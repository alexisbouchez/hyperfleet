/**
 * Cloud Hypervisor API models
 * Based on the OpenAPI specification from cloud-hypervisor
 */

/**
 * Token bucket for rate limiting
 */
export interface TokenBucket {
  /** Size of the token bucket */
  size: number;
  /** Time to refill one token in milliseconds */
  one_time_burst?: number;
  /** Refill time in milliseconds */
  refill_time: number;
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  /** Bandwidth rate limiter */
  bandwidth?: TokenBucket;
  /** Operations per second rate limiter */
  ops?: TokenBucket;
}

/**
 * CPU topology configuration
 */
export interface CpuTopology {
  threads_per_core?: number;
  cores_per_die?: number;
  dies_per_package?: number;
  packages?: number;
}

/**
 * CPU affinity configuration
 */
export interface CpuAffinity {
  vcpu: number;
  host_cpus: number[];
}

/**
 * CPU features configuration
 */
export interface CpuFeatures {
  amx?: boolean;
}

/**
 * CPUs configuration
 */
export interface CpusConfig {
  /** Number of boot vCPUs */
  boot_vcpus: number;
  /** Maximum number of vCPUs */
  max_vcpus: number;
  /** CPU topology */
  topology?: CpuTopology;
  /** Enable KVM Hyper-V emulation */
  kvm_hyperv?: boolean;
  /** Maximum physical address bits */
  max_phys_bits?: number;
  /** CPU affinity settings */
  affinity?: CpuAffinity[];
  /** CPU features */
  features?: CpuFeatures;
}

/**
 * Memory zone configuration
 */
export interface MemoryZoneConfig {
  id: string;
  size: number;
  file?: string;
  mergeable?: boolean;
  shared?: boolean;
  hugepages?: boolean;
  hugepage_size?: number;
  host_numa_node?: number;
  hotplug_size?: number;
  hotplugged_size?: number;
  prefault?: boolean;
}

/**
 * Memory configuration
 */
export interface MemoryConfig {
  /** Memory size in bytes */
  size: number;
  /** Enable memory merging */
  mergeable?: boolean;
  /** Enable huge pages */
  hugepages?: boolean;
  /** Huge page size */
  hugepage_size?: number;
  /** Hotplug size in bytes */
  hotplug_size?: number;
  /** Hotplugged memory size */
  hotplugged_size?: number;
  /** Enable shared memory */
  shared?: boolean;
  /** Enable memory prefaulting */
  prefault?: boolean;
  /** Enable memory ballooning */
  balloon?: boolean;
  /** Initial balloon size */
  balloon_size?: number;
  /** Memory zones */
  zones?: MemoryZoneConfig[];
  /** Enable thp (transparent huge pages) */
  thp?: boolean;
}

/**
 * Payload configuration (kernel/firmware)
 */
export interface PayloadConfig {
  /** Path to firmware image */
  firmware?: string;
  /** Path to kernel image */
  kernel?: string;
  /** Kernel command line */
  cmdline?: string;
  /** Path to initramfs */
  initramfs?: string;
}

/**
 * Disk configuration
 */
export interface DiskConfig {
  /** Disk path */
  path?: string;
  /** Read-only disk */
  readonly?: boolean;
  /** Use direct I/O */
  direct?: boolean;
  /** Enable IOMMU */
  iommu?: boolean;
  /** Number of queues */
  num_queues?: number;
  /** Queue size */
  queue_size?: number;
  /** vhost-user socket path */
  vhost_user?: boolean;
  /** vhost-user socket */
  socket?: string;
  /** Rate limiter */
  rate_limiter_config?: RateLimiterConfig;
  /** PCI segment */
  pci_segment?: number;
  /** Device ID */
  id?: string;
  /** Disable I/O */
  disable_io_uring?: boolean;
  /** Disable AIO */
  disable_aio?: boolean;
  /** Serial string */
  serial?: string;
}

/**
 * Network configuration
 */
export interface NetConfig {
  /** TAP interface name */
  tap?: string;
  /** IP address */
  ip?: string;
  /** Network mask */
  mask?: string;
  /** MAC address */
  mac?: string;
  /** Host MAC address */
  host_mac?: string;
  /** MTU */
  mtu?: number;
  /** Enable IOMMU */
  iommu?: boolean;
  /** Number of queues */
  num_queues?: number;
  /** Queue size */
  queue_size?: number;
  /** vhost-user support */
  vhost_user?: boolean;
  /** vhost-user socket */
  socket?: string;
  /** vhost mode */
  vhost_mode?: "client" | "server";
  /** Device ID */
  id?: string;
  /** PCI segment */
  pci_segment?: number;
  /** Rate limiter for received traffic */
  rate_limiter_config?: RateLimiterConfig;
  /** Enable offloading */
  offload_tso?: boolean;
  offload_ufo?: boolean;
  offload_csum?: boolean;
}

