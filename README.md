# Hyperfleet

A multi-runtime container and microVM orchestration platform. Hyperfleet provides a unified API for managing workloads across different isolation technologies.

## Supported Runtimes

| Runtime | Type | Use Case |
|---------|------|----------|
| **Firecracker** | microVM | Secure, fast-booting lightweight VMs |
| **Cloud Hypervisor** | microVM | Feature-rich VMs with hot-plug support |
| **Docker** | Container | Standard container workloads |

## Project Structure

```
hyperfleet/
├── apps/
│   └── api/                    # REST API server (Elysia)
├── packages/
│   ├── runtime/               # Shared runtime interface
│   ├── firecracker/           # Firecracker microVM SDK
│   ├── cloud-hypervisor/      # Cloud Hypervisor SDK
│   ├── docker/                # Docker container SDK
│   └── worker/                # Database and shared utilities
└── scripts/
    └── setup.ts               # Development setup script
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- [Lima](https://lima-vm.io/) (for macOS local development)

### Installation

```bash
# Clone the repository
git clone https://github.com/alexisbouchez/hyperfleet.git
cd hyperfleet

# Install dependencies
bun install

# Run setup (installs Firecracker, Cloud Hypervisor, Docker in Lima VM)
bun run setup
```

### Start the API Server

```bash
cd apps/api
bun run dev
```

The API will be available at `http://localhost:3000` with Swagger docs at `/swagger`.

## API Usage

### Create a Firecracker microVM

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-firecracker-vm",
    "runtime_type": "firecracker",
    "vcpu_count": 2,
    "mem_size_mib": 512,
    "kernel_image_path": "/path/to/vmlinux",
    "rootfs_path": "/path/to/rootfs.ext4"
  }'
```

### Create a Cloud Hypervisor microVM

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-ch-vm",
    "runtime_type": "cloud-hypervisor",
    "vcpu_count": 4,
    "mem_size_mib": 1024,
    "kernel_image_path": "/path/to/vmlinux",
    "rootfs_path": "/path/to/rootfs.ext4"
  }'
```

### Create a Docker Container

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-container",
    "runtime_type": "docker",
    "vcpu_count": 2,
    "mem_size_mib": 512,
    "image": "nginx:latest",
    "ports": [{"host_port": 8080, "container_port": 80}],
    "env": {"NODE_ENV": "production"}
  }'
```

### List Machines

```bash
# List all machines
curl http://localhost:3000/machines

# Filter by runtime type
curl http://localhost:3000/machines?runtime_type=docker

# Filter by status
curl http://localhost:3000/machines?status=running
```

### Machine Lifecycle

```bash
# Start a machine
curl -X POST http://localhost:3000/machines/{id}/start

# Stop a machine
curl -X POST http://localhost:3000/machines/{id}/stop

# Restart a machine
curl -X POST http://localhost:3000/machines/{id}/restart

# Delete a machine
curl -X DELETE http://localhost:3000/machines/{id}
```

### Execute Commands

```bash
curl -X POST http://localhost:3000/machines/{id}/exec \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": ["ls", "-la"],
    "timeout": 30
  }'
```

## SDK Usage

### Firecracker

```typescript
import { Machine, DrivesBuilder } from "@hyperfleet/firecracker";

const machine = new Machine({
  socketPath: "/tmp/firecracker.sock",
  kernelImagePath: "/path/to/vmlinux",
  kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
  vcpuCount: 2,
  memSizeMib: 512,
  drives: new DrivesBuilder("/path/to/rootfs.ext4").build(),
  networkInterfaces: [{
    iface_id: "eth0",
    host_dev_name: "tap0",
  }],
});

await machine.start();

// Execute a command
const result = await machine.exec(["uname", "-a"]);
console.log(result.stdout);

// Graceful shutdown
await machine.shutdown();
```

### Cloud Hypervisor

```typescript
import { Machine } from "@hyperfleet/cloud-hypervisor";

const machine = new Machine({
  socketPath: "/tmp/cloud-hypervisor.sock",
  payload: {
    kernel: "/path/to/vmlinux",
    cmdline: "console=ttyS0 root=/dev/vda rw",
  },
  cpus: {
    boot_vcpus: 4,
    max_vcpus: 8,  // Supports CPU hot-plug
  },
  memory: {
    size: 1024 * 1024 * 1024,  // 1GB in bytes
    hotplug_size: 512 * 1024 * 1024,  // Allow hot-adding 512MB
  },
  disks: [{
    path: "/path/to/rootfs.ext4",
    readonly: false,
  }],
  net: [{
    tap: "tap0",
    mac: "02:00:00:00:00:01",
  }],
});

