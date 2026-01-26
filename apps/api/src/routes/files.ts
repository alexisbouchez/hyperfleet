import { Elysia, t } from "elysia";
import type { FileService } from "../services/files";
import type { AuthService } from "../services/auth";
import type { Logger } from "@hyperfleet/logger";
import { getHttpStatus } from "@hyperfleet/errors";

const errorResponse = t.Object({
  error: t.String(),
  message: t.String(),
});

const fileStatResponse = t.Object({
  path: t.String(),
  size: t.Number(),
  mode: t.String(),
  mod_time: t.String(),
  is_dir: t.Boolean(),
});

const uploadResponse = t.Object({
  success: t.Boolean(),
  bytes_written: t.Number(),
});

// Type for context with our derived services
type Context = {
  fileService: FileService;
  authService: AuthService;
  logger: Logger;
};

/**
 * Validate API key from Authorization header
 */
async function validateAuth(
  request: Request,
  set: { status?: number | string },
  authService: AuthService,
  logger: Logger
): Promise<boolean> {
  const authHeader = request.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    set.status = 401;
    return false;
  }

  const token = authHeader.slice(7);
  const apiKey = await authService.validateKey(token);

  if (!apiKey) {
    logger.warn("Invalid API key attempt", { prefix: token.slice(0, 11) });
    set.status = 401;
    return false;
  }

  logger.debug("Request authenticated", { keyId: apiKey.id, keyName: apiKey.name });
  return true;
}

export const fileRoutes = (disableAuth: boolean) =>
  new Elysia({ prefix: "/machines/:id/files", tags: ["files"] })
    // POST /machines/:id/files - Upload file
    .post(
      "/",
      async (ctx) => {
        const { params, body, set, fileService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        // Get file content from body
        const content = Buffer.from(body.content, "base64");

        const result = await fileService.uploadFile(params.id, body.path, content);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }

        const data = result.unwrap();
        return { success: true, bytes_written: data.bytes_written };
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        body: t.Object({
          path: t.String({ description: "Absolute path on the VM where the file will be written" }),
          content: t.String({ description: "Base64-encoded file content" }),
        }),
        response: {
          200: uploadResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
        detail: {
          summary: "Upload file",
          description: "Upload a file to a running VM. Content must be base64-encoded.",
        },
      }
    )

    // GET /machines/:id/files - Download file
    .get(
      "/",
      async (ctx) => {
        const { params, query, set, fileService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await fileService.downloadFile(params.id, query.path);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }

        // Return base64-encoded content
        const content = result.unwrap();
        return {
          content: content.toString("base64"),
          size: content.length,
        };
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        query: t.Object({
          path: t.String({ description: "Absolute path on the VM to download" }),
        }),
        response: {
          200: t.Object({
            content: t.String({ description: "Base64-encoded file content" }),
            size: t.Number({ description: "File size in bytes" }),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
        detail: {
          summary: "Download file",
          description: "Download a file from a running VM. Content is base64-encoded.",
        },
      }
    )

    // GET /machines/:id/files/stat - Get file info
    .get(
      "/stat",
      async (ctx) => {
        const { params, query, set, fileService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await fileService.statFile(params.id, query.path);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }

        return result.unwrap();
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        query: t.Object({
          path: t.String({ description: "Absolute path on the VM to stat" }),
        }),
        response: {
          200: fileStatResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
        detail: {
          summary: "Get file info",
          description: "Get file/directory information from a running VM",
        },
      }
    )

    // DELETE /machines/:id/files - Delete file
    .delete(
      "/",
      async (ctx) => {
        const { params, query, set, fileService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await fileService.deleteFile(params.id, query.path);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }

        set.status = 204;
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        query: t.Object({
          path: t.String({ description: "Absolute path on the VM to delete" }),
        }),
        response: {
          204: t.Void(),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
        detail: {
          summary: "Delete file",
          description: "Delete a file from a running VM",
        },
      }
    );
