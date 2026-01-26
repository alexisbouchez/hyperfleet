/**
 * Basic Hyperfleet Example
 *
 * This example demonstrates:
 *   - Creating a VM from an OCI image (alpine:latest)
 *   - Starting and managing the VM lifecycle
 *   - Executing commands inside the VM
 *   - File upload and download
 *
 * Prerequisites:
 *   - Hyperfleet API server running
 *   - Linux host with KVM support, or macOS with Lima VM
 *   - skopeo and umoci installed (for OCI image support)
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const API_KEY = process.env.API_KEY ?? "test-key";

interface Machine {
  id: string;
  name: string;
  status: string;
  vcpu_count: number;
  mem_size_mib: number;
  image_ref?: string;
}

interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function waitForStatus(
  machineId: string,
  status: string,
  timeoutMs = 60000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const machine = await apiRequest<Machine>("GET", `/machines/${machineId}`);
    if (machine.status === status) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Timeout waiting for status: ${status}`);
}

async function main() {
  console.log("=== Hyperfleet Basic Example ===\n");

  let machineId: string | null = null;

  try {
    // Step 1: Create a VM from Alpine OCI image
    console.log("1. Creating VM from alpine:latest OCI image...");
    const machine = await apiRequest<Machine>("POST", "/machines", {
      name: "basic-example",
      vcpu_count: 1,
      mem_size_mib: 512,
      image: "alpine:latest",
    });
    machineId = machine.id;
    console.log(`   Machine ID: ${machineId}`);
    console.log(`   Status: ${machine.status}`);

    // Step 2: Start the VM
    console.log("\n2. Starting VM...");
    await apiRequest("POST", `/machines/${machineId}/start`);
    await waitForStatus(machineId, "running");
    console.log("   VM is running!");

    // Wait for guest init to be ready (boot + init startup takes a few seconds)
    console.log("   Waiting for guest init...");
    await Bun.sleep(5000);

    // Step 3: Execute commands
    console.log("\n3. Executing commands in VM...");

    // Get system info
    const unameResult = await apiRequest<ExecResult>(
      "POST",
      `/machines/${machineId}/exec`,
      { cmd: ["uname", "-a"], timeout: 10000 }
    );
    console.log(`   uname -a: ${unameResult.stdout.trim()}`);

    // Check hostname
    const hostnameResult = await apiRequest<ExecResult>(
      "POST",
      `/machines/${machineId}/exec`,
      { cmd: ["hostname"], timeout: 10000 }
    );
    console.log(`   hostname: ${hostnameResult.stdout.trim()}`);

    // List root directory
    const lsResult = await apiRequest<ExecResult>(
      "POST",
      `/machines/${machineId}/exec`,
      { cmd: ["ls", "-la", "/"], timeout: 10000 }
    );
    console.log(`   ls /:\n${lsResult.stdout.split("\n").map(l => "      " + l).join("\n")}`);

    // Step 4: File upload
    console.log("\n4. Uploading file to VM...");
    const testContent = "Hello from Hyperfleet!\nThis file was uploaded via the API.";
    await fetch(`${API_URL}/machines/${machineId}/files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        path: "/tmp/hello.txt",
        content: Buffer.from(testContent).toString("base64"),
      }),
    });
    console.log("   Uploaded /tmp/hello.txt");

    // Verify the file
    const catResult = await apiRequest<ExecResult>(
      "POST",
      `/machines/${machineId}/exec`,
      { cmd: ["cat", "/tmp/hello.txt"], timeout: 10000 }
    );
    console.log(`   File contents: ${catResult.stdout.trim()}`);

    // Step 5: File download
    console.log("\n5. Downloading file from VM...");

    // Create a file in the VM first
    await apiRequest<ExecResult>(
      "POST",
      `/machines/${machineId}/exec`,
      { cmd: ["sh", "-c", "echo 'Generated inside VM' > /tmp/from-vm.txt"], timeout: 10000 }
    );

    const downloadResponse = await fetch(
      `${API_URL}/machines/${machineId}/files?path=/tmp/from-vm.txt`,
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    );
    if (downloadResponse.ok) {
      const data = await downloadResponse.json();
      const content = Buffer.from(data.content, "base64").toString();
      console.log(`   Downloaded content: ${content.trim()}`);
    }

    // Step 6: Get file info
    console.log("\n6. Getting file info...");
    const statResponse = await fetch(
      `${API_URL}/machines/${machineId}/files/stat?path=/tmp/hello.txt`,
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    );
    if (statResponse.ok) {
      const stat = await statResponse.json();
      console.log(`   File: ${stat.path}`);
      console.log(`   Size: ${stat.size} bytes`);
      console.log(`   Mode: ${stat.mode}`);
    }

    // Step 7: Get machine info
    console.log("\n7. Getting machine info...");
    const info = await apiRequest<Machine>("GET", `/machines/${machineId}`);
    console.log(`   Name: ${info.name}`);
    console.log(`   Status: ${info.status}`);
    console.log(`   vCPUs: ${info.vcpu_count}`);
    console.log(`   Memory: ${info.mem_size_mib} MiB`);
    console.log(`   Image: ${info.image_ref ?? "N/A"}`);

    console.log("\n=== Example completed successfully! ===");

  } catch (error) {
    console.error("\nError:", error);
    process.exit(1);
  } finally {
    // Cleanup
    if (machineId) {
      console.log("\nCleaning up...");
      try {
        await apiRequest("POST", `/machines/${machineId}/stop`);
        await waitForStatus(machineId, "stopped", 10000).catch(() => {});
      } catch {
        // Ignore
      }
      try {
        await apiRequest("DELETE", `/machines/${machineId}`);
        console.log("VM deleted.");
      } catch {
        // Ignore
      }
    }
  }
}

main();
