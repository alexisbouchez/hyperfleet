---
title: Machines API
description: REST API endpoints for managing Firecracker microVMs.
icon: server
---

The Machines API provides endpoints for creating, managing, and monitoring Firecracker microVMs.

## Create Machine

Create a new microVM.

```http
POST /machines
```

### Request Body

```json
{
  "name": "my-vm",
  "vcpu_count": 2,
  "mem_size_mib": 512,
  "exposed_ports": [8080, 443]
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique name for the machine |
| `vcpu_count` | integer | Yes | Number of vCPUs (minimum: 1) |
| `mem_size_mib` | integer | Yes | Memory in MiB (minimum: 4) |
| `exposed_ports` | integer[] | No | Ports to expose via reverse proxy |

The kernel image, kernel args, and rootfs paths are configured server-wide via [environment variables](/docs/configuration/environment-variables/).

### Response

**Status**: `201 Created`

```json
{
  "id": "abc123xyz",
  "name": "my-vm",
  "status": "pending",
  "vcpu_count": 2,
  "mem_size_mib": 512,
  "kernel_image_path": "/path/to/vmlinux",
  "kernel_args": "console=ttyS0 reboot=k panic=1 pci=off",
  "rootfs_path": "/path/to/rootfs.ext4",
  "exposed_ports": [8080, 443],
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

### Example

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "name": "web-server",
    "vcpu_count": 2,
    "mem_size_mib": 512
  }'
```

---

## List Machines

Retrieve all machines, optionally filtered by status.

```http
GET /machines
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by machine status |
| `limit` | integer | Maximum results (default: 50) |
| `offset` | integer | Skip N results (default: 0) |

### Response

**Status**: `200 OK`

```json
{
  "machines": [
    {
      "id": "abc123xyz",
      "name": "web-server",
      "status": "running",
      "vcpu_count": 2,
      "mem_size_mib": 512,
      "created_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "def456uvw",
      "name": "database",
      "status": "stopped",
      "vcpu_count": 4,
      "mem_size_mib": 2048,
      "created_at": "2024-01-14T08:00:00Z"
    }
  ],
  "total": 2
}
```

### Examples

```bash
# List all machines
curl -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines

# List only running machines
curl -H "Authorization: Bearer hf_your_api_key" \
  "http://localhost:3000/machines?status=running"

# Paginate results
curl -H "Authorization: Bearer hf_your_api_key" \
  "http://localhost:3000/machines?limit=10&offset=20"
```

---

## Get Machine

Retrieve details about a specific machine.

```http
GET /machines/{id}
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Machine ID |

### Response

**Status**: `200 OK`

```json
{
  "id": "abc123xyz",
  "name": "web-server",
  "status": "running",
  "vcpu_count": 2,
  "mem_size_mib": 512,
  "kernel_image_path": ".hyperfleet/vmlinux",
  "kernel_args": "console=ttyS0 reboot=k panic=1 pci=off",
  "rootfs_path": ".hyperfleet/alpine-rootfs.ext4",
  "socket_path": "/tmp/firecracker-abc123xyz.sock",
  "tap_device": "tap0",
  "tap_ip": "172.16.0.1",
  "guest_ip": "172.16.0.2",
  "guest_mac": "AA:FC:00:00:00:01",
  "pid": 12345,
  "exposed_ports": [8080],
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:35:00Z"
}
```

### Example

```bash
curl -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines/abc123xyz
```

---

## Delete Machine

Delete a machine. The machine must be stopped first.

```http
DELETE /machines/{id}
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Machine ID |

### Response

**Status**: `204 No Content`

### Example

```bash
curl -X DELETE \
  -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines/abc123xyz
```

---

## Start Machine

Start a stopped or pending machine.

```http
POST /machines/{id}/start
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Machine ID |

### Response

**Status**: `200 OK`

Returns the updated machine object with `status: "running"`.

### Example

```bash
curl -X POST \
  -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines/abc123xyz/start
```

---

## Wait for Status

Wait for a machine to reach a specific status.

```http
GET /machines/{id}/wait
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Machine ID |

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Target status (e.g., `running`, `stopped`) |
| `timeout` | integer | Timeout in seconds (default: 30, max: 30) |

### Response

**Status**: `200 OK`

Returns the machine object once it reaches the target status.

### Example

```bash
curl -H "Authorization: Bearer hf_your_api_key" \
  "http://localhost:3000/machines/abc123xyz/wait?status=running&timeout=30"
```

---

## Stop Machine

Gracefully stop a running machine.

```http
POST /machines/{id}/stop
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Machine ID |

### Response

**Status**: `200 OK`

Returns the updated machine object with `status: "stopped"`.

### Example

```bash
curl -X POST \
  -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines/abc123xyz/stop
```

---

## Restart Machine

Restart a running machine.

```http
POST /machines/{id}/restart
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Machine ID |

### Response

**Status**: `200 OK`

Returns the updated machine object with `status: "running"`.

### Example

```bash
curl -X POST \
  -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines/abc123xyz/restart
```

---

## Error Responses

### Machine Not Found

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Machine with id 'abc123xyz' not found"
  }
}
```

**Status**: `404 Not Found`

### Wait Timeout

```json
{
  "error": {
    "code": "TIMEOUT",
    "message": "Timed out waiting for machine abc123xyz to reach status running"
  }
}
```

**Status**: `504 Gateway Timeout`

### Invalid Machine State

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Cannot start machine in 'running' state"
  }
}
```

**Status**: `400 Bad Request`

### Validation Error

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "vcpu_count must be at least 1"
  }
}
```

**Status**: `400 Bad Request`

## Next Steps

- [Commands API](/docs/api/commands/) - Execute commands on machines
- [Machine Lifecycle](/docs/guides/machine-lifecycle/) - Understanding machine states
- [Machine Options](/docs/configuration/machine-options/) - Configuration reference
