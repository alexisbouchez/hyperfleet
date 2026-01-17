# Hyperfleet

Hyperfleet is a sandbox orchestrator for AI agents. It provisions and manages Firecracker microVMs running Alpine Linux, exposing a REST API for machine lifecycle management, command execution, and filesystem operations.

## AI Agent Workflows

Hyperfleet is designed to run AI coding agents (Claude Code, Codex, etc.) in isolated sandboxes using the **ralph loop** pattern.

### The Ralph Loop

A ralph loop is an AI agent running autonomously in a continuous cycle:

```
┌─────────────────────────────────────────────────────────────────┐
│                         Ralph Loop                              │
│                                                                 │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐     │
│   │  Read   │───▶│  Plan   │───▶│Execute  │───▶│ Verify  │──┐  │
│   │TODO.txt │    │  Task   │    │  Task   │    │ (tests) │  │  │
│   └─────────┘    └─────────┘    └─────────┘    └─────────┘  │  │
│        ▲                                                     │  │
│        │              ┌──────────────────┐                   │  │
│        └──────────────│  Update TODO.txt │◀──────────────────┘  │
│                       │  (mark done/add) │                      │
│                       └──────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

Each iteration:
1. Agent reads `TODO.txt` for the next task
2. Plans and executes the task (code changes, file operations)
3. Runs verification (tests, linters, type checkers) — **back pressure**
4. Updates `TODO.txt` (mark complete, add new tasks discovered)
5. Loops until all tasks complete

### Back Pressure

Back pressure provides automated feedback that catches errors during execution:

- **Type checkers**: `cargo check`, `tsc --noEmit`, `mypy`
- **Linters**: `clippy`, `eslint`, `ruff`
- **Tests**: `cargo test`, `pytest`, `jest`
- **Pre-commit hooks**: Format, lint, validate before each commit

Hyperfleet sandboxes come pre-configured with these tools, giving agents immediate feedback on code quality.

### Parallel Loops

Agents can spawn additional machines for parallel work:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Orchestrator Machine                        │
│                                                                 │
│   TODO.txt:                                                     │
│   - [x] Analyze codebase structure                              │
│   - [ ] Implement feature A  ──────▶  Spawn Machine A           │
│   - [ ] Implement feature B  ──────▶  Spawn Machine B           │
│   - [ ] Implement feature C  ──────▶  Spawn Machine C           │
│   - [ ] Integration tests (blocked)                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │  Machine A  │    │  Machine B  │    │  Machine C  │
    │  Feature A  │    │  Feature B  │    │  Feature C  │
    │  (ralph     │    │  (ralph     │    │  (ralph     │
    │   loop)     │    │   loop)     │    │   loop)     │
    └─────────────┘    └─────────────┘    └─────────────┘
           │                  │                  │
           └──────────────────┼──────────────────┘
                              ▼
                     Orchestrator merges,
                     runs integration tests
```

### Example: Claude Code in Ralph Loop

```sh
# Create a machine with Claude Code environment
hf machines create --vcpus 4 --memory 4096 \
  --env ANTHROPIC_API_KEY=sk-ant-... \
  --env CLAUDE_CODE_ENTRYPOINT="/workspace"

# Write initial TODO.txt
hf files write <id> /workspace/TODO.txt << 'EOF'
- [ ] Read SPEC.md and understand requirements
- [ ] Implement user authentication module
- [ ] Add unit tests for auth module
- [ ] Implement API endpoints
- [ ] Add integration tests
- [ ] Update documentation
EOF

# Start the ralph loop
hf exec <id> -- claude-code --loop --todo /workspace/TODO.txt

# Monitor progress
hf files cat <id> /workspace/TODO.txt
```

### Specs-Driven Development

For best results, provide agents with structured specifications:

```
/workspace/
├── SPEC.md           # High-level requirements
├── TODO.txt          # Task list (agent-managed)
├── docs/
│   └── architecture.md
└── src/
    └── ...
```

