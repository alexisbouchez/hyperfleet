import type { Runtime } from "@hyperfleet/runtime";
import { Machine as FirecrackerMachine, type MachineConfig as FirecrackerConfig } from "@hyperfleet/firecracker";
import { Container, type ContainerConfig } from "@hyperfleet/docker";
import { Machine as CloudHypervisorMachine, type MachineConfig as CloudHypervisorConfig } from "@hyperfleet/cloud-hypervisor";
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
      case "docker":
        return this.createDocker(machine.id, config);
      case "cloud-hypervisor":
        return this.createCloudHypervisor(machine.id, config);
      default:
        throw new Error(`Unknown runtime type: ${machine.runtime_type}`);
    }
  }

  private createFirecracker(id: string, config: FirecrackerConfig): Runtime {
    this.logger?.debug("Creating Firecracker machine", { id, socketPath: config.socketPath });
    return new FirecrackerMachine(config);
  }

  private createDocker(id: string, config: ContainerConfig): Runtime {
    this.logger?.debug("Creating Docker container", { id, image: config.image });
    return new Container(config);
  }

  private createCloudHypervisor(id: string, config: CloudHypervisorConfig): Runtime {
    this.logger?.debug("Creating Cloud Hypervisor machine", { id, socketPath: config.socketPath });
    return new CloudHypervisorMachine(config);
  }
}
