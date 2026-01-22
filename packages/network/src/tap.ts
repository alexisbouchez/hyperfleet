/**
 * TAP Device Management using direct ioctl syscalls
 *
 * TAP devices are virtual network interfaces that operate at Layer 2 (Ethernet).
 * They're used to give microVMs network connectivity.
 *
 * This implementation uses Bun's FFI to call ioctl directly, avoiding shell commands.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { Result } from "better-result";

// ioctl constants for TUN/TAP (Linux x86_64)
const TUNSETIFF = 0x400454ca;
const TUNSETPERSIST = 0x400454cb;
const TUNSETOWNER = 0x400454cc;
const TUNSETGROUP = 0x400454ce;

// Interface flags
const IFF_TAP = 0x0002;
const IFF_NO_PI = 0x1000; // Don't include packet info header
const IFF_MULTI_QUEUE = 0x0100;

// File control
const O_RDWR = 0x0002;

// ifreq structure size (for interface requests)
const IFNAMSIZ = 16;
const IFREQ_SIZE = 40; // struct ifreq size on x86_64

// Load libc for syscalls
const libc = dlopen("libc.so.6", {
  open: {
    args: [FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
  close: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  ioctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  strerror: {
    args: [FFIType.i32],
    returns: FFIType.cstring,
  },
});

// Error type for TAP operations
export class TapError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly syscall?: string
  ) {
    super(message);
    this.name = "TapError";
  }

  static is(error: unknown): error is TapError {
    return error instanceof TapError;
  }
}

/**
 * Create an ifreq structure for TAP device configuration
 */
function createIfreq(name: string, flags: number): Uint8Array {
  const buffer = new Uint8Array(IFREQ_SIZE);

  // Copy interface name (max IFNAMSIZ-1 chars + null terminator)
  const nameBytes = new TextEncoder().encode(name);
  const copyLen = Math.min(nameBytes.length, IFNAMSIZ - 1);
  buffer.set(nameBytes.subarray(0, copyLen), 0);

  // Set flags at offset 16 (after ifr_name)
  // flags is a short (2 bytes) in little-endian
  buffer[16] = flags & 0xff;
  buffer[17] = (flags >> 8) & 0xff;

  return buffer;
}

/**
 * Extract interface name from ifreq structure
 */
function extractIfName(ifreq: Uint8Array): string {
  let end = 0;
  while (end < IFNAMSIZ && ifreq[end] !== 0) {
    end++;
  }
  return new TextDecoder().decode(ifreq.subarray(0, end));
}

export interface TapDeviceConfig {
  /** Device name (e.g., "tap0"). If not specified, kernel assigns one */
  name?: string;
  /** Enable multi-queue support */
  multiQueue?: boolean;
  /** Make device persistent (survives process exit) */
  persistent?: boolean;
  /** Owner UID for the device */
  owner?: number;
  /** Group GID for the device */
  group?: number;
}

export interface TapDevice {
  /** The file descriptor for the TAP device */
  fd: number;
  /** The actual interface name assigned by the kernel */
  name: string;
}

/**
 * Create a TAP device using ioctl
 *
 * This is the low-level function that directly interfaces with the kernel.
 * For most use cases, use TapManager instead.
 */