The spec anchors the agent's context, reducing drift and improving output quality. Combined with type-safe languages (Rust, TypeScript, Go), compiler errors provide additional back pressure.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              External Traffic                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         hypergate (Pingora)                                 │
│                                                                             │
│  ┌─────────────────────────────┐  ┌──────────────────────────────────────┐  │
│  │       Machines API          │  │            Gateways                  │  │
│  │    api.hyperfleet.local     │  │   <port>-<machine-id>.gw.local       │  │
│  └─────────────────────────────┘  └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            hyperfleet-daemon                                │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ hyperfleet-  │  │ hyperfleet-  │  │ hyperfleet-  │  │  hyperfleet-     │ │
│  │     api      │  │    core      │  │     vmm      │  │      db          │ │
│  │   (axum)     │  │   (logic)    │  │ (firecracker)│  │   (sqlite)       │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                          virtio-vsock│
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Firecracker microVMs                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                           Machine                                       ││
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐      ││
│  │  │    hyperinit    │  │  Alpine Linux   │  │       Volume        │      ││
│  │  │   (PID 1, C)    │  │    (rootfs)     │  │       (ext4)        │      ││
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Components

### hypergate

Pingora-based reverse proxy handling all inbound traffic. Routes requests to either the Machines API or directly to machine gateways.

- **Machines API**: Control plane for machine CRUD, exec, and filesystem operations
- **Gateways**: Data plane for exposing machine ports externally via `<port>-<machine-id>.<domain>` subdomains

### hyperfleet-daemon

Main orchestration daemon written in Rust. Composed of multiple crates:

| Crate                | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `hyperfleet-common`  | Shared types, trait definitions, error types        |
| `hyperfleet-api`     | REST API layer (axum)                               |
| `hyperfleet-core`    | Business logic, machine lifecycle, reconciliation   |
| `hyperfleet-vmm`     | Firecracker process management, vsock communication |
| `hyperfleet-db`      | SQLite persistence layer                            |
| `hyperfleet-network` | TAP device and bridge management, NAT configuration |
| `hyperfleet-volume`  | Volume creation, formatting, and attachment         |
| `hyperfleet-cli`     | CLI client (`hf`) for interacting with the API      |

### Trait Abstractions

Core traits enabling future multi-node support:

```rust
// hyperfleet-db
#[async_trait]
pub trait Storage: Send + Sync {
    async fn create_machine(&self, machine: &Machine) -> Result<()>;
    async fn get_machine(&self, id: &str) -> Result<Option<Machine>>;
    async fn list_machines(&self) -> Result<Vec<Machine>>;
    async fn update_machine(&self, machine: &Machine) -> Result<()>;
    async fn delete_machine(&self, id: &str) -> Result<()>;
    // ...
}

// hyperfleet-vmm
#[async_trait]
pub trait Vmm: Send + Sync {
    async fn create(&self, config: &VmConfig) -> Result<()>;
    async fn start(&self, id: &str) -> Result<()>;
    async fn stop(&self, id: &str) -> Result<()>;
    async fn destroy(&self, id: &str) -> Result<()>;
    async fn exec(&self, id: &str, cmd: &ExecRequest) -> Result<ExecResponse>;
    // ...
}

// hyperfleet-network
#[async_trait]
pub trait Network: Send + Sync {
    async fn create_tap(&self, machine_id: &str) -> Result<TapDevice>;
    async fn delete_tap(&self, machine_id: &str) -> Result<()>;
    async fn allocate_ip(&self, machine_id: &str) -> Result<IpAddr>;
    // ...
}

// hyperfleet-volume
#[async_trait]
pub trait VolumeManager: Send + Sync {
    async fn create(&self, machine_id: &str, size_mb: u64) -> Result<Volume>;
    async fn delete(&self, machine_id: &str) -> Result<()>;
    async fn get_path(&self, machine_id: &str) -> Result<PathBuf>;
    // ...
}
```

`hyperfleet-core` depends only on these traits, not concrete implementations. This allows swapping SQLite for a distributed store, or proxying VMM calls to remote nodes, without changing business logic.

### hyperfleet-cli

Command-line interface for interacting with the Machines API. Binary name: `hf`.

