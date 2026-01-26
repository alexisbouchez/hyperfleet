# Hyperfleet Init System

A minimal init system (PID 1) designed for Firecracker microVMs with built-in vsock server for file operations and command execution.

## Features

- **Filesystem Setup**: Mounts `/proc`, `/sys`, `/dev`, `/dev/pts`, `/run`, `/tmp`
- **Device Nodes**: Creates essential device nodes if not present
- **Networking**: Configures loopback interface
- **Vsock Server**: Built-in vsock server (port 52) for file operations and command execution
- **Zombie Reaping**: Properly reaps all child processes
- **Signal Handling**: Handles SIGTERM (shutdown) and SIGINT (reboot)
- **Graceful Shutdown**: Terminates processes, syncs filesystems, unmounts

## Vsock Operations

The init system listens on vsock port 52 and handles JSON requests:

### File Read
```json
{"operation": "file_read", "path": "/etc/hostname"}
```

### File Write
```json
{"operation": "file_write", "path": "/tmp/test.txt", "content": "SGVsbG8gV29ybGQh"}
```
Content is base64-encoded.

### File Stat
```json
{"operation": "file_stat", "path": "/etc/hostname"}
```

### File Delete
```json
{"operation": "file_delete", "path": "/tmp/test.txt"}
```

### Command Execution
```json
{"operation": "exec", "cmd": ["ls", "-la", "/"], "timeout": 30000}
```

### Ping
```json
{"operation": "ping"}
```

## Building

### Prerequisites

For static linking (recommended), you need musl:

```bash
# Ubuntu/Debian
sudo apt install musl-tools

# macOS (for cross-compilation)
brew install FiloSottile/musl-cross/musl-cross
```

### Build

```bash
# Build for current architecture
make build

# Build for x86_64
make build-amd64

# Build for aarch64 (requires cross-compiler)
make build-arm64

# Build both
make all
```

The binaries will be placed in `../assets/init/`.

### Install to Rootfs

```bash
# Install to a rootfs directory
make install ROOTFS=/path/to/your/rootfs
```

This copies the init binary as `/init` in the rootfs.

## Usage

The init binary should be placed at `/init` or `/sbin/init` in your rootfs. Firecracker will execute it as PID 1.

### Kernel Arguments

Pass `init=/init` in your kernel boot arguments if the init is not at the default location.

### Debug Mode

To enable debug logging, pass `-d` or `--debug`:

```
init=/init -- -d
```

## Behavior

1. **Startup**:
   - Mounts essential filesystems
   - Creates device nodes
   - Sets hostname to "hyperfleet"
   - Configures loopback interface
   - Starts vsock server on port 52

2. **Runtime**:
   - Handles vsock requests for file operations and command execution
   - Reaps zombie processes

3. **Shutdown** (SIGTERM):
   - Closes vsock server
   - Sends SIGTERM to all processes
   - Waits 2 seconds
   - Sends SIGKILL to remaining processes
   - Syncs and unmounts filesystems
   - Powers off

4. **Reboot** (SIGINT/Ctrl+Alt+Del):
   - Same as shutdown but reboots instead of powering off

## License

Part of the Hyperfleet project.
