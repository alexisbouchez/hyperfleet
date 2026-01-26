/*
 * Hyperfleet Init System
 *
 * A minimal init (PID 1) for Firecracker microVMs.
 * Responsibilities:
 *   - Mount essential filesystems (/proc, /sys, /dev, /dev/pts, /run)
 *   - Setup networking (loopback, configure eth0 if present)
 *   - Listen on vsock for file operations and command execution
 *   - Reap zombie processes
 *   - Handle shutdown signals
 *
 * Build: gcc -static -O2 -o init init.c
 */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <linux/if.h>
#include <linux/sockios.h>
#include <linux/vm_sockets.h>
#include <sys/ioctl.h>
#include <dirent.h>
#include <pthread.h>

/* Configuration */
#define HOSTNAME "hyperfleet"
#define VSOCK_PORT 52
#define MAX_REQUEST_SIZE (128 * 1024 * 1024) /* 128MB */
#define MAX_RESPONSE_SIZE (128 * 1024 * 1024)
#define BASE64_ENCODE_SIZE(n) (((n) + 2) / 3 * 4 + 1)
#define BASE64_DECODE_SIZE(n) (((n) + 3) / 4 * 3)

/* Log levels */
#define LOG_DEBUG 0
#define LOG_INFO  1
#define LOG_WARN  2
#define LOG_ERROR 3

static int log_level = LOG_INFO;
static volatile sig_atomic_t shutdown_requested = 0;
static volatile sig_atomic_t reboot_requested = 0;

/* Logging */
static void log_msg(int level, const char *fmt, ...) {
    if (level < log_level) return;

    const char *prefix;
    switch (level) {
        case LOG_DEBUG: prefix = "[DEBUG]"; break;
        case LOG_INFO:  prefix = "[INFO] "; break;
        case LOG_WARN:  prefix = "[WARN] "; break;
        case LOG_ERROR: prefix = "[ERROR]"; break;
        default:        prefix = "[?]    "; break;
    }

    time_t now = time(NULL);
    struct tm *tm = localtime(&now);
    char timebuf[32];
    strftime(timebuf, sizeof(timebuf), "%H:%M:%S", tm);

    fprintf(stderr, "%s %s init: ", timebuf, prefix);

    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);

    fprintf(stderr, "\n");
    fflush(stderr);
}

#define log_debug(...) log_msg(LOG_DEBUG, __VA_ARGS__)
#define log_info(...)  log_msg(LOG_INFO, __VA_ARGS__)
#define log_warn(...)  log_msg(LOG_WARN, __VA_ARGS__)
#define log_error(...) log_msg(LOG_ERROR, __VA_ARGS__)

/* Base64 encoding table */
static const char base64_table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const int base64_decode_table[256] = {
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
    52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
    -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1
};

static char *base64_encode(const unsigned char *data, size_t len, size_t *out_len) {
    size_t olen = BASE64_ENCODE_SIZE(len);
    char *out = malloc(olen);
    if (!out) return NULL;

    char *p = out;
    for (size_t i = 0; i < len; i += 3) {
        unsigned int n = ((unsigned int)data[i]) << 16;
        if (i + 1 < len) n |= ((unsigned int)data[i + 1]) << 8;
        if (i + 2 < len) n |= data[i + 2];

        *p++ = base64_table[(n >> 18) & 0x3F];
        *p++ = base64_table[(n >> 12) & 0x3F];
        *p++ = (i + 1 < len) ? base64_table[(n >> 6) & 0x3F] : '=';
        *p++ = (i + 2 < len) ? base64_table[n & 0x3F] : '=';
    }
    *p = '\0';
    if (out_len) *out_len = p - out;
    return out;
}

