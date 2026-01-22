/**
 * Cloud Hypervisor Runtime Integration Tests
 *
 * These tests run real Cloud Hypervisor VMs and require:
 * - Linux host with KVM support (/dev/kvm)
 * - Cloud Hypervisor binary installed (run `bun run setup`)
 * - Kernel image and rootfs available
 *
 * Run with: bun test packages/cloud-hypervisor/src/__tests__/integration
 *
 * Note: These tests are skipped on GitHub Actions unless running on a
 * self-hosted runner with KVM access.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine, type MachineConfig } from "../../machine";

// Check if we can run VM tests
async function isKvmAvailable(): Promise<boolean> {
  try {
    return existsSync("/dev/kvm");
  } catch {
    return false;
  }
}

async function isCloudHypervisorAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "cloud-hypervisor"]);
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

// Default paths for kernel and rootfs (from setup script)
const KERNEL_PATH = join(process.env.HOME || "/root", ".hyperfleet/vmlinux");
const ROOTFS_PATH = join(process.env.HOME || "/root", ".hyperfleet/alpine-rootfs.ext4");

function hasRequiredAssets(): boolean {
  return existsSync(KERNEL_PATH) && existsSync(ROOTFS_PATH);
}

describe("Cloud Hypervisor Integration Tests", () => {
  let canRunTests: boolean;
  const machinesToCleanup: Machine[] = [];

  beforeAll(async () => {
    const kvmAvailable = await isKvmAvailable();
    const chAvailable = await isCloudHypervisorAvailable();
    const assetsAvailable = hasRequiredAssets();

    canRunTests = kvmAvailable && chAvailable && assetsAvailable;

    if (!canRunTests) {
      const missing: string[] = [];
      if (!kvmAvailable) missing.push("KVM");
      if (!chAvailable) missing.push("Cloud Hypervisor binary");
      if (!assetsAvailable) missing.push("kernel/rootfs assets");
      console.warn(`Skipping Cloud Hypervisor tests - missing: ${missing.join(", ")}`);
      console.warn("Run 'bun run setup' to install required assets");
    }
  });

  afterEach(async () => {
    // Clean up any machines created during tests
    for (const machine of machinesToCleanup) {
      try {
        await machine.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
    machinesToCleanup.length = 0;
  });

  afterAll(async () => {
    // Final cleanup
    for (const machine of machinesToCleanup) {
      try {
        await machine.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  function createTestConfig(id: string): MachineConfig {
    const socketPath = join(tmpdir(), `cloud-hypervisor-${id}-${Date.now()}.sock`);
    return {
      socketPath,
      payload: {
        kernel: KERNEL_PATH,
        cmdline: "console=ttyS0 root=/dev/vda rw",
      },
      cpus: {
        boot_vcpus: 1,
        max_vcpus: 1,
      },
      memory: {
        size: 134217728, // 128 MiB in bytes
      },
      disks: [
        {
          path: ROOTFS_PATH,
        },
      ],
      serial: {
        mode: "Null",
      },
      console: {
        mode: "Off",
      },
    };
  }

  describe("Machine Lifecycle", () => {
    it("should start a VM", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("start-test");
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      expect(machine.isRunning()).toBe(true);
      expect(machine.getPid()).not.toBeNull();

      // Verify instance state
      const info = await machine.getVmInfo();
      expect(info.state).toBe("Running");
    });

    it("should stop a VM", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("stop-test");
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();
      expect(machine.isRunning()).toBe(true);

      await machine.stop();
      expect(machine.isRunning()).toBe(false);
    });

    it("should pause and resume a VM", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("pause-test");
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      // Pause
      await machine.pause();
      const pausedInfo = await machine.getVmInfo();
      expect(pausedInfo.state).toBe("Paused");

      // Resume
      await machine.resume();
      const resumedInfo = await machine.getVmInfo();
      expect(resumedInfo.state).toBe("Running");
    });

    it("should gracefully shutdown a VM", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("shutdown-test");
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      // Graceful shutdown with timeout
      await machine.shutdown(5000);

      expect(machine.isRunning()).toBe(false);
    });

    it("should get runtime info", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("info-test");
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      const info = await machine.getInfo();
      expect(info.id).toBeDefined();
      expect(info.status).toBe("running");
      expect(info.pid).not.toBeNull();
    });
  });

  describe("Machine Configuration", () => {
    it("should start with custom vCPU count", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("vcpu-test");
      config.cpus = {
        boot_vcpus: 2,
        max_vcpus: 2,
      };
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      const info = await machine.getVmInfo();
      expect(info.state).toBe("Running");
    });

    it("should start with custom memory size", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("memory-test");
      config.memory = {
        size: 268435456, // 256 MiB
      };
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      const info = await machine.getVmInfo();
      expect(info.state).toBe("Running");
    });
  });

  describe("Dynamic Operations", () => {
    it("should resize CPU count", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("resize-cpu-test");
      config.cpus = {
        boot_vcpus: 1,
        max_vcpus: 4,
      };
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      // Resize to 2 vCPUs
      await machine.resize({ desired_vcpus: 2 });

      // Verify (may need to check via VM info or guest)
      const info = await machine.getVmInfo();
      expect(info.state).toBe("Running");
    });

    it("should get VM counters", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("counters-test");
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      const counters = await machine.getCounters();
      expect(typeof counters).toBe("object");
    });
  });

  describe("Command Execution (requires vsock agent)", () => {
    // Note: These tests require a vsock agent running inside the VM
    // which would need to be set up in the rootfs image

    it.skip("should execute commands via vsock", async () => {
      if (!canRunTests) return;

      const config = createTestConfig("exec-test");
      config.vsock = {
        cid: 3,
        socket: join(tmpdir(), `vsock-${Date.now()}.sock`),
      };
      const machine = new Machine(config);
      machinesToCleanup.push(machine);

      await machine.start();

      // This requires a vsock agent running in the VM
      const result = await machine.exec(["echo", "hello"]);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("hello");
    });
  });

  describe("Multiple Machines", () => {
    it("should run multiple VMs concurrently", async () => {
      if (!canRunTests) return;

      const machines: Machine[] = [];

      for (let i = 0; i < 2; i++) {
        const config = createTestConfig(`multi-${i}`);
        const machine = new Machine(config);
        machines.push(machine);
        machinesToCleanup.push(machine);
      }

      // Start all machines
      await Promise.all(machines.map((m) => m.start()));

      // Verify all are running
      for (const machine of machines) {
        expect(machine.isRunning()).toBe(true);
        const info = await machine.getVmInfo();
        expect(info.state).toBe("Running");
      }

      // Stop all machines
      await Promise.all(machines.map((m) => m.stop()));
    });
  });
});
