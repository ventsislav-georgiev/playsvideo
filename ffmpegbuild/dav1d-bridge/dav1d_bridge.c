#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <dav1d/dav1d.h>
#include <dav1d/headers.h>

enum Dav1dBridgeStatus {
    DJS_OK = 0,
    DJS_ERROR = -1,
    DJS_EAGAIN = -2,
    DJS_UNSUPPORTED_LAYOUT = -3,
    DJS_UNSUPPORTED_BITDEPTH = -4,
    DJS_NO_MEMORY = -5,
};

typedef struct Dav1dBridgeFrame {
    uint32_t width;
    uint32_t height;
    uint32_t size;
    uint32_t data_ref;
    uint32_t bit_depth;
    uint32_t layout;
    int32_t status;
    uint32_t reserved;
    uint32_t timestamp_low;
    int32_t timestamp_high;
} Dav1dBridgeFrame;

typedef struct Dav1dBridgeFrameNode {
    Dav1dBridgeFrame *frame;
    struct Dav1dBridgeFrameNode *next;
} Dav1dBridgeFrameNode;

typedef struct Dav1dBridgeContext {
    Dav1dContext *decoder;
    Dav1dBridgeFrameNode *head;
    Dav1dBridgeFrameNode *tail;
} Dav1dBridgeContext;

void *djs_alloc_obu(uint32_t size) {
    return malloc(size);
}

void djs_free(void *ptr) {
    free(ptr);
}

static int64_t timestamp_from_parts(uint32_t low, int32_t high) {
    return ((int64_t)high << 32) | (int64_t)low;
}

Dav1dBridgeContext *djs_init(void) {
    Dav1dSettings settings;
    dav1d_default_settings(&settings);
    settings.n_threads = 1;
    settings.max_frame_delay = 1;
    settings.apply_grain = 1;

    Dav1dContext *context = NULL;
    if (dav1d_open(&context, &settings) < 0) {
        return NULL;
    }

    Dav1dBridgeContext *bridge = (Dav1dBridgeContext *)calloc(1, sizeof(Dav1dBridgeContext));
    if (!bridge) {
        dav1d_close(&context);
        return NULL;
    }
    bridge->decoder = context;
    return bridge;
}

static void free_frame_queue(Dav1dBridgeContext *context) {
    Dav1dBridgeFrameNode *node = context ? context->head : NULL;
    while (node) {
        Dav1dBridgeFrameNode *next = node->next;
        if (node->frame) {
            if (node->frame->data_ref) {
                free((void *)(uintptr_t)node->frame->data_ref);
            }
            free(node->frame);
        }
        free(node);
        node = next;
    }
    if (context) {
        context->head = NULL;
        context->tail = NULL;
    }
}

void djs_close(Dav1dBridgeContext *context) {
    if (context) {
        free_frame_queue(context);
        if (context->decoder) {
            Dav1dContext *decoder = context->decoder;
            dav1d_close(&decoder);
            context->decoder = NULL;
        }
        free(context);
    }
}

void djs_flush(Dav1dBridgeContext *context) {
    if (context && context->decoder) {
        free_frame_queue(context);
        dav1d_flush(context->decoder);
    }
}

static uint8_t clamp_to_u8(unsigned value) {
    return value > 255 ? 255 : (uint8_t)value;
}

static void copy_plane_8bit(
    uint8_t *dst,
    const uint8_t *src,
    const ptrdiff_t stride,
    const uint32_t width,
    const uint32_t height
) {
    for (uint32_t y = 0; y < height; y++) {
        memcpy(dst + y * width, src + y * stride, width);
    }
}

static void copy_plane_high_bitdepth_to_8bit(
    uint8_t *dst,
    const uint8_t *src_bytes,
    const ptrdiff_t stride,
    const uint32_t width,
    const uint32_t height,
    const uint32_t bit_depth
) {
    const unsigned shift = bit_depth > 8 ? bit_depth - 8 : 0;

    for (uint32_t y = 0; y < height; y++) {
        const uint16_t *src = (const uint16_t *)(const void *)(src_bytes + y * stride);
        for (uint32_t x = 0; x < width; x++) {
            dst[y * width + x] = clamp_to_u8(src[x] >> shift);
        }
    }
}

static Dav1dBridgeFrame *make_error_frame(const int status) {
    Dav1dBridgeFrame *frame = (Dav1dBridgeFrame *)calloc(1, sizeof(Dav1dBridgeFrame));
    if (!frame) return NULL;
    frame->status = status;
    return frame;
}

