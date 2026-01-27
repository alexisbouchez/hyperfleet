---
title: Quickstart
description: Create and manage your first Firecracker microVM with Hyperfleet.
icon: zap
---

This guide will walk you through creating your first microVM using Hyperfleet's REST API.

## Start the API Server

First, start the Hyperfleet API server:

```bash
cd apps/api
bun run dev
```

The server starts on `http://localhost:3000` by default.

## Disable Authentication (Development)

For local development, you can disable authentication:

```bash
DISABLE_AUTH=true bun run dev
```

For production, you'll want to [set up API keys](/docs/api/authentication/).

## Create Your First Machine

Create a new microVM using the REST API:

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-first-vm",
    "vcpu_count": 1,
    "mem_size_mib": 128
  }'
```

The kernel and rootfs paths are configured via [environment variables](/docs/configuration/environment-variables/). By default, Hyperfleet uses `.hyperfleet/vmlinux` and `.hyperfleet/alpine-rootfs.ext4`.

Response:

```json
{
  "id": "abc123",
  "name": "my-first-vm",
  "status": "pending",
  "vcpu_count": 1,
  "mem_size_mib": 128,
  "created_at": "2024-01-15T10:30:00Z"
}
```

## Start the Machine

Start the newly created machine:

```bash
curl -X POST http://localhost:3000/machines/abc123/start
```

Response:

```json
{
  "id": "abc123",
  "name": "my-first-vm",
  "status": "running",
  "vcpu_count": 1,
  "mem_size_mib": 128,
  "created_at": "2024-01-15T10:30:00Z",
  "started_at": "2024-01-15T10:30:05Z"
}
```

## Execute Commands

Run commands inside the running VM:

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -d '{
    "command": ["uname", "-a"],
    "timeout": 30
  }'
```

Response:

```json
{
  "exit_code": 0,
  "stdout": "Linux localhost 5.10.0 #1 SMP x86_64 Linux\n",
  "stderr": ""
}
```

## List All Machines

View all your machines:

```bash
curl http://localhost:3000/machines
```

Filter by status:

```bash
curl "http://localhost:3000/machines?status=running"
```

## Stop the Machine

Gracefully stop the machine:

```bash
curl -X POST http://localhost:3000/machines/abc123/stop
```

## Delete the Machine

Remove the machine when done:

```bash
curl -X DELETE http://localhost:3000/machines/abc123
```

## Using the TypeScript SDK

For programmatic access, use the TypeScript SDK:

```typescript
import { Machine, DrivesBuilder } from "@hyperfleet/firecracker";

async function main() {
  const machine = new Machine({
    socketPath: "/tmp/firecracker.sock",
    kernelImagePath: ".hyperfleet/vmlinux",
    kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    vcpuCount: 1,
    memSizeMib: 128,
    drives: new DrivesBuilder(".hyperfleet/alpine-rootfs.ext4").build(),
  });

  // Start the machine
  await machine.start();
  console.log("Machine started!");

  // Run a command
  const result = await machine.exec(["echo", "Hello from the VM!"]);
  console.log("Output:", result.stdout);

  // Shutdown
  await machine.shutdown();
  console.log("Machine stopped.");
}

main();
```

## Next Steps

- [API Authentication](/docs/api/authentication/) - Secure your API with API keys
- [Machine Lifecycle](/docs/guides/machine-lifecycle/) - Understanding machine states
- [Networking](/docs/guides/networking/) - Configure VM networking
- [Environment Variables](/docs/configuration/environment-variables/) - Configure Hyperfleet
