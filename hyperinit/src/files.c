// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#include "files.h"
#include "json.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>

#define MAX_FILE_SIZE (1024 * 1024) // 1MB

static int get_path_param(const struct http_request *req, char *path, size_t path_size) {
    if (get_query_param(req->query, "path", path, path_size) == NULL) {
        return -1;
    }
    return 0;
}

int handle_list_dir(const struct http_request *req, char *response, size_t response_size) {
    char path[2048];
    if (get_path_param(req, path, sizeof(path)) < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"missing path\"}");
    }

    DIR *dir = opendir(path);
    if (!dir) {
        if (errno == ENOENT) {
            return snprintf(response, response_size,
                "HTTP/1.1 404 Not Found\r\n"
                "Content-Type: application/json\r\n"
                "Content-Length: 23\r\n\r\n"
                "{\"error\":\"not found\"}");
        }
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 28\r\n\r\n"
            "{\"error\":\"cannot open dir\"}");
    }

    char json_body[32768];
    int json_len = 1;
    json_body[0] = '[';

    struct dirent *entry;
    int first = 1;
    while ((entry = readdir(dir)) != NULL) {
        // Skip . and ..
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }

        char escaped[512];
        json_escape(entry->d_name, escaped, sizeof(escaped));

        int written = snprintf(json_body + json_len, sizeof(json_body) - json_len,
            "%s\"%s\"", first ? "" : ",", escaped);
        if (written > 0 && json_len + written < (int)sizeof(json_body)) {
            json_len += written;
        }
        first = 0;
    }
    closedir(dir);

    json_body[json_len++] = ']';
    json_body[json_len] = '\0';

    return snprintf(response, response_size,
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n\r\n%s",
        json_len, json_body);
}

int handle_read_file(const struct http_request *req, char *response, size_t response_size) {
    char path[2048];
    if (get_path_param(req, path, sizeof(path)) < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"missing path\"}");
    }

    struct stat st;
    if (stat(path, &st) < 0) {
        if (errno == ENOENT) {
            return snprintf(response, response_size,
                "HTTP/1.1 404 Not Found\r\n"
                "Content-Type: application/json\r\n"
                "Content-Length: 23\r\n\r\n"
                "{\"error\":\"not found\"}");
        }
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 24\r\n\r\n"
            "{\"error\":\"stat failed\"}");
    }

    if (!S_ISREG(st.st_mode)) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 24\r\n\r\n"
            "{\"error\":\"not a file\"}");
    }

    if (st.st_size > MAX_FILE_SIZE) {
        return snprintf(response, response_size,
            "HTTP/1.1 413 Payload Too Large\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"file too large\"}");
    }

    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 24\r\n\r\n"
            "{\"error\":\"cannot open\"}");
    }

    // Build response headers
    int header_len = snprintf(response, response_size,
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/octet-stream\r\n"
        "Content-Length: %ld\r\n\r\n",
        (long)st.st_size);

    // Read file content
    ssize_t n = read(fd, response + header_len, response_size - header_len);
    close(fd);

    if (n < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 24\r\n\r\n"
            "{\"error\":\"read failed\"}");
    }

    return header_len + n;
}

int handle_write_file(const struct http_request *req, char *response, size_t response_size) {
    char path[2048];
    if (get_path_param(req, path, sizeof(path)) < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"missing path\"}");
    }

    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"cannot create\"}");
    }

    if (req->body && req->body_len > 0) {
        ssize_t n = write(fd, req->body, req->body_len);
        if (n < 0 || (size_t)n != req->body_len) {
            close(fd);
            return snprintf(response, response_size,
                "HTTP/1.1 500 Internal Server Error\r\n"
                "Content-Type: application/json\r\n"
                "Content-Length: 25\r\n\r\n"
                "{\"error\":\"write failed\"}");
        }
    }

    close(fd);

    return snprintf(response, response_size,
        "HTTP/1.1 204 No Content\r\n"
        "Content-Length: 0\r\n\r\n");
}

int handle_delete(const struct http_request *req, char *response, size_t response_size) {
    char path[2048];
    if (get_path_param(req, path, sizeof(path)) < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"missing path\"}");
    }

    struct stat st;
    if (stat(path, &st) < 0) {
        if (errno == ENOENT) {
            // Already deleted, idempotent
            return snprintf(response, response_size,
                "HTTP/1.1 204 No Content\r\n"
                "Content-Length: 0\r\n\r\n");
        }
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 24\r\n\r\n"
            "{\"error\":\"stat failed\"}");
    }

    int result;
    if (S_ISDIR(st.st_mode)) {
        result = rmdir(path);
    } else {
        result = unlink(path);
    }

    if (result < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"delete failed\"}");
    }

    return snprintf(response, response_size,
        "HTTP/1.1 204 No Content\r\n"
        "Content-Length: 0\r\n\r\n");
}

int handle_mkdir(const struct http_request *req, char *response, size_t response_size) {
    char path[2048];
    if (get_path_param(req, path, sizeof(path)) < 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"missing path\"}");
    }

    // Create directory with parents (like mkdir -p)
    char tmp[2048];
    strncpy(tmp, path, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';

    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
    mkdir(tmp, 0755);

    struct stat st;
    if (stat(path, &st) < 0 || !S_ISDIR(st.st_mode)) {
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 25\r\n\r\n"
            "{\"error\":\"mkdir failed\"}");
    }

    return snprintf(response, response_size,
        "HTTP/1.1 201 Created\r\n"
        "Content-Length: 0\r\n\r\n");
}
