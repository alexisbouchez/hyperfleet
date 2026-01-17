// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#include "json.h"
#include <stdio.h>
#include <string.h>

size_t json_escape(const char *input, char *output, size_t output_size) {
    if (!input || !output || output_size == 0) {
        return 0;
    }

    size_t out_idx = 0;
    const unsigned char *p = (const unsigned char *)input;

    while (*p && out_idx < output_size - 1) {
        char escape_char = 0;

        switch (*p) {
            case '"':  escape_char = '"'; break;
            case '\\': escape_char = '\\'; break;
            case '\b': escape_char = 'b'; break;
            case '\f': escape_char = 'f'; break;
            case '\n': escape_char = 'n'; break;
            case '\r': escape_char = 'r'; break;
            case '\t': escape_char = 't'; break;
            default:
                // Control characters (0x00-0x1F)
                if (*p < 0x20) {
                    if (out_idx + 6 < output_size) {
                        out_idx += snprintf(output + out_idx, output_size - out_idx,
                            "\\u%04x", *p);
                    }
                    p++;
                    continue;
                }
                break;
        }

        if (escape_char) {
            if (out_idx + 2 < output_size) {
                output[out_idx++] = '\\';
                output[out_idx++] = escape_char;
            }
        } else {
            output[out_idx++] = *p;
        }
        p++;
    }

    output[out_idx] = '\0';
    return out_idx;
}
