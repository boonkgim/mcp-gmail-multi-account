import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { AccountsHandler } from "./accounts-handler";
import {
  createConnectLinkToken,
  listAccounts,
  removeAccount,
  resolveAccount,
  type GmailAccount,
} from "./accounts";
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
  LABEL_COLOR_PRESET_NAMES,
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
import { getGoogleAccessToken, type Props } from "./google-auth";
import { GoogleHandler } from "./google-handler";
import { isSendAllowed, setSendAllowed } from "./send-permission";

const accountParam = z
  .string()
  .optional()
  .describe(
    "Gmail address of the connected account to use. Omit if only one account is connected; " +
      "required when multiple accounts are connected (see list_gmail_accounts).",
  );

const messageFormatParam = z
  .enum(["MINIMAL", "FULL_CONTENT", "METADATA_ONLY", "PLAIN_TEXT"])
  .optional()
  .describe(
    "MINIMAL: snippet + key headers. FULL_CONTENT (default): + full body (plain and HTML) and " +
      "attachment list. METADATA_ONLY: just id/threadId/labels/size, no subject or body. " +
      "PLAIN_TEXT: like FULL_CONTENT but omits htmlBody (HTML is converted to plain text if no " +
      "plain part exists) — prefer this to avoid pulling large HTML bodies into context.",
  );

const attachmentParam = z.object({
  content: z.string().describe("Base64-encoded attachment content"),
  filename: z.string().optional(),
  mimeType: z.string().optional().describe('IANA MIME type, e.g. "application/pdf"'),
  inline: z
    .boolean()
    .optional()
    .describe(
      "If true, reference it in htmlBody via cid:<filename> instead of listing it as a download",
    ),
});

