// Gmail API client, implemented with plain fetch (no `googleapis` SDK — it's
// Node-oriented and unnecessarily heavy for a Workers isolate). Schema and
// tool surface mirror Anthropic's official single-account Gmail connector
// (field names, enums, capability set) with a multi-account `account`
// param layered on top by the tool layer in index.ts.

import { buildRawMimeMessage, type MimeAttachment } from "./mime";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
  internalDate?: string;
}

interface GmailThreadResource {
  id: string;
  messages?: GmailMessageResource[];
}

async function gmailFetch<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const resp = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!resp.ok) {
    throw new Error(`Gmail API error (${resp.status}): ${await resp.text()}`);
  }
  // messages.trash/untrash, labels.delete etc. may return 204 No Content,
  // which would otherwise throw on .json().
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function base64UrlToBase64(data: string): string {
  const std = data.replace(/-/g, "+").replace(/_/g, "/");
  return std + "=".repeat((4 - (std.length % 4)) % 4);
}

function findPart(
  payload: GmailMessagePart | undefined,
  mimeType: string,
): GmailMessagePart | undefined {
  if (!payload) return undefined;
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return undefined;
}

function extractBodies(payload: GmailMessagePart | undefined): {
  body?: string;
  htmlBody?: string;
} {
  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  return {
    body: plain?.body?.data ? decodeBase64Url(plain.body.data) : undefined,
    htmlBody: html?.body?.data ? decodeBase64Url(html.body.data) : undefined,
  };
}

// Rough HTML->text fallback for PLAIN_TEXT format when a message has no
// text/plain part — not a full markdown converter, just a readable approximation.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export interface AttachmentSummary {
  filename: string;
  mimeType?: string;
  attachmentId?: string;
  size?: number;
}

function collectAttachments(payload: GmailMessagePart | undefined): AttachmentSummary[] {
  const attachments: AttachmentSummary[] = [];
  const walk = (part: GmailMessagePart | undefined) => {
    if (!part) return;
    if (part.filename) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body?.attachmentId,
        size: part.body?.size,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return attachments;
}

// --- Message / thread formats (mirrors the official connector's messageFormat) ---

export type MessageFormat = "MINIMAL" | "FULL_CONTENT" | "METADATA_ONLY" | "PLAIN_TEXT";

const KEY_HEADERS = ["Subject", "From", "To", "Cc", "Date"];

function gmailFormatFor(format: MessageFormat): "full" | "metadata" {
  return format === "FULL_CONTENT" || format === "PLAIN_TEXT" ? "full" : "metadata";
}

export interface MessageDetail {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  body?: string;
  htmlBody?: string;
  attachments?: AttachmentSummary[];
  sizeEstimate?: number;
  internalDate?: string;
}

function toMessageDetail(msg: GmailMessageResource, format: MessageFormat): MessageDetail {
  if (format === "METADATA_ONLY") {
    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: msg.labelIds,
      sizeEstimate: msg.sizeEstimate,
      internalDate: msg.internalDate,
    };
  }

  const headers = msg.payload?.headers;
  const meta: MessageDetail = {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    subject: headerValue(headers, "Subject"),
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    date: headerValue(headers, "Date"),
  };
  if (format === "MINIMAL") return meta;

  const { body, htmlBody } = extractBodies(msg.payload);
  const attachments = collectAttachments(msg.payload);
  if (format === "PLAIN_TEXT") {
    return { ...meta, body: body ?? (htmlBody ? htmlToText(htmlBody) : undefined), attachments };
  }
  return { ...meta, body, htmlBody, attachments };
}

async function fetchGmailMessage(
  accessToken: string,
  id: string,
  format: MessageFormat,
): Promise<GmailMessageResource> {
  const gmailFormat = gmailFormatFor(format);
  const params = new URLSearchParams({ format: gmailFormat });
  if (gmailFormat === "metadata" && format === "MINIMAL") {
    for (const header of KEY_HEADERS) params.append("metadataHeaders", header);
  }
  return gmailFetch<GmailMessageResource>(accessToken, `/users/me/messages/${id}?${params}`);
}

