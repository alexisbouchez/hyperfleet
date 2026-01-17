// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

/**
 * Hyperfleet Bun Example
 *
 * This example demonstrates:
 * 1. Creating a machine with environment variables
 * 2. Starting the machine
 * 3. Writing a Bun HTTP server to the machine
 * 4. Installing dependencies and running the server
 * 5. Creating a gateway to expose the server
 * 6. Testing the HTTP server from outside the machine
 * 7. Cleaning up
 */

import { HyperfleetClient } from "./hyperfleet";

const client = new HyperfleetClient();

async function main() {
  console.log("🚀 Hyperfleet Bun Example\n");

  // Step 1: Create a machine
  console.log("📦 Creating machine...");
  const machine = await client.createMachine({
    vcpu_count: 2,
    memory_mb: 1024,
    volume_size_mb: 2048,
    volume_mount_path: "/data",
    env: {
      NODE_ENV: "production",
      PORT: "3000",
    },
  });
  console.log(`   Created machine: ${machine.id}`);

  try {
    // Step 2: Start the machine
    console.log("\n▶️  Starting machine...");
    await client.startMachine(machine.id);
    await client.waitForStatus(machine.id, "running");
    console.log("   Machine is running!");

    // Step 3: Create the app directory
    console.log("\n📁 Creating app directory...");
    await client.mkdir(machine.id, "/app");

    // Step 4: Write the Bun HTTP server
    console.log("\n📝 Writing HTTP server code...");

    const serverCode = `
// Simple Bun HTTP server
const port = parseInt(process.env.PORT || "3000");

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(JSON.stringify({
        message: "Hello from Hyperfleet! 🚀",
        timestamp: new Date().toISOString(),
        machine_id: process.env.MACHINE_ID || "unknown",
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/env") {
      return new Response(JSON.stringify({
        NODE_ENV: process.env.NODE_ENV,
        PORT: process.env.PORT,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(\`Server running at http://localhost:\${server.port}\`);
`;

    await client.writeFile(machine.id, "/app/server.ts", serverCode);
    console.log("   Written /app/server.ts");

    // Step 5: Start the HTTP server in the background
    console.log("\n🌐 Starting HTTP server...");
    const startResult = await client.exec(machine.id, [
      "sh",
      "-c",
      "cd /app && nohup bun run server.ts > /app/server.log 2>&1 & echo $!",
    ]);

    if (startResult.exit_code !== 0) {
      console.error("   Failed to start server:", startResult.stderr);
      throw new Error("Failed to start server");
    }

    const serverPid = startResult.stdout.trim();
    console.log(`   Server started with PID: ${serverPid}`);

    // Wait for server to be ready
    await Bun.sleep(2000);

    // Step 6: Test the server locally (from inside the machine)
    console.log("\n🧪 Testing server from inside the machine...");
    const curlResult = await client.exec(machine.id, [
      "curl",
      "-s",
      "http://localhost:3000/",
    ]);

    if (curlResult.exit_code === 0) {
      console.log("   Response:", curlResult.stdout);
    } else {
      console.error("   curl failed:", curlResult.stderr);
    }

    // Test /health endpoint
    const healthResult = await client.exec(machine.id, [
      "curl",
      "-s",
      "http://localhost:3000/health",
    ]);
    console.log("   Health check:", healthResult.stdout);

    // Test /env endpoint
    const envResult = await client.exec(machine.id, [
      "curl",
      "-s",
      "http://localhost:3000/env",
    ]);
    console.log("   Environment:", envResult.stdout);

    // Step 7: Create a gateway to expose the server
    console.log("\n🌍 Creating gateway to expose port 3000...");
    const gateway = await client.createGateway(machine.id, 3000);
    console.log(`   Gateway created: ${gateway.subdomain}`);

    // Step 8: Test the server from outside (via gateway)
    console.log("\n🔗 Testing server via gateway...");
    console.log(`   Gateway URL: http://${gateway.subdomain}`);

    // In a real scenario, you would fetch from the gateway URL
    // For this example, we'll just show the URL
    console.log("   (Gateway routing requires hypergate to be running)");

    // Step 9: Show server logs
    console.log("\n📋 Server logs:");
    const logsResult = await client.exec(machine.id, ["cat", "/app/server.log"]);
    console.log(logsResult.stdout || "   (no logs yet)");

    // Step 10: List files in /app
    console.log("\n📂 Files in /app:");
    const files = await client.listFiles(machine.id, "/app");
    for (const file of files) {
      console.log(`   - ${file}`);
    }

    // Cleanup prompt
    console.log("\n🧹 Cleaning up...");

    // Stop the machine
    console.log("   Stopping machine...");
    await client.stopMachine(machine.id);
    await client.waitForStatus(machine.id, "stopped");
    console.log("   Machine stopped");

    // Delete the machine
    console.log("   Deleting machine...");
    await client.deleteMachine(machine.id);
    console.log("   Machine deleted");

    console.log("\n✅ Example completed successfully!");
  } catch (error) {
    console.error("\n❌ Error:", error);

    // Cleanup on error
    console.log("\n🧹 Cleaning up after error...");
    try {
      const m = await client.getMachine(machine.id);
      if (m.status === "running") {
        await client.stopMachine(machine.id);
        await client.waitForStatus(machine.id, "stopped");
      }
      await client.deleteMachine(machine.id);
      console.log("   Cleaned up machine");
    } catch {
      console.log("   Machine may already be deleted");
    }

    process.exit(1);
  }
}

main();
