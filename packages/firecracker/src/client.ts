/**
 * Low-level Firecracker API Client
 * Complete implementation based on Firecracker's OpenAPI specification
 */

import { Result } from "better-result";
import { FirecrackerApiError } from "@hyperfleet/errors";
import type {
  BootSource,
  Drive,
  PartialDrive,
  MachineConfiguration,
  NetworkInterface,
  PartialNetworkInterface,
  Vsock,
  Balloon,
  BalloonUpdate,
  BalloonStats,
  BalloonStatsUpdate,
  BalloonStartCmd,
  BalloonHintingStatus,
  Logger,
  Metrics,
  MmdsConfig,
  MmdsContentsObject,
  SnapshotCreateParams,
  SnapshotLoadParams,
  InstanceInfo,
  FullVmConfiguration,
  EntropyDevice,
  SerialDevice,
  CpuConfig,
  Pmem,
  MemoryHotplugConfig,
  MemoryHotplugSizeUpdate,
  MemoryHotplugStatus,
  FirecrackerVersion,
} from "./models";

export interface FirecrackerClientConfig {
  socketPath: string;
}

export class FirecrackerClient {
  readonly socketPath: string;

  constructor(config: FirecrackerClientConfig) {
    this.socketPath = config.socketPath;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Result<T, FirecrackerApiError>> {
    return Result.tryPromise({
      try: async () => {
        const url = `unix://${this.socketPath}:${path}`;

        const response = await fetch(url, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new FirecrackerApiError({
            message: `Firecracker API error: ${response.status} - ${errorBody}`,
            statusCode: response.status,
            responseBody: errorBody,
          });
        }

        const text = await response.text();
        return text ? JSON.parse(text) : ({} as T);
      },
      catch: (cause) => {
        if (FirecrackerApiError.is(cause)) {
          return cause;
        }
        return new FirecrackerApiError({
          message: cause instanceof Error ? cause.message : String(cause),
          statusCode: 0,
          responseBody: "",
        });
      },
    });
  }

  // ==========================================================================
  // Instance Info
  // ==========================================================================

  async describeInstance(): Promise<Result<InstanceInfo, FirecrackerApiError>> {
    return this.request<InstanceInfo>("GET", "/");
  }

  async getExportVmConfig(): Promise<Result<FullVmConfiguration, FirecrackerApiError>> {
    return this.request<FullVmConfiguration>("GET", "/vm/config");
  }

  async getFirecrackerVersion(): Promise<Result<FirecrackerVersion, FirecrackerApiError>> {
    return this.request<FirecrackerVersion>("GET", "/version");
  }

  // ==========================================================================
  // Boot Source
  // ==========================================================================

  async putGuestBootSource(bootSource: BootSource): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/boot-source", bootSource);
  }

  // ==========================================================================
  // Machine Configuration
  // ==========================================================================

  async getMachineConfiguration(): Promise<Result<MachineConfiguration, FirecrackerApiError>> {
    return this.request<MachineConfiguration>("GET", "/machine-config");
  }

