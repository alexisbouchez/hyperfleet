// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

/**
 * Simple Hyperfleet Example
 *
 * A minimal example showing the basic workflow:
 * 1. Create a machine
 * 2. Start it
 * 3. Execute a command
 * 4. Stop and delete it
 */

import { HyperfleetClient } from "./hyperfleet";

const client = new HyperfleetClient();

async function main() {
  // Create a machine
  console.log("Creating machine...");
  const machine = await client.createMachine({
    vcpu_count: 1,
    memory_mb: 512,
  });
  console.log(`Machine created: ${machine.id}`);

  try {
    // Start the machine
    console.log("Starting machine...");
    await client.startMachine(machine.id);
    await client.waitForStatus(machine.id, "running");
    console.log("Machine is running!");

    // Execute some commands
    console.log("\nExecuting commands...\n");

    // Get system info
    const unameResult = await client.exec(machine.id, ["uname", "-a"]);
    console.log("System:", unameResult.stdout.trim());

    // Check Bun version
    const bunResult = await client.exec(machine.id, ["bun", "--version"]);
    console.log("Bun version:", bunResult.stdout.trim());

    // Check Node version (if available)
    const nodeResult = await client.exec(machine.id, ["node", "--version"]);
    console.log("Node version:", nodeResult.stdout.trim());

    // Run a simple Bun script
    const evalResult = await client.exec(machine.id, [
      "bun",
      "-e",
      "console.log('Hello from Hyperfleet! 🚀'); console.log('2 + 2 =', 2 + 2);",
    ]);
    console.log("\nBun eval output:");
    console.log(evalResult.stdout);

    // Check disk space
    const dfResult = await client.exec(machine.id, ["df", "-h", "/"]);
    console.log("Disk usage:");
    console.log(dfResult.stdout);

    // Check memory
    const freeResult = await client.exec(machine.id, ["free", "-h"]);
    console.log("Memory usage:");
    console.log(freeResult.stdout);

  } finally {
    // Cleanup
    console.log("\nCleaning up...");
    try {
      await client.stopMachine(machine.id);
      await client.waitForStatus(machine.id, "stopped");
    } catch {
      // Machine might already be stopped
    }
    await client.deleteMachine(machine.id);
    console.log("Machine deleted");
  }
}

main().catch(console.error);
