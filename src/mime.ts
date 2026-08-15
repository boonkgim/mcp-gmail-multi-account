// Builds the base64url-encoded RFC 2822 message the Gmail API's `raw` field
// expects (used by messages.send and drafts.create/update). Plain fetch +
// Buffer (via nodejs_compat) rather than a MIME library — supports plain
// text, HTML (as multipart/alternative), and attachments (regular via
// multipart/mixed, inline via multipart/related), matching what the Gmail
// API itself accepts.

export interface MimeAttachment {
  /** Base64-encoded attachment content. */
  content: string;
  filename?: string;
  mimeType?: string;
  /** Displayed inline (e.g. referenced via `cid:<filename>` in htmlBody) rather than as a downloadable file. */
  inline?: boolean;
}

export interface MimeMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
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

interface MimePart {
  headers: string[];
  body: string;
}

function textPart(mimeType: string, content: string): MimePart {
  return {
    headers: [`Content-Type: ${mimeType}; charset="UTF-8"`, "Content-Transfer-Encoding: 8bit"],
    body: content,
  };
}

// RFC 2045 caps base64 body lines at 76 chars.
function wrapBase64(data: string): string {
  return (data.match(/.{1,76}/g) ?? []).join("\r\n");
}

function attachmentPart(attachment: MimeAttachment, index: number): MimePart {
  const mimeType = attachment.mimeType || "application/octet-stream";
  const nameAttr = attachment.filename ? `; name="${encodeHeaderValue(attachment.filename)}"` : "";
  const filenameAttr = attachment.filename
    ? `; filename="${encodeHeaderValue(attachment.filename)}"`
    : "";
  const headers = [
    `Content-Type: ${mimeType}${nameAttr}`,
    `Content-Disposition: ${attachment.inline ? "inline" : "attachment"}${filenameAttr}`,
    "Content-Transfer-Encoding: base64",
  ];
  if (attachment.inline) {
    headers.push(`Content-ID: <${attachment.filename ?? `inline-${index}`}>`);
  }
  return { headers, body: wrapBase64(attachment.content) };
}

function multipart(type: string, parts: MimePart[]): MimePart {
  const boundary = `${type.split("/")[1]}_${crypto.randomUUID().replace(/-/g, "")}`;
  const rendered = parts
    .map((part) => `--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n${part.body}`)
    .join("\r\n");
  return {
    headers: [`Content-Type: ${type}; boundary="${boundary}"`],
    body: `${rendered}\r\n--${boundary}--`,
  };
}

export function buildRawMimeMessage(input: MimeMessageInput): string {
  assertValidAddresses("to", input.to);
  assertValidAddresses("cc", input.cc);
  assertValidAddresses("bcc", input.bcc);

  let core: MimePart;
  if (input.htmlBody && input.body) {
    core = multipart("multipart/alternative", [
      textPart("text/plain", input.body),
      textPart("text/html", input.htmlBody),
    ]);
  } else if (input.htmlBody) {
    core = textPart("text/html", input.htmlBody);
  } else {
    core = textPart("text/plain", input.body ?? "");
  }

  const inlineAttachments = (input.attachments ?? []).filter((a) => a.inline);
  const regularAttachments = (input.attachments ?? []).filter((a) => !a.inline);

  if (inlineAttachments.length) {
    core = multipart("multipart/related", [
      core,
      ...inlineAttachments.map((a, i) => attachmentPart(a, i)),
    ]);
  }
  if (regularAttachments.length) {
    core = multipart("multipart/mixed", [
      core,
      ...regularAttachments.map((a, i) => attachmentPart(a, i)),
    ]);
  }

  const headers: string[] = [];
  if (input.to.length) headers.push(`To: ${input.to.join(", ")}`);
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  headers.push("MIME-Version: 1.0");
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);
  headers.push(...core.headers);

  const message = `${headers.join("\r\n")}\r\n\r\n${core.body}`;
  return Buffer.from(message, "utf-8").toString("base64url");
}
