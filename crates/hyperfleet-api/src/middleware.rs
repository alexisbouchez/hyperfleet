// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! API middleware.

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use hyperfleet_common::traits::{Network, Storage, Vmm, VolumeManager};

use crate::AppState;

/// Authentication middleware.
pub async fn auth<S, V, N, Vol>(
    State(state): State<Arc<AppState<S, V, N, Vol>>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode>
where
    S: Storage + 'static,
    V: Vmm + 'static,
    N: Network + 'static,
    Vol: VolumeManager + 'static,
{
    // Extract Authorization header
    let auth_header = request
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok());

    let token = auth_header
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");

    // Validate token
    if token != state.api_key {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}