export async function getMessage(
  accessToken: string,
  id: string,
  format: MessageFormat = "FULL_CONTENT",
): Promise<MessageDetail> {
  const msg = await fetchGmailMessage(accessToken, id, format);
  return toMessageDetail(msg, format);
}

export interface ThreadDetail {
  id: string;
  messages: MessageDetail[];
}

export async function getThread(
  accessToken: string,
  id: string,
  format: MessageFormat = "FULL_CONTENT",
): Promise<ThreadDetail> {
  const gmailFormat = gmailFormatFor(format);
  const params = new URLSearchParams({ format: gmailFormat });
  if (gmailFormat === "metadata" && format === "MINIMAL") {
    for (const header of KEY_HEADERS) params.append("metadataHeaders", header);
  }
  const thread = await gmailFetch<GmailThreadResource>(
    accessToken,
    `/users/me/threads/${id}?${params}`,
  );
  return {
    id: thread.id,
    messages: (thread.messages ?? []).map((m) => toMessageDetail(m, format)),
  };
}

// --- Search (thread-centric, mirrors search_threads) ---

export type ThreadView = "THREAD_VIEW_MINIMAL" | "THREAD_VIEW_METADATA_ONLY";

export interface ThreadSummary {
  id: string;
  snippet?: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  labelIds?: string[];
}

async function hydrateThread(
  accessToken: string,
  id: string,
  view: ThreadView,
): Promise<ThreadSummary> {
  const params = new URLSearchParams({ format: "metadata" });
  const headersToFetch =
    view === "THREAD_VIEW_MINIMAL" ? KEY_HEADERS : ["From", "To", "Cc", "Date"];
  for (const header of headersToFetch) params.append("metadataHeaders", header);

  const thread = await gmailFetch<GmailThreadResource>(
    accessToken,
    `/users/me/threads/${id}?${params}`,
  );
  const messages = thread.messages ?? [];
  const last = messages[messages.length - 1];
  const first = messages[0];
  const lastHeaders = last?.payload?.headers;

  return {
    id: thread.id,
    snippet: view === "THREAD_VIEW_MINIMAL" ? last?.snippet : undefined,
    subject:
      view === "THREAD_VIEW_MINIMAL" ? headerValue(first?.payload?.headers, "Subject") : undefined,
    from: headerValue(lastHeaders, "From"),
    to: headerValue(lastHeaders, "To"),
    cc: headerValue(lastHeaders, "Cc"),
    date: headerValue(lastHeaders, "Date"),
    labelIds: last?.labelIds,
  };
}

export interface SearchThreadsInput {
  query?: string;
  pageSize?: number;
  pageToken?: string;
  view?: ThreadView;
  includeTrash?: boolean;
}

export interface SearchThreadsResult {
  threads: ThreadSummary[];
  nextPageToken?: string;
}

export async function searchThreads(
  accessToken: string,
  {
    query,
    pageSize = 20,
    pageToken,
    view = "THREAD_VIEW_MINIMAL",
    includeTrash = false,
  }: SearchThreadsInput,
): Promise<SearchThreadsResult> {
  const params = new URLSearchParams({ maxResults: String(Math.min(pageSize, 50)) });
  if (query) params.set("q", query);
  if (pageToken) params.set("pageToken", pageToken);
  if (includeTrash) params.set("includeSpamTrash", "true");

  const list = await gmailFetch<{ threads?: { id: string }[]; nextPageToken?: string }>(
    accessToken,
    `/users/me/threads?${params}`,
  );
  const refs = list.threads ?? [];
  const threads = await Promise.all(refs.map((ref) => hydrateThread(accessToken, ref.id, view)));
  return { threads, nextPageToken: list.nextPageToken };
}

