/**
 * Low-level Firecracker API Client
 * Complete implementation based on Firecracker's OpenAPI specification
 */

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
  ): Promise<T> {
    const url = `unix://${this.socketPath}:${path}`;

    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new FirecrackerError(
        `Firecracker API error: ${response.status} - ${error}`,
        response.status,
        error
      );
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  // ==========================================================================
  // Instance Info
  // ==========================================================================

  async describeInstance(): Promise<InstanceInfo> {
    return this.request<InstanceInfo>("GET", "/");
  }

  async getExportVmConfig(): Promise<FullVmConfiguration> {
    return this.request<FullVmConfiguration>("GET", "/vm/config");
  }

  async getFirecrackerVersion(): Promise<FirecrackerVersion> {
    return this.request<FirecrackerVersion>("GET", "/version");
  }

  // ==========================================================================
  // Boot Source
  // ==========================================================================

  async putGuestBootSource(bootSource: BootSource): Promise<void> {
    await this.request("PUT", "/boot-source", bootSource);
  }

  // ==========================================================================
  // Machine Configuration
  // ==========================================================================

  async getMachineConfiguration(): Promise<MachineConfiguration> {
    return this.request<MachineConfiguration>("GET", "/machine-config");
  }

  async putMachineConfiguration(config: MachineConfiguration): Promise<void> {
    await this.request("PUT", "/machine-config", config);
  }

  async patchMachineConfiguration(
    config: Partial<MachineConfiguration>
  ): Promise<void> {
    await this.request("PATCH", "/machine-config", config);
  }

  // ==========================================================================
  // CPU Configuration
  // ==========================================================================

  async putCpuConfiguration(config: CpuConfig): Promise<void> {
    await this.request("PUT", "/cpu-config", config);
  }

  // ==========================================================================
  // Drives
  // ==========================================================================

  async putGuestDriveByID(drive: Drive): Promise<void> {
    await this.request("PUT", `/drives/${drive.drive_id}`, drive);
  }

  async patchGuestDriveByID(driveId: string, update: PartialDrive): Promise<void> {
    await this.request("PATCH", `/drives/${driveId}`, update);
  }

  // ==========================================================================
  // Persistent Memory (Pmem)
  // ==========================================================================

  async putGuestPmemByID(pmem: Pmem): Promise<void> {
    await this.request("PUT", `/pmem/${pmem.id}`, pmem);
  }

  // ==========================================================================
  // Network Interfaces
  // ==========================================================================

  async putGuestNetworkInterfaceByID(iface: NetworkInterface): Promise<void> {
    await this.request("PUT", `/network-interfaces/${iface.iface_id}`, iface);
  }

  async patchGuestNetworkInterfaceByID(
    ifaceId: string,
    update: PartialNetworkInterface
  ): Promise<void> {
    await this.request("PATCH", `/network-interfaces/${ifaceId}`, update);
  }

  // ==========================================================================
  // Vsock
  // ==========================================================================

  async putGuestVsock(vsock: Vsock): Promise<void> {
    await this.request("PUT", "/vsock", vsock);
  }

  // ==========================================================================
  // Balloon Device
  // ==========================================================================

  async describeBalloonConfig(): Promise<Balloon> {
    return this.request<Balloon>("GET", "/balloon");
  }

  async putBalloon(balloon: Balloon): Promise<void> {
    await this.request("PUT", "/balloon", balloon);
  }

  async patchBalloon(update: BalloonUpdate): Promise<void> {
    await this.request("PATCH", "/balloon", update);
  }

  async describeBalloonStats(): Promise<BalloonStats> {
    return this.request<BalloonStats>("GET", "/balloon/statistics");
  }

  async patchBalloonStatsInterval(update: BalloonStatsUpdate): Promise<void> {
    await this.request("PATCH", "/balloon/statistics", update);
  }

  async startBalloonHinting(cmd?: BalloonStartCmd): Promise<void> {
    await this.request("PATCH", "/balloon/hinting/start", cmd || {});
  }

  async describeBalloonHinting(): Promise<BalloonHintingStatus> {
    return this.request<BalloonHintingStatus>("GET", "/balloon/hinting/status");
  }

  async stopBalloonHinting(): Promise<void> {
    await this.request("PATCH", "/balloon/hinting/stop", {});
  }

  // ==========================================================================
  // Logger
  // ==========================================================================

  async putLogger(logger: Logger): Promise<void> {
    await this.request("PUT", "/logger", logger);
  }

  // ==========================================================================
  // Metrics
  // ==========================================================================

  async putMetrics(metrics: Metrics): Promise<void> {
    await this.request("PUT", "/metrics", metrics);
  }

  // ==========================================================================
  // Serial Device
  // ==========================================================================

  async putSerialDevice(serial: SerialDevice): Promise<void> {
    await this.request("PUT", "/serial", serial);
  }

  // ==========================================================================
  // Entropy Device
  // ==========================================================================

  async putEntropyDevice(device: EntropyDevice): Promise<void> {
    await this.request("PUT", "/entropy", device);
  }

  // ==========================================================================
  // MMDS (Microvm Metadata Service)
  // ==========================================================================

  async putMmdsConfig(config: MmdsConfig): Promise<void> {
    await this.request("PUT", "/mmds/config", config);
  }

  async getMmds(): Promise<MmdsContentsObject> {
    return this.request<MmdsContentsObject>("GET", "/mmds");
  }

  async putMmds(data: MmdsContentsObject): Promise<void> {
    await this.request("PUT", "/mmds", data);
  }

  async patchMmds(data: MmdsContentsObject): Promise<void> {
    await this.request("PATCH", "/mmds", data);
  }

  // ==========================================================================
  // Memory Hotplug
  // ==========================================================================

  async putMemoryHotplug(config: MemoryHotplugConfig): Promise<void> {
    await this.request("PUT", "/hotplug/memory", config);
  }

  async patchMemoryHotplug(update: MemoryHotplugSizeUpdate): Promise<void> {
    await this.request("PATCH", "/hotplug/memory", update);
  }

  async getMemoryHotplug(): Promise<MemoryHotplugStatus> {
    return this.request<MemoryHotplugStatus>("GET", "/hotplug/memory");
  }

  // ==========================================================================
  // Actions
  // ==========================================================================

  async createSyncAction(
    actionType: "InstanceStart" | "SendCtrlAltDel" | "FlushMetrics"
  ): Promise<void> {
    await this.request("PUT", "/actions", { action_type: actionType });
  }

  // ==========================================================================
  // VM State
  // ==========================================================================

  async patchVm(state: "Paused" | "Resumed"): Promise<void> {
    await this.request("PATCH", "/vm", { state });
  }

  // ==========================================================================
  // Snapshots
  // ==========================================================================

  async createSnapshot(params: SnapshotCreateParams): Promise<void> {
    await this.request("PUT", "/snapshot/create", params);
  }

  async loadSnapshot(params: SnapshotLoadParams): Promise<void> {
    await this.request("PUT", "/snapshot/load", params);
  }
}

export class FirecrackerError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody: string
  ) {
    super(message);
    this.name = "FirecrackerError";
  }
}