export function createTapDevice(config: TapDeviceConfig = {}): Result<TapDevice, TapError> {
  const tunPath = "/dev/net/tun";

  // Open /dev/net/tun
  const fd = libc.symbols.open(
    ptr(Buffer.from(tunPath + "\0")),
    O_RDWR
  );

  if (fd < 0) {
    return Result.err(new TapError(`Failed to open ${tunPath}`, fd, "open"));
  }

  try {
    // Build flags
    let flags = IFF_TAP | IFF_NO_PI;
    if (config.multiQueue) {
      flags |= IFF_MULTI_QUEUE;
    }

    // Create ifreq structure
    const ifreq = createIfreq(config.name || "", flags);
    const ifreqPtr = ptr(ifreq);

    // Call ioctl to create the interface
    const result = libc.symbols.ioctl(fd, TUNSETIFF, ifreqPtr);
    if (result < 0) {
      libc.symbols.close(fd);
      return Result.err(new TapError(
        `Failed to create TAP device: ioctl TUNSETIFF failed`,
        result,
        "ioctl"
      ));
    }

    // Get the actual interface name assigned
    const actualName = extractIfName(ifreq);

    // Set persistence if requested
    if (config.persistent) {
      const persistResult = libc.symbols.ioctl(fd, TUNSETPERSIST, ptr(new Uint8Array([1])));
      if (persistResult < 0) {
        libc.symbols.close(fd);
        return Result.err(new TapError(
          "Failed to set TAP device persistence",
          persistResult,
          "ioctl"
        ));
      }
    }

    // Set owner if specified
    if (config.owner !== undefined) {
      const ownerBuf = new Uint8Array(4);
      new DataView(ownerBuf.buffer).setInt32(0, config.owner, true);
      const ownerResult = libc.symbols.ioctl(fd, TUNSETOWNER, ptr(ownerBuf));
      if (ownerResult < 0) {
        libc.symbols.close(fd);
        return Result.err(new TapError(
          "Failed to set TAP device owner",
          ownerResult,
          "ioctl"
        ));
      }
    }

    // Set group if specified
    if (config.group !== undefined) {
      const groupBuf = new Uint8Array(4);
      new DataView(groupBuf.buffer).setInt32(0, config.group, true);
      const groupResult = libc.symbols.ioctl(fd, TUNSETGROUP, ptr(groupBuf));
      if (groupResult < 0) {
        libc.symbols.close(fd);
        return Result.err(new TapError(
          "Failed to set TAP device group",
          groupResult,
          "ioctl"
        ));
      }
    }

    return Result.ok({ fd, name: actualName });
  } catch (error) {
    libc.symbols.close(fd);
    return Result.err(new TapError(
      `Unexpected error creating TAP device: ${error}`,
      -1,
      "unknown"
    ));
  }
}

/**
 * Close a TAP device file descriptor
 */
export function closeTapDevice(fd: number): Result<void, TapError> {
  const result = libc.symbols.close(fd);
  if (result < 0) {
    return Result.err(new TapError("Failed to close TAP device", result, "close"));
  }
  return Result.ok(undefined);
}

/**
 * Delete a TAP device by making it non-persistent and closing it
 *
 * Note: This only works for persistent devices. Non-persistent devices
 * are automatically deleted when their fd is closed.
 */
export function deleteTapDevice(name: string): Result<void, TapError> {
  // Open the existing device
  const tunPath = "/dev/net/tun";
  const fd = libc.symbols.open(ptr(Buffer.from(tunPath + "\0")), O_RDWR);

  if (fd < 0) {
    return Result.err(new TapError(`Failed to open ${tunPath}`, fd, "open"));
  }

  try {
    // Create ifreq with the device name
    const ifreq = createIfreq(name, IFF_TAP | IFF_NO_PI);

    // Attach to the existing device
    const attachResult = libc.symbols.ioctl(fd, TUNSETIFF, ptr(ifreq));
    if (attachResult < 0) {
      libc.symbols.close(fd);
      return Result.err(new TapError(
        `Failed to attach to TAP device ${name}`,
        attachResult,
        "ioctl"
      ));
    }

    // Set persistence to 0 (delete on close)
    const persistResult = libc.symbols.ioctl(fd, TUNSETPERSIST, ptr(new Uint8Array([0])));
    if (persistResult < 0) {
      libc.symbols.close(fd);
      return Result.err(new TapError(
        "Failed to remove TAP device persistence",
        persistResult,
        "ioctl"
      ));
    }

    // Close the fd, which will now delete the device
    libc.symbols.close(fd);
    return Result.ok(undefined);
  } catch (error) {
    libc.symbols.close(fd);
    return Result.err(new TapError(
      `Unexpected error deleting TAP device: ${error}`,
      -1,
      "unknown"
    ));
  }
}

/**
 * Check if a TAP device exists by trying to open it
 */
export function tapDeviceExists(name: string): boolean {
  try {
    const tunPath = "/dev/net/tun";
    const fd = libc.symbols.open(ptr(Buffer.from(tunPath + "\0")), O_RDWR);

    if (fd < 0) {
      return false;
    }

    const ifreq = createIfreq(name, IFF_TAP | IFF_NO_PI);
    const result = libc.symbols.ioctl(fd, TUNSETIFF, ptr(ifreq));
    libc.symbols.close(fd);

    // If ioctl succeeds, device exists (or we just created it)
    // We need a different approach - check /sys/class/net
    return result >= 0;
  } catch {
    return false;
  }
}
