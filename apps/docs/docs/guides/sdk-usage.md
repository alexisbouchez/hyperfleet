---
title: SDK Usage
description: Use the Hyperfleet TypeScript SDK for programmatic microVM management.
icon: code
---

Hyperfleet provides a TypeScript SDK for programmatic management of Firecracker microVMs. This guide covers the low-level `@hyperfleet/firecracker` package for direct VM control.

## Installation

The SDK is included in the Hyperfleet monorepo. For external projects:

```bash
# Coming soon to npm
npm install @hyperfleet/firecracker
```

## Basic Usage

### Creating a Machine

```typescript
import { Machine, DrivesBuilder } from "@hyperfleet/firecracker";

const machine = new Machine({
  socketPath: "/tmp/firecracker-my-vm.sock",
  kernelImagePath: ".hyperfleet/vmlinux",
  kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
  vcpuCount: 2,
  memSizeMib: 512,
  drives: new DrivesBuilder(".hyperfleet/alpine-rootfs.ext4").build(),
});
```

> **Note:** When using the REST API, `kernelImagePath`, `kernelArgs`, and the rootfs path are configured server-wide via environment variables. See [Environment Variables](/docs/configuration/environment-variables/). The SDK requires explicit configuration per-machine.

### Machine Configuration Options

```typescript
interface MachineConfig {
  // Required
  socketPath: string;          // Path for Firecracker API socket
  kernelImagePath: string;     // Path to kernel image
  vcpuCount: number;           // Number of vCPUs (min: 1)
  memSizeMib: number;          // Memory in MiB (min: 4)
  drives: Drive[];             // Storage drives

  // Optional
  kernelArgs?: string;         // Kernel boot arguments
  networkInterfaces?: NetworkInterface[];  // Network configuration
}
```

## Lifecycle Operations

### Starting a Machine

```typescript
async function startMachine() {
  const machine = new Machine({
    socketPath: "/tmp/fc.sock",
    kernelImagePath: ".hyperfleet/vmlinux",
    vcpuCount: 1,
    memSizeMib: 128,
    drives: new DrivesBuilder(".hyperfleet/rootfs.ext4").build(),
  });

  await machine.start();
  console.log("Machine started!");
  console.log("PID:", machine.getPid());
}
```

### Stopping a Machine

```typescript
// Graceful shutdown (sends ACPI shutdown signal)
await machine.shutdown();

// Or force stop
await machine.stop();
```

### Restarting a Machine

```typescript
// Restart with optional timeout (seconds)
await machine.restart(30);
```

### Pausing and Resuming

```typescript
// Pause execution
await machine.pause();

// Resume execution
await machine.resume();
```

## Executing Commands

### Basic Command Execution

```typescript
const result = await machine.exec(["ls", "-la", "/"]);

console.log("Exit code:", result.exitCode);
console.log("stdout:", result.stdout);
console.log("stderr:", result.stderr);
```

### With Timeout

```typescript
// 60 second timeout
const result = await machine.exec(["apt-get", "update"], 60000);
```

### Shell Commands

```typescript
// Use sh -c for shell features
const result = await machine.exec([
  "sh", "-c",
  "echo $HOME && ls -la | head -5"
]);
```

### Error Handling

```typescript
try {
  const result = await machine.exec(["some-command"]);

  if (result.exitCode !== 0) {
    console.error("Command failed:", result.stderr);
  }
} catch (error) {
  if (error.name === "TimeoutError") {
    console.error("Command timed out");
  } else {
    throw error;
  }
}
```

## Storage Configuration

### DrivesBuilder

The `DrivesBuilder` provides a fluent API for configuring storage:

```typescript
import { DrivesBuilder } from "@hyperfleet/firecracker";

// Basic rootfs drive
const drives = new DrivesBuilder("/path/to/rootfs.ext4").build();

// Read-only rootfs
const drives = new DrivesBuilder("/path/to/rootfs.ext4")
  .readOnly()
  .build();

// Multiple drives
const drives = new DrivesBuilder("/path/to/rootfs.ext4")
  .addDrive({
    driveId: "data",
    pathOnHost: "/path/to/data.ext4",
    isReadOnly: false,
    isRootDevice: false,
  })
  .build();
```

