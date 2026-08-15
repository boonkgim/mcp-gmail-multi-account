// Google OAuth: authorize-URL construction, code exchange, userinfo lookup,
// and on-demand access-token refresh (called fresh from each MCP tool call
// rather than synced to this Worker's own OAuth token lifetime).
//
// Unlike a single-account server, Props here only identifies *who is allowed
// to use this connector* (the owner) — it does not carry a Gmail refresh
// token. Refresh tokens for the (potentially many) connected Gmail accounts
// live in KV, keyed by owner; see accounts.ts.

export type Props = {
  email: string;
  name: string;
};

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface GoogleUserInfo {
  email: string;
  name: string;
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// Read/write/send access to Gmail, plus email/profile to identify the account.
export const GOOGLE_SCOPES = "https://www.googleapis.com/auth/gmail.modify email profile";

export function getGoogleAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  prompt = "consent",
}: {
  clientId: string;
  redirectUri: string;
  state: string;
  /** e.g. "consent" (default) or "consent select_account" for the account-linking flow. */
  prompt?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("state", state);
  // access_type=offline gets us a refresh token; prompt=consent forces Google to
  // reissue one on every authorization (it's otherwise only sent on first consent).
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", prompt);
  return url.href;
}

export async function exchangeGoogleCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Google token exchange failed: ${await resp.text()}`);
  }
  return resp.json();
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const resp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch Google user info: ${await resp.text()}`);
  }
  return resp.json();
}

// Keyed by refresh token, valid for the lifetime of this Worker isolate.
// Avoids hitting Google's token endpoint on every single MCP tool call.
// Naturally supports many concurrently-connected accounts, since each has
// its own refresh token and thus its own cache entry.
const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export async function getGoogleAccessToken(env: Env, refreshToken: string): Promise<string> {
  const cached = accessTokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Failed to refresh Google access token: ${await resp.text()}`);
  }
  const data: GoogleTokenResponse = await resp.json();
  accessTokenCache.set(refreshToken, {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
