// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet daemon - Main orchestration service.

use anyhow::{Context, Result};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::signal;
use tracing::{error, info, warn};

use hyperfleet_api::{create_router, AppState};
use hyperfleet_common::traits::Storage;
use hyperfleet_common::MachineStatus;
use hyperfleet_core::MachineService;
use hyperfleet_db::SqliteStorage;
use hyperfleet_network::NetworkManager;
use hyperfleet_vmm::FirecrackerVmm;
use hyperfleet_volume::FileVolumeManager;

/// Configuration loaded from environment.
struct Config {
    api_key: String,
    listen_addr: SocketAddr,
    db_url: String,
    data_dir: PathBuf,
    volumes_path: PathBuf,
    bridge_name: String,
    bridge_cidr: String,
    gateway_domain: String,
    firecracker_bin: PathBuf,
    kernel_path: PathBuf,
    rootfs_path: PathBuf,
}

impl Config {
    fn from_env() -> Result<Self> {
        Ok(Self {
            api_key: std::env::var("HYPERFLEET_API_KEY").unwrap_or_else(|_| "unsecure".to_string()),
            listen_addr: std::env::var("HYPERFLEET_LISTEN")
                .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
                .parse()
                .context("invalid listen address")?,
            db_url: std::env::var("HYPERFLEET_DB_URL")
                .unwrap_or_else(|_| "sqlite:///var/lib/hyperfleet/hyperfleet.db".to_string()),
            data_dir: PathBuf::from(
                std::env::var("HYPERFLEET_DATA_DIR")
                    .unwrap_or_else(|_| "/var/lib/hyperfleet/data".to_string()),
            ),
            volumes_path: PathBuf::from(
                std::env::var("HYPERFLEET_VOLUMES_PATH")
                    .unwrap_or_else(|_| "/var/lib/hyperfleet/volumes".to_string()),
            ),
            bridge_name: std::env::var("HYPERFLEET_BRIDGE_NAME")
                .unwrap_or_else(|_| "hfbr0".to_string()),
            bridge_cidr: std::env::var("HYPERFLEET_BRIDGE_CIDR")
                .unwrap_or_else(|_| "10.0.0.1/24".to_string()),
            gateway_domain: std::env::var("HYPERFLEET_GATEWAY_DOMAIN")
                .unwrap_or_else(|_| "gw.hyperfleet.local".to_string()),
            firecracker_bin: PathBuf::from(
                std::env::var("HYPERFLEET_FIRECRACKER_BIN")
                    .unwrap_or_else(|_| "/usr/local/bin/firecracker".to_string()),
            ),
            kernel_path: PathBuf::from(
                std::env::var("HYPERFLEET_KERNEL_PATH")
                    .unwrap_or_else(|_| "/var/lib/hyperfleet/images/vmlinux".to_string()),
            ),
            rootfs_path: PathBuf::from(
                std::env::var("HYPERFLEET_ROOTFS_PATH")
                    .unwrap_or_else(|_| "/var/lib/hyperfleet/images/rootfs.ext4".to_string()),
            ),
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("hyperfleet=info".parse().unwrap())
                .add_directive("tower_http=debug".parse().unwrap()),
        )
        .init();

    info!("hyperfleet-daemon starting");

    // Load configuration
    let config = Config::from_env()?;

    // Initialize storage
    info!("connecting to database: {}", config.db_url);
    let storage = Arc::new(
        SqliteStorage::new(&config.db_url)
            .await
            .context("failed to initialize storage")?,
    );

    // Initialize network manager
    let network = Arc::new(NetworkManager::new(
        config.bridge_name.clone(),
        config.bridge_cidr.clone(),
    ));

    // Initialize bridge and NAT (requires root)
    if let Err(e) = network.init_bridge().await {
        warn!("failed to initialize bridge (may need root): {}", e);
    }
    if let Err(e) = network.setup_nat().await {
        warn!("failed to setup NAT (may need root): {}", e);
    }

    // Initialize volume manager
    let volume_manager = Arc::new(FileVolumeManager::new(config.volumes_path.clone()));
    volume_manager.init().await?;

    // Initialize VMM
    let vmm = Arc::new(FirecrackerVmm::new(
        config.firecracker_bin.clone(),
        config.kernel_path.clone(),
        config.rootfs_path.clone(),
        config.data_dir.clone(),
    ));

    if let Err(e) = vmm.init().await {
        warn!("VMM initialization warning: {}", e);
    }

    // Recover machine states
    recover_machines(storage.as_ref()).await;

    // Create machine service
    let service = Arc::new(MachineService::new(
        storage.clone(),
        vmm,
        network,
        volume_manager,
        config.gateway_domain,
    ));

    // Create API state
    let state = Arc::new(AppState {
        service,
        api_key: config.api_key,
    });

    // Create router
    let app = create_router(state);

    // Start server
    let listener = tokio::net::TcpListener::bind(config.listen_addr).await?;
    info!("listening on {}", config.listen_addr);

    // Run with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    info!("hyperfleet-daemon stopped");
    Ok(())
}

/// Recover machine states after daemon restart.
async fn recover_machines<S: Storage>(storage: &S) {
    info!("recovering machine states");

    let machines = match storage.list_machines().await {
        Ok(m) => m,
        Err(e) => {
            error!("failed to list machines for recovery: {}", e);
            return;
        }
    };

    for mut machine in machines {
        let original_status = machine.status;
        let new_status = match machine.status {
            // VMs that were starting when daemon died are now failed
            MachineStatus::Starting => MachineStatus::Failed,
            // VMs that were running or stopping are now stopped (process died with daemon)
            MachineStatus::Running | MachineStatus::Stopping => MachineStatus::Stopped,
            // Keep other states as-is
            _ => continue,
        };

        machine.status = new_status;
        machine.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        if let Err(e) = storage.update_machine(&machine).await {
            error!(
                "failed to update machine {} status: {}",
                machine.id, e
            );
        } else {
            info!(
                machine_id = %machine.id,
                from = %original_status,
                to = %new_status,
                "recovered machine state"
            );
        }
    }
}

/// Wait for shutdown signal.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            info!("received Ctrl+C, shutting down");
        }
        _ = terminate => {
            info!("received SIGTERM, shutting down");
        }
    }
}