  async putMachineConfiguration(config: MachineConfiguration): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/machine-config", config);
  }

  async patchMachineConfiguration(
    config: Partial<MachineConfiguration>
  ): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/machine-config", config);
  }

  // ==========================================================================
  // CPU Configuration
  // ==========================================================================

  async putCpuConfiguration(config: CpuConfig): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/cpu-config", config);
  }

  // ==========================================================================
  // Drives
  // ==========================================================================

  async putGuestDriveByID(drive: Drive): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", `/drives/${drive.drive_id}`, drive);
  }

  async patchGuestDriveByID(driveId: string, update: PartialDrive): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", `/drives/${driveId}`, update);
  }

  // ==========================================================================
  // Persistent Memory (Pmem)
  // ==========================================================================

  async putGuestPmemByID(pmem: Pmem): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", `/pmem/${pmem.id}`, pmem);
  }

  // ==========================================================================
  // Network Interfaces
  // ==========================================================================

  async putGuestNetworkInterfaceByID(iface: NetworkInterface): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", `/network-interfaces/${iface.iface_id}`, iface);
  }

  async patchGuestNetworkInterfaceByID(
    ifaceId: string,
    update: PartialNetworkInterface
  ): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", `/network-interfaces/${ifaceId}`, update);
  }

  // ==========================================================================
  // Vsock
  // ==========================================================================

  async putGuestVsock(vsock: Vsock): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/vsock", vsock);
  }

  // ==========================================================================
  // Balloon Device
  // ==========================================================================

  async describeBalloonConfig(): Promise<Result<Balloon, FirecrackerApiError>> {
    return this.request<Balloon>("GET", "/balloon");
  }

  async putBalloon(balloon: Balloon): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/balloon", balloon);
  }

  async patchBalloon(update: BalloonUpdate): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/balloon", update);
  }

  async describeBalloonStats(): Promise<Result<BalloonStats, FirecrackerApiError>> {
    return this.request<BalloonStats>("GET", "/balloon/statistics");
  }

  async patchBalloonStatsInterval(update: BalloonStatsUpdate): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/balloon/statistics", update);
  }

  async startBalloonHinting(cmd?: BalloonStartCmd): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/balloon/hinting/start", cmd || {});
  }

  async describeBalloonHinting(): Promise<Result<BalloonHintingStatus, FirecrackerApiError>> {
    return this.request<BalloonHintingStatus>("GET", "/balloon/hinting/status");
  }

  async stopBalloonHinting(): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/balloon/hinting/stop", {});
  }

  // ==========================================================================
  // Logger
  // ==========================================================================

  async putLogger(logger: Logger): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/logger", logger);
  }

  // ==========================================================================
  // Metrics
  // ==========================================================================

  async putMetrics(metrics: Metrics): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/metrics", metrics);
  }

  // ==========================================================================
  // Serial Device
  // ==========================================================================

  async putSerialDevice(serial: SerialDevice): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/serial", serial);
  }

  // ==========================================================================
  // Entropy Device
  // ==========================================================================

  async putEntropyDevice(device: EntropyDevice): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/entropy", device);
  }

  // ==========================================================================
  // MMDS (Microvm Metadata Service)
  // ==========================================================================

  async putMmdsConfig(config: MmdsConfig): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/mmds/config", config);
  }

  async getMmds(): Promise<Result<MmdsContentsObject, FirecrackerApiError>> {
    return this.request<MmdsContentsObject>("GET", "/mmds");
  }

  async putMmds(data: MmdsContentsObject): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/mmds", data);
  }

  async patchMmds(data: MmdsContentsObject): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/mmds", data);
  }

  // ==========================================================================
  // Memory Hotplug
  // ==========================================================================

  async putMemoryHotplug(config: MemoryHotplugConfig): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/hotplug/memory", config);
  }

  async patchMemoryHotplug(update: MemoryHotplugSizeUpdate): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/hotplug/memory", update);
  }

  async getMemoryHotplug(): Promise<Result<MemoryHotplugStatus, FirecrackerApiError>> {
    return this.request<MemoryHotplugStatus>("GET", "/hotplug/memory");
  }

  // ==========================================================================
  // Actions
  // ==========================================================================

  async createSyncAction(
    actionType: "InstanceStart" | "SendCtrlAltDel" | "FlushMetrics"
  ): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/actions", { action_type: actionType });
  }

  // ==========================================================================
  // VM State
  // ==========================================================================

  async patchVm(state: "Paused" | "Resumed"): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PATCH", "/vm", { state });
  }

  // ==========================================================================
  // Snapshots
  // ==========================================================================

  async createSnapshot(params: SnapshotCreateParams): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/snapshot/create", params);
  }

  async loadSnapshot(params: SnapshotLoadParams): Promise<Result<void, FirecrackerApiError>> {
    return this.request<void>("PUT", "/snapshot/load", params);
  }
}

// Re-export for backwards compatibility during migration
export { FirecrackerApiError } from "@hyperfleet/errors";
