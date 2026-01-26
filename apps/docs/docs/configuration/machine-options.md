---
title: Machine Options
description: Configuration options for Firecracker microVMs.
icon: cpu
---

This page documents all configuration options available when creating a Hyperfleet machine.

## Required Options

These fields must be provided when creating a machine.

### name

A unique identifier for the machine.

```json
{
  "name": "my-web-server"
}
```

- **Type**: `string`
- **Requirements**: Must be unique across all machines
- **Best practice**: Use descriptive, DNS-compatible names

### vcpu_count

Number of virtual CPUs allocated to the machine.

```json
{
  "vcpu_count": 2
}
```

- **Type**: `integer`
- **Minimum**: `1`
- **Maximum**: Limited by host CPU cores
- **Best practice**: Start with 1-2 vCPUs, scale up based on workload

### mem_size_mib

Memory allocated to the machine in MiB (mebibytes).

```json
{
  "mem_size_mib": 512
}
```

- **Type**: `integer`
- **Minimum**: `4`
- **Maximum**: Limited by host memory
- **Best practice**: Alpine Linux runs well with 128-256 MiB for basic workloads

### kernel_image_path

Path to the Linux kernel image.

```json
{
  "kernel_image_path": ".hyperfleet/vmlinux"
}
```

- **Type**: `string`
- **Requirements**: Must be a valid, bootable kernel
- **Format**: Uncompressed ELF binary (`vmlinux`)
- **Note**: The setup script downloads a compatible kernel automatically

## Optional Options

These fields have defaults or are not always required.

### kernel_args

Kernel command-line arguments passed at boot.

```json
{
  "kernel_args": "console=ttyS0 reboot=k panic=1 pci=off"
}
```

- **Type**: `string`
- **Default**: `"console=ttyS0 reboot=k panic=1 pci=off"`

#### Common Kernel Arguments

| Argument | Description |
|----------|-------------|
| `console=ttyS0` | Serial console output |
| `reboot=k` | Use keyboard controller for reboot |
| `panic=1` | Reboot 1 second after kernel panic |
| `pci=off` | Disable PCI (not needed in microVMs) |
| `quiet` | Suppress most kernel messages |
| `init=/sbin/init` | Specify init process path |

### rootfs_path

Path to the root filesystem image.

```json
{
  "rootfs_path": ".hyperfleet/alpine-rootfs.ext4"
}
```

- **Type**: `string`
- **Format**: ext4 filesystem image
- **Note**: If not provided, the machine boots without a root filesystem (useful for custom setups)

### exposed_ports

Ports to expose via the reverse proxy.

```json
{
  "exposed_ports": [80, 443, 8080]
}
```

- **Type**: `integer[]` (array of integers)
- **Default**: `[]` (no ports exposed)
- **Range**: 1-65535

## Complete Example

```json
{
  "name": "production-api",
  "vcpu_count": 4,
  "mem_size_mib": 1024,
  "kernel_image_path": ".hyperfleet/vmlinux",
  "kernel_args": "console=ttyS0 reboot=k panic=1 pci=off quiet",
  "rootfs_path": ".hyperfleet/alpine-rootfs.ext4",
  "exposed_ports": [3000, 8080]
}
```

## Sizing Guidelines

### Development Workloads

```json
{
  "vcpu_count": 1,
  "mem_size_mib": 128
}
```

Suitable for:
- Simple scripts
- Development testing
- Minimal services

### Web Services

```json
{
  "vcpu_count": 2,
  "mem_size_mib": 512
}
```

Suitable for:
- Node.js/Python web apps
- Small databases
- API services

### Compute-Intensive

```json
{
  "vcpu_count": 4,
  "mem_size_mib": 2048
}
```

Suitable for:
- Build processes
- Data processing
- CI/CD runners

### Memory-Intensive

```json
{
  "vcpu_count": 2,
  "mem_size_mib": 4096
}
```

Suitable for:
- In-memory databases
- Caching services
- Large applications

## Resource Limits

### Per-Machine Limits

| Resource | Minimum | Typical Max | Notes |
|----------|---------|-------------|-------|
| vCPUs | 1 | 8 | Limited by host |
| Memory | 4 MiB | 32 GiB | Limited by host |
| Disk | - | Host disk | Depends on rootfs size |

### System-Wide Limits

The total resources used by all machines cannot exceed host resources. Hyperfleet doesn't currently enforce quotas - plan your deployments accordingly.

## Rootfs Considerations

### Image Size

Keep rootfs images small for faster boot times:

- Minimal Alpine: ~50 MB
- Alpine with tools: ~100-200 MB
- Full Linux distribution: 500+ MB

### Read-Only vs Read-Write

By default, the rootfs is read-write. For immutable infrastructure:

1. Create a read-only base image
2. Use overlay filesystems for writable data
3. Or mount separate data drives

### Creating Custom Images

```bash
# Create an empty ext4 image
dd if=/dev/zero of=custom.ext4 bs=1M count=500
mkfs.ext4 custom.ext4

# Mount and customize
sudo mount custom.ext4 /mnt
# Add your files...
sudo umount /mnt
```

## Network Configuration (Internal)

Network settings are managed automatically but stored in the database:

| Field | Description |
|-------|-------------|
| `tap_device` | TAP device name (e.g., `tap0`) |
| `tap_ip` | Host-side IP address |
| `guest_ip` | Guest IP address |
| `guest_mac` | Guest MAC address |

These are populated when the machine starts and cleared when it stops.

## Validation

Hyperfleet validates machine options at creation time:

```json
// Invalid: vcpu_count too low
{
  "vcpu_count": 0,
  "mem_size_mib": 128
}
// Error: "vcpu_count must be at least 1"

// Invalid: missing required field
{
  "vcpu_count": 1
}
// Error: "mem_size_mib is required"

// Invalid: path doesn't exist
{
  "kernel_image_path": "/nonexistent/vmlinux"
}
// Error: "kernel_image_path does not exist"
```

## Next Steps

- [Environment Variables](/docs/configuration/environment-variables/) - Server configuration
- [Machine Lifecycle](/docs/guides/machine-lifecycle/) - Machine states
- [Machines API](/docs/api/machines/) - API reference