static unsigned char *base64_decode(const char *data, size_t len, size_t *out_len) {
    if (len % 4 != 0) return NULL;

    size_t olen = BASE64_DECODE_SIZE(len);
    if (data[len - 1] == '=') olen--;
    if (data[len - 2] == '=') olen--;

    unsigned char *out = malloc(olen + 1);
    if (!out) return NULL;

    size_t j = 0;
    for (size_t i = 0; i < len; i += 4) {
        int a = base64_decode_table[(unsigned char)data[i]];
        int b = base64_decode_table[(unsigned char)data[i + 1]];
        int c = base64_decode_table[(unsigned char)data[i + 2]];
        int d = base64_decode_table[(unsigned char)data[i + 3]];

        if (a < 0 || b < 0) { free(out); return NULL; }
        if (data[i + 2] != '=' && c < 0) { free(out); return NULL; }
        if (data[i + 3] != '=' && d < 0) { free(out); return NULL; }

        unsigned int n = (a << 18) | (b << 12) | ((c >= 0 ? c : 0) << 6) | (d >= 0 ? d : 0);
        out[j++] = (n >> 16) & 0xFF;
        if (data[i + 2] != '=') out[j++] = (n >> 8) & 0xFF;
        if (data[i + 3] != '=') out[j++] = n & 0xFF;
    }

    out[j] = '\0';
    if (out_len) *out_len = j;
    return out;
}

/* Simple JSON parsing helpers */
static char *json_get_string(const char *json, const char *key) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\"", key);

    const char *start = strstr(json, search);
    if (!start) return NULL;

    start += strlen(search);
    while (*start && (*start == ' ' || *start == ':' || *start == '\t')) start++;

    if (*start != '"') return NULL;
    start++;

    const char *end = start;
    while (*end && *end != '"') {
        if (*end == '\\' && *(end + 1)) end++;
        end++;
    }

    size_t len = end - start;
    char *result = malloc(len + 1);
    if (!result) return NULL;

    /* Handle escape sequences */
    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        if (start[i] == '\\' && i + 1 < len) {
            i++;
            switch (start[i]) {
                case 'n': result[j++] = '\n'; break;
                case 'r': result[j++] = '\r'; break;
                case 't': result[j++] = '\t'; break;
                case '\\': result[j++] = '\\'; break;
                case '"': result[j++] = '"'; break;
                default: result[j++] = start[i]; break;
            }
        } else {
            result[j++] = start[i];
        }
    }
    result[j] = '\0';
    return result;
}

static int json_get_int(const char *json, const char *key, int *value) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\"", key);

    const char *start = strstr(json, search);
    if (!start) return -1;

    start += strlen(search);
    while (*start && (*start == ' ' || *start == ':' || *start == '\t')) start++;

    *value = atoi(start);
    return 0;
}

/* Escape string for JSON */
static char *json_escape(const char *str) {
    size_t len = strlen(str);
    char *out = malloc(len * 2 + 1);
    if (!out) return NULL;

    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        switch (str[i]) {
            case '"':  out[j++] = '\\'; out[j++] = '"'; break;
            case '\\': out[j++] = '\\'; out[j++] = '\\'; break;
            case '\n': out[j++] = '\\'; out[j++] = 'n'; break;
            case '\r': out[j++] = '\\'; out[j++] = 'r'; break;
            case '\t': out[j++] = '\\'; out[j++] = 't'; break;
            default:
                if ((unsigned char)str[i] < 32) {
                    j += snprintf(out + j, 7, "\\u%04x", (unsigned char)str[i]);
                } else {
                    out[j++] = str[i];
                }
        }
    }
    out[j] = '\0';
    return out;
}

/* Signal handlers */
static void handle_sigterm(int sig) {
    (void)sig;
    shutdown_requested = 1;
}

static void handle_sigint(int sig) {
    (void)sig;
    reboot_requested = 1;
}

static void handle_sigchld(int sig) {
    (void)sig;
}

static void setup_signals(void) {
    struct sigaction sa;

    sa.sa_handler = SIG_IGN;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGHUP, &sa, NULL);
    sigaction(SIGUSR1, &sa, NULL);
    sigaction(SIGUSR2, &sa, NULL);

    sa.sa_handler = handle_sigterm;
    sigaction(SIGTERM, &sa, NULL);

    sa.sa_handler = handle_sigint;
    sigaction(SIGINT, &sa, NULL);

    sa.sa_handler = handle_sigchld;
    sa.sa_flags = SA_NOCLDSTOP;
    sigaction(SIGCHLD, &sa, NULL);
}

