import type { Runtime } from "@hyperfleet/runtime";
import { Machine as FirecrackerMachine, type MachineConfig as FirecrackerConfig } from "@hyperfleet/firecracker";
import type { Machine } from "@hyperfleet/worker/database";
import type { Logger } from "@hyperfleet/logger";

/**
 * Factory for creating Runtime instances from database records
 */
export class RuntimeFactory {
  constructor(private logger?: Logger) {}

  /**
   * Create a runtime instance from a database machine record
   */
  createFromMachine(machine: Machine): Runtime {
    const config = JSON.parse(machine.config_json);

    switch (machine.runtime_type) {
      case "firecracker":
        return this.createFirecracker(machine.id, config);
      default:
        throw new Error(`Unknown runtime type: ${machine.runtime_type}`);
    }
  }

  private createFirecracker(id: string, config: FirecrackerConfig): Runtime {
    this.logger?.debug("Creating Firecracker machine", { id, socketPath: config.socketPath });
    return new FirecrackerMachine(config);
  }
}
