/**
 * Firecracker API Models
 * Complete types based on Firecracker's OpenAPI specification
 */

// ============================================================================
// Boot & Machine Configuration
// ============================================================================

export interface BootSource {
  kernel_image_path: string;
  boot_args?: string;
  initrd_path?: string;
}

export interface MachineConfiguration {
  vcpu_count: number;
  mem_size_mib: number;
  smt?: boolean;
  cpu_template?: CpuTemplate;
  track_dirty_pages?: boolean;
  huge_pages?: "None" | "2M";
}

export type CpuTemplate = "C3" | "T2" | "T2S" | "T2CL" | "T2A" | "V1N1" | "None";

// ============================================================================
// CPU Configuration (Advanced)
// ============================================================================

export interface CpuConfig {
  kvm_capabilities?: string[];
  cpuid_modifiers?: CpuidLeafModifier[];
  msr_modifiers?: MsrModifier[];
  reg_modifiers?: ArmRegisterModifier[];
  vcpu_features?: VcpuFeatures[];
}

export interface CpuidLeafModifier {
  leaf: string;
  subleaf: string;
  flags: number;
  modifiers: CpuidRegisterModifier[];
}

export interface CpuidRegisterModifier {
  register: "eax" | "ebx" | "ecx" | "edx";
  bitmap: string;
}

export interface MsrModifier {
  addr: string;
  bitmap: string;
}

export interface ArmRegisterModifier {
  addr: string;
  bitmap: string;
}

export interface VcpuFeatures {
  index: number;
  bitmap: string;
}

// ============================================================================
// Storage Devices
// ============================================================================

export interface Drive {
  drive_id: string;
  path_on_host?: string;
  socket?: string;
  is_root_device: boolean;
  is_read_only?: boolean;
  partuuid?: string;
  cache_type?: "Unsafe" | "Writeback";
  io_engine?: "Sync" | "Async";
  rate_limiter?: RateLimiter;
}

export interface PartialDrive {
  drive_id: string;
  path_on_host?: string;
  rate_limiter?: RateLimiter;
}

export interface Pmem {
  id: string;
  path_on_host: string;
  root_device?: boolean;
  read_only?: boolean;
}

// ============================================================================
// Network
// ============================================================================

export interface NetworkInterface {
  iface_id: string;
  host_dev_name: string;
  guest_mac?: string;
  rx_rate_limiter?: RateLimiter;
  tx_rate_limiter?: RateLimiter;
}

export interface PartialNetworkInterface {
  iface_id: string;
  rx_rate_limiter?: RateLimiter;
  tx_rate_limiter?: RateLimiter;
}

// ============================================================================
// Rate Limiting
// ============================================================================

export interface RateLimiter {
  bandwidth?: TokenBucket;
  ops?: TokenBucket;
}

export interface TokenBucket {
  size: number;
  one_time_burst?: number;
  refill_time: number;
}

// ============================================================================
// Vsock
// ============================================================================

export interface Vsock {
  guest_cid: number;
  uds_path: string;
  /** @deprecated */
  vsock_id?: string;
}

// ============================================================================
// Balloon Device
// ============================================================================

export interface Balloon {
  amount_mib: number;
  deflate_on_oom: boolean;
  stats_polling_interval_s?: number;
  free_page_hinting?: boolean;
  free_page_reporting?: boolean;
}

export interface BalloonUpdate {
  amount_mib: number;
}

export interface BalloonStats {
  target_pages: number;
  actual_pages: number;
  target_mib: number;
  actual_mib: number;
  swap_in?: number;
  swap_out?: number;
  major_faults?: number;
  minor_faults?: number;
  free_memory?: number;
  total_memory?: number;
  available_memory?: number;
  disk_caches?: number;
  hugetlb_allocations?: number;
  hugetlb_failures?: number;
  oom_kill?: number;
  alloc_stall?: number;
  async_scan?: number;
  direct_scan?: number;
  async_reclaim?: number;
  direct_reclaim?: number;
}

export interface BalloonStatsUpdate {
  stats_polling_interval_s: number;
}

export interface BalloonStartCmd {
  acknowledge_on_stop?: boolean;
}

export interface BalloonHintingStatus {
  host_cmd: number;
  guest_cmd?: number;
}

// ============================================================================
// Memory Hotplug
// ============================================================================

export interface MemoryHotplugConfig {
  total_size_mib?: number;
  slot_size_mib?: number;
  block_size_mib?: number;
}

export interface MemoryHotplugSizeUpdate {
  requested_size_mib?: number;
}

export interface MemoryHotplugStatus {
  total_size_mib?: number;
  slot_size_mib?: number;
  block_size_mib?: number;
  plugged_size_mib?: number;
  requested_size_mib?: number;
}

// ============================================================================
// Logging & Metrics
// ============================================================================

export interface Logger {
  log_path?: string;
  level?: "Error" | "Warning" | "Info" | "Debug" | "Trace" | "Off";
  show_level?: boolean;
  show_log_origin?: boolean;
  module?: string;
}

export interface Metrics {
  metrics_path: string;
}

// ============================================================================
// Serial Device
// ============================================================================

export interface SerialDevice {
  serial_out_path?: string;
}

// ============================================================================
// Entropy Device
// ============================================================================

export interface EntropyDevice {
  rate_limiter?: RateLimiter;
}

// ============================================================================
// MMDS (Microvm Metadata Service)
// ============================================================================

export interface MmdsConfig {
  network_interfaces: string[];
  version?: "V1" | "V2";
  ipv4_address?: string;
  imds_compat?: boolean;
}

export type MmdsContentsObject = Record<string, unknown>;

// ============================================================================
// Snapshots
// ============================================================================

export interface SnapshotCreateParams {
  snapshot_path: string;
  mem_file_path: string;
  snapshot_type?: "Full" | "Diff";
}

export interface SnapshotLoadParams {
  snapshot_path: string;
  mem_file_path?: string;
  mem_backend?: MemoryBackend;
  track_dirty_pages?: boolean;
  resume_vm?: boolean;
  network_overrides?: NetworkOverride[];
}

export interface MemoryBackend {
  backend_type: "File" | "Uffd";
  backend_path: string;
}

export interface NetworkOverride {
  iface_id: string;
  host_dev_name: string;
}

// ============================================================================
// VM State & Actions
// ============================================================================

export interface Vm {
  state: "Paused" | "Resumed";
}

export interface InstanceActionInfo {
  action_type: "InstanceStart" | "SendCtrlAltDel" | "FlushMetrics";
}

export interface InstanceInfo {
  id: string;
  state: "Not started" | "Running" | "Paused";
  vmm_version: string;
  app_name: string;
}

export interface FirecrackerVersion {
  firecracker_version: string;
}

// ============================================================================
// Full VM Configuration
// ============================================================================

export interface FullVmConfiguration {
  balloon?: Balloon;
  "boot-source"?: BootSource;
  "cpu-config"?: CpuConfig;
  entropy?: EntropyDevice;
  logger?: Logger;
  "machine-config"?: MachineConfiguration;
  metrics?: Metrics;
  "mmds-config"?: MmdsConfig;
  vsock?: Vsock;
  drives?: Drive[];
  "network-interfaces"?: NetworkInterface[];
  pmem?: Pmem[];
  "memory-hotplug"?: MemoryHotplugConfig;
}

// ============================================================================
// Error
// ============================================================================

export interface FirecrackerApiError {
  fault_message: string;
}
