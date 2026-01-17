// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet SQLite storage layer.

use async_trait::async_trait;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::collections::HashMap;

use hyperfleet_common::{
    traits::Storage, Error, Gateway, Machine, MachineStatus, Result, Webhook,
};

/// SQLite-backed storage implementation.
pub struct SqliteStorage {
    pool: SqlitePool,
}

impl SqliteStorage {
    /// Create a new SQLite storage instance.
    pub async fn new(database_url: &str) -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await
            .map_err(|e| Error::Database(e.to_string()))?;

        let storage = Self { pool };
        storage.run_migrations().await?;
        Ok(storage)
    }

    /// Create an in-memory SQLite storage for testing.
    pub async fn in_memory() -> Result<Self> {
        Self::new("sqlite::memory:").await
    }

    /// Run database migrations.
    async fn run_migrations(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                vcpu_count INTEGER NOT NULL,
                memory_mb INTEGER NOT NULL,
                volume_size_mb INTEGER NOT NULL,
                volume_mount_path TEXT NOT NULL,
                env TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS gateways (
                machine_id TEXT NOT NULL,
                port INTEGER NOT NULL,
                subdomain TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (machine_id, port),
                FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
            )
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS webhooks (
                id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                url TEXT NOT NULL,
                events TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
            )
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(())
    }
}

