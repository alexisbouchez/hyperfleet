# Hyperfleet

A Firecracker microVM orchestration platform. Hyperfleet provides a unified API for managing secure, fast-booting lightweight virtual machines with support for OCI images and file transfer.

## Features

- **Firecracker microVMs** - Sub-second boot times, minimal footprint
- **OCI Image Support** - Boot VMs from Docker/OCI images (e.g., `alpine:latest`)
- **File Transfer** - Upload/download files to/from running VMs
- **Command Execution** - Execute commands in VMs via vsock
- **Auto Networking** - Automatic TAP device and NAT configuration
- **API Key Authentication** - Secure API access

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- Linux with KVM support, or [Lima](https://lima-vm.io/) (for macOS)
- For OCI image support: `skopeo`, `umoci`

### Installation

```bash
# Clone the repository
git clone https://github.com/hyperfleet/hyperfleet.git
cd hyperfleet

# Install dependencies
bun install

# Run setup (installs Firecracker, downloads kernel/rootfs)
bun run setup
```

### Start the API Server

```bash
cd apps/api
bun run dev
```

The API will be available at `http://localhost:3000` with Swagger docs at `/docs`.

## API Usage

### Create a VM from OCI Image (minimal payload)

```bash
# Create a VM from an Alpine image
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "my-alpine-vm",
    "vcpu_count": 1,
    "mem_size_mib": 512,
    "image": "alpine:latest"
  }'
```

The create payload is intentionally small (name, CPU, RAM, image). The API also supports optional fields like `image_size_mib`, `registry_auth`, `network`, and `exposed_ports` if you need them.

### Create a VM with Custom Rootfs

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "my-vm",
    "vcpu_count": 2,
    "mem_size_mib": 512
  }'
```

The kernel and rootfs paths are configured via environment variables.

### Machine Lifecycle

```bash
# Start a machine
curl -X POST http://localhost:3000/machines/{id}/start \
  -H "Authorization: Bearer $API_KEY"

# Wait for a machine to reach running (default/max timeout: 30s)
curl "http://localhost:3000/machines/{id}/wait?status=running&timeout=30" \
  -H "Authorization: Bearer $API_KEY"

# Stop a machine
curl -X POST http://localhost:3000/machines/{id}/stop \
  -H "Authorization: Bearer $API_KEY"

# Restart a machine
curl -X POST http://localhost:3000/machines/{id}/restart \
  -H "Authorization: Bearer $API_KEY"

# Delete a machine
curl -X DELETE http://localhost:3000/machines/{id} \
  -H "Authorization: Bearer $API_KEY"
```

### List Machines

```bash
# List all machines
curl http://localhost:3000/machines \
  -H "Authorization: Bearer $API_KEY"

# Filter by status
curl "http://localhost:3000/machines?status=running" \
  -H "Authorization: Bearer $API_KEY"
```

Example response (trimmed for clarity):

```json
[
  {
    "id": "vm_01HXYZ...",
    "name": "my-alpine-vm",
    "status": "running",
    "vcpu_count": 1,
    "mem_size_mib": 512,
    "image_ref": "alpine:latest"
  }
]
```

The full response includes additional fields (kernel/rootfs paths, network, timestamps, etc.).

### Execute Commands

```bash
curl -X POST http://localhost:3000/machines/{id}/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "command": ["ls", "-la", "/"],
    "timeout": 30
  }'
```

`command` is preferred; `cmd` is still accepted for backward compatibility.

### File Transfer

```bash
# Upload a file (content is base64-encoded)
curl -X POST http://localhost:3000/machines/{id}/files \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "path": "/tmp/hello.txt",
    "content": "SGVsbG8gV29ybGQh"
  }'

# Download a file
curl "http://localhost:3000/machines/{id}/files?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $API_KEY"

# Get file info
curl "http://localhost:3000/machines/{id}/files/stat?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $API_KEY"

# Delete a file
curl -X DELETE "http://localhost:3000/machines/{id}/files?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $API_KEY"
```

## SDK Usage

```typescript
import { Machine } from "@hyperfleet/firecracker";

