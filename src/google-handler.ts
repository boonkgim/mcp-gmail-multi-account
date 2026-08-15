import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { upsertAccount } from "./accounts";
import {
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  getGoogleAuthorizeUrl,
  type Props,
} from "./google-auth";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    return redirectToGoogle(c.req.raw, stateToken, { "Set-Cookie": sessionBindingCookie });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description:
        "This MCP server reads, sends, and organizes email in your connected Gmail accounts.",
      name: "Gmail MCP Server",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return redirectToGoogle(c.req.raw, stateToken, Object.fromEntries(headers));
  } catch (error) {
    console.error("POST /authorize error:", error);
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.text(`Internal server error: ${message}`, 500);
  }
});

function redirectToGoogle(
  request: Request,
  stateToken: string,
  headers: Record<string, string> = {},
) {
  return new Response(null, {
    headers: {
      ...headers,
      location: getGoogleAuthorizeUrl({
        clientId: env.GOOGLE_CLIENT_ID,
        redirectUri: new URL("/callback", request.url).href,
        state: stateToken,
      }),
    },
    status: 302,
  });
}

/**
 * OAuth callback from Google. Exchanges the code for tokens, looks up the
 * user's email/name, and completes the authorization back to the MCP client
 * (Claude). The email identifies the connector *owner* — Props carries no
 * Gmail refresh token; this first-signed-in account is instead registered as
 * the owner's first connected Gmail account (accounts.ts), same as any
 * account added later via the "connect another account" flow.
 */
app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text(`Google authorization failed: ${c.req.query("error") ?? "missing code"}`, 400);
  }

  const tokens = await exchangeGoogleCode(c.env, code, new URL("/callback", c.req.url).href);
  if (!tokens.refresh_token) {
    return c.text(
      "Google did not return a refresh token. Revoke this app's access at " +
        "https://myaccount.google.com/permissions and try authorizing again.",
      400,
    );
  }

  const { email, name } = await fetchGoogleUserInfo(tokens.access_token);

  await upsertAccount(c.env, email, {
    email,
    refreshToken: tokens.refresh_token,
    connectedAt: Date.now(),
  });

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: name },
    props: { email, name } as Props,
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: email,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }

  return new Response(null, { status: 302, headers });
});

export { app as GoogleHandler };
