import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveMessage,
  createDraft,
  createLabel,
  deleteLabel,
  forward,
  getMessage,
  getThread,
  labelMessage,
  labelThread,
  listDrafts,
  listLabels,
  markMessageSpam,
  markThreadSpam,
  reply,
  searchThreads,
  sendMessage,
  trashMessage,
  trashThread,
  unlabelMessage,
  unlabelThread,
  unmarkMessageSpam,
  unmarkThreadSpam,
  untrashMessage,
  untrashThread,
  updateDraft,
  updateLabel,
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

const FULL_MESSAGE = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
  snippet: "snippet",
  sizeEstimate: 1234,
  internalDate: "1700000000000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Subject", value: "Hi" },
      { name: "From", value: "a@example.com" },
      { name: "To", value: "me@example.com" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("Hello, world!").toString("base64url") },
      },
      {
        mimeType: "text/html",
        body: { data: Buffer.from("<p>Hello</p>").toString("base64url") },
      },
    ],
  },
};

describe("getMessage", () => {
  it("FULL_CONTENT (default) returns both plain and html bodies plus attachments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(FULL_MESSAGE)),
    );
    const message = await getMessage("token", "m1");
    expect(message.body).toBe("Hello, world!");
    expect(message.htmlBody).toBe("<p>Hello</p>");
    expect(message.subject).toBe("Hi");
    expect(message.attachments).toEqual([]);
  });

  it("MINIMAL returns headers/snippet but no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(FULL_MESSAGE)),
    );
    const message = await getMessage("token", "m1", "MINIMAL");
    expect(message.subject).toBe("Hi");
    expect(message.body).toBeUndefined();
    expect(message.htmlBody).toBeUndefined();
  });

  it("METADATA_ONLY returns only id/threadId/labels/size, no subject or snippet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(FULL_MESSAGE)),
    );
    const message = await getMessage("token", "m1", "METADATA_ONLY");
    expect(message).toEqual({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX"],
      sizeEstimate: 1234,
      internalDate: "1700000000000",
    });
  });

  it("PLAIN_TEXT omits htmlBody, and falls back to a stripped version of html when there's no plain part", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(FULL_MESSAGE)),
    );
    const withPlain = await getMessage("token", "m1", "PLAIN_TEXT");
    expect(withPlain.body).toBe("Hello, world!");
    expect(withPlain.htmlBody).toBeUndefined();

    const htmlOnly = {
      ...FULL_MESSAGE,
      payload: {
        mimeType: "text/html",
        body: { data: Buffer.from("<p>Only <b>html</b></p>").toString("base64url") },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(htmlOnly)),
    );
    const fallback = await getMessage("token", "m1", "PLAIN_TEXT");
    expect(fallback.body).toBe("Only html");
    expect(fallback.htmlBody).toBeUndefined();
  });
});

describe("getThread", () => {
  it("maps every message in the thread", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ id: "t1", messages: [FULL_MESSAGE] }),
      ),
    );
    const thread = await getThread("token", "t1");
    expect(thread.id).toBe("t1");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].body).toBe("Hello, world!");
  });
});

