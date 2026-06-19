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
  ExternalLink,
  FileJson,
  GitBranch,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Send,
  SquarePen,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppState, ChatMessage, DeploymentRecord, PreviewService, SessionSummary } from "../src/types.js";
import { DeployPane } from "./DeployPane.js";
import "./styles.css";

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

type RightPanelTab = {
  id: string;
  type: "preview" | "deploy" | "events";
  title: string;
};

const initialRightTabs: RightPanelTab[] = [
  { id: "preview-1", type: "preview", title: "Preview" },
  { id: "deploy-1", type: "deploy", title: "Deploy" },
  { id: "events-1", type: "events", title: "Events" }
];

function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [error, setError] = useState<string | undefined>();
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | undefined>();
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightTabs, setRightTabs] = useState<RightPanelTab[]>(initialRightTabs);
  const [activeRightTabId, setActiveRightTabId] = useState(initialRightTabs[0].id);
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [deployLog, setDeployLog] = useState("");
  const [deployError, setDeployError] = useState<string | undefined>();
  const [resumeTestRunning, setResumeTestRunning] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state");
    const next = (await response.json()) as AppState;
    setState(next);
  }, []);

  const refreshDeployments = useCallback(async () => {
    const response = await fetch("/api/deployments");
    const payload = (await response.json()) as { deployments: DeploymentRecord[] };
    setDeployments(payload.deployments);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(readError(err)));
    void refreshDeployments().catch((err) => setDeployError(readError(err)));

    const events = new EventSource("/api/events");
    events.addEventListener("state", (event) => {
      setState(JSON.parse((event as MessageEvent).data) as AppState);
      setError(undefined);
    });
    events.onerror = () => setError("Event stream disconnected. Refresh or restart the dev server.");
    return () => events.close();
  }, [refresh, refreshDeployments]);

  const messages = useMemo(() => state.messages.map(toThreadMessage), [state.messages]);
  const selectedPreview = useMemo(
    () => state.previews.find((preview) => preview.id === selectedPreviewId) ?? state.previews[0],
    [selectedPreviewId, state.previews]
  );
  const activeRightTab = rightTabs.find((tab) => tab.id === activeRightTabId) ?? rightTabs[0];

  useEffect(() => {
    if (state.previews.length === 0) {
      setSelectedPreviewId(undefined);
      return;
    }
    if (!selectedPreviewId || !state.previews.some((preview) => preview.id === selectedPreviewId)) {
      setSelectedPreviewId(state.previews[0].id);
    }
  }, [selectedPreviewId, state.previews]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: state.isRunning,
    convertMessage: (message) => message,
    onNew: async (message) => {
      const content = appendMessageText(message);
      if (!content.trim()) return;
      setError(undefined);
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      if (!response.ok) throw new Error(await response.text());
      setState((await response.json()) as AppState);
    },
    onCancel: async () => {
      const response = await fetch("/api/cancel", { method: "POST" });
      if (response.ok) setState((await response.json()) as AppState);
    }
  });

  async function newSession() {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new: true })
    });
    setState((await response.json()) as AppState);
  }

  async function openSession(session: SessionSummary) {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: session.path })
    });
    setState((await response.json()) as AppState);
  }

  async function removePreview(preview: PreviewService) {
    const response = await fetch(`/api/previews/${encodeURIComponent(preview.id)}`, { method: "DELETE" });
    setState((await response.json()) as AppState);
  }

  async function testRuntimeResume() {
    setResumeTestRunning(true);
    setError(undefined);
    try {
      const response = await fetch("/api/runtime/resume-test", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setState((await response.json()) as AppState);
    } catch (err) {
      setError(readError(err));
    } finally {
      setResumeTestRunning(false);
    }
  }

  function addRightTab(type: RightPanelTab["type"]) {
    const title = type === "preview" ? "Preview" : type === "deploy" ? "Deploy" : "Events";
    const id = `${type}-${Date.now().toString(36)}`;
    const tab = { id, type, title };
    setRightTabs((tabs) => [...tabs, tab]);
    setActiveRightTabId(id);
    setRightPanelOpen(true);
    setNewTabMenuOpen(false);
  }

  function closeRightTab(tabId: string) {
    if (rightTabs.length <= 1) {
      setRightPanelOpen(false);
      return;
    }

    const index = rightTabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = rightTabs.filter((tab) => tab.id !== tabId);
    setRightTabs(nextTabs);
    if (activeRightTabId === tabId) {
      setActiveRightTabId(nextTabs[Math.max(0, index - 1)]?.id ?? nextTabs[0].id);
    }
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">G2</div>
            <div>
              <h1>Agent Granny 2</h1>
              <p>Pi-backed local coding loop</p>
            </div>
          </div>

          <div className="workspace-block">
            <span>Workspace</span>
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
            <button type="button" onClick={() => void refresh()}>
              <RefreshCw size={16} />
              <span>Refresh</span>
            </button>
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
            <StatusItem label="model" value={state.model || "loading"} />
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

            {rightPanelOpen && (
              <aside className="right-panel">
                <div className="right-tabbar">
                  <div className="right-tabs" role="tablist" aria-label="Right panel tabs">
                    {rightTabs.map((tab) => (
                      <div
                        className={tab.id === activeRightTab?.id ? "right-tab active" : "right-tab"}
                        key={tab.id}
                      >
                        <button
                          type="button"
                          className="right-tab-select"
                          onClick={() => setActiveRightTabId(tab.id)}
                          role="tab"
                          aria-selected={tab.id === activeRightTab?.id}
                        >
                          {tab.type === "events" ? (
                            <FileJson size={14} />
                          ) : tab.type === "deploy" ? (
                            <Rocket size={14} />
                          ) : (
                            <Monitor size={14} />
                          )}
                          <span>{tab.title}</span>
                          <span className="right-tab-count">
                            {tab.type === "events"
                              ? state.events.length
                              : tab.type === "deploy"
                                ? deployments.length
                                : state.previews.length}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="right-tab-close"
                          title="Close tab"
                          onClick={() => closeRightTab(tab.id)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="right-tab-actions">
                    <button
                      type="button"
                      className="panel-icon-button"
                      onClick={() => setNewTabMenuOpen((open) => !open)}
                      title="New tab"
                    >
                      <Plus size={16} />
                    </button>
                    {newTabMenuOpen && (
                      <div className="new-tab-menu">
                        <button type="button" onClick={() => addRightTab("preview")}>
                          <Monitor size={14} />
                          <span>Preview</span>
                        </button>
                        <button type="button" onClick={() => addRightTab("deploy")}>
                          <Rocket size={14} />
                          <span>Deploy</span>
                        </button>
                        <button type="button" onClick={() => addRightTab("events")}>
                          <FileJson size={14} />
                          <span>Events</span>
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="panel-icon-button"
                      onClick={() => setRightPanelOpen(false)}
                      title="Collapse panel"
                    >
                      <PanelRightClose size={16} />
                    </button>
                  </div>
                </div>

                <div className="right-panel-body">
                  {activeRightTab?.type === "events" ? (
                    <EventLog events={state.events} />
                  ) : activeRightTab?.type === "deploy" ? (
                    <DeployPane
                      deployments={deployments}
                      error={deployError}
                      log={deployLog}
                      onPublish={async (input) => {
                        setDeployError(undefined);
                        setDeployLog("");
                        const response = await fetch("/api/deployments", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(input)
                        });
                        const payload = await response.json();
                        if (!response.ok) {
                          await refreshDeployments();
                          throw new Error(payload.error ?? JSON.stringify(payload));
                        }
                        await refreshDeployments();
                      }}
                      onDelete={async (deployment) => {
                        setDeployError(undefined);
                        const response = await fetch(`/api/deployments/${encodeURIComponent(deployment.slug)}`, {
                          method: "DELETE"
                        });
                        const payload = await response.json();
                        if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
                        setDeployments(payload.deployments ?? []);
                        setDeployLog("");
                      }}
                      onLogs={async (deployment) => {
                        setDeployError(undefined);
                        const response = await fetch(`/api/deployments/${encodeURIComponent(deployment.slug)}/logs`);
                        const payload = await response.json();
                        if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
                        setDeployLog(payload.logs ?? "");
                      }}
                      onError={setDeployError}
                    />
                  ) : (
                    <PreviewPane
                      previews={state.previews}
                      selectedPreview={selectedPreview}
                      previewRefreshKey={previewRefreshKey}
                      onSelectPreview={setSelectedPreviewId}
                      onRefreshPreview={() => setPreviewRefreshKey((key) => key + 1)}
                      onRemovePreview={removePreview}
                    />
                  )}
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}

function PreviewPane({
  previews,
  selectedPreview,
  previewRefreshKey,
  onSelectPreview,
  onRefreshPreview,
  onRemovePreview
}: {
  previews: PreviewService[];
  selectedPreview: PreviewService | undefined;
  previewRefreshKey: number;
  onSelectPreview: (id: string) => void;
  onRefreshPreview: () => void;
  onRemovePreview: (preview: PreviewService) => Promise<void>;
}) {
  return (
    <section className="preview-pane">
      <div className="pane-toolbar">
        <div className="preview-tabs">
          {previews.length === 0 ? (
            <span className="preview-placeholder">No exposed services.</span>
          ) : (
            previews.map((preview) => (
              <button
                type="button"
                className={preview.id === selectedPreview?.id ? "preview-tab active" : "preview-tab"}
                key={preview.id}
                onClick={() => onSelectPreview(preview.id)}
                title={`${preview.name} :${preview.port}`}
              >
                <span>{preview.name}</span>
                <small>:{preview.port}</small>
              </button>
            ))
          )}
        </div>
        <div className="pane-actions">
          <button type="button" className="panel-icon-button" onClick={onRefreshPreview} disabled={!selectedPreview} title="Refresh preview">
            <RefreshCw size={15} />
          </button>
          {selectedPreview && (
            <a className="panel-icon-button" href={selectedPreview.path} target="_blank" rel="noreferrer" title="Open preview">
              <ExternalLink size={15} />
            </a>
          )}
          {selectedPreview && (
            <button type="button" className="panel-icon-button" onClick={() => void onRemovePreview(selectedPreview)} title="Remove preview">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {previews.length === 0 ? (
        <div className="preview-empty">
          <Monitor size={22} />
          <span>No exposed services.</span>
        </div>
      ) : (
        selectedPreview && (
          <iframe
            className="preview-frame"
            key={`${selectedPreview.id}-${previewRefreshKey}`}
            src={selectedPreview.path}
            title={`Preview ${selectedPreview.name}`}
          />
        )
      )}
    </section>
  );
}

function EventLog({ events }: { events: AppState["events"] }) {
  return (
    <section className="event-log-pane">
      {events.length === 0 ? (
        <p className="muted">No events.</p>
      ) : (
        events.map((event) => (
          <article className={event.isError ? "json-event error" : "json-event"} key={event.id}>
            <div>
              <strong>{event.title}</strong>
              <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
            </div>
            <pre>{JSON.stringify(event, null, 2)}</pre>
          </article>
        ))
      )}
    </section>
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

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
