// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet CLI client.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::io::{self, Read, Write};

use hyperfleet_common::{ExecRequest, ExecResponse, Gateway, Machine, SpawnRequest, Webhook};

/// Hyperfleet CLI - Manage Firecracker microVMs
#[derive(Parser)]
#[command(name = "hf")]
#[command(about = "Hyperfleet CLI for managing microVMs")]
struct Cli {
    /// API URL (default: HYPERFLEET_API_URL or http://localhost:8080)
    #[arg(long, env = "HYPERFLEET_API_URL")]
    api_url: Option<String>,

    /// API key (default: HYPERFLEET_API_KEY)
    #[arg(long, env = "HYPERFLEET_API_KEY")]
    api_key: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Machine management
    Machines {
        #[command(subcommand)]
        action: MachinesAction,
    },
    /// Execute command in a machine
    Exec {
        /// Machine ID
        id: String,
        /// Command and arguments (after --)
        #[arg(last = true)]
        cmd: Vec<String>,
        /// Environment variables (KEY=VALUE)
        #[arg(short, long)]
        env: Vec<String>,
        /// Timeout in seconds
        #[arg(short, long, default_value = "30")]
        timeout: u32,
    },
    /// Filesystem operations
    Files {
        #[command(subcommand)]
        action: FilesAction,
    },
    /// Gateway management
    Gateways {
        #[command(subcommand)]
        action: GatewaysAction,
    },
}

#[derive(Subcommand)]
enum MachinesAction {
    /// List all machines
    List,
    /// Create a new machine
    Create {
        /// Number of vCPUs
        #[arg(long, default_value = "1")]
        vcpus: u8,
        /// Memory in MB
        #[arg(long, default_value = "512")]
        memory: u32,
        /// Volume size in MB
        #[arg(long, default_value = "1024")]
        volume_size: u32,
        /// Volume mount path
        #[arg(long, default_value = "/data")]
        volume_mount: String,
        /// Environment variables (KEY=VALUE)
        #[arg(short, long)]
        env: Vec<String>,
    },
    /// Get machine details
    Get {
        /// Machine ID
        id: String,
    },
    /// Start a machine
    Start {
        /// Machine ID
        id: String,
    },
    /// Stop a machine
    Stop {
        /// Machine ID
        id: String,
    },
    /// Delete a machine
    Delete {
        /// Machine ID
        id: String,
    },
    /// Spawn a child machine
    Spawn {
        /// Parent machine ID
        id: String,
        /// Number of vCPUs
        #[arg(long, default_value = "1")]
        vcpus: u8,
        /// Memory in MB
        #[arg(long, default_value = "512")]
        memory: u32,
        /// Inherit environment from parent
        #[arg(long, default_value = "true")]
        inherit_env: bool,
        /// Additional environment variables (KEY=VALUE)
        #[arg(short, long)]
        env: Vec<String>,
        /// Webhook URL
        #[arg(long)]
        webhook_url: Option<String>,
    },
    /// List child machines
    Children {
        /// Parent machine ID
        id: String,
    },
}

#[derive(Subcommand)]
enum FilesAction {
    /// List directory contents
    Ls {
        /// Machine ID
        id: String,
        /// Path in machine
        path: String,
    },
    /// Read file contents
    Cat {
        /// Machine ID
        id: String,
        /// Path in machine
        path: String,
    },
    /// Write content to file (reads from stdin)
    Write {
        /// Machine ID
        id: String,
        /// Path in machine
        path: String,
    },
    /// Delete file or directory
    Rm {
        /// Machine ID
        id: String,
        /// Path in machine
        path: String,
    },
    /// Create directory
    Mkdir {
        /// Machine ID
        id: String,
        /// Path in machine
        path: String,
    },
}

#[derive(Subcommand)]
enum GatewaysAction {
    /// List gateways for a machine
    List {
        /// Machine ID
        id: String,
    },
    /// Create a gateway
    Create {
        /// Machine ID
        id: String,
        /// Port to expose
        #[arg(long)]
        port: u16,
    },
    /// Delete a gateway
    Delete {
        /// Machine ID
        id: String,
        /// Port
        #[arg(long)]
        port: u16,
    },
}

