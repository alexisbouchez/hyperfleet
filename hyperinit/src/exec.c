// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

#include "exec.h"
#include "json.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>

// External environment from main
extern char **parsed_env;
extern int parsed_env_count;

#define MAX_CMD_ARGS 64
#define MAX_OUTPUT_SIZE 32768

int handle_exec(const struct http_request *req, char *response, size_t response_size) {
    if (!req->body || req->body_len == 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 24\r\n\r\n"
            "{\"error\":\"no body\"}");
    }

    // Parse JSON request
    char *cmd[MAX_CMD_ARGS];
    int cmd_count = 0;
    int timeout_seconds = 30;

    // Simple JSON parsing for cmd array
    char body_copy[4096];
    size_t copy_len = req->body_len < sizeof(body_copy) - 1 ? req->body_len : sizeof(body_copy) - 1;
    memcpy(body_copy, req->body, copy_len);
    body_copy[copy_len] = '\0';

    // Find "cmd" array
    char *cmd_start = strstr(body_copy, "\"cmd\"");
    if (!cmd_start) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"missing cmd\"}");
    }

    // Find array start
    cmd_start = strchr(cmd_start, '[');
    if (!cmd_start) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"invalid cmd\"}");
    }
    cmd_start++;

    // Parse array elements
    char *p = cmd_start;
    while (*p && *p != ']' && cmd_count < MAX_CMD_ARGS - 1) {
        // Skip whitespace
        while (*p && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == ',')) {
            p++;
        }

        if (*p == ']') break;

        if (*p == '"') {
            p++; // Skip opening quote
            char *str_end = p;
            while (*str_end && *str_end != '"') {
                if (*str_end == '\\' && str_end[1]) {
                    str_end += 2;
                } else {
                    str_end++;
                }
            }

            size_t len = str_end - p;
            cmd[cmd_count] = malloc(len + 1);
            if (cmd[cmd_count]) {
                // Copy and unescape
                char *dst = cmd[cmd_count];
                char *src = p;
                while (src < str_end) {
                    if (*src == '\\' && src[1]) {
                        src++;
                        switch (*src) {
                            case 'n': *dst++ = '\n'; break;
                            case 't': *dst++ = '\t'; break;
                            case 'r': *dst++ = '\r'; break;
                            default: *dst++ = *src; break;
                        }
                        src++;
                    } else {
                        *dst++ = *src++;
                    }
                }
                *dst = '\0';
                cmd_count++;
            }
            p = str_end + 1; // Skip closing quote
        } else {
            p++;
        }
    }
    cmd[cmd_count] = NULL;

    if (cmd_count == 0) {
        return snprintf(response, response_size,
            "HTTP/1.1 400 Bad Request\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 24\r\n\r\n"
            "{\"error\":\"empty cmd\"}");
    }

    // Parse timeout
    char *timeout_str = strstr(body_copy, "\"timeout_seconds\"");
    if (timeout_str) {
        timeout_str = strchr(timeout_str, ':');
        if (timeout_str) {
            timeout_seconds = atoi(timeout_str + 1);
            if (timeout_seconds <= 0) timeout_seconds = 30;
            if (timeout_seconds > 300) timeout_seconds = 300;
        }
    }

    // Create pipes for stdout and stderr
    int stdout_pipe[2], stderr_pipe[2];
    if (pipe(stdout_pipe) < 0 || pipe(stderr_pipe) < 0) {
        for (int i = 0; i < cmd_count; i++) free(cmd[i]);
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"pipe failed\"}");
    }

    // Block SIGCHLD to prevent the handler from reaping our child
    sigset_t mask, oldmask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);
    sigprocmask(SIG_BLOCK, &mask, &oldmask);

    pid_t pid = fork();
    if (pid < 0) {
        sigprocmask(SIG_SETMASK, &oldmask, NULL);
        close(stdout_pipe[0]); close(stdout_pipe[1]);
        close(stderr_pipe[0]); close(stderr_pipe[1]);
        for (int i = 0; i < cmd_count; i++) free(cmd[i]);
        return snprintf(response, response_size,
            "HTTP/1.1 500 Internal Server Error\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 26\r\n\r\n"
            "{\"error\":\"fork failed\"}");
    }

    if (pid == 0) {
        // Child process
        // Restore signal mask in child
        sigprocmask(SIG_SETMASK, &oldmask, NULL);

        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        close(stdout_pipe[1]);
        close(stderr_pipe[1]);

        // Set up environment
        if (parsed_env) {
            for (int i = 0; i < parsed_env_count; i++) {
                putenv(parsed_env[i]);
            }
        }

        // Set PATH if not set
        if (!getenv("PATH")) {
            putenv("PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        }

        execvp(cmd[0], cmd);
        fprintf(stderr, "exec failed: %s\n", strerror(errno));
        _exit(127);
    }

    // Parent process
    close(stdout_pipe[1]);
    close(stderr_pipe[1]);

    // Set non-blocking
    fcntl(stdout_pipe[0], F_SETFL, O_NONBLOCK);
    fcntl(stderr_pipe[0], F_SETFL, O_NONBLOCK);

    char stdout_buf[MAX_OUTPUT_SIZE];
    char stderr_buf[MAX_OUTPUT_SIZE];
    size_t stdout_len = 0, stderr_len = 0;

    struct timeval start, now;
    gettimeofday(&start, NULL);

    int status;
    while (1) {
        // Check timeout
        gettimeofday(&now, NULL);
        int elapsed = (now.tv_sec - start.tv_sec);
        if (elapsed >= timeout_seconds) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            sigprocmask(SIG_SETMASK, &oldmask, NULL);
            close(stdout_pipe[0]);
            close(stderr_pipe[0]);
            for (int i = 0; i < cmd_count; i++) free(cmd[i]);
            return snprintf(response, response_size,
                "HTTP/1.1 408 Request Timeout\r\n"
                "Content-Type: application/json\r\n"
                "Content-Length: 22\r\n\r\n"
                "{\"error\":\"timeout\"}");
        }

        // Try to read output
        ssize_t n;
        if (stdout_len < MAX_OUTPUT_SIZE - 1) {
            n = read(stdout_pipe[0], stdout_buf + stdout_len, MAX_OUTPUT_SIZE - 1 - stdout_len);
            if (n > 0) stdout_len += n;
        }
        if (stderr_len < MAX_OUTPUT_SIZE - 1) {
            n = read(stderr_pipe[0], stderr_buf + stderr_len, MAX_OUTPUT_SIZE - 1 - stderr_len);
            if (n > 0) stderr_len += n;
        }

        // Check if child has exited
        int ret = waitpid(pid, &status, WNOHANG);
        if (ret > 0) {
            // Child exited, read remaining output
            ssize_t n;
            while ((n = read(stdout_pipe[0], stdout_buf + stdout_len, MAX_OUTPUT_SIZE - 1 - stdout_len)) > 0) {
                stdout_len += n;
            }
            while ((n = read(stderr_pipe[0], stderr_buf + stderr_len, MAX_OUTPUT_SIZE - 1 - stderr_len)) > 0) {
                stderr_len += n;
            }
            break;
        }

        usleep(10000); // 10ms
    }

    close(stdout_pipe[0]);
    close(stderr_pipe[0]);

    // Restore signal mask
    sigprocmask(SIG_SETMASK, &oldmask, NULL);

    stdout_buf[stdout_len] = '\0';
    stderr_buf[stderr_len] = '\0';

    int exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;

    // Build JSON response
    char json_body[MAX_OUTPUT_SIZE * 2 + 256];
    char stdout_escaped[MAX_OUTPUT_SIZE * 2];
    char stderr_escaped[MAX_OUTPUT_SIZE * 2];

    json_escape(stdout_buf, stdout_escaped, sizeof(stdout_escaped));
    json_escape(stderr_buf, stderr_escaped, sizeof(stderr_escaped));

    int json_len = snprintf(json_body, sizeof(json_body),
        "{\"exit_code\":%d,\"stdout\":\"%s\",\"stderr\":\"%s\"}",
        exit_code, stdout_escaped, stderr_escaped);

    int resp_len = snprintf(response, response_size,
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n\r\n%s",
        json_len, json_body);

    // Clean up
    for (int i = 0; i < cmd_count; i++) {
        free(cmd[i]);
    }

    return resp_len;
}
