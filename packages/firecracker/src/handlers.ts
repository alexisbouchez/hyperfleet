/**
 * Handler chain for VM lifecycle management
 * Similar to firecracker-go-sdk's handler pattern
 */

import { Result } from "better-result";
import type { Machine } from "./machine";
import { getImageService } from "@hyperfleet/oci";

export type Handler = (machine: Machine) => Promise<Result<void, Error>>;

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

  /**
   * Insert a handler before another handler
   */
  insertBefore(beforeName: string, name: string, handler: Handler): this {
    if (this.handlers.has(name)) {
      this.order = this.order.filter((n) => n !== name);
    }
    this.handlers.set(name, handler);

    const index = this.order.indexOf(beforeName);
    if (index === -1) {
      // If before handler not found, append at end
      this.order.push(name);
    } else {
      this.order.splice(index, 0, name);
    }
    return this;
  }

  /**
   * Insert a handler after another handler
   */
  insertAfter(afterName: string, name: string, handler: Handler): this {
    if (this.handlers.has(name)) {
      this.order = this.order.filter((n) => n !== name);
    }
    this.handlers.set(name, handler);

    const index = this.order.indexOf(afterName);
    if (index === -1) {
      // If after handler not found, append at end
      this.order.push(name);
    } else {
      this.order.splice(index + 1, 0, name);
    }
    return this;
  }

  clear(): this {
    this.handlers.clear();
    this.order = [];
    return this;
  }

  async run(machine: Machine): Promise<Result<void, Error>> {
    for (const name of this.order) {
      const handler = this.handlers.get(name);
      if (handler) {
        const result = await handler(machine);
        if (result.isErr()) {
          return result;
        }
      }
    }
    return Result.ok(undefined);
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
    return Result.err(new Error("kernel image path is required"));
  }

  if (config.vcpuCount < 1) {
    return Result.err(new Error("vcpu count must be at least 1"));
  }

  if (config.memSizeMib < 1) {
    return Result.err(new Error("memory size must be at least 1 MiB"));
  }

  return Result.ok(undefined);
};

export const NetworkConfigValidationHandler: Handler = async (machine) => {
  const networkInterfaces = machine.config.networkInterfaces || [];

  for (const iface of networkInterfaces) {
    if (!iface.iface_id) {
      return Result.err(new Error("network interface id is required"));
    }
    if (!iface.host_dev_name) {
      return Result.err(new Error("host device name is required"));
    }
  }

  return Result.ok(undefined);
};

// Default initialization handlers
export const CreateLogFilesHandler: Handler = async (machine) => {
  const { logPath } = machine.config;
  if (logPath) {
    try {
      const file = Bun.file(logPath);
      await Bun.write(file, "");
    } catch (err) {
      return Result.err(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return Result.ok(undefined);
};

export const BootstrapLoggingHandler: Handler = async (machine) => {
  const { logPath, logLevel } = machine.config;
  if (logPath) {
    return await machine.client.putLogger({
      log_path: logPath,
      level: logLevel || "Warning",
      show_level: true,
      show_log_origin: true,
    });
  }
  return Result.ok(undefined);
};

export const CreateMachineHandler: Handler = async (machine) => {
  return await machine.client.putMachineConfiguration({
    vcpu_count: machine.config.vcpuCount,
    mem_size_mib: machine.config.memSizeMib,
    smt: machine.config.smt,
    cpu_template: machine.config.cpuTemplate,
    track_dirty_pages: machine.config.trackDirtyPages,
  });
};

export const CreateBootSourceHandler: Handler = async (machine) => {
  return await machine.client.putGuestBootSource({
    kernel_image_path: machine.config.kernelImagePath,
    boot_args: machine.getKernelArgs(),
    initrd_path: machine.config.initrdPath,
  });
};

export const AttachDrivesHandler: Handler = async (machine) => {
  const drives = machine.config.drives || [];
  for (const drive of drives) {
    const result = await machine.client.putGuestDriveByID(drive);
    if (result.isErr()) return result;
  }
  return Result.ok(undefined);
};

/**
 * Handler to resolve OCI images to ext4 rootfs
 * Should run before AttachDrivesHandler
 */
export const ResolveImageHandler: Handler = async (machine) => {
  const { imageRef, imageSizeMib, registryAuth } = machine.config;

  if (!imageRef) {
    return Result.ok(undefined); // No image to resolve, skip
  }

  const imageService = getImageService();
  const result = await imageService.resolveImage(imageRef, {
    sizeMib: imageSizeMib,
    auth: registryAuth,
  });

  if (result.isErr()) {
    return Result.err(new Error(`Failed to resolve image ${imageRef}: ${result.error.message}`));
  }

  const converted = result.unwrap();

  // Update the root drive with the converted image path
  if (!machine.config.drives || machine.config.drives.length === 0) {
    machine.config.drives = [
      {
        drive_id: "rootfs",
        path_on_host: converted.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    ];
  } else {
    // Update the first drive (root drive) with the converted image
    machine.config.drives[0].path_on_host = converted.rootfsPath;
  }

  return Result.ok(undefined);
};

export const CreateNetworkInterfacesHandler: Handler = async (machine) => {
  const interfaces = machine.config.networkInterfaces || [];
  for (const iface of interfaces) {
    const result = await machine.client.putGuestNetworkInterfaceByID(iface);
    if (result.isErr()) return result;
  }
  return Result.ok(undefined);
};

export const AddVsockHandler: Handler = async (machine) => {
  const { vsock } = machine.config;
  if (vsock) {
    return await machine.client.putGuestVsock(vsock);
  }
  return Result.ok(undefined);
};

export const SetupBalloonHandler: Handler = async (machine) => {
  const { balloon } = machine.config;
  if (balloon) {
    return await machine.client.putBalloon(balloon);
  }
  return Result.ok(undefined);
};

export const ConfigMmdsHandler: Handler = async (machine) => {
  const { mmdsConfig, mmdsData } = machine.config;
  if (mmdsConfig) {
    const res = await machine.client.putMmdsConfig(mmdsConfig);
    if (res.isErr()) return res;
    
    if (mmdsData) {
      return await machine.client.putMmds(mmdsData);
    }
  }
  return Result.ok(undefined);
};

export const StartVMMHandler: Handler = async (machine) => {
  return await machine.client.createSyncAction("InstanceStart");
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
    .append("ResolveImage", ResolveImageHandler)
    .append("AttachDrives", AttachDrivesHandler)
    .append("CreateNetworkInterfaces", CreateNetworkInterfacesHandler)
    .append("AddVsock", AddVsockHandler)
    .append("SetupBalloon", SetupBalloonHandler)
    .append("ConfigMmds", ConfigMmdsHandler)
    .append("StartVMM", StartVMMHandler);

  return handlers;
}