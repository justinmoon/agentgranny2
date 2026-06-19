import { Bot, GrammyError, HttpError } from "grammy";
import type { Message } from "grammy/types";
import type { CatalogWorkspace } from "./catalog.js";
import type { AppState, ChatMessage } from "./types.js";
import type { WorkspaceRuntimeManager } from "./workspace-runtime.js";

type TelegramSource = "message" | "channel_post";

export type TelegramChannelOptions = {
  token: string;
  workspace: CatalogWorkspace;
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

  private async handleTelegramMessage(message: Message, source: TelegramSource): Promise<void> {
    const text = telegramText(message);
    if (!text) return;

    if (message.from?.id && this.botId && message.from.id === this.botId) return;

    const inboundKey = telegramMessageKey(message.chat.id, message.message_id);
    if (this.sentMessageKeys.delete(inboundKey)) return;

    console.log(
      `telegram ${source} received chat=${message.chat.id} message=${message.message_id} chars=${text.length}`
    );

    const { bridge } = await this.options.runtimes.get(this.options.workspace);
    const before = await bridge.snapshot();

    try {
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
      await this.sendText(message.chat.id, `Agent Granny error: ${detail}`, source === "message" ? message.message_id : undefined);
    }
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

function telegramMessageKey(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function isTelegramGetUpdatesConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("getUpdates") && message.includes("409");
}