/* Filesystem mounting */
static int mount_fs(const char *source, const char *target,
                    const char *fstype, unsigned long flags,
                    const char *data) {
    struct stat st;

    if (stat(target, &st) != 0) {
        if (mkdir(target, 0755) != 0 && errno != EEXIST) {
            log_error("mkdir %s: %s", target, strerror(errno));
            return -1;
        }
    }

    if (mount(source, target, fstype, flags, data) != 0) {
        if (errno != EBUSY) {
            log_error("mount %s on %s: %s", fstype, target, strerror(errno));
            return -1;
        }
        log_debug("%s already mounted", target);
    } else {
        log_debug("mounted %s on %s", fstype, target);
    }

    return 0;
}

static int setup_filesystems(void) {
    log_info("mounting filesystems");

    if (mount_fs("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) {
        return -1;
    }

    if (mount_fs("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) {
        return -1;
    }

    if (mount_fs("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, "mode=0755") != 0) {
        if (mount_fs("tmpfs", "/dev", "tmpfs", MS_NOSUID, "mode=0755") != 0) {
            return -1;
        }
    }

    mkdir("/dev/pts", 0755);
    if (mount_fs("devpts", "/dev/pts", "devpts", MS_NOSUID | MS_NOEXEC,
                 "gid=5,mode=620,ptmxmode=666") != 0) {
        log_warn("failed to mount devpts");
    }

    if (mount_fs("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755") != 0) {
        log_warn("failed to mount /run");
    }

    if (mount_fs("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777") != 0) {
        log_warn("failed to mount /tmp");
    }

    struct {
        const char *path;
        mode_t mode;
        dev_t dev;
    } devices[] = {
        { "/dev/null",    S_IFCHR | 0666, makedev(1, 3) },
        { "/dev/zero",    S_IFCHR | 0666, makedev(1, 5) },
        { "/dev/full",    S_IFCHR | 0666, makedev(1, 7) },
        { "/dev/random",  S_IFCHR | 0666, makedev(1, 8) },
        { "/dev/urandom", S_IFCHR | 0666, makedev(1, 9) },
        { "/dev/tty",     S_IFCHR | 0666, makedev(5, 0) },
        { "/dev/console", S_IFCHR | 0600, makedev(5, 1) },
        { "/dev/ptmx",    S_IFCHR | 0666, makedev(5, 2) },
        { NULL, 0, 0 }
    };

    for (int i = 0; devices[i].path != NULL; i++) {
        struct stat st;
        if (stat(devices[i].path, &st) != 0) {
            if (mknod(devices[i].path, devices[i].mode, devices[i].dev) != 0 &&
                errno != EEXIST) {
                log_debug("mknod %s: %s", devices[i].path, strerror(errno));
            }
        }
    }

    symlink("/proc/self/fd", "/dev/fd");
    symlink("/proc/self/fd/0", "/dev/stdin");
    symlink("/proc/self/fd/1", "/dev/stdout");
    symlink("/proc/self/fd/2", "/dev/stderr");

    return 0;
}

/* Networking setup */
static int setup_loopback(void) {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        log_error("socket: %s", strerror(errno));
        return -1;
    }

    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, "lo", IFNAMSIZ);

    if (ioctl(sock, SIOCGIFFLAGS, &ifr) < 0) {
        log_error("ioctl SIOCGIFFLAGS: %s", strerror(errno));
        close(sock);
        return -1;
    }

    ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
    if (ioctl(sock, SIOCSIFFLAGS, &ifr) < 0) {
        log_error("ioctl SIOCSIFFLAGS: %s", strerror(errno));
        close(sock);
        return -1;
    }

    close(sock);
    log_debug("loopback interface up");
    return 0;
}

static int setup_networking(void) {
    log_info("configuring network");
    if (setup_loopback() != 0) {
        log_warn("failed to setup loopback interface");
    }
    return 0;
}

static int setup_hostname(void) {
    if (sethostname(HOSTNAME, strlen(HOSTNAME)) != 0) {
        log_warn("sethostname: %s", strerror(errno));
        return -1;
    }
    log_debug("hostname set to %s", HOSTNAME);
    return 0;
}

/* File operations */
static char *handle_file_read(const char *path) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        char *err = NULL;
        asprintf(&err, "{\"success\":false,\"error\":\"open: %s\"}\n", strerror(errno));
        return err;
    }

    struct stat st;
    if (fstat(fd, &st) < 0) {
        close(fd);
        char *err = NULL;
        asprintf(&err, "{\"success\":false,\"error\":\"fstat: %s\"}\n", strerror(errno));
        return err;
    }

    if (st.st_size > MAX_REQUEST_SIZE) {
        close(fd);
        return strdup("{\"success\":false,\"error\":\"file too large\"}\n");
    }

    unsigned char *buf = malloc(st.st_size);
    if (!buf) {
        close(fd);
        return strdup("{\"success\":false,\"error\":\"out of memory\"}\n");
    }

    ssize_t n = read(fd, buf, st.st_size);
    close(fd);

    if (n < 0) {
        free(buf);
        char *err = NULL;
        asprintf(&err, "{\"success\":false,\"error\":\"read: %s\"}\n", strerror(errno));
        return err;
    }

    size_t b64_len;
    char *b64 = base64_encode(buf, n, &b64_len);
    free(buf);

    if (!b64) {
        return strdup("{\"success\":false,\"error\":\"base64 encode failed\"}\n");
    }

    char *response = NULL;
    asprintf(&response, "{\"success\":true,\"data\":{\"content\":\"%s\",\"size\":%zd}}\n", b64, n);
    free(b64);

    return response ? response : strdup("{\"success\":false,\"error\":\"out of memory\"}\n");
}

