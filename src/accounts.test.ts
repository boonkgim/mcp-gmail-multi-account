import { describe, expect, it } from "vitest";
import {
  consumeConnectLinkToken,
  createConnectLinkToken,
  listAccounts,
  peekConnectLinkToken,
  removeAccount,
  resolveAccount,
  upsertAccount,
  type GmailAccount,
} from "./accounts";

function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function fakeEnv(): Env {
  return { OAUTH_KV: fakeKv() } as unknown as Env;
}

describe("account store", () => {
  it("starts empty, then lists what's upserted", async () => {
    const env = fakeEnv();
    expect(await listAccounts(env, "owner@example.com")).toEqual([]);

    const account: GmailAccount = { email: "a@gmail.com", refreshToken: "rt1", connectedAt: 1 };
    await upsertAccount(env, "owner@example.com", account);
    expect(await listAccounts(env, "owner@example.com")).toEqual([account]);
  });

  it("updates an existing account in place, matched case-insensitively", async () => {
    const env = fakeEnv();
    await upsertAccount(env, "owner", {
      email: "a@gmail.com",
      refreshToken: "old",
      connectedAt: 1,
    });
    await upsertAccount(env, "owner", {
      email: "A@Gmail.com",
      refreshToken: "new",
      connectedAt: 2,
    });

    const accounts = await listAccounts(env, "owner");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].refreshToken).toBe("new");
  });

  it("keeps different owners' accounts separate", async () => {
    const env = fakeEnv();
    await upsertAccount(env, "owner1", {
      email: "a@gmail.com",
      refreshToken: "r1",
      connectedAt: 1,
    });
    await upsertAccount(env, "owner2", {
      email: "b@gmail.com",
      refreshToken: "r2",
      connectedAt: 1,
    });

    expect(await listAccounts(env, "owner1")).toEqual([
      { email: "a@gmail.com", refreshToken: "r1", connectedAt: 1 },
    ]);
    expect(await listAccounts(env, "owner2")).toEqual([
      { email: "b@gmail.com", refreshToken: "r2", connectedAt: 1 },
    ]);
  });

  it("removes an account and reports whether one was found", async () => {
    const env = fakeEnv();
    await upsertAccount(env, "owner", { email: "a@gmail.com", refreshToken: "r1", connectedAt: 1 });

    expect(await removeAccount(env, "owner", "missing@gmail.com")).toBe(false);
    expect(await removeAccount(env, "owner", "a@gmail.com")).toBe(true);
    expect(await listAccounts(env, "owner")).toEqual([]);
  });
});

describe("resolveAccount", () => {
  const a: GmailAccount = { email: "a@gmail.com", refreshToken: "r1", connectedAt: 1 };
  const b: GmailAccount = { email: "b@gmail.com", refreshToken: "r2", connectedAt: 1 };

  it("returns the sole account when none is requested", () => {
    expect(resolveAccount([a])).toBe(a);
  });

  it("throws when none is requested and there are zero or multiple accounts", () => {
    expect(() => resolveAccount([])).toThrow("No Gmail accounts connected");
    expect(() => resolveAccount([a, b])).toThrow("Multiple Gmail accounts");
  });

  it("matches the requested account case-insensitively", () => {
    expect(resolveAccount([a, b], "A@GMAIL.com")).toBe(a);
  });

  it("throws a descriptive error for an unknown requested account", () => {
    expect(() => resolveAccount([a, b], "c@gmail.com")).toThrow('"c@gmail.com"');
  });
});

describe("connect link tokens", () => {
  it("round-trips: peek doesn't consume, consume does", async () => {
    const env = fakeEnv();
    const token = await createConnectLinkToken(env, "owner@example.com");

    expect(await peekConnectLinkToken(env, token)).toBe("owner@example.com");
    expect(await peekConnectLinkToken(env, token)).toBe("owner@example.com");

    expect(await consumeConnectLinkToken(env, token)).toBe("owner@example.com");
    expect(await consumeConnectLinkToken(env, token)).toBeNull();
    expect(await peekConnectLinkToken(env, token)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const env = fakeEnv();
    expect(await peekConnectLinkToken(env, "nope")).toBeNull();
    expect(await consumeConnectLinkToken(env, "nope")).toBeNull();
  });
});
