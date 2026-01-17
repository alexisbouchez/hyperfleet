// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Machine types and configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Machine status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineStatus {
    /// VM not running, rootfs and volumes persisted.
    Stopped,
    /// VM is starting up.
    Starting,
    /// VM actively running, hyperinit accepting requests.
    Running,
    /// VM is shutting down.
    Stopping,
    /// Machine failed to start or crashed.
    Failed,
}

impl std::fmt::Display for MachineStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stopped => write!(f, "stopped"),
            Self::Starting => write!(f, "starting"),
            Self::Running => write!(f, "running"),
            Self::Stopping => write!(f, "stopping"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// Machine configuration for creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineConfig {
    /// Number of vCPUs (1-8).
    pub vcpu_count: u8,
    /// Memory in MB (128-8192).
    pub memory_mb: u32,
    /// Volume size in MB (64-102400).
    pub volume_size_mb: u32,
    /// Mount path for the volume inside the guest.
    pub volume_mount_path: String,
    /// Environment variables.
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl Default for MachineConfig {
    fn default() -> Self {
        Self {
            vcpu_count: 1,
            memory_mb: 512,
            volume_size_mb: 1024,
            volume_mount_path: "/data".to_string(),
            env: HashMap::new(),
        }
    }
}

/// A Hyperfleet machine (microVM).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Machine {
    /// Unique machine ID (8-char NanoID).
    pub id: String,
    /// Parent machine ID (for child machines spawned via orchestration).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Number of vCPUs.
    pub vcpu_count: u8,
    /// Memory in MB.
    pub memory_mb: u32,
    /// Volume size in MB.
    pub volume_size_mb: u32,
    /// Mount path for the volume inside the guest.
    pub volume_mount_path: String,
    /// Environment variables.
    pub env: HashMap<String, String>,
    /// Current machine status.
    pub status: MachineStatus,
    /// Creation timestamp (Unix epoch seconds).
    pub created_at: i64,
    /// Last updated timestamp (Unix epoch seconds).
    pub updated_at: i64,
}

impl Machine {
    /// Create a new machine from configuration.
    pub fn new(config: MachineConfig) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        Self {
            id: crate::id::generate_id(),
            parent_id: None,
            vcpu_count: config.vcpu_count,
            memory_mb: config.memory_mb,
            volume_size_mb: config.volume_size_mb,
            volume_mount_path: config.volume_mount_path,
            env: config.env,
            status: MachineStatus::Stopped,
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a child machine from configuration with parent ID.
    pub fn new_child(config: MachineConfig, parent_id: String) -> Self {
        let mut machine = Self::new(config);
        machine.parent_id = Some(parent_id);
        machine
    }
}

/// Request to execute a command in a machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecRequest {
    /// Command and arguments.
    pub cmd: Vec<String>,
    /// Optional environment variable overrides.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Timeout in seconds.
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
}

fn default_timeout() -> u32 {
    30
}

/// Response from command execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecResponse {
    /// Exit code of the command.
    pub exit_code: i32,
    /// Standard output.
    pub stdout: String,
    /// Standard error.
    pub stderr: String,
}

/// Gateway configuration for exposing machine ports.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gateway {
    /// Machine ID this gateway belongs to.
    pub machine_id: String,
    /// Port exposed on the machine.
    pub port: u16,
    /// Full subdomain (e.g., "8080-k7x9m2p4.gw.hyperfleet.local").
    pub subdomain: String,
    /// Creation timestamp.
    pub created_at: i64,
}

/// Request to spawn a child machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRequest {
    /// Number of vCPUs (1-8).
    #[serde(default = "default_vcpu")]
    pub vcpu_count: u8,
    /// Memory in MB (128-8192).
    #[serde(default = "default_memory")]
    pub memory_mb: u32,
    /// Whether to inherit environment from parent.
    #[serde(default = "default_true")]
    pub inherit_env: bool,
    /// Additional environment variables (merged with/override parent).
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Webhook URL to call when machine completes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
}

fn default_vcpu() -> u8 {
    1
}
fn default_memory() -> u32 {
    512
}
fn default_true() -> bool {
    true
}

/// Response from spawn request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnResponse {
    /// Child machine ID.
    pub id: String,
    /// Parent machine ID.
    pub parent_id: String,
    /// Status of the child machine.
    pub status: MachineStatus,
}

/// Webhook configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Webhook {
    /// Unique webhook ID.
    pub id: String,
    /// Machine ID this webhook is for.
    pub machine_id: String,
    /// URL to POST to.
    pub url: String,
    /// Events to trigger on (e.g., "machine.stopped").
    pub events: Vec<String>,
    /// Creation timestamp.
    pub created_at: i64,
}

/// Webhook event payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookPayload {
    /// Event type.
    pub event: String,
    /// Machine ID.
    pub machine_id: String,
    /// Parent machine ID (if child).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Exit status (success/failed).
    pub exit_status: String,
    /// Timestamp.
    pub timestamp: i64,
}
