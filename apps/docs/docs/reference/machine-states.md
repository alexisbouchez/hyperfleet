---
title: Machine States
description: Reference for all Hyperfleet machine states and their meanings.
icon: activity
---

This reference documents all possible machine states in Hyperfleet.

## States Overview

| State | Description | Can Execute Commands | Can Delete |
|-------|-------------|---------------------|------------|
| `pending` | Created, not started | No | Yes |
| `starting` | Boot in progress | No | No |
| `running` | Fully operational | Yes | No |
| `paused` | Execution suspended | No | No |
| `stopping` | Shutdown in progress | No | No |
| `stopped` | Halted, can restart | No | Yes |
| `failed` | Error occurred | No | Yes |

## Detailed State Reference

### pending

The machine has been created but hasn't been started yet.

**Characteristics:**
- Database record exists
- No Firecracker process running
- No resources allocated (socket, TAP device)

**Transitions from:** Initial state after creation

**Transitions to:**
- `starting` - When start is called
- Deleted - When delete is called

**API Operations:**
- `GET /machines/{id}` - View details
- `POST /machines/{id}/start` - Start the machine
- `DELETE /machines/{id}` - Delete the machine

---

### starting

The machine is in the process of booting.

**Characteristics:**
- Firecracker process spawning
- VM configuration being applied
- Kernel loading

**Transitions from:** `pending`, `stopped`

**Transitions to:**
- `running` - When boot completes successfully
- `failed` - When boot fails

**API Operations:**
- `GET /machines/{id}` - View details (status will update)

**Notes:**
- This is a transient state
- Typically lasts less than a second for microVMs
- Operations should poll until state changes

---

### running

The machine is fully operational and accepting commands.

**Characteristics:**
- Firecracker process running
- Guest kernel booted
- Network configured (if applicable)
- Command execution available via vsock

**Transitions from:** `starting`

**Transitions to:**
- `stopping` - When stop is called
- `starting` - When restart is called (via stop then start)
- `paused` - When pause is called
- `failed` - On critical error

**API Operations:**
- `GET /machines/{id}` - View details
- `POST /machines/{id}/stop` - Stop the machine
- `POST /machines/{id}/restart` - Restart the machine
- `POST /machines/{id}/exec` - Execute commands

---

### paused

The machine's execution is suspended.

**Characteristics:**
- Firecracker process exists
- vCPUs halted
- Memory preserved
- No command execution

**Transitions from:** `running`

**Transitions to:**
- `running` - When resume is called
- `stopping` - When stop is called

**API Operations:**
- `GET /machines/{id}` - View details
- `POST /machines/{id}/resume` - Resume execution
- `POST /machines/{id}/stop` - Stop the machine

**Use Cases:**
- Temporarily suspending workloads
- Debugging
- Resource management

---

### stopping

The machine is in the process of shutting down.

**Characteristics:**
- Shutdown signal sent to guest
- Waiting for graceful termination
- Resources being cleaned up

**Transitions from:** `running`, `paused`

**Transitions to:**
- `stopped` - When shutdown completes
- `failed` - If shutdown fails

**API Operations:**
- `GET /machines/{id}` - View details (status will update)

**Notes:**
- Transient state
- Typically completes within seconds
- Force stop may be needed if guest doesn't respond

---

### stopped

The machine has been stopped and can be restarted.

**Characteristics:**
- No Firecracker process
- Configuration preserved
- Resources deallocated
- Can be started again

**Transitions from:** `stopping`

**Transitions to:**
- `starting` - When start is called
- Deleted - When delete is called

**API Operations:**
- `GET /machines/{id}` - View details
- `POST /machines/{id}/start` - Start the machine
- `DELETE /machines/{id}` - Delete the machine

---

### failed

The machine encountered an error and cannot continue.

**Characteristics:**
- Error message recorded
- May or may not have running process
- Requires investigation

**Transitions from:** `starting`, `running`, `stopping`

**Transitions to:**
- Deleted - When delete is called

**API Operations:**
- `GET /machines/{id}` - View details and error message
- `DELETE /machines/{id}` - Delete the machine

**Common Causes:**
- Kernel not found or invalid
- Rootfs corruption
- KVM unavailable
- Resource exhaustion
- Network configuration failure

**Error Information:**

The `error_message` field contains details:

```json
{
  "id": "abc123",
  "status": "failed",
  "error_message": "Failed to open kernel image: No such file or directory"
}
```

## State Transition Matrix

| From \ To | pending | starting | running | paused | stopping | stopped | failed |
|-----------|:-------:|:--------:|:-------:|:------:|:--------:|:-------:|:------:|
| pending   | - | start | - | - | - | - | - |
| starting  | - | - | auto | - | - | - | error |
| running   | - | restart | - | pause | stop | - | error |
| paused    | - | - | resume | - | stop | - | error |
| stopping  | - | - | - | - | - | auto | error |
| stopped   | - | start | - | - | - | - | - |
| failed    | - | - | - | - | - | - | - |

Legend:
- `start/stop/etc.` - Triggered by API call
- `auto` - Automatic transition
- `error` - On failure
- `-` - Not possible

## Checking Machine State

### Via API

```bash
curl -H "Authorization: Bearer hf_xxx" \
  http://localhost:3000/machines/abc123
```

### Via SDK

```typescript
const machine = await getMachine(id);
console.log("Status:", machine.status);

if (machine.status === "failed") {
  console.log("Error:", machine.error_message);
}
```

## Waiting for State Changes

```typescript
async function waitForState(
  machineId: string,
  targetState: string,
  timeoutMs: number = 30000
): Promise<Machine> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const machine = await getMachine(machineId);

    if (machine.status === targetState) {
      return machine;
    }

    if (machine.status === "failed") {
      throw new Error(`Machine failed: ${machine.error_message}`);
    }

    await sleep(500);
  }

  throw new Error(`Timeout waiting for state: ${targetState}`);
}

// Usage
const machine = await waitForState("abc123", "running");
```

## Next Steps

- [Machine Lifecycle](/docs/guides/machine-lifecycle/) - State transitions guide
- [Error Codes](/docs/reference/error-codes/) - Error reference
- [Machines API](/docs/api/machines/) - API reference
