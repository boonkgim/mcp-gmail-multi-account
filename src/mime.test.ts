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

  it("throws when there are no recipients", () => {
    expect(() => buildRawMimeMessage({ to: [], subject: "x", body: "x" })).toThrow(
      "At least one recipient",
    );
  });

  it("rejects malformed addresses", () => {
    expect(() => buildRawMimeMessage({ to: ["not-an-email"], subject: "x", body: "x" })).toThrow(
      'Invalid to address: "not-an-email"',
    );
  });
});
