/**
 * FFmpeg Video Processing Example
 *
 * This example demonstrates:
 *   - Booting a VM from an OCI image (Alpine with ffmpeg)
 *   - Uploading a video file to the VM
 *   - Running ffmpeg to process the video
 *   - Downloading the result
 *
 * Prerequisites:
 *   - Linux host with KVM support, or macOS with Lima VM
 *   - Firecracker binary installed
 *   - skopeo and umoci installed (for OCI image support)
 *   - A sample video file (or use the generated test pattern)
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
  console.log("=== FFmpeg Video Processing Example ===\n");

  let machineId: string | null = null;

  // Step 1: Create a VM from Alpine OCI image
  console.log("1. Creating VM from Alpine OCI image...");
  const createResult = await apiRequest<Machine>("POST", "/machines", {
    name: "ffmpeg-worker",
    vcpu_count: 2,
    mem_size_mib: 1024,
    image: "alpine:latest",
    image_size_mib: 2048, // 2GB rootfs for ffmpeg and video files
    network: { enable: true }, // Enable network for package downloads
  });

  if (createResult.isErr()) {
    console.error("Failed to create VM:", createResult.error);
    process.exit(1);
  }

  const machine = createResult.unwrap();
  machineId = machine.id;
  console.log(`   Created machine: ${machineId}`);

  // Step 2: Start the VM
  console.log("\n2. Starting VM...");
  const startResult = await apiRequest("POST", `/machines/${machineId}/start`);
  if (startResult.isErr()) {
    console.error("Failed to start VM:", startResult.error);
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

  // Wait for init to be ready (boot + init startup takes a few seconds)
  console.log("   Waiting for guest init...");
  await Bun.sleep(5000);

  // Step 3: Install ffmpeg in the VM
  console.log("\n3. Installing ffmpeg...");
  const installResult = await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    {
      cmd: ["apk", "add", "--no-cache", "ffmpeg"],
      timeout: 120000,
    }
  );
  if (installResult.isErr()) {
      console.error("Failed to execute install command:", installResult.error);
      await cleanup(machineId);
      process.exit(1);
  }
  
  const installOutput = installResult.unwrap();
  if (installOutput.exit_code !== 0) {
    console.log(`   stderr: ${installOutput.stderr}`);
    console.error("Failed to install ffmpeg (exit code != 0)");
    await cleanup(machineId);
    process.exit(1);
  }
  console.log("   ffmpeg installed successfully!");

  // Step 4: Generate a test video pattern (since we don't have a real video)
  console.log("\n4. Generating test video pattern...");
  const generateResult = await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    {
      cmd: [
        "ffmpeg",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=5:size=640x480:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=5",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-y",
        "/tmp/input.mp4",
      ],
      timeout: 60000,
    }
  );

  if (generateResult.isErr()) {
     console.error("Failed to execute generate command:", generateResult.error);
     await cleanup(machineId);
     process.exit(1);
  }

  const generateOutput = generateResult.unwrap();
  if (generateOutput.exit_code !== 0) {
    console.log(`   stderr: ${generateOutput.stderr}`);
    console.error("Failed to generate test video");
    await cleanup(machineId);
    process.exit(1);
  }
  console.log("   Test video generated: /tmp/input.mp4");

  // Step 5: Process the video (convert to WebM)
  console.log("\n5. Converting video to WebM format...");
  const convertResult = await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    {
      cmd: [
        "ffmpeg",
        "-i",
        "/tmp/input.mp4",
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "30",
        "-b:v",
        "0",
        "-c:a",
        "libopus",
        "-y",
        "/tmp/output.webm",
      ],
      timeout: 120000,
    }
  );
  
  if (convertResult.isErr()) {
     console.error("Failed to execute convert command:", convertResult.error);
     await cleanup(machineId);
     process.exit(1);
  }

  const convertOutput = convertResult.unwrap();
  if (convertOutput.exit_code !== 0) {
    console.log(`   stderr: ${convertOutput.stderr}`);
    console.error("Failed to convert video");
    await cleanup(machineId);
    process.exit(1);
  }
  console.log("   Video converted successfully!");

  // Step 6: Get file info
  console.log("\n6. Checking output file...");
  try {
      const statResponse = await fetch(
        `${API_URL}/machines/${machineId}/files/stat?path=/tmp/output.webm`,
        {
          headers: { Authorization: `Bearer ${API_KEY}` },
        }
      );
      if (statResponse.ok) {
        const stat = await statResponse.json();
        console.log(`   Output file size: ${stat.size} bytes`);
      }
  } catch(e) { console.error("Failed stat:", e); }

  // Step 7: Download the result
  console.log("\n7. Downloading converted video...");
  try {
      const downloadResponse = await fetch(
        `${API_URL}/machines/${machineId}/files?path=/tmp/output.webm`,
        {
          headers: { Authorization: `Bearer ${API_KEY}` },
        }
      );
      if (downloadResponse.ok) {
        const data = await downloadResponse.json();
        const content = Buffer.from(data.content, "base64");
        const outputPath = "/tmp/ffmpeg-output.webm";
        await Bun.write(outputPath, content);
        console.log(`   Downloaded to ${outputPath} (${content.length} bytes)`);
      }
  } catch(e) { console.error("Failed download:", e); }

  // Step 8: Extract a thumbnail
  console.log("\n8. Extracting thumbnail...");
  const thumbResult = await apiRequest<ExecResult>(
    "POST",
    `/machines/${machineId}/exec`,
    {
      cmd: [
        "ffmpeg",
        "-i",
        "/tmp/input.mp4",
        "-ss",
        "00:00:02",
        "-vframes",
        "1",
        "-y",
        "/tmp/thumbnail.jpg",
      ],
      timeout: 30000,
    }
  );
  
  if (thumbResult.isOk() && thumbResult.unwrap().exit_code === 0) {
    try {
        const thumbResponse = await fetch(
          `${API_URL}/machines/${machineId}/files?path=/tmp/thumbnail.jpg`,
          {
            headers: { Authorization: `Bearer ${API_KEY}` },
          }
        );
        if (thumbResponse.ok) {
          const data = await thumbResponse.json();
          const content = Buffer.from(data.content, "base64");
          const thumbPath = "/tmp/ffmpeg-thumbnail.jpg";
          await Bun.write(thumbPath, content);
          console.log(`   Thumbnail saved to ${thumbPath} (${content.length} bytes)`);
        }
    } catch(e) { console.error("Failed thumbnail download:", e); }
  }

  console.log("\n=== Example completed successfully! ===");
  console.log("\nOutput files:");
  console.log("  - /tmp/ffmpeg-output.webm (converted video)");
  console.log("  - /tmp/ffmpeg-thumbnail.jpg (video thumbnail)");
  
  await cleanup(machineId);
}

async function cleanup(machineId: string | null) {
    if (machineId) {
      console.log("\nCleaning up...");
      const stopResult = await apiRequest("POST", `/machines/${machineId}/stop`);
      if (stopResult.isOk()) {
        await waitForStatus(machineId, "stopped", 10000).catch(() => {});
      }
      
      const delResult = await apiRequest("DELETE", `/machines/${machineId}`);
      if (delResult.isOk()) {
          console.log("VM deleted.");
      }
    }
}

main();
