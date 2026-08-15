// The "connect another Gmail account" flow: a human opens a one-time link
// (minted by the get_gmail_connect_link MCP tool) in their browser, picks
// which Google account to authorize — separately from whichever account they
// used to authorize the Claude connector itself — and that account's refresh
// token gets stored under the same owner. This is deliberately simpler than
// google-handler.ts's OAuth-client-facing flow: there's no third-party OAuth
// client to protect against here, just a bearer link (like a password-reset
// email) that's single-use and short-lived.

import { Hono } from "hono";
import { consumeConnectLinkToken, peekConnectLinkToken, upsertAccount } from "./accounts";
import { exchangeGoogleCode, fetchGoogleUserInfo, getGoogleAuthorizeUrl } from "./google-auth";
import { sanitizeText } from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env }>();

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
             max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #333; line-height: 1.6; }
      .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 2rem; text-align: center; }
      h1 { font-size: 1.3rem; font-weight: 600; }
    </style>
  </head>
  <body><div class="card">${body}</div></body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

function expiredPage(): Response {
  return htmlPage(
    "Link expired",
    "<h1>This link has expired</h1><p>Connect links are single-use and valid for 15 minutes. " +
      "Ask Claude to run <code>get_gmail_connect_link</code> again to get a fresh one.</p>",
    400,
  );
}

app.get("/connect", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.text("Missing token", 400);

  const ownerId = await peekConnectLinkToken(c.env, token);
  if (!ownerId) return expiredPage();

  return new Response(null, {
    status: 302,
    headers: {
      location: getGoogleAuthorizeUrl({
        clientId: c.env.GOOGLE_CLIENT_ID,
        redirectUri: new URL("/accounts/callback", c.req.url).href,
        state: token,
        // Force the account chooser so the user can pick a *different*
        // Google account from whichever one they used to sign in to Claude.
        prompt: "consent select_account",
      }),
    },
  });
});

app.get("/callback", async (c) => {
  const token = c.req.query("state");
  if (!token) return c.text("Missing state", 400);

  const ownerId = await consumeConnectLinkToken(c.env, token);
  if (!ownerId) return expiredPage();

  const code = c.req.query("code");
  if (!code) {
    return c.text(`Google authorization failed: ${c.req.query("error") ?? "missing code"}`, 400);
  }

  const tokens = await exchangeGoogleCode(
    c.env,
    code,
    new URL("/accounts/callback", c.req.url).href,
  );
  if (!tokens.refresh_token) {
    return c.text(
      "Google did not return a refresh token. Revoke this app's access at " +
        "https://myaccount.google.com/permissions and try connecting again.",
      400,
    );
  }

  const { email } = await fetchGoogleUserInfo(tokens.access_token);
  await upsertAccount(c.env, ownerId, {
    email,
    refreshToken: tokens.refresh_token,
    connectedAt: Date.now(),
  });

  return htmlPage(
    "Gmail account connected",
    `<h1>Connected ${sanitizeText(email)}</h1><p>You can close this tab and return to Claude.</p>`,
  );
});

export { app as AccountsHandler };
