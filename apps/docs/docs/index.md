---
title: Introduction
description: Hyperfleet is a Firecracker microVM orchestration platform providing a unified REST API for managing secure, fast-booting lightweight virtual machines.
icon: rocket
---

## What is Hyperfleet?

Hyperfleet is a **Firecracker microVM orchestration platform** that provides a unified REST API for managing secure, fast-booting lightweight virtual machines. Built with TypeScript and Bun, it offers a modern, type-safe approach to VM management.

### Why Firecracker?

[Firecracker](https://firecracker-microvm.github.io/) is a virtual machine monitor (VMM) that uses the Linux Kernel-based Virtual Machine (KVM) to create and manage microVMs. It was developed by AWS and powers services like AWS Lambda and AWS Fargate.

Key benefits:

- **Fast boot times**: microVMs boot in under 125ms
- **Low memory overhead**: minimal footprint per VM
- **Strong security**: each microVM runs in its own isolated environment
- **Simple API**: clean REST API for VM management

### What Hyperfleet Provides

Hyperfleet builds on Firecracker to provide:

- **REST API**: Complete HTTP API for creating, managing, and monitoring microVMs
- **Machine Lifecycle**: Full state management with start, stop, restart, and delete operations
- **Command Execution**: Run commands directly inside VMs via vsock
- **Networking**: Automatic TAP device creation, IP allocation, and NAT configuration
- **Reverse Proxy**: Built-in proxy for exposing services running inside VMs
- **Authentication**: API key-based authentication with scopes and expiration
- **TypeScript SDK**: Type-safe programmatic access to all features

## Architecture Overview

Hyperfleet is organized as a monorepo with the following structure:

```
hyperfleet/
├── apps/
│   └── api/              # REST API server
├── packages/
│   ├── firecracker/      # Low-level Firecracker SDK
│   ├── runtime/          # Abstract runtime interface
│   ├── network/          # Network management
│   ├── worker/           # Database and persistence
│   ├── logger/           # Structured logging
│   ├── errors/           # Error types
│   └── resilience/       # Circuit breaker patterns
└── scripts/
    └── setup.ts          # Automated setup
```

## Next Steps

- [Installation](/docs/installation/) - Set up Hyperfleet on your system
- [Quickstart](/docs/quickstart/) - Create your first microVM
- [API Reference](/docs/api/overview/) - Explore the REST API