```sh
# Machine management
hf machines list
hf machines create --vcpus 2 --memory 512
hf machines get <id>
hf machines start <id>
hf machines stop <id>
hf machines delete <id>

# Exec
hf exec <id> -- ls -la /
hf exec <id> --env DEBUG=1 -- node app.js

# Filesystem
hf files ls <id> /etc
hf files cat <id> /etc/hosts
hf files write <id> /app/config.json < config.json
hf files rm <id> /tmp/old

# Gateways
hf gateways list <id>
hf gateways create <id> --port 8080
hf gateways delete <id> --port 8080
```

Configuration via environment:

- `HYPERFLEET_API_URL` - API endpoint (default: `http://localhost:8080`)
- `HYPERFLEET_API_KEY` - Authentication key

### hyperinit

Minimal init system written in C with zero external dependencies. Runs as PID 1 inside each microVM. Exposes a REST API over virtio-vsock for:

- Command execution (spawn processes, stream stdout/stderr)
- Filesystem operations (read, write, list, delete, mkdir)
- Machine shutdown

## Machine Lifecycle

```
     create
        │
        ▼
   ┌─────────┐    start     ┌─────────┐
   │ stopped │─────────────▶│ running │
   └─────────┘              └─────────┘
        ▲                        │
        │         stop           │
        └────────────────────────┘
        │
        │ delete
        ▼
   ┌─────────┐
   │ deleted │
   └─────────┘
```

States:

- **stopped**: VM not running, rootfs and volumes persisted
- **running**: VM actively running, hyperinit accepting requests
- **deleted**: All resources cleaned up

On host reboot, `hyperfleet-daemon` reconciles state: machines marked as `running` in the database are restarted automatically.

## Storage

### Rootfs

Each machine uses a read-only Alpine Linux base image with a writable overlay:

```
┌────────────────────────────┐
│     Writable Overlay       │  ← Per-machine, persisted
├────────────────────────────┤
│   Alpine Linux Base        │  ← Shared, read-only
└────────────────────────────┘
```

The overlay captures all filesystem modifications, enabling fast machine creation (no full image copy) while preserving changes across stop/start cycles.

### Volumes

Persistent ext4-formatted block devices attached to machines. One volume per machine, mounted at a configurable path within the guest.

Volume lifecycle is tied to machine lifecycle: volumes are created with the machine and deleted when the machine is deleted.

## Networking

### Outbound

Each machine gets a TAP device connected to a bridge with NAT, providing outbound internet access.

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Machine │────▶│   TAP    │────▶│  Bridge  │────▶│ Internet │
│  (eth0)  │     │ (tapX)   │     │ (hfbr0)  │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### Inbound (Gateways)

Machines can expose ports via HTTP gateways. The proxy routes `<port>-<machine-id>.<domain>` to the corresponding machine port over the bridge network.

Example: `8080-abc123.gw.example.com` routes to machine `abc123` port `8080`.

TCP gateway support planned for non-HTTP protocols.

## Vsock Communication

Host-guest communication uses virtio-vsock. The guest runs with CID 3 (standard guest CID). The host connects to the guest's hyperinit on a well-known port.

```
Host                              Guest (CID 3)
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ hyperfleet-vmm              │◀─▶│    hyperinit                │
│                             │   │    (port 80)                │
└─────────────────────────────┘   └─────────────────────────────┘
                   vsock connection to CID 3, port 80
```

Protocol: HTTP/1.1 over vsock. Simple, debuggable, no custom serialization.

## Machines API

Base URL: `https://api.hyperfleet.local/v1`

Authentication: `Authorization: Bearer <API_KEY>` (API key configured via `HYPERFLEET_API_KEY` environment variable)

### Endpoints

#### Machines

| Method   | Path                  | Description             |
| -------- | --------------------- | ----------------------- |
| `GET`    | `/machines`           | List all machines       |
| `POST`   | `/machines`           | Create a new machine    |
| `GET`    | `/machines/:id`       | Get machine details     |
| `DELETE` | `/machines/:id`       | Delete a machine        |
| `POST`   | `/machines/:id/start` | Start a stopped machine |
| `POST`   | `/machines/:id/stop`  | Stop a running machine  |

#### Exec

| Method | Path                 | Description       |
| ------ | -------------------- | ----------------- |
| `POST` | `/machines/:id/exec` | Execute a command |

