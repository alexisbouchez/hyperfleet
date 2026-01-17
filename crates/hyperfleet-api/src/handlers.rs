// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! API request handlers.

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use hyperfleet_common::traits::{Network, Storage, Vmm, VolumeManager};
use hyperfleet_common::{
    Error, ExecRequest, ExecResponse, Gateway, Machine, MachineConfig, SpawnRequest,
    SpawnResponse, Webhook,
};

use crate::AppState;

/// Health check response.
#[derive(Serialize)]
pub struct HealthResponse {
    status: &'static str,
}

/// Health check endpoint.
pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

/// Error response.
#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// Convert Error to HTTP response.
fn error_response(err: Error) -> (StatusCode, Json<ErrorResponse>) {
    let status = match &err {
        Error::MachineNotFound(_) => StatusCode::NOT_FOUND,
        Error::GatewayNotFound { .. } => StatusCode::NOT_FOUND,
        Error::WebhookNotFound(_) => StatusCode::NOT_FOUND,
        Error::MachineAlreadyExists(_) => StatusCode::CONFLICT,
        Error::GatewayAlreadyExists { .. } => StatusCode::CONFLICT,
        Error::InvalidMachineState { .. } => StatusCode::CONFLICT,
        Error::ExecTimeout(_) => StatusCode::REQUEST_TIMEOUT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };

    (
        status,
        Json(ErrorResponse {
            error: err.to_string(),
        }),
    )
}

/// Create machine request.
#[derive(Deserialize)]
pub struct CreateMachineRequest {
    #[serde(default = "default_vcpu")]
    vcpu_count: u8,
    #[serde(default = "default_memory")]
    memory_mb: u32,
    #[serde(default = "default_volume_size")]
    volume_size_mb: u32,
    #[serde(default = "default_mount_path")]
    volume_mount_path: String,
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
}

fn default_vcpu() -> u8 {
    1
}
fn default_memory() -> u32 {
    512
}
fn default_volume_size() -> u32 {
    1024
}
fn default_mount_path() -> String {
    "/data".to_string()
}

/// List machines.
pub async fn list_machines<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
) -> Result<Json<Vec<Machine>>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .list_machines()
        .await
        .map(Json)
        .map_err(error_response)
}

/// Create a machine.
pub async fn create_machine<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Json(req): Json<CreateMachineRequest>,
) -> Result<(StatusCode, Json<Machine>), (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    let config = MachineConfig {
        vcpu_count: req.vcpu_count,
        memory_mb: req.memory_mb,
        volume_size_mb: req.volume_size_mb,
        volume_mount_path: req.volume_mount_path,
        env: req.env,
    };

    state
        .service
        .create_machine(config)
        .await
        .map(|m| (StatusCode::CREATED, Json(m)))
        .map_err(error_response)
}

/// Get a machine.
pub async fn get_machine<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
) -> Result<Json<Machine>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .get_machine(&id)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Delete a machine.
pub async fn delete_machine<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .delete_machine(&id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(error_response)
}

/// Start a machine.
pub async fn start_machine<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
) -> Result<Json<Machine>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .start_machine(&id)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Stop a machine.
pub async fn stop_machine<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
) -> Result<Json<Machine>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .stop_machine(&id)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Execute a command.
pub async fn exec<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Json(req): Json<ExecRequest>,
) -> Result<Json<ExecResponse>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .exec(&id, req)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Query parameters for file operations.
#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
}

/// List directory contents.
pub async fn list_files<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .list_files(&id, &query.path)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Read file content.
pub async fn read_file<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .read_file(&id, &query.path)
        .await
        .map(Bytes::from)
        .map_err(error_response)
}

/// Write file content.
pub async fn write_file<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .write_file(&id, &query.path, &body)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(error_response)
}

/// Delete file or directory.
pub async fn delete_file<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .delete_file(&id, &query.path)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(error_response)
}

/// Create directory.
pub async fn mkdir<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .mkdir(&id, &query.path)
        .await
        .map(|_| StatusCode::CREATED)
        .map_err(error_response)
}

/// Gateway creation request.
#[derive(Deserialize)]
pub struct CreateGatewayRequest {
    port: u16,
}

/// List gateways.
pub async fn list_gateways<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Gateway>>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .list_gateways(&id)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Create a gateway.
pub async fn create_gateway<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Json(req): Json<CreateGatewayRequest>,
) -> Result<(StatusCode, Json<Gateway>), (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .create_gateway(&id, req.port)
        .await
        .map(|g| (StatusCode::CREATED, Json(g)))
        .map_err(error_response)
}

/// Delete a gateway.
pub async fn delete_gateway<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path((id, port)): Path<(String, u16)>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .delete_gateway(&id, port)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(error_response)
}

/// Spawn a child machine.
pub async fn spawn_child<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Json(req): Json<SpawnRequest>,
) -> Result<(StatusCode, Json<SpawnResponse>), (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .spawn_child(&id, req)
        .await
        .map(|r| (StatusCode::CREATED, Json(r)))
        .map_err(error_response)
}

/// List children.
pub async fn list_children<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Machine>>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .list_children(&id)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Webhook creation request.
#[derive(Deserialize)]
pub struct CreateWebhookRequest {
    url: String,
    events: Vec<String>,
}

/// List webhooks.
pub async fn list_webhooks<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Webhook>>, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .list_webhooks(&id)
        .await
        .map(Json)
        .map_err(error_response)
}

/// Create a webhook.
pub async fn create_webhook<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path(id): Path<String>,
    Json(req): Json<CreateWebhookRequest>,
) -> Result<(StatusCode, Json<Webhook>), (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .create_webhook(&id, req.url, req.events)
        .await
        .map(|w| (StatusCode::CREATED, Json(w)))
        .map_err(error_response)
}

/// Delete a webhook.
pub async fn delete_webhook<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    Path((_id, hook_id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    state
        .service
        .delete_webhook(&hook_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(error_response)
}
