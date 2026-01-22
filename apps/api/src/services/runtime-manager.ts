import type { Runtime } from "@hyperfleet/runtime";
import type { Logger } from "@hyperfleet/logger";

/**
 * In-memory registry of running runtime instances
 * Tracks active VMs/containers to enable stop operations
 */
export class RuntimeManager {
  private instances: Map<string, Runtime> = new Map();

  constructor(private logger?: Logger) {}

  /**
   * Register a running runtime instance
   */
  register(id: string, runtime: Runtime): void {
    this.instances.set(id, runtime);
    this.logger?.debug("Runtime registered", { id, type: runtime.type });
  }

  /**
   * Get a runtime instance by ID
   */
  get(id: string): Runtime | undefined {
    return this.instances.get(id);
  }

  /**
   * Remove a runtime instance from the registry
   */
  remove(id: string): boolean {
    const removed = this.instances.delete(id);
    if (removed) {
      this.logger?.debug("Runtime unregistered", { id });
    }
    return removed;
  }

  /**
   * Check if a runtime is registered
   */
  has(id: string): boolean {
    return this.instances.has(id);
  }

  /**
   * List all registered runtime IDs
   */
  listRunning(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * Get the count of running instances
   */
  count(): number {
    return this.instances.size;
  }

  /**
   * Clear all registered instances (for shutdown)
   */
  clear(): void {
    this.instances.clear();
  }
}

// Singleton instance for sharing across the application
let globalManager: RuntimeManager | null = null;

/**
 * Get the global RuntimeManager instance
 */
export function getGlobalRuntimeManager(logger?: Logger): RuntimeManager {
  if (!globalManager) {
    globalManager = new RuntimeManager(logger);
  }
  return globalManager;
}
