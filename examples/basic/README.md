# Basic Hyperfleet Example

A simple example demonstrating how to create, manage, and interact with Firecracker microVMs using the Hyperfleet API.

## What it does

1. Creates a VM from the `alpine:latest` OCI image
2. Starts the VM
3. Executes commands inside the VM (`uname`, `hostname`, `ls`)
4. Uploads a file to the VM
5. Downloads a file from the VM
6. Gets file metadata
7. Retrieves machine info
8. Cleans up (stops and deletes the VM)

## Prerequisites

- Hyperfleet API server running (`bun run dev` in `apps/api`)
- Linux with KVM support, or macOS with Lima VM
- `skopeo` and `umoci` installed (for OCI image support)

## Running the example

1. Start the API server:

```bash
cd apps/api
bun run dev
```

2. Run the example:

```bash
cd examples/basic
bun install
bun run start
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:3000/api/v1` | Hyperfleet API URL |
| `API_KEY` | `test-key` | API authentication key |

## Expected output

```
=== Hyperfleet Basic Example ===

1. Creating VM from alpine:latest OCI image...
   Machine ID: abc123
   Status: pending

2. Starting VM...
   VM is running!
   Waiting for guest init...

3. Executing commands in VM...
   uname -a: Linux hyperfleet 5.10.0 #1 SMP ... x86_64 Linux
   hostname: hyperfleet
   ls /:
      total 52
      drwxr-xr-x   19 root root  4096 Jan 1 00:00 .
      ...

4. Uploading file to VM...
   Uploaded /tmp/hello.txt
   File contents: Hello from Hyperfleet!
This file was uploaded via the API.

5. Downloading file from VM...
   Downloaded content: Generated inside VM

6. Getting file info...
   File: /tmp/hello.txt
   Size: 58 bytes
   Mode: 644

7. Getting machine info...
   Name: basic-example
   Status: running
   vCPUs: 1
   Memory: 512 MiB
   Image: alpine:latest

=== Example completed successfully! ===

Cleaning up...
VM deleted.
```

## Key concepts demonstrated

- **OCI Image Support**: Boot VMs directly from Docker/OCI images
- **Command Execution**: Run commands inside the VM via vsock
- **File Transfer**: Upload and download files to/from the VM
- **Lifecycle Management**: Create, start, stop, and delete VMs
