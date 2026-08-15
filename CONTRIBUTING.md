# Contributing

## Local setup

Follow the README's "Google Cloud setup" and "Cloudflare setup" sections
(or the more detailed [`docs/google-cloud-setup.md`](docs/google-cloud-setup.md))
to get your own test project deployed, then:

```bash
npm install
cp .env.development.example .env.development   # fill in your own values
npm run dev
```

## Before submitting a PR

Run the full quality chain and fix anything it flags:

```bash
npm run check   # type-check, lint, format:check, test
```

Individual pieces, if you want faster feedback while iterating:
`npm run type-check`, `npm run lint`, `npm run format`, `npm run test:watch`.

CI runs the same `npm run check` chain on every PR.

## Code style

- No comments unless they explain a non-obvious _why_ (a workaround, a
  constraint from the Gmail API, etc.) — not what the code does.
- Keep changes scoped to what's needed; avoid speculative abstraction.
- Add or update tests in `src/*.test.ts` for behavior changes, especially
  anything touching `gmail.ts`/`mime.ts`'s request/response shaping or
  `accounts.ts`'s multi-account resolution logic.
