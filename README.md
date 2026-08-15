# mcp-gmail-multi-account

[![CI](https://github.com/boonkgim/mcp-gmail-multi-account/actions/workflows/ci.yml/badge.svg)](https://github.com/boonkgim/mcp-gmail-multi-account/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A remote MCP server for Gmail, deployed on Cloudflare Workers, for use as a
**custom connector in claude.ai** (web/desktop/mobile) — built because the
official Gmail connector only supports one account at a time. This one lets
a single connector authorization manage **any number of connected Gmail
accounts** (personal, work, side project, ...), with tools that let Claude
pick which account to act on.

Each user who connects authorizes their own Google account(s) via OAuth —
the server proxies that OAuth flow and never sees your Google password, just
the refresh tokens it needs to call the Gmail API on your behalf.

> **Setting this up with an AI coding agent?** Clone the repo and just ask
> it (e.g. "help me set up this MCP server") — it can run the `npm`/
> `wrangler` commands below and edit `wrangler.jsonc` itself. See
> [AGENTS.md](AGENTS.md) for exactly what it can automate versus what
> needs you in a browser (the Google Cloud Console steps and the
> claude.ai connector step).

## Architecture

- **`@cloudflare/workers-oauth-provider`** — implements the OAuth 2.1 server
  that claude.ai talks to (authorize/token/dynamic client registration), and
  hands your Worker an encrypted `props` bag identifying the connector
  _owner_ (email + name) once per authorized Claude session.
- **`google-handler.ts`** — a small Hono app that owns `/authorize` and
  `/callback`: shows the consent screen, redirects to Google, exchanges the
  code for tokens. The first Google account signed in here both establishes
  the owner's identity and is registered as their first connected Gmail
  account.
- **`accounts.ts`** — the multi-account store. Connected Gmail accounts
  (email + refresh token) are kept in KV, keyed by owner, independent of the
  Worker's own OAuth session lifetime — this is what makes "more than one
  Gmail account" possible at all, since a single Google OAuth consent screen
  can only ever authorize one account at a time.
- **`accounts-handler.ts`** — the "connect another Gmail account" flow.
  The `get_gmail_connect_link` tool mints a one-time link; opening it starts
  a _fresh_ Google OAuth round trip (with the account chooser forced open),
  and the resulting refresh token is added to the same owner's account list
  in KV — it does not touch the Claude-facing OAuth session at all.
- **`agents`' `McpAgent`** — a Durable Object-backed MCP server. Tool calls
  resolve which connected account to use (`accounts.ts`'s `resolveAccount`),
  mint that account a fresh Google access token on demand (cached in-memory
  per Worker isolate), and call the Gmail API (`gmail.ts`).
- **`workers-oauth-utils.ts`** — CSRF/session/approval-dialog plumbing,
  copied near-verbatim from Cloudflare's reference OAuth demo (provider-agnostic).

## Tools

Account management:

- `list_gmail_accounts` — list connected accounts
- `get_gmail_connect_link` — get a one-time link to connect another account
- `disconnect_gmail_account` — remove a connected account
- `set_send_permission` — allow/disallow the sending tools below (off by default)

Reading:

- `search_messages` — search with Gmail's query syntax (or list recent inbox mail)
- `get_message` / `get_thread` — full content of a message or thread
- `list_labels` — list system + user labels

Sending — **disabled by default**, see [Sending is off by default](#sending-is-off-by-default) below:

- `send_message` — compose and send
- `reply_to_message` — reply in-thread (optionally reply-all)

Drafts — always available, regardless of the sending toggle:

- `create_draft` / `list_drafts` / `send_draft`

Organizing:

- `modify_labels` — generic add/remove labels (star, mark read/unread, etc.)
- `archive_message` / `trash_message`

Every tool other than the account-management ones takes an optional
`account` parameter — the Gmail address to act on. It's optional only when
exactly one account is connected; with more than one, omitting it returns an
error listing the connected accounts to choose from.

### Sending is off by default

`send_message`, `reply_to_message`, and `send_draft` — anything that causes
mail to actually leave the account — are blocked until you (or Claude, on
your explicit say-so) call `set_send_permission` with `allow: true`. Until
then, calling any of them returns a message pointing Claude at `create_draft`
instead. This is a per-owner setting stored in KV (not per-deployment), so
it persists across Claude sessions and covers every connected account; call
`set_send_permission` with `allow: false` to turn it back off.

## 1. Google Cloud setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. Enable the **Gmail API**.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Authorized redirect URIs: `https://<your-worker-subdomain>.workers.dev/callback`
     **and** `https://<your-worker-subdomain>.workers.dev/accounts/callback`
     (you'll know your Worker's URL after the first `wrangler deploy` — you
     can add/edit these afterward in the Cloud Console).
   - Save the **Client ID** and **Client Secret**.
4. If your OAuth consent screen is in "Testing" mode, add every Google account
   you plan to connect (not just your primary one) as test users.

See [`docs/google-cloud-setup.md`](docs/google-cloud-setup.md) for a more
detailed, click-by-click walkthrough.

## 2. Cloudflare setup

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc   # gitignored — this is your own config, not the repo's
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` printed by the last command into your `wrangler.jsonc` under both
`kv_namespaces[0].id` and `env.development.kv_namespaces[0].id`. This one KV
namespace stores both OAuth state and the connected-accounts data.

If `npx wrangler whoami` lists more than one Cloudflare account, add
`"account_id"` to your `wrangler.jsonc` (see the comment there) or set the
`CLOUDFLARE_ACCOUNT_ID` env var — otherwise `wrangler` can't tell which
account to deploy to.

Set secrets (each command prompts for the value on stdin):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # e.g. output of: openssl rand -hex 32
```

Scripting this instead of typing interactively? Pipe the value in:
`printf '%s' "$VALUE" | npx wrangler secret put NAME` (and
`openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY` for
the third one).

## 3. Deploy

```bash
npm run deploy
```

This prints your Worker's URL, e.g. `https://mcp-gmail-multi-account.<your-subdomain>.workers.dev`.
Go back to the Google Cloud Console and make sure the OAuth client's redirect
URIs are exactly `<that-url>/callback` and `<that-url>/accounts/callback`.

Then edit your `wrangler.jsonc`'s top-level `vars.PUBLIC_URL` to that same
URL — it's used to build the "connect another Gmail account" link — and
redeploy (`npm run deploy` again).

## 4. Connect it to claude.ai

In claude.ai: **Settings → Connectors → Add custom connector**, and enter:

```
https://mcp-gmail-multi-account.<your-subdomain>.workers.dev/mcp
```

Claude will walk you through authorizing — you'll see the consent screen
from `google-handler.ts`, then Google's own OAuth screen. Once approved, the
Gmail tools are available, with that first Google account already connected.

## 5. Connect additional Gmail accounts

Ask Claude to connect another account (it'll call `get_gmail_connect_link`)
and open the link it gives you. Pick a different Google account at Google's
account chooser, approve, and it's added — no need to reauthorize the
Claude connector itself.

## Local development

```bash
cp .env.development.example .env.development   # fill in the same three values as the secrets above
npm run dev
```

`wrangler dev` runs the Worker locally; note that Google's OAuth redirects
must match what you're actually running against (add
`http://localhost:8788/callback` and `http://localhost:8788/accounts/callback`
as additional authorized redirect URIs in Google Cloud Console for local
testing).

## Notes

- Uses the `https://www.googleapis.com/auth/gmail.modify` OAuth scope (read,
  compose, send, and organize mail, but not permanent delete) plus
  `email profile` to identify each connecting account.
- Google access tokens expire in ~1 hour; this server refreshes them on
  demand from the stored refresh token, per connected account, rather than
  syncing to this Worker's own OAuth token lifetime.
- `search_messages` hydrates each result with a metadata fetch (subject,
  from, to, date) since Gmail's `messages.list` only returns bare message
  ids — capped to a max of 100 results per call to bound the fan-out.
- Attachment downloads aren't implemented — `get_message`/`get_thread`
  return attachment metadata (filename, type, size, attachment id) but not
  content.
- See [SECURITY.md](SECURITY.md) for the account-linking flow's threat
  model and how to report vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and the quality
checks (`npm run check`) to run before opening a PR.

## License

[MIT](LICENSE)