Request:

```json
{
  "cmd": ["ls", "-la", "/"],
  "timeout_seconds": 30
}
```

Response:

```json
{
  "exit_code": 0,
  "stdout": "...",
  "stderr": ""
}
```

#### Filesystem

| Method   | Path                                                | Description              |
| -------- | --------------------------------------------------- | ------------------------ |
| `GET`    | `/machines/:id/files?path=/etc`                     | List directory contents  |
| `GET`    | `/machines/:id/files/content?path=/etc/hosts`       | Read file content        |
| `PUT`    | `/machines/:id/files/content?path=/app/config.json` | Write file content       |
| `DELETE` | `/machines/:id/files?path=/tmp/old`                 | Delete file or directory |
| `POST`   | `/machines/:id/files/mkdir?path=/app/data`          | Create directory         |

#### Gateways

| Method   | Path                           | Description           |
| -------- | ------------------------------ | --------------------- |
| `GET`    | `/machines/:id/gateways`       | List machine gateways |
| `POST`   | `/machines/:id/gateways`       | Create a gateway      |
| `DELETE` | `/machines/:id/gateways/:port` | Delete a gateway      |

#### Orchestration (Child Machines)

| Method   | Path                              | Description                 |
| -------- | --------------------------------- | --------------------------- |
| `POST`   | `/machines/:id/spawn`             | Spawn a child machine       |
| `GET`    | `/machines/:id/children`          | List child machines         |
| `POST`   | `/machines/:id/webhooks`          | Register completion webhook |
| `GET`    | `/machines/:id/webhooks`          | List registered webhooks    |
| `DELETE` | `/machines/:id/webhooks/:hook_id` | Delete a webhook            |

Spawn request (inherits parent context):

```json
{
  "vcpu_count": 2,
  "memory_mb": 1024,
  "inherit_env": true,
  "env": {
    "TASK": "implement-feature-a"
  },
  "webhook_url": "http://parent-machine:8080/child-complete"
}
```

Spawn response:

```json
{
  "id": "a3b8c2d1",
  "parent_id": "k7x9m2p4",
  "status": "starting"
}
```

Webhook payload (POST to registered URL on machine stop/complete):

```json
{
  "event": "machine.stopped",
  "machine_id": "a3b8c2d1",
  "parent_id": "k7x9m2p4",
  "exit_status": "success",
  "timestamp": 1705500000
}
```

### Machine Configuration

```json
{
  "id": "k7x9m2p4",
  "vcpu_count": 2,
  "memory_mb": 512,
  "volume_size_mb": 1024,
  "volume_mount_path": "/data",
  "env": {
    "NODE_ENV": "production",
    "DATABASE_URL": "sqlite:///data/app.db",
    "API_KEY": "sk-..."
  },
  "status": "running"
}
```

Resource constraints:

- `vcpu_count`: 1-8 vCPUs
- `memory_mb`: 128-8192 MB
- `volume_size_mb`: 64-102400 MB

Environment variables:

- Set at machine creation, persisted across stop/start cycles
- Injected into every command executed via `/exec`
- Can be updated on a stopped machine

### Machine IDs

Machine IDs are 8-character NanoIDs using a lowercase alphanumeric alphabet (`a-z0-9`).

- **Length**: 8 characters
- **Alphabet**: `abcdefghijklmnopqrstuvwxyz0123456789` (36 chars)
- **Collision probability**: ~1% at 1 million machines
- **Examples**: `k7x9m2p4`, `a3b8c2d1`, `9xq2m7nk`

This format is:

- Subdomain-safe (no uppercase, no special characters)
- URL-safe
- Human-typeable
- Short enough for CLI usage

## Project Structure

