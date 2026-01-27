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

import { Result } from "better-result";

const API_URL = process.env.API_URL ?? "http://localhost:3000/api/v1";
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
): Promise<Result<T, Error>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return Result.err(new Error(`API error: ${response.status} - ${errorText}`));
    }

    const data = await response.json();
    return Result.ok(data);
  } catch (err) {
    return Result.err(err instanceof Error ? err : new Error(String(err)));
  }
}

async function waitForStatus(
  machineId: string,
  status: string,
  timeoutMs = 60000
): Promise<Result<void, Error>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const machineResult = await apiRequest<Machine>("GET", `/machines/${machineId}`);
    if (machineResult.isErr()) {
      return machineResult;
    }
    
    if (machineResult.unwrap().status === status) {
      return Result.ok(undefined);
    }
    await Bun.sleep(1000);
  }
  return Result.err(new Error(`Timeout waiting for status: ${status}`));
}

async function main() {
  console.log("=== Hyperfleet Basic Example ===\n");

  let machineId: string | null = null;

  // Step 1: Create a VM from Alpine OCI image
  console.log("1. Creating VM from alpine:latest OCI image...");
  const createResult = await apiRequest<Machine>("POST", "/machines", {
    name: "basic-example",
    vcpu_count: 1,
    mem_size_mib: 512,
    image: "alpine:latest",
  });

  if (createResult.isErr()) {
    console.error("Failed to create VM:", createResult.error);
    process.exit(1);
  }

  const machine = createResult.unwrap();
  machineId = machine.id;
  console.log(`   Machine ID: ${machineId}`);
  console.log(`   Status: ${machine.status}`);

  // Step 2: Start the VM
  console.log("\n2. Starting VM...");
  const startResult = await apiRequest("POST", `/machines/${machineId}/start`);
  if (startResult.isErr()) {
    console.error("Failed to start VM:", startResult.error);
    // Cleanup will happen at end of function if we structure it right, 
    // but here we might just want to exit or goto cleanup.
    // For simplicity in this script, we'll try to clean up.
    await cleanup(machineId);
    process.exit(1);
  }

  const waitResult = await waitForStatus(machineId, "running");
  if (waitResult.isErr()) {
    console.error("Failed waiting for running status:", waitResult.error);
    await cleanup(machineId);
    process.exit(1);
  }
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
  if (unameResult.isOk()) {
    console.log(`   uname -a: ${unameResult.unwrap().stdout.trim()}`);
  } else {
    console.error("   Failed to run uname:", unameResult.error);
  }

  // Check hostname
  const hostnameResult = await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    { cmd: ["hostname"], timeout: 10000 }
  );
  if (hostnameResult.isOk()) {
    console.log(`   hostname: ${hostnameResult.unwrap().stdout.trim()}`);
  }

  // List root directory
  const lsResult = await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    { cmd: ["ls", "-la", "/"], timeout: 10000 }
  );
  if (lsResult.isOk()) {
    console.log(`   ls /:\n${lsResult.unwrap().stdout.split("\n").map(l => "      " + l).join("\n")}`);
  }

  // Step 4: File upload
  console.log("\n4. Uploading file to VM...");
  const testContent = "Hello from Hyperfleet!\nThis file was uploaded via the API.";
  try {
    const uploadResponse = await fetch(`${API_URL}/machines/${machineId}/files`, {
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
    
    if (uploadResponse.ok) {
       console.log("   Uploaded /tmp/hello.txt");
    } else {
       console.error("   Failed upload:", await uploadResponse.text());
    }
  } catch (e) {
    console.error("   Failed upload exception:", e);
  }

  // Verify the file
  const catResult = await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    { cmd: ["cat", "/tmp/hello.txt"], timeout: 10000 }
  );
  if (catResult.isOk()) {
    console.log(`   File contents: ${catResult.unwrap().stdout.trim()}`);
  }

  // Step 5: File download
  console.log("\n5. Downloading file from VM...");

  // Create a file in the VM first
  await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    { cmd: ["sh", "-c", "echo 'Generated inside VM' > /tmp/from-vm.txt"], timeout: 10000 }
  );

  try {
    const downloadResponse = await fetch(
      `${API_URL}/machines/${machineId}/files?path=/tmp/from-vm.txt`,
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    );
    if (downloadResponse.ok) {
      const data = await downloadResponse.json();
      const content = Buffer.from(data.content, "base64").toString();
      console.log(`   Downloaded content: ${content.trim()}`);
    } else {
      console.error("   Failed download:", await downloadResponse.text());
    }
  } catch (e) {
    console.error("   Failed download exception:", e);
  }

  // Step 6: Get file info
  console.log("\n6. Getting file info...");
  try {
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
  } catch(e) { console.error("   Failed stat:", e); }

  // Step 7: Get machine info
  console.log("\n7. Getting machine info...");
  const infoResult = await apiRequest<Machine>("GET", `/machines/${machineId}`);
  if (infoResult.isOk()) {
    const info = infoResult.unwrap();
    console.log(`   Name: ${info.name}`);
    console.log(`   Status: ${info.status}`);
    console.log(`   vCPUs: ${info.vcpu_count}`);
    console.log(`   Memory: ${info.mem_size_mib} MiB`);
    console.log(`   Image: ${info.image_ref ?? "N/A"}`);
  }

  console.log("\n=== Example completed successfully! ===");
  await cleanup(machineId);
}

async function cleanup(machineId: string | null) {
  if (machineId) {
    console.log("\nCleaning up...");
    const stopResult = await apiRequest("POST", `/machines/${machineId}/stop`);
    if (stopResult.isOk()) {
       await waitForStatus(machineId, "stopped", 10000);
    }
    
    const delResult = await apiRequest("DELETE", `/machines/${machineId}`);
    if (delResult.isOk()) {
      console.log("VM deleted.");
    }
  }
}

main();