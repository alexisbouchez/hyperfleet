---
title: Installation
description: How to install and set up Hyperfleet on your system.
icon: download
---

## Prerequisites

Before installing Hyperfleet, ensure you have the following:

### Required

- **Bun v1.0+** - TypeScript runtime ([install Bun](https://bun.sh/))
- **Linux with KVM support** - Firecracker requires KVM for hardware virtualization

### For Linux Development

If you're developing directly on Linux, you can run Firecracker natively without any virtualization layer. See the [Linux Development & Deployment](/docs/guides/linux-development/) guide for detailed instructions.

### For macOS Development

Since macOS doesn't support KVM natively, you'll need:

- **Lima** - Linux virtual machine for macOS ([install Lima](https://lima-vm.io/))

Lima provides a Linux environment with nested virtualization support, allowing you to run Firecracker microVMs on your Mac. The automated setup script below handles Lima configuration for you.

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/alexisbouchez/hyperfleet.git
cd hyperfleet
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Run Automated Setup

The setup script handles all the heavy lifting:

```bash
bun run setup
```

This command will:

1. **Create/start a Lima VM** (macOS only) with nested virtualization enabled
2. **Install Firecracker v1.10.1** inside the VM
3. **Download Alpine Linux kernel** for booting VMs
4. **Create Alpine Linux rootfs** image
5. **Configure TAP devices** for networking

### 4. Verify Installation

After setup completes, verify everything is working:

```bash
# Start the API server
cd apps/api
bun run dev
```

The API should be available at `http://localhost:3000`. Check the health endpoint:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "healthy"
}
```

## Directory Structure After Setup

After running setup, you'll have these additional directories:

```
hyperfleet/
├── .hyperfleet/
│   ├── firecracker           # Firecracker binary
│   ├── vmlinux               # Linux kernel
│   └── alpine-rootfs.ext4    # Root filesystem image
└── ...
```

## Troubleshooting

### KVM Not Available

If you see errors about KVM not being available:

**On Linux:**
```bash
# Check if KVM is enabled
lsmod | grep kvm

# If not loaded, try:
sudo modprobe kvm
sudo modprobe kvm_intel  # or kvm_amd for AMD CPUs
```

**On macOS:**
Ensure Lima is properly installed and the VM is running:
```bash
limactl list
limactl start default
```

### Permission Denied

If you encounter permission errors:

```bash
# Add your user to the kvm group (Linux)
sudo usermod -aG kvm $USER

# Log out and back in for changes to take effect
```

### Lima VM Issues (macOS)

If the Lima VM isn't starting properly:

```bash
# Stop and restart the VM
limactl stop default
limactl start default

# Check VM status
limactl shell default -- uname -a
```

## Next Steps

Once installation is complete, proceed to the [Quickstart guide](/docs/quickstart/) to create your first microVM.
