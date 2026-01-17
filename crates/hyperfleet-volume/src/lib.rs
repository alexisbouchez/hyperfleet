// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet volume management.
//!
//! Handles creation, formatting, and lifecycle of persistent ext4 volumes
//! for Firecracker microVMs.

use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::process::Command;

use hyperfleet_common::traits::{Volume, VolumeManager};
use hyperfleet_common::{Error, Result};

/// File-based volume manager.
pub struct FileVolumeManager {
    /// Base directory for volume files.
    volumes_path: PathBuf,
}

impl FileVolumeManager {
    /// Create a new volume manager.
    pub fn new(volumes_path: PathBuf) -> Self {
        Self { volumes_path }
    }

    /// Ensure the volumes directory exists.
    pub async fn init(&self) -> Result<()> {
        tokio::fs::create_dir_all(&self.volumes_path)
            .await
            .map_err(|e| Error::Volume(format!("failed to create volumes directory: {}", e)))?;
        Ok(())
    }

    /// Get the path to a volume file.
    fn volume_path(&self, machine_id: &str) -> PathBuf {
        self.volumes_path.join(format!("{}.ext4", machine_id))
    }
}

#[async_trait]
impl VolumeManager for FileVolumeManager {
    async fn create(&self, machine_id: &str, size_mb: u64) -> Result<Volume> {
        let path = self.volume_path(machine_id);

        if path.exists() {
            return Err(Error::Volume(format!(
                "volume already exists: {}",
                machine_id
            )));
        }

        // Create sparse file
        let output = Command::new("dd")
            .args([
                "if=/dev/zero",
                &format!("of={}", path.display()),
                "bs=1M",
                &format!("count={}", size_mb),
                "conv=sparse",
            ])
            .output()
            .map_err(|e| Error::Volume(format!("failed to create volume file: {}", e)))?;

        if !output.status.success() {
            return Err(Error::Volume(format!(
                "failed to create volume file: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        // Format as ext4
        let output = Command::new("mkfs.ext4")
            .args([
                "-F", // Force, don't ask
                "-L",
                &format!("hf-{}", &machine_id[..6.min(machine_id.len())]),
                path.to_str().unwrap(),
            ])
            .output()
            .map_err(|e| Error::Volume(format!("failed to format volume: {}", e)))?;

        if !output.status.success() {
            // Clean up the file on failure
            let _ = std::fs::remove_file(&path);
            return Err(Error::Volume(format!(
                "failed to format volume: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        tracing::info!(
            machine_id = %machine_id,
            size_mb = size_mb,
            path = %path.display(),
            "created volume"
        );

        Ok(Volume {
            machine_id: machine_id.to_string(),
            path,
            size_mb,
        })
    }

    async fn delete(&self, machine_id: &str) -> Result<()> {
        let path = self.volume_path(machine_id);

        if !path.exists() {
            return Ok(()); // Idempotent
        }

        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| Error::Volume(format!("failed to delete volume: {}", e)))?;

        tracing::info!(machine_id = %machine_id, "deleted volume");
        Ok(())
    }

    async fn get_path(&self, machine_id: &str) -> Result<PathBuf> {
        let path = self.volume_path(machine_id);

        if !path.exists() {
            return Err(Error::Volume(format!("volume not found: {}", machine_id)));
        }

        Ok(path)
    }

    async fn exists(&self, machine_id: &str) -> Result<bool> {
        Ok(self.volume_path(machine_id).exists())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_volume_path() {
        let vm = FileVolumeManager::new(PathBuf::from("/tmp/volumes"));
        let path = vm.volume_path("abc123");
        assert_eq!(path, PathBuf::from("/tmp/volumes/abc123.ext4"));
    }

    #[tokio::test]
    async fn test_volume_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let vm = FileVolumeManager::new(tmp.path().to_path_buf());
        vm.init().await.unwrap();

        assert!(!vm.exists("nonexistent").await.unwrap());

        // Create a dummy file
        std::fs::write(tmp.path().join("test123.ext4"), b"dummy").unwrap();
        assert!(vm.exists("test123").await.unwrap());
    }
}