// Create a machine with OCI image
const machine = new Machine({
  socketPath: "/tmp/firecracker.sock",
  kernelImagePath: "/path/to/vmlinux",
  kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
  vcpuCount: 2,
  memSizeMib: 512,
  // OCI image will be resolved at start time
  imageRef: "alpine:latest",
  imageSizeMib: 1024,
  // Required for exec(): host UDS for vsock + guest agent in the image
  vsock: { guest_cid: 3, uds_path: "/tmp/hyperfleet.vsock" },
});

const startRes = await machine.start();
startRes.unwrap();

// Execute a command
const execRes = (await machine.exec(["uname", "-a"])).unwrap();
console.log(execRes.stdout);

// Graceful shutdown
const shutdownRes = await machine.shutdown();
shutdownRes.unwrap();
```

## Architecture

### Packages

| Package | Description |
|---------|-------------|
| `@hyperfleet/api` | REST API server (Elysia) |
| `@hyperfleet/firecracker` | Firecracker SDK |
| `@hyperfleet/oci` | OCI image handling |
| `@hyperfleet/runtime` | Runtime interface |
| `@hyperfleet/network` | Network management |
| `@hyperfleet/worker` | Database (SQLite + Kysely) |
| `@hyperfleet/logger` | Structured logging |
| `@hyperfleet/errors` | Error types |
| `@hyperfleet/resilience` | Circuit breaker, retry |

### Guest Components

| Component | Description |
|-----------|-------------|
| `guest/` | Minimal init system (PID 1) with vsock server for file transfer and exec |

## Configuration

### Environment Variables

```bash
# API Server
PORT=3000

# Paths (with defaults)
HYPERFLEET_SOCKET_DIR=/tmp
HYPERFLEET_KERNEL_IMAGE_PATH=assets/vmlinux
HYPERFLEET_KERNEL_ARGS="console=ttyS0 reboot=k panic=1 pci=off"
HYPERFLEET_ROOTFS_PATH=assets/alpine-rootfs.ext4

# OCI Image Service
HYPERFLEET_OCI_CACHE_DIR=/var/lib/hyperfleet/images
HYPERFLEET_OCI_MAX_CACHE_SIZE=10737418240  # 10GB

# File Transfer
HYPERFLEET_FILE_TRANSFER_TIMEOUT=60000     # 1 minute
HYPERFLEET_FILE_MAX_SIZE=104857600         # 100MB
```

## Building Guest Components

### Init System

The init system is a minimal PID 1 process written in C that handles:
- Mounting essential filesystems (/proc, /sys, /dev, /run, /tmp)
- Setting up networking (loopback interface)
- Running a vsock server for file operations and command execution
- Reaping zombie processes
- Handling shutdown signals

```bash
cd guest

# Build for x86_64 (requires musl for static linking)
make build-amd64

# Build for arm64 (requires cross-compiler)
make build-arm64

# Install to rootfs
make install ROOTFS=/path/to/rootfs
```

## Local Development (macOS)

### Prerequisites

- [Lima](https://lima-vm.io/) installed (`brew install lima`)

### Automated Setup

```bash
bun run setup
```

This will:
1. Create/start a Lima VM with nested virtualization
2. Install Firecracker
3. Download Alpine Linux kernel
4. Create Alpine Linux rootfs
5. Configure networking (TAP device, NAT)

### Run Tests

```bash
# All tests
bun test

# Unit tests only
bun run test:unit

# Integration tests (requires VM environment)
bun run test:integration
```

## API Reference

See the Swagger documentation at `/docs` when running the API server.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/machines` | List machines |
| `POST` | `/machines` | Create machine |
| `GET` | `/machines/:id` | Get machine |
| `DELETE` | `/machines/:id` | Delete machine |
| `POST` | `/machines/:id/start` | Start machine |
| `POST` | `/machines/:id/stop` | Stop machine |
| `POST` | `/machines/:id/restart` | Restart machine |
| `POST` | `/machines/:id/exec` | Execute command |
| `POST` | `/machines/:id/files` | Upload file |
| `GET` | `/machines/:id/files` | Download file |
| `GET` | `/machines/:id/files/stat` | Get file info |
| `DELETE` | `/machines/:id/files` | Delete file |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `bun test`
5. Run linting: `bun run lint`
6. Run type check: `bun run typecheck`
7. Submit a pull request

## License

MIT