// --- Reply-field derivation, shared by reply() and threaded create_draft ---

// Address-list headers ("A <a@x.com>, "B, Inc" <b@x.com>") split on commas
// that aren't inside a quoted display name.
function splitAddressList(headerVal: string): string[] {
  const matches = headerVal.match(/"[^"]*"[^,]*|[^,]+/g) ?? [];
  return matches.map((entry) => entry.trim()).filter(Boolean);
}

function bareAddress(entry: string): string {
  const match = entry.match(/<([^>]+)>/);
  return (match ? match[1] : entry).trim();
}

function dedupeAddresses(entries: string[], excluding: string[]): string[] {
  const excludeSet = new Set(excluding.map((e) => bareAddress(e).toLowerCase()));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const address = bareAddress(entry);
    const key = address.toLowerCase();
    if (excludeSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

interface ReplyFields {
  to: string[];
  cc?: string[];
  subject: string;
  inReplyTo?: string;
  references?: string;
  threadId: string;
}

const REPLY_HEADERS = ["Subject", "From", "To", "Cc", "Message-ID", "References"];

function replyHeaderParams(): URLSearchParams {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of REPLY_HEADERS) params.append("metadataHeaders", header);
  return params;
}

/** Derives the To/Cc/Subject/threading headers a reply to `messageId` needs, Gmail-thread-correct. */
async function resolveReplyFields(
  accessToken: string,
  {
    account,
    messageId,
    replyAll = false,
  }: { account: string; messageId: string; replyAll?: boolean },
): Promise<ReplyFields> {
  const original = await gmailFetch<GmailMessageResource>(
    accessToken,
    `/users/me/messages/${messageId}?${replyHeaderParams()}`,
  );
  const headers = original.payload?.headers;
  const originalFrom = headerValue(headers, "From");
  if (!originalFrom) {
    throw new Error("Original message has no From header to reply to.");
  }
  const originalMessageId =
    headerValue(headers, "Message-ID") ?? headerValue(headers, "Message-Id");
  const originalReferences = headerValue(headers, "References");
  const originalSubject = headerValue(headers, "Subject") ?? "";

  const to = [bareAddress(originalFrom)];
  const cc = replyAll
    ? dedupeAddresses(
        [
          ...splitAddressList(headerValue(headers, "To") ?? ""),
          ...splitAddressList(headerValue(headers, "Cc") ?? ""),
        ],
        [...to, account],
      )
    : undefined;

  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
  const references = [originalReferences, originalMessageId].filter(Boolean).join(" ");

  return {
    to,
    cc: cc?.length ? cc : undefined,
    subject,
    inReplyTo: originalMessageId,
    references: references || undefined,
    threadId: original.threadId,
  };
}

// --- Sending ---

export interface SentMessage {
  id: string;
  threadId: string;
}

export interface SendMessageInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: MimeAttachment[];
  /** Sends a previously created draft, ignoring every other field. */
  draftId?: string;
}

export async function sendMessage(
  accessToken: string,
  input: SendMessageInput,
): Promise<SentMessage> {
  if (input.draftId) {
    return gmailFetch<SentMessage>(accessToken, "/users/me/drafts/send", {
      method: "POST",
      body: JSON.stringify({ id: input.draftId }),
    });
  }
  if (!input.to?.length) {
    throw new Error("At least one recipient (to) is required when draftId is not provided.");
  }
  const raw = buildRawMimeMessage({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject ?? "",
    body: input.body,
    htmlBody: input.htmlBody,
    attachments: input.attachments,
  });
  return gmailFetch<SentMessage>(accessToken, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
}

export interface ReplyInput {
  /** The connected account's own address, excluded from a reply-all Cc. */
  account: string;
  messageId: string;
  body?: string;
  htmlBody?: string;
  replyAll?: boolean;
}

export async function reply(
  accessToken: string,
  { account, messageId, body, htmlBody, replyAll = false }: ReplyInput,
): Promise<SentMessage> {
  if (!body && !htmlBody) {
    throw new Error("Either body or htmlBody is required.");
  }
  const fields = await resolveReplyFields(accessToken, { account, messageId, replyAll });
  const raw = buildRawMimeMessage({
    to: fields.to,
    cc: fields.cc,
    subject: fields.subject,
    body,
    htmlBody,
    inReplyTo: fields.inReplyTo,
    references: fields.references,
  });
  return gmailFetch<SentMessage>(accessToken, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, threadId: fields.threadId }),
  });
}