const colorPresetParam = z
  .enum(LABEL_COLOR_PRESET_NAMES)
  .optional()
  .describe("Gmail only accepts colors from this fixed preset palette.");

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "mcp-gmail-multi-account", version: "0.1.0" });

  private get ownerId(): string {
    return this.props!.email;
  }

  /** Resolves the requested (or sole) connected account and mints it a fresh access token. */
  private async resolve(
    requested: string | undefined,
  ): Promise<{ accessToken: string; account: GmailAccount }> {
    const accounts = await listAccounts(this.env, this.ownerId);
    const account = resolveAccount(accounts, requested);
    const accessToken = await getGoogleAccessToken(this.env, account.refreshToken);
    return { accessToken, account };
  }

  private static readonly SEND_BLOCKED_MESSAGE =
    "Sending is currently disabled for this connector (the default). Use create_draft to save " +
    "it instead, or ask the user whether to enable sending — if they agree, call " +
    "set_send_permission with allow: true first.";

  /** Null when sending is allowed; otherwise the message to return instead of sending. */
  private async sendBlockedMessage(): Promise<string | null> {
    return (await isSendAllowed(this.env, this.ownerId)) ? null : MyMCP.SEND_BLOCKED_MESSAGE;
  }

  async init() {
    // --- Account management -------------------------------------------------

    this.server.registerTool(
      "list_gmail_accounts",
      {
        title: "List connected Gmail accounts",
        description:
          "List the Gmail accounts currently connected to this connector. Most other tools take " +
          "an optional `account` parameter to pick which one to act on.",
        inputSchema: {},
      },
      async () => {
        const accounts = await listAccounts(this.env, this.ownerId);
        const text = accounts.length
          ? accounts
              .map((a) => `- ${a.email} (connected ${new Date(a.connectedAt).toISOString()})`)
              .join("\n")
          : "No Gmail accounts connected yet. Use get_gmail_connect_link to connect one.";
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.registerTool(
      "get_gmail_connect_link",
      {
        title: "Get a link to connect another Gmail account",
        description:
          "Generate a one-time link (valid 15 minutes) for the user to open in their browser to " +
          "connect an additional Gmail account — or reconnect one whose access was revoked. Present " +
          "this link to the user; it lets them pick any Google account, including one different " +
          "from whichever they used to authorize this connector.",
        inputSchema: {},
      },
      async () => {
        if (!this.env.PUBLIC_URL) {
          return {
            content: [
              {
                type: "text",
                text:
                  "This server's PUBLIC_URL environment variable isn't configured, so a connect " +
                  "link can't be built. Set it in wrangler.jsonc to this Worker's deployed URL and redeploy.",
              },
            ],
          };
        }
        const token = await createConnectLinkToken(this.env, this.ownerId);
        const base = this.env.PUBLIC_URL.replace(/\/$/, "");
        return {
          content: [
            {
              type: "text",
              text: `Open this link to connect a Gmail account (valid for 15 minutes):\n${base}/accounts/connect?token=${token}`,
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "disconnect_gmail_account",
      {
        title: "Disconnect a Gmail account",
        description:
          "Remove a connected Gmail account from this connector. This does not revoke Google's own " +
          "access grant — the user can also do that at https://myaccount.google.com/permissions.",
        inputSchema: { account: z.string().describe("Gmail address to disconnect") },
      },
      async ({ account }) => {
        const removed = await removeAccount(this.env, this.ownerId, account);
        return {
          content: [
            {
              type: "text",
              text: removed
                ? `Disconnected ${account}.`
                : `No connected account matches ${account}.`,
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "set_send_permission",
      {
        title: "Allow or disallow sending mail",
        description:
          "Turn this connector's ability to actually send mail (send_message, reply, forward) on " +
          "or off. Off by default, so those tools fall back to explaining that create_draft should " +
          "be used instead. Only call this with allow: true after the user has explicitly agreed to " +
          "let the connector send mail on their behalf — don't enable it on your own initiative " +
          "just because a send was blocked.",
        inputSchema: { allow: z.boolean() },
      },
      async ({ allow }) => {
        await setSendAllowed(this.env, this.ownerId, allow);
        return {
          content: [
            {
              type: "text",
              text: allow
                ? "Sending is now enabled. send_message, reply, and forward will work."
                : "Sending is now disabled. Use create_draft instead until it's re-enabled.",
            },
          ],
        };
      },
    );

    // --- Reading -------------------------------------------------------------

    this.server.registerTool(
      "search_threads",
      {
        title: "Search Gmail threads",
        description:
          "Search threads (conversations) using Gmail's search syntax, e.g. \"from:alice@example.com " +
          'is:unread", "subject:invoice after:2026/01/01". Omit query to list the most recent inbox ' +
          "threads. Use get_thread to fetch a thread's full messages.",
        inputSchema: {
          query: z.string().optional(),
          pageSize: z.number().int().min(1).max(50).optional(),
          pageToken: z
            .string()
            .optional()
            .describe("From a previous search_threads call, to page further"),
          view: z
            .enum(["THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY"])
            .optional()
            .describe("MINIMAL (default) includes subject/snippet; METADATA_ONLY omits them"),
          includeTrash: z
            .boolean()
            .optional()
            .describe("Include threads in Trash/Spam. Default false"),
          account: accountParam,
        },
      },
      async ({ query, pageSize, pageToken, view, includeTrash, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await searchThreads(accessToken, {
          query,
          pageSize,
          pageToken,
          view,
          includeTrash,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "get_message",
      {
        title: "Get Gmail message",
        description: "Fetch one message by id. Use messageFormat to control how much is returned.",
        inputSchema: {
          messageId: z.string(),
          messageFormat: messageFormatParam,
          account: accountParam,
        },
      },
      async ({ messageId, messageFormat, account }) => {
        const { accessToken } = await this.resolve(account);
        const message = await getMessage(accessToken, messageId, messageFormat);
        return { content: [{ type: "text", text: JSON.stringify(message, null, 2) }] };
      },
    );

    this.server.registerTool(
      "get_thread",
      {
        title: "Get Gmail thread",
        description:
          "Fetch every message in a thread, in order. Use messageFormat to control how much of " +
          "each message is returned.",
        inputSchema: {
          threadId: z.string(),
          messageFormat: messageFormatParam,
          account: accountParam,
        },
      },
      async ({ threadId, messageFormat, account }) => {
        const { accessToken } = await this.resolve(account);
        const thread = await getThread(accessToken, threadId, messageFormat);
        return { content: [{ type: "text", text: JSON.stringify(thread, null, 2) }] };
      },
    );

    // --- Labels ----------------------------------------------------------------

    this.server.registerTool(
      "list_labels",
      {
        title: "List Gmail labels",
        description: "List the account's labels (system, e.g. INBOX/STARRED, and user-created).",
        inputSchema: { account: accountParam },
      },
      async ({ account }) => {
        const { accessToken } = await this.resolve(account);
        const labels = await listLabels(accessToken);
        return { content: [{ type: "text", text: JSON.stringify(labels, null, 2) }] };
      },
    );

    this.server.registerTool(
      "create_label",
      {
        title: "Create a Gmail label",
        description:
          'Create a new label. Use "/" for nested sub-labels (e.g. "Projects/Alpha/Sprint-1"); ' +
          "missing parent labels are created automatically unless autoCreateParentLabels is false.",
        inputSchema: {
          displayName: z.string(),
          colorPreset: colorPresetParam,
          autoCreateParentLabels: z.boolean().optional(),
          account: accountParam,
        },
      },
      async ({ displayName, colorPreset, autoCreateParentLabels, account }) => {
        const { accessToken } = await this.resolve(account);
        const label = await createLabel(accessToken, {
          displayName,
          colorPreset,
          autoCreateParentLabels,
        });
        return { content: [{ type: "text", text: JSON.stringify(label, null, 2) }] };
      },
    );

    this.server.registerTool(
      "update_label",
      {
        title: "Rename or recolor a Gmail label",
        description: "Modify an existing label's display name and/or color.",
        inputSchema: {
          labelId: z.string(),
          displayName: z.string().optional(),
          colorPreset: colorPresetParam,
          account: accountParam,
        },
      },
      async ({ labelId, displayName, colorPreset, account }) => {
        const { accessToken } = await this.resolve(account);
        const label = await updateLabel(accessToken, { labelId, displayName, colorPreset });
        return { content: [{ type: "text", text: JSON.stringify(label, null, 2) }] };
      },
    );

    this.server.registerTool(
      "delete_label",
      {
        title: "Delete a Gmail label",
        description: "Permanently delete a label. Use list_labels to find its id.",
        inputSchema: { labelId: z.string(), account: accountParam },
      },
      async ({ labelId, account }) => {
        const { accessToken } = await this.resolve(account);
        await deleteLabel(accessToken, labelId);
        return { content: [{ type: "text", text: `Deleted label ${labelId}.` }] };
      },
    );

    this.server.registerTool(
      "label_message",
      {
        title: "Add labels to a Gmail message",
        description:
          "Add one or more labels to a message — system (e.g. STARRED, IMPORTANT) or user-defined " +
          "(use list_labels for ids).",
        inputSchema: {
          messageId: z.string(),
          labelIds: z.array(z.string()).min(1),
          account: accountParam,
        },
      },
      async ({ messageId, labelIds, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await labelMessage(accessToken, messageId, labelIds);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "unlabel_message",
      {
        title: "Remove labels from a Gmail message",
        description:
          "Remove one or more labels from a message — e.g. remove UNREAD to mark read, remove " +
          "STARRED to unstar.",
        inputSchema: {
          messageId: z.string(),
          labelIds: z.array(z.string()).min(1),
          account: accountParam,
        },
      },
      async ({ messageId, labelIds, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await unlabelMessage(accessToken, messageId, labelIds);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "label_thread",
      {
        title: "Add labels to a Gmail thread",
        description:
          "Add one or more labels to every message in a thread, including future messages added to it.",
        inputSchema: {
          threadId: z.string(),
          labelIds: z.array(z.string()).min(1),
          account: accountParam,
        },
      },
      async ({ threadId, labelIds, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await labelThread(accessToken, threadId, labelIds);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "unlabel_thread",
      {
        title: "Remove labels from a Gmail thread",
        description: "Remove one or more labels from every message in a thread.",
        inputSchema: {
          threadId: z.string(),
          labelIds: z.array(z.string()).min(1),
          account: accountParam,
        },
      },
      async ({ threadId, labelIds, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await unlabelThread(accessToken, threadId, labelIds);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    // --- Archive / trash / spam -------------------------------------------------

    this.server.registerTool(
      "archive_message",
      {
        title: "Archive Gmail message",
        description: "Remove a message from the inbox (equivalent to the Archive button).",
        inputSchema: { messageId: z.string(), account: accountParam },
      },
      async ({ messageId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await archiveMessage(accessToken, messageId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "trash_message",
      {
        title: "Trash Gmail message",
        description: "Move a message to Trash (recoverable for ~30 days, matching Gmail's UI).",
        inputSchema: { messageId: z.string(), account: accountParam },
      },
      async ({ messageId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await trashMessage(accessToken, messageId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "untrash_message",
      {
        title: "Restore Gmail message from Trash",
        description: "Move a message out of Trash and back to its previous labels.",
        inputSchema: { messageId: z.string(), account: accountParam },
      },
      async ({ messageId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await untrashMessage(accessToken, messageId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "trash_thread",
      {
        title: "Trash Gmail thread",
        description: "Move an entire thread to Trash, including all its messages.",
        inputSchema: { threadId: z.string(), account: accountParam },
      },
      async ({ threadId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await trashThread(accessToken, threadId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "untrash_thread",
      {
        title: "Restore Gmail thread from Trash",
        description: "Move an entire thread out of Trash.",
        inputSchema: { threadId: z.string(), account: accountParam },
      },
      async ({ threadId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await untrashThread(accessToken, threadId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "mark_message_spam",
      {
        title: "Mark Gmail message as spam",
        description: "Mark a message as Spam and remove it from the inbox.",
        inputSchema: { messageId: z.string(), account: accountParam },
      },
      async ({ messageId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await markMessageSpam(accessToken, messageId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "unmark_message_spam",
      {
        title: "Unmark Gmail message as spam",
        description: 'Mark a message as "Not spam" and return it to the inbox.',
        inputSchema: { messageId: z.string(), account: accountParam },
      },
      async ({ messageId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await unmarkMessageSpam(accessToken, messageId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "mark_thread_spam",
      {
        title: "Mark Gmail thread as spam",
        description: "Mark an entire thread as Spam and remove it from the inbox.",
        inputSchema: { threadId: z.string(), account: accountParam },
      },
      async ({ threadId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await markThreadSpam(accessToken, threadId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    this.server.registerTool(
      "unmark_thread_spam",
      {
        title: "Unmark Gmail thread as spam",
        description: 'Mark an entire thread as "Not spam" and return it to the inbox.',
        inputSchema: { threadId: z.string(), account: accountParam },
      },
      async ({ threadId, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await unmarkThreadSpam(accessToken, threadId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    // --- Drafts ------------------------------------------------------------

    this.server.registerTool(
      "create_draft",
      {
        title: "Create Gmail draft",
        description:
          "Save a new draft without sending it. Pass replyToMessageId to save it as an in-thread " +
          'reply draft (like Gmail\'s own "Draft reply") — to and subject are then derived from ' +
          "the original message unless overridden, and replyAll also Ccs the original recipients " +
          "(minus the sending account).",
        inputSchema: {
          to: z.array(z.string()).optional(),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          subject: z.string().optional(),
          body: z
            .string()
            .optional()
            .describe("Plain-text body; the alternative if htmlBody is also set"),
          htmlBody: z.string().optional(),
          attachments: z.array(attachmentParam).optional(),
          replyToMessageId: z
            .string()
            .optional()
            .describe("Message id to thread this draft as a reply to"),
          replyAll: z.boolean().optional(),
          account: accountParam,
        },
      },
      async ({
        to,
        cc,
        bcc,
        subject,
        body,
        htmlBody,
        attachments,
        replyToMessageId,
        replyAll,
        account,
      }) => {
        const { accessToken, account: resolved } = await this.resolve(account);
        const draft = await createDraft(accessToken, {
          to,
          cc,
          bcc,
          subject,
          body,
          htmlBody,
          attachments,
          replyToMessageId,
          replyAll,
          account: resolved.email,
        });
        return { content: [{ type: "text", text: `Created draft ${draft.id}.` }] };
      },
    );

    this.server.registerTool(
      "update_draft",
      {
        title: "Update a Gmail draft",
        description:
          "Update an existing draft. Fields you provide overwrite the draft; omitted fields are " +
          "preserved. Note: attachments are never merged — omitting them removes any the draft " +
          "already had, so re-include ones you want to keep.",
        inputSchema: {
          draftId: z.string(),
          to: z.array(z.string()).optional(),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          subject: z.string().optional(),
          body: z.string().optional(),
          htmlBody: z.string().optional(),
          attachments: z.array(attachmentParam).optional(),
          account: accountParam,
        },
      },
      async ({ draftId, to, cc, bcc, subject, body, htmlBody, attachments, account }) => {
        const { accessToken } = await this.resolve(account);
        const draft = await updateDraft(accessToken, {
          draftId,
          to,
          cc,
          bcc,
          subject,
          body,
          htmlBody,
          attachments,
        });
        return { content: [{ type: "text", text: `Updated draft ${draft.id}.` }] };
      },
    );

    this.server.registerTool(
      "list_drafts",
      {
        title: "List Gmail drafts",
        description: "List saved drafts, optionally filtered with Gmail search syntax.",
        inputSchema: {
          query: z.string().optional(),
          pageSize: z.number().int().min(1).max(50).optional(),
          pageToken: z.string().optional(),
          view: z
            .enum(["DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"])
            .optional()
            .describe("METADATA_ONLY (default) omits subject/body; FULL includes them"),
          account: accountParam,
        },
      },
      async ({ query, pageSize, pageToken, view, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await listDrafts(accessToken, { query, pageSize, pageToken, view });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

    // --- Sending ---------------------------------------------------------------

    this.server.registerTool(
      "send_message",
      {
        title: "Send Gmail message",
        description:
          "Compose and immediately send a new email, or send an existing draft by passing draftId " +
          "(all other fields are then ignored). Disabled by default (see set_send_permission) — " +
          "prefer create_draft unless the user has explicitly enabled sending.",
        inputSchema: {
          to: z.array(z.string()).optional().describe("Required unless draftId is set"),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          subject: z.string().optional(),
          body: z
            .string()
            .optional()
            .describe("Plain-text body; the alternative if htmlBody is also set"),
          htmlBody: z.string().optional(),
          attachments: z.array(attachmentParam).optional(),
          draftId: z.string().optional().describe("Send this existing draft as-is"),
          account: accountParam,
        },
      },
      async ({ to, cc, bcc, subject, body, htmlBody, attachments, draftId, account }) => {
        const blocked = await this.sendBlockedMessage();
        if (blocked) return { content: [{ type: "text", text: blocked }] };
        const { accessToken } = await this.resolve(account);
        const result = await sendMessage(accessToken, {
          to,
          cc,
          bcc,
          subject,
          body,
          htmlBody,
          attachments,
          draftId,
        });
        return {
          content: [
            { type: "text", text: `Sent message ${result.id} (thread ${result.threadId}).` },
          ],
        };
      },
    );

    this.server.registerTool(
      "reply",
      {
        title: "Reply to Gmail message",
        description:
          "Reply in-thread to an existing message, preserving subject/threading headers. " +
          "replyAll also Ccs the original recipients (minus the sending account); default is reply " +
          "to sender only. Disabled by default (see set_send_permission) — prefer create_draft " +
          "unless the user has explicitly enabled sending.",
        inputSchema: {
          messageId: z.string(),
          body: z.string().optional().describe("Required unless htmlBody is set"),
          htmlBody: z.string().optional().describe("Required unless body is set"),
          replyAll: z.boolean().optional(),
          account: accountParam,
        },
      },
      async ({ messageId, body, htmlBody, replyAll, account }) => {
        const blocked = await this.sendBlockedMessage();
        if (blocked) return { content: [{ type: "text", text: blocked }] };
        const { accessToken, account: resolved } = await this.resolve(account);
        const result = await reply(accessToken, {
          account: resolved.email,
          messageId,
          body,
          htmlBody,
          replyAll,
        });
        return {
          content: [
            { type: "text", text: `Sent reply ${result.id} in thread ${result.threadId}.` },
          ],
        };
      },
    );

    this.server.registerTool(
      "forward",
      {
        title: "Forward Gmail message",
        description:
          "Forward an existing message, carrying over its attachments. Disabled by default (see " +
          "set_send_permission) — prefer create_draft unless the user has explicitly enabled sending.",
        inputSchema: {
          messageId: z.string(),
          to: z.array(z.string()).min(1),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          forwardText: z
            .string()
            .optional()
            .describe("Plain-text comment to add before the forwarded message"),
          htmlBody: z
            .string()
            .optional()
            .describe("HTML comment to add before the forwarded message"),
          account: accountParam,
        },
      },
      async ({ messageId, to, cc, bcc, forwardText, htmlBody, account }) => {
        const blocked = await this.sendBlockedMessage();
        if (blocked) return { content: [{ type: "text", text: blocked }] };
        const { accessToken } = await this.resolve(account);
        const result = await forward(accessToken, {
          messageId,
          to,
          cc,
          bcc,
          forwardText,
          htmlBody,
        });
        return {
          content: [
            {
              type: "text",
              text: `Forwarded as message ${result.id} (thread ${result.threadId}).`,
            },
          ],
        };
      },
    );
  }
}

const app = new Hono<{ Bindings: Env }>();
app.route("/", GoogleHandler);
app.route("/accounts", AccountsHandler);

export default new OAuthProvider({
  apiHandler: MyMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: app,
  tokenEndpoint: "/token",
});
