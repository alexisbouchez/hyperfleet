/**
 * Jailer configuration for Firecracker isolation
 */

export interface JailerConfig {
  /** User ID for the jailer process */
  uid: number;
  /** Group ID for the jailer process */
  gid: number;
  /** Unique VM identifier (alphanumeric, max 64 chars) */
  id: string;
  /** NUMA node to pin the VM to */
  numaNode?: number;
  /** Path to the firecracker binary */
  firecrackerBinary?: string;
  /** Path to the jailer binary */
  jailerBinary?: string;
  /** Base path for chroot (default: /srv/jailer) */
  chrootBaseDir?: string;
  /** Network namespace path */
  netnsPath?: string;
  /** Cgroup version (1 or 2) */
  cgroupVersion?: 1 | 2;
  /** Whether to daemonize the process */
  daemonize?: boolean;
}

export interface JailerCommandOptions {
  config: JailerConfig;
  socketPath: string;
}

/**
 * Build jailer command arguments
 */
export function buildJailerArgs(options: JailerCommandOptions): string[] {
  const { config, socketPath } = options;
  const args: string[] = [];

  args.push("--id", config.id);
  args.push("--uid", String(config.uid));
  args.push("--gid", String(config.gid));
  args.push("--exec-file", config.firecrackerBinary || "/usr/local/bin/firecracker");

  if (config.chrootBaseDir) {
    args.push("--chroot-base-dir", config.chrootBaseDir);
  }

  if (config.numaNode !== undefined) {
    args.push("--node", String(config.numaNode));
  }

  if (config.netnsPath) {
    args.push("--netns", config.netnsPath);
  }

  if (config.cgroupVersion) {
    args.push("--cgroup-version", String(config.cgroupVersion));
  }

  if (config.daemonize) {
    args.push("--daemonize");
  }

  // Add firecracker arguments after --
  args.push("--");
  args.push("--api-sock", socketPath);

  return args;
}

/**
 * Get the chroot path for a jailed VM
 */
export function getJailerChrootPath(config: JailerConfig): string {
  const baseDir = config.chrootBaseDir || "/srv/jailer";
  const binary = config.firecrackerBinary || "firecracker";
  const binaryName = binary.split("/").pop() || "firecracker";
  return `${baseDir}/${binaryName}/${config.id}/root`;
}

/**
 * Files that need to be linked into the jail
 */
export interface JailFile {
  /** Source path on host */
  src: string;
  /** Destination path relative to chroot */
  dst: string;
}

/**
 * Get the list of files that need to be linked into the jail
 */
export function getJailFiles(
  chrootPath: string,
  kernelPath: string,
  rootfsPath: string,
  additionalDrives: string[] = []
): JailFile[] {
  const files: JailFile[] = [
    { src: kernelPath, dst: `${chrootPath}/kernel` },
    { src: rootfsPath, dst: `${chrootPath}/rootfs.ext4` },
  ];

  for (let i = 0; i < additionalDrives.length; i++) {
    files.push({
      src: additionalDrives[i],
      dst: `${chrootPath}/drive${i + 1}.ext4`,
    });
  }

  return files;
}
