# FFmpeg Video Processing Example

Demonstrates using Hyperfleet to run FFmpeg video processing in an isolated microVM, showcasing OCI image support and file transfer capabilities.

## What it does

1. Creates a VM from the `alpine:latest` OCI image
2. Installs ffmpeg inside the VM
3. Generates a test video pattern
4. Converts the video to WebM format
5. Extracts a thumbnail
6. Downloads the results to your local machine
7. Cleans up the VM

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
cd examples/ffmpeg
bun install
bun run start
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:3000` | Hyperfleet API URL |
| `API_KEY` | `test-key` | API authentication key |

## Expected output

```
=== FFmpeg Video Processing Example ===

1. Creating VM from Alpine OCI image...
   Created machine: abc123

2. Starting VM...
   VM is running!
   Waiting for guest init...

3. Installing ffmpeg...
   ffmpeg installed successfully!

4. Generating test video pattern...
   Test video generated: /tmp/input.mp4

5. Converting video to WebM format...
   Video converted successfully!

6. Checking output file...
   Output file size: 123456 bytes

7. Downloading converted video...
   Downloaded to ./output.webm (123456 bytes)

8. Extracting thumbnail...
   Thumbnail saved to ./thumbnail.jpg (12345 bytes)

=== Example completed successfully! ===

Output files:
  - ./output.webm (converted video)
  - ./thumbnail.jpg (video thumbnail)

Cleaning up...
VM deleted.
```

## Processing your own videos

To process your own video file, you can upload it before processing:

```typescript
// Upload a video file
const videoContent = await Bun.file("./my-video.mp4").arrayBuffer();
await fetch(`${API_URL}/machines/${machineId}/files`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    path: "/tmp/input.mp4",
    content: Buffer.from(videoContent).toString("base64"),
  }),
});
```

## Use cases

- Video transcoding (MP4 to WebM, AVI to MP4, etc.)
- Thumbnail generation
- Video compression
- Audio extraction
- Format conversion
- Batch processing in isolated environments
