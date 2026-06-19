import { mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createBashToolDefinition,
  createLocalBashOperations,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type BashOperations,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config.js";
import {
  PREVIEW_SENTINEL,
  PreviewManager,
  type PreviewFetchRequest,
  type PreviewFetchResponse,
  type PreviewRegistration
} from "./previews.js";
import { SmolvmRuntime } from "./smolvm.js";
import type { AppState, ChatMessage, SessionSummary, UiEvent } from "./types.js";

type PiMessage = UserMessage | AssistantMessage;
type StateListener = (state: AppState) => void;

const ACTIVE_TOOLS = ["read", "bash", "edit", "write"];

export class PiBridge {
  private session?: AgentSession;
  private sessionManager?: SessionManager;
  private unsubscribe?: () => void;
  private isRunning = false;
  private lastError: string | undefined;
  private liveMessages = new Map<string, ChatMessage>();
  private events: UiEvent[] = [];
  private listeners = new Set<StateListener>();
  private smolvm?: SmolvmRuntime;
  private previewProcesses = new Map<string, ChildProcess>();

  constructor(
    private readonly config: AppConfig,
    private readonly previews: PreviewManager
  ) {
    this.previews.setGuestFetcher((port, request) => this.fetchPreviewFromGuest(port, request));
  }

  async init(): Promise<void> {
    await this.openSession({ kind: "continue" });
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshotSync());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async snapshot(): Promise<AppState> {
    return {
      ...this.snapshotSync(),
      sessions: await this.listSessions()
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    try {
      const sessions = await SessionManager.list(this.config.agentCwd, this.config.sessionDir);
      return sessions.map((session) => ({
        id: session.id,
        path: session.path,
        name: session.name,
        cwd: session.cwd,
        firstMessage: session.firstMessage,
        messageCount: session.messageCount,
        modified: session.modified.toISOString()
      }));
    } catch {
      return [];
    }
  }

  async openSession(request: { kind: "continue" | "new" | "open"; path?: string }): Promise<AppState> {
    this.disposeCurrentSession();
    this.lastError = undefined;
    this.liveMessages.clear();

    mkdirSync(this.config.agentDir, { recursive: true });
    mkdirSync(this.config.sessionDir, { recursive: true });
    mkdirSync(this.config.projectsDir, { recursive: true });
    mkdirSync(this.config.agentCwd, { recursive: true });
    const previewCli = this.previews.cliInstall();

    const authStorage = AuthStorage.create(join(this.config.agentDir, "auth.json"));
    if (this.config.openRouterApiKey) {
      authStorage.setRuntimeApiKey("openrouter", this.config.openRouterApiKey);
    }

    const modelRegistry = ModelRegistry.create(authStorage, join(this.config.agentDir, "models.json"));
    const model =
      modelRegistry.find("openrouter", this.config.openRouterModel) ??
      (getModel("openrouter", this.config.openRouterModel as never) as Model<any> | undefined);
    if (!model) {
      throw new Error(`OpenRouter model not found: ${this.config.openRouterModel}`);
    }

    const sessionManager =
      request.kind === "open" && request.path
        ? SessionManager.open(request.path, this.config.sessionDir, this.config.agentCwd)
        : request.kind === "new"
          ? SessionManager.create(this.config.agentCwd, this.config.sessionDir)
          : SessionManager.continueRecent(this.config.agentCwd, this.config.sessionDir);

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.config.agentCwd,
      agentDir: this.config.agentDir,
      appendSystemPromptOverride: (base) => [
        ...base,
        [
          "## Agent Granny Preview",
          "- To start a long-running HTTP dev server, use `granny serve <port> [name] -- <command>`.",
          "- If a server is already running, use `granny expose <port> [name]`.",
          "- Exposed services appear in the web preview panel."
        ].join("\n")
      ]
    });
    await resourceLoader.reload();

    const customTools = await this.prepareCustomTools(previewCli.guestBinDir);

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.config.agentCwd,
      agentDir: this.config.agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "minimal",
      sessionManager,
      resourceLoader,
      tools: ACTIVE_TOOLS,
      customTools
    });

    this.session = session;
    this.sessionManager = sessionManager;
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
    this.addEvent("session", request.kind === "new" ? "Started new session" : "Session ready", session.sessionFile);
    if (modelFallbackMessage) {
      this.addEvent("model", "Model fallback", modelFallbackMessage, true);
    }
    this.emit();
    return this.snapshot();
  }

  async sendMessage(content: string): Promise<AppState> {
    const text = content.trim();
    if (!text) return this.snapshot();
    if (!this.session) await this.init();
    if (!this.session) throw new Error("Pi session was not created");
    if (this.isRunning) throw new Error("A Pi turn is already running");

    this.isRunning = true;
    this.lastError = undefined;
    this.emit();

    try {
      await this.session.prompt(text);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.addEvent("error", "Turn failed", this.lastError, true);
      throw error;
    } finally {
      this.isRunning = false;
      this.liveMessages.clear();
      this.emit();
    }

    return this.snapshot();
  }

  async cancel(): Promise<AppState> {
    if (this.session && this.isRunning) {
      await this.session.abort();
      this.addEvent("cancel", "Stopped active turn");
    }
    this.isRunning = false;
    this.liveMessages.clear();
    this.emit();
    return this.snapshot();
  }

  listPreviews() {
    return this.previews.list();
  }

  registerPreview(port: number, name?: string): AppState {
    const service = this.previews.register({ port, name });
    this.addEvent("preview", "Preview exposed", `${service.name} ${service.path}`);
    this.emit();
    return this.snapshotSync();
  }

  removePreview(id: string): AppState {
    if (this.previews.remove(id)) {
      this.stopPreviewProcess(id);
      this.addEvent("preview", "Preview removed", id);
      this.emit();
    }
    return this.snapshotSync();
  }

  async fetchPreview(id: string, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
    return this.previews.fetch(id, request);
  }

  async testRuntimeResume(): Promise<AppState> {
    if (this.config.executor !== "smolvm") {
      this.addEvent("runtime", "Resume test unavailable", "Current executor is local", true);
      this.emit();
      return this.snapshot();
    }

    this.lastError = undefined;
    this.smolvm ??= new SmolvmRuntime(this.config);
    this.addEvent("runtime", "Resume test started", `Stopping and restarting ${this.config.smolvm.name}`);
    this.emit();

    try {
      const result = await this.smolvm.testResume();
      this.addEvent("runtime", "Resume test passed", stringifyCompact(result));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.addEvent("runtime", "Resume test failed", this.lastError, true);
    }

    this.emit();
    return this.snapshot();
  }

  dispose(): void {
    this.disposeCurrentSession();
    for (const id of [...this.previewProcesses.keys()]) {
      this.stopPreviewProcess(id);
    }
    void this.smolvm?.dispose();
    this.listeners.clear();
  }

  private disposeCurrentSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.sessionManager = undefined;
    this.isRunning = false;
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_start") {
      this.isRunning = true;
      this.addEvent("agent", "Turn started");
    } else if (event.type === "agent_end") {
      this.addEvent("agent", event.willRetry ? "Turn ended; retry pending" : "Turn ended");
    } else if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const message = event.message;
      if (message.role === "user" || message.role === "assistant") {
        const chat = toChatMessage(`live-${message.role}`, message, event.type === "message_update");
        this.liveMessages.set(chat.id, chat);
      }
    } else if (event.type === "tool_execution_start") {
      this.addEvent("tool", `${event.toolName} started`, stringifyCompact(event.args));
    } else if (event.type === "tool_execution_update") {
      this.addEvent("tool", `${event.toolName} update`, stringifyCompact(event.partialResult));
    } else if (event.type === "tool_execution_end") {
      this.addEvent(
        "tool",
        `${event.toolName} ${event.isError ? "failed" : "finished"}`,
        stringifyCompact(event.result),
        event.isError
      );
    } else if (event.type === "compaction_start") {
      this.addEvent("compaction", "Compaction started", event.reason);
    } else if (event.type === "compaction_end") {
      this.addEvent("compaction", event.aborted ? "Compaction aborted" : "Compaction ended", event.errorMessage);
    }

    this.emit();
  }

  private snapshotSync(): AppState {
    const session = this.session;
    const sessionManager = this.sessionManager;
    const persisted = sessionManager ? sessionMessages(sessionManager) : [];
    const messages = mergeLiveMessages(persisted, [...this.liveMessages.values()]);

    return {
      app: {
        commit: this.config.appCommit,
        sourceDir: this.config.rootDir
      },
      workspace: this.config.workspace,
      projectsDir: this.config.projectsDir,
      agentCwd: this.config.agentCwd,
      sessionDir: this.config.sessionDir,
      session: session
        ? {
            id: session.sessionId,
            path: session.sessionFile,
            name: session.sessionName,
            cwd: this.config.agentCwd
          }
        : undefined,
      sessions: [],
      previews: this.previews.list(),
      messages,
      events: this.events,
      isRunning: this.isRunning,
      model: `openrouter/${this.config.openRouterModel}`,
      tools: ACTIVE_TOOLS,
      error: this.lastError,
      runtime: {
        executor: this.config.executor,
        guestWorkspace: this.config.executor === "smolvm" ? this.config.smolvm.guestWorkspace : undefined,
        vm: this.smolvm?.snapshot()
          ? {
              name: this.smolvm.snapshot()!.name,
              state: this.smolvm.snapshot()!.state,
              pid: this.smolvm.snapshot()!.pid
            }
          : undefined
      }
    };
  }

  private emit(): void {
    const state = this.snapshotSync();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private async prepareCustomTools(guestBinDir: string): Promise<ToolDefinition[]> {
    let operations: BashOperations;

    if (this.config.executor === "smolvm") {
      this.smolvm ??= new SmolvmRuntime(this.config);
      this.addEvent("runtime", "Starting smolvm", this.config.smolvm.name);
      this.emit();
      await this.smolvm.ensureReady();
      this.addEvent("runtime", "smolvm ready", this.config.smolvm.name);
      operations = this.smolvm.createBashOperations();
    } else {
      operations = createLocalBashOperations();
    }

    return [
      createBashToolDefinition(this.config.agentCwd, {
        commandPrefix: `export PATH=${shellQuote(guestBinDir)}:$PATH`,
        operations: this.withPreviewRegistration(operations)
      }) as unknown as ToolDefinition
    ];
  }

  private withPreviewRegistration(operations: BashOperations): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        let pending = "";
        const registrationTasks: Promise<void>[] = [];

        const forward = (text: string) => {
          if (text) options.onData(Buffer.from(text, "utf8"));
        };

        const processLine = (line: string) => {
          const trimmed = line.replace(/\r?\n$/, "");
          if (!trimmed.startsWith(PREVIEW_SENTINEL)) {
            forward(line);
            return;
          }

          try {
            const registrations = this.previews.parseSentinelOutput(trimmed);
            for (const registration of registrations) {
              registrationTasks.push(this.handlePreviewRegistration(registration, cwd));
            }
          } catch (error) {
            this.addEvent("preview", "Preview registration failed", error instanceof Error ? error.message : String(error), true);
            this.emit();
          }
        };

        const onData = (data: Buffer) => {
          pending += data.toString("utf8");
          for (;;) {
            const newline = pending.indexOf("\n");
            if (newline === -1) break;
            const line = pending.slice(0, newline + 1);
            pending = pending.slice(newline + 1);
            processLine(line);
          }
        };

        try {
          return await operations.exec(command, cwd, {
            ...options,
            onData
          });
        } finally {
          if (pending) {
            processLine(pending);
            pending = "";
          }
          await Promise.all(registrationTasks);
        }
      }
    };
  }

  private async handlePreviewRegistration(registration: PreviewRegistration, cwd: string): Promise<void> {
    try {
      if (registration.command) {
        await this.startPreviewProcess(registration, cwd);
      }

      const service = this.previews.register(registration);
      this.addEvent(
        "preview",
        registration.command ? "Preview service started" : "Preview exposed",
        `${service.name} ${service.path}`
      );
      this.emit();
    } catch (error) {
      this.addEvent("preview", "Preview registration failed", error instanceof Error ? error.message : String(error), true);
      this.emit();
    }
  }

  private async startPreviewProcess(registration: PreviewRegistration, cwd: string): Promise<void> {
    if (!registration.command) return;
    const id = `port-${registration.port}`;
    this.stopPreviewProcess(id);

    const onData = (data: Buffer) => {
      const text = data.toString("utf8").trim();
      if (!text) return;
      this.addEvent("preview-log", registration.name ?? id, truncate(text, 1200));
      this.emit();
    };

    const child =
      this.config.executor === "smolvm"
        ? await this.startSmolvmPreviewProcess(registration.command, cwd, onData)
        : this.startLocalPreviewProcess(registration.command, cwd, onData);

    this.previewProcesses.set(id, child);
    child.on("close", (exitCode) => {
      if (this.previewProcesses.get(id) !== child) return;
      this.previewProcesses.delete(id);
      this.addEvent("preview", "Preview service exited", `${registration.name ?? id} exited ${exitCode ?? "unknown"}`);
      this.emit();
    });
  }

  private async startSmolvmPreviewProcess(
    command: string,
    cwd: string,
    onData: (data: Buffer) => void
  ): Promise<ChildProcess> {
    this.smolvm ??= new SmolvmRuntime(this.config);
    return this.smolvm.startProcess(command, cwd, onData);
  }

  private startLocalPreviewProcess(command: string, cwd: string, onData: (data: Buffer) => void): ChildProcess {
    const child = spawn("sh", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    return child;
  }

  private stopPreviewProcess(id: string): void {
    const child = this.previewProcesses.get(id);
    if (!child) return;
    child.kill("SIGTERM");
    this.previewProcesses.delete(id);
  }

  private async fetchPreviewFromGuest(port: number, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
    this.smolvm ??= new SmolvmRuntime(this.config);
    return this.smolvm.fetchHttp(port, request);
  }

  private addEvent(type: string, title: string, detail?: string, isError = false): void {
    this.events = [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type,
        title,
        detail,
        isError,
        createdAt: new Date().toISOString()
      },
      ...this.events
    ].slice(0, 100);
  }
}

