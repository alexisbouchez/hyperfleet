---
title: Reverse Proxy
description: Expose services running inside microVMs using Hyperfleet's built-in reverse proxy.
icon: arrow-right-left
---

Hyperfleet includes a built-in reverse proxy that allows you to expose services running inside your microVMs to the outside world.

## Overview

The reverse proxy:

- Routes external traffic to services inside VMs
- Supports both path-based and host-based routing
- Automatically discovers exposed ports
- Runs on a separate port from the API

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `4000` | Port for the reverse proxy |
| `PROXY_PREFIX` | `/proxy` | URL prefix for path-based routing |
| `PROXY_HOST_SUFFIX` | - | Host suffix for host-based routing |
| `PROXY_EXPOSED_PORT_POLL_INTERVAL_MS` | `10000` | Port discovery polling interval |

### Start the Proxy

The proxy starts automatically with the API server:

```bash
cd apps/api
bun run dev
```

The proxy is available at `http://localhost:4000`.

## Exposing Ports

### When Creating a Machine

Specify ports to expose when creating a machine:

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "name": "web-server",
    "vcpu_count": 2,
    "mem_size_mib": 512,
    "kernel_image_path": ".hyperfleet/vmlinux",
    "rootfs_path": ".hyperfleet/alpine-rootfs.ext4",
    "exposed_ports": [80, 8080]
  }'
```

## Routing Methods

### Path-Based Routing

Access services using the URL path:

```
http://localhost:4000/proxy/{machine-id}/{port}/
```

Example:

```bash
# Access port 80 on machine abc123
curl http://localhost:4000/proxy/abc123/80/

# Access port 8080 on machine abc123
curl http://localhost:4000/proxy/abc123/8080/api/health
```

### Host-Based Routing

With `PROXY_HOST_SUFFIX` configured, access services via subdomain:

```bash
# Set the host suffix
export PROXY_HOST_SUFFIX=".local.dev"

# Access via subdomain
curl http://abc123-80.local.dev:4000/
```

Format: `{machine-id}-{port}.{PROXY_HOST_SUFFIX}:{PROXY_PORT}`

## Example: Running a Web Server

### 1. Create a Machine with Exposed Port

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "name": "nginx-server",
    "vcpu_count": 1,
    "mem_size_mib": 256,
    "kernel_image_path": ".hyperfleet/vmlinux",
    "rootfs_path": ".hyperfleet/alpine-rootfs.ext4",
    "exposed_ports": [80]
  }'
```

### 2. Start the Machine

```bash
curl -X POST http://localhost:3000/machines/abc123/start \
  -H "Authorization: Bearer hf_your_api_key"
```

### 3. Install and Start nginx

```bash
# Install nginx
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["apk", "add", "--no-cache", "nginx"],
    "timeout": 60
  }'

# Create a simple index page
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["sh", "-c", "echo \"<h1>Hello from Hyperfleet!</h1>\" > /var/www/localhost/htdocs/index.html"]
  }'

# Start nginx
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["nginx"]
  }'
```

### 4. Access via Proxy

```bash
curl http://localhost:4000/proxy/abc123/80/
# Output: <h1>Hello from Hyperfleet!</h1>
```

## Port Discovery

The proxy automatically discovers which ports are exposed and listening:

1. Polls machines at configured interval
2. Checks which configured ports have listeners
3. Updates routing table dynamically

Configure the polling interval:

```bash
PROXY_EXPOSED_PORT_POLL_INTERVAL_MS=5000 bun run dev
```

## Request Headers

The proxy adds headers to forwarded requests:

| Header | Description |
|--------|-------------|
| `X-Forwarded-For` | Original client IP |
| `X-Forwarded-Host` | Original host header |
| `X-Forwarded-Proto` | Original protocol (http/https) |
| `X-Machine-ID` | Target machine ID |

## WebSocket Support

The proxy supports WebSocket connections:

```javascript
const ws = new WebSocket("ws://localhost:4000/proxy/abc123/8080/ws");

ws.onmessage = (event) => {
  console.log("Received:", event.data);
};
```

## Error Handling

### Machine Not Found

```json
{
  "error": "Machine not found"
}
```

**Status**: `404 Not Found`

### Machine Not Running

```json
{
  "error": "Machine is not running"
}
```

**Status**: `503 Service Unavailable`

### Port Not Exposed

```json
{
  "error": "Port 3000 is not exposed on this machine"
}
```

**Status**: `403 Forbidden`

### Connection Failed

```json
{
  "error": "Failed to connect to upstream"
}
```

**Status**: `502 Bad Gateway`

## Production Considerations

### HTTPS Termination

The proxy handles HTTP only. For HTTPS, place it behind a reverse proxy like nginx or Cloudflare:

```nginx
server {
    listen 443 ssl;
    server_name *.hyperfleet.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Rate Limiting

Implement rate limiting at your edge proxy or CDN to protect your VMs.

### Access Control

The proxy doesn't perform authentication. Implement access control at:

- Your edge proxy (nginx, Cloudflare)
- Inside the VM application
- Using network policies

## Next Steps

- [Networking](/docs/guides/networking/) - Network configuration details
- [Environment Variables](/docs/configuration/environment-variables/) - All configuration options
- [Machine Options](/docs/configuration/machine-options/) - Exposed ports configuration
