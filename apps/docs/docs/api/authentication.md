---
title: Authentication
description: How to authenticate with the Hyperfleet API using API keys.
icon: lock
---

Hyperfleet uses API key authentication to secure its REST API. All endpoints except `/health` require a valid API key.

## API Key Format

API keys follow this format:

```
hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- Prefix: `hf_` (hyperfleet)
- Key: 32 random characters

## Using API Keys

Include your API key in the `Authorization` header:

```bash
curl -H "Authorization: Bearer hf_your_api_key_here" \
  http://localhost:3000/machines
```

## Creating API Keys

API keys are managed through the `AuthService`. Currently, keys are created programmatically:

```typescript
import { AuthService } from "./services/auth";

const authService = new AuthService(database);

// Create a new API key
const { key, keyData } = await authService.createApiKey({
  name: "My Application",
  scopes: ["machines:read", "machines:write"],
  expiresAt: new Date("2025-12-31"),
});

// Store the key securely - it's only shown once!
console.log("Your API key:", key);
```

## API Key Properties

| Property | Description |
|----------|-------------|
| `id` | Unique identifier for the key |
| `name` | Human-readable name/description |
| `key_prefix` | First 11 characters (e.g., `hf_abc1234`) |
| `key_hash` | SHA-256 hash of the full key |
| `scopes` | Array of permission scopes |
| `expires_at` | Optional expiration date |
| `last_used_at` | Last time the key was used |
| `created_at` | When the key was created |
| `revoked_at` | When the key was revoked (if applicable) |

## Permission Scopes

API keys can be limited to specific scopes:

| Scope | Permissions |
|-------|-------------|
| `machines:read` | List and view machines |
| `machines:write` | Create, update, delete machines |
| `machines:exec` | Execute commands on machines |
| `*` | Full access (all permissions) |

## Security Best Practices

### Store Keys Securely

- Never commit API keys to version control
- Use environment variables or secrets management
- Rotate keys regularly

### Use Minimal Scopes

Create keys with only the permissions needed:

```typescript
// Read-only monitoring key
const monitoringKey = await authService.createApiKey({
  name: "Monitoring Service",
  scopes: ["machines:read"],
});

// Full access deployment key
const deployKey = await authService.createApiKey({
  name: "Deployment Pipeline",
  scopes: ["machines:read", "machines:write", "machines:exec"],
});
```

### Set Expiration Dates

For temporary access, set an expiration:

```typescript
const tempKey = await authService.createApiKey({
  name: "Contractor Access",
  scopes: ["machines:read"],
  expiresAt: new Date("2024-03-01"),
});
```

### Revoke Unused Keys

Revoke keys that are no longer needed:

```typescript
await authService.revokeApiKey(keyId);
```

## Disabling Authentication

For local development, you can disable authentication:

```bash
DISABLE_AUTH=true bun run dev
```

**Warning**: Never disable authentication in production environments.

## Error Responses

### Missing Authorization Header

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authorization header is required"
  }
}
```

Status: `401 Unauthorized`

### Invalid API Key

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

Status: `401 Unauthorized`

### Expired API Key

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "API key has expired"
  }
}
```

Status: `401 Unauthorized`

### Insufficient Permissions

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient permissions for this action"
  }
}
```

Status: `403 Forbidden`

## Next Steps

- [API Overview](/docs/api/overview/) - General API information
- [Machines API](/docs/api/machines/) - Machine management endpoints
