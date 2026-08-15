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
  getMessage,
  getThread,
  listDrafts,
  listLabels,
  modifyMessageLabels,
  replyToMessage,
  searchMessages,
  sendDraft,
  sendMessage,
  trashMessage,
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
    "Sending is currently disabled for this connector (the default). Use create_draft to " +
    "save it instead, or ask the user whether to enable sending — if they agree, call " +
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
          "Turn this connector's ability to actually send mail (send_message, reply_to_message, " +
          "send_draft) on or off. Off by default, so those tools fall back to explaining that " +
          "create_draft should be used instead. Only call this with allow: true after the user has " +
          "explicitly agreed to let the connector send mail on their behalf — don't enable it on " +
          "your own initiative just because a send was blocked.",
        inputSchema: { allow: z.boolean() },
      },
      async ({ allow }) => {
        await setSendAllowed(this.env, this.ownerId, allow);
        return {
          content: [
            {
              type: "text",
              text: allow
                ? "Sending is now enabled. send_message, reply_to_message, and send_draft will work."
                : "Sending is now disabled. Use create_draft instead until it's re-enabled.",
            },
          ],
        };
      },
    );

    // --- Reading -------------------------------------------------------------

    this.server.registerTool(
      "search_messages",
      {
        title: "Search Gmail messages",
        description:
          'Search messages using Gmail\'s search syntax, e.g. "from:alice@example.com is:unread", ' +
          '"subject:invoice after:2026/01/01". Omit query to list the most recent inbox messages.',
        inputSchema: {
          query: z.string().optional(),
          maxResults: z.number().int().min(1).max(50).optional(),
          account: accountParam,
        },
      },
      async ({ query, maxResults, account }) => {
        const { accessToken } = await this.resolve(account);
        const results = await searchMessages(accessToken, { query, maxResults });
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      },
    );

    this.server.registerTool(
      "get_message",
      {
        title: "Get Gmail message",
        description: "Fetch the full content (headers, body, attachment list) of one message.",
        inputSchema: { messageId: z.string(), account: accountParam },
      },
      async ({ messageId, account }) => {
        const { accessToken } = await this.resolve(account);
        const message = await getMessage(accessToken, messageId);
        return { content: [{ type: "text", text: JSON.stringify(message, null, 2) }] };
      },
    );

    this.server.registerTool(
      "get_thread",
      {
        title: "Get Gmail thread",
        description: "Fetch every message in a thread, in order, with full content.",
        inputSchema: { threadId: z.string(), account: accountParam },
      },
      async ({ threadId, account }) => {
        const { accessToken } = await this.resolve(account);
        const thread = await getThread(accessToken, threadId);
        return { content: [{ type: "text", text: JSON.stringify(thread, null, 2) }] };
      },
    );

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

    // --- Sending ---------------------------------------------------------------

    this.server.registerTool(
      "send_message",
      {
        title: "Send Gmail message",
        description:
          "Compose and immediately send a new email. Disabled by default (see " +
          "set_send_permission) — prefer create_draft unless the user has explicitly enabled sending.",
        inputSchema: {
          to: z.array(z.string()).min(1),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          subject: z.string(),
          body: z.string().describe("Plain-text message body"),
          account: accountParam,
        },
      },
      async ({ to, cc, bcc, subject, body, account }) => {
        const blocked = await this.sendBlockedMessage();
        if (blocked) return { content: [{ type: "text", text: blocked }] };
        const { accessToken } = await this.resolve(account);
        const result = await sendMessage(accessToken, { to, cc, bcc, subject, body });
        return {
          content: [
            { type: "text", text: `Sent message ${result.id} (thread ${result.threadId}).` },
          ],
        };
      },
    );

    this.server.registerTool(
      "reply_to_message",
      {
        title: "Reply to Gmail message",
        description:
          "Reply in-thread to an existing message, preserving subject/threading headers. " +
          "replyAll also Ccs the original recipients (minus the sending account); default is reply " +
          "to sender only. Disabled by default (see set_send_permission) — prefer create_draft " +
          "unless the user has explicitly enabled sending.",
        inputSchema: {
          messageId: z.string(),
          body: z.string().describe("Plain-text reply body"),
          replyAll: z.boolean().optional(),
          account: accountParam,
        },
      },
      async ({ messageId, body, replyAll, account }) => {
        const blocked = await this.sendBlockedMessage();
        if (blocked) return { content: [{ type: "text", text: blocked }] };
        const { accessToken, account: resolved } = await this.resolve(account);
        const result = await replyToMessage(accessToken, {
          account: resolved.email,
          messageId,
          body,
          replyAll,
        });
        return {
          content: [
            { type: "text", text: `Sent reply ${result.id} in thread ${result.threadId}.` },
          ],
        };
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
          to: z
            .array(z.string())
            .min(1)
            .optional()
            .describe("Required unless replyToMessageId is set"),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          subject: z.string().optional().describe("Required unless replyToMessageId is set"),
          body: z.string().describe("Plain-text message body"),
          replyToMessageId: z
            .string()
            .optional()
            .describe("Message id to thread this draft as a reply to"),
          replyAll: z.boolean().optional(),
          account: accountParam,
        },
      },
      async ({ to, cc, bcc, subject, body, replyToMessageId, replyAll, account }) => {
        const { accessToken, account: resolved } = await this.resolve(account);
        const draft = await createDraft(accessToken, {
          to,
          cc,
          bcc,
          subject,
          body,
          replyToMessageId,
          replyAll,
          account: resolved.email,
        });
        return { content: [{ type: "text", text: `Created draft ${draft.id}.` }] };
      },
    );

    this.server.registerTool(
      "list_drafts",
      {
        title: "List Gmail drafts",
        description: "List saved drafts.",
        inputSchema: {
          maxResults: z.number().int().min(1).max(50).optional(),
          account: accountParam,
        },
      },
      async ({ maxResults, account }) => {
        const { accessToken } = await this.resolve(account);
        const drafts = await listDrafts(accessToken, maxResults);
        return { content: [{ type: "text", text: JSON.stringify(drafts, null, 2) }] };
      },
    );

    this.server.registerTool(
      "send_draft",
      {
        title: "Send Gmail draft",
        description:
          "Send a previously created draft by its draft id. Disabled by default (see " +
          "set_send_permission) — the draft stays saved either way.",
        inputSchema: { draftId: z.string(), account: accountParam },
      },
      async ({ draftId, account }) => {
        const blocked = await this.sendBlockedMessage();
        if (blocked) return { content: [{ type: "text", text: blocked }] };
        const { accessToken } = await this.resolve(account);
        const result = await sendDraft(accessToken, draftId);
        return {
          content: [
            {
              type: "text",
              text: `Sent draft as message ${result.id} (thread ${result.threadId}).`,
            },
          ],
        };
      },
    );

    // --- Organizing ----------------------------------------------------------

    this.server.registerTool(
      "modify_labels",
      {
        title: "Modify Gmail message labels",
        description:
          "Add and/or remove labels on a message — e.g. add STARRED to star, remove UNREAD to mark " +
          "read, remove INBOX to archive. Use list_labels for available label ids.",
        inputSchema: {
          messageId: z.string(),
          addLabelIds: z.array(z.string()).optional(),
          removeLabelIds: z.array(z.string()).optional(),
          account: accountParam,
        },
      },
      async ({ messageId, addLabelIds, removeLabelIds, account }) => {
        const { accessToken } = await this.resolve(account);
        const result = await modifyMessageLabels(accessToken, messageId, {
          addLabelIds,
          removeLabelIds,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );

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
