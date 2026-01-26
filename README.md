# Hyperfleet

A Firecracker microVM orchestration platform. Hyperfleet provides a unified API for managing secure, fast-booting lightweight virtual machines.

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

# Run setup (installs Firecracker in Lima VM)
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
    "name": "my-vm",
    "vcpu_count": 2,
    "mem_size_mib": 512,
    "kernel_image_path": "/path/to/vmlinux",
    "rootfs_path": "/path/to/rootfs.ext4"
  }'
```

### List Machines

```bash
# List all machines
curl http://localhost:3000/machines

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

## Runtime Interface

All machines implement the shared `Runtime` interface:

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
  getPid(): number | null;
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
3. Download Alpine Linux kernel
4. Create Alpine Linux rootfs
5. Configure networking (TAP device, NAT)

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

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `bun test`
5. Run linting: `bun run lint`
6. Submit a pull request

## License

MIT
