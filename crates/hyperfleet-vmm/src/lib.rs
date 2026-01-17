// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet Firecracker VMM management.
//!
//! Handles Firecracker process lifecycle and vsock communication
//! with hyperinit running inside VMs.

mod config;
mod vsock;

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use hyperfleet_common::traits::Vmm;
use hyperfleet_common::{Error, ExecRequest, ExecResponse, Machine, Result};

pub use config::VmConfig;
pub use vsock::VsockClient;

/// Firecracker VMM manager.
pub struct FirecrackerVmm {
    /// Path to Firecracker binary.
    firecracker_bin: PathBuf,
    /// Path to kernel image.
    kernel_path: PathBuf,
    /// Path to base rootfs image.
    rootfs_path: PathBuf,
    /// Base directory for VM data.
    data_dir: PathBuf,
    /// Running VM processes.
    vms: Arc<Mutex<HashMap<String, VmProcess>>>,
}

/// A running VM process.
struct VmProcess {
    /// Firecracker child process.
    #[allow(dead_code)]
    process: Child,
    /// Path to vsock socket.
    vsock_path: PathBuf,
}

impl FirecrackerVmm {
    /// Create a new Firecracker VMM manager.
    pub fn new(
        firecracker_bin: PathBuf,
        kernel_path: PathBuf,
        rootfs_path: PathBuf,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            firecracker_bin,
            kernel_path,
            rootfs_path,
            data_dir,
            vms: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Initialize the VMM (create directories, verify binaries).
    pub async fn init(&self) -> Result<()> {
        // Create data directory
        tokio::fs::create_dir_all(&self.data_dir)
            .await
            .map_err(|e| Error::Vmm(format!("failed to create data directory: {}", e)))?;

        // Verify Firecracker binary exists
        if !self.firecracker_bin.exists() {
            return Err(Error::Vmm(format!(
                "Firecracker binary not found: {}",
                self.firecracker_bin.display()
            )));
        }

        // Verify kernel exists
        if !self.kernel_path.exists() {
            return Err(Error::Vmm(format!(
                "kernel not found: {}",
                self.kernel_path.display()
            )));
        }

        // Verify rootfs exists
        if !self.rootfs_path.exists() {
            return Err(Error::Vmm(format!(
                "rootfs not found: {}",
                self.rootfs_path.display()
            )));
        }

        Ok(())
    }

    /// Get the VM directory for a machine.
    fn vm_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join(id)
    }

    /// Get the vsock path for a machine.
    fn vsock_path(&self, id: &str) -> PathBuf {
        self.vm_dir(id).join("vsock.sock")
    }

    /// Get the overlay path for a machine.
    fn overlay_path(&self, id: &str) -> PathBuf {
        self.vm_dir(id).join("overlay.ext4")
    }

    /// Get the config path for a machine.
    fn config_path(&self, id: &str) -> PathBuf {
        self.vm_dir(id).join("config.json")
    }

    /// Create overlay filesystem for a machine.
    async fn create_overlay(&self, id: &str) -> Result<PathBuf> {
        let overlay_path = self.overlay_path(id);

        // Copy base rootfs as overlay
        tokio::fs::copy(&self.rootfs_path, &overlay_path)
            .await
            .map_err(|e| Error::Vmm(format!("failed to create overlay: {}", e)))?;

        Ok(overlay_path)
    }

    /// Connect to hyperinit via vsock.
    async fn connect(&self, id: &str) -> Result<VsockClient> {
        let vms = self.vms.lock().await;
        let vm = vms
            .get(id)
            .ok_or_else(|| Error::MachineNotFound(id.to_string()))?;

        VsockClient::connect(&vm.vsock_path).await
    }
}

