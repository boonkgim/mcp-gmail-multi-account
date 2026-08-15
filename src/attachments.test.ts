import { describe, expect, it } from "vitest";
import {
  consumeAttachment,
  mintUploadKey,
  resolveUploadKeyOwner,
  storeAttachment,
} from "./attachments";

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

describe("upload key", () => {
  it("resolves to the owner it was minted for", async () => {
    const env = fakeEnv();
    const key = await mintUploadKey(env, "owner@example.com");
    expect(await resolveUploadKeyOwner(env, key)).toBe("owner@example.com");
  });

  it("is not consumed by resolving it (reusable for repeat uploads)", async () => {
    const env = fakeEnv();
    const key = await mintUploadKey(env, "owner@example.com");
    await resolveUploadKeyOwner(env, key);
    expect(await resolveUploadKeyOwner(env, key)).toBe("owner@example.com");
  });

  it("returns null for an unknown key", async () => {
    const env = fakeEnv();
    expect(await resolveUploadKeyOwner(env, "nope")).toBeNull();
  });
});

describe("attachment blob store", () => {
  it("round-trips a stored attachment and consumes it on read", async () => {
    const env = fakeEnv();
    const ref = await storeAttachment(env, {
      ownerId: "owner@example.com",
      content: "aGVsbG8=",
      filename: "hello.txt",
      mimeType: "text/plain",
    });

    const stored = await consumeAttachment(env, "owner@example.com", ref);
    expect(stored).toEqual({
      ownerId: "owner@example.com",
      content: "aGVsbG8=",
      filename: "hello.txt",
      mimeType: "text/plain",
    });

    expect(await consumeAttachment(env, "owner@example.com", ref)).toBeNull();
  });

  it("refuses to hand back an attachment to a different owner", async () => {
    const env = fakeEnv();
    const ref = await storeAttachment(env, { ownerId: "owner@example.com", content: "aGk=" });

    expect(await consumeAttachment(env, "someone-else@example.com", ref)).toBeNull();
  });

  it("returns null for an unknown ref", async () => {
    const env = fakeEnv();
    expect(await consumeAttachment(env, "owner@example.com", "nope")).toBeNull();
  });
});