export interface ForwardInput {
  messageId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  forwardText?: string;
  htmlBody?: string;
}

export async function forward(
  accessToken: string,
  { messageId, to, cc, bcc, forwardText, htmlBody }: ForwardInput,
): Promise<SentMessage> {
  if (!to?.length) {
    throw new Error("At least one recipient (to) is required to forward a message.");
  }

  const original = await gmailFetch<GmailMessageResource>(
    accessToken,
    `/users/me/messages/${messageId}?format=full`,
  );
  const headers = original.payload?.headers;
  const originalSubject = headerValue(headers, "Subject") ?? "";
  const subject = /^fwd:/i.test(originalSubject) ? originalSubject : `Fwd: ${originalSubject}`;
  const { body: originalBody, htmlBody: originalHtml } = extractBodies(original.payload);

  const quotedHeaderLines = [
    "---------- Forwarded message ----------",
    `From: ${headerValue(headers, "From") ?? ""}`,
    `Date: ${headerValue(headers, "Date") ?? ""}`,
    `Subject: ${originalSubject}`,
    `To: ${headerValue(headers, "To") ?? ""}`,
  ];
  const body = `${forwardText ? `${forwardText}\r\n\r\n` : ""}${quotedHeaderLines.join("\r\n")}\r\n\r\n${originalBody ?? ""}`;

  const originalAttachments = collectAttachments(original.payload).filter((a) => a.attachmentId);
  const attachments: MimeAttachment[] = await Promise.all(
    originalAttachments.map(async (att) => {
      const data = await gmailFetch<{ data: string }>(
        accessToken,
        `/users/me/messages/${messageId}/attachments/${att.attachmentId}`,
      );
      return {
        content: base64UrlToBase64(data.data),
        filename: att.filename,
        mimeType: att.mimeType,
      };
    }),
  );

  const raw = buildRawMimeMessage({
    to,
    cc,
    bcc,
    subject,
    body,
    htmlBody: htmlBody
      ? `${htmlBody}<br><br>${quotedHeaderLines.join("<br>")}<br><br>${originalHtml ?? ""}`
      : undefined,
    attachments,
  });
  return gmailFetch<SentMessage>(accessToken, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
}

// --- Drafts ---

export interface DraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: MimeAttachment[];
  /** The connected account's own address, excluded from a reply-all Cc. */
  account?: string;
  /** When set, the draft is threaded as a reply to this message (matching Gmail's own "Draft reply"). */
  replyToMessageId?: string;
  replyAll?: boolean;
}

export interface DraftSummary {
  id: string;
  message: SentMessage;
}

export async function createDraft(accessToken: string, input: DraftInput): Promise<DraftSummary> {
  let to = input.to;
  let cc = input.cc;
  let subject = input.subject;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;

  if (input.replyToMessageId) {
    const fields = await resolveReplyFields(accessToken, {
      account: input.account ?? "",
      messageId: input.replyToMessageId,
      replyAll: input.replyAll,
    });
    to = to?.length ? to : fields.to;
    cc = cc ?? fields.cc;
    subject = subject ?? fields.subject;
    inReplyTo = fields.inReplyTo;
    references = fields.references;
    threadId = fields.threadId;
  }

  const raw = buildRawMimeMessage({
    to: to ?? [],
    cc,
    bcc: input.bcc,
    subject: subject ?? "",
    body: input.body,
    htmlBody: input.htmlBody,
    attachments: input.attachments,
    inReplyTo,
    references,
  });
  return gmailFetch<DraftSummary>(accessToken, "/users/me/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, threadId } }),
  });
}