#[async_trait]
impl Vmm for FirecrackerVmm {
    async fn create(&self, machine: &Machine) -> Result<()> {
        let vm_dir = self.vm_dir(&machine.id);

        // Create VM directory
        tokio::fs::create_dir_all(&vm_dir)
            .await
            .map_err(|e| Error::Vmm(format!("failed to create VM directory: {}", e)))?;

        // Create overlay
        let overlay_path = self.create_overlay(&machine.id).await?;

        // Generate VM config
        let vsock_path = self.vsock_path(&machine.id);
        let config = VmConfig::new(
            machine.vcpu_count,
            machine.memory_mb,
            &self.kernel_path,
            &overlay_path,
            &vsock_path,
            &machine.env,
        );

        // Write config
        let config_json = serde_json::to_string_pretty(&config)?;
        tokio::fs::write(self.config_path(&machine.id), config_json)
            .await
            .map_err(|e| Error::Vmm(format!("failed to write config: {}", e)))?;

        tracing::info!(machine_id = %machine.id, "created VM resources");
        Ok(())
    }

    async fn start(&self, id: &str) -> Result<()> {
        let vm_dir = self.vm_dir(id);
        let config_path = self.config_path(id);
        let vsock_path = self.vsock_path(id);

        if !config_path.exists() {
            return Err(Error::MachineNotFound(id.to_string()));
        }

        // Remove old vsock socket if exists
        let _ = tokio::fs::remove_file(&vsock_path).await;

        // Start Firecracker
        let process = Command::new(&self.firecracker_bin)
            .args([
                "--api-sock",
                vm_dir.join("api.sock").to_str().unwrap(),
                "--config-file",
                config_path.to_str().unwrap(),
            ])
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| Error::Vmm(format!("failed to start Firecracker: {}", e)))?;

        // Store VM process
        let mut vms = self.vms.lock().await;
        vms.insert(
            id.to_string(),
            VmProcess {
                process,
                vsock_path: vsock_path.clone(),
            },
        );

        // Wait for vsock to be ready
        for _ in 0..50 {
            if vsock_path.exists() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        if !vsock_path.exists() {
            return Err(Error::Vmm("vsock socket not created".to_string()));
        }

        // Wait for hyperinit to be ready
        for _ in 0..50 {
            match VsockClient::connect(&vsock_path).await {
                Ok(mut client) => {
                    if client.health_check().await.is_ok() {
                        tracing::info!(machine_id = %id, "VM started and hyperinit ready");
                        return Ok(());
                    }
                }
                Err(_) => {}
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        Err(Error::Vmm("hyperinit not responding".to_string()))
    }

    async fn stop(&self, id: &str) -> Result<()> {
        // Try graceful shutdown via hyperinit
        if let Ok(mut client) = self.connect(id).await {
            let _ = client.shutdown().await;
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        // Remove from running VMs (process will be killed on drop)
        let mut vms = self.vms.lock().await;
        vms.remove(id);

        tracing::info!(machine_id = %id, "VM stopped");
        Ok(())
    }

    async fn destroy(&self, id: &str) -> Result<()> {
        // Stop VM if running
        self.stop(id).await?;

        // Remove VM directory
        let vm_dir = self.vm_dir(id);
        if vm_dir.exists() {
            tokio::fs::remove_dir_all(&vm_dir)
                .await
                .map_err(|e| Error::Vmm(format!("failed to remove VM directory: {}", e)))?;
        }

        tracing::info!(machine_id = %id, "VM destroyed");
        Ok(())
    }

    async fn exec(&self, id: &str, request: &ExecRequest) -> Result<ExecResponse> {
        let mut client = self.connect(id).await?;
        client.exec(request).await
    }

    async fn read_file(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        let mut client = self.connect(id).await?;
        client.read_file(path).await
    }

    async fn write_file(&self, id: &str, path: &str, content: &[u8]) -> Result<()> {
        let mut client = self.connect(id).await?;
        client.write_file(path, content).await
    }

    async fn list_dir(&self, id: &str, path: &str) -> Result<Vec<String>> {
        let mut client = self.connect(id).await?;
        client.list_dir(path).await
    }

    async fn delete_path(&self, id: &str, path: &str) -> Result<()> {
        let mut client = self.connect(id).await?;
        client.delete_path(path).await
    }

    async fn mkdir(&self, id: &str, path: &str) -> Result<()> {
        let mut client = self.connect(id).await?;
        client.mkdir(path).await
    }
}