static char *handle_file_write(const char *path, const char *content) {
    size_t content_len = strlen(content);
    size_t data_len;
    unsigned char *data = base64_decode(content, content_len, &data_len);

    if (!data) {
        return strdup("{\"success\":false,\"error\":\"base64 decode failed\"}\n");
    }

    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        free(data);
        char *err = NULL;
        asprintf(&err, "{\"success\":false,\"error\":\"open: %s\"}\n", strerror(errno));
        return err;
    }

    ssize_t written = write(fd, data, data_len);
    int write_errno = errno;
    close(fd);
    free(data);

    if (written < 0) {
        char *err = NULL;
        asprintf(&err, "{\"success\":false,\"error\":\"write: %s\"}\n", strerror(write_errno));
        return err;
    }

    char *response = NULL;
    asprintf(&response, "{\"success\":true,\"data\":{\"bytes_written\":%zd}}\n", written);
    return response ? response : strdup("{\"success\":false,\"error\":\"out of memory\"}\n");
}

static char *handle_file_stat(const char *path) {
    struct stat st;
    if (stat(path, &st) < 0) {
        char *err = NULL;
        asprintf(&err, "{\"success\":false,\"error\":\"stat: %s\"}\n", strerror(errno));
        return err;
    }

    char mode[16];
    snprintf(mode, sizeof(mode), "%o", st.st_mode & 07777);

    char mod_time[64];
    struct tm *tm = gmtime(&st.st_mtime);
    strftime(mod_time, sizeof(mod_time), "%Y-%m-%dT%H:%M:%SZ", tm);

    char *response = NULL;
    asprintf(&response,
        "{\"success\":true,\"data\":{\"path\":\"%s\",\"size\":%ld,\"mode\":\"%s\",\"mod_time\":\"%s\",\"is_dir\":%s}}\n",
        path, (long)st.st_size, mode, mod_time, S_ISDIR(st.st_mode) ? "true" : "false");

    return response ? response : strdup("{\"success\":false,\"error\":\"out of memory\"}\n");
}

static char *handle_file_delete(const char *path) {
    if (unlink(path) < 0) {
        if (errno == EISDIR) {
            if (rmdir(path) < 0) {
                char *err = NULL;
                asprintf(&err, "{\"success\":false,\"error\":\"rmdir: %s\"}\n", strerror(errno));
                return err;
            }
        } else {
            char *err = NULL;
            asprintf(&err, "{\"success\":false,\"error\":\"unlink: %s\"}\n", strerror(errno));
            return err;
        }
    }

    return strdup("{\"success\":true,\"data\":{}}\n");
}

