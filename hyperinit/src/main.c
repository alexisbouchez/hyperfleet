// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

// hyperinit - Minimal init system for Hyperfleet VMs

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <sys/reboot.h>
#include <linux/reboot.h>
#include <linux/vm_sockets.h>
#include <errno.h>
#include <fcntl.h>

#include "http.h"
#include "exec.h"
#include "files.h"

#include <sys/ioctl.h>
#include <net/if.h>

#define VSOCK_PORT 80
#define LISTEN_BACKLOG 16

// Global shutdown flag
static volatile int shutdown_requested = 0;

// Environment variables parsed from kernel cmdline
char **parsed_env = NULL;
int parsed_env_count = 0;

static void log_msg(const char *msg) {
    fprintf(stderr, "hyperinit: %s\n", msg);
}

static int mount_filesystems(void) {
    // Mount proc
    if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) {
        if (errno != EBUSY) {
            perror("mount /proc");
            return -1;
        }
    }

    // Mount sys
    if (mount("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) {
        if (errno != EBUSY) {
            perror("mount /sys");
            return -1;
        }
    }

    // Mount devtmpfs
    if (mount("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, NULL) != 0) {
        if (errno != EBUSY) {
            perror("mount /dev");
            return -1;
        }
    }

    // Mount tmpfs on /tmp
    if (mount("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "size=64M") != 0) {
        if (errno != EBUSY) {
            perror("mount /tmp");
            return -1;
        }
    }

    // Mount tmpfs on /run
    mkdir("/run", 0755);
    if (mount("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV, "size=16M") != 0) {
        if (errno != EBUSY) {
            perror("mount /run");
            return -1;
        }
    }

    return 0;
}

static int create_device_nodes(void) {
    // Create /dev/null
    mknod("/dev/null", S_IFCHR | 0666, makedev(1, 3));
    // Create /dev/zero
    mknod("/dev/zero", S_IFCHR | 0666, makedev(1, 5));
    // Create /dev/random
    mknod("/dev/random", S_IFCHR | 0666, makedev(1, 8));
    // Create /dev/urandom
    mknod("/dev/urandom", S_IFCHR | 0666, makedev(1, 9));
    // Create /dev/tty
    mknod("/dev/tty", S_IFCHR | 0666, makedev(5, 0));
    // Create /dev/console
    mknod("/dev/console", S_IFCHR | 0600, makedev(5, 1));
    // Create /dev/ptmx
    mknod("/dev/ptmx", S_IFCHR | 0666, makedev(5, 2));

    // Create /dev/pts directory
    mkdir("/dev/pts", 0755);
    mount("devpts", "/dev/pts", "devpts", 0, "gid=5,mode=620,ptmxmode=666");

    return 0;
}

static int setup_loopback(void) {
    // Block SIGCHLD to prevent handler from reaping our child
    sigset_t mask, oldmask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);
    sigprocmask(SIG_BLOCK, &mask, &oldmask);

    // Bring up loopback interface using fork/exec
    pid_t pid = fork();
    if (pid < 0) {
        sigprocmask(SIG_SETMASK, &oldmask, NULL);
        log_msg("warning: failed to fork for loopback setup");
        return -1;
    }

    if (pid == 0) {
        // Child process - restore signal mask
        sigprocmask(SIG_SETMASK, &oldmask, NULL);
        // Exec ip command
        char *args[] = {"/bin/ip", "link", "set", "lo", "up", NULL};
        execvp("/bin/ip", args);
        // If exec fails, try /sbin/ip
        args[0] = "/sbin/ip";
        execvp("/sbin/ip", args);
        _exit(127);
    }

    // Parent - wait for child
    int status;
    int wret = waitpid(pid, &status, 0);

    // Restore signal mask
    sigprocmask(SIG_SETMASK, &oldmask, NULL);

    if (wret < 0) {
        log_msg("warning: waitpid failed for loopback setup");
        return -1;
    }

    if (WIFEXITED(status)) {
        int exit_code = WEXITSTATUS(status);
        if (exit_code == 0) {
            return 0;
        }
        char err[64];
        snprintf(err, sizeof(err), "ip command exited with code %d", exit_code);
        log_msg(err);
        return -1;
    }

    log_msg("warning: ip command did not exit normally");
    return -1;
}

static int parse_cmdline_env(void) {
    FILE *f = fopen("/proc/cmdline", "r");
    if (!f) {
        return -1;
    }

    char cmdline[4096];
    if (!fgets(cmdline, sizeof(cmdline), f)) {
        fclose(f);
        return -1;
    }
    fclose(f);

    // Count environment variables
    int count = 0;
    char *p = cmdline;
    while ((p = strstr(p, "hyperfleet.env.")) != NULL) {
        count++;
        p++;
    }

    if (count == 0) {
        return 0;
    }

    // Allocate environment array (count + 1 for NULL terminator)
    parsed_env = malloc((count + 1) * sizeof(char *));
    if (!parsed_env) {
        return -1;
    }

    // Parse environment variables
    p = cmdline;
    int idx = 0;
    while ((p = strstr(p, "hyperfleet.env.")) != NULL) {
        p += strlen("hyperfleet.env.");

        // Find end of this parameter (space or end of string)
        char *end = strchr(p, ' ');
        size_t len = end ? (size_t)(end - p) : strlen(p);

        // Remove trailing newline if present
        while (len > 0 && (p[len-1] == '\n' || p[len-1] == '\r')) {
            len--;
        }

        // Allocate and copy
        parsed_env[idx] = malloc(len + 1);
        if (parsed_env[idx]) {
            memcpy(parsed_env[idx], p, len);
            parsed_env[idx][len] = '\0';

            // Handle escaped spaces
            char *s = parsed_env[idx];
            char *d = s;
            while (*s) {
                if (s[0] == '\\' && s[1] == ' ') {
                    *d++ = ' ';
                    s += 2;
                } else {
                    *d++ = *s++;
                }
            }
            *d = '\0';

            idx++;
        }

        p += len;
    }

    parsed_env[idx] = NULL;
    parsed_env_count = idx;

    return 0;
}

static int create_vsock_server(void) {
    int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return -1;
    }

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_vm addr = {
        .svm_family = AF_VSOCK,
        .svm_port = VSOCK_PORT,
        .svm_cid = VMADDR_CID_ANY,
    };

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(fd);
        return -1;
    }

    if (listen(fd, LISTEN_BACKLOG) < 0) {
        perror("listen");
        close(fd);
        return -1;
    }

    return fd;
}