describe("searchThreads", () => {
  it("hydrates each thread from its last message, including subject/snippet for MINIMAL view", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/threads?")) {
        return jsonResponse({ threads: [{ id: "t1" }], nextPageToken: "next-token" });
      }
      return jsonResponse({
        id: "t1",
        messages: [
          {
            id: "m0",
            threadId: "t1",
            payload: { headers: [{ name: "Subject", value: "Original" }] },
          },
          {
            id: "m1",
            threadId: "t1",
            snippet: "latest snippet",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Re: Original" },
                { name: "From", value: "a@example.com" },
                { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
              ],
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchThreads("token", { query: "is:unread" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=is%3Aunread");
    expect(result.nextPageToken).toBe("next-token");
    expect(result.threads[0]).toMatchObject({
      id: "t1",
      subject: "Original",
      snippet: "latest snippet",
      from: "a@example.com",
    });
  });

  it("omits subject/snippet for METADATA_ONLY view", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/threads?")) return jsonResponse({ threads: [{ id: "t1" }] });
      return jsonResponse({
        id: "t1",
        messages: [
          {
            id: "m1",
            threadId: "t1",
            payload: { headers: [{ name: "From", value: "a@example.com" }] },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchThreads("token", { view: "THREAD_VIEW_METADATA_ONLY" });
    expect(result.threads[0].subject).toBeUndefined();
    expect(result.threads[0].snippet).toBeUndefined();
    expect(result.threads[0].from).toBe("a@example.com");
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

  it("allows a fully empty draft (no recipients required)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ id: "d1", message: { id: "m1", threadId: "t1" } }),
      ),
    );
    const draft = await createDraft("token", {});
    expect(draft.id).toBe("d1");
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
    expect(message).toContain("In-Reply-To: <orig@mail.gmail.com>");
    expect(body.message.threadId).toBe("t1");
  });
});

describe("updateDraft", () => {
  function stubExisting() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        return jsonResponse({
          id: "d1",
          message: {
            id: "m1",
            threadId: "t1",
            payload: {
              headers: [
                { name: "To", value: "old@example.com" },
                { name: "Subject", value: "Old subject" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("old body").toString("base64url") },
            },
          },
        });
      }
      return jsonResponse({ id: "d1", message: { id: "m1", threadId: "t1" } });
    });
  }

  function stubExistingWithAttachment() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/attachments/"))
        return jsonResponse({ data: Buffer.from("file").toString("base64url") });
      if (!init?.method) {
        return jsonResponse({
          id: "d1",
          message: {
            id: "m1",
            threadId: "t1",
            payload: {
              headers: [
                { name: "To", value: "old@example.com" },
                { name: "Subject", value: "Old subject" },
              ],
              mimeType: "multipart/mixed",
              parts: [
                {
                  mimeType: "text/plain",
                  body: { data: Buffer.from("old body").toString("base64url") },
                },
                {
                  filename: "file.txt",
                  mimeType: "text/plain",
                  body: { attachmentId: "att1", size: 4 },
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ id: "d1", message: { id: "m1", threadId: "t1" } });
    });
  }

  it("overwrites only the fields provided, preserving the rest", async () => {
    const fetchMock = stubExisting();
    vi.stubGlobal("fetch", fetchMock);

    await updateDraft("token", { draftId: "d1", subject: "New subject" });

    const putCall = fetchMock.mock.calls[1];
    expect(putCall[1]?.method).toBe("PUT");
    const body = JSON.parse(String(putCall[1]?.body));
    expect(body.message.threadId).toBe("t1");
    const message = Buffer.from(body.message.raw, "base64url").toString("utf-8");
    expect(message).toContain("To: old@example.com");
    expect(message).toContain("Subject: New subject");
    expect(message).toContain("old body");
  });

  it("replaces the body wholesale when a new body is given, not merged with the old one", async () => {
    const fetchMock = stubExisting();
    vi.stubGlobal("fetch", fetchMock);

    await updateDraft("token", { draftId: "d1", body: "new body" });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const message = Buffer.from(body.message.raw, "base64url").toString("utf-8");
    expect(message).toContain("new body");
    expect(message).not.toContain("old body");
  });

  it("preserves the existing attachment when attachments are omitted", async () => {
    const fetchMock = stubExistingWithAttachment();
    vi.stubGlobal("fetch", fetchMock);

    await updateDraft("token", { draftId: "d1", subject: "New subject" });

    const putCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(String(putCall[1]?.body));
    const message = Buffer.from(body.message.raw, "base64url").toString("utf-8");
    expect(message).toContain('filename="file.txt"');
  });

  it("replaces attachments wholesale when new ones are given", async () => {
    const fetchMock = stubExistingWithAttachment();
    vi.stubGlobal("fetch", fetchMock);

    await updateDraft("token", {
      draftId: "d1",
      attachments: [{ content: Buffer.from("new file").toString("base64"), filename: "new.txt" }],
    });

    const putCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(String(putCall[1]?.body));
    const message = Buffer.from(body.message.raw, "base64url").toString("utf-8");
    expect(message).toContain('filename="new.txt"');
    expect(message).not.toContain('filename="file.txt"');
  });
});

describe("listDrafts", () => {
  it("hydrates metadata (To/Cc/Bcc/Date) for each draft by default, without subject/body", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/drafts?")) return jsonResponse({ drafts: [{ id: "d1" }] });
      return jsonResponse({
        id: "d1",
        message: {
          id: "m1",
          threadId: "t1",
          payload: {
            headers: [
              { name: "To", value: "a@example.com" },
              { name: "Subject", value: "Hi" },
            ],
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listDrafts("token", {});
    expect(result.drafts[0].to).toBe("a@example.com");
    expect(result.drafts[0].subject).toBeUndefined();
  });

  it("includes subject/body for DRAFT_VIEW_FULL", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/drafts?")) return jsonResponse({ drafts: [{ id: "d1" }] });
      return jsonResponse({
        id: "d1",
        message: {
          id: "m1",
          threadId: "t1",
          payload: {
            headers: [{ name: "Subject", value: "Hi" }],
            mimeType: "text/plain",
            body: { data: Buffer.from("draft body").toString("base64url") },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listDrafts("token", { view: "DRAFT_VIEW_FULL" });
    expect(result.drafts[0].subject).toBe("Hi");
    expect(result.drafts[0].body).toBe("draft body");
  });
});

describe("labels", () => {
  it("creates a label with a color preset", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "Label_1", name: "Important", type: "user" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createLabel("token", { displayName: "Important", colorPreset: "LABEL_COLOR_PRESET_RED" });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({
      name: "Important",
      color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
    });
  });

  it("auto-creates missing parent labels for a nested name, skipping ones that already exist", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method)
        return jsonResponse({ labels: [{ id: "L0", name: "Projects", type: "user" }] });
      return jsonResponse({ id: "new", name: JSON.parse(String(init.body)).name, type: "user" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createLabel("token", { displayName: "Projects/Alpha/Sprint-1" });

    const createdNames = fetchMock.mock.calls
      .filter((c) => (c[1] as RequestInit | undefined)?.method === "POST")
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).name);
    // "Projects" already existed, so only "Projects/Alpha" and the final label are created.
    expect(createdNames).toEqual(["Projects/Alpha", "Projects/Alpha/Sprint-1"]);
  });

  it("skips parent auto-creation when autoCreateParentLabels is false", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "new", name: "A/B", type: "user" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createLabel("token", { displayName: "A/B", autoCreateParentLabels: false });

    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("updates a label's name and color", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "L1", name: "Renamed", type: "user" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await updateLabel("token", {
      labelId: "L1",
      displayName: "Renamed",
      colorPreset: "LABEL_COLOR_PRESET_BLUE",
    });

    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({
      name: "Renamed",
      color: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
    });
  });

  it("deletes a label", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true, status: 204 }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await deleteLabel("token", "L1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/labels/L1");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("lists labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] }),
      ),
    );
    const labels = await listLabels("token");
    expect(labels).toEqual([{ id: "INBOX", name: "INBOX", type: "system" }]);
  });
});

describe("message/thread label, archive, trash, and spam operations", () => {
  it("labelMessage / unlabelMessage post add/removeLabelIds to the message modify endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "m1", labelIds: ["STARRED"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await labelMessage("token", "m1", ["STARRED"]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/messages/m1/modify");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      addLabelIds: ["STARRED"],
    });

    await unlabelMessage("token", "m1", ["UNREAD"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      removeLabelIds: ["UNREAD"],
    });
  });

  it("labelThread / unlabelThread post to the thread modify endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "t1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await labelThread("token", "t1", ["STARRED"]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/threads/t1/modify");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      addLabelIds: ["STARRED"],
    });

    await unlabelThread("token", "t1", ["STARRED"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      removeLabelIds: ["STARRED"],
    });
  });

  it("archiveMessage removes INBOX", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "m1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await archiveMessage("token", "m1");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      removeLabelIds: ["INBOX"],
    });
  });

  it("trashMessage / untrashMessage / trashThread / untrashThread hit their dedicated endpoints", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "x1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await trashMessage("token", "m1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/messages/m1/trash");
    await untrashMessage("token", "m1");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/messages/m1/untrash");
    await trashThread("token", "t1");
    expect(String(fetchMock.mock.calls[2][0])).toContain("/threads/t1/trash");
    await untrashThread("token", "t1");
    expect(String(fetchMock.mock.calls[3][0])).toContain("/threads/t1/untrash");
  });

  it("markMessageSpam adds SPAM/removes INBOX; unmark does the reverse", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "m1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await markMessageSpam("token", "m1");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      addLabelIds: ["SPAM"],
      removeLabelIds: ["INBOX"],
    });
    await unmarkMessageSpam("token", "m1");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      removeLabelIds: ["SPAM"],
      addLabelIds: ["INBOX"],
    });
  });

  it("markThreadSpam / unmarkThreadSpam mirror the message-level behavior on the thread endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "t1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await markThreadSpam("token", "t1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/threads/t1/modify");
    await unmarkThreadSpam("token", "t1");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/threads/t1/modify");
  });
});

