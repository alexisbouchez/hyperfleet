// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet common types, traits, and error definitions.

pub mod error;
pub mod id;
pub mod machine;
pub mod traits;

pub use error::{Error, Result};
pub use id::generate_id;
pub use machine::{
    ExecRequest, ExecResponse, Gateway, Machine, MachineConfig, MachineStatus, SpawnRequest,
    SpawnResponse, Webhook, WebhookPayload,
};