await machine.start();

// Hot-add a disk
await machine.addDisk({ path: "/path/to/data.ext4", id: "data" });

// Resize resources
await machine.resize({ desired_vcpus: 6, desired_ram: 2 * 1024 * 1024 * 1024 });

// Create a snapshot
await machine.createSnapshot("file:///path/to/snapshot");

await machine.shutdown();
```

### Docker

```typescript
import { Container } from "@hyperfleet/docker";

const container = new Container({
  id: "my-app",
  image: "node:20-alpine",
  cmd: ["node", "server.js"],
  cpus: 2,
  memoryMib: 512,
  env: {
    NODE_ENV: "production",
    PORT: "3000",
  },
  ports: [
    { hostPort: 3000, containerPort: 3000 },
  ],
  volumes: [
    { hostPath: "/data/app", containerPath: "/app", readOnly: false },
  ],
  restart: "unless-stopped",
});

await container.start();

// Execute a command
const result = await container.exec(["node", "--version"]);
console.log(result.stdout);

// Get logs
const logs = await container.logs({ tail: 100 });
console.log(logs);

// Stop and remove
await container.stop();
await container.remove();
```

## Runtime Interface

All runtimes implement the shared `Runtime` interface:

```typescript
interface Runtime {
  readonly type: RuntimeType;
  readonly id: string;

  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;

  isRunning(): boolean;
  getPid(): number | string | null;
  getInfo(): Promise<RuntimeInfo>;

  exec(cmd: string[], timeoutMs?: number): Promise<ExecResult>;
  wait(): Promise<number>;
}
```

## Local Development (macOS)

### Prerequisites

- [Lima](https://lima-vm.io/) installed (`brew install lima`)

### Automated Setup

The setup script handles everything:

```bash
bun run setup
```

This will:
1. Create/start a Lima VM with nested virtualization
2. Install Firecracker
3. Install Cloud Hypervisor
4. Install Docker
5. Download Alpine Linux kernel
6. Create Alpine Linux rootfs
7. Configure networking (TAP device, NAT)

### Manual Setup

If you prefer manual setup:

1. Start Lima VM with nested virtualization:
```bash
limactl start --set '.nestedVirtualization=true' template://default
```

2. Enable KVM access:
```bash
lima sudo usermod -aG kvm $USER
lima sudo chmod 666 /dev/kvm
```

3. Verify KVM is working:
```bash
lima ls -la /dev/kvm
```

## Architecture

### Database

Hyperfleet uses SQLite (via Kysely ORM) to store machine configurations:

```sql
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,  -- pending, starting, running, paused, stopping, stopped, failed
  runtime_type TEXT NOT NULL,  -- firecracker, docker, cloud-hypervisor
  vcpu_count INTEGER NOT NULL,
  mem_size_mib INTEGER NOT NULL,
  kernel_image_path TEXT,
  kernel_args TEXT,
  rootfs_path TEXT,
  socket_path TEXT,
  image TEXT,  -- Docker image
  container_id TEXT,  -- Docker container ID
  pid INTEGER,
  config_json TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);
```

### Handler Pattern

Each runtime uses a handler chain pattern for extensible lifecycle management:

```typescript
// Custom handler
const MyHandler: Handler = async (machine) => {
  console.log(`Starting machine ${machine.id}`);
};

// Add to handler chain
machine.handlers.init.prepend("MyHandler", MyHandler);
```

## Feature Comparison

| Feature | Firecracker | Cloud Hypervisor | Docker |
|---------|-------------|------------------|--------|
| Boot time | ~125ms | ~200ms | ~500ms |
| Memory overhead | ~5MB | ~10MB | ~50MB |
| CPU hot-plug | No | Yes | No |
| Memory hot-plug | No | Yes | No |
| Disk hot-plug | Yes | Yes | No |
| Live migration | No | Yes | No |
| Snapshots | Yes | Yes | No |
| GPU passthrough | No | Yes | Yes |
| Nested virtualization | No | Yes | N/A |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `bun test`
5. Run linting: `bun run lint`
6. Submit a pull request

## License

MIT
