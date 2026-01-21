/**
 * Drive builder for Firecracker microVMs
 * Follows the builder pattern from firecracker-go-sdk
 */

import type { Drive, RateLimiter } from "./models";

export type DriveOpt = (drive: Drive) => Drive;

export function withDriveId(id: string): DriveOpt {
  return (drive) => ({ ...drive, drive_id: id });
}

export function withReadOnly(readOnly: boolean): DriveOpt {
  return (drive) => ({ ...drive, is_read_only: readOnly });
}

export function withPartuuid(partuuid: string): DriveOpt {
  return (drive) => ({ ...drive, partuuid });
}

export function withCacheType(cacheType: "Unsafe" | "Writeback"): DriveOpt {
  return (drive) => ({ ...drive, cache_type: cacheType });
}

export function withIoEngine(ioEngine: "Sync" | "Async"): DriveOpt {
  return (drive) => ({ ...drive, io_engine: ioEngine });
}

export function withDriveRateLimiter(rateLimiter: RateLimiter): DriveOpt {
  return (drive) => ({ ...drive, rate_limiter: rateLimiter });
}

export class DrivesBuilder {
  private rootDrive: Drive | null = null;
  private additionalDrives: Drive[] = [];
  private nextDriveId = 1;

  constructor(rootDrivePath?: string, ...opts: DriveOpt[]) {
    if (rootDrivePath) {
      this.withRootDrive(rootDrivePath, ...opts);
    }
  }

  withRootDrive(path: string, ...opts: DriveOpt[]): this {
    let drive: Drive = {
      drive_id: "rootfs",
      path_on_host: path,
      is_root_device: true,
      is_read_only: false,
    };

    for (const opt of opts) {
      drive = opt(drive);
    }

    this.rootDrive = drive;
    return this;
  }

  addDrive(path: string, readOnly: boolean = false, ...opts: DriveOpt[]): this {
    let drive: Drive = {
      drive_id: String(this.nextDriveId++),
      path_on_host: path,
      is_root_device: false,
      is_read_only: readOnly,
    };

    for (const opt of opts) {
      drive = opt(drive);
    }

    this.additionalDrives.push(drive);
    return this;
  }

  build(): Drive[] {
    const drives: Drive[] = [...this.additionalDrives];

    if (this.rootDrive) {
      drives.push(this.rootDrive);
    }

    return drives;
  }
}
