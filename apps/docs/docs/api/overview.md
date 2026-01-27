---
title: API Overview
description: Overview of the Hyperfleet REST API.
icon: globe
---

Hyperfleet provides a RESTful API for managing Firecracker microVMs. The API is built with [Elysia](https://elysiajs.com/) and includes automatic OpenAPI documentation.

## Base URL

By default, the API runs on:

```
http://localhost:3000
```

You can change the port using the `PORT` environment variable.

## OpenAPI Documentation

Interactive API documentation is available at:

- **Swagger UI**: `http://localhost:3000/docs`
- **OpenAPI JSON**: `http://localhost:3000/docs/json`

## Authentication

Most endpoints require authentication via Bearer token:

```bash
curl -H "Authorization: Bearer hf_your_api_key" \
  http://localhost:3000/machines
```

See [Authentication](/docs/api/authentication/) for details on obtaining and managing API keys.

To disable authentication for development:

```bash
DISABLE_AUTH=true bun run dev
```

## Response Format

All responses are JSON. Successful responses return the requested data directly:

```json
{
  "id": "abc123",
  "name": "my-vm",
  "status": "running"
}
```

Error responses include an error object:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Machine with id 'abc123' not found"
  }
}
```

## HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `201` | Created (for POST requests that create resources) |
| `204` | No Content (for DELETE requests) |
| `400` | Bad Request - Invalid input |
| `401` | Unauthorized - Missing or invalid API key |
| `404` | Not Found - Resource doesn't exist |
| `500` | Internal Server Error |
| `502` | Bad Gateway - VM communication error |
| `503` | Service Unavailable - Circuit breaker open |
| `504` | Gateway Timeout - VM command timed out |

## Endpoints Summary

### Health & Documentation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check (public) |
| `GET` | `/docs` | OpenAPI documentation UI |
| `GET` | `/docs/json` | OpenAPI specification |

### Machine Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/machines` | Create a new machine |
| `GET` | `/machines` | List all machines |
| `GET` | `/machines/{id}` | Get machine details |
| `GET` | `/machines/{id}/wait` | Wait for machine to reach a status |
| `DELETE` | `/machines/{id}` | Delete a machine |
| `POST` | `/machines/{id}/start` | Start a machine |
| `POST` | `/machines/{id}/stop` | Stop a machine |
| `POST` | `/machines/{id}/restart` | Restart a machine |
| `POST` | `/machines/{id}/exec` | Execute command on machine |

## Request Headers

### Required Headers

| Header | Description |
|--------|-------------|
| `Authorization` | Bearer token for authentication |
| `Content-Type` | `application/json` for POST/PUT requests |

### Optional Headers

| Header | Description |
|--------|-------------|
| `X-Correlation-ID` | Request correlation ID for tracing |

## Rate Limiting

Currently, there is no built-in rate limiting. For production deployments, consider using a reverse proxy like nginx or Cloudflare to implement rate limiting.

## Pagination

List endpoints support pagination via query parameters:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `limit` | Maximum items to return | 50 |
| `offset` | Number of items to skip | 0 |

Example:

```bash
curl "http://localhost:3000/machines?limit=10&offset=20"
```

## Filtering

The machines list endpoint supports filtering:

```bash
# Filter by status
curl "http://localhost:3000/machines?status=running"
```

## Next Steps

- [Authentication](/docs/api/authentication/) - Learn about API keys
- [Machines API](/docs/api/machines/) - Machine management endpoints
- [Commands API](/docs/api/commands/) - Execute commands on machines