static char *handle_exec(const char *json) {
    /* Parse cmd array - simple parsing for ["cmd", "arg1", "arg2"] */
    char *argv[256];
    int argc = 0;

    /* Find the cmd array */
    const char *arr_start = strstr(json, "\"cmd\"");
    if (!arr_start) {
        return strdup("{\"success\":false,\"error\":\"missing cmd\"}\n");
    }
    arr_start = strchr(arr_start, '[');
    if (!arr_start) {
        return strdup("{\"success\":false,\"error\":\"cmd must be an array\"}\n");
    }

    if (arr_start) {
        arr_start++;
        const char *p = arr_start;

        while (*p && *p != ']' && argc < 255) {
            while (*p && (*p == ' ' || *p == ',' || *p == '\t' || *p == '\n')) p++;
            if (*p == '"') {
                p++;
                const char *end = p;
                while (*end && *end != '"') {
                    if (*end == '\\' && *(end + 1)) end++;
                    end++;
                }
                size_t len = end - p;
                argv[argc] = malloc(len + 1);
                if (argv[argc]) {
                    size_t j = 0;
                    for (size_t i = 0; i < len; i++) {
                        if (p[i] == '\\' && i + 1 < len) {
                            i++;
                            switch (p[i]) {
                                case 'n': argv[argc][j++] = '\n'; break;
                                case 't': argv[argc][j++] = '\t'; break;
                                default: argv[argc][j++] = p[i]; break;
                            }
                        } else {
                            argv[argc][j++] = p[i];
                        }
                    }
                    argv[argc][j] = '\0';
                    argc++;
                }
                p = end;
                if (*p == '"') p++;
            } else if (*p && *p != ']') {
                p++;
            }
        }
    }
    argv[argc] = NULL;

    if (argc == 0) {
        return strdup("{\"success\":false,\"error\":\"empty command\"}\n");
    }

    int timeout_ms = 30000;
    json_get_int(json, "timeout", &timeout_ms);

    int stdout_pipe[2], stderr_pipe[2];
    if (pipe(stdout_pipe) < 0 || pipe(stderr_pipe) < 0) {
        for (int i = 0; i < argc; i++) free(argv[i]);
        return strdup("{\"success\":false,\"error\":\"pipe failed\"}\n");
    }

    pid_t pid = fork();
    if (pid < 0) {
        for (int i = 0; i < argc; i++) free(argv[i]);
        close(stdout_pipe[0]); close(stdout_pipe[1]);
        close(stderr_pipe[0]); close(stderr_pipe[1]);
        return strdup("{\"success\":false,\"error\":\"fork failed\"}\n");
    }

    if (pid == 0) {
        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        close(stdout_pipe[1]);
        close(stderr_pipe[1]);

        int fd = open("/dev/null", O_RDONLY);
        if (fd >= 0) { dup2(fd, STDIN_FILENO); close(fd); }

        char *envp[] = {
            "PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
            "HOME=/root",
            "TERM=linux",
            NULL
        };

        execve(argv[0], argv, envp);

        /* If execve failed, try with /bin/sh -c */
        char cmd_line[4096] = "";
        for (int i = 0; argv[i]; i++) {
            if (i > 0) strcat(cmd_line, " ");
            strcat(cmd_line, argv[i]);
        }
        char *sh_argv[] = { "/bin/sh", "-c", cmd_line, NULL };
        execve("/bin/sh", sh_argv, envp);

        _exit(127);
    }

    for (int i = 0; i < argc; i++) free(argv[i]);

    close(stdout_pipe[1]);
    close(stderr_pipe[1]);

    /* Set non-blocking */
    fcntl(stdout_pipe[0], F_SETFL, O_NONBLOCK);
    fcntl(stderr_pipe[0], F_SETFL, O_NONBLOCK);

    char *stdout_buf = malloc(MAX_RESPONSE_SIZE);
    char *stderr_buf = malloc(MAX_RESPONSE_SIZE);
    size_t stdout_len = 0, stderr_len = 0;

    if (!stdout_buf || !stderr_buf) {
        free(stdout_buf);
        free(stderr_buf);
        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        kill(pid, SIGKILL);
        waitpid(pid, NULL, 0);
        return strdup("{\"success\":false,\"error\":\"out of memory\"}\n");
    }

    time_t start = time(NULL);
    int status = 0;
    bool done = false;

    while (!done) {
        ssize_t n;

        n = read(stdout_pipe[0], stdout_buf + stdout_len, MAX_RESPONSE_SIZE - stdout_len - 1);
        if (n > 0) stdout_len += n;

        n = read(stderr_pipe[0], stderr_buf + stderr_len, MAX_RESPONSE_SIZE - stderr_len - 1);
        if (n > 0) stderr_len += n;

        int wpid = waitpid(pid, &status, WNOHANG);
        if (wpid > 0) {
            /* Read any remaining data */
            while ((n = read(stdout_pipe[0], stdout_buf + stdout_len, MAX_RESPONSE_SIZE - stdout_len - 1)) > 0)
                stdout_len += n;
            while ((n = read(stderr_pipe[0], stderr_buf + stderr_len, MAX_RESPONSE_SIZE - stderr_len - 1)) > 0)
                stderr_len += n;
            done = true;
        } else if (time(NULL) - start > timeout_ms / 1000) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            done = true;
        } else {
            usleep(10000);
        }
    }

    close(stdout_pipe[0]);
    close(stderr_pipe[0]);

    stdout_buf[stdout_len] = '\0';
    stderr_buf[stderr_len] = '\0';

    int exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;

    char *stdout_escaped = json_escape(stdout_buf);
    char *stderr_escaped = json_escape(stderr_buf);
    free(stdout_buf);
    free(stderr_buf);

    char *response = NULL;
    asprintf(&response,
        "{\"success\":true,\"data\":{\"exit_code\":%d,\"stdout\":\"%s\",\"stderr\":\"%s\"}}\n",
        exit_code,
        stdout_escaped ? stdout_escaped : "",
        stderr_escaped ? stderr_escaped : "");

    free(stdout_escaped);
    free(stderr_escaped);

    return response ? response : strdup("{\"success\":false,\"error\":\"out of memory\"}\n");
}

