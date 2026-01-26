---
title: Error Codes
description: Reference for Hyperfleet API error codes and their meanings.
icon: alert-triangle
---

This reference documents all error codes returned by the Hyperfleet API.

## Error Response Format

All errors follow this format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

## HTTP Status Codes

| Status | Category | Description |
|--------|----------|-------------|
| 400 | Client Error | Bad request / Validation error |
| 401 | Auth Error | Authentication required or failed |
| 403 | Auth Error | Permission denied |
| 404 | Client Error | Resource not found |
| 500 | Server Error | Internal error |
| 502 | Gateway Error | VM communication failed |
| 503 | Service Error | Service unavailable |
| 504 | Timeout | Operation timed out |

## Error Codes Reference

### Authentication Errors

#### UNAUTHORIZED

**Status:** 401

Authentication is required or the provided credentials are invalid.

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authorization header is required"
  }
}
```

**Causes:**
- Missing `Authorization` header
- Invalid API key format
- API key not found
- API key has been revoked
- API key has expired

**Resolution:**
- Include valid API key: `Authorization: Bearer hf_xxx`
- Check key hasn't expired or been revoked
- Generate a new API key if needed

#### FORBIDDEN

**Status:** 403

The API key is valid but lacks required permissions.

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient permissions for this action"
  }
}
```

**Causes:**
- API key missing required scope
- Attempting restricted operation

**Resolution:**
- Create a new key with required scopes
- Use a key with broader permissions

---

### Client Errors

#### NOT_FOUND

**Status:** 404

The requested resource doesn't exist.

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Machine with id 'abc123' not found"
  }
}
```

**Causes:**
- Invalid machine ID
- Machine was deleted
- Typo in resource path

**Resolution:**
- Verify the resource ID
- List resources to find valid IDs

#### VALIDATION_ERROR

**Status:** 400

The request body failed validation.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "vcpu_count must be at least 1"
  }
}
```

**Common Validation Errors:**

| Field | Error | Requirement |
|-------|-------|-------------|
| `name` | Required | Non-empty string |
| `vcpu_count` | Minimum 1 | Integer >= 1 |
| `mem_size_mib` | Minimum 4 | Integer >= 4 |
| `kernel_image_path` | Must exist | Valid file path |
| `exposed_ports` | Invalid port | Array of integers 1-65535 |

#### BAD_REQUEST

**Status:** 400

The request is malformed or invalid.

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Cannot start machine in 'running' state"
  }
}
```

**Causes:**
- Invalid JSON body
- Operation not allowed in current state
- Invalid parameter values

#### PATH_TRAVERSAL_ERROR

**Status:** 400

An attempt to access files outside allowed directories.

```json
{
  "error": {
    "code": "PATH_TRAVERSAL_ERROR",
    "message": "Path traversal detected in kernel_image_path"
  }
}
```

**Causes:**
- Path contains `..` components
- Symbolic link escape attempt

**Resolution:**
- Use absolute paths
- Avoid relative path components

---

### Server Errors

#### INTERNAL_ERROR

**Status:** 500

An unexpected error occurred on the server.

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

**Causes:**
- Bug in application code
- Database error
- System resource exhaustion

**Resolution:**
- Check server logs for details
- Retry the request
- Report persistent issues

#### RUNTIME_ERROR

**Status:** 500

An error occurred in the VM runtime layer.

```json
{
  "error": {
    "code": "RUNTIME_ERROR",
    "message": "Failed to spawn Firecracker process"
  }
}
```

**Causes:**
- Firecracker binary not found
- KVM not available
- Insufficient permissions

---

### Gateway Errors

#### FIRECRACKER_API_ERROR

**Status:** 400 or 502

Error communicating with the Firecracker API.

```json
{
  "error": {
    "code": "FIRECRACKER_API_ERROR",
    "message": "Firecracker returned error: Invalid kernel path"
  }
}
```

**Causes:**
- Invalid VM configuration
- Firecracker rejected the request
- API socket unavailable

#### VSOCK_ERROR

**Status:** 502

Error communicating with the VM via vsock.

```json
{
  "error": {
    "code": "VSOCK_ERROR",
    "message": "Failed to establish vsock connection"
  }
}
```

**Causes:**
- VM not fully booted
- vsock agent not running in guest
- Connection interrupted

**Resolution:**
- Ensure VM is in `running` state
- Verify guest has vsock agent installed
- Retry the request

---

### Service Errors

#### CIRCUIT_OPEN_ERROR

**Status:** 503

The circuit breaker has opened due to repeated failures.

```json
{
  "error": {
    "code": "CIRCUIT_OPEN_ERROR",
    "message": "Service temporarily unavailable, please retry later"
  }
}
```

**Causes:**
- Multiple recent failures to a resource
- Service protecting against cascade failure

**Resolution:**
- Wait and retry (circuit will close automatically)
- Check underlying service health

---

### Timeout Errors

#### TIMEOUT_ERROR

**Status:** 504

An operation exceeded its time limit.

```json
{
  "error": {
    "code": "TIMEOUT_ERROR",
    "message": "Command execution timed out after 30 seconds"
  }
}
```

**Causes:**
- Long-running command exceeded timeout
- Network latency
- VM unresponsive

**Resolution:**
- Increase timeout value
- Check VM health
- Break long operations into smaller steps

---

## Error Handling Best Practices

### Retry Logic

```typescript
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isRetryable =
        error.code === "TIMEOUT_ERROR" ||
        error.code === "CIRCUIT_OPEN_ERROR" ||
        error.status >= 500;

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      await sleep(1000 * attempt); // Exponential backoff
    }
  }
  throw new Error("Max retries exceeded");
}
```

### Error Type Checking

```typescript
async function handleOperation() {
  try {
    await execCommand(machineId, ["some-command"]);
  } catch (error) {
    switch (error.code) {
      case "NOT_FOUND":
        console.log("Machine doesn't exist");
        break;
      case "TIMEOUT_ERROR":
        console.log("Command took too long");
        break;
      case "VSOCK_ERROR":
        console.log("Couldn't reach VM");
        break;
      default:
        console.log("Unknown error:", error.message);
    }
  }
}
```

### Graceful Degradation

```typescript
async function getMachineStatus(id: string): Promise<string> {
  try {
    const machine = await getMachine(id);
    return machine.status;
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      return "deleted";
    }
    if (error.code === "CIRCUIT_OPEN_ERROR") {
      return "unknown";
    }
    throw error;
  }
}
```

## Next Steps

- [Machine States](/docs/reference/machine-states/) - State reference
- [API Overview](/docs/api/overview/) - API documentation
- [Troubleshooting](/docs/guides/machine-lifecycle/) - Common issues
