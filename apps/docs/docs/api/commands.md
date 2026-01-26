---
title: Commands API
description: Execute commands inside running Firecracker microVMs.
icon: terminal
---

The Commands API allows you to execute shell commands inside running microVMs using vsock communication.

## Execute Command

Run a command inside a running machine.

```http
POST /machines/{id}/exec
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Machine ID |

### Request Body

```json
{
  "cmd": ["ls", "-la", "/"],
  "timeout": 30
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | string[] | Yes | Command and arguments as array |
| `timeout` | integer | No | Timeout in seconds (default: 30) |

### Response

**Status**: `200 OK`

```json
{
  "exit_code": 0,
  "stdout": "total 64\ndrwxr-xr-x  19 root root  4096 Jan 15 10:30 .\ndrwxr-xr-x  19 root root  4096 Jan 15 10:30 ..\ndrwxr-xr-x   2 root root  4096 Jan 15 10:30 bin\n...",
  "stderr": ""
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `exit_code` | integer | Command exit code (0 = success) |
| `stdout` | string | Standard output from the command |
| `stderr` | string | Standard error from the command |

## Examples

### Basic Command

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["uname", "-a"]
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

### Command with Arguments

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["cat", "/etc/os-release"]
  }'
```

### Long-Running Command with Timeout

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["sleep", "5"],
    "timeout": 10
  }'
```

### Shell Commands

For shell features like pipes, redirects, or environment variables, use `sh -c`:

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["sh", "-c", "echo $HOME && ls -la | head -5"]
  }'
```

### Check Service Status

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["rc-service", "nginx", "status"]
  }'
```

### Install Packages

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["apk", "add", "--no-cache", "nginx"],
    "timeout": 120
  }'
```

## Error Responses

### Machine Not Running

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Machine must be running to execute commands"
  }
}
```

**Status**: `400 Bad Request`

### Command Timeout

```json
{
  "error": {
    "code": "TIMEOUT",
    "message": "Command execution timed out after 30 seconds"
  }
}
```

**Status**: `504 Gateway Timeout`

### Vsock Communication Error

```json
{
  "error": {
    "code": "VSOCK_ERROR",
    "message": "Failed to communicate with VM"
  }
}
```

**Status**: `502 Bad Gateway`

### Command Failed

When a command runs but returns a non-zero exit code, the API still returns `200 OK` with the exit code and stderr:

```json
{
  "exit_code": 127,
  "stdout": "",
  "stderr": "sh: invalid-command: not found\n"
}
```

## Best Practices

### Use Arrays for Commands

Always pass commands as arrays, not strings:

```json
// Correct
{"cmd": ["ls", "-la", "/home"]}

// Incorrect - won't work
{"cmd": "ls -la /home"}
```

### Handle Timeouts

Set appropriate timeouts for your commands:

- Quick commands (ls, cat, echo): 5-10 seconds
- Package installation: 60-120 seconds
- Build processes: 300+ seconds

### Check Exit Codes

Always check the `exit_code` in responses:

```javascript
const response = await fetch("/machines/abc123/exec", {
  method: "POST",
  body: JSON.stringify({ cmd: ["some-command"] }),
});

const result = await response.json();

if (result.exit_code !== 0) {
  console.error("Command failed:", result.stderr);
}
```

### Escape Special Characters

When using `sh -c`, be careful with special characters:

```json
{
  "cmd": ["sh", "-c", "echo 'Hello, World!'"]
}
```

## Next Steps

- [Machines API](/docs/api/machines/) - Machine management endpoints
- [Machine Lifecycle](/docs/guides/machine-lifecycle/) - Understanding machine states
- [SDK Usage](/docs/guides/sdk-usage/) - Programmatic command execution