describe("sendMessage", () => {
  it("builds and sends a raw message when no draftId is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "m1", threadId: "t1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendMessage("token", { to: ["a@example.com"], subject: "Hi", body: "hello" });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/messages/send");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(Buffer.from(body.raw, "base64url").toString("utf-8")).toContain("To: a@example.com");
  });

  it("sends an existing draft via drafts.send when draftId is given, ignoring other fields", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "m1", threadId: "t1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendMessage("token", { draftId: "d1", to: ["ignored@example.com"] });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/drafts/send");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ id: "d1" });
  });

  it("throws when neither draftId nor to is given", async () => {
    await expect(sendMessage("token", {})).rejects.toThrow("recipient (to) is required");
  });
});

describe("reply", () => {
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

    await reply("token", { account: "me@example.com", messageId: "m1", body: "reply body" });

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

    await reply("token", {
      account: "me@example.com",
      messageId: "m1",
      body: "reply body",
      replyAll: true,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const message = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(message).toContain("Cc: other@example.com, third@example.com");
    expect((message.match(/Re:/g) ?? []).length).toBe(1);
  });

  it("throws when the original message has no From header", async () => {
    stubOriginal({ Subject: "Original" });
    await expect(
      reply("token", { account: "me@example.com", messageId: "m1", body: "x" }),
    ).rejects.toThrow("no From header");
  });

  it("throws when neither body nor htmlBody is given", async () => {
    await expect(reply("token", { account: "me@example.com", messageId: "m1" })).rejects.toThrow(
      "Either body or htmlBody",
    );
  });
});