export interface UpdateDraftInput {
  draftId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: MimeAttachment[];
}

function parseAddressListHeader(value: string | undefined): string[] {
  return value ? splitAddressList(value).map(bareAddress) : [];
}

// Gmail's drafts.update replaces the whole message, so "merge" semantics
// (unset fields preserve the existing draft) are implemented here by reading
// the current draft first and folding in only the fields the caller set.
export async function updateDraft(
  accessToken: string,
  input: UpdateDraftInput,
): Promise<DraftSummary> {
  const existing = await gmailFetch<{ id: string; message: GmailMessageResource }>(
    accessToken,
    `/users/me/drafts/${input.draftId}?format=full`,
  );
  const headers = existing.message.payload?.headers;
  const { body: existingBody, htmlBody: existingHtml } = extractBodies(existing.message.payload);

  const to = input.to?.length ? input.to : parseAddressListHeader(headerValue(headers, "To"));
  const cc = input.cc?.length ? input.cc : parseAddressListHeader(headerValue(headers, "Cc"));
  const bcc = input.bcc?.length ? input.bcc : parseAddressListHeader(headerValue(headers, "Bcc"));
  const subject = input.subject || headerValue(headers, "Subject") || "";

  const bodyProvided = Boolean(input.body || input.htmlBody);
  const body = bodyProvided ? input.body : existingBody;
  const htmlBody = bodyProvided ? input.htmlBody : existingHtml;

  const raw = buildRawMimeMessage({
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject,
    body,
    htmlBody,
    attachments: input.attachments,
  });

  return gmailFetch<DraftSummary>(accessToken, `/users/me/drafts/${input.draftId}`, {
    method: "PUT",
    body: JSON.stringify({ message: { raw, threadId: existing.message.threadId } }),
  });
}

export type DraftView = "DRAFT_VIEW_METADATA_ONLY" | "DRAFT_VIEW_FULL";

export interface DraftListItem {
  id: string;
  threadId?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  date?: string;
  subject?: string;
  body?: string;
}

export interface ListDraftsInput {
  query?: string;
  pageSize?: number;
  pageToken?: string;
  view?: DraftView;
}

export interface ListDraftsResult {
  drafts: DraftListItem[];
  nextPageToken?: string;
}

export async function listDrafts(
  accessToken: string,
  { query, pageSize = 20, pageToken, view = "DRAFT_VIEW_METADATA_ONLY" }: ListDraftsInput,
): Promise<ListDraftsResult> {
  const params = new URLSearchParams({ maxResults: String(Math.min(pageSize, 50)) });
  if (query) params.set("q", query);
  if (pageToken) params.set("pageToken", pageToken);

  const list = await gmailFetch<{ drafts?: { id: string }[]; nextPageToken?: string }>(
    accessToken,
    `/users/me/drafts?${params}`,
  );
  const refs = list.drafts ?? [];
  const gmailFormat = view === "DRAFT_VIEW_FULL" ? "full" : "metadata";

  const drafts = await Promise.all(
    refs.map(async (ref): Promise<DraftListItem> => {
      const draftParams = new URLSearchParams({ format: gmailFormat });
      if (gmailFormat === "metadata") {
        for (const header of ["To", "Cc", "Bcc", "Date", "Subject"]) {
          draftParams.append("metadataHeaders", header);
        }
      }
      const draft = await gmailFetch<{ id: string; message: GmailMessageResource }>(
        accessToken,
        `/users/me/drafts/${ref.id}?${draftParams}`,
      );
      const headers = draft.message.payload?.headers;
      const item: DraftListItem = {
        id: draft.id,
        threadId: draft.message.threadId,
        to: headerValue(headers, "To"),
        cc: headerValue(headers, "Cc"),
        bcc: headerValue(headers, "Bcc"),
        date: headerValue(headers, "Date"),
      };
      if (view === "DRAFT_VIEW_FULL") {
        item.subject = headerValue(headers, "Subject");
        item.body = extractBodies(draft.message.payload).body;
      }
      return item;
    }),
  );
  return { drafts, nextPageToken: list.nextPageToken };
}

