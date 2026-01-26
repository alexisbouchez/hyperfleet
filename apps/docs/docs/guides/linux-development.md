---
title: Linux Development & Deployment
description: How to develop and deploy Hyperfleet on native Linux environments.
icon: terminal
---

This guide covers setting up Hyperfleet for development on Linux and deploying to production Linux servers. Since Linux natively supports KVM, you can run Firecracker directly without virtualization layers like Lima.

## Prerequisites

### System Requirements

- **Linux kernel 4.14+** with KVM support
- **Bun v1.0+** - TypeScript runtime ([install Bun](https://bun.sh/))
- **Root access** or appropriate permissions for KVM and networking

### Verify KVM Support

Check that KVM is available on your system:

```bash
# Check if KVM modules are loaded
lsmod | grep kvm

# You should see kvm_intel (Intel) or kvm_amd (AMD)
# If not loaded, load them:
sudo modprobe kvm
sudo modprobe kvm_intel  # or kvm_amd for AMD CPUs

# Verify /dev/kvm exists and is accessible
ls -la /dev/kvm
```

### Configure KVM Permissions

Add your user to the `kvm` group:

```bash
sudo usermod -aG kvm $USER

# Log out and back in, or run:
newgrp kvm

# Verify access
[ -w /dev/kvm ] && echo "KVM access OK" || echo "KVM access DENIED"
```

## Development Setup

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/alexisbouchez/hyperfleet.git
cd hyperfleet
bun install
```

### 2. Install Firecracker

Download and install Firecracker directly on your Linux system:

```bash
# Set version
FIRECRACKER_VERSION="v1.10.1"

# Detect architecture
ARCH=$(uname -m)

# Download and extract
curl -sL "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${ARCH}.tgz" | tar -xz

# Install binaries
sudo mv release-${FIRECRACKER_VERSION}-${ARCH}/firecracker-${FIRECRACKER_VERSION}-${ARCH} /usr/local/bin/firecracker
sudo mv release-${FIRECRACKER_VERSION}-${ARCH}/jailer-${FIRECRACKER_VERSION}-${ARCH} /usr/local/bin/jailer
sudo chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer

# Cleanup
rm -rf release-${FIRECRACKER_VERSION}-${ARCH}

# Verify installation
firecracker --version
```

### 3. Download the Kernel

```bash
mkdir -p assets

# For x86_64:
curl -sL "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/netboot/vmlinuz-virt" -o assets/vmlinux

# For aarch64:
# curl -sL "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/netboot/vmlinuz-virt" -o assets/vmlinux
```

### 4. Create the Root Filesystem

Create an Alpine Linux rootfs image:

```bash
ARCH=$(uname -m)
ALPINE_VERSION="3.21"

# Download Alpine mini rootfs
curl -sL "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/${ARCH}/alpine-minirootfs-${ALPINE_VERSION}.0-${ARCH}.tar.gz" -o /tmp/alpine-minirootfs.tar.gz

# Create ext4 image (512MB)
dd if=/dev/zero of=assets/alpine-rootfs.ext4 bs=1M count=512
mkfs.ext4 -F assets/alpine-rootfs.ext4

# Mount and extract
sudo mkdir -p /mnt/rootfs
sudo mount -o loop assets/alpine-rootfs.ext4 /mnt/rootfs
sudo tar -xzf /tmp/alpine-minirootfs.tar.gz -C /mnt/rootfs

# Configure init system
sudo tee /mnt/rootfs/etc/inittab > /dev/null << 'EOF'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100
::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
EOF

# Setup networking script
sudo tee /mnt/rootfs/etc/init.d/networking > /dev/null << 'EOF'
#!/sbin/openrc-run
depend() {
    after localmount
}
start() {
    ebegin "Configuring network"
    ip link set eth0 up
    if grep -q "ip=" /proc/cmdline; then
        IP=$(sed -n 's/.*ip=\([^:]*\).*/\1/p' /proc/cmdline)
        GW=$(sed -n 's/.*ip=[^:]*::[^:]*:\([^:]*\).*/\1/p' /proc/cmdline)
        ip addr add $IP dev eth0
        ip route add default via $GW
    fi
    eend 0
}
EOF
sudo chmod +x /mnt/rootfs/etc/init.d/networking
sudo ln -sf /etc/init.d/networking /mnt/rootfs/etc/runlevels/default/networking

# Configure DNS
echo "nameserver 8.8.8.8" | sudo tee /mnt/rootfs/etc/resolv.conf

# Set root password to empty
sudo sed -i 's/root:x:/root::/' /mnt/rootfs/etc/passwd
sudo sed -i 's/^root:.*/root::::::::/' /mnt/rootfs/etc/shadow

# Unmount
sudo umount /mnt/rootfs
sudo rmdir /mnt/rootfs

# Cleanup
rm /tmp/alpine-minirootfs.tar.gz
```

### 5. Setup Networking

Configure TAP networking for VM communication:

```bash
# Create TAP device
sudo ip tuntap add tap0 mode tap user $USER
sudo ip addr add 172.16.0.1/24 dev tap0
sudo ip link set tap0 up

# Enable IP forwarding
sudo sysctl -w net.ipv4.ip_forward=1

# Setup NAT for internet access (replace eth0 with your interface)
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
sudo iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
sudo iptables -A FORWARD -i tap0 -o eth0 -j ACCEPT
```

To make networking persistent across reboots, add these to your system startup scripts or use `systemd-networkd`.

### 6. Start Development Server

```bash
cd apps/api
DISABLE_AUTH=true bun run dev
```

The API is now available at `http://localhost:3000`.

## Production Deployment

### Systemd Service

Create a systemd service for running Hyperfleet in production:

```bash
sudo tee /etc/systemd/system/hyperfleet.service > /dev/null << 'EOF'
[Unit]
Description=Hyperfleet microVM API Server
After=network.target

[Service]
Type=simple
User=hyperfleet
Group=hyperfleet
WorkingDirectory=/opt/hyperfleet
ExecStart=/usr/local/bin/bun run apps/api/src/index.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=KERNEL_PATH=/opt/hyperfleet/assets/vmlinux
Environment=ROOTFS_PATH=/opt/hyperfleet/assets/alpine-rootfs.ext4

[Install]
WantedBy=multi-user.target
EOF
```

### Create Service User

```bash
# Create a dedicated user
sudo useradd -r -s /bin/false hyperfleet

# Add to kvm group
sudo usermod -aG kvm hyperfleet

# Set ownership
sudo chown -R hyperfleet:hyperfleet /opt/hyperfleet
```

### Persistent Networking with systemd-networkd

Create a netdev file for the TAP device:

```bash
sudo tee /etc/systemd/network/10-tap0.netdev > /dev/null << 'EOF'
[NetDev]
Name=tap0
Kind=tap

[Tap]
User=hyperfleet
EOF
```

Create the network configuration:

```bash
sudo tee /etc/systemd/network/10-tap0.network > /dev/null << 'EOF'
[Match]
Name=tap0

[Network]
Address=172.16.0.1/24
IPForward=yes
EOF
```

Enable and start:

```bash
sudo systemctl enable --now systemd-networkd
```

### Persistent NAT Rules

For persistent iptables rules, use `iptables-persistent`:

```bash
# Debian/Ubuntu
sudo apt install iptables-persistent
sudo netfilter-persistent save

# RHEL/Fedora
sudo dnf install iptables-services
sudo service iptables save
```

### Enable and Start Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable hyperfleet
sudo systemctl start hyperfleet

# Check status
sudo systemctl status hyperfleet

# View logs
sudo journalctl -u hyperfleet -f
```

## Production Checklist

Before deploying to production, ensure:

- [ ] **Authentication enabled** - Set up [API keys](/docs/api/authentication/)
- [ ] **TLS/HTTPS** - Use a reverse proxy like nginx or Caddy
- [ ] **Firewall configured** - Only expose necessary ports
- [ ] **Resource limits** - Configure systemd resource limits
- [ ] **Monitoring** - Set up health checks and alerting
- [ ] **Backups** - Regular backups of configuration and data

### Resource Limits

Add resource limits to the systemd service:

```ini
[Service]
# ... existing config ...
LimitNOFILE=65535
LimitNPROC=4096
MemoryMax=4G
CPUQuota=200%
```

### Health Check Script

Create a simple health check:

```bash
#!/bin/bash
# /opt/hyperfleet/health-check.sh

response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)

if [ "$response" = "200" ]; then
    echo "Hyperfleet is healthy"
    exit 0
else
    echo "Hyperfleet health check failed: HTTP $response"
    exit 1
fi
```

## Troubleshooting

### KVM Permission Denied

```bash
# Check device permissions
ls -la /dev/kvm

# Ensure user is in kvm group
groups $USER

# Temporary fix (not recommended for production)
sudo chmod 666 /dev/kvm
```

### TAP Device Issues

```bash
# List existing TAP devices
ip link show type tuntap

# Remove a TAP device
sudo ip link delete tap0

# Recreate
sudo ip tuntap add tap0 mode tap user $USER
```

### Firecracker Won't Start

```bash
# Check if another instance is using the socket
ls -la /tmp/firecracker.sock

# Remove stale socket
rm -f /tmp/firecracker.sock

# Check system logs
dmesg | tail -20
```

### Network Connectivity Issues

```bash
# Check IP forwarding
cat /proc/sys/net/ipv4/ip_forward

# Verify iptables rules
sudo iptables -L -v -n
sudo iptables -t nat -L -v -n

# Test from inside VM
# The VM should be able to ping 172.16.0.1 (host)
```

## Next Steps

- [Networking Guide](/docs/guides/networking/) - Advanced networking configuration
- [Environment Variables](/docs/configuration/environment-variables/) - All configuration options
- [Reverse Proxy](/docs/guides/reverse-proxy/) - Set up routing to VMs
