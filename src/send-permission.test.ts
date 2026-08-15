import { describe, expect, it } from "vitest";
import { isSendAllowed, setSendAllowed } from "./send-permission";

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

describe("send permission", () => {
  it("defaults to disallowed for an owner that's never set it", async () => {
    const env = fakeEnv();
    expect(await isSendAllowed(env, "owner@example.com")).toBe(false);
  });

  it("can be enabled and disabled per owner", async () => {
    const env = fakeEnv();
    await setSendAllowed(env, "owner@example.com", true);
    expect(await isSendAllowed(env, "owner@example.com")).toBe(true);

    await setSendAllowed(env, "owner@example.com", false);
    expect(await isSendAllowed(env, "owner@example.com")).toBe(false);
  });

  it("keeps different owners' permission separate", async () => {
    const env = fakeEnv();
    await setSendAllowed(env, "owner1", true);
    expect(await isSendAllowed(env, "owner1")).toBe(true);
    expect(await isSendAllowed(env, "owner2")).toBe(false);
  });
});
