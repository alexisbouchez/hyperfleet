# Hyperfleet

## Local Development (macOS)

### Prerequisites

- [Lima](https://lima-vm.io/) installed

### Setup

1. Start Lima VM with nested virtualization:

```bash
limactl start --set '.nestedVirtualization=true' template://default
```

2. Install curl in the VM (needed to install Bun):

```bash
lima sudo apt-get update
lima sudo apt-get install -y curl
```

3. Install Bun in the VM:

```bash
lima bash -lc "curl -fsSL https://bun.sh/install | bash"
```

4. Run the local setup script:

```bash
bun run ./scripts/setup.ts
```

5. Enable KVM access by adding your user to the `kvm` group inside the VM:

```bash
lima sudo usermod -aG kvm $USER
```

6. Verify nested virtualization is working:

```bash
lima ls -la /dev/kvm
lima newgrp kvm -c "[ -w /dev/kvm ] && echo 'KVM acceleration can be used'"
```
