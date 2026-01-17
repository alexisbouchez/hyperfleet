// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Hyperfleet REST API layer.

mod handlers;
mod middleware;

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use std::sync::Arc;
use tower_http::trace::TraceLayer;

use hyperfleet_common::traits::{Network, Storage, Vmm, VolumeManager};
use hyperfleet_core::MachineService;

/// Application state shared across handlers.
pub struct AppState<S, V, N, Vol>
where
    S: Storage,
    V: Vmm,
    N: Network,
    Vol: VolumeManager,
{
    pub service: Arc<MachineService<S, V, N, Vol>>,
    pub api_key: String,
}

/// Create the API router.
pub fn create_router<S, V, N, Vol>(state: Arc<AppState<S, V, N, Vol>>) -> Router
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    let api_routes = Router::new()
        // Machines
        .route("/machines", get(handlers::list_machines::<S, V, N, Vol>))
        .route("/machines", post(handlers::create_machine::<S, V, N, Vol>))
        .route(
            "/machines/{id}",
            get(handlers::get_machine::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}",
            delete(handlers::delete_machine::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/start",
            post(handlers::start_machine::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/stop",
            post(handlers::stop_machine::<S, V, N, Vol>),
        )
        // Exec
        .route("/machines/{id}/exec", post(handlers::exec::<S, V, N, Vol>))
        // Files
        .route(
            "/machines/{id}/files",
            get(handlers::list_files::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/files",
            delete(handlers::delete_file::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/files/content",
            get(handlers::read_file::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/files/content",
            put(handlers::write_file::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/files/mkdir",
            post(handlers::mkdir::<S, V, N, Vol>),
        )
        // Gateways
        .route(
            "/machines/{id}/gateways",
            get(handlers::list_gateways::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/gateways",
            post(handlers::create_gateway::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/gateways/{port}",
            delete(handlers::delete_gateway::<S, V, N, Vol>),
        )
        // Orchestration
        .route(
            "/machines/{id}/spawn",
            post(handlers::spawn_child::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/children",
            get(handlers::list_children::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/webhooks",
            get(handlers::list_webhooks::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/webhooks",
            post(handlers::create_webhook::<S, V, N, Vol>),
        )
        .route(
            "/machines/{id}/webhooks/{hook_id}",
            delete(handlers::delete_webhook::<S, V, N, Vol>),
        )
        // Apply auth middleware
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::auth::<S, V, N, Vol>,
        ));

    Router::new()
        .nest("/v1", api_routes)
        .route("/health", get(handlers::health))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