### Drive Configuration

```typescript
interface Drive {
  driveId: string;       // Unique identifier
  pathOnHost: string;    // Path to disk image on host
  isReadOnly: boolean;   // Read-only flag
  isRootDevice: boolean; // Is this the root filesystem?
}
```

## Network Configuration

### Adding Network Interfaces

```typescript
const machine = new Machine({
  socketPath: "/tmp/fc.sock",
  kernelImagePath: ".hyperfleet/vmlinux",
  vcpuCount: 1,
  memSizeMib: 128,
  drives: new DrivesBuilder(".hyperfleet/rootfs.ext4").build(),
  networkInterfaces: [
    {
      iface_id: "eth0",
      host_dev_name: "tap0",
      guest_mac: "AA:FC:00:00:00:01",
    },
  ],
});
```

### Network Interface Options

```typescript
interface NetworkInterface {
  iface_id: string;       // Interface ID in guest
  host_dev_name: string;  // TAP device name on host
  guest_mac?: string;     // MAC address for guest
}
```

## Getting Machine Information

### Check Running State

```typescript
if (machine.isRunning()) {
  console.log("Machine is running");
}
```

### Get Process ID

```typescript
const pid = machine.getPid();
if (pid) {
  console.log("Firecracker PID:", pid);
}
```

### Get Runtime Info

```typescript
const info = await machine.getInfo();

console.log("Machine ID:", info.id);
console.log("Status:", info.status);
console.log("vCPUs:", info.vcpuCount);
console.log("Memory:", info.memSizeMib, "MiB");
```

## Waiting for Completion

### Wait for Machine to Exit

```typescript
const exitCode = await machine.wait();
console.log("Machine exited with code:", exitCode);
```

## Complete Example

```typescript
import { Machine, DrivesBuilder } from "@hyperfleet/firecracker";

async function main() {
  // Create machine configuration
  const machine = new Machine({
    socketPath: "/tmp/firecracker-example.sock",
    kernelImagePath: ".hyperfleet/vmlinux",
    kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    vcpuCount: 2,
    memSizeMib: 512,
    drives: new DrivesBuilder(".hyperfleet/alpine-rootfs.ext4").build(),
    networkInterfaces: [
      {
        iface_id: "eth0",
        host_dev_name: "tap0",
      },
    ],
  });

  try {
    // Start the machine
    console.log("Starting machine...");
    await machine.start();
    console.log("Machine started! PID:", machine.getPid());

    // Run some commands
    console.log("\nRunning commands...");

    const uname = await machine.exec(["uname", "-a"]);
    console.log("Kernel:", uname.stdout.trim());

    const uptime = await machine.exec(["cat", "/proc/uptime"]);
    console.log("Uptime:", uptime.stdout.trim());

    const memory = await machine.exec(["free", "-m"]);
    console.log("Memory:\n", memory.stdout);

    // Install a package
    console.log("\nInstalling curl...");
    const install = await machine.exec(
      ["apk", "add", "--no-cache", "curl"],
      60000
    );

    if (install.exitCode === 0) {
      console.log("curl installed successfully");
    }

    // Shutdown gracefully
    console.log("\nShutting down...");
    await machine.shutdown();
    console.log("Machine stopped.");

  } catch (error) {
    console.error("Error:", error);

    // Ensure cleanup on error
    if (machine.isRunning()) {
      await machine.stop();
    }
  }
}

main();
```

## Error Handling

### Error Types

```typescript
import {
  TimeoutError,
  VsockError,
  FirecrackerApiError,
} from "@hyperfleet/errors";

try {
  await machine.exec(["long-running-command"], 5000);
} catch (error) {
  if (error instanceof TimeoutError) {
    console.error("Command timed out");
  } else if (error instanceof VsockError) {
    console.error("VM communication error:", error.message);
  } else if (error instanceof FirecrackerApiError) {
    console.error("Firecracker API error:", error.message);
  } else {
    throw error;
  }
}
```

## Next Steps

- [Machine Lifecycle](/docs/guides/machine-lifecycle/) - Understanding machine states
- [Networking](/docs/guides/networking/) - Network configuration details
- [API Reference](/docs/api/overview/) - REST API documentation
