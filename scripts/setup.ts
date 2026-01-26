import { $ } from "bun";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const FIRECRACKER_VERSION = "v1.10.1";
const ALPINE_VERSION = "3.21";

const ASSETS_DIR = join(import.meta.dir, "..", "assets");
const KERNEL_PATH = join(ASSETS_DIR, "vmlinux");
const ROOTFS_PATH = join(ASSETS_DIR, "alpine-rootfs.ext4");

async function checkCommand(command: string): Promise<boolean> {
  try {
    await $`which ${command}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function run(description: string, fn: () => Promise<void>) {
  process.stdout.write(`${description}... `);
  try {
    await fn();
    console.log("done");
  } catch (error) {
    console.log("failed");
    throw error;
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  await Bun.write(dest, response);
}

async function getArch(): Promise<"x86_64" | "aarch64"> {
  const arch = (await $`lima uname -m`.text()).trim();
  return arch === "aarch64" ? "aarch64" : "x86_64";
}

async function setupLima(): Promise<void> {
  const hasLima = await checkCommand("limactl");
  if (!hasLima) {
    console.error("Error: Lima is not installed.");
    console.error("Install it with: brew install lima");
    process.exit(1);
  }
  console.log("Lima is installed");

  // Check if default VM exists
  const vmsOutput = await $`limactl list --format json`.text();
  const vms = vmsOutput.trim() ? JSON.parse(vmsOutput) : [];
  const defaultVm = vms.find((vm: { name: string }) => vm.name === "default");

  if (!defaultVm) {
    await run("Creating Lima VM with nested virtualization", async () => {
      await $`limactl start --set '.nestedVirtualization=true' template://default`;
    });
  } else if (defaultVm.status !== "Running") {
    await run("Starting Lima VM", async () => {
      await $`limactl start default`;
    });
  } else {
    console.log("Lima VM is already running");
  }

  // Configure KVM access
  await run("Configuring KVM access", async () => {
    await $`lima sudo usermod -aG kvm $USER`.quiet().nothrow();
  });

  // Verify KVM access
  const kvmCheck =
    await $`lima sh -c "[ -w /dev/kvm ] && echo 'ok' || echo 'fail'"`.text();

  if (kvmCheck.trim() === "ok") {
    console.log("KVM acceleration is available");
  } else {
    console.warn("Warning: KVM acceleration may not be available");
    console.warn("Try: lima sudo chmod 666 /dev/kvm");
  }
}

async function installFirecracker(): Promise<void> {
  const hasFirecracker =
    (await $`lima which firecracker`.quiet().nothrow()).exitCode === 0;

  if (hasFirecracker) {
    const version = (await $`lima firecracker --version`.text()).trim();
    console.log(`Firecracker already installed: ${version}`);
    return;
  }

  await run("Installing Firecracker", async () => {
    const arch = await getArch();
    const url = `https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${arch}.tgz`;
    const releaseDir = `release-${FIRECRACKER_VERSION}-${arch}`;

    await $`lima bash -c "cd /tmp && curl -sL '${url}' | tar -xz"`;
    await $`lima sudo mv /tmp/${releaseDir}/firecracker-${FIRECRACKER_VERSION}-${arch} /usr/local/bin/firecracker`;
    await $`lima sudo mv /tmp/${releaseDir}/jailer-${FIRECRACKER_VERSION}-${arch} /usr/local/bin/jailer`;
    await $`lima sudo chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer`;
    await $`lima rm -rf /tmp/${releaseDir}`;
  });
}

async function downloadKernel(): Promise<void> {
  if (existsSync(KERNEL_PATH)) {
    console.log("Kernel already exists, skipping download");
    return;
  }

  await run("Downloading Alpine Linux kernel", async () => {
    const arch = await getArch();
    const kernelArch = arch === "aarch64" ? "aarch64" : "x86_64";

    // Download kernel from Alpine Linux
    const kernelUrl = `https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/${kernelArch}/netboot/vmlinuz-virt`;

    await downloadFile(kernelUrl, KERNEL_PATH);
  });
}

