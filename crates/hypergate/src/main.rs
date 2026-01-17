// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hypergate - Reverse proxy for Hyperfleet.
//!
//! Routes traffic to:
//! - api.hyperfleet.local → hyperfleet-daemon API
//! - <port>-<machine-id>.gw.hyperfleet.local → machine ports

use anyhow::{Context, Result};
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tracing::{error, info, warn};

use hyperfleet_common::traits::Storage;
use hyperfleet_db::SqliteStorage;

/// Proxy configuration.
struct ProxyConfig {
    /// API subdomain (e.g., "api.hyperfleet.local").
    api_host: String,
    /// Gateway domain suffix (e.g., "gw.hyperfleet.local").
    gw_domain: String,
    /// Backend API address.
    api_backend: String,
    /// Bridge network prefix (e.g., "10.0.0").
    bridge_prefix: String,
}

/// Proxy state.
struct ProxyState {
    config: ProxyConfig,
    storage: Arc<SqliteStorage>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("hypergate=info".parse().unwrap()),
        )
        .init();

    // Load configuration from environment
    let config = ProxyConfig {
        api_host: std::env::var("HYPERGATE_API_HOST")
            .unwrap_or_else(|_| "api.hyperfleet.local".to_string()),
        gw_domain: std::env::var("HYPERGATE_GW_DOMAIN")
            .unwrap_or_else(|_| "gw.hyperfleet.local".to_string()),
        api_backend: std::env::var("HYPERGATE_API_BACKEND")
            .unwrap_or_else(|_| "127.0.0.1:8080".to_string()),
        bridge_prefix: std::env::var("HYPERGATE_BRIDGE_PREFIX")
            .unwrap_or_else(|_| "10.0.0".to_string()),
    };

    let db_url = std::env::var("HYPERFLEET_DB_URL")
        .unwrap_or_else(|_| "sqlite:///var/lib/hyperfleet/hyperfleet.db".to_string());

    let storage = SqliteStorage::new(&db_url)
        .await
        .context("failed to connect to database")?;

    let state = Arc::new(ProxyState {
        config,
        storage: Arc::new(storage),
    });

    let listen_addr: SocketAddr = std::env::var("HYPERGATE_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:80".to_string())
        .parse()
        .context("invalid listen address")?;

    let listener = TcpListener::bind(listen_addr)
        .await
        .context("failed to bind")?;

    info!("hypergate listening on {}", listen_addr);

    loop {
        let (stream, remote_addr) = listener.accept().await?;
        let state = state.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, remote_addr, state).await {
                error!("connection error: {}", e);
            }
        });
    }
}

async fn handle_connection(
    stream: TcpStream,
    remote_addr: SocketAddr,
    state: Arc<ProxyState>,
) -> Result<()> {
    let io = TokioIo::new(stream);

    http1::Builder::new()
        .serve_connection(
            io,
            service_fn(|req| {
                let state = state.clone();
                async move { handle_request(req, state).await }
            }),
        )
        .await
        .context("http connection error")
}

async fn handle_request(
    req: Request<Incoming>,
    state: Arc<ProxyState>,
) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
    // Get the Host header
    let host = req
        .headers()
        .get("Host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    // Route based on host
    if host == state.config.api_host || host.starts_with(&format!("{}:", state.config.api_host)) {
        // Proxy to API backend
        proxy_to_backend(req, &state.config.api_backend).await
    } else if host.ends_with(&state.config.gw_domain) {
        // Gateway request - parse port and machine ID
        let subdomain = host
            .strip_suffix(&format!(".{}", state.config.gw_domain))
            .unwrap_or("");

        if let Some((port_str, machine_id)) = subdomain.split_once('-') {
            if let Ok(port) = port_str.parse::<u16>() {
                // Look up the gateway in the database
                if let Ok(Some(gateway)) = state.storage.get_gateway(machine_id, port).await {
                    // Get machine IP from bridge network
                    // For now, we use a simple IP calculation based on machine position
                    // In production, this would query the network manager
                    let machine_ip = format!("{}.{}", state.config.bridge_prefix, 2);
                    let backend = format!("{}:{}", machine_ip, port);
                    return proxy_to_backend(req, &backend).await;
                }
            }
        }

        Ok(error_response(StatusCode::NOT_FOUND, "Gateway not found"))
    } else {
        Ok(error_response(StatusCode::BAD_REQUEST, "Unknown host"))
    }
}

async fn proxy_to_backend(
    req: Request<Incoming>,
    backend: &str,
) -> Result<Response<BoxBody<Bytes, hyper::Error>>> {
    // Connect to backend
    let stream = match TcpStream::connect(backend).await {
        Ok(s) => s,
        Err(e) => {
            warn!("failed to connect to backend {}: {}", backend, e);
            return Ok(error_response(
                StatusCode::BAD_GATEWAY,
                "Backend unavailable",
            ));
        }
    };

    let io = TokioIo::new(stream);

    // Create a client connection
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .context("handshake failed")?;

    // Spawn connection handler
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            error!("backend connection error: {}", e);
        }
    });

    // Convert request body
    let (parts, body) = req.into_parts();
    let body = body.collect().await?.to_bytes();
    let new_req = Request::from_parts(parts, Full::new(body));

    // Send request to backend
    let resp = sender
        .send_request(new_req)
        .await
        .context("failed to send request")?;

    // Convert response
    let (parts, body) = resp.into_parts();
    let body = body.boxed();

    Ok(Response::from_parts(parts, body))
}

fn error_response(status: StatusCode, message: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
    let body = format!("{{\"error\": \"{}\"}}", message);
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body)).map_err(|e| match e {}).boxed())
        .unwrap()
}
