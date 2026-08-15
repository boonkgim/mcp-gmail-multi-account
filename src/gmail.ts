// Gmail API client, implemented with plain fetch (no `googleapis` SDK — it's
// Node-oriented and unnecessarily heavy for a Workers isolate). Mirrors the
// style of a sibling contacts server's people.ts client.

import { buildRawMimeMessage } from "./mime";

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
  // messages.trash/untrash and modify return a body; a 204 No Content (rare
  // here, but cheap to guard) would otherwise throw on .json().
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
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

function extractBody(payload: GmailMessagePart | undefined): { body: string; bodyType: string } {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return { body: decodeBase64Url(plain.body.data), bodyType: "text/plain" };
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return { body: decodeBase64Url(html.body.data), bodyType: "text/html" };
  return { body: "", bodyType: "text/plain" };
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

export interface MessageSummary {
  id: string;
  threadId: string;
  snippet?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  labelIds?: string[];
}

const METADATA_HEADERS = ["Subject", "From", "To", "Date"];

function metadataParams(): URLSearchParams {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of METADATA_HEADERS) params.append("metadataHeaders", header);
  return params;
}

async function hydrateMessage(accessToken: string, id: string): Promise<MessageSummary> {
  const msg = await gmailFetch<GmailMessageResource>(
    accessToken,
    `/users/me/messages/${id}?${metadataParams()}`,
  );
  const headers = msg.payload?.headers;
  return {
    id: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet,
    subject: headerValue(headers, "Subject"),
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    date: headerValue(headers, "Date"),
    labelIds: msg.labelIds,
  };
}

export async function searchMessages(
  accessToken: string,
  { query, maxResults = 20 }: { query?: string; maxResults?: number },
): Promise<MessageSummary[]> {
  const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 100)) });
  if (query) params.set("q", query);
  const list = await gmailFetch<{ messages?: { id: string; threadId: string }[] }>(
    accessToken,
    `/users/me/messages?${params}`,
  );
  const refs = list.messages ?? [];
  return Promise.all(refs.map((ref) => hydrateMessage(accessToken, ref.id)));
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
  body: string;
  bodyType: string;
  attachments: AttachmentSummary[];
}

function toMessageDetail(msg: GmailMessageResource): MessageDetail {
  const headers = msg.payload?.headers;
  const { body, bodyType } = extractBody(msg.payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    subject: headerValue(headers, "Subject"),
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    date: headerValue(headers, "Date"),
    body,
    bodyType,
    attachments: collectAttachments(msg.payload),
  };
}

export async function getMessage(accessToken: string, id: string): Promise<MessageDetail> {
  const msg = await gmailFetch<GmailMessageResource>(
    accessToken,
    `/users/me/messages/${id}?format=full`,
  );
  return toMessageDetail(msg);
}

export interface ThreadDetail {
  id: string;
  messages: MessageDetail[];
}

export async function getThread(accessToken: string, id: string): Promise<ThreadDetail> {
  const thread = await gmailFetch<GmailThreadResource>(
    accessToken,
    `/users/me/threads/${id}?format=full`,
  );
  return { id: thread.id, messages: (thread.messages ?? []).map(toMessageDetail) };
}

export interface SendMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId?: string;
}

export interface SentMessage {
  id: string;
  threadId: string;
}

export async function sendMessage(
  accessToken: string,
  input: SendMessageInput,
): Promise<SentMessage> {
  const raw = buildRawMimeMessage(input);
  return gmailFetch<SentMessage>(accessToken, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, threadId: input.threadId }),
  });
}

// Address-list headers ("A <a@x.com>, "B, Inc" <b@x.com>") split on commas
// that aren't inside a quoted display name.
function splitAddressList(headerValue: string): string[] {
  const matches = headerValue.match(/"[^"]*"[^,]*|[^,]+/g) ?? [];
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

export interface ReplyInput {
  /** The connected account's own address, excluded from a reply-all Cc. */
  account: string;
  messageId: string;
  body: string;
  replyAll?: boolean;
}

const REPLY_HEADERS = ["Subject", "From", "To", "Cc", "Message-ID", "References"];

function replyHeaderParams(): URLSearchParams {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of REPLY_HEADERS) params.append("metadataHeaders", header);
  return params;
}

export async function replyToMessage(
  accessToken: string,
  { account, messageId, body, replyAll = false }: ReplyInput,
): Promise<SentMessage> {
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

  const raw = buildRawMimeMessage({
    to,
    cc: cc?.length ? cc : undefined,
    subject,
    body,
    inReplyTo: originalMessageId,
    references: references || undefined,
  });

  return gmailFetch<SentMessage>(accessToken, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, threadId: original.threadId }),
  });
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId?: string;
}

export interface DraftSummary {
  id: string;
  message: SentMessage;
}

export async function createDraft(accessToken: string, input: DraftInput): Promise<DraftSummary> {
  const raw = buildRawMimeMessage(input);
  return gmailFetch<DraftSummary>(accessToken, "/users/me/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, threadId: input.threadId } }),
  });
}

export async function listDrafts(accessToken: string, maxResults = 20): Promise<DraftSummary[]> {
  const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 100)) });
  const data = await gmailFetch<{ drafts?: DraftSummary[] }>(
    accessToken,
    `/users/me/drafts?${params}`,
  );
  return data.drafts ?? [];
}

export async function sendDraft(accessToken: string, draftId: string): Promise<SentMessage> {
  return gmailFetch<SentMessage>(accessToken, "/users/me/drafts/send", {
    method: "POST",
    body: JSON.stringify({ id: draftId }),
  });
}

export interface LabelSummary {
  id: string;
  name: string;
  type: string;
}

export async function listLabels(accessToken: string): Promise<LabelSummary[]> {
  const data = await gmailFetch<{ labels?: LabelSummary[] }>(accessToken, "/users/me/labels");
  return data.labels ?? [];
}

export async function modifyMessageLabels(
  accessToken: string,
  id: string,
  { addLabelIds, removeLabelIds }: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ id: string; labelIds?: string[] }> {
  return gmailFetch(accessToken, `/users/me/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

export async function archiveMessage(
  accessToken: string,
  id: string,
): Promise<{ id: string; labelIds?: string[] }> {
  return modifyMessageLabels(accessToken, id, { removeLabelIds: ["INBOX"] });
}

export async function trashMessage(accessToken: string, id: string): Promise<{ id: string }> {
  return gmailFetch(accessToken, `/users/me/messages/${id}/trash`, { method: "POST" });
}
