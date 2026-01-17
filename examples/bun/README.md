# Hyperfleet Bun Examples

This directory contains examples of using Hyperfleet with Bun.

## Prerequisites

1. Hyperfleet daemon running:
   ```sh
   hyperfleet-daemon
   ```

2. Bun installed:
   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```

## Examples

### Simple Example (`simple.ts`)

A minimal example showing the basic workflow:
- Create a machine
- Start it
- Execute commands
- Stop and delete it

```sh
bun run simple.ts
```

### HTTP Server Example (`index.ts`)

A complete example demonstrating:
- Creating a machine with environment variables
- Writing a Bun HTTP server to the machine
- Starting the server
- Testing the server from inside the machine
- Creating a gateway to expose the server externally
- Cleanup

```sh
bun run index.ts
```

### Ralph Loop Example (`ralph-loop.ts`)

Demonstrates the Ralph Loop pattern where an AI agent runs autonomously
in a Hyperfleet sandbox, working through a TODO list with "back pressure"
from tests.

```sh
bun run ralph-loop.ts
```

## Client Library

The `hyperfleet.ts` file contains a TypeScript client for the Hyperfleet API.

### Basic Usage

```typescript
import { HyperfleetClient } from "./hyperfleet";

const client = new HyperfleetClient();

// Create a machine
const machine = await client.createMachine({
  vcpu_count: 2,
  memory_mb: 1024,
  env: { NODE_ENV: "production" },
});

// Start it
await client.startMachine(machine.id);
await client.waitForStatus(machine.id, "running");

// Execute commands
const result = await client.exec(machine.id, ["echo", "Hello, World!"]);
console.log(result.stdout);

// Write files
await client.writeFile(machine.id, "/app/hello.txt", "Hello from Hyperfleet!");

// Read files
const content = await client.readFile(machine.id, "/app/hello.txt");
console.log(new TextDecoder().decode(content));

// Create a gateway
const gateway = await client.createGateway(machine.id, 3000);
console.log(`Server available at: http://${gateway.subdomain}`);

// Cleanup
await client.stopMachine(machine.id);
await client.deleteMachine(machine.id);
```

## Configuration

Set these environment variables to configure the client:

| Variable | Default | Description |
|----------|---------|-------------|
| `HYPERFLEET_API_URL` | `http://localhost:8080` | API endpoint |
| `HYPERFLEET_API_KEY` | `unsecure` | Authentication key |

Or pass them to the constructor:

```typescript
const client = new HyperfleetClient(
  "https://api.hyperfleet.example.com",
  "your-api-key"
);
```
