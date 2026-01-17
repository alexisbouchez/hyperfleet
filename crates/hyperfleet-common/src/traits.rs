// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Core trait definitions for Hyperfleet components.
//!
//! These traits enable dependency injection and future multi-node support
//! by abstracting the concrete implementations behind interfaces.

use async_trait::async_trait;
use std::net::IpAddr;
use std::path::PathBuf;

use crate::error::Result;
use crate::machine::{ExecRequest, ExecResponse, Gateway, Machine, MachineConfig, Webhook};

/// Storage trait for machine persistence.
///
/// Implemented by hyperfleet-db for SQLite, can be swapped for
/// distributed storage (Postgres, CockroachDB) in multi-node setup.
#[async_trait]
pub trait Storage: Send + Sync {
    /// Create a new machine record.
    async fn create_machine(&self, machine: &Machine) -> Result<()>;

    /// Get a machine by ID.
    async fn get_machine(&self, id: &str) -> Result<Option<Machine>>;

    /// List all machines.
    async fn list_machines(&self) -> Result<Vec<Machine>>;

    /// Update a machine record.
    async fn update_machine(&self, machine: &Machine) -> Result<()>;

    /// Delete a machine record.
    async fn delete_machine(&self, id: &str) -> Result<()>;

    /// Create a gateway record.
    async fn create_gateway(&self, gateway: &Gateway) -> Result<()>;

    /// Get gateway by machine ID and port.
    async fn get_gateway(&self, machine_id: &str, port: u16) -> Result<Option<Gateway>>;

    /// List gateways for a machine.
    async fn list_gateways(&self, machine_id: &str) -> Result<Vec<Gateway>>;

    /// List all gateways.
    async fn list_all_gateways(&self) -> Result<Vec<Gateway>>;

    /// Delete a gateway.
    async fn delete_gateway(&self, machine_id: &str, port: u16) -> Result<()>;

    /// Create a webhook record.
    async fn create_webhook(&self, webhook: &Webhook) -> Result<()>;

    /// Get a webhook by ID.
    async fn get_webhook(&self, id: &str) -> Result<Option<Webhook>>;

    /// List webhooks for a machine.
    async fn list_webhooks(&self, machine_id: &str) -> Result<Vec<Webhook>>;

    /// Delete a webhook.
    async fn delete_webhook(&self, id: &str) -> Result<()>;
}

/// VMM trait for Firecracker management.
///
/// Implemented by hyperfleet-vmm. In multi-node setup, can proxy
/// requests to remote nodes.
#[async_trait]
pub trait Vmm: Send + Sync {
    /// Create VM resources (rootfs overlay, config).
    async fn create(&self, machine: &Machine) -> Result<()>;

    /// Start the VM.
    async fn start(&self, id: &str) -> Result<()>;

    /// Stop the VM gracefully.
    async fn stop(&self, id: &str) -> Result<()>;

    /// Destroy VM and clean up resources.
    async fn destroy(&self, id: &str) -> Result<()>;

    /// Execute a command in the VM via hyperinit.
    async fn exec(&self, id: &str, request: &ExecRequest) -> Result<ExecResponse>;

    /// Read a file from the VM.
    async fn read_file(&self, id: &str, path: &str) -> Result<Vec<u8>>;

    /// Write a file to the VM.
    async fn write_file(&self, id: &str, path: &str, content: &[u8]) -> Result<()>;

    /// List directory contents in the VM.
    async fn list_dir(&self, id: &str, path: &str) -> Result<Vec<String>>;

    /// Delete a file or directory in the VM.
    async fn delete_path(&self, id: &str, path: &str) -> Result<()>;

    /// Create a directory in the VM.
    async fn mkdir(&self, id: &str, path: &str) -> Result<()>;
}

/// Network trait for TAP device and bridge management.
#[async_trait]
pub trait Network: Send + Sync {
    /// Create a TAP device for a machine.
    async fn create_tap(&self, machine_id: &str) -> Result<TapDevice>;

    /// Delete a TAP device.
    async fn delete_tap(&self, machine_id: &str) -> Result<()>;

    /// Allocate an IP address for a machine.
    async fn allocate_ip(&self, machine_id: &str) -> Result<IpAddr>;

    /// Release an IP address.
    async fn release_ip(&self, machine_id: &str) -> Result<()>;

    /// Get the IP address for a machine.
    async fn get_machine_ip(&self, machine_id: &str) -> Result<Option<IpAddr>>;
}

/// TAP device information.
#[derive(Debug, Clone)]
pub struct TapDevice {
    /// TAP device name (e.g., "tap0").
    pub name: String,
    /// MAC address assigned to the device.
    pub mac_address: String,
}

/// Volume manager trait for persistent storage.
#[async_trait]
pub trait VolumeManager: Send + Sync {
    /// Create a volume for a machine.
    async fn create(&self, machine_id: &str, size_mb: u64) -> Result<Volume>;

    /// Delete a volume.
    async fn delete(&self, machine_id: &str) -> Result<()>;

    /// Get the path to a volume's block device.
    async fn get_path(&self, machine_id: &str) -> Result<PathBuf>;

    /// Check if a volume exists.
    async fn exists(&self, machine_id: &str) -> Result<bool>;
}

/// Volume information.
#[derive(Debug, Clone)]
pub struct Volume {
    /// Machine ID this volume belongs to.
    pub machine_id: String,
    /// Path to the volume file.
    pub path: PathBuf,
    /// Size in MB.
    pub size_mb: u64,
}
