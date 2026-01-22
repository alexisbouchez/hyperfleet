/**
 * Handler chain for Docker container lifecycle management
 * Similar pattern to Firecracker handlers
 */

import type { Container } from "./container";

export type ContainerHandler = (container: Container) => Promise<void>;

export class ContainerHandlerList {
  private handlers: Map<string, ContainerHandler> = new Map();
  private order: string[] = [];

  append(name: string, handler: ContainerHandler): this {
    if (!this.handlers.has(name)) {
      this.order.push(name);
    }
    this.handlers.set(name, handler);
    return this;
  }

  prepend(name: string, handler: ContainerHandler): this {
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

  async run(container: Container): Promise<void> {
    for (const name of this.order) {
      const handler = this.handlers.get(name);
      if (handler) {
        await handler(container);
      }
    }
  }

  list(): string[] {
    return [...this.order];
  }
}

export class ContainerHandlers {
  validation = new ContainerHandlerList();
  init = new ContainerHandlerList();
}

// Default validation handlers

export const ConfigValidationHandler: ContainerHandler = async (container) => {
  const config = container.config;

  if (!config.image) {
    throw new Error("image is required");
  }

  if (!config.id) {
    throw new Error("id is required");
  }
};

export const ResourceValidationHandler: ContainerHandler = async (container) => {
  const config = container.config;

  if (config.cpus !== undefined && config.cpus < 0.01) {
    throw new Error("cpus must be at least 0.01");
  }

  if (config.memoryMib !== undefined && config.memoryMib < 4) {
    throw new Error("memory must be at least 4 MiB");
  }
};

export const PortValidationHandler: ContainerHandler = async (container) => {
  const ports = container.config.ports || [];

  for (const port of ports) {
    if (port.hostPort < 0 || port.hostPort > 65535) {
      throw new Error(`invalid host port: ${port.hostPort}`);
    }
    if (port.containerPort < 0 || port.containerPort > 65535) {
      throw new Error(`invalid container port: ${port.containerPort}`);
    }
  }
};

// Default initialization handlers

export const PullImageHandler: ContainerHandler = async (container) => {
  const imageExists = await container.client.imageExists(container.config.image);
  if (!imageExists) {
    (await container.client.pullImage(container.config.image)).unwrap();
  }
};

export const CreateContainerHandler: ContainerHandler = async (container) => {
  await container.create();
};

/**
 * Create default handlers for a standard container start
 */
export function createDefaultHandlers(): ContainerHandlers {
  const handlers = new ContainerHandlers();

  // Validation handlers
  handlers.validation
    .append("ConfigValidation", ConfigValidationHandler)
    .append("ResourceValidation", ResourceValidationHandler)
    .append("PortValidation", PortValidationHandler);

  // Initialization handlers
  handlers.init
    .append("PullImage", PullImageHandler)
    .append("CreateContainer", CreateContainerHandler);

  return handlers;
}