// --- Labels ---

export interface LabelSummary {
  id: string;
  name: string;
  type: string;
}

export async function listLabels(accessToken: string): Promise<LabelSummary[]> {
  const data = await gmailFetch<{ labels?: LabelSummary[] }>(accessToken, "/users/me/labels");
  return data.labels ?? [];
}

// Gmail restricts label colors to this fixed palette (labels.create/patch
// reject any other hex pair) — mirrors the official connector's presets.
const LABEL_COLOR_PRESETS = {
  LABEL_COLOR_PRESET_BLACK: { backgroundColor: "#000000", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GRAY: { backgroundColor: "#434343", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_GRAY: { backgroundColor: "#666666", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_LIGHT_GRAY: { backgroundColor: "#cccccc", textColor: "#000000" },
  LABEL_COLOR_PRESET_WHITE: { backgroundColor: "#ffffff", textColor: "#000000" },
  LABEL_COLOR_PRESET_RED: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_ORANGE: { backgroundColor: "#ffad47", textColor: "#000000" },
  LABEL_COLOR_PRESET_YELLOW: { backgroundColor: "#fad165", textColor: "#000000" },
  LABEL_COLOR_PRESET_GREEN: { backgroundColor: "#16a765", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_MINT: { backgroundColor: "#43d692", textColor: "#000000" },
  LABEL_COLOR_PRESET_TEAL: { backgroundColor: "#2da2bb", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BLUE: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PURPLE: { backgroundColor: "#a479e2", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PINK: { backgroundColor: "#f691b2", textColor: "#000000" },
  LABEL_COLOR_PRESET_DARK_RED: { backgroundColor: "#822111", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_ORANGE: { backgroundColor: "#a46a21", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GREEN: { backgroundColor: "#076239", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_BLUE: { backgroundColor: "#1c4587", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PURPLE: { backgroundColor: "#41236d", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PINK: { backgroundColor: "#83334c", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BROWN: { backgroundColor: "#7a4706", textColor: "#ffffff" },
} as const;

export type LabelColorPreset = keyof typeof LABEL_COLOR_PRESETS;
export const LABEL_COLOR_PRESET_NAMES = Object.keys(LABEL_COLOR_PRESETS) as [
  LabelColorPreset,
  ...LabelColorPreset[],
];

async function createLabelRaw(
  accessToken: string,
  name: string,
  colorPreset?: LabelColorPreset,
): Promise<LabelSummary> {
  const color = colorPreset ? LABEL_COLOR_PRESETS[colorPreset] : undefined;
  return gmailFetch<LabelSummary>(accessToken, "/users/me/labels", {
    method: "POST",
    body: JSON.stringify({ name, ...(color ? { color } : {}) }),
  });
}

export interface CreateLabelInput {
  displayName: string;
  colorPreset?: LabelColorPreset;
  autoCreateParentLabels?: boolean;
}

export async function createLabel(
  accessToken: string,
  { displayName, colorPreset, autoCreateParentLabels = true }: CreateLabelInput,
): Promise<LabelSummary> {
  const segments = displayName.split("/");
  if (segments.length > 1 && autoCreateParentLabels) {
    const existing = await listLabels(accessToken);
    const existingNames = new Set(existing.map((l) => l.name));
    let path = "";
    for (const segment of segments.slice(0, -1)) {
      path = path ? `${path}/${segment}` : segment;
      if (!existingNames.has(path)) {
        await createLabelRaw(accessToken, path);
        existingNames.add(path);
      }
    }
  }
  return createLabelRaw(accessToken, displayName, colorPreset);
}

export interface UpdateLabelInput {
  labelId: string;
  displayName?: string;
  colorPreset?: LabelColorPreset;
}

export async function updateLabel(
  accessToken: string,
  { labelId, displayName, colorPreset }: UpdateLabelInput,
): Promise<LabelSummary> {
  const color = colorPreset ? LABEL_COLOR_PRESETS[colorPreset] : undefined;
  return gmailFetch<LabelSummary>(accessToken, `/users/me/labels/${labelId}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(displayName ? { name: displayName } : {}),
      ...(color ? { color } : {}),
    }),
  });
}

export async function deleteLabel(accessToken: string, labelId: string): Promise<void> {
  await gmailFetch(accessToken, `/users/me/labels/${labelId}`, { method: "DELETE" });
}

// --- Message/thread label, trash, and spam operations ---

interface ModifyResult {
  id: string;
  labelIds?: string[];
}

async function modifyMessage(
  accessToken: string,
  messageId: string,
  body: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<ModifyResult> {
  return gmailFetch(accessToken, `/users/me/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function modifyThread(
  accessToken: string,
  threadId: string,
  body: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<ModifyResult> {
  return gmailFetch(accessToken, `/users/me/threads/${threadId}/modify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function labelMessage(
  accessToken: string,
  messageId: string,
  labelIds: string[],
): Promise<ModifyResult> {
  return modifyMessage(accessToken, messageId, { addLabelIds: labelIds });
}

export function unlabelMessage(
  accessToken: string,
  messageId: string,
  labelIds: string[],
): Promise<ModifyResult> {
  return modifyMessage(accessToken, messageId, { removeLabelIds: labelIds });
}

export function labelThread(
  accessToken: string,
  threadId: string,
  labelIds: string[],
): Promise<ModifyResult> {
  return modifyThread(accessToken, threadId, { addLabelIds: labelIds });
}

export function unlabelThread(
  accessToken: string,
  threadId: string,
  labelIds: string[],
): Promise<ModifyResult> {
  return modifyThread(accessToken, threadId, { removeLabelIds: labelIds });
}

export function archiveMessage(accessToken: string, id: string): Promise<ModifyResult> {
  return unlabelMessage(accessToken, id, ["INBOX"]);
}

export async function trashMessage(accessToken: string, id: string): Promise<{ id: string }> {
  return gmailFetch(accessToken, `/users/me/messages/${id}/trash`, { method: "POST" });
}

export async function untrashMessage(accessToken: string, id: string): Promise<{ id: string }> {
  return gmailFetch(accessToken, `/users/me/messages/${id}/untrash`, { method: "POST" });
}

export async function trashThread(accessToken: string, id: string): Promise<{ id: string }> {
  return gmailFetch(accessToken, `/users/me/threads/${id}/trash`, { method: "POST" });
}

export async function untrashThread(accessToken: string, id: string): Promise<{ id: string }> {
  return gmailFetch(accessToken, `/users/me/threads/${id}/untrash`, { method: "POST" });
}

export function markMessageSpam(accessToken: string, id: string): Promise<ModifyResult> {
  return modifyMessage(accessToken, id, { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
}

export function unmarkMessageSpam(accessToken: string, id: string): Promise<ModifyResult> {
  return modifyMessage(accessToken, id, { removeLabelIds: ["SPAM"], addLabelIds: ["INBOX"] });
}

export function markThreadSpam(accessToken: string, id: string): Promise<ModifyResult> {
  return modifyThread(accessToken, id, { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
}

export function unmarkThreadSpam(accessToken: string, id: string): Promise<ModifyResult> {
  return modifyThread(accessToken, id, { removeLabelIds: ["SPAM"], addLabelIds: ["INBOX"] });
}
