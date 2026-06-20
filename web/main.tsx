import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike
} from "@assistant-ui/react";
import {
  CircleStop,
  GitBranch,
  LogOut,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  SquarePen,
  Terminal,
  UserPlus
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AppState,
  ChatMessage,
  MeState,
  PreviewService,
  SessionSummary
} from "../src/types.js";
import { AdminPage } from "./admin.js";
import { AuthScreen, LoadingScreen } from "./auth.js";
import { readError, readJsonResponse, readResponseError } from "./http.js";
import { RightPanel } from "./right-panel.js";
import { TelegramSettingsPage } from "./telegram-settings.js";
import "./pages.css";
import "./styles.css";
import "./thread.css";

const emptyState: AppState = {
  app: {
    sourceDir: ""
  },
  workspace: "",
  projectsDir: "",
  agentCwd: "",
  sessionDir: "",
  sessions: [],
  previews: [],
  messages: [],
  events: [],
  isRunning: false,
  model: "",
  tools: [],
  runtime: {
    executor: "local"
  }
};

function App() {
  const [me, setMe] = useState<MeState | undefined>();
  const [authChecked, setAuthChecked] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [state, setState] = useState<AppState>(emptyState);
  const [error, setError] = useState<string | undefined>();
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [resumeTestRunning, setResumeTestRunning] = useState(false);
  const isAdminPage = window.location.pathname === "/admin";
  const isTelegramSettingsPage = window.location.pathname === "/settings/telegram";

  const selectedWorkspace = useMemo(
    () => me?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? me?.workspace,
    [me, selectedWorkspaceId]
  );

  const loadMe = useCallback(async () => {
    const response = await fetch("/api/me");
    const payload = await readJsonResponse(response);
    setAuthEnabled(Boolean(payload.authEnabled));
    if (response.ok) {
      const next = payload as MeState;
      setMe(next);
      setSelectedWorkspaceId((current) => current ?? next.workspace.id);
    } else {
      setMe(undefined);
    }
    setAuthChecked(true);
  }, []);

  const workspaceUrl = useCallback(
    (path: string) => {
      if (!selectedWorkspace?.id) throw new Error("workspace is not loaded");
      return `/api/workspaces/${encodeURIComponent(selectedWorkspace.id)}${path}`;
    },
    [selectedWorkspace?.id]
  );

  const refresh = useCallback(async () => {
    if (!selectedWorkspace?.id) return;
    const response = await fetch(workspaceUrl("/state"));
    if (!response.ok) throw new Error(await readResponseError(response));
    setState((await response.json()) as AppState);
    setError(undefined);
  }, [selectedWorkspace?.id, workspaceUrl]);

  useEffect(() => {
    void loadMe().catch((err) => {
      setError(readError(err));
      setAuthChecked(true);
    });
  }, [loadMe]);

  useEffect(() => {
    if (isAdminPage || isTelegramSettingsPage || !selectedWorkspace?.id) return;
    let cancelled = false;
    let events: EventSource | undefined;

    void refresh()
      .then(() => {
        if (cancelled) return;
        events = new EventSource(workspaceUrl("/events"));
        events.addEventListener("state", (event) => {
          setState(JSON.parse((event as MessageEvent).data) as AppState);
          setError(undefined);
        });
        events.onerror = () => setError("Event stream disconnected. Refresh or restart the dev server.");
      })
      .catch((err) => {
        if (!cancelled) setError(readError(err));
      });

    return () => {
      cancelled = true;
      events?.close();
    };
  }, [isAdminPage, isTelegramSettingsPage, refresh, selectedWorkspace?.id, workspaceUrl]);

  const messages = useMemo(() => state.messages.map(toThreadMessage), [state.messages]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: state.isRunning,
    convertMessage: (message) => message,
    onNew: async (message) => {
      const content = appendMessageText(message);
      if (!content.trim()) return;
      setError(undefined);
      const response = await fetch(workspaceUrl("/messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      setState((await response.json()) as AppState);
    },
    onCancel: async () => {
      const response = await fetch(workspaceUrl("/cancel"), { method: "POST" });
      if (response.ok) setState((await response.json()) as AppState);
    }
  });

  async function newSession() {
    const response = await fetch(workspaceUrl("/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new: true })
    });
    setState((await response.json()) as AppState);
  }

  async function openSession(session: SessionSummary) {
    const response = await fetch(workspaceUrl("/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: session.path })
    });
    setState((await response.json()) as AppState);
  }

  async function removePreview(preview: PreviewService) {
    const response = await fetch(`${workspaceUrl("/previews")}/${encodeURIComponent(preview.id)}`, { method: "DELETE" });
    setState((await response.json()) as AppState);
  }

  async function testRuntimeResume() {
    setResumeTestRunning(true);
    setError(undefined);
    try {
      const response = await fetch(workspaceUrl("/runtime/resume-test"), { method: "POST" });
      if (!response.ok) throw new Error(await readResponseError(response));
      setState((await response.json()) as AppState);
    } catch (err) {
      setError(readError(err));
    } finally {
      setResumeTestRunning(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe(undefined);
    setState(emptyState);
    setSelectedWorkspaceId(undefined);
  }

  if (!authChecked) {
    return <LoadingScreen text="Loading Agent Mom" />;
  }

  if (authEnabled && !me) {
    return <AuthScreen onAuth={setMe} onAuthEnabled={setAuthEnabled} />;
  }

  if (!me || !selectedWorkspace) {
    return <LoadingScreen text="Preparing workspace" error={error} onRetry={() => void loadMe()} />;
  }

  if (isAdminPage) {
    return <AdminPage authEnabled={authEnabled} me={me} onLogout={logout} />;
  }

  if (isTelegramSettingsPage) {
    return <TelegramSettingsPage authEnabled={authEnabled} me={me} onLogout={logout} />;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">AM</div>
            <div>
              <h1>Agent Mom</h1>
              <p>{me.user.fullName}</p>
            </div>
          </div>

          <div className="workspace-block">
            <span>Workspace</span>
            {me.workspaces.length > 1 ? (
              <select value={selectedWorkspace.id} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
                {me.workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>
                    {workspace.displayName}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{selectedWorkspace.displayName}</strong>
            )}
            <code title={state.workspace}>{state.workspace || "loading"}</code>
          </div>

          <div className="workspace-block">
            <span>Agent cwd</span>
            <code title={state.agentCwd}>{state.agentCwd || "loading"}</code>
          </div>

          <div className="runtime-block">
            <span>Runtime</span>
            <strong>{state.runtime.executor}</strong>
            {state.runtime.vm && (
              <small title={state.runtime.vm.pid ? `pid ${state.runtime.vm.pid}` : undefined}>
                {state.runtime.vm.name} · {state.runtime.vm.state}
              </small>
            )}
            <button
              type="button"
              className="runtime-test-button"
              onClick={() => void testRuntimeResume()}
              disabled={state.runtime.executor !== "smolvm" || resumeTestRunning}
              title={
                state.runtime.executor === "smolvm"
                  ? "Stop the smolvm, resume it, and run a guest smoke command"
                  : "Resume test requires the smolvm executor"
              }
            >
              <RotateCcw size={14} />
              <span>{resumeTestRunning ? "Testing..." : "Test resume"}</span>
            </button>
          </div>

          <div className="actions">
            <button type="button" onClick={newSession}>
              <SquarePen size={16} />
              <span>New</span>
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
              <span>Refresh</span>
            </button>
            {authEnabled && (
              <button type="button" onClick={() => void logout()}>
                <LogOut size={16} />
                <span>Logout</span>
              </button>
            )}
            {me.user.role === "admin" && (
              <a className="action-link" href="/admin">
                <UserPlus size={16} />
                <span>Admin</span>
              </a>
            )}
            <a className="action-link" href="/settings/telegram">
              <MessageCircle size={16} />
              <span>Telegram</span>
            </a>
          </div>

          <section className="sessions">
            <h2>Sessions</h2>
            <div className="session-list">
              {state.sessions.length === 0 ? (
                <p className="muted">No persisted sessions yet.</p>
              ) : (
                state.sessions.map((session) => (
                  <button
                    type="button"
                    className={session.path === state.session?.path ? "session active" : "session"}
                    key={session.path ?? session.id}
                    onClick={() => void openSession(session)}
                  >
                    <GitBranch size={14} />
                    <span>{session.firstMessage || session.name || session.id}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <strong>{state.model || "loading model"}</strong>
              <span>{state.tools.join(", ")}</span>
            </div>
            <div className={state.isRunning ? "run-state running" : "run-state"}>
              {state.isRunning ? <Play size={14} /> : <Terminal size={14} />}
              <span>{state.isRunning ? "running" : "idle"}</span>
            </div>
            <button
              type="button"
              className="topbar-icon-button"
              onClick={() => setRightPanelOpen((open) => !open)}
              title={rightPanelOpen ? "Hide right panel" : "Show right panel"}
            >
              {rightPanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
          </header>

          <section className="status-strip" aria-label="Runtime status">
            <StatusItem label="commit" value={state.app.commit ?? "unknown"} />
            <StatusItem label="user" value={`${me.user.email} ${me.user.role}`} />
            <StatusItem label="executor" value={state.runtime.executor} />
            <StatusItem label="vm" value={state.runtime.vm ? `${state.runtime.vm.name} ${state.runtime.vm.state}` : "none"} />
            <StatusItem label="workspace" value={state.workspace || "loading"} title={state.workspace} />
            <StatusItem label="session" value={shortPath(state.session?.path) || "none"} title={state.session?.path} />
          </section>

          {(error || state.error) && <div className="error-line">{error ?? state.error}</div>}

          <div className={rightPanelOpen ? "content-grid" : "content-grid right-panel-closed"}>
            <section className="thread-panel">
              <ThreadPrimitive.Root className="thread-root">
                <ThreadPrimitive.Viewport className="thread-viewport">
                  <ThreadPrimitive.Empty>
                    <div className="empty-thread">
                      <h2>Ask Pi to work in this workspace.</h2>
                      <p>Messages go straight to Pi. Keep the loop simple and inspect what changes.</p>
                    </div>
                  </ThreadPrimitive.Empty>
                  <ThreadPrimitive.Messages>
                    {({ message }) => (
                      <MessagePrimitive.Root className={`message ${message.role}`}>
                        <div className="message-role">{message.role}</div>
                        <div className="message-body">
                          <MessagePrimitive.Content />
                        </div>
                      </MessagePrimitive.Root>
                    )}
                  </ThreadPrimitive.Messages>
                </ThreadPrimitive.Viewport>

                <ComposerPrimitive.Root className="composer">
                  <ComposerPrimitive.Input
                    autoFocus
                    className="composer-input"
                    placeholder="Ask for a code change, command, or explanation..."
                    submitMode="enter"
                  />
                  {state.isRunning ? (
                    <ComposerPrimitive.Cancel className="icon-button danger" title="Stop">
                      <CircleStop size={18} />
                    </ComposerPrimitive.Cancel>
                  ) : (
                    <ComposerPrimitive.Send className="icon-button primary" title="Send">
                      <Send size={18} />
                    </ComposerPrimitive.Send>
                  )}
                </ComposerPrimitive.Root>
              </ThreadPrimitive.Root>
            </section>

            <div className="right-panel-slot" hidden={!rightPanelOpen}>
              <RightPanel
                events={state.events}
                previews={state.previews}
                onCollapse={() => setRightPanelOpen(false)}
                onRemovePreview={removePreview}
              />
            </div>
          </div>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}

function StatusItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="status-item">
      <span>{label}</span>
      <strong title={title ?? value}>{value}</strong>
    </div>
  );
}

function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    status:
      message.role === "assistant"
        ? message.status === "running"
          ? { type: "running" }
          : message.status === "error"
            ? { type: "incomplete", reason: "error" }
            : { type: "complete", reason: "stop" }
        : undefined
  };
}

function appendMessageText(message: AppendMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function shortPath(path: string | undefined): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
