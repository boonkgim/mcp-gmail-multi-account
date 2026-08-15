See [CLAUDE.md](CLAUDE.md) for the quality-check workflow to run before committing.

## Setting this project up for a user

If asked to set this project up (deploy it to Cloudflare Workers and connect
it to claude.ai), work through the README's "Google Cloud setup" and
"Cloudflare setup" sections (`docs/google-cloud-setup.md` has the detailed
click-by-click version) — but split the work like this:

### You can do directly, without asking

- `npm install`
- `cp wrangler.jsonc.example wrangler.jsonc` and
  `cp .env.development.example .env.development` — both gitignored, your
  own local config rather than the repo's.
- `npx wrangler login` (opens a browser for the user to approve; wait for
  it to complete) and `npx wrangler whoami`. If `whoami` lists more than one
  account, add `"account_id"` to `wrangler.jsonc` yourself (see the comment
  there), or set `CLOUDFLARE_ACCOUNT_ID`.
- `npx wrangler kv namespace create OAUTH_KV` — parse the printed `id` out
  of the output and write it into **both** `kv_namespaces[0].id` and
  `env.development.kv_namespaces[0].id` in `wrangler.jsonc` yourself; don't
  ask the user to copy/paste it.
- Setting secrets: don't leave `npx wrangler secret put NAME` sitting on an
  interactive prompt. Once the user has given you a value, pipe it in
  non-interactively, e.g. `printf '%s' "$VALUE" | npx wrangler secret put
NAME`. For `COOKIE_ENCRYPTION_KEY` you can generate it yourself: `openssl
rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY`.
- `npm run deploy` — parse the printed Worker URL out of the output, write
  it into `wrangler.jsonc`'s top-level `vars.PUBLIC_URL` yourself, and
  redeploy. Don't ask the user to do this by hand.
- For local dev: once you have the same three values, fill them into
  `.env.development` yourself and run `npm run dev`.

### Only the user can do this — hand it back to them

- Creating/picking the Google Cloud project, enabling the Gmail API, and
  configuring the OAuth consent screen + test users (README "1. Google
  Cloud setup", or the detailed walkthrough in
  `docs/google-cloud-setup.md`) — all in the Cloud Console UI. Ask them to
  do it and report back the **Client ID** and **Client Secret**.
- Going back into the Google Cloud Console to add/confirm the OAuth
  client's redirect URIs once the Worker URL is known (`<url>/callback`
  and `<url>/accounts/callback`).
- Adding the deployed Worker as a custom connector in claude.ai (README "4.
  Connect it to claude.ai") and approving the OAuth consent screens — this
  happens in their own claude.ai session, not yours.

Tell the user up front which parts you're about to automate and which you
need them for, so they're not surprised by you editing `wrangler.jsonc` or
running deploys on their behalf.
