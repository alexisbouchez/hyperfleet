// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! Vsock client for communicating with hyperinit.

use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use hyperfleet_common::{Error, ExecRequest, ExecResponse, Result};

/// Client for communicating with hyperinit over vsock.
pub struct VsockClient {
    stream: UnixStream,
}

impl VsockClient {
    /// Connect to hyperinit via the Firecracker vsock Unix socket.
    pub async fn connect(socket_path: &Path) -> Result<Self> {
        let mut stream = UnixStream::connect(socket_path)
            .await
            .map_err(|e| Error::Vmm(format!("failed to connect to vsock: {}", e)))?;

        // Firecracker vsock protocol: send "CONNECT <port>\n"
        stream
            .write_all(b"CONNECT 80\n")
            .await
            .map_err(|e| Error::Vmm(format!("failed to send CONNECT: {}", e)))?;

        // Read response (should be "OK <cid>\n")
        let mut reader = BufReader::new(&mut stream);
        let mut response = String::new();
        reader
            .read_line(&mut response)
            .await
            .map_err(|e| Error::Vmm(format!("failed to read CONNECT response: {}", e)))?;

        if !response.starts_with("OK") {
            return Err(Error::Vmm(format!(
                "vsock connection rejected: {}",
                response.trim()
            )));
        }

        Ok(Self { stream })
    }

    /// Send an HTTP request and read the response.
    async fn request(&mut self, method: &str, path: &str, body: Option<&[u8]>) -> Result<Vec<u8>> {
        let body_len = body.map(|b| b.len()).unwrap_or(0);

        // Build HTTP request
        let request = format!(
            "{} {} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
            method, path, body_len
        );

        tracing::debug!(method, path, body_len, "sending request");

        self.stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| Error::Vmm(format!("failed to write request: {}", e)))?;

        if let Some(body) = body {
            self.stream
                .write_all(body)
                .await
                .map_err(|e| Error::Vmm(format!("failed to write body: {}", e)))?;
            tracing::debug!("body sent");
        }

        // Flush to ensure data is sent
        self.stream
            .flush()
            .await
            .map_err(|e| Error::Vmm(format!("failed to flush: {}", e)))?;

        tracing::debug!("waiting for response");

        // Read response
        let mut reader = BufReader::new(&mut self.stream);

        // Read status line with timeout
        let mut status_line = String::new();
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            reader.read_line(&mut status_line)
        ).await;

        match read_result {
            Ok(Ok(0)) => return Err(Error::Vmm("connection closed (read 0 bytes)".to_string())),
            Ok(Ok(n)) => tracing::debug!(bytes = n, status = %status_line.trim(), "got status line"),
            Ok(Err(e)) => return Err(Error::Vmm(format!("failed to read status: {}", e))),
            Err(_) => return Err(Error::Vmm("timeout waiting for response".to_string())),
        }

        // Parse status code
        let status_code: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(500);

        // Read headers
        let mut content_length: usize = 0;
        loop {
            let mut header = String::new();
            reader
                .read_line(&mut header)
                .await
                .map_err(|e| Error::Vmm(format!("failed to read header: {}", e)))?;

            if header == "\r\n" || header.is_empty() {
                break;
            }

            let header_lower = header.to_lowercase();
            if header_lower.starts_with("content-length:") {
                content_length = header
                    .split(':')
                    .nth(1)
                    .and_then(|s| s.trim().parse().ok())
                    .unwrap_or(0);
            }
        }

        // Read body
        let mut body = vec![0u8; content_length];
        reader
            .read_exact(&mut body)
            .await
            .map_err(|e| Error::Vmm(format!("failed to read body: {}", e)))?;

        if status_code >= 400 {
            return Err(Error::Vmm(format!(
                "request failed with status {}: {}",
                status_code,
                String::from_utf8_lossy(&body)
            )));
        }

        Ok(body)
    }

    /// Check if hyperinit is healthy.
    pub async fn health_check(&mut self) -> Result<()> {
        self.request("GET", "/health", None).await?;
        Ok(())
    }

    /// Request graceful shutdown.
    pub async fn shutdown(&mut self) -> Result<()> {
        self.request("POST", "/shutdown", None).await?;
        Ok(())
    }

    /// Execute a command.
    pub async fn exec(&mut self, request: &ExecRequest) -> Result<ExecResponse> {
        let body = serde_json::to_vec(request)?;
        let response = self.request("POST", "/exec", Some(&body)).await?;
        let exec_response: ExecResponse = serde_json::from_slice(&response)?;
        Ok(exec_response)
    }

    /// Read a file.
    pub async fn read_file(&mut self, path: &str) -> Result<Vec<u8>> {
        let encoded_path = urlencoding_path(path);
        self.request("GET", &format!("/files/content?path={}", encoded_path), None)
            .await
    }

    /// Write a file.
    pub async fn write_file(&mut self, path: &str, content: &[u8]) -> Result<()> {
        let encoded_path = urlencoding_path(path);
        self.request(
            "PUT",
            &format!("/files/content?path={}", encoded_path),
            Some(content),
        )
        .await?;
        Ok(())
    }

    /// List directory contents.
    pub async fn list_dir(&mut self, path: &str) -> Result<Vec<String>> {
        let encoded_path = urlencoding_path(path);
        let response = self
            .request("GET", &format!("/files?path={}", encoded_path), None)
            .await?;
        let entries: Vec<String> = serde_json::from_slice(&response)?;
        Ok(entries)
    }

    /// Delete a file or directory.
    pub async fn delete_path(&mut self, path: &str) -> Result<()> {
        let encoded_path = urlencoding_path(path);
        self.request("DELETE", &format!("/files?path={}", encoded_path), None)
            .await?;
        Ok(())
    }

    /// Create a directory.
    pub async fn mkdir(&mut self, path: &str) -> Result<()> {
        let encoded_path = urlencoding_path(path);
        self.request("POST", &format!("/files/mkdir?path={}", encoded_path), None)
            .await?;
        Ok(())
    }
}

/// Simple URL encoding for paths.
fn urlencoding_path(path: &str) -> String {
    path.replace('%', "%25")
        .replace(' ', "%20")
        .replace('?', "%3F")
        .replace('&', "%26")
        .replace('=', "%3D")
}
