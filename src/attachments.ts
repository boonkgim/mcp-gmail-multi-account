// Ephemeral attachment upload store. Lets a shell (curl) upload a file's
// bytes directly to this Worker's HTTP endpoint (attachments-handler.ts),
// out of band from the MCP tool-call JSON — so an LLM never has to retype
// a file's base64 into a tool call, which is both expensive (huge output
// token cost for anything but tiny files) and risky (one mistyped
// character corrupts the attachment). A short-lived, per-owner upload key
// (minted by the get_attachment_upload_key MCP tool) authorizes the
// upload; the resulting ref is then passed as an attachment's `ref` field
// (instead of `content`) to create_draft/update_draft/send_message, which
// resolves and consumes it server-side.

const UPLOAD_KEY_PREFIX = "attachment-upload-key:";
const UPLOAD_KEY_TTL_SECONDS = 3600; // 1 hour

const BLOB_KEY_PREFIX = "attachment-blob:";
const BLOB_TTL_SECONDS = 900; // 15 minutes — expected to be consumed within the same task

// KV values cap at 25MB; leave headroom since base64 inflates size by ~1.37x.
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export interface StoredAttachment {
  ownerId: string;
  content: string; // base64
  filename?: string;
  mimeType?: string;
}

/** Mints a key a shell can use to authorize uploads on this owner's behalf. */
export async function mintUploadKey(env: Env, ownerId: string): Promise<string> {
  const key = crypto.randomUUID();
  await env.OAUTH_KV.put(UPLOAD_KEY_PREFIX + key, ownerId, {
    expirationTtl: UPLOAD_KEY_TTL_SECONDS,
  });
  return key;
}

/** Looks up which owner an upload key belongs to, without consuming it (reusable until it expires). */
export async function resolveUploadKeyOwner(env: Env, key: string): Promise<string | null> {
  return env.OAUTH_KV.get(UPLOAD_KEY_PREFIX + key);
}

/** Stores an uploaded file's bytes, returning a one-time ref to hand to a tool call. */
export async function storeAttachment(env: Env, attachment: StoredAttachment): Promise<string> {
  const ref = crypto.randomUUID();
  await env.OAUTH_KV.put(BLOB_KEY_PREFIX + ref, JSON.stringify(attachment), {
    expirationTtl: BLOB_TTL_SECONDS,
  });
  return ref;
}

/**
 * Looks up and deletes an uploaded attachment (one-time use). Returns null
 * if the ref is unknown, expired, or belongs to a different owner.
 */
export async function consumeAttachment(
  env: Env,
  ownerId: string,
  ref: string,
): Promise<StoredAttachment | null> {
  const key = BLOB_KEY_PREFIX + ref;
  const raw = await env.OAUTH_KV.get(key);
  if (!raw) return null;
  await env.OAUTH_KV.delete(key);
  const stored = JSON.parse(raw) as StoredAttachment;
  return stored.ownerId === ownerId ? stored : null;
}
