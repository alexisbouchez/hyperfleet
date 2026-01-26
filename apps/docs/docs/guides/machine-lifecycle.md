---
title: Machine Lifecycle
description: Understanding Firecracker microVM states and transitions in Hyperfleet.
icon: refresh-cw
---

This guide explains the lifecycle of a Hyperfleet machine, including all possible states and the transitions between them.

## Machine States

A machine can be in one of the following states:

| State | Description |
|-------|-------------|
| `pending` | Machine is created but not yet started |
| `starting` | Machine is in the process of booting |
| `running` | Machine is running and accepting commands |
| `paused` | Machine is paused (execution suspended) |
| `stopping` | Machine is shutting down |
| `stopped` | Machine is stopped (can be restarted) |
| `failed` | Machine encountered an error |

## State Diagram

```
                    ┌──────────┐
                    │  Create  │
                    └────┬─────┘
                         │
                         ▼
                    ┌──────────┐
        ┌──────────│ pending  │──────────┐
        │          └────┬─────┘          │
        │               │                │
        │          Start│                │Delete
        │               ▼                │
        │          ┌──────────┐          │
        │          │ starting │          │
        │          └────┬─────┘          │
        │               │                │
        │          Success               │
        │               │   Failure      │
        │               ▼       │        │
        │          ┌──────────┐ │        │
        │    ┌─────│ running  │─┼────────┤
        │    │     └────┬─────┘ │        │
        │    │          │       │        │
        │ Restart    Stop│      │        │
        │    │          │       │        │
        │    │          ▼       ▼        │
        │    │     ┌──────────┐          │
        │    │     │ stopping │──────────┤
        │    │     └────┬─────┘          │
        │    │          │                │
        │    │          ▼                │
        │    │     ┌──────────┐          │
        │    └─────│ stopped  │──────────┤
        │          └──────────┘          │
        │                                │
        │          ┌──────────┐          │
        └──────────│  failed  │──────────┘
                   └──────────┘
```

## State Transitions

### pending → starting

Triggered by: `POST /machines/{id}/start`

The machine begins the boot process. Hyperfleet:

1. Creates the Firecracker socket
2. Spawns the Firecracker process
3. Configures the microVM (CPU, memory, drives)
4. Starts the guest kernel

### starting → running

Automatic transition after successful boot.

The VM is now fully operational and can:
- Accept command execution requests
- Serve network traffic (if networking configured)
- Be accessed via the reverse proxy

### starting → failed

Automatic transition if boot fails.

Common causes:
- Invalid kernel image
- Missing or corrupt rootfs
- Insufficient resources
- KVM not available

### running → stopping

Triggered by: `POST /machines/{id}/stop`

Hyperfleet initiates a graceful shutdown:

1. Sends shutdown signal to the guest
2. Waits for guest to halt
3. Terminates the Firecracker process
4. Cleans up resources

### stopping → stopped

Automatic transition after successful shutdown.

The machine can be restarted or deleted.

### stopped → starting

Triggered by: `POST /machines/{id}/start`

A stopped machine can be started again with the same configuration.

### running → running (restart)

Triggered by: `POST /machines/{id}/restart`

Equivalent to stop followed by start:

1. Graceful shutdown
2. Clean up resources
3. Boot with same configuration

### any → deleted

Triggered by: `DELETE /machines/{id}`

Machine must be stopped first. This removes:
- Machine record from database
- Associated socket file
- Network configuration (TAP device, IP allocation)

## Handling the Failed State

When a machine enters the `failed` state, check the error message:

```bash
curl -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines/abc123
```

Response includes `error_message`:

```json
{
  "id": "abc123",
  "status": "failed",
  "error_message": "Failed to start Firecracker: kernel image not found"
}
```

### Recovery Options

1. **Fix the issue and recreate**: Delete the failed machine and create a new one with corrected configuration.

2. **Check logs**: Review Hyperfleet logs for detailed error information.

3. **Verify resources**: Ensure kernel, rootfs, and other resources exist and are accessible.

## Best Practices

### Check State Before Operations

Always verify machine state before performing operations:

```javascript
const machine = await getMachine(id);

if (machine.status !== "running") {
  console.log("Machine not running, cannot execute commands");
  return;
}

await execCommand(id, ["ls", "-la"]);
```

### Handle Transient States

The `starting` and `stopping` states are transient. Don't assume immediate transitions:

```javascript
// Wait for machine to be running
async function waitForRunning(id, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const machine = await getMachine(id);

    if (machine.status === "running") {
      return machine;
    }

    if (machine.status === "failed") {
      throw new Error(`Machine failed: ${machine.error_message}`);
    }

    await sleep(1000); // Wait 1 second
  }

  throw new Error("Timeout waiting for machine to start");
}
```

### Graceful Shutdown

Always stop machines gracefully before deletion:

```javascript
// Correct
await stopMachine(id);
await deleteMachine(id);

// Incorrect - may fail or leave resources
await deleteMachine(id); // Machine still running!
```

### Clean Up Failed Machines

Failed machines still consume database records. Clean them up:

```javascript
const machines = await listMachines({ status: "failed" });

for (const machine of machines) {
  console.log(`Cleaning up failed machine: ${machine.name}`);
  await deleteMachine(machine.id);
}
```

## Next Steps

- [Machine States Reference](/docs/reference/machine-states/) - Detailed state reference
- [Error Codes](/docs/reference/error-codes/) - Understanding error responses
- [SDK Usage](/docs/guides/sdk-usage/) - Programmatic lifecycle management
