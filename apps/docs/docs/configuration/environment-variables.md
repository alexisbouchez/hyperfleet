---
title: Environment Variables
description: Configure Hyperfleet using environment variables.
icon: settings
---

Hyperfleet is configured using environment variables. This page documents all available configuration options.

## Quick Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server port |
| `DATABASE_PATH` | `./hyperfleet.db` | SQLite database location |
| `DISABLE_AUTH` | `false` | Disable API key authentication |
| `PROXY_PORT` | `4000` | Reverse proxy port |
| `PROXY_PREFIX` | `/proxy` | Path prefix for proxy routing |
| `PROXY_HOST_SUFFIX` | - | Host suffix for subdomain routing |
| `PROXY_EXPOSED_PORT_POLL_INTERVAL_MS` | `10000` | Port discovery interval |
| `HYPERFLEET_SOCKET_DIR` | `/tmp` | Directory for Firecracker sockets |
| `HYPERFLEET_KERNEL_IMAGE_PATH` | `.hyperfleet/vmlinux` | Default kernel image path |
| `HYPERFLEET_KERNEL_ARGS` | `console=ttyS0 reboot=k panic=1 pci=off` | Default kernel boot arguments |
| `HYPERFLEET_ROOTFS_PATH` | `.hyperfleet/alpine-rootfs.ext4` | Default rootfs image path |

## API Server

### PORT

The port the API server listens on.

```bash
PORT=8080 bun run dev
```

**Default**: `3000`

### DATABASE_PATH

Path to the SQLite database file. The file is created if it doesn't exist.

```bash
DATABASE_PATH=/var/lib/hyperfleet/data.db bun run dev
```

**Default**: `./hyperfleet.db`

## Authentication

### DISABLE_AUTH

Disable API key authentication. **Use only for development.**

```bash
DISABLE_AUTH=true bun run dev
```

**Default**: `false`

**Warning**: Never disable authentication in production environments. All endpoints except `/health` will be publicly accessible.

## Reverse Proxy

### PROXY_PORT

The port the reverse proxy listens on.

```bash
PROXY_PORT=8000 bun run dev
```

**Default**: `4000`

### PROXY_PREFIX

URL prefix for path-based proxy routing.

```bash
PROXY_PREFIX=/vm bun run dev
```

With this setting, proxy URLs become:
```
http://localhost:4000/vm/{machine-id}/{port}/
```

**Default**: `/proxy`

### PROXY_HOST_SUFFIX

Enable host-based routing with a domain suffix.

```bash
PROXY_HOST_SUFFIX=.vms.example.com bun run dev
```

With this setting, you can access VMs via subdomain:
```
http://abc123-80.vms.example.com:4000/
```

**Default**: Not set (host-based routing disabled)

### PROXY_EXPOSED_PORT_POLL_INTERVAL_MS

How often (in milliseconds) to poll machines for newly exposed ports.

```bash
PROXY_EXPOSED_PORT_POLL_INTERVAL_MS=5000 bun run dev
```

Lower values provide faster port discovery but increase CPU usage.

**Default**: `10000` (10 seconds)

## Machine Defaults

### HYPERFLEET_SOCKET_DIR

Directory where Firecracker socket files are created.

```bash
HYPERFLEET_SOCKET_DIR=/var/run/firecracker bun run dev
```

**Default**: `/tmp`

### HYPERFLEET_KERNEL_IMAGE_PATH

Default kernel image path used when creating machines without specifying `kernel_image_path`. Can be relative (resolved from current working directory) or absolute.

```bash
HYPERFLEET_KERNEL_IMAGE_PATH=/opt/hyperfleet/vmlinux bun run dev
```

**Default**: `.hyperfleet/vmlinux`

### HYPERFLEET_KERNEL_ARGS

Default kernel boot arguments used when creating machines without specifying `kernel_args`.

```bash
HYPERFLEET_KERNEL_ARGS="console=ttyS0 reboot=k panic=1 pci=off quiet" bun run dev
```

**Default**: `console=ttyS0 reboot=k panic=1 pci=off`

### HYPERFLEET_ROOTFS_PATH

Default rootfs image path used when creating machines without specifying `rootfs_path`. Can be relative (resolved from current working directory) or absolute.

```bash
HYPERFLEET_ROOTFS_PATH=/opt/hyperfleet/rootfs.ext4 bun run dev
```

**Default**: `.hyperfleet/alpine-rootfs.ext4`

## Example Configurations

### Development

```bash
# .env.development
PORT=3000
DATABASE_PATH=./dev.db
DISABLE_AUTH=true
PROXY_PORT=4000
```

### Production

```bash
# .env.production
PORT=3000
DATABASE_PATH=/var/lib/hyperfleet/hyperfleet.db
DISABLE_AUTH=false
PROXY_PORT=4000
PROXY_HOST_SUFFIX=.vms.mycompany.com
PROXY_EXPOSED_PORT_POLL_INTERVAL_MS=30000
```

### Docker

```dockerfile
# Dockerfile
ENV PORT=3000
ENV DATABASE_PATH=/data/hyperfleet.db
ENV DISABLE_AUTH=false
ENV PROXY_PORT=4000
```

## Using .env Files

Create a `.env` file in the `apps/api` directory:

```bash
# apps/api/.env
PORT=3000
DATABASE_PATH=./hyperfleet.db
DISABLE_AUTH=false
```

Bun automatically loads `.env` files.

### Environment-Specific Files

You can use environment-specific files:

- `.env` - Default for all environments
- `.env.local` - Local overrides (not committed)
- `.env.development` - Development settings
- `.env.production` - Production settings

## Runtime Configuration

Some values can also be configured programmatically when using the SDK:

```typescript
import { createApp } from "./app";

const app = createApp({
  databasePath: process.env.DATABASE_PATH || "./hyperfleet.db",
  disableAuth: process.env.DISABLE_AUTH === "true",
});

app.listen(parseInt(process.env.PORT || "3000"));
```

## Validating Configuration

Hyperfleet validates configuration at startup. Invalid values will cause the server to exit with an error message.

Common validation errors:

```
Error: PORT must be a number between 1 and 65535
Error: DATABASE_PATH directory does not exist
Error: PROXY_EXPOSED_PORT_POLL_INTERVAL_MS must be a positive number
```

## Next Steps

- [Machine Options](/docs/configuration/machine-options/) - Machine configuration
- [Installation](/docs/installation/) - Setup guide
- [API Overview](/docs/api/overview/) - API documentation