/* Handle vsock connection */
static void *handle_connection(void *arg) {
    int client_fd = (int)(intptr_t)arg;

    char *request = malloc(MAX_REQUEST_SIZE);
    if (!request) {
        close(client_fd);
        return NULL;
    }

    size_t total = 0;
    ssize_t n;

    while (total < MAX_REQUEST_SIZE - 1) {
        n = read(client_fd, request + total, MAX_REQUEST_SIZE - total - 1);
        if (n <= 0) break;
        total += n;

        /* Check for newline (end of request) */
        if (memchr(request, '\n', total)) break;
    }

    request[total] = '\0';

    char *response = NULL;
    char *operation = json_get_string(request, "operation");

    if (!operation) {
        response = strdup("{\"success\":false,\"error\":\"missing operation\"}\n");
    } else if (strcmp(operation, "ping") == 0) {
        response = strdup("{\"success\":true,\"data\":{\"pong\":true}}\n");
    } else if (strcmp(operation, "file_read") == 0) {
        char *path = json_get_string(request, "path");
        if (path) {
            response = handle_file_read(path);
            free(path);
        } else {
            response = strdup("{\"success\":false,\"error\":\"missing path\"}\n");
        }
    } else if (strcmp(operation, "file_write") == 0) {
        char *path = json_get_string(request, "path");
        char *content = json_get_string(request, "content");
        if (path && content) {
            response = handle_file_write(path, content);
        } else {
            response = strdup("{\"success\":false,\"error\":\"missing path or content\"}\n");
        }
        free(path);
        free(content);
    } else if (strcmp(operation, "file_stat") == 0) {
        char *path = json_get_string(request, "path");
        if (path) {
            response = handle_file_stat(path);
            free(path);
        } else {
            response = strdup("{\"success\":false,\"error\":\"missing path\"}\n");
        }
    } else if (strcmp(operation, "file_delete") == 0) {
        char *path = json_get_string(request, "path");
        if (path) {
            response = handle_file_delete(path);
            free(path);
        } else {
            response = strdup("{\"success\":false,\"error\":\"missing path\"}\n");
        }
    } else if (strcmp(operation, "exec") == 0) {
        response = handle_exec(request);
    } else {
        response = strdup("{\"success\":false,\"error\":\"unknown operation\"}\n");
    }

    free(operation);
    free(request);

    if (response) {
        write(client_fd, response, strlen(response));
        free(response);
    }

    close(client_fd);
    return NULL;
}

