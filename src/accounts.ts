// Multi-account store: which Gmail accounts (email + refresh token) a given
// connector owner has connected, plus the one-time link tokens used by the
// "connect another Gmail account" flow in accounts-handler.ts.
//
// Reuses the OAUTH_KV namespace the OAuth provider already needs, under
// distinct key prefixes, rather than requiring a second KV namespace.

export interface GmailAccount {
  email: string;
  refreshToken: string;
  connectedAt: number;
}

const ACCOUNTS_KEY_PREFIX = "gmail-accounts:";
const LINK_TOKEN_KEY_PREFIX = "gmail-link:";
const LINK_TOKEN_TTL_SECONDS = 900; // 15 minutes

export async function listAccounts(env: Env, ownerId: string): Promise<GmailAccount[]> {
  const raw = await env.OAUTH_KV.get(ACCOUNTS_KEY_PREFIX + ownerId);
  if (!raw) return [];
  return JSON.parse(raw) as GmailAccount[];
}

export async function upsertAccount(
  env: Env,
  ownerId: string,
  account: GmailAccount,
): Promise<void> {
  const accounts = await listAccounts(env, ownerId);
  const index = accounts.findIndex((a) => a.email.toLowerCase() === account.email.toLowerCase());
  if (index >= 0) {
    accounts[index] = account;
  } else {
    accounts.push(account);
  }
  await env.OAUTH_KV.put(ACCOUNTS_KEY_PREFIX + ownerId, JSON.stringify(accounts));
}

export async function removeAccount(env: Env, ownerId: string, email: string): Promise<boolean> {
  const accounts = await listAccounts(env, ownerId);
  const remaining = accounts.filter((a) => a.email.toLowerCase() !== email.toLowerCase());
  if (remaining.length === accounts.length) return false;
  await env.OAUTH_KV.put(ACCOUNTS_KEY_PREFIX + ownerId, JSON.stringify(remaining));
  return true;
}

/**
 * Picks which connected account a tool call should act on: the explicitly
 * requested one, the sole connected account if there's only one, or a
 * descriptive error listing the choices otherwise.
 */
export function resolveAccount(accounts: GmailAccount[], requested?: string): GmailAccount {
  if (requested) {
    const match = accounts.find((a) => a.email.toLowerCase() === requested.toLowerCase());
    if (!match) {
      throw new Error(
        `No connected Gmail account matches "${requested}". Connected accounts: ` +
          (accounts.length
            ? accounts.map((a) => a.email).join(", ")
            : "(none — use get_gmail_connect_link)"),
      );
    }
    return match;
  }
  if (accounts.length === 1) return accounts[0];
  if (accounts.length === 0) {
    throw new Error("No Gmail accounts connected yet. Use get_gmail_connect_link to connect one.");
  }
  throw new Error(
    `Multiple Gmail accounts are connected — specify which one with the "account" parameter: ` +
      accounts.map((a) => a.email).join(", "),
  );
}

/**
 * Creates a one-time, short-lived token that the "connect another Gmail
 * account" link is built from. It doubles as the `state` param for the
 * Google OAuth round trip it kicks off, and is deleted once that flow
 * completes (see accounts-handler.ts).
 */
export async function createConnectLinkToken(env: Env, ownerId: string): Promise<string> {
  const token = crypto.randomUUID();
  await env.OAUTH_KV.put(LINK_TOKEN_KEY_PREFIX + token, ownerId, {
    expirationTtl: LINK_TOKEN_TTL_SECONDS,
  });
  return token;
}

/** Looks up the owner for a connect-link token without consuming it. */
export async function peekConnectLinkToken(env: Env, token: string): Promise<string | null> {
  return env.OAUTH_KV.get(LINK_TOKEN_KEY_PREFIX + token);
}

/** Looks up and deletes a connect-link token (one-time use, at flow completion). */
export async function consumeConnectLinkToken(env: Env, token: string): Promise<string | null> {
  const key = LINK_TOKEN_KEY_PREFIX + token;
  const ownerId = await env.OAUTH_KV.get(key);
  if (ownerId) await env.OAUTH_KV.delete(key);
  return ownerId;
}