```
hyperfleet/
├── Cargo.toml                    # Workspace definition
├── crates/
│   ├── hyperfleet-common/        # Shared types and traits
│   ├── hyperfleet-api/           # REST API (axum)
│   ├── hyperfleet-core/          # Business logic
│   ├── hyperfleet-db/            # SQLite persistence
│   ├── hyperfleet-vmm/           # Firecracker management
│   ├── hyperfleet-network/       # Network configuration
│   ├── hyperfleet-volume/        # Volume management
│   ├── hyperfleet-cli/           # CLI client (hf)
│   ├── hypergate/                # Pingora proxy
│   └── hyperfleet-daemon/        # Main binary
├── hyperinit/                    # C init system
│   ├── Makefile
│   └── src/
│       └── main.c
└── sdks/
    ├── python/                   # hyperfleet (PyPI)
    ├── typescript/               # @hyperfleet/sdk (npm)
    ├── go/                       # github.com/hyperfleetio/hyperfleet-go
    ├── rust/                     # hyperfleet-client (crates.io)
    ├── php/                      # hyperfleet/hyperfleet (Packagist)
    └── ruby/                     # hyperfleet (RubyGems)
```

## Conventions

This project follows the [Rust compiler coding conventions](https://rustc-dev-guide.rust-lang.org/conventions.html):

- **Formatting**: All code formatted with `rustfmt` using the project's `rustfmt.toml`
- **Naming**: Snake case for functions and variables, CamelCase for types
- **Imports**: Grouped by std, external crates, then internal modules
- **Error handling**: Use `thiserror` for library errors, `anyhow` in binaries where appropriate
- **Documentation**: Public APIs documented with `///` doc comments

### File Headers

Every Rust source file must include the following header:

```rust
// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.
```

## Installation

### Quick Install (Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/hyperfleetio/hyperfleet/main/install.sh | sh
```

The install script:

- Detects CPU architecture (x86_64, aarch64)
- Downloads and installs `hyperfleet-daemon`, `hypergate`, and `hyperinit`
- Downloads Firecracker binary
- Sets up the Alpine Linux base image
- Configures systemd services
- Creates network bridge and iptables rules
- Verifies kernel vsock support
- Configures local DNS resolution for `.local` domains (systemd-resolved / Avahi)

### Local Development (Ubuntu)

The install script configures `.local` domain resolution for development:

1. Configures `systemd-resolved` to resolve `*.hyperfleet.local` to `127.0.0.1`
2. Adds `/etc/systemd/resolved.conf.d/hyperfleet.conf`:
   ```ini
   [Resolve]
   DNS=127.0.0.1
   Domains=~hyperfleet.local
   ```
3. Sets up dnsmasq (if needed) for wildcard subdomain support
4. Restarts resolved: `systemctl restart systemd-resolved`

After installation, these domains resolve locally:

- `api.hyperfleet.local` → Machines API
- `8080-k7x9m2p4.gw.hyperfleet.local` → Machine gateway

### DNS Setup (Production)

For production deployments with a domain name (e.g., on OVH VPS):

#### Prerequisites

- A domain name (e.g., `hyperfleet.example.com`)
- VPS with static IPv4 and IPv6 addresses
- Access to DNS management (OVH, Cloudflare, etc.)

#### DNS Records

Configure the following DNS records:

```
# A records (IPv4)
api.hyperfleet.example.com.     A       203.0.113.10
*.gw.hyperfleet.example.com.    A       203.0.113.10

# AAAA records (IPv6)
api.hyperfleet.example.com.     AAAA    2001:db8::1
*.gw.hyperfleet.example.com.    AAAA    2001:db8::1
```

The wildcard record (`*.gw`) enables gateway subdomains like `8080-k7x9m2p4.gw.hyperfleet.example.com`.

#### OVH DNS Configuration

1. Log in to OVH Control Panel
2. Navigate to **Domains** → **your-domain** → **DNS Zone**
3. Add records:

| Type | Subdomain        | Target       | TTL  |
| ---- | ---------------- | ------------ | ---- |
| A    | api.hyperfleet   | 203.0.113.10 | 3600 |
| A    | \*.gw.hyperfleet | 203.0.113.10 | 3600 |
| AAAA | api.hyperfleet   | 2001:db8::1  | 3600 |
| AAAA | \*.gw.hyperfleet | 2001:db8::1  | 3600 |

#### Hyperfleet Configuration

Update environment variables to match your domain:

```sh
export HYPERFLEET_GATEWAY_DOMAIN="gw.hyperfleet.example.com"
```

#### TLS (Let's Encrypt)

For HTTPS, use a wildcard certificate:

```sh
certbot certonly --manual --preferred-challenges dns \
  -d "api.hyperfleet.example.com" \
  -d "*.gw.hyperfleet.example.com"
```

Configure certificate paths in hypergate:

```sh
export HYPERGATE_TLS_CERT="/etc/letsencrypt/live/hyperfleet.example.com/fullchain.pem"
export HYPERGATE_TLS_KEY="/etc/letsencrypt/live/hyperfleet.example.com/privkey.pem"
```

### Manual Build

#### hyperfleet (Rust workspace)

```sh
cargo build --release
```

Binaries output to `target/release/`:

- `hyperfleet-daemon` - Main orchestration daemon
- `hypergate` - Reverse proxy
- `hf` - CLI client

#### hyperinit

```sh
cd hyperinit
make
```

Produces a statically-linked binary targeting x86_64-linux-musl.

## Configuration

Environment variables:

| Variable                    | Description                  | Default                             |
| --------------------------- | ---------------------------- | ----------------------------------- |
| `HYPERFLEET_API_KEY`        | API authentication key       | `unsecure`                          |
| `HYPERFLEET_DB_PATH`        | SQLite database path         | `/var/lib/hyperfleet/hyperfleet.db` |
| `HYPERFLEET_IMAGES_PATH`    | Alpine base images directory | `/var/lib/hyperfleet/images`        |
| `HYPERFLEET_VOLUMES_PATH`   | Volume storage directory     | `/var/lib/hyperfleet/volumes`       |
| `HYPERFLEET_BRIDGE_NAME`    | Network bridge name          | `hfbr0`                             |
| `HYPERFLEET_BRIDGE_CIDR`    | Bridge network CIDR          | `10.0.0.1/24`                       |
| `HYPERFLEET_GATEWAY_DOMAIN` | Gateway subdomain base       | `gw.hyperfleet.local`               |

## Dependencies

- Firecracker (VMM)
- Linux kernel with vsock support (`vhost_vsock` module)
- Alpine Linux rootfs image
- SQLite 3

## SDKs

Official client SDKs planned for:

| Language   | Package Name                          |
| ---------- | ------------------------------------- |
| Python     | `hyperfleet`                          |
| TypeScript | `@hyperfleet/sdk`                     |
| Go         | `github.com/hyperfleet/hyperfleet-go` |
| Rust       | `hyperfleet-client`                   |
| PHP        | `hyperfleet/hyperfleet`               |
| Ruby       | `hyperfleet`                          |

## Testing Strategy

### Unit Tests

Run everywhere (CI, local):

| Crate              | Approach                              |
| ------------------ | ------------------------------------- |
| `hyperfleet-db`    | In-memory SQLite, test CRUD ops       |
| `hyperfleet-core`  | Mock traits for VMM/DB/Network/Volume |
| `hyperfleet-api`   | `axum::test` with mocked service      |
| `hypergate`        | Routing logic with mock upstreams     |

### Integration Tests

Require Linux with KVM:

| Component          | Approach                                    |
| ------------------ | ------------------------------------------- |
| `hyperfleet-vmm`   | Real Firecracker, test VM lifecycle         |
| `hyperfleet-network` | Requires root, test TAP/bridge creation   |
| Full API           | Spin up daemon, test via HTTP               |

### End-to-End Tests

Full system tests:

1. Boot a machine
2. Execute a command, verify output
3. Write/read files
4. Create gateway, verify routing
5. Stop and delete machine

### Running Tests

```sh
# Unit tests (all platforms)
cargo test

# Integration tests (Linux with KVM)
cargo test --features integration

# E2E tests
./scripts/e2e-test.sh
```

### CI Configuration

- **Unit tests**: Run on every PR (ubuntu-latest)
- **Integration tests**: Linux runner with KVM (self-hosted or nested virt)
- **E2E tests**: Nightly, full VM boot cycle

## Future Work

- Multi-node clustering with machine placement
- Live migration
- Snapshots and restore
- Resource quotas and limits
- Metrics and observability
- TCP gateway support

## License

AGPL-3.0. See [LICENSE](LICENSE) for details.
