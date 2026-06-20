import { Bot, GrammyError, HttpError } from "grammy";
import type { Message } from "grammy/types";
import { CatalogStore } from "./catalog.js";
import type { AppState, ChatMessage } from "./types.js";
import type { TelegramChatType } from "./types.js";
import type { WorkspaceRuntimeManager } from "./workspace-runtime.js";

type TelegramSource = "message" | "channel_post";

export type TelegramChannelOptions = {
  token: string;
  catalog: CatalogStore;
  runtimes: WorkspaceRuntimeManager;
};

export class TelegramChannel {
  private readonly bot: Bot;
  private botId: number | undefined;
  private readonly sentMessageKeys = new Set<string>();
  private readonly sentMessageOrder: string[] = [];
  private startTask: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopRequested = false;
  private botUsername: string | undefined;

  constructor(private readonly options: TelegramChannelOptions) {
    this.bot = new Bot(options.token);
    this.bot.catch((error) => this.logBotError(error.error));
    this.bot.on("message", async (ctx) => {
      const message = ctx.message;
      if (message) await this.handleTelegramMessage(message, "message");
    });
    this.bot.on("channel_post", async (ctx) => {
      const message = ctx.channelPost;
      if (message) await this.handleTelegramMessage(message, "channel_post");
    });
  }

  start(): void {
    this.stopRequested = false;
    this.startPolling();
  }

  private startPolling(): void {
    if (this.startTask || this.restartTimer) return;

    const task = this.bot
      .start({
        allowed_updates: ["message", "channel_post"],
        drop_pending_updates: true,
        onStart: (info) => {
          this.botId = info.id;
          this.botUsername = info.username;
          console.log(`telegram channel listening as @${info.username ?? info.first_name}`);
        }
      })
      .catch((error) => {
        console.error(`telegram channel stopped: ${error instanceof Error ? error.message : String(error)}`);
        if (!this.stopRequested && isTelegramGetUpdatesConflict(error)) {
          console.error("telegram channel retrying in 5s after getUpdates conflict");
          this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            this.startPolling();
          }, 5000);
        }
      })
      .finally(() => {
        if (this.startTask === task) this.startTask = undefined;
      });
    this.startTask = task;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (!this.startTask) return;
    await this.bot.stop().catch(() => undefined);
    await this.startTask.catch(() => undefined);
    this.startTask = undefined;
  }

  username(): string | undefined {
    return this.botUsername;
  }

  private async handleTelegramMessage(message: Message, source: TelegramSource): Promise<void> {
    const text = telegramText(message);
    if (!text) return;

    if (message.from?.id && this.botId && message.from.id === this.botId) return;

    const inboundKey = telegramMessageKey(message.chat.id, message.message_id);
    if (this.sentMessageKeys.delete(inboundKey)) return;

    console.log(
      `telegram ${source} received chat=${message.chat.id} message=${message.message_id} chars=${text.length}`
    );

    try {
      const linkCode = parseTelegramLinkCode(text);
      if (linkCode) {
        await this.linkChat(message, linkCode, source);
        return;
      }

      const route = this.options.catalog.telegramWorkspaceForChat(String(message.chat.id));
      if (!route) {
        await this.sendText(
          message.chat.id,
          "This Telegram chat is not linked yet. Open Agent Mom settings, create a Telegram link code, then send /link <code> here.",
          source === "message" ? message.message_id : undefined
        );
        return;
      }

      const { bridge } = await this.options.runtimes.get(route.workspace);
      const before = await bridge.snapshot();

      if (source === "message") {
        await this.bot.api.sendChatAction(message.chat.id, "typing").catch(() => undefined);
      }

      const state = await bridge.sendMessage(text);
      const reply = assistantReplyFromState(before, state);
      await this.sendText(message.chat.id, reply, source === "message" ? message.message_id : undefined);
      console.log(`telegram reply sent chat=${message.chat.id} chars=${reply.length}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`telegram message failed: ${detail}`);
      await this.sendText(message.chat.id, `Agent Mom error: ${detail}`, source === "message" ? message.message_id : undefined);
    }
  }

  private async linkChat(message: Message, code: string, source: TelegramSource): Promise<void> {
    const result = this.options.catalog.linkTelegramChat({
      code,
      chatId: String(message.chat.id),
      chatType: telegramChatType(message),
      title: telegramChatTitle(message),
      username: telegramUsername(message.chat),
      telegramUserId: message.from?.id != null ? String(message.from.id) : undefined,
      telegramUsername: message.from?.username
    });

    await this.sendText(
      message.chat.id,
      `Linked this Telegram chat to ${result.workspace.displayName}.`,
      source === "message" ? message.message_id : undefined
    );
    console.log(`telegram linked chat=${message.chat.id} workspace=${result.workspace.id}`);
  }

  private async sendText(chatId: number | string, text: string, replyToMessageId?: number): Promise<void> {
    for (const chunk of chunkTelegramText(text)) {
      const sent = await this.bot.api.sendMessage(chatId, chunk, {
        ...(replyToMessageId
          ? {
              reply_parameters: {
                message_id: replyToMessageId,
                allow_sending_without_reply: true
              }
            }
          : {})
      });
      this.rememberSentMessage(telegramMessageKey(sent.chat.id, sent.message_id));
    }
  }

  private rememberSentMessage(key: string): void {
    this.sentMessageKeys.add(key);
    this.sentMessageOrder.push(key);
    while (this.sentMessageOrder.length > 200) {
      const old = this.sentMessageOrder.shift();
      if (old) this.sentMessageKeys.delete(old);
    }
  }

  private logBotError(error: unknown): void {
    if (error instanceof GrammyError) {
      console.error(`telegram API error ${error.error_code}: ${error.description}`);
      return;
    }
    if (error instanceof HttpError) {
      console.error(`telegram HTTP error: ${error.message}`);
      return;
    }
    console.error(`telegram error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assistantReplyFromState(before: AppState, after: AppState): string {
  const beforeIds = new Set(before.messages.map((message) => message.id));
  return (
    lastAssistant(after.messages, (message) => !beforeIds.has(message.id)) ??
    lastAssistant(after.messages, () => true) ??
    "No text response."
  );
}

function lastAssistant(messages: ChatMessage[], predicate: (message: ChatMessage) => boolean): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.status === "running" || !predicate(message)) continue;
    const content = message.content.trim();
    if (content && content !== "[tool call]") return content;
  }
  return undefined;
}

export function chunkTelegramText(text: string, maxChars = 3900): string[] {
  let remaining = text.trim() || "No text response.";
  const chunks: string[] = [];

  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars / 2) cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < maxChars / 2) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < 1) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  chunks.push(remaining);
  return chunks;
}

function telegramText(message: Message): string {
  return "text" in message && typeof message.text === "string" ? message.text.trim() : "";
}

function parseTelegramLinkCode(text: string): string | undefined {
  const match = /^\/(?:link|start)(?:@[A-Za-z0-9_]+)?\s+(\S+)/i.exec(text.trim());
  return match?.[1];
}

function telegramChatType(message: Message): TelegramChatType {
  const type = message.chat.type;
  return type === "group" || type === "supergroup" || type === "channel" ? type : "private";
}

function telegramChatTitle(message: Message): string | undefined {
  const chat = message.chat as {
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  return chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username);
}

function telegramUsername(chat: Message["chat"]): string | undefined {
  return "username" in chat && typeof chat.username === "string" ? chat.username : undefined;
}

function telegramMessageKey(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function isTelegramGetUpdatesConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("getUpdates") && message.includes("409");
}
