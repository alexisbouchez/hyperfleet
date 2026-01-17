// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet core business logic.
//!
//! Contains the MachineService which orchestrates machine lifecycle,
//! command execution, and filesystem operations.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use hyperfleet_common::traits::{Network, Storage, Vmm, VolumeManager};
use hyperfleet_common::{
    Error, ExecRequest, ExecResponse, Gateway, Machine, MachineConfig, MachineStatus, Result,
    SpawnRequest, SpawnResponse, Webhook, WebhookPayload,
};

/// Machine service for orchestrating VM lifecycle.
pub struct MachineService<S, V, N, Vol>
where
    S: Storage,
    V: Vmm,
    N: Network,
    Vol: VolumeManager,
{
    storage: Arc<S>,
    vmm: Arc<V>,
    network: Arc<N>,
    volume_manager: Arc<Vol>,
    gateway_domain: String,
}

impl<S, V, N, Vol> MachineService<S, V, N, Vol>
where
    S: Storage,
    V: Vmm,
    N: Network,
    Vol: VolumeManager,
{
    /// Create a new machine service.
    pub fn new(
        storage: Arc<S>,
        vmm: Arc<V>,
        network: Arc<N>,
        volume_manager: Arc<Vol>,
        gateway_domain: String,
    ) -> Self {
        Self {
            storage,
            vmm,
            network,
            volume_manager,
            gateway_domain,
        }
    }

    /// Create a new machine.
    pub async fn create_machine(&self, config: MachineConfig) -> Result<Machine> {
        let machine = Machine::new(config.clone());

        // Create volume
        self.volume_manager
            .create(&machine.id, config.volume_size_mb as u64)
            .await?;

        // Create TAP device
        self.network.create_tap(&machine.id).await?;

        // Allocate IP
        self.network.allocate_ip(&machine.id).await?;

        // Create VM resources
        self.vmm.create(&machine).await?;

        // Persist to storage
        self.storage.create_machine(&machine).await?;

        tracing::info!(machine_id = %machine.id, "created machine");
        Ok(machine)
    }

    /// Get a machine by ID.
    pub async fn get_machine(&self, id: &str) -> Result<Machine> {
        self.storage
            .get_machine(id)
            .await?
            .ok_or_else(|| Error::MachineNotFound(id.to_string()))
    }

    /// List all machines.
    pub async fn list_machines(&self) -> Result<Vec<Machine>> {
        self.storage.list_machines().await
    }

    /// Start a machine.
    pub async fn start_machine(&self, id: &str) -> Result<Machine> {
        let mut machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Stopped {
            return Err(Error::InvalidMachineState {
                expected: "stopped".to_string(),
                actual: machine.status.to_string(),
            });
        }

        // Update status to starting
        machine.status = MachineStatus::Starting;
        machine.updated_at = now();
        self.storage.update_machine(&machine).await?;

        // Start VM
        match self.vmm.start(id).await {
            Ok(()) => {
                machine.status = MachineStatus::Running;
                machine.updated_at = now();
                self.storage.update_machine(&machine).await?;
                tracing::info!(machine_id = %id, "started machine");
                Ok(machine)
            }
            Err(e) => {
                machine.status = MachineStatus::Failed;
                machine.updated_at = now();
                self.storage.update_machine(&machine).await?;
                Err(e)
            }
        }
    }

    /// Stop a machine.
    pub async fn stop_machine(&self, id: &str) -> Result<Machine> {
        let mut machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        // Update status to stopping
        machine.status = MachineStatus::Stopping;
        machine.updated_at = now();
        self.storage.update_machine(&machine).await?;

        // Stop VM
        self.vmm.stop(id).await?;

        // Fire webhooks
        self.fire_webhooks(&machine, "machine.stopped", "success")
            .await;

        machine.status = MachineStatus::Stopped;
        machine.updated_at = now();
        self.storage.update_machine(&machine).await?;

        tracing::info!(machine_id = %id, "stopped machine");
        Ok(machine)
    }

    /// Delete a machine.
    pub async fn delete_machine(&self, id: &str) -> Result<()> {
        let machine = self.get_machine(id).await?;

        if machine.status == MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "stopped".to_string(),
                actual: machine.status.to_string(),
            });
        }

        // Destroy VM resources
        self.vmm.destroy(id).await?;

        // Delete volume
        self.volume_manager.delete(id).await?;

        // Delete TAP device
        self.network.delete_tap(id).await?;

        // Release IP
        self.network.release_ip(id).await?;

        // Delete from storage
        self.storage.delete_machine(id).await?;

        tracing::info!(machine_id = %id, "deleted machine");
        Ok(())
    }

    /// Execute a command in a machine.
    pub async fn exec(&self, id: &str, request: ExecRequest) -> Result<ExecResponse> {
        let machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        self.vmm.exec(id, &request).await
    }

    /// List directory contents in a machine.
    pub async fn list_files(&self, id: &str, path: &str) -> Result<Vec<String>> {
        let machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        self.vmm.list_dir(id, path).await
    }

    /// Read a file from a machine.
    pub async fn read_file(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        let machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        self.vmm.read_file(id, path).await
    }

    /// Write a file to a machine.
    pub async fn write_file(&self, id: &str, path: &str, content: &[u8]) -> Result<()> {
        let machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        self.vmm.write_file(id, path, content).await
    }

    /// Delete a file or directory in a machine.
    pub async fn delete_file(&self, id: &str, path: &str) -> Result<()> {
        let machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        self.vmm.delete_path(id, path).await
    }

    /// Create a directory in a machine.
    pub async fn mkdir(&self, id: &str, path: &str) -> Result<()> {
        let machine = self.get_machine(id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        self.vmm.mkdir(id, path).await
    }

    /// Create a gateway for a machine.
    pub async fn create_gateway(&self, machine_id: &str, port: u16) -> Result<Gateway> {
        // Verify machine exists and is running
        let machine = self.get_machine(machine_id).await?;

        if machine.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: machine.status.to_string(),
            });
        }

        // Check if gateway already exists
        if self
            .storage
            .get_gateway(machine_id, port)
            .await?
            .is_some()
        {
            return Err(Error::GatewayAlreadyExists {
                machine_id: machine_id.to_string(),
                port,
            });
        }

        let gateway = Gateway {
            machine_id: machine_id.to_string(),
            port,
            subdomain: format!("{}-{}.{}", port, machine_id, self.gateway_domain),
            created_at: now(),
        };

        self.storage.create_gateway(&gateway).await?;

        tracing::info!(machine_id = %machine_id, port = port, "created gateway");
        Ok(gateway)
    }

    /// List gateways for a machine.
    pub async fn list_gateways(&self, machine_id: &str) -> Result<Vec<Gateway>> {
        // Verify machine exists
        self.get_machine(machine_id).await?;
        self.storage.list_gateways(machine_id).await
    }

    /// Delete a gateway.
    pub async fn delete_gateway(&self, machine_id: &str, port: u16) -> Result<()> {
        self.storage.delete_gateway(machine_id, port).await?;
        tracing::info!(machine_id = %machine_id, port = port, "deleted gateway");
        Ok(())
    }

    /// Spawn a child machine.
    pub async fn spawn_child(
        &self,
        parent_id: &str,
        request: SpawnRequest,
    ) -> Result<SpawnResponse> {
        let parent = self.get_machine(parent_id).await?;

        if parent.status != MachineStatus::Running {
            return Err(Error::InvalidMachineState {
                expected: "running".to_string(),
                actual: parent.status.to_string(),
            });
        }

        // Build child config
        let mut env = if request.inherit_env {
            parent.env.clone()
        } else {
            std::collections::HashMap::new()
        };

        // Merge additional env vars
        env.extend(request.env);

        let config = MachineConfig {
            vcpu_count: request.vcpu_count,
            memory_mb: request.memory_mb,
            volume_size_mb: parent.volume_size_mb,
            volume_mount_path: parent.volume_mount_path.clone(),
            env,
        };

        // Create child machine
        let mut child = Machine::new_child(config.clone(), parent_id.to_string());

        // Create resources
        self.volume_manager
            .create(&child.id, config.volume_size_mb as u64)
            .await?;
        self.network.create_tap(&child.id).await?;
        self.network.allocate_ip(&child.id).await?;
        self.vmm.create(&child).await?;

        // Start the child
        child.status = MachineStatus::Starting;
        self.storage.create_machine(&child).await?;

        match self.vmm.start(&child.id).await {
            Ok(()) => {
                child.status = MachineStatus::Running;
                child.updated_at = now();
                self.storage.update_machine(&child).await?;
            }
            Err(e) => {
                child.status = MachineStatus::Failed;
                child.updated_at = now();
                self.storage.update_machine(&child).await?;
                return Err(e);
            }
        }

        // Register webhook if provided
        if let Some(url) = request.webhook_url {
            let webhook = Webhook {
                id: hyperfleet_common::generate_id(),
                machine_id: child.id.clone(),
                url,
                events: vec!["machine.stopped".to_string()],
                created_at: now(),
            };
            self.storage.create_webhook(&webhook).await?;
        }

        tracing::info!(
            parent_id = %parent_id,
            child_id = %child.id,
            "spawned child machine"
        );

        Ok(SpawnResponse {
            id: child.id,
            parent_id: parent_id.to_string(),
            status: child.status,
        })
    }

    /// List child machines.
    pub async fn list_children(&self, parent_id: &str) -> Result<Vec<Machine>> {
        let machines = self.storage.list_machines().await?;
        Ok(machines
            .into_iter()
            .filter(|m| m.parent_id.as_deref() == Some(parent_id))
            .collect())
    }

    /// Register a webhook.
    pub async fn create_webhook(
        &self,
        machine_id: &str,
        url: String,
        events: Vec<String>,
    ) -> Result<Webhook> {
        // Verify machine exists
        self.get_machine(machine_id).await?;

        let webhook = Webhook {
            id: hyperfleet_common::generate_id(),
            machine_id: machine_id.to_string(),
            url,
            events,
            created_at: now(),
        };

        self.storage.create_webhook(&webhook).await?;

        tracing::info!(machine_id = %machine_id, webhook_id = %webhook.id, "created webhook");
        Ok(webhook)
    }

    /// List webhooks for a machine.
    pub async fn list_webhooks(&self, machine_id: &str) -> Result<Vec<Webhook>> {
        self.storage.list_webhooks(machine_id).await
    }

    /// Delete a webhook.
    pub async fn delete_webhook(&self, id: &str) -> Result<()> {
        self.storage.delete_webhook(id).await?;
        tracing::info!(webhook_id = %id, "deleted webhook");
        Ok(())
    }

    /// Fire webhooks for a machine event.
    async fn fire_webhooks(&self, machine: &Machine, event: &str, exit_status: &str) {
        let webhooks = match self.storage.list_webhooks(&machine.id).await {
            Ok(w) => w,
            Err(_) => return,
        };

        let payload = WebhookPayload {
            event: event.to_string(),
            machine_id: machine.id.clone(),
            parent_id: machine.parent_id.clone(),
            exit_status: exit_status.to_string(),
            timestamp: now(),
        };

        let client = reqwest::Client::new();

        for webhook in webhooks {
            if webhook.events.contains(&event.to_string()) {
                let client = client.clone();
                let url = webhook.url.clone();
                let payload = payload.clone();

                // Fire async, don't wait
                tokio::spawn(async move {
                    if let Err(e) = client.post(&url).json(&payload).send().await {
                        tracing::warn!(url = %url, error = %e, "webhook delivery failed");
                    }
                });
            }
        }
    }
}

/// Get current Unix timestamp.
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
