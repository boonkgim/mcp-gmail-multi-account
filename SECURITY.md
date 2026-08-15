# Security

This server handles Google OAuth refresh tokens for potentially several
connected Gmail accounts, and access to send, read, and organize mail in
them. If you find a vulnerability — anything from a token handling bug to a
way one owner's connected accounts could be reached from another owner's
session — please report it privately rather than opening a public issue:

- Preferred: open a [GitHub Security Advisory](../../security/advisories/new)
  for this repo.
- Otherwise: email khurbk@gmail.com with details and, if possible, steps to
  reproduce.

Please don't test against other people's deployments or accounts — this is
a small, self-hosted project each user deploys under their own Cloudflare
account and Google Cloud project, so there's no shared production instance
to responsibly disclose against beyond your own.

## Scope

Things worth reporting:

- OAuth flow issues in the connector-authorization path (state/CSRF
  handling, token storage/scoping in `google-handler.ts` /
  `workers-oauth-utils.ts`).
- Issues in the account-linking path (`accounts-handler.ts` /
  `accounts.ts`) — in particular, anything that would let a connect link
  minted for one owner attach an account to a different owner's store, or
  let a link be replayed after use.
- Any way the Gmail API client (`gmail.ts`, `mime.ts`) could leak or
  corrupt data across accounts or requests — e.g. cross-account token
  bleed, or a crafted message causing a reply/send to go to the wrong
  recipients.

Things generally out of scope: vulnerabilities in upstream dependencies
(report those upstream), or issues that require you to already control the
Cloudflare account/secrets a given deployment runs under.

## Known trade-off

Connect links (from `get_gmail_connect_link`) are single-use, short-lived
(15 minute) bearer tokens rather than tied to a browser session — similar in
model to a password-reset email link. If one leaked before use, the worst
case is an attacker linking an account of _their own_ choosing into your
connector (visible via `list_gmail_accounts`, removable via
`disconnect_gmail_account`); it does not expose your existing accounts'
mail. This is a deliberate simplification for a self-hosted, single-owner
tool — see `accounts-handler.ts` for the reasoning.
