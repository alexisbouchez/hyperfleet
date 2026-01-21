/**
 * Handler chain for VM lifecycle management
 * Similar to firecracker-go-sdk's handler pattern
 */

import type { Machine } from "./machine";

export type Handler = (machine: Machine) => Promise<void>;

export class HandlerList {
  private handlers: Map<string, Handler> = new Map();
  private order: string[] = [];

  append(name: string, handler: Handler): this {
    if (!this.handlers.has(name)) {
      this.order.push(name);
    }
    this.handlers.set(name, handler);
    return this;
  }

  prepend(name: string, handler: Handler): this {
    if (this.handlers.has(name)) {
      this.order = this.order.filter((n) => n !== name);
    }
    this.handlers.set(name, handler);
    this.order.unshift(name);
    return this;
  }

  remove(name: string): this {
    this.handlers.delete(name);
    this.order = this.order.filter((n) => n !== name);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  clear(): this {
    this.handlers.clear();
    this.order = [];
    return this;
  }

  async run(machine: Machine): Promise<void> {
    for (const name of this.order) {
      const handler = this.handlers.get(name);
      if (handler) {
        await handler(machine);
      }
    }
  }

  list(): string[] {
    return [...this.order];
  }
}

export class Handlers {
  validation = new HandlerList();
  fcInit = new HandlerList();
}

// Default validation handlers
export const ConfigValidationHandler: Handler = async (machine) => {
  const config = machine.config;

  if (!config.kernelImagePath) {
    throw new Error("kernel image path is required");
  }

  if (config.vcpuCount < 1) {
    throw new Error("vcpu count must be at least 1");
  }

  if (config.memSizeMib < 1) {
    throw new Error("memory size must be at least 1 MiB");
  }
};

export const NetworkConfigValidationHandler: Handler = async (machine) => {
  const networkInterfaces = machine.config.networkInterfaces || [];

  for (const iface of networkInterfaces) {
    if (!iface.iface_id) {
      throw new Error("network interface id is required");
    }
    if (!iface.host_dev_name) {
      throw new Error("host device name is required");
    }
  }
};

// Default initialization handlers
export const CreateLogFilesHandler: Handler = async (machine) => {
  const { logPath } = machine.config;
  if (logPath) {
    const file = Bun.file(logPath);
    await Bun.write(file, "");
  }
};

export const BootstrapLoggingHandler: Handler = async (machine) => {
  const { logPath, logLevel } = machine.config;
  if (logPath) {
    await machine.client.putLogger({
      log_path: logPath,
      level: logLevel || "Warning",
      show_level: true,
      show_log_origin: true,
    });
  }
};

export const CreateMachineHandler: Handler = async (machine) => {
  await machine.client.putMachineConfiguration({
    vcpu_count: machine.config.vcpuCount,
    mem_size_mib: machine.config.memSizeMib,
    smt: machine.config.smt,
    cpu_template: machine.config.cpuTemplate,
    track_dirty_pages: machine.config.trackDirtyPages,
  });
};

export const CreateBootSourceHandler: Handler = async (machine) => {
  await machine.client.putGuestBootSource({
    kernel_image_path: machine.config.kernelImagePath,
    boot_args: machine.getKernelArgs(),
    initrd_path: machine.config.initrdPath,
  });
};

export const AttachDrivesHandler: Handler = async (machine) => {
  const drives = machine.config.drives || [];
  for (const drive of drives) {
    await machine.client.putGuestDriveByID(drive);
  }
};

export const CreateNetworkInterfacesHandler: Handler = async (machine) => {
  const interfaces = machine.config.networkInterfaces || [];
  for (const iface of interfaces) {
    await machine.client.putGuestNetworkInterfaceByID(iface);
  }
};

export const AddVsockHandler: Handler = async (machine) => {
  const { vsock } = machine.config;
  if (vsock) {
    await machine.client.putGuestVsock(vsock);
  }
};

export const SetupBalloonHandler: Handler = async (machine) => {
  const { balloon } = machine.config;
  if (balloon) {
    await machine.client.putBalloon(balloon);
  }
};

export const ConfigMmdsHandler: Handler = async (machine) => {
  const { mmdsConfig, mmdsData } = machine.config;
  if (mmdsConfig) {
    await machine.client.putMmdsConfig(mmdsConfig);
    if (mmdsData) {
      await machine.client.putMmds(mmdsData);
    }
  }
};

export const StartVMMHandler: Handler = async (machine) => {
  await machine.client.createSyncAction("InstanceStart");
};

/**
 * Create default handlers for a standard VM start
 */
export function createDefaultHandlers(): Handlers {
  const handlers = new Handlers();

  // Validation handlers
  handlers.validation
    .append("ConfigValidation", ConfigValidationHandler)
    .append("NetworkConfigValidation", NetworkConfigValidationHandler);

  // Initialization handlers
  handlers.fcInit
    .append("CreateLogFiles", CreateLogFilesHandler)
    .append("BootstrapLogging", BootstrapLoggingHandler)
    .append("CreateMachine", CreateMachineHandler)
    .append("CreateBootSource", CreateBootSourceHandler)
    .append("AttachDrives", AttachDrivesHandler)
    .append("CreateNetworkInterfaces", CreateNetworkInterfacesHandler)
    .append("AddVsock", AddVsockHandler)
    .append("SetupBalloon", SetupBalloonHandler)
    .append("ConfigMmds", ConfigMmdsHandler)
    .append("StartVMM", StartVMMHandler);

  return handlers;
}
