import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  DEPLOY_SENTINEL,
  PREVIEW_SENTINEL,
  PreviewManager,
  type DeploymentRegistration,
  type PreviewFetchRequest,
  type PreviewFetchResponse,
  type PreviewRegistration
} from "./previews.js";
import type { DeploymentManager } from "./deployments.js";
import {
  attachmentImages,
  messagePromptText,
  saveMessageAttachments,
  userMessageAttachments
} from "./message-attachments.js";
import { SmolvmRuntime } from "./smolvm.js";
import { allocatePort } from "./process-utils.js";
import type { AppState, ChatMessage, MessageAttachment, SessionSummary, UiEvent } from "./types.js";
import { createWebSearchTool } from "./web-search.js";

type PiMessage = UserMessage | AssistantMessage;
type StateListener = (state: AppState) => void;
type SendMessageInput = string | { content: string; attachments?: MessageAttachment[] };

const ACTIVE_TOOLS = ["read", "bash", "edit", "write", "web_search"];

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
  private previewProcesses = new Set<ChildProcess>();
  private sessionSummaries: SessionSummary[] = [];
  private autoPreviewServers = new Map<string, HttpServer>();
  private autoServing = false;
  private lastTurnStartedAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly previews: PreviewManager,
    private readonly deployments?: DeploymentManager
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
    await this.refreshSessionSummaries();
    return this.snapshotSync();
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.refreshSessionSummaries();
  }

  private async refreshSessionSummaries(): Promise<SessionSummary[]> {
    try {
      const sessions = await SessionManager.list(this.config.agentCwd, this.config.sessionDir);
      this.sessionSummaries = sessions.map((session) => ({
        id: session.id,
        path: session.path,
        name: session.name,
        cwd: session.cwd,
        firstMessage: session.firstMessage,
        messageCount: session.messageCount,
        modified: session.modified.toISOString()
      }));
      return this.sessionSummaries;
    } catch {
      return this.sessionSummaries;
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
          "## Agent Mom Preview",
          "- IMPORTANT: As soon as you finish building anything that renders in a browser (a website, web app, or HTML page), automatically start a preview server with `mom serve` as your final step — do this on your own, without being asked, so the user can immediately see what they created.",
          "- For preview servers, run `mom serve <port> <name> -- <command>` from the project directory.",
          "- Example (framework app): `mom serve 8080 \"My App\" -- npm run dev -- --host 0.0.0.0`.",
          "- Example (static site with an index.html): `mom serve 8080 \"My Site\" -- python3 -m http.server 8080`.",
          "- Use `mom expose <port> <name>` only if a preview server is already running.",
          "- The preview name is required and should be human-readable.",
          "- Do not expose the parent workspace directory unless the user asked for a directory listing.",
          "",
          "## Agent Mom Deployments",
          "- When the user asks to deploy or publish, do it yourself with `mom deploy`.",
          "- The project must have a Dockerfile. Make it listen on `$PORT`.",
          "- In Dockerfiles, `EXPOSE` must be a literal port like `EXPOSE 3000`; do not write `EXPOSE $PORT`.",
          "- All deploy args are required: `mom deploy --cwd <absolute-project-path> --port <port> --slug <slug>`.",
          "- If you are in the project directory, use `mom deploy --cwd \"$PWD\" --port <port> --slug <slug>`.",
          "- Deployment service errors are returned in command output; fix the Dockerfile/app and rerun deploy."
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

  async sendMessage(input: SendMessageInput): Promise<AppState> {
    const text = (typeof input === "string" ? input : input.content).trim();
    const attachments = typeof input === "string" ? [] : input.attachments ?? [];
    if (!text && attachments.length === 0) return this.snapshot();
    if (!this.session) await this.init();
    if (!this.session) throw new Error("Pi session was not created");
    if (this.isRunning) throw new Error("A Pi turn is already running");

    const savedAttachments = saveMessageAttachments(this.config, attachments);
    const images = attachmentImages(savedAttachments);
    const promptText = messagePromptText(text, savedAttachments);

    this.isRunning = true;
    this.lastError = undefined;
    this.emit();

    try {
      await this.session.prompt(promptText, images.length > 0 ? { images } : undefined);
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

  registerPreview(port: number, name: string): AppState {
    const service = this.previews.register({ port, name });
    this.addEvent("preview", "Preview exposed", `${service.name} ${service.path}`);
    this.emit();
    return this.snapshotSync();
  }

  removePreview(id: string): AppState {
    if (this.previews.remove(id)) {
      this.closeAutoPreviewServer(id);
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
    } finally {
      const removed = this.previews.removeByRuntime("smolvm");
      if (removed.length > 0) {
        this.addEvent("preview", "Cleared smolvm previews", `${removed.length} preview process(es) were stopped by resume testing`);
      }
    }

    this.emit();
    return this.snapshot();
  }

  dispose(): void {
    this.disposeCurrentSession();
    void this.smolvm?.dispose();
    this.disposePreviewProcesses();
    this.disposeAutoPreviewServers();
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
      this.lastTurnStartedAt = Date.now();
      this.addEvent("agent", "Turn started");
    } else if (event.type === "agent_end") {
      this.addEvent("agent", event.willRetry ? "Turn ended; retry pending" : "Turn ended");
      if (!event.willRetry) void this.maybeAutoServePreview(this.lastTurnStartedAt);
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
      sessions: this.sessionSummaries,
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
      createWebSearchTool(this.config),
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
          if (!trimmed.startsWith(PREVIEW_SENTINEL) && !trimmed.startsWith(DEPLOY_SENTINEL)) {
            forward(line);
            return;
          }

          try {
            if (trimmed.startsWith(PREVIEW_SENTINEL)) {
              const registrations = this.previews.parseSentinelOutput(trimmed);
              for (const registration of registrations) {
                registrationTasks.push(this.handlePreviewRegistration(registration));
              }
              return;
            }

            const registrations = this.previews.parseDeploymentOutput(trimmed);
            for (const registration of registrations) {
              registrationTasks.push(this.handleDeploymentRegistration(registration, forward));
            }
          } catch (error) {
            this.addEvent("mom-cli", "Command registration failed", error instanceof Error ? error.message : String(error), true);
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

  private async handlePreviewRegistration(registration: PreviewRegistration): Promise<void> {
    try {
      await this.startPreviewProcess(registration);
      const service = this.previews.register(registration);
      this.addEvent("preview", "Preview exposed", `${service.name} ${service.path}`);
      this.emit();
    } catch (error) {
      this.addEvent("preview", "Preview registration failed", error instanceof Error ? error.message : String(error), true);
      this.emit();
    }
  }

  private async startPreviewProcess(registration: PreviewRegistration): Promise<void> {
    if (!registration.command) return;

    const cwd = this.resolveAgentPath(registration.cwd ?? this.config.agentCwd);
    if (this.config.executor === "smolvm") {
      this.smolvm ??= new SmolvmRuntime(this.config);
      await this.smolvm.startProcess(registration.command, cwd);
    } else {
      const child = spawn("sh", ["-lc", registration.command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      this.previewProcesses.add(child);
      child.on("close", () => this.previewProcesses.delete(child));
    }
    this.addEvent("preview", "Preview process started", `${registration.name} :${registration.port}`);
  }

  // After a turn, if the agent built a renderable site but didn't expose it,
  // serve it automatically so the preview opens on its own.
  private async maybeAutoServePreview(turnStartedAt: number): Promise<void> {
    if (this.autoServing) return;
    if (this.previews.list().length > 0) return;
    this.autoServing = true;
    try {
      const dir = this.findRenderableDir(turnStartedAt);
      if (!dir) return;
      const port = await allocatePort();
      const server = createStaticServer(dir);
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolvePromise());
      });
      const name = basename(dir) || "Preview";
      const service = this.previews.register({ port, name, runtime: "local" });
      this.autoPreviewServers.set(service.id, server);
      server.on("close", () => this.autoPreviewServers.delete(service.id));
      this.addEvent("preview", "Preview ready", `${name} is live — opening preview`);
      this.emit();
    } catch (error) {
      this.addEvent("preview", "Auto preview failed", error instanceof Error ? error.message : String(error), true);
      this.emit();
    } finally {
      this.autoServing = false;
    }
  }

  // Find the most recently built directory that has an index.html.
  private findRenderableDir(minModifiedAt: number): string | undefined {
    const root = this.resolveAgentPath(this.config.agentCwd);
    const candidates: string[] = [];
    if (isFreshStaticIndex(join(root, "index.html"), minModifiedAt)) candidates.push(root);
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const sub = join(root, entry.name);
        if (isFreshStaticIndex(join(sub, "index.html"), minModifiedAt)) candidates.push(sub);
      }
    } catch {
      // ignore unreadable directories
    }
    if (candidates.length === 0) return undefined;
    candidates.sort(
      (a, b) => statSync(join(b, "index.html")).mtimeMs - statSync(join(a, "index.html")).mtimeMs
    );
    return candidates[0];
  }

  private disposePreviewProcesses(): void {
    for (const child of this.previewProcesses) {
      child.kill("SIGTERM");
    }
    this.previewProcesses.clear();
  }

  private closeAutoPreviewServer(id: string): void {
    const server = this.autoPreviewServers.get(id);
    if (!server) return;
    this.autoPreviewServers.delete(id);
    server.close();
  }

  private disposeAutoPreviewServers(): void {
    for (const id of [...this.autoPreviewServers.keys()]) {
      this.closeAutoPreviewServer(id);
    }
  }

  private async handleDeploymentRegistration(
    registration: DeploymentRegistration,
    forward: (text: string) => void
  ): Promise<void> {
    try {
      if (!this.deployments) {
        throw new Error("Deployment service is not available");
      }

      const projectPath = this.resolveAgentPath(registration.cwd);
      const deployment = await this.deployments.publish({
        path: projectPath,
        slug: registration.slug,
        port: registration.port,
        workspaceId: this.config.workspaceId,
        workspaceDirName: this.config.workspaceDirName
      });
      const url = deployment.url ?? deployment.urlPath;
      this.addEvent("deployment", "Deployment published", `${deployment.slug} ${url}`);
      forward(`Deployment published: ${url}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addEvent("deployment", "Deployment failed", truncate(message, 4000), true);
      forward(`Deployment failed: ${message}\n`);
      throw error;
    } finally {
      this.emit();
    }
  }

  private resolveAgentPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) throw new Error("Path is required");

    if (this.config.executor === "smolvm") {
      const guestWorkspace = this.config.smolvm.guestWorkspace.replace(/\/+$/, "");
      if (trimmed === guestWorkspace || trimmed.startsWith(`${guestWorkspace}/`)) {
        const relativePath = trimmed.slice(guestWorkspace.length).replace(/^\/+/, "");
        return this.ensureProjectPath(resolve(this.config.projectsDir, relativePath));
      }
    }

    if (!isAbsolute(trimmed)) {
      throw new Error("Deployment path must be absolute");
    }
    return this.ensureProjectPath(resolve(trimmed));
  }

  private ensureProjectPath(path: string): string {
    const projectsDir = resolve(this.config.projectsDir);
    const projectRelative = relative(projectsDir, path);
    if (projectRelative === "" || (!projectRelative.startsWith("..") && !isAbsolute(projectRelative))) {
      return path;
    }
    throw new Error(`Deployment path must be inside ${projectsDir}`);
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
  const attachments = messageAttachments(message);
  const createdAt =
    typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : fallbackTimestamp ?? new Date().toISOString();

  return {
    id: `${idPrefix}-${message.role}-${createdAt}`,
    role: message.role,
    content: content || (message.role === "assistant" ? "[tool call]" : ""),
    attachments,
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
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function messageAttachments(message: PiMessage): MessageAttachment[] | undefined {
  return message.role === "user" ? userMessageAttachments(message) : undefined;
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

function isFreshStaticIndex(path: string, minModifiedAt: number): boolean {
  try {
    if (!existsSync(path) || statSync(path).mtimeMs < minModifiedAt - 1000) return false;
    const html = readFileSync(path, "utf8");
    return !/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/src\//i.test(html);
  } catch {
    return false;
  }
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

// Minimal static file server for auto-previewing a built site (no extra deps).
function createStaticServer(rootDir: string): HttpServer {
  const root = resolve(rootDir);
  return createHttpServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      let target = resolve(root, `.${pathname}`);
      if (target !== root && !target.startsWith(`${root}/`)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      if (existsSync(target) && statSync(target).isDirectory()) {
        target = join(target, "index.html");
      }
      if (!existsSync(target)) {
        // Single-page-app fallback to the root index.html
        const fallback = join(root, "index.html");
        if (existsSync(fallback)) {
          target = fallback;
        } else {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
      }
      const body = readFileSync(target);
      res.statusCode = 200;
      res.setHeader("Content-Type", STATIC_MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
      res.end(body);
    } catch {
      res.statusCode = 500;
      res.end("Preview error");
    }
  });
}
