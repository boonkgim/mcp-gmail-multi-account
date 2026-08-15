import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDraft,
  getMessage,
  listLabels,
  modifyMessageLabels,
  replyToMessage,
  searchMessages,
  trashMessage,
} from "./gmail";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchMessages", () => {
  it("lists message ids then hydrates each with metadata headers", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) {
        return jsonResponse({
          messages: [
            { id: "m1", threadId: "t1" },
            { id: "m2", threadId: "t2" },
          ],
        });
      }
      const id = url.match(/messages\/(\w+)\?/)?.[1];
      return jsonResponse({
        id,
        threadId: `t-${id}`,
        snippet: `snippet ${id}`,
        payload: {
          headers: [
            { name: "Subject", value: `Subject ${id}` },
            { name: "From", value: "sender@example.com" },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchMessages("token", { query: "is:unread" });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "m1",
      subject: "Subject m1",
      from: "sender@example.com",
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=is%3Aunread");
  });
});

describe("getMessage", () => {
  it("decodes the text/plain part from a nested multipart payload", async () => {
    const encoded = Buffer.from("Hello, world!", "utf-8").toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "multipart/alternative",
            headers: [
              { name: "Subject", value: "Hi" },
              { name: "From", value: "a@example.com" },
            ],
            parts: [
              { mimeType: "text/plain", body: { data: encoded } },
              {
                mimeType: "text/html",
                body: { data: Buffer.from("<p>Hello</p>").toString("base64url") },
              },
            ],
          },
        }),
      ),
    );

    const message = await getMessage("token", "m1");
    expect(message.body).toBe("Hello, world!");
    expect(message.bodyType).toBe("text/plain");
    expect(message.subject).toBe("Hi");
  });

  it("falls back to text/html when there's no text/plain part", async () => {
    const html = Buffer.from("<p>Only html</p>", "utf-8").toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "m1",
          threadId: "t1",
          payload: { mimeType: "text/html", body: { data: html } },
        }),
      ),
    );

    const message = await getMessage("token", "m1");
    expect(message.body).toBe("<p>Only html</p>");
    expect(message.bodyType).toBe("text/html");
  });
});

describe("replyToMessage", () => {
  function stubOriginal(headers: Record<string, string>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!init?.method) {
          return jsonResponse({
            id: "m1",
            threadId: "t1",
            payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
          });
        }
        return jsonResponse({ id: "sent1", threadId: "t1" });
      }),
    );
  }

  it("replies to the sender only by default", async () => {
    stubOriginal({
      From: "Sender <sender@example.com>",
      To: "me@example.com",
      Subject: "Original",
      "Message-ID": "<orig@mail.gmail.com>",
    });
    const fetchMock = vi.mocked(fetch);

    await replyToMessage("token", {
      account: "me@example.com",
      messageId: "m1",
      body: "reply body",
    });

    const sendCall = fetchMock.mock.calls[1];
    const body = JSON.parse(String(sendCall[1]?.body));
    const message = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(message).toContain("To: sender@example.com");
    expect(message).not.toContain("Cc:");
    expect(message).toContain("Subject: Re: Original");
    expect(message).toContain("In-Reply-To: <orig@mail.gmail.com>");
    expect(body.threadId).toBe("t1");
  });

  it("Ccs the other original recipients when replyAll is set, excluding the sending account", async () => {
    stubOriginal({
      From: "Sender <sender@example.com>",
      To: "me@example.com, Other <other@example.com>",
      Cc: "third@example.com",
      Subject: "Re: Original",
      "Message-ID": "<orig@mail.gmail.com>",
    });
    const fetchMock = vi.mocked(fetch);

    await replyToMessage("token", {
      account: "me@example.com",
      messageId: "m1",
      body: "reply body",
      replyAll: true,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const message = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(message).toContain("Cc: other@example.com, third@example.com");
    // Subject already has "Re: " — not doubled.
    expect(message).toContain("Subject: Re: Original");
    expect((message.match(/Re:/g) ?? []).length).toBe(1);
  });

  it("throws when the original message has no From header", async () => {
    stubOriginal({ Subject: "Original" });
    await expect(
      replyToMessage("token", { account: "me@example.com", messageId: "m1", body: "x" }),
    ).rejects.toThrow("no From header");
  });
});

describe("createDraft", () => {
  it("creates a standalone draft with no threading headers", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "d1", message: { id: "m1", threadId: "t1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createDraft("token", { to: ["a@example.com"], subject: "Hi", body: "body" });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/drafts");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.message.threadId).toBeUndefined();
    const message = Buffer.from(body.message.raw, "base64url").toString("utf-8");
    expect(message).not.toContain("In-Reply-To:");
  });

  it("throws when neither replyToMessageId nor to/subject are given", async () => {
    await expect(createDraft("token", { body: "body" })).rejects.toThrow(
      "recipient (to) is required",
    );
  });

  it("threads a reply draft off the original message, deriving to/subject/threadId", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        return jsonResponse({
          id: "m1",
          threadId: "t1",
          payload: {
            headers: [
              { name: "From", value: "Sender <sender@example.com>" },
              { name: "Subject", value: "Original" },
              { name: "Message-ID", value: "<orig@mail.gmail.com>" },
            ],
          },
        });
      }
      return jsonResponse({ id: "d1", message: { id: "m2", threadId: "t1" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createDraft("token", {
      body: "reply body",
      replyToMessageId: "m1",
      account: "me@example.com",
    });

    const draftCall = fetchMock.mock.calls[1];
    const body = JSON.parse(String(draftCall[1]?.body));
    expect(body.message.threadId).toBe("t1");
    const message = Buffer.from(body.message.raw, "base64url").toString("utf-8");
    expect(message).toContain("To: sender@example.com");
    expect(message).toContain("Subject: Re: Original");
    expect(message).toContain("In-Reply-To: <orig@mail.gmail.com>");
  });

  it("lets explicit to/subject override the derived reply defaults", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        return jsonResponse({
          id: "m1",
          threadId: "t1",
          payload: {
            headers: [
              { name: "From", value: "sender@example.com" },
              { name: "Subject", value: "Original" },
              { name: "Message-ID", value: "<orig@mail.gmail.com>" },
            ],
          },
        });
      }
      return jsonResponse({ id: "d1", message: { id: "m2", threadId: "t1" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createDraft("token", {
      to: ["override@example.com"],
      subject: "Custom subject",
      body: "reply body",
      replyToMessageId: "m1",
      account: "me@example.com",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const message = Buffer.from(body.message.raw, "base64url").toString("utf-8");
    expect(message).toContain("To: override@example.com");
    expect(message).toContain("Subject: Custom subject");
    // Threading headers still come from the original message even when to/subject are overridden.
    expect(message).toContain("In-Reply-To: <orig@mail.gmail.com>");
    expect(body.message.threadId).toBe("t1");
  });
});

describe("modifyMessageLabels / trashMessage / listLabels", () => {
  it("posts add/remove label ids to the modify endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "m1", labelIds: ["STARRED"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await modifyMessageLabels("token", "m1", {
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/messages/m1/modify");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({ addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] });
  });

  it("posts to the trash endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "m1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await trashMessage("token", "m1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/messages/m1/trash");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
  });

  it("lists labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] })),
    );
    const labels = await listLabels("token");
    expect(labels).toEqual([{ id: "INBOX", name: "INBOX", type: "system" }]);
  });
});
