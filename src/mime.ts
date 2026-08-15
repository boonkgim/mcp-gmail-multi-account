// Builds the base64url-encoded RFC 2822 message the Gmail API's `raw` field
// expects (used by messages.send and drafts.create/update). Plain fetch +
// Buffer (via nodejs_compat) rather than a MIME library — the messages this
// server sends are always single-part text/plain.

export interface MimeMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertValidAddresses(label: string, addresses: string[] | undefined): void {
  for (const address of addresses ?? []) {
    if (!EMAIL_PATTERN.test(address)) {
      throw new Error(`Invalid ${label} address: "${address}"`);
    }
  }
}

// RFC 2047 encoded-word, needed for any non-ASCII header value (e.g. a
// subject with emoji or accented characters); ASCII-only values pass through.
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

export function buildRawMimeMessage(input: MimeMessageInput): string {
  if (input.to.length === 0) {
    throw new Error("At least one recipient (to) is required.");
  }
  assertValidAddresses("to", input.to);
  assertValidAddresses("cc", input.cc);
  assertValidAddresses("bcc", input.bcc);

  const headers: string[] = [];
  headers.push(`To: ${input.to.join(", ")}`);
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  headers.push("MIME-Version: 1.0");
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 8bit");

  const message = `${headers.join("\r\n")}\r\n\r\n${input.body}`;
  return Buffer.from(message, "utf-8").toString("base64url");
}
