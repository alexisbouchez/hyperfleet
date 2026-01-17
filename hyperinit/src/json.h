// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#ifndef JSON_H
#define JSON_H

#include <stddef.h>

// Escape a string for JSON output
// Returns the length of the escaped string
size_t json_escape(const char *input, char *output, size_t output_size);

#endif // JSON_H
