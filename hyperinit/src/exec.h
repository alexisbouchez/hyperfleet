// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#ifndef EXEC_H
#define EXEC_H

#include "http.h"

// Handle exec request
// Returns response length on success, -1 on error
int handle_exec(const struct http_request *req, char *response, size_t response_size);

#endif // EXEC_H