function sessionMessages(sessionManager: SessionManager): ChatMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .flatMap((entry) => {
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") return [];
      return [toChatMessage(entry.id, message, false, entry.timestamp)];
    });
}

function mergeLiveMessages(persisted: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const result = [...persisted];
  for (const liveMessage of live) {
    const alreadyPersisted = result.some(
      (message) => message.role === liveMessage.role && message.content === liveMessage.content
    );
    if (!alreadyPersisted) result.push(liveMessage);
  }
  return result;
}

function toChatMessage(
  idPrefix: string,
  message: PiMessage,
  running: boolean,
  fallbackTimestamp?: string
): ChatMessage {
  const content = messageToText(message);
  const createdAt =
    typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : fallbackTimestamp ?? new Date().toISOString();

  return {
    id: `${idPrefix}-${message.role}-${createdAt}`,
    role: message.role,
    content: content || (message.role === "assistant" ? "[tool call]" : ""),
    createdAt,
    status: running ? "running" : message.role === "assistant" && message.stopReason === "error" ? "error" : "complete"
  };
}

function messageToText(message: PiMessage): string {
  if (message.role === "user") {
    return typeof message.content === "string" ? message.content : textParts(message.content);
  }

  const text = message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "toolCall") return `[${part.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return message.errorMessage ? `${text}\n${message.errorMessage}`.trim() : text;
}

function textParts(parts: Array<TextContent | ImageContent>): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .filter(Boolean)
    .join("\n");
}

function stringifyCompact(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
