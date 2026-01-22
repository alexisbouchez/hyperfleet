/**
 * Handler chain for Cloud Hypervisor VM lifecycle management
 * Similar pattern to Firecracker handlers
 */

import type { Machine } from "./machine";

export type CloudHypervisorHandler = (machine: Machine) => Promise<void>;

export class CloudHypervisorHandlerList {
  private handlers: Map<string, CloudHypervisorHandler> = new Map();
  private order: string[] = [];

  append(name: string, handler: CloudHypervisorHandler): this {
    if (!this.handlers.has(name)) {
      this.order.push(name);
    }
    this.handlers.set(name, handler);
    return this;
  }

  prepend(name: string, handler: CloudHypervisorHandler): this {
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

export class CloudHypervisorHandlers {
  validation = new CloudHypervisorHandlerList();
  init = new CloudHypervisorHandlerList();
}

// Default validation handlers

export const ConfigValidationHandler: CloudHypervisorHandler = async (machine) => {
  const config = machine.config;

  if (!config.payload) {
    throw new Error("payload configuration is required");
  }

  if (!config.payload.kernel && !config.payload.firmware) {
    throw new Error("either kernel or firmware path is required");
  }

  if (!config.cpus) {
    throw new Error("cpus configuration is required");
  }

  if (config.cpus.boot_vcpus < 1) {
    throw new Error("boot_vcpus must be at least 1");
  }

  if (!config.memory) {
    throw new Error("memory configuration is required");
  }

  if (config.memory.size < 1) {
    throw new Error("memory size must be at least 1 byte");
  }
};

export const NetworkConfigValidationHandler: CloudHypervisorHandler = async (machine) => {
  const netConfigs = machine.config.net || [];

  for (const net of netConfigs) {
    if (net.tap && !net.tap.match(/^[a-zA-Z0-9_-]+$/)) {
      throw new Error(`invalid TAP device name: ${net.tap}`);
    }
  }
};

export const DiskConfigValidationHandler: CloudHypervisorHandler = async (machine) => {
  const disks = machine.config.disks || [];

  for (const disk of disks) {
    if (!disk.path && !disk.vhost_user) {
      throw new Error("disk must have either a path or vhost_user configured");
    }
  }
};

// Default initialization handlers

export const CreateVmHandler: CloudHypervisorHandler = async (machine) => {
  const vmConfig = machine.buildVmConfig();
  (await machine.client.createVm(vmConfig)).unwrap();
};

export const BootVmHandler: CloudHypervisorHandler = async (machine) => {
  (await machine.client.bootVm()).unwrap();
};

/**
 * Create default handlers for a standard VM start
 */
export function createDefaultHandlers(): CloudHypervisorHandlers {
  const handlers = new CloudHypervisorHandlers();

  // Validation handlers
  handlers.validation
    .append("ConfigValidation", ConfigValidationHandler)
    .append("NetworkConfigValidation", NetworkConfigValidationHandler)
    .append("DiskConfigValidation", DiskConfigValidationHandler);

  // Initialization handlers
  handlers.init
    .append("CreateVm", CreateVmHandler)
    .append("BootVm", BootVmHandler);

  return handlers;
}