static void handle_client(int client_fd) {
    char buffer[8192];
    ssize_t total = 0;

    // Read initial data (headers + possibly partial body)
    ssize_t n = read(client_fd, buffer, sizeof(buffer) - 1);
    if (n <= 0) {
        close(client_fd);
        return;
    }
    total = n;
    buffer[total] = '\0';

    // Find Content-Length header
    char *cl_header = strcasestr(buffer, "content-length:");
    size_t content_length = 0;
    if (cl_header) {
        content_length = atoi(cl_header + 15);
    }

    // Find body start (after \r\n\r\n)
    char *body_start = strstr(buffer, "\r\n\r\n");
    if (body_start && content_length > 0) {
        body_start += 4;
        size_t headers_len = body_start - buffer;
        size_t body_received = total - headers_len;

        // Read remaining body if needed
        while (body_received < content_length && total < (ssize_t)sizeof(buffer) - 1) {
            n = read(client_fd, buffer + total, sizeof(buffer) - 1 - total);
            if (n <= 0) break;
            total += n;
            body_received += n;
        }
        buffer[total] = '\0';
    }

    // Parse HTTP request
    struct http_request req;
    if (parse_http_request(buffer, total, &req) < 0) {
        const char *response = "HTTP/1.1 400 Bad Request\r\n"
                               "Content-Length: 0\r\n\r\n";
        write(client_fd, response, strlen(response));
        close(client_fd);
        return;
    }

    // Route request
    char response[65536];
    int response_len = 0;

    if (strcmp(req.path, "/health") == 0 && strcmp(req.method, "GET") == 0) {
        response_len = snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 15\r\n\r\n"
            "{\"status\":\"ok\"}");
    } else if (strcmp(req.path, "/shutdown") == 0 && strcmp(req.method, "POST") == 0) {
        response_len = snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 15\r\n\r\n"
            "{\"status\":\"ok\"}");
        write(client_fd, response, response_len);
        close(client_fd);
        shutdown_requested = 1;
        return;
    } else if (strcmp(req.path, "/exec") == 0 && strcmp(req.method, "POST") == 0) {
        response_len = handle_exec(&req, response, sizeof(response));
    } else if (strncmp(req.path, "/files/mkdir", 12) == 0 && strcmp(req.method, "POST") == 0) {
        response_len = handle_mkdir(&req, response, sizeof(response));
    } else if (strncmp(req.path, "/files/content", 14) == 0) {
        if (strcmp(req.method, "GET") == 0) {
            response_len = handle_read_file(&req, response, sizeof(response));
        } else if (strcmp(req.method, "PUT") == 0) {
            response_len = handle_write_file(&req, response, sizeof(response));
        }
    } else if (strncmp(req.path, "/files", 6) == 0) {
        if (strcmp(req.method, "GET") == 0) {
            response_len = handle_list_dir(&req, response, sizeof(response));
        } else if (strcmp(req.method, "DELETE") == 0) {
            response_len = handle_delete(&req, response, sizeof(response));
        }
    } else {
        response_len = snprintf(response, sizeof(response),
            "HTTP/1.1 404 Not Found\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 23\r\n\r\n"
            "{\"error\":\"not found\"}");
    }

    if (response_len > 0) {
        write(client_fd, response, response_len);
    }

    close(client_fd);
}

