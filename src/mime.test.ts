import { describe, expect, it } from "vitest";
import { buildRawMimeMessage } from "./mime";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf-8");
}

describe("buildRawMimeMessage", () => {
  it("builds a plain-text message with to/cc/subject/body", () => {
    const raw = buildRawMimeMessage({
      to: ["a@example.com"],
      cc: ["b@example.com"],
      subject: "Hello",
      body: "Hi there",
    });
    const message = decode(raw);
    expect(message).toContain("To: a@example.com");
    expect(message).toContain("Cc: b@example.com");
    expect(message).toContain("Subject: Hello");
    expect(message).toContain("Content-Type: text/plain");
    expect(message).toContain("\r\n\r\nHi there");
  });

  it("RFC 2047-encodes non-ASCII subjects and leaves ASCII ones untouched", () => {
    const ascii = decode(
      buildRawMimeMessage({ to: ["a@example.com"], subject: "Plain", body: "x" }),
    );
    expect(ascii).toContain("Subject: Plain");

    const raw = decode(
      buildRawMimeMessage({ to: ["a@example.com"], subject: "Café ☕", body: "x" }),
    );
    const match = raw.match(/Subject: (=\?UTF-8\?B\?.*\?=)/);
    expect(match).not.toBeNull();
    const encoded = match![1].replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toBe("Café ☕");
  });

  it("includes In-Reply-To and References when provided", () => {
    const message = decode(
      buildRawMimeMessage({
        to: ["a@example.com"],
        subject: "Re: Hello",
        body: "x",
        inReplyTo: "<msg1@mail.gmail.com>",
        references: "<msg0@mail.gmail.com> <msg1@mail.gmail.com>",
      }),
    );
    expect(message).toContain("In-Reply-To: <msg1@mail.gmail.com>");
    expect(message).toContain("References: <msg0@mail.gmail.com> <msg1@mail.gmail.com>");
  });

  it("omits the To header (rather than throwing) when there are no recipients, for empty drafts", () => {
    const message = decode(buildRawMimeMessage({ to: [], subject: "x", body: "x" }));
    expect(message).not.toContain("To:");
  });

  it("rejects malformed addresses", () => {
    expect(() => buildRawMimeMessage({ to: ["not-an-email"], subject: "x", body: "x" })).toThrow(
      'Invalid to address: "not-an-email"',
    );
  });

  it("builds a multipart/alternative message when both body and htmlBody are given", () => {
    const message = decode(
      buildRawMimeMessage({
        to: ["a@example.com"],
        subject: "Hi",
        body: "plain",
        htmlBody: "<p>html</p>",
      }),
    );
    expect(message).toContain("Content-Type: multipart/alternative");
    expect(message).toContain("Content-Type: text/plain");
    expect(message).toContain("plain");
    expect(message).toContain("Content-Type: text/html");
    expect(message).toContain("<p>html</p>");
  });

  it("builds a single text/html part when only htmlBody is given", () => {
    const message = decode(
      buildRawMimeMessage({ to: ["a@example.com"], subject: "Hi", htmlBody: "<p>html</p>" }),
    );
    expect(message).toContain("Content-Type: text/html");
    expect(message).not.toContain("multipart/alternative");
    expect(message).toContain("<p>html</p>");
  });

  it("wraps a regular attachment in multipart/mixed with base64 content", () => {
    const content = Buffer.from("file bytes").toString("base64");
    const message = decode(
      buildRawMimeMessage({
        to: ["a@example.com"],
        subject: "Hi",
        body: "see attached",
        attachments: [{ content, filename: "note.txt", mimeType: "text/plain" }],
      }),
    );
    expect(message).toContain("Content-Type: multipart/mixed");
    expect(message).toContain('Content-Disposition: attachment; filename="note.txt"');
    expect(message).toContain("Content-Transfer-Encoding: base64");
    expect(message).toContain(content);
  });

  it("wraps an inline attachment in multipart/related with a Content-ID", () => {
    const content = Buffer.from("image bytes").toString("base64");
    const message = decode(
      buildRawMimeMessage({
        to: ["a@example.com"],
        subject: "Hi",
        htmlBody: '<img src="cid:logo.png">',
        attachments: [{ content, filename: "logo.png", mimeType: "image/png", inline: true }],
      }),
    );
    expect(message).toContain("Content-Type: multipart/related");
    expect(message).toContain("Content-Disposition: inline");
    expect(message).toContain("Content-ID: <logo.png>");
  });

  it("line-wraps long base64 attachment content at 76 characters", () => {
    const content = Buffer.from("x".repeat(200)).toString("base64");
    const message = decode(
      buildRawMimeMessage({
        to: ["a@example.com"],
        subject: "Hi",
        body: "x",
        attachments: [{ content, filename: "big.bin" }],
      }),
    );
    // Only the base64 payload lines need wrapping; header lines (e.g. the
    // multipart boundary) legitimately run longer than 76 chars.
    const base64Lines = message
      .split("\r\n")
      .filter((line) => /^[A-Za-z0-9+/]+=*$/.test(line) && line.length > 0);
    expect(base64Lines.length).toBeGreaterThan(1);
    for (const line of base64Lines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});