async function createRootfs(): Promise<void> {
  if (existsSync(ROOTFS_PATH)) {
    console.log("Rootfs already exists, skipping creation");
    return;
  }

  await run("Creating Alpine Linux rootfs", async () => {
    const arch = await getArch();
    const alpineArch = arch === "aarch64" ? "aarch64" : "x86_64";
    const miniRootfsUrl = `https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/${alpineArch}/alpine-minirootfs-${ALPINE_VERSION}.0-${alpineArch}.tar.gz`;

    // Create rootfs in Lima VM
    const script = `
set -e

# Download mini rootfs
cd /tmp
curl -sL "${miniRootfsUrl}" -o alpine-minirootfs.tar.gz

# Create ext4 image (512MB)
dd if=/dev/zero of=alpine-rootfs.ext4 bs=1M count=512
mkfs.ext4 -F alpine-rootfs.ext4

# Mount and extract
sudo mkdir -p /mnt/rootfs
sudo mount -o loop alpine-rootfs.ext4 /mnt/rootfs
sudo tar -xzf alpine-minirootfs.tar.gz -C /mnt/rootfs

# Configure the system
sudo tee /mnt/rootfs/etc/inittab > /dev/null << 'INITTAB'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100
::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
INITTAB

# Enable serial console
sudo mkdir -p /mnt/rootfs/etc/init.d

# Set up networking script
sudo tee /mnt/rootfs/etc/init.d/networking > /dev/null << 'NETWORKING'
#!/sbin/openrc-run
depend() {
    after localmount
}
start() {
    ebegin "Configuring network"
    ip link set eth0 up
    # Try DHCP or use static from kernel args
    if grep -q "ip=" /proc/cmdline; then
        IP=$(sed -n 's/.*ip=\\([^:]*\\).*/\\1/p' /proc/cmdline)
        GW=$(sed -n 's/.*ip=[^:]*::[^:]*:\\([^:]*\\).*/\\1/p' /proc/cmdline)
        ip addr add $IP dev eth0
        ip route add default via $GW
    fi
    eend 0
}
NETWORKING
sudo chmod +x /mnt/rootfs/etc/init.d/networking

# Enable services
sudo ln -sf /etc/init.d/networking /mnt/rootfs/etc/runlevels/default/networking 2>/dev/null || true

# Set root password to empty (no password)
sudo sed -i 's/root:x:/root::/' /mnt/rootfs/etc/passwd
sudo sed -i 's/^root:.*/root::::::::/' /mnt/rootfs/etc/shadow

# Create a welcome message
sudo tee /mnt/rootfs/etc/motd > /dev/null << 'MOTD'

  _    _                       __ _           _
 | |  | |                     / _| |         | |
 | |__| |_   _ _ __   ___ _ _| |_| | ___  ___| |_
 |  __  | | | | '_ \\ / _ \\ '__|  _| |/ _ \\/ _ \\ __|
 | |  | | |_| | |_) |  __/ |  | | | |  __/  __/ |_
 |_|  |_|\\__, | .__/ \\___|_|  |_| |_|\\___|\\___|\\__|
          __/ | |
         |___/|_|   Alpine Linux microVM

MOTD

# Configure DNS
echo "nameserver 8.8.8.8" | sudo tee /mnt/rootfs/etc/resolv.conf

# Unmount
sudo umount /mnt/rootfs
sudo rmdir /mnt/rootfs

# Cleanup
rm alpine-minirootfs.tar.gz
`;

    await $`lima bash -c ${script}`;

    // Copy rootfs from Lima to host
    await $`limactl copy default:/tmp/alpine-rootfs.ext4 ${ROOTFS_PATH}`;
    await $`lima rm /tmp/alpine-rootfs.ext4`;
  });
}

async function setupNetworking(): Promise<void> {
  await run("Setting up networking in Lima VM", async () => {
    const script = `
# Create a TAP device for Firecracker
sudo ip tuntap add tap0 mode tap
sudo ip addr add 172.16.0.1/24 dev tap0
sudo ip link set tap0 up

# Enable IP forwarding
sudo sysctl -w net.ipv4.ip_forward=1

# Setup NAT for internet access
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
sudo iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
sudo iptables -A FORWARD -i tap0 -o eth0 -j ACCEPT
`;
    await $`lima bash -c ${script}`.nothrow();
  });
}

async function main() {
  console.log("Hyperfleet Setup\n");
  console.log("================\n");

  // Create assets directory
  if (!existsSync(ASSETS_DIR)) {
    mkdirSync(ASSETS_DIR, { recursive: true });
  }

  // Step 1: Setup Lima VM
  console.log("\n[1/5] Setting up Lima VM...\n");
  await setupLima();

  // Step 2: Install Firecracker
  console.log("\n[2/5] Installing Firecracker...\n");
  await installFirecracker();

  // Step 3: Download kernel
  console.log("\n[3/5] Downloading Alpine Linux kernel...\n");
  await downloadKernel();

  // Step 4: Create rootfs
  console.log("\n[4/5] Creating Alpine Linux rootfs...\n");
  await createRootfs();

  // Step 5: Setup networking
  console.log("\n[5/5] Setting up networking...\n");
  await setupNetworking();

  console.log("\n================");
  console.log("Setup complete!\n");
  console.log("Installed runtime: Firecracker (microVMs)");
  console.log("\nAssets location:");
  console.log(`  Kernel: ${KERNEL_PATH}`);
  console.log(`  Rootfs: ${ROOTFS_PATH}`);
  console.log("\n--- Firecracker Example ---");
  console.log(`
import { Machine, DrivesBuilder } from "@hyperfleet/firecracker";

const machine = new Machine({
  socketPath: "/tmp/firecracker.sock",
  kernelImagePath: "${KERNEL_PATH}",
  kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
  vcpuCount: 1,
  memSizeMib: 128,
  drives: new DrivesBuilder("${ROOTFS_PATH}").build(),
});

await machine.start();
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