static void reap_zombies(int sig) {
    (void)sig;
    while (waitpid(-1, NULL, WNOHANG) > 0);
}

int main(void) {
    // Verify we are PID 1
    if (getpid() != 1) {
        fprintf(stderr, "hyperinit: not running as PID 1\n");
        return 1;
    }

    log_msg("hyperinit starting as PID 1");

    // Set up signal handlers
    signal(SIGCHLD, reap_zombies);

    // Mount filesystems
    log_msg("mounting filesystems");
    if (mount_filesystems() < 0) {
        log_msg("failed to mount filesystems");
        return 1;
    }

    // Create device nodes
    log_msg("creating device nodes");
    create_device_nodes();

    // Parse environment from kernel cmdline
    log_msg("parsing environment from cmdline");
    parse_cmdline_env();

    log_msg("init setup complete");

    // Create vsock server
    int server_fd = create_vsock_server();
    if (server_fd < 0) {
        log_msg("failed to create vsock server");
        return 1;
    }

    char msg[64];
    snprintf(msg, sizeof(msg), "listening on vsock port %d", VSOCK_PORT);
    log_msg(msg);

    // Main loop
    while (!shutdown_requested) {
        struct sockaddr_vm client_addr;
        socklen_t client_len = sizeof(client_addr);

        int client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &client_len);
        if (client_fd < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("accept");
            continue;
        }

        // Handle in a child process for isolation
        pid_t pid = fork();
        if (pid == 0) {
            // Child
            close(server_fd);
            handle_client(client_fd);
            _exit(0);
        } else if (pid > 0) {
            // Parent
            close(client_fd);
        } else {
            // Fork failed, handle in main process
            handle_client(client_fd);
        }
    }

    log_msg("shutting down");
    close(server_fd);

    // Sync filesystems
    sync();

    // Power off
    reboot(LINUX_REBOOT_CMD_POWER_OFF);

    return 0;
}
