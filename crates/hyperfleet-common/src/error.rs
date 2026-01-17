// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Error types for Hyperfleet.

use thiserror::Error;

/// Result type alias using the Hyperfleet Error.
pub type Result<T> = std::result::Result<T, Error>;

/// Hyperfleet error type.
#[derive(Debug, Error)]
pub enum Error {
    /// Machine not found.
    #[error("machine not found: {0}")]
    MachineNotFound(String),

    /// Machine already exists.
    #[error("machine already exists: {0}")]
    MachineAlreadyExists(String),

    /// Machine is in an invalid state for the requested operation.
    #[error("invalid machine state: expected {expected}, got {actual}")]
    InvalidMachineState { expected: String, actual: String },

    /// Gateway not found.
    #[error("gateway not found: machine {machine_id} port {port}")]
    GatewayNotFound { machine_id: String, port: u16 },

    /// Gateway already exists.
    #[error("gateway already exists: machine {machine_id} port {port}")]
    GatewayAlreadyExists { machine_id: String, port: u16 },

    /// Webhook not found.
    #[error("webhook not found: {0}")]
    WebhookNotFound(String),

    /// Configuration error.
    #[error("configuration error: {0}")]
    Config(String),

    /// Database error.
    #[error("database error: {0}")]
    Database(String),

    /// Firecracker/VMM error.
    #[error("vmm error: {0}")]
    Vmm(String),

    /// Network error.
    #[error("network error: {0}")]
    Network(String),

    /// Volume error.
    #[error("volume error: {0}")]
    Volume(String),

    /// Exec timeout.
    #[error("exec timeout after {0} seconds")]
    ExecTimeout(u32),

    /// File system error.
    #[error("filesystem error: {0}")]
    Filesystem(String),

    /// IO error.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Serialization error.
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Internal error.
    #[error("internal error: {0}")]
    Internal(String),
}
