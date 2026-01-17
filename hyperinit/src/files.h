// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#ifndef FILES_H
#define FILES_H

#include "http.h"

// Handle list directory request
int handle_list_dir(const struct http_request *req, char *response, size_t response_size);

// Handle read file request
int handle_read_file(const struct http_request *req, char *response, size_t response_size);

// Handle write file request
int handle_write_file(const struct http_request *req, char *response, size_t response_size);

// Handle delete file/directory request
int handle_delete(const struct http_request *req, char *response, size_t response_size);

// Handle mkdir request
int handle_mkdir(const struct http_request *req, char *response, size_t response_size);

#endif // FILES_H
