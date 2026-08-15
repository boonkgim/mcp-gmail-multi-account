// Per-owner "may this connector actually send mail" gate. Off by default —
// send_message/reply_to_message/send_draft all check this before doing
// anything irreversible, so Claude falls back to create_draft until a human
// explicitly opts in via the set_send_permission tool.

const SEND_PERMISSION_KEY_PREFIX = "send-permission:";

export async function isSendAllowed(env: Env, ownerId: string): Promise<boolean> {
  const value = await env.OAUTH_KV.get(SEND_PERMISSION_KEY_PREFIX + ownerId);
  return value === "true";
}

export async function setSendAllowed(env: Env, ownerId: string, allowed: boolean): Promise<void> {
  await env.OAUTH_KV.put(SEND_PERMISSION_KEY_PREFIX + ownerId, allowed ? "true" : "false");
}
