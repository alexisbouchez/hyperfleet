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

const API_URL = process.env.API_URL ?? "http://localhost:3000/api/v1";
const API_KEY = process.env.API_KEY ?? "test-key";

interface Machine {
  id: string;
  name: string;
  status: string;
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
  console.log("=== FFmpeg Video Processing Example ===\n");

  let machineId: string | null = null;

  try {
    // Step 1: Create a VM from Alpine OCI image
    console.log("1. Creating VM from Alpine OCI image...");
    const machine = await apiRequest<Machine>("POST", "/machines", {
      name: "ffmpeg-worker",
      vcpu_count: 2,
      mem_size_mib: 1024,
      image: "alpine:latest",
      image_size_mib: 2048, // 2GB rootfs for ffmpeg and video files
      network: { enable: true }, // Enable network for package downloads
    });
    machineId = machine.id;
    console.log(`   Created machine: ${machineId}`);

    // Step 2: Start the VM
    console.log("\n2. Starting VM...");
    await apiRequest("POST", `/machines/${machineId}/start`);
    await waitForStatus(machineId, "running");
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
    if (installResult.exit_code !== 0) {
      console.log(`   stderr: ${installResult.stderr}`);
      throw new Error("Failed to install ffmpeg");
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
    if (generateResult.exit_code !== 0) {
      console.log(`   stderr: ${generateResult.stderr}`);
      throw new Error("Failed to generate test video");
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
    if (convertResult.exit_code !== 0) {
      console.log(`   stderr: ${convertResult.stderr}`);
      throw new Error("Failed to convert video");
    }
    console.log("   Video converted successfully!");

    // Step 6: Get file info
    console.log("\n6. Checking output file...");
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

    // Step 7: Download the result
    console.log("\n7. Downloading converted video...");
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
    if (thumbResult.exit_code === 0) {
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
    }

    console.log("\n=== Example completed successfully! ===");
    console.log("\nOutput files:");
    console.log("  - /tmp/ffmpeg-output.webm (converted video)");
    console.log("  - /tmp/ffmpeg-thumbnail.jpg (video thumbnail)");
  } catch (error) {
    console.error("\nError:", error);
    process.exit(1);
  } finally {
    // Cleanup: Stop and delete the VM
    if (machineId) {
      console.log("\nCleaning up...");
      try {
        await apiRequest("POST", `/machines/${machineId}/stop`);
        await waitForStatus(machineId, "stopped", 10000).catch(() => {});
      } catch {
        // Ignore stop errors
      }
      try {
        await apiRequest("DELETE", `/machines/${machineId}`);
        console.log("VM deleted.");
      } catch {
        // Ignore delete errors
      }
    }
  }
}

main();