/**
 * virtio-fs configuration
 */
export interface FsConfig {
  /** Tag for mounting */
  tag: string;
  /** Socket path */
  socket: string;
  /** Number of queues */
  num_queues?: number;
  /** Queue size */
  queue_size?: number;
  /** PCI segment */
  pci_segment?: number;
  /** Device ID */
  id?: string;
}

/**
 * Persistent memory configuration
 */
export interface PmemConfig {
  /** File path */
  file: string;
  /** Size in bytes */
  size?: number;
  /** Enable IOMMU */
  iommu?: boolean;
  /** Discard writes */
  discard_writes?: boolean;
  /** PCI segment */
  pci_segment?: number;
  /** Device ID */
  id?: string;
}

/**
 * Console configuration
 */
export interface ConsoleConfig {
  /** Console file path */
  file?: string;
  /** Console mode */
  mode: "Off" | "Pty" | "Tty" | "File" | "Socket" | "Null";
  /** Enable IOMMU */
  iommu?: boolean;
  /** Socket path for Socket mode */
  socket?: string;
}

/**
 * Serial configuration
 */
export interface SerialConfig {
  /** Serial file path */
  file?: string;
  /** Serial mode */
  mode: "Off" | "Pty" | "Tty" | "File" | "Socket" | "Null";
  /** Socket path for Socket mode */
  socket?: string;
}

/**
 * Device configuration
 */
export interface DeviceConfig {
  /** Device path */
  path: string;
  /** Enable IOMMU */
  iommu?: boolean;
  /** PCI segment */
  pci_segment?: number;
  /** Device ID */
  id?: string;
  /** X-ndrv flag */
  x_ndrv?: boolean;
}

/**
 * User device configuration
 */
export interface UserDeviceConfig {
  /** Socket path */
  socket: string;
  /** PCI segment */
  pci_segment?: number;
  /** Device ID */
  id?: string;
}

/**
 * vDPA device configuration
 */
export interface VdpaConfig {
  /** vDPA device path */
  path: string;
  /** Number of queues */
  num_queues?: number;
  /** Enable IOMMU */
  iommu?: boolean;
  /** PCI segment */
  pci_segment?: number;
  /** Device ID */
  id?: string;
}

/**
 * Vsock configuration
 */
export interface VsockConfig {
  /** Context ID (CID) */
  cid: number;
  /** Unix socket path */
  socket: string;
  /** Enable IOMMU */
  iommu?: boolean;
  /** PCI segment */
  pci_segment?: number;
  /** Device ID */
  id?: string;
}

/**
 * Balloon configuration
 */
export interface BalloonConfig {
  /** Balloon size in bytes */
  size: number;
  /** Deflate on OOM */
  deflate_on_oom?: boolean;
  /** Free page reporting */
  free_page_reporting?: boolean;
}

/**
 * RNG (random number generator) configuration
 */
export interface RngConfig {
  /** Source path */
  src: string;
  /** Enable IOMMU */
  iommu?: boolean;
}

/**
 * SGX EPC section configuration
 */
export interface SgxEpcConfig {
  /** Section ID */
  id: string;
  /** Size in bytes */
  size: number;
  /** Prefault memory */
  prefault?: boolean;
}

/**
 * NUMA configuration
 */
export interface NumaConfig {
  /** Guest NUMA node ID */
  guest_numa_id: number;
  /** vCPUs in this node */
  cpus?: number[];
  /** Distances to other nodes */
  distances?: { destination: number; distance: number }[];
  /** Memory zones */
  memory_zones?: string[];
  /** SGX EPC sections */
  sgx_epc_sections?: string[];
  /** PCI segments */
  pci_segments?: number[];
}

/**
 * PCI segment configuration
 */
export interface PciSegmentConfig {
  /** PCI segment ID */
  pci_segment: number;
  /** MMIO aperture weight */
  mmio_aperture_weight?: number;
}

/**
 * Platform configuration
 */
export interface PlatformConfig {
  /** Number of PCI segments */
  num_pci_segments?: number;
  /** IOMMU segments */
  iommu_segments?: number[];
  /** Serial number */
  serial_number?: string;
  /** UUID */
  uuid?: string;
  /** OEM strings */
  oem_strings?: string[];
  /** TDX enabled */
  tdx?: boolean;
  /** SEV enabled */
  sev?: boolean;
}

