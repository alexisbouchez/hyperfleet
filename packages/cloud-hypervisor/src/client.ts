/**
 * Cloud Hypervisor API client
 * Communicates with Cloud Hypervisor via Unix socket REST API
 */

import { Result } from "better-result";
import { CloudHypervisorApiError } from "@hyperfleet/errors";
import type {
  VmConfig,
  VmInfo,
  VmmPingResponse,
  VmResize,
  VmResizeDisk,
  VmResizeZone,
  SnapshotConfig,
  RestoreConfig,
  MigrationConfig,
  ReceiveMigrationConfig,
  DeviceRemoval,
  PciDeviceInfo,
  VmCounters,
  DiskConfig,
  NetConfig,
  FsConfig,
  PmemConfig,
  VsockConfig,
  DeviceConfig,
  UserDeviceConfig,
  VdpaConfig,
} from "./models";

export interface CloudHypervisorClientConfig {
  /**
   * Path to the Cloud Hypervisor API socket
   */
  socketPath: string;
}

/**
 * Cloud Hypervisor API client
 * Uses Unix socket for communication with the Cloud Hypervisor REST API
 */
export class CloudHypervisorClient {
  private socketPath: string;

  constructor(config: CloudHypervisorClientConfig) {
    this.socketPath = config.socketPath;
  }

  /**
   * Make a request to the Cloud Hypervisor API
   */
  private async request<T>(
    method: "GET" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<Result<T, CloudHypervisorApiError>> {
    return Result.tryPromise({
      try: async () => {
        const url = `unix://${this.socketPath}:http://localhost/api/v1${path}`;

        const headers: Record<string, string> = {
          Accept: "application/json",
        };

        let requestBody: string | undefined;
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
          requestBody = JSON.stringify(body);
        }

        const response = await fetch(url, {
          method,
          headers,
          body: requestBody,
          unix: this.socketPath,
        } as globalThis.RequestInit & { unix: string });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new CloudHypervisorApiError({
            message: `Cloud Hypervisor API error: ${response.status} ${response.statusText}`,
            statusCode: response.status,
            body: errorBody,
          });
        }

        // Handle 204 No Content
        if (response.status === 204) {
          return undefined as T;
        }

        const text = await response.text();
        if (!text) {
          return undefined as T;
        }

        return JSON.parse(text) as T;
      },
      catch: (cause) => {
        if (CloudHypervisorApiError.is(cause)) {
          return cause;
        }
        return new CloudHypervisorApiError({
          message: cause instanceof Error ? cause.message : String(cause),
          statusCode: 0,
          body: "",
        });
      },
    });
  }

  // ============================================
  // VMM (Virtual Machine Monitor) operations
  // ============================================

  /**
   * Ping the VMM to check if it's running
   */
  async ping(): Promise<Result<VmmPingResponse, CloudHypervisorApiError>> {
    return this.request<VmmPingResponse>("GET", "/vmm.ping");
  }

  /**
   * Shutdown the VMM (terminates the hypervisor process)
   */
  async shutdownVmm(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vmm.shutdown");
  }

  /**
   * Inject a non-maskable interrupt (NMI)
   */
  async nmi(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vmm.nmi");
  }

  // ============================================
  // VM lifecycle operations
  // ============================================

  /**
   * Create a new VM (does not boot it)
   */
  async createVm(config: VmConfig): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.create", config);
  }

  /**
   * Boot the VM
   */
  async bootVm(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.boot");
  }

  /**
   * Pause the VM
   */
  async pauseVm(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.pause");
  }

  /**
   * Resume a paused VM
   */
  async resumeVm(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.resume");
  }

  /**
   * Shutdown the VM gracefully
   */
  async shutdownVm(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.shutdown");
  }

  /**
   * Reboot the VM
   */
  async rebootVm(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.reboot");
  }

  /**
   * Delete the VM
   */
  async deleteVm(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.delete");
  }

  /**
   * Press the power button (ACPI)
   */
  async powerButton(): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.power-button");
  }

  /**
   * Get VM information
   */
  async getVmInfo(): Promise<Result<VmInfo, CloudHypervisorApiError>> {
    return this.request<VmInfo>("GET", "/vm.info");
  }

  /**
   * Get VM counters/metrics
   */
  async getVmCounters(): Promise<Result<VmCounters, CloudHypervisorApiError>> {
    return this.request<VmCounters>("GET", "/vm.counters");
  }

  // ============================================
  // Dynamic resource management
  // ============================================

  /**
   * Resize VM (vCPUs, memory, balloon)
   */
  async resizeVm(resize: VmResize): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.resize", resize);
  }

  /**
   * Resize a disk
   */
  async resizeDisk(resize: VmResizeDisk): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.resize-disk", resize);
  }

  /**
   * Resize a memory zone
   */
  async resizeZone(resize: VmResizeZone): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.resize-zone", resize);
  }

  /**
   * Add a disk (hot-plug)
   */
  async addDisk(disk: DiskConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-disk", disk);
  }

  /**
   * Add a network interface (hot-plug)
   */
  async addNet(net: NetConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-net", net);
  }

  /**
   * Add a virtio-fs device
   */
  async addFs(fs: FsConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-fs", fs);
  }

  /**
   * Add a persistent memory device
   */
  async addPmem(pmem: PmemConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-pmem", pmem);
  }

  /**
   * Add a vsock device
   */
  async addVsock(vsock: VsockConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-vsock", vsock);
  }

  /**
   * Add a generic PCI device
   */
  async addDevice(device: DeviceConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-device", device);
  }

  /**
   * Add a userspace device
   */
  async addUserDevice(device: UserDeviceConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-user-device", device);
  }

  /**
   * Add a vDPA device
   */
  async addVdpa(vdpa: VdpaConfig): Promise<Result<PciDeviceInfo | void, CloudHypervisorApiError>> {
    return this.request<PciDeviceInfo | void>("PUT", "/vm.add-vdpa", vdpa);
  }

  /**
   * Remove a device by ID
   */
  async removeDevice(removal: DeviceRemoval): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.remove-device", removal);
  }

  // ============================================
  // State persistence (snapshots/migration)
  // ============================================

  /**
   * Create a snapshot of the VM
   */
  async createSnapshot(config: SnapshotConfig): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.snapshot", config);
  }

  /**
   * Create a core dump
   */
  async coredump(config: { destination_url: string }): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.coredump", config);
  }

  /**
   * Restore a VM from a snapshot
   */
  async restore(config: RestoreConfig): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.restore", config);
  }

  /**
   * Send migration to another host
   */
  async sendMigration(config: MigrationConfig): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.send-migration", config);
  }

  /**
   * Receive migration from another host
   */
  async receiveMigration(config: ReceiveMigrationConfig): Promise<Result<void, CloudHypervisorApiError>> {
    return this.request<void>("PUT", "/vm.receive-migration", config);
  }
}

// Re-export for backwards compatibility during migration
export { CloudHypervisorApiError } from "@hyperfleet/errors";
