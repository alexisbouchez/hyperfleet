// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet network management.
//!
//! Handles TAP device creation, bridge management, and IP allocation
//! for Firecracker microVMs.

use async_trait::async_trait;
use std::collections::HashMap;
use std::net::IpAddr;
use std::process::Command;
use std::sync::Mutex;

use hyperfleet_common::traits::{Network, TapDevice};
use hyperfleet_common::{Error, Result};

/// Network manager for TAP devices and IP allocation.
pub struct NetworkManager {
    /// Bridge name (e.g., "hfbr0").
    bridge_name: String,
    /// Bridge CIDR (e.g., "10.0.0.1/24").
    bridge_cidr: String,
    /// Allocated IPs mapped by machine ID.
    allocations: Mutex<HashMap<String, IpAddr>>,
    /// Next available IP octet.
    next_ip: Mutex<u8>,
}

impl NetworkManager {
    /// Create a new network manager.
    pub fn new(bridge_name: String, bridge_cidr: String) -> Self {
        Self {
            bridge_name,
            bridge_cidr,
            allocations: Mutex::new(HashMap::new()),
            next_ip: Mutex::new(2), // Start at .2, .1 is the bridge
        }
    }

    /// Initialize the network bridge.
    pub async fn init_bridge(&self) -> Result<()> {
        // Check if bridge exists
        let status = Command::new("ip")
            .args(["link", "show", &self.bridge_name])
            .status()
            .map_err(|e| Error::Network(format!("failed to check bridge: {}", e)))?;

        if !status.success() {
            // Create bridge
            let output = Command::new("ip")
                .args(["link", "add", &self.bridge_name, "type", "bridge"])
                .output()
                .map_err(|e| Error::Network(format!("failed to create bridge: {}", e)))?;

            if !output.status.success() {
                return Err(Error::Network(format!(
                    "failed to create bridge: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }

            // Set IP address
            let output = Command::new("ip")
                .args(["addr", "add", &self.bridge_cidr, "dev", &self.bridge_name])
                .output()
                .map_err(|e| Error::Network(format!("failed to set bridge IP: {}", e)))?;

            if !output.status.success() {
                return Err(Error::Network(format!(
                    "failed to set bridge IP: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }

            // Bring up bridge
            let output = Command::new("ip")
                .args(["link", "set", &self.bridge_name, "up"])
                .output()
                .map_err(|e| Error::Network(format!("failed to bring up bridge: {}", e)))?;

            if !output.status.success() {
                return Err(Error::Network(format!(
                    "failed to bring up bridge: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }

            tracing::info!(bridge = %self.bridge_name, "created network bridge");
        }

        Ok(())
    }

    /// Set up NAT for outbound traffic.
    pub async fn setup_nat(&self) -> Result<()> {
        // Enable IP forwarding
        let output = Command::new("sysctl")
            .args(["-w", "net.ipv4.ip_forward=1"])
            .output()
            .map_err(|e| Error::Network(format!("failed to enable IP forwarding: {}", e)))?;

        if !output.status.success() {
            return Err(Error::Network(format!(
                "failed to enable IP forwarding: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        // Add masquerade rule
        let cidr = &self.bridge_cidr;
        let output = Command::new("iptables")
            .args([
                "-t",
                "nat",
                "-C",
                "POSTROUTING",
                "-s",
                cidr,
                "-j",
                "MASQUERADE",
            ])
            .output()
            .map_err(|e| Error::Network(format!("failed to check NAT rule: {}", e)))?;

        if !output.status.success() {
            // Rule doesn't exist, add it
            let output = Command::new("iptables")
                .args([
                    "-t",
                    "nat",
                    "-A",
                    "POSTROUTING",
                    "-s",
                    cidr,
                    "-j",
                    "MASQUERADE",
                ])
                .output()
                .map_err(|e| Error::Network(format!("failed to add NAT rule: {}", e)))?;

            if !output.status.success() {
                return Err(Error::Network(format!(
                    "failed to add NAT rule: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }

            tracing::info!("configured NAT masquerading");
        }

        Ok(())
    }

    /// Generate a MAC address for a machine.
    fn generate_mac(&self, machine_id: &str) -> String {
        // Use a locally administered MAC prefix (02:xx:xx)
        // Hash the machine ID to generate consistent MACs
        let hash = machine_id.bytes().fold(0u64, |acc, b| acc.wrapping_add(b as u64));
        format!(
            "02:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
            (hash >> 40) as u8 & 0xff,
            (hash >> 32) as u8 & 0xff,
            (hash >> 24) as u8 & 0xff,
            (hash >> 16) as u8 & 0xff,
            (hash >> 8) as u8 & 0xff,
        )
    }
}

#[async_trait]
impl Network for NetworkManager {
    async fn create_tap(&self, machine_id: &str) -> Result<TapDevice> {
        let tap_name = format!("tap-{}", &machine_id[..6.min(machine_id.len())]);
        let mac_address = self.generate_mac(machine_id);

        // Create TAP device
        let output = Command::new("ip")
            .args(["tuntap", "add", &tap_name, "mode", "tap"])
            .output()
            .map_err(|e| Error::Network(format!("failed to create TAP: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.contains("exists") {
                return Err(Error::Network(format!("failed to create TAP: {}", stderr)));
            }
        }

        // Set MAC address
        let output = Command::new("ip")
            .args(["link", "set", &tap_name, "address", &mac_address])
            .output()
            .map_err(|e| Error::Network(format!("failed to set TAP MAC: {}", e)))?;

        if !output.status.success() {
            return Err(Error::Network(format!(
                "failed to set TAP MAC: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        // Add to bridge
        let output = Command::new("ip")
            .args(["link", "set", &tap_name, "master", &self.bridge_name])
            .output()
            .map_err(|e| Error::Network(format!("failed to add TAP to bridge: {}", e)))?;

        if !output.status.success() {
            return Err(Error::Network(format!(
                "failed to add TAP to bridge: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        // Bring up TAP
        let output = Command::new("ip")
            .args(["link", "set", &tap_name, "up"])
            .output()
            .map_err(|e| Error::Network(format!("failed to bring up TAP: {}", e)))?;

        if !output.status.success() {
            return Err(Error::Network(format!(
                "failed to bring up TAP: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        tracing::debug!(tap = %tap_name, mac = %mac_address, "created TAP device");

        Ok(TapDevice {
            name: tap_name,
            mac_address,
        })
    }

    async fn delete_tap(&self, machine_id: &str) -> Result<()> {
        let tap_name = format!("tap-{}", &machine_id[..6.min(machine_id.len())]);

        let output = Command::new("ip")
            .args(["link", "delete", &tap_name])
            .output()
            .map_err(|e| Error::Network(format!("failed to delete TAP: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.contains("Cannot find device") {
                return Err(Error::Network(format!("failed to delete TAP: {}", stderr)));
            }
        }

        tracing::debug!(tap = %tap_name, "deleted TAP device");
        Ok(())
    }

    async fn allocate_ip(&self, machine_id: &str) -> Result<IpAddr> {
        let mut allocations = self.allocations.lock().unwrap();

        // Check if already allocated
        if let Some(ip) = allocations.get(machine_id) {
            return Ok(*ip);
        }

        // Allocate next IP
        let mut next = self.next_ip.lock().unwrap();
        if *next >= 254 {
            return Err(Error::Network("IP address pool exhausted".to_string()));
        }

        // Parse base IP from CIDR
        let base_ip: std::net::Ipv4Addr = self
            .bridge_cidr
            .split('/')
            .next()
            .unwrap()
            .parse()
            .map_err(|e| Error::Network(format!("invalid bridge CIDR: {}", e)))?;

        let octets = base_ip.octets();
        let ip = std::net::Ipv4Addr::new(octets[0], octets[1], octets[2], *next);
        *next += 1;

        let ip_addr = IpAddr::V4(ip);
        allocations.insert(machine_id.to_string(), ip_addr);

        tracing::debug!(machine_id = %machine_id, ip = %ip_addr, "allocated IP address");
        Ok(ip_addr)
    }

    async fn release_ip(&self, machine_id: &str) -> Result<()> {
        let mut allocations = self.allocations.lock().unwrap();
        allocations.remove(machine_id);
        tracing::debug!(machine_id = %machine_id, "released IP address");
        Ok(())
    }

    async fn get_machine_ip(&self, machine_id: &str) -> Result<Option<IpAddr>> {
        let allocations = self.allocations.lock().unwrap();
        Ok(allocations.get(machine_id).copied())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_mac() {
        let nm = NetworkManager::new("hfbr0".to_string(), "10.0.0.1/24".to_string());
        let mac1 = nm.generate_mac("abc123");
        let mac2 = nm.generate_mac("abc123");
        let mac3 = nm.generate_mac("xyz789");

        // Same input should produce same MAC
        assert_eq!(mac1, mac2);
        // Different input should produce different MAC
        assert_ne!(mac1, mac3);
        // Should be locally administered
        assert!(mac1.starts_with("02:"));
    }

    #[tokio::test]
    async fn test_ip_allocation() {
        let nm = NetworkManager::new("hfbr0".to_string(), "10.0.0.1/24".to_string());

        let ip1 = nm.allocate_ip("machine1").await.unwrap();
        let ip2 = nm.allocate_ip("machine2").await.unwrap();

        assert_ne!(ip1, ip2);
        assert_eq!(ip1.to_string(), "10.0.0.2");
        assert_eq!(ip2.to_string(), "10.0.0.3");

        // Same machine should get same IP
        let ip1_again = nm.allocate_ip("machine1").await.unwrap();
        assert_eq!(ip1, ip1_again);
    }
}