/**
 * TPM configuration
 */
export interface TpmConfig {
  /** TPM socket path */
  socket: string;
}

/**
 * Landlock configuration
 */
export interface LandlockConfig {
  /** Paths to allow */
  paths?: { path: string; access: string[] }[];
  /** Enable Landlock */
  enable?: boolean;
}

/**
 * Complete VM configuration
 */
export interface VmConfig {
  /** CPUs configuration */
  cpus?: CpusConfig;
  /** Memory configuration */
  memory?: MemoryConfig;
  /** Payload (kernel/firmware) configuration */
  payload?: PayloadConfig;
  /** Disk configurations */
  disks?: DiskConfig[];
  /** Network configurations */
  net?: NetConfig[];
  /** Random number generator configuration */
  rng?: RngConfig;
  /** Balloon configuration */
  balloon?: BalloonConfig;
  /** Virtio-fs configurations */
  fs?: FsConfig[];
  /** Persistent memory configurations */
  pmem?: PmemConfig[];
  /** Serial console configuration */
  serial?: SerialConfig;
  /** Console configuration */
  console?: ConsoleConfig;
  /** PCI device configurations */
  devices?: DeviceConfig[];
  /** User device configurations */
  user_devices?: UserDeviceConfig[];
  /** vDPA device configurations */
  vdpa?: VdpaConfig[];
  /** Vsock configuration */
  vsock?: VsockConfig;
  /** Platform configuration */
  platform?: PlatformConfig;
  /** NUMA configurations */
  numa?: NumaConfig[];
  /** PCI segment configurations */
  pci_segments?: PciSegmentConfig[];
  /** SGX EPC configurations */
  sgx_epc?: SgxEpcConfig[];
  /** TPM configuration */
  tpm?: TpmConfig;
  /** Preserve FDs */
  preserve_fds?: number[];
  /** Landlock configuration */
  landlock_config?: LandlockConfig;
  /** Watchdog */
  watchdog?: boolean;
  /** PVPanic device */
  pvpanic?: boolean;
}

/**
 * VM state
 */
export type VmState =
  | "Created"
  | "Running"
  | "Shutdown"
  | "Paused"
  | "BreakPoint";

/**
 * VM information
 */
export interface VmInfo {
  /** VM configuration */
  config: VmConfig;
  /** VM state */
  state: VmState;
  /** Memory actual size */
  memory_actual_size?: number;
  /** Device tree */
  device_tree?: Record<string, { id: string; resources?: unknown[] }>;
}

/**
 * VMM ping response
 */
export interface VmmPingResponse {
  /** API version */
  version: string;
  /** Build version */
  build_version?: string;
  /** Process ID */
  pid?: number;
  /** Enabled features */
  features?: string[];
}

/**
 * VM resize request
 */
export interface VmResize {
  /** New vCPU count */
  desired_vcpus?: number;
  /** New memory size in bytes */
  desired_ram?: number;
  /** New balloon size in bytes */
  desired_balloon?: number;
}

/**
 * VM resize disk request
 */
export interface VmResizeDisk {
  /** Disk ID */
  id: string;
  /** New size in bytes */
  new_size: number;
}

/**
 * VM resize zone request
 */
export interface VmResizeZone {
  /** Zone ID */
  id: string;
  /** New size in bytes */
  desired_ram: number;
}

/**
 * Snapshot configuration
 */
export interface SnapshotConfig {
  /** Destination URL */
  destination_url: string;
}

/**
 * Restore configuration
 */
export interface RestoreConfig {
  /** Source URL */
  source_url: string;
  /** Prefault memory */
  prefault?: boolean;
}

/**
 * Migration configuration
 */
export interface MigrationConfig {
  /** Destination URL */
  destination_url: string;
  /** Enable local migration */
  local?: boolean;
}

/**
 * Receive migration configuration
 */
export interface ReceiveMigrationConfig {
  /** Receiver URL */
  receiver_url: string;
}

/**
 * Device removal request
 */
export interface DeviceRemoval {
  /** Device ID */
  id: string;
}

/**
 * PCI device info (returned from add operations)
 */
export interface PciDeviceInfo {
  /** Device ID */
  id: string;
  /** BDF (Bus:Device.Function) */
  bdf: string;
}

/**
 * VM counters
 */
export interface VmCounters {
  [key: string]: {
    [key: string]: number;
  };
}
