// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#include "http.h"
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

// Forward declaration for musl compatibility
char *strcasestr(const char *haystack, const char *needle);

int parse_http_request(const char *buffer, size_t len, struct http_request *req) {
    memset(req, 0, sizeof(*req));

    const char *p = buffer;
    const char *end = buffer + len;

    // Parse method
    const char *method_end = strchr(p, ' ');
    if (!method_end || method_end - p >= (int)sizeof(req->method)) {
        return -1;
    }
    memcpy(req->method, p, method_end - p);
    req->method[method_end - p] = '\0';
    p = method_end + 1;

    // Parse path (and query string)
    const char *path_end = strchr(p, ' ');
    if (!path_end) {
        return -1;
    }

    // Check for query string
    const char *query_start = memchr(p, '?', path_end - p);
    if (query_start) {
        // Copy path
        size_t path_len = query_start - p;
        if (path_len >= sizeof(req->path)) {
            path_len = sizeof(req->path) - 1;
        }
        memcpy(req->path, p, path_len);
        req->path[path_len] = '\0';

        // Copy query
        query_start++;
        size_t query_len = path_end - query_start;
        if (query_len >= sizeof(req->query)) {
            query_len = sizeof(req->query) - 1;
        }
        memcpy(req->query, query_start, query_len);
        req->query[query_len] = '\0';
    } else {
        size_t path_len = path_end - p;
        if (path_len >= sizeof(req->path)) {
            path_len = sizeof(req->path) - 1;
        }
        memcpy(req->path, p, path_len);
        req->path[path_len] = '\0';
    }

    // URL decode path
    url_decode(req->path);

    // Skip to end of request line
    p = strstr(path_end, "\r\n");
    if (!p) {
        return -1;
    }
    p += 2;

    // Parse headers
    req->header_count = 0;
    while (p < end && *p != '\r' && req->header_count < MAX_HEADERS) {
        const char *header_end = strstr(p, "\r\n");
        if (!header_end) {
            break;
        }

        const char *colon = memchr(p, ':', header_end - p);
        if (!colon) {
            p = header_end + 2;
            continue;
        }

        // Copy header name
        size_t name_len = colon - p;
        if (name_len >= MAX_HEADER_NAME) {
            name_len = MAX_HEADER_NAME - 1;
        }
        memcpy(req->headers[req->header_count].name, p, name_len);
        req->headers[req->header_count].name[name_len] = '\0';

        // Skip colon and whitespace
        colon++;
        while (colon < header_end && (*colon == ' ' || *colon == '\t')) {
            colon++;
        }

        // Copy header value
        size_t value_len = header_end - colon;
        if (value_len >= MAX_HEADER_VALUE) {
            value_len = MAX_HEADER_VALUE - 1;
        }
        memcpy(req->headers[req->header_count].value, colon, value_len);
        req->headers[req->header_count].value[value_len] = '\0';

        req->header_count++;
        p = header_end + 2;
    }

    // Find body (after empty line)
    const char *body_start = strstr(p, "\r\n");
    if (body_start) {
        body_start += 2;
        if (body_start < end) {
            req->body = (char *)body_start;
            req->body_len = end - body_start;
        }
    }

    return 0;
}

void url_decode(char *str) {
    char *src = str;
    char *dst = str;

    while (*src) {
        if (*src == '%' && src[1] && src[2]) {
            char hex[3] = {src[1], src[2], '\0'};
            *dst++ = (char)strtol(hex, NULL, 16);
            src += 3;
        } else if (*src == '+') {
            *dst++ = ' ';
            src++;
        } else {
            *dst++ = *src++;
        }
    }
    *dst = '\0';
}

const char *get_query_param(const char *query, const char *name, char *value, size_t value_size) {
    if (!query || !name || !value || value_size == 0) {
        return NULL;
    }

    size_t name_len = strlen(name);
    const char *p = query;

    while (*p) {
        // Check if this is the parameter we're looking for
        if (strncmp(p, name, name_len) == 0 && p[name_len] == '=') {
            p += name_len + 1;

            // Find end of value
            const char *end = strchr(p, '&');
            size_t len = end ? (size_t)(end - p) : strlen(p);

            if (len >= value_size) {
                len = value_size - 1;
            }

            memcpy(value, p, len);
            value[len] = '\0';

            // URL decode the value
            url_decode(value);

            return value;
        }

        // Move to next parameter
        p = strchr(p, '&');
        if (!p) {
            break;
        }
        p++;
    }

    return NULL;
}
