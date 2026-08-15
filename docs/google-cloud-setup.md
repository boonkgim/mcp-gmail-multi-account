# Google Cloud + Cloudflare setup guide

A detailed walkthrough of the one-time setup this project needs, expanding on
the README's quickstart with the specific screens/menus involved and a few
gotchas in the current (2026) Google Cloud and Wrangler UIs. Follow this
top to bottom on a fresh clone.

## 1. Create a Google Cloud project

Go to the [Google Cloud Console](https://console.cloud.google.com/projectcreate)
and create a new project.

- Pick a name that's reusable, not scoped to just this server (e.g.
  `mcp-connectors` rather than `mcp-gmail-multi-account`) — you'll likely
  want to register other Google OAuth clients (Calendar, Drive, etc.) under
  the same project later, since a Google Cloud project's OAuth consent
  screen is shared by all OAuth clients created inside it.
- If project creation is blocked by your account's quota, either delete an
  unused project first or request a quota increase from the same screen —
  deleted projects take up to 30 days to fully release their quota slot.

## 2. Enable the Gmail API

APIs & Services → Library → search **Gmail API** → **Enable**.

## 3. Configure the OAuth consent screen

This now lives under **Google Auth Platform** in the left sidebar (not
"OAuth consent screen" — Google renamed/restructured this recently). If the
project has never had one configured, you'll land on an "Overview" page with
a **Get started** button that walks through a 4-step wizard:

1. **App Information** — app name (shown to users during consent) and a
   support email.
2. **Audience** — choose **External** unless this is a Google Workspace
   account restricting access to your own organisation.
3. **Contact Information** — an email for Google to send project notices to.
4. **Finish** — agree to the API services user data policy.

After creating it, go to **Audience** in the sidebar and add every Google
account you plan to connect (your primary sign-in account _and_ any
additional Gmail accounts you'll link later) under **Test users**. While the
app is in "Testing" publishing status (the default, and fine for personal
use), only listed test users can complete the OAuth flow — everyone else
gets blocked before reaching the consent screen. Because this server is
designed to connect _multiple_ Gmail accounts to one owner, make sure all of
them are listed here up front.

## 4. Create the OAuth Client ID

**Clients** in the sidebar → **Create client**:

- Application type: **Web application**
- Name: anything identifying (e.g. `mcp-gmail-multi-account`)
- Authorized redirect URIs: add both of these now for local dev —
  `http://localhost:8788/callback` and
  `http://localhost:8788/accounts/callback` (the first completes
  authorizing the Claude connector itself; the second completes connecting
  each additional Gmail account). You'll add the production equivalents in
  step 10, after deploying.

On creation, Google shows the Client ID and Client Secret **once** — the
secret can't be viewed again after closing the dialog (only rotated). Use
the **Download JSON** option rather than copying by hand, to avoid a
transcription mistake; delete the downloaded file once you've copied its
values into `.env.development` (next step).

## 5. Local secrets file

```bash
cp .env.development.example .env.development
```

Fill in the three values:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from step 4.
- `COOKIE_ENCRYPTION_KEY` — generate with `openssl rand -hex 32`.

`.env.development` is gitignored; never commit it.

Run `npm run dev` to confirm `wrangler dev --env development` picks the file
up correctly (it's wired to `--env development` specifically so it loads
`.env.development` rather than a plain `.env` — see the comment in
`wrangler.jsonc` if you ever rename that environment).

## 6. Pick a Cloudflare account

```bash
npx wrangler login
npx wrangler whoami
```

If the output lists more than one account, add the one you want this Worker
under to `wrangler.jsonc`:

```jsonc
"account_id": "<the account id from whoami>",
```

Without this, any non-interactive `wrangler` command (secret put, deploy)
fails with "More than one account available but unable to select one in
non-interactive mode."

## 7. Create the KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Paste the printed `id` into **both** places in `wrangler.jsonc` — the
top-level `kv_namespaces` block and the identical one under
`env.development` (Wrangler doesn't let named environments inherit
`kv_namespaces`/`durable_objects`/`migrations` from the top level, so they're
duplicated there; keep the two `id` values in sync if it ever changes). This
one namespace stores both OAuth state and the connected-accounts data — no
second KV namespace is needed.

## 8. Push secrets to Cloudflare

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --env=""
npx wrangler secret put GOOGLE_CLIENT_SECRET --env=""
npx wrangler secret put COOKIE_ENCRYPTION_KEY --env=""
```

The `--env=""` is required (and `npm run deploy` already passes it) because
`wrangler.jsonc` defines a named `development` environment — without an
explicit `--env`, Wrangler refuses to guess whether you meant the top-level
(production) environment or `development`, to avoid secrets landing in the
wrong place.

## 9. Deploy

```bash
npm run deploy
```

This prints the Worker's URL, e.g.
`https://mcp-gmail-multi-account.<your-subdomain>.workers.dev`.

## 10. Finalize the redirect URIs and PUBLIC_URL

Go back to the OAuth client from step 4 in Cloud Console and add two more
authorized redirect URIs using the printed URL: `<that-url>/callback` and
`<that-url>/accounts/callback` (keep the `localhost:8788` ones too, for
local dev).

Then edit `wrangler.jsonc`'s top-level `vars.PUBLIC_URL` to that same URL
(it's used to build the "connect another Gmail account" links the
`get_gmail_connect_link` tool returns) and redeploy:

```bash
npm run deploy
```

## 11. Connect it to claude.ai

In claude.ai: **Settings → Customize → Connectors → Add → Add custom
connector** (connector management moved out of the old Settings →
Connectors page). Fill in:

- Name: anything (e.g. `Gmail`)
- Remote MCP server URL: `<your-worker-url>/mcp`
- Leave the optional OAuth Client ID/Secret fields blank — this Worker runs
  its own OAuth server (via `workers-oauth-provider`) and claude.ai
  registers with it automatically; those fields are only for connectors that
  proxy a third-party OAuth provider directly.

Click **Connect**. You'll see two consent screens in sequence: this
project's own approval screen (confirming claude.ai as the client), then
Google's real account picker and consent screen. Since the app is in
Testing mode, Google will show a "Google hasn't verified this app" warning —
click **Advanced → Go to \<app name\> (unsafe)** to proceed (safe to ignore
for your own test project). After approving, you're redirected back to
claude.ai and the connector shows as connected — with that first Google
account already registered as your first connected Gmail account.

## 12. Connect additional Gmail accounts

Ask Claude to run the `get_gmail_connect_link` tool (e.g. "connect my other
Gmail account"). Open the returned link, pick/sign in to the other Google
account (Google will prompt an account chooser), and approve. Once you're
back on the "Gmail account connected" page, that account is available to
every Gmail tool going forward — pass its address in the `account`
parameter to target it (or ask Claude to; it can call `list_gmail_accounts`
to see what's available).