/// API client wrapper.
struct Client {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

impl Client {
    fn new(base_url: String, api_key: String) -> Self {
        Self {
            base_url,
            api_key,
            http: reqwest::Client::new(),
        }
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let resp = self
            .http
            .get(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("API error {}: {}", status, body);
        }

        resp.json().await.context("failed to parse response")
    }

    async fn post<T: serde::de::DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let resp = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.api_key)
            .json(body)
            .send()
            .await
            .context("request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("API error {}: {}", status, body);
        }

        resp.json().await.context("failed to parse response")
    }

    async fn post_empty<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let resp = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("API error {}: {}", status, body);
        }

        resp.json().await.context("failed to parse response")
    }

    async fn delete(&self, path: &str) -> Result<()> {
        let resp = self
            .http
            .delete(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("API error {}: {}", status, body);
        }

        Ok(())
    }

    async fn get_bytes(&self, path: &str) -> Result<Vec<u8>> {
        let resp = self
            .http
            .get(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("API error {}: {}", status, body);
        }

        Ok(resp.bytes().await?.to_vec())
    }

    async fn put_bytes(&self, path: &str, body: Vec<u8>) -> Result<()> {
        let resp = self
            .http
            .put(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.api_key)
            .body(body)
            .send()
            .await
            .context("request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("API error {}: {}", status, body);
        }

        Ok(())
    }
}

