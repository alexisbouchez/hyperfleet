// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Firecracker VM configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Firecracker VM configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmConfig {
    /// Boot source configuration.
    #[serde(rename = "boot-source")]
    pub boot_source: BootSource,
    /// Drive configurations.
    pub drives: Vec<Drive>,
    /// Machine configuration.
    #[serde(rename = "machine-config")]
    pub machine_config: MachineConfig,
    /// Network interface configurations.
    #[serde(rename = "network-interfaces")]
    pub network_interfaces: Vec<NetworkInterface>,
    /// Vsock device configuration.
    pub vsock: VsockConfig,
}

/// Network interface configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInterface {
    /// Interface ID.
    pub iface_id: String,
    /// Guest MAC address.
    pub guest_mac: String,
    /// Host TAP device name.
    pub host_dev_name: String,
}

/// Boot source configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootSource {
    /// Path to the kernel image.
    pub kernel_image_path: String,
    /// Kernel boot arguments.
    pub boot_args: String,
}

/// Drive configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Drive {
    /// Drive ID.
    pub drive_id: String,
    /// Path to the drive image.
    pub path_on_host: String,
    /// Whether the drive is read-only.
    pub is_read_only: bool,
    /// Whether this is the root device.
    pub is_root_device: bool,
}

/// Machine configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineConfig {
    /// Number of vCPUs.
    pub vcpu_count: u8,
    /// Memory size in MiB.
    pub mem_size_mib: u32,
}

/// Vsock device configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VsockConfig {
    /// Guest CID.
    pub guest_cid: u32,
    /// Path to the Unix domain socket.
    pub uds_path: String,
}

/// Network configuration for a VM.
pub struct NetworkConfig {
    /// TAP device name on the host.
    pub tap_name: String,
    /// MAC address for the guest interface.
    pub mac_address: String,
    /// IP address for the guest (e.g., "10.0.0.2").
    pub guest_ip: String,
    /// Gateway IP (e.g., "10.0.0.1").
    pub gateway_ip: String,
}

impl VmConfig {
    /// Create a new VM configuration.
    pub fn new(
        vcpu_count: u8,
        memory_mb: u32,
        kernel_path: &Path,
        rootfs_path: &Path,
        vsock_path: &Path,
        env: &HashMap<String, String>,
        network: Option<&NetworkConfig>,
    ) -> Self {
        // Build boot args with environment variables
        let mut boot_args = "console=ttyS0 reboot=k panic=1 pci=off".to_string();

        // Add environment variables as kernel parameters
        for (key, value) in env {
            // Escape special characters in values
            let escaped = value.replace(' ', "\\ ").replace('"', "\\\"");
            boot_args.push_str(&format!(" hyperfleet.env.{}={}", key, escaped));
        }

        // Add network configuration as kernel parameters
        let network_interfaces = if let Some(net) = network {
            boot_args.push_str(&format!(" hyperfleet.net.ip={}", net.guest_ip));
            boot_args.push_str(&format!(" hyperfleet.net.gateway={}", net.gateway_ip));
            vec![NetworkInterface {
                iface_id: "eth0".to_string(),
                guest_mac: net.mac_address.clone(),
                host_dev_name: net.tap_name.clone(),
            }]
        } else {
            vec![]
        };

        Self {
            boot_source: BootSource {
                kernel_image_path: kernel_path.to_str().unwrap().to_string(),
                boot_args,
            },
            drives: vec![Drive {
                drive_id: "rootfs".to_string(),
                path_on_host: rootfs_path.to_str().unwrap().to_string(),
                is_read_only: false,
                is_root_device: true,
            }],
            machine_config: MachineConfig {
                vcpu_count,
                mem_size_mib: memory_mb,
            },
            network_interfaces,
            vsock: VsockConfig {
                guest_cid: 3, // Standard guest CID
                uds_path: vsock_path.to_str().unwrap().to_string(),
            },
        }
    }
}