static Dav1dBridgeFrame *copy_picture_as_i420_8bit(const Dav1dPicture *picture) {
    if (picture->p.layout != DAV1D_PIXEL_LAYOUT_I420) {
        return make_error_frame(DJS_UNSUPPORTED_LAYOUT);
    }

    if (picture->p.bpc != 8 && picture->p.bpc != 10 && picture->p.bpc != 12) {
        return make_error_frame(DJS_UNSUPPORTED_BITDEPTH);
    }

    const uint32_t width = (uint32_t)picture->p.w;
    const uint32_t height = (uint32_t)picture->p.h;
    const uint32_t chroma_width = (width + 1) / 2;
    const uint32_t chroma_height = (height + 1) / 2;
    const uint32_t y_size = width * height;
    const uint32_t uv_size = chroma_width * chroma_height;
    const uint32_t output_size = y_size + uv_size * 2;

    Dav1dBridgeFrame *frame = (Dav1dBridgeFrame *)calloc(1, sizeof(Dav1dBridgeFrame));
    if (!frame) return NULL;

    uint8_t *data = (uint8_t *)malloc(output_size);
    if (!data) {
        free(frame);
        return make_error_frame(DJS_NO_MEMORY);
    }

    if (picture->p.bpc == 8) {
        copy_plane_8bit(data, picture->data[0], picture->stride[0], width, height);
        copy_plane_8bit(data + y_size, picture->data[1], picture->stride[1], chroma_width, chroma_height);
        copy_plane_8bit(data + y_size + uv_size, picture->data[2], picture->stride[1], chroma_width, chroma_height);
    } else {
        copy_plane_high_bitdepth_to_8bit(data, picture->data[0], picture->stride[0], width, height, picture->p.bpc);
        copy_plane_high_bitdepth_to_8bit(data + y_size, picture->data[1], picture->stride[1], chroma_width, chroma_height, picture->p.bpc);
        copy_plane_high_bitdepth_to_8bit(data + y_size + uv_size, picture->data[2], picture->stride[1], chroma_width, chroma_height, picture->p.bpc);
    }

    frame->width = width;
    frame->height = height;
    frame->size = output_size;
    frame->data_ref = (uint32_t)(uintptr_t)data;
    frame->bit_depth = (uint32_t)picture->p.bpc;
    frame->layout = (uint32_t)picture->p.layout;
    frame->status = DJS_OK;
    frame->timestamp_low = (uint32_t)(picture->m.timestamp & 0xffffffffu);
    frame->timestamp_high = (int32_t)(picture->m.timestamp >> 32);
    return frame;
}

static int queue_frame(Dav1dBridgeContext *context, Dav1dBridgeFrame *frame) {
    Dav1dBridgeFrameNode *node = (Dav1dBridgeFrameNode *)calloc(1, sizeof(Dav1dBridgeFrameNode));
    if (!node) return -1;
    node->frame = frame;
    if (context->tail) {
        context->tail->next = node;
    } else {
        context->head = node;
    }
    context->tail = node;
    return 0;
}

static Dav1dBridgeFrame *pop_queued_frame(Dav1dBridgeContext *context) {
    if (!context || !context->head) return NULL;
    Dav1dBridgeFrameNode *node = context->head;
    Dav1dBridgeFrame *frame = node->frame;
    context->head = node->next;
    if (!context->head) context->tail = NULL;
    free(node);
    return frame;
}

static int drain_available_pictures(Dav1dBridgeContext *context) {
    int drained = 0;
    for (;;) {
        Dav1dPicture picture = { 0 };
        int picture_result = dav1d_get_picture(context->decoder, &picture);
        if (picture_result < 0) {
            if (picture_result == DAV1D_ERR(EAGAIN)) return drained;
            return -1;
        }

        Dav1dBridgeFrame *frame = copy_picture_as_i420_8bit(&picture);
        dav1d_picture_unref(&picture);
        if (!frame || queue_frame(context, frame) < 0) {
            if (frame) {
                if (frame->data_ref) free((void *)(uintptr_t)frame->data_ref);
                free(frame);
            }
            return -1;
        }
        drained += 1;
    }
}

Dav1dBridgeFrame *djs_receive_frame(Dav1dBridgeContext *context) {
    if (!context || !context->decoder) return make_error_frame(DJS_ERROR);

    Dav1dBridgeFrame *queued = pop_queued_frame(context);
    if (queued) return queued;

    if (drain_available_pictures(context) < 0) return make_error_frame(DJS_ERROR);
    queued = pop_queued_frame(context);
    return queued ? queued : make_error_frame(DJS_EAGAIN);
}

int djs_send_obu(
    Dav1dBridgeContext *context,
    const uint8_t *input,
    uint32_t size,
    uint32_t timestamp_low,
    int32_t timestamp_high
) {
    if (!context || !context->decoder || !input || size == 0) return DJS_ERROR;

    Dav1dData data = { 0 };
    uint8_t *buffer = dav1d_data_create(&data, size);
    if (!buffer) {
        return DJS_NO_MEMORY;
    }
    memcpy(buffer, input, size);
    data.m.timestamp = timestamp_from_parts(timestamp_low, timestamp_high);

    while (data.sz > 0) {
        int send_result = dav1d_send_data(context->decoder, &data);
        if (send_result == 0) continue;
        if (send_result == DAV1D_ERR(EAGAIN)) {
            if (drain_available_pictures(context) < 0) {
                dav1d_data_unref(&data);
                return DJS_ERROR;
            }
            if (!context->head) {
                dav1d_data_unref(&data);
                return DJS_EAGAIN;
            }
            continue;
        }

        dav1d_data_unref(&data);
        return DJS_ERROR;
    }

    if (drain_available_pictures(context) < 0) return DJS_ERROR;
    return DJS_OK;
}

Dav1dBridgeFrame *djs_decode_obu(Dav1dBridgeContext *context, const uint8_t *input, uint32_t size) {
    const int status = djs_send_obu(context, input, size, 0, (int32_t)(INT64_MIN >> 32));
    if (status != DJS_OK) return make_error_frame(status);
    return djs_receive_frame(context);
}
