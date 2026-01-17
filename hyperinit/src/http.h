// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#ifndef HTTP_H
#define HTTP_H

#include <stddef.h>

// Maximum sizes
#define MAX_HEADERS 32
#define MAX_HEADER_NAME 64
#define MAX_HEADER_VALUE 1024
#define MAX_PATH 2048
#define MAX_QUERY 2048

// HTTP header
struct http_header {
    char name[MAX_HEADER_NAME];
    char value[MAX_HEADER_VALUE];
};

// HTTP request
struct http_request {
    char method[16];
    char path[MAX_PATH];
    char query[MAX_QUERY];
    struct http_header headers[MAX_HEADERS];
    int header_count;
    char *body;
    size_t body_len;
};

// Parse an HTTP request
// Returns 0 on success, -1 on error
int parse_http_request(const char *buffer, size_t len, struct http_request *req);

// URL decode a string in place
void url_decode(char *str);

// Get query parameter value
// Returns NULL if not found
const char *get_query_param(const char *query, const char *name, char *value, size_t value_size);

#endif // HTTP_H