#[async_trait]
impl Storage for SqliteStorage {
    async fn create_machine(&self, machine: &Machine) -> Result<()> {
        let env_json = serde_json::to_string(&machine.env)?;
        let status_str = machine.status.to_string();

        sqlx::query(
            r#"
            INSERT INTO machines (id, parent_id, vcpu_count, memory_mb, volume_size_mb,
                volume_mount_path, env, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&machine.id)
        .bind(&machine.parent_id)
        .bind(machine.vcpu_count as i32)
        .bind(machine.memory_mb as i32)
        .bind(machine.volume_size_mb as i32)
        .bind(&machine.volume_mount_path)
        .bind(&env_json)
        .bind(&status_str)
        .bind(machine.created_at)
        .bind(machine.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(())
    }

    async fn get_machine(&self, id: &str) -> Result<Option<Machine>> {
        let row: Option<MachineRow> = sqlx::query_as(
            r#"
            SELECT id, parent_id, vcpu_count, memory_mb, volume_size_mb,
                volume_mount_path, env, status, created_at, updated_at
            FROM machines WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        row.map(|r| r.try_into()).transpose()
    }

    async fn list_machines(&self) -> Result<Vec<Machine>> {
        let rows: Vec<MachineRow> = sqlx::query_as(
            r#"
            SELECT id, parent_id, vcpu_count, memory_mb, volume_size_mb,
                volume_mount_path, env, status, created_at, updated_at
            FROM machines ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.try_into()).collect()
    }

    async fn update_machine(&self, machine: &Machine) -> Result<()> {
        let env_json = serde_json::to_string(&machine.env)?;
        let status_str = machine.status.to_string();

        let result = sqlx::query(
            r#"
            UPDATE machines SET parent_id = ?, vcpu_count = ?, memory_mb = ?,
                volume_size_mb = ?, volume_mount_path = ?, env = ?, status = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&machine.parent_id)
        .bind(machine.vcpu_count as i32)
        .bind(machine.memory_mb as i32)
        .bind(machine.volume_size_mb as i32)
        .bind(&machine.volume_mount_path)
        .bind(&env_json)
        .bind(&status_str)
        .bind(machine.updated_at)
        .bind(&machine.id)
        .execute(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(Error::MachineNotFound(machine.id.clone()));
        }

        Ok(())
    }

    async fn delete_machine(&self, id: &str) -> Result<()> {
        let result = sqlx::query("DELETE FROM machines WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| Error::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(Error::MachineNotFound(id.to_string()));
        }

        Ok(())
    }

    async fn create_gateway(&self, gateway: &Gateway) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO gateways (machine_id, port, subdomain, created_at)
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(&gateway.machine_id)
        .bind(gateway.port as i32)
        .bind(&gateway.subdomain)
        .bind(gateway.created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(())
    }

    async fn get_gateway(&self, machine_id: &str, port: u16) -> Result<Option<Gateway>> {
        let row: Option<GatewayRow> = sqlx::query_as(
            r#"
            SELECT machine_id, port, subdomain, created_at
            FROM gateways WHERE machine_id = ? AND port = ?
            "#,
        )
        .bind(machine_id)
        .bind(port as i32)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(row.map(|r| r.into()))
    }

    async fn list_gateways(&self, machine_id: &str) -> Result<Vec<Gateway>> {
        let rows: Vec<GatewayRow> = sqlx::query_as(
            r#"
            SELECT machine_id, port, subdomain, created_at
            FROM gateways WHERE machine_id = ? ORDER BY port
            "#,
        )
        .bind(machine_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(rows.into_iter().map(|r| r.into()).collect())
    }

    async fn list_all_gateways(&self) -> Result<Vec<Gateway>> {
        let rows: Vec<GatewayRow> = sqlx::query_as(
            r#"
            SELECT machine_id, port, subdomain, created_at
            FROM gateways ORDER BY machine_id, port
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(rows.into_iter().map(|r| r.into()).collect())
    }

    async fn delete_gateway(&self, machine_id: &str, port: u16) -> Result<()> {
        let result = sqlx::query("DELETE FROM gateways WHERE machine_id = ? AND port = ?")
            .bind(machine_id)
            .bind(port as i32)
            .execute(&self.pool)
            .await
            .map_err(|e| Error::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(Error::GatewayNotFound {
                machine_id: machine_id.to_string(),
                port,
            });
        }

        Ok(())
    }

    async fn create_webhook(&self, webhook: &Webhook) -> Result<()> {
        let events_json = serde_json::to_string(&webhook.events)?;

        sqlx::query(
            r#"
            INSERT INTO webhooks (id, machine_id, url, events, created_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&webhook.id)
        .bind(&webhook.machine_id)
        .bind(&webhook.url)
        .bind(&events_json)
        .bind(webhook.created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(())
    }

    async fn get_webhook(&self, id: &str) -> Result<Option<Webhook>> {
        let row: Option<WebhookRow> = sqlx::query_as(
            r#"
            SELECT id, machine_id, url, events, created_at
            FROM webhooks WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        row.map(|r| r.try_into()).transpose()
    }

    async fn list_webhooks(&self, machine_id: &str) -> Result<Vec<Webhook>> {
        let rows: Vec<WebhookRow> = sqlx::query_as(
            r#"
            SELECT id, machine_id, url, events, created_at
            FROM webhooks WHERE machine_id = ? ORDER BY created_at
            "#,
        )
        .bind(machine_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| Error::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.try_into()).collect()
    }

    async fn delete_webhook(&self, id: &str) -> Result<()> {
        let result = sqlx::query("DELETE FROM webhooks WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| Error::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(Error::WebhookNotFound(id.to_string()));
        }

        Ok(())
    }
}

/// Internal row type for machines.
#[derive(sqlx::FromRow)]
struct MachineRow {
    id: String,
    parent_id: Option<String>,
    vcpu_count: i32,
    memory_mb: i32,
    volume_size_mb: i32,
    volume_mount_path: String,
    env: String,
    status: String,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<MachineRow> for Machine {
    type Error = Error;

    fn try_from(row: MachineRow) -> Result<Self> {
        let env: HashMap<String, String> = serde_json::from_str(&row.env)?;
        let status = match row.status.as_str() {
            "stopped" => MachineStatus::Stopped,
            "starting" => MachineStatus::Starting,
            "running" => MachineStatus::Running,
            "stopping" => MachineStatus::Stopping,
            "failed" => MachineStatus::Failed,
            _ => return Err(Error::Internal(format!("unknown status: {}", row.status))),
        };

        Ok(Machine {
            id: row.id,
            parent_id: row.parent_id,
            vcpu_count: row.vcpu_count as u8,
            memory_mb: row.memory_mb as u32,
            volume_size_mb: row.volume_size_mb as u32,
            volume_mount_path: row.volume_mount_path,
            env,
            status,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

/// Internal row type for gateways.
#[derive(sqlx::FromRow)]
struct GatewayRow {
    machine_id: String,
    port: i32,
    subdomain: String,
    created_at: i64,
}

impl From<GatewayRow> for Gateway {
    fn from(row: GatewayRow) -> Self {
        Gateway {
            machine_id: row.machine_id,
            port: row.port as u16,
            subdomain: row.subdomain,
            created_at: row.created_at,
        }
    }
}

/// Internal row type for webhooks.
#[derive(sqlx::FromRow)]
struct WebhookRow {
    id: String,
    machine_id: String,
    url: String,
    events: String,
    created_at: i64,
}

impl TryFrom<WebhookRow> for Webhook {
    type Error = Error;

    fn try_from(row: WebhookRow) -> Result<Self> {
        let events: Vec<String> = serde_json::from_str(&row.events)?;
        Ok(Webhook {
            id: row.id,
            machine_id: row.machine_id,
            url: row.url,
            events,
            created_at: row.created_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperfleet_common::MachineConfig;

    #[tokio::test]
    async fn test_machine_crud() {
        let storage = SqliteStorage::in_memory().await.unwrap();

        // Create
        let machine = Machine::new(MachineConfig::default());
        storage.create_machine(&machine).await.unwrap();

        // Read
        let fetched = storage.get_machine(&machine.id).await.unwrap().unwrap();
        assert_eq!(fetched.id, machine.id);
        assert_eq!(fetched.status, MachineStatus::Stopped);

        // List
        let machines = storage.list_machines().await.unwrap();
        assert_eq!(machines.len(), 1);

        // Update
        let mut updated = fetched.clone();
        updated.status = MachineStatus::Running;
        storage.update_machine(&updated).await.unwrap();

        let fetched = storage.get_machine(&machine.id).await.unwrap().unwrap();
        assert_eq!(fetched.status, MachineStatus::Running);

        // Delete
        storage.delete_machine(&machine.id).await.unwrap();
        let fetched = storage.get_machine(&machine.id).await.unwrap();
        assert!(fetched.is_none());
    }

    #[tokio::test]
    async fn test_gateway_crud() {
        let storage = SqliteStorage::in_memory().await.unwrap();

        // Create machine first
        let machine = Machine::new(MachineConfig::default());
        storage.create_machine(&machine).await.unwrap();

        // Create gateway
        let gateway = Gateway {
            machine_id: machine.id.clone(),
            port: 8080,
            subdomain: format!("8080-{}.gw.hyperfleet.local", machine.id),
            created_at: 1234567890,
        };
        storage.create_gateway(&gateway).await.unwrap();

        // Get gateway
        let fetched = storage
            .get_gateway(&machine.id, 8080)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fetched.port, 8080);

        // List gateways
        let gateways = storage.list_gateways(&machine.id).await.unwrap();
        assert_eq!(gateways.len(), 1);

        // Delete gateway
        storage.delete_gateway(&machine.id, 8080).await.unwrap();
        let fetched = storage.get_gateway(&machine.id, 8080).await.unwrap();
        assert!(fetched.is_none());
    }

    #[tokio::test]
    async fn test_webhook_crud() {
        let storage = SqliteStorage::in_memory().await.unwrap();

        // Create machine first
        let machine = Machine::new(MachineConfig::default());
        storage.create_machine(&machine).await.unwrap();

        // Create webhook
        let webhook = Webhook {
            id: "webhook123".to_string(),
            machine_id: machine.id.clone(),
            url: "http://example.com/webhook".to_string(),
            events: vec!["machine.stopped".to_string()],
            created_at: 1234567890,
        };
        storage.create_webhook(&webhook).await.unwrap();

        // Get webhook
        let fetched = storage.get_webhook("webhook123").await.unwrap().unwrap();
        assert_eq!(fetched.url, "http://example.com/webhook");

        // List webhooks
        let webhooks = storage.list_webhooks(&machine.id).await.unwrap();
        assert_eq!(webhooks.len(), 1);

        // Delete webhook
        storage.delete_webhook("webhook123").await.unwrap();
        let fetched = storage.get_webhook("webhook123").await.unwrap();
        assert!(fetched.is_none());
    }
}
