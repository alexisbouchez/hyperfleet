---
title: Networking
description: Configure networking for Firecracker microVMs in Hyperfleet.
icon: wifi
---

Hyperfleet automatically handles network configuration for your microVMs, including TAP device creation, IP address allocation, and NAT for internet access.

## Network Architecture

Each microVM gets:

- A dedicated **TAP device** on the host
- A unique **IP address** within a private subnet
- **NAT configuration** for internet access
- Optional **port exposure** via reverse proxy

```
┌─────────────────────────────────────────────────────┐
│                      Host                           │
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐     │
│  │   VM 1   │    │   VM 2   │    │   VM 3   │     │
│  │172.16.0.2│    │172.16.0.4│    │172.16.0.6│     │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘     │
│       │               │               │            │
│  ┌────┴─────┐    ┌────┴─────┐    ┌────┴─────┐     │
│  │   tap0   │    │   tap1   │    │   tap2   │     │
│  │172.16.0.1│    │172.16.0.3│    │172.16.0.5│     │
│  └────┬─────┘    └────┴─────┘    └────┴─────┘     │
│       │               │               │            │
│       └───────────────┼───────────────┘            │
│                       │                            │
│                  ┌────┴─────┐                      │
│                  │   NAT    │                      │
│                  └────┬─────┘                      │
│                       │                            │
└───────────────────────┼────────────────────────────┘
                        │
                   ┌────┴─────┐
                   │ Internet │
                   └──────────┘
```

## Automatic Network Configuration

When you create a machine, Hyperfleet automatically:

1. **Allocates IP addresses** from the configured subnet
2. **Creates a TAP device** with a unique name
3. **Configures the guest network** interface
4. **Sets up NAT rules** for outbound traffic

### Example Machine with Networking

```bash
curl -X POST http://localhost:3000/machines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "name": "web-server",
    "vcpu_count": 2,
    "mem_size_mib": 512,
    "kernel_image_path": ".hyperfleet/vmlinux",
    "rootfs_path": ".hyperfleet/alpine-rootfs.ext4"
  }'
```

Response includes network information:

```json
{
  "id": "abc123",
  "name": "web-server",
  "status": "pending",
  "tap_device": "tap0",
  "tap_ip": "172.16.0.1",
  "guest_ip": "172.16.0.2",
  "guest_mac": "AA:FC:00:00:00:01"
}
```

## IP Address Management (IPAM)

Hyperfleet includes a built-in IPAM system that:

- Tracks allocated IP addresses in the database
- Assigns /30 subnets per VM (host and guest)
- Prevents IP conflicts between machines
- Releases addresses when machines are deleted

### Default Subnet

The default subnet is `172.16.0.0/16`, providing:

- ~16,000 possible microVMs
- Automatic allocation and release
- No manual IP configuration needed

## TAP Device Configuration

TAP devices provide Layer 2 connectivity between the host and guest.

### TAP Device Naming

TAP devices are named sequentially: `tap0`, `tap1`, `tap2`, etc.

### TAP Device Lifecycle

1. **Created** when machine is started
2. **Configured** with host-side IP address
3. **Attached** to the Firecracker VM
4. **Deleted** when machine is stopped/deleted

## Guest Network Configuration

Inside the VM, the network is configured automatically with:

- **eth0**: Primary network interface
- **IP address**: Assigned by IPAM
- **Gateway**: TAP device IP on host
- **DNS**: Configurable (defaults to host resolver)

### Verify Network Inside VM

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["ip", "addr", "show", "eth0"]
  }'
```

### Test Internet Connectivity

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hf_your_api_key" \
  -d '{
    "cmd": ["ping", "-c", "3", "8.8.8.8"]
  }'
```

## NAT Configuration

Hyperfleet configures NAT (Network Address Translation) to allow VMs to access the internet.

### How NAT Works

1. VM sends packet to external IP
2. Host receives packet on TAP device
3. Host translates source IP to host's external IP
4. Response is translated back and forwarded to VM

### NAT Requirements

NAT requires:

- IP forwarding enabled on host
- iptables/nftables rules configured
- Host has external network access

The setup script configures these automatically.

## Exposing Services

To expose services running inside VMs, use the [reverse proxy](/docs/guides/reverse-proxy/) feature.

### Configure Exposed Ports

When creating a machine, specify ports to expose:

```json
{
  "name": "web-server",
  "vcpu_count": 2,
  "mem_size_mib": 512,
  "kernel_image_path": ".hyperfleet/vmlinux",
  "rootfs_path": ".hyperfleet/alpine-rootfs.ext4",
  "exposed_ports": [80, 443, 8080]
}
```

## Network Troubleshooting

### VM Can't Reach Internet

1. **Check IP forwarding**:
   ```bash
   cat /proc/sys/net/ipv4/ip_forward
   # Should be 1
   ```

2. **Check NAT rules**:
   ```bash
   iptables -t nat -L POSTROUTING -v -n
   ```

3. **Verify TAP device is up**:
   ```bash
   ip link show tap0
   ```

### VM Can't Resolve DNS

Configure DNS inside the VM:

```bash
curl -X POST http://localhost:3000/machines/abc123/exec \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": ["sh", "-c", "echo nameserver 8.8.8.8 > /etc/resolv.conf"]
  }'
```

### Host Can't Reach VM

1. **Check TAP device has IP**:
   ```bash
   ip addr show tap0
   ```

2. **Ping the guest IP from host**:
   ```bash
   ping 172.16.0.2
   ```

3. **Check VM is running**:
   ```bash
   curl http://localhost:3000/machines/abc123
   ```

## Network Security

### Isolation

Each VM is isolated in its own network namespace:

- VMs cannot see each other's traffic
- VMs cannot access the host's other network interfaces
- Only explicitly exposed ports are accessible

### Firewall Recommendations

For production deployments:

1. **Restrict outbound traffic** if VMs don't need internet
2. **Limit exposed ports** to only what's necessary
3. **Use network policies** at the infrastructure level

## Next Steps

- [Reverse Proxy](/docs/guides/reverse-proxy/) - Expose VM services
- [Machine Options](/docs/configuration/machine-options/) - Network configuration options
- [SDK Usage](/docs/guides/sdk-usage/) - Programmatic network configuration
