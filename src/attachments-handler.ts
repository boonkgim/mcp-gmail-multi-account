// The shell-side half of the attachment-ref flow: curl (or any HTTP
// client) POSTs a file here directly, authorized by a short-lived key
// minted via the get_attachment_upload_key MCP tool. This is deliberately
// outside the MCP session/OAuth flow — the whole point is that a client
// with local file access but no MCP bearer token (e.g. a coding agent's
// shell) can move bytes to this Worker without an LLM ever having to
// retype them into a tool call.

import { Hono } from "hono";
import { MAX_ATTACHMENT_BYTES, resolveUploadKeyOwner, storeAttachment } from "./attachments";

const app = new Hono<{ Bindings: Env }>();

app.post("/upload", async (c) => {
  const auth = c.req.header("Authorization");
  const key = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!key) {
    return c.json({ error: "Missing Authorization: Bearer <upload key> header." }, 401);
  }

  const ownerId = await resolveUploadKeyOwner(c.env, key);
  if (!ownerId) {
    return c.json(
      { error: "Upload key is invalid or expired. Call get_attachment_upload_key again." },
      401,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart/form-data with a "file" field.' }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing "file" field (multipart/form-data).' }, 400);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return c.json(
      { error: `File too large: ${file.size} bytes (max ${MAX_ATTACHMENT_BYTES}).` },
      413,
    );
  }

  const content = Buffer.from(await file.arrayBuffer()).toString("base64");
  const filenameField = form.get("filename");
  const mimeTypeField = form.get("mimeType");
  const filename = typeof filenameField === "string" ? filenameField : file.name || undefined;
  const mimeType = typeof mimeTypeField === "string" ? mimeTypeField : file.type || undefined;
  const ref = await storeAttachment(c.env, { ownerId, content, filename, mimeType });

  return c.json({ ref, expiresInSeconds: 900 });
});

export { app as AttachmentsHandler };