/* Vsock server */
static int vsock_fd = -1;

static void *vsock_server(void *arg) {
    (void)arg;

    vsock_fd = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (vsock_fd < 0) {
        log_error("vsock socket: %s", strerror(errno));
        return NULL;
    }

    struct sockaddr_vm addr = {
        .svm_family = AF_VSOCK,
        .svm_cid = VMADDR_CID_ANY,
        .svm_port = VSOCK_PORT,
    };

    if (bind(vsock_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        log_error("vsock bind: %s", strerror(errno));
        close(vsock_fd);
        vsock_fd = -1;
        return NULL;
    }

    if (listen(vsock_fd, 16) < 0) {
        log_error("vsock listen: %s", strerror(errno));
        close(vsock_fd);
        vsock_fd = -1;
        return NULL;
    }

    log_info("vsock server listening on port %d", VSOCK_PORT);

    while (!shutdown_requested && !reboot_requested) {
        struct sockaddr_vm client_addr;
        socklen_t client_len = sizeof(client_addr);

        int client_fd = accept(vsock_fd, (struct sockaddr *)&client_addr, &client_len);
        if (client_fd < 0) {
            if (errno == EINTR) continue;
            log_error("vsock accept: %s", strerror(errno));
            continue;
        }

        pthread_t thread;
        if (pthread_create(&thread, NULL, handle_connection, (void *)(intptr_t)client_fd) != 0) {
            log_error("pthread_create: %s", strerror(errno));
            close(client_fd);
        } else {
            pthread_detach(thread);
        }
    }

    return NULL;
}

/* Reap zombie processes */
static void reap_zombies(void) {
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        if (WIFEXITED(status)) {
            log_debug("process %d exited with status %d", pid, WEXITSTATUS(status));
        } else if (WIFSIGNALED(status)) {
            log_debug("process %d killed by signal %d", pid, WTERMSIG(status));
        }
    }
}

/* Shutdown sequence */
static void do_shutdown(bool do_reboot) {
    log_info("%s initiated", do_reboot ? "reboot" : "shutdown");

    if (vsock_fd >= 0) {
        close(vsock_fd);
        vsock_fd = -1;
    }

    log_info("sending SIGTERM to all processes");
    kill(-1, SIGTERM);
    sleep(2);

    log_info("sending SIGKILL to remaining processes");
    kill(-1, SIGKILL);
    while (waitpid(-1, NULL, WNOHANG) > 0);

    log_info("syncing filesystems");
    sync();

    log_info("unmounting filesystems");
    umount2("/tmp", MNT_DETACH);
    umount2("/run", MNT_DETACH);
    umount2("/dev/pts", MNT_DETACH);
    umount2("/dev", MNT_DETACH);
    umount2("/sys", MNT_DETACH);
    umount2("/proc", MNT_DETACH);

    sync();

    if (do_reboot) {
        log_info("rebooting...");
        reboot(RB_AUTOBOOT);
    } else {
        log_info("powering off...");
        reboot(RB_POWER_OFF);
    }

    _exit(0);
}

/* Main loop */
static void main_loop(void) {
    while (!shutdown_requested && !reboot_requested) {
        reap_zombies();
        usleep(100000);
    }
}

static void print_banner(void) {
    log_info("Hyperfleet init starting");
    log_info("PID: %d", getpid());
}

int main(int argc, char *argv[]) {
    if (getpid() != 1) {
        fprintf(stderr, "init: must be run as PID 1\n");
        return 1;
    }

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-d") == 0 || strcmp(argv[i], "--debug") == 0) {
            log_level = LOG_DEBUG;
        }
    }

    print_banner();
    setup_signals();

    if (setup_filesystems() != 0) {
        log_error("failed to setup filesystems");
    }

    setup_hostname();

    if (setup_networking() != 0) {
        log_error("failed to setup networking");
    }

    /* Start vsock server in a thread */
    pthread_t vsock_thread;
    if (pthread_create(&vsock_thread, NULL, vsock_server, NULL) != 0) {
        log_error("failed to start vsock server: %s", strerror(errno));
    }

    log_info("init ready");

    main_loop();

    do_shutdown(reboot_requested);

    return 0;
}