fn parse_env_vars(vars: &[String]) -> HashMap<String, String> {
    vars.iter()
        .filter_map(|v| {
            let parts: Vec<&str> = v.splitn(2, '=').collect();
            if parts.len() == 2 {
                Some((parts[0].to_string(), parts[1].to_string()))
            } else {
                None
            }
        })
        .collect()
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let api_url = cli
        .api_url
        .unwrap_or_else(|| "http://localhost:8080".to_string());
    let api_key = cli.api_key.unwrap_or_else(|| "unsecure".to_string());

    let client = Client::new(api_url, api_key);

    match cli.command {
        Commands::Machines { action } => match action {
            MachinesAction::List => {
                let machines: Vec<Machine> = client.get("/v1/machines").await?;
                println!(
                    "{:<12} {:<10} {:>5} {:>6} {:>8}",
                    "ID", "STATUS", "VCPU", "MEM", "VOLUME"
                );
                for m in machines {
                    println!(
                        "{:<12} {:<10} {:>5} {:>5}M {:>7}M",
                        m.id, m.status, m.vcpu_count, m.memory_mb, m.volume_size_mb
                    );
                }
            }
            MachinesAction::Create {
                vcpus,
                memory,
                volume_size,
                volume_mount,
                env,
            } => {
                #[derive(serde::Serialize)]
                struct CreateReq {
                    vcpu_count: u8,
                    memory_mb: u32,
                    volume_size_mb: u32,
                    volume_mount_path: String,
                    env: HashMap<String, String>,
                }

                let machine: Machine = client
                    .post(
                        "/v1/machines",
                        &CreateReq {
                            vcpu_count: vcpus,
                            memory_mb: memory,
                            volume_size_mb: volume_size,
                            volume_mount_path: volume_mount,
                            env: parse_env_vars(&env),
                        },
                    )
                    .await?;

                println!("Created machine: {}", machine.id);
            }
            MachinesAction::Get { id } => {
                let machine: Machine = client.get(&format!("/v1/machines/{}", id)).await?;
                println!("{}", serde_json::to_string_pretty(&machine)?);
            }
            MachinesAction::Start { id } => {
                let machine: Machine =
                    client.post_empty(&format!("/v1/machines/{}/start", id)).await?;
                println!("Started machine: {} (status: {})", machine.id, machine.status);
            }
            MachinesAction::Stop { id } => {
                let machine: Machine =
                    client.post_empty(&format!("/v1/machines/{}/stop", id)).await?;
                println!("Stopped machine: {} (status: {})", machine.id, machine.status);
            }
            MachinesAction::Delete { id } => {
                client.delete(&format!("/v1/machines/{}", id)).await?;
                println!("Deleted machine: {}", id);
            }
            MachinesAction::Spawn {
                id,
                vcpus,
                memory,
                inherit_env,
                env,
                webhook_url,
            } => {
                let req = SpawnRequest {
                    vcpu_count: vcpus,
                    memory_mb: memory,
                    inherit_env,
                    env: parse_env_vars(&env),
                    webhook_url,
                };

                #[derive(serde::Deserialize)]
                struct SpawnResp {
                    id: String,
                    parent_id: String,
                    status: String,
                }

                let resp: SpawnResp = client
                    .post(&format!("/v1/machines/{}/spawn", id), &req)
                    .await?;
                println!(
                    "Spawned child {} (parent: {}, status: {})",
                    resp.id, resp.parent_id, resp.status
                );
            }
            MachinesAction::Children { id } => {
                let machines: Vec<Machine> =
                    client.get(&format!("/v1/machines/{}/children", id)).await?;
                println!("{:<12} {:<10} {:>5} {:>6}", "ID", "STATUS", "VCPU", "MEM");
                for m in machines {
                    println!(
                        "{:<12} {:<10} {:>5} {:>5}M",
                        m.id, m.status, m.vcpu_count, m.memory_mb
                    );
                }
            }
        },
        Commands::Exec {
            id,
            cmd,
            env,
            timeout,
        } => {
            if cmd.is_empty() {
                anyhow::bail!("No command specified. Use -- before command, e.g.: hf exec <id> -- ls -la");
            }

            let req = ExecRequest {
                cmd,
                env: parse_env_vars(&env),
                timeout_seconds: timeout,
            };

            let resp: ExecResponse = client
                .post(&format!("/v1/machines/{}/exec", id), &req)
                .await?;

            if !resp.stdout.is_empty() {
                print!("{}", resp.stdout);
            }
            if !resp.stderr.is_empty() {
                eprint!("{}", resp.stderr);
            }

            std::process::exit(resp.exit_code);
        }
        Commands::Files { action } => match action {
            FilesAction::Ls { id, path } => {
                let encoded = urlencoding::encode(&path);
                let entries: Vec<String> =
                    client.get(&format!("/v1/machines/{}/files?path={}", id, encoded)).await?;
                for entry in entries {
                    println!("{}", entry);
                }
            }
            FilesAction::Cat { id, path } => {
                let encoded = urlencoding::encode(&path);
                let content = client
                    .get_bytes(&format!("/v1/machines/{}/files/content?path={}", id, encoded))
                    .await?;
                io::stdout().write_all(&content)?;
            }
            FilesAction::Write { id, path } => {
                let mut content = Vec::new();
                io::stdin().read_to_end(&mut content)?;

                let encoded = urlencoding::encode(&path);
                client
                    .put_bytes(
                        &format!("/v1/machines/{}/files/content?path={}", id, encoded),
                        content,
                    )
                    .await?;
                println!("Written to {}", path);
            }
            FilesAction::Rm { id, path } => {
                let encoded = urlencoding::encode(&path);
                client
                    .delete(&format!("/v1/machines/{}/files?path={}", id, encoded))
                    .await?;
                println!("Deleted {}", path);
            }
            FilesAction::Mkdir { id, path } => {
                let encoded = urlencoding::encode(&path);
                client
                    .post_empty::<serde_json::Value>(&format!(
                        "/v1/machines/{}/files/mkdir?path={}",
                        id, encoded
                    ))
                    .await
                    .ok(); // mkdir returns empty response
                println!("Created directory {}", path);
            }
        },
        Commands::Gateways { action } => match action {
            GatewaysAction::List { id } => {
                let gateways: Vec<Gateway> =
                    client.get(&format!("/v1/machines/{}/gateways", id)).await?;
                println!("{:<8} {}", "PORT", "SUBDOMAIN");
                for gw in gateways {
                    println!("{:<8} {}", gw.port, gw.subdomain);
                }
            }
            GatewaysAction::Create { id, port } => {
                #[derive(serde::Serialize)]
                struct CreateGwReq {
                    port: u16,
                }

                let gw: Gateway = client
                    .post(
                        &format!("/v1/machines/{}/gateways", id),
                        &CreateGwReq { port },
                    )
                    .await?;
                println!("Created gateway: {}", gw.subdomain);
            }
            GatewaysAction::Delete { id, port } => {
                client
                    .delete(&format!("/v1/machines/{}/gateways/{}", id, port))
                    .await?;
                println!("Deleted gateway on port {}", port);
            }
        },
    }

    Ok(())
}