describe("forward", () => {
  it("quotes the original message, carries over its attachments, and sends", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/attachments/"))
        return jsonResponse({ data: Buffer.from("file").toString("base64url") });
      if (!init?.method) {
        return jsonResponse({
          id: "m1",
          threadId: "t1",
          payload: {
            headers: [
              { name: "Subject", value: "Original" },
              { name: "From", value: "sender@example.com" },
              { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
              { name: "To", value: "me@example.com" },
            ],
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: Buffer.from("original body").toString("base64url") },
              },
              {
                filename: "file.txt",
                mimeType: "text/plain",
                body: { attachmentId: "att1", size: 4 },
              },
            ],
          },
        });
      }
      return jsonResponse({ id: "fwd1", threadId: "t2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await forward("token", { messageId: "m1", to: ["dest@example.com"], forwardText: "FYI" });

    const sendCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(String(sendCall[1]?.body));
    const message = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(message).toContain("Subject: Fwd: Original");
    expect(message).toContain("FYI");
    expect(message).toContain("Forwarded message");
    expect(message).toContain("original body");
    expect(message).toContain('filename="file.txt"');
  });

  it("throws when no recipients are given", async () => {
    await expect(forward("token", { messageId: "m1" })).rejects.toThrow(
      "recipient (to) is required",
    );
  });
});
