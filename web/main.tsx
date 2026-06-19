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
  LogOut,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  SquarePen,
  Terminal,
  Trash2,
  UserPlus,
  X
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AppState,
  ChatMessage,
  MeState,
  PreviewService,
  PublicAdminUser,
  PublicInvite,
  PublicWorkspace,
  SessionSummary
} from "../src/types.js";
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
  type: "preview" | "events";
  title: string;
};

const initialRightTabs: RightPanelTab[] = [
  { id: "preview-1", type: "preview", title: "Preview" },
  { id: "events-1", type: "events", title: "Events" }
];

function App() {
  const [me, setMe] = useState<MeState | undefined>();
  const [authChecked, setAuthChecked] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [state, setState] = useState<AppState>(emptyState);
  const [error, setError] = useState<string | undefined>();
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | undefined>();
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightTabs, setRightTabs] = useState<RightPanelTab[]>(initialRightTabs);
  const [activeRightTabId, setActiveRightTabId] = useState(initialRightTabs[0].id);
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [resumeTestRunning, setResumeTestRunning] = useState(false);
  const isAdminPage = window.location.pathname === "/admin";

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
    if (!response.ok) throw new Error(await response.text());
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
    if (isAdminPage || !selectedWorkspace?.id) return;
    void refresh().catch((err) => setError(readError(err)));

    const events = new EventSource(workspaceUrl("/events"));
    events.addEventListener("state", (event) => {
      setState(JSON.parse((event as MessageEvent).data) as AppState);
      setError(undefined);
    });
    events.onerror = () => setError("Event stream disconnected. Refresh or restart the dev server.");
    return () => events.close();
  }, [isAdminPage, refresh, selectedWorkspace?.id, workspaceUrl]);

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
      const response = await fetch(workspaceUrl("/messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      if (!response.ok) throw new Error(await response.text());
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
      if (!response.ok) throw new Error(await response.text());
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

  function addRightTab(type: RightPanelTab["type"]) {
    const title = type === "preview" ? "Preview" : "Events";
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

  if (!authChecked) {
    return <LoadingScreen text="Loading Agent Granny 2" />;
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">G2</div>
            <div>
              <h1>Agent Granny 2</h1>
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
                          ) : (
                            <Monitor size={14} />
                          )}
                          <span>{tab.title}</span>
                          <span className="right-tab-count">
                            {tab.type === "events" ? state.events.length : state.previews.length}
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

function AuthScreen({
  onAuth,
  onAuthEnabled
}: {
  onAuth: (me: MeState) => void;
  onAuthEnabled: (enabled: boolean) => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName, password, inviteCode })
      });
      const payload = await response.json();
      onAuthEnabled(Boolean(payload.authEnabled));
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      onAuth(payload as MeState);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <div className="brand auth-brand">
          <div className="brand-mark">G2</div>
          <div>
            <h1>Agent Granny 2</h1>
            <p>{mode === "login" ? "Sign in" : "Create account"}</p>
          </div>
        </div>
        {mode === "signup" && (
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Full name" />
        )}
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" />
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          type="password"
        />
        {mode === "signup" && (
          <input
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            placeholder="Invite code"
          />
        )}
        {error && <div className="form-error">{error}</div>}
        <button type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? "Working" : mode === "login" ? "Log in" : "Sign up"}
        </button>
        <button
          type="button"
          className="auth-switch"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(undefined);
          }}
        >
          {mode === "login" ? "Need an account?" : "Have an account?"}
        </button>
      </form>
    </main>
  );
}

function AdminPage({
  authEnabled,
  me,
  onLogout
}: {
  authEnabled: boolean;
  me: MeState;
  onLogout: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<"invites" | "users">("invites");
  const [invites, setInvites] = useState<PublicInvite[]>([]);
  const [users, setUsers] = useState<PublicAdminUser[]>([]);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const loadInvites = useCallback(async () => {
    const response = await fetch("/api/admin/invites");
    const payload = (await readJsonResponse(response)) as { invites: PublicInvite[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
    setInvites(payload.invites);
  }, []);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/admin/users");
    const payload = (await readJsonResponse(response)) as { users: PublicAdminUser[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
    setUsers(payload.users);
  }, []);

  useEffect(() => {
    if (me.user.role !== "admin") return;
    void Promise.all([loadInvites(), loadUsers()]).catch((err) => setError(readError(err)));
  }, [loadInvites, loadUsers, me.user.role]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, role })
      });
      const payload = (await readJsonResponse(response)) as { invite: PublicInvite; code: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      setLabel("");
      await loadInvites();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function disableInvite(invite: PublicInvite) {
    setError(undefined);
    const response = await fetch(`/api/admin/invites/${encodeURIComponent(invite.id)}/disable`, { method: "POST" });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      setError(payload.error ?? JSON.stringify(payload));
      return;
    }
    await loadInvites();
  }

  if (me.user.role !== "admin") {
    return (
      <main className="admin-shell">
        <header className="admin-header">
          <div className="brand">
            <div className="brand-mark">G2</div>
            <div>
              <h1>Admin</h1>
              <p>Admin access required</p>
            </div>
          </div>
          <a className="admin-link-button" href="/">
            Back to app
          </a>
        </header>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="brand">
          <div className="brand-mark">G2</div>
          <div>
            <h1>Admin</h1>
            <p>{me.user.email}</p>
          </div>
        </div>
        <div className="admin-header-actions">
          <a className="admin-link-button" href="/">
            Back to app
          </a>
          {authEnabled && (
            <button type="button" className="admin-link-button" onClick={() => void onLogout()}>
              Logout
            </button>
          )}
        </div>
      </header>

      <section className="admin-panel">
        <div className="admin-tabs" role="tablist" aria-label="Admin tabs">
          <button
            type="button"
            className={activeTab === "invites" ? "active" : ""}
            onClick={() => setActiveTab("invites")}
            role="tab"
            aria-selected={activeTab === "invites"}
          >
            Invites
          </button>
          <button
            type="button"
            className={activeTab === "users" ? "active" : ""}
            onClick={() => setActiveTab("users")}
            role="tab"
            aria-selected={activeTab === "users"}
          >
            Users
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        {activeTab === "invites" ? (
          <div className="admin-tab-body">
            <form className="admin-create-form" onSubmit={(event) => void submit(event)}>
              <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label" />
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button type="submit" disabled={busy}>
                <UserPlus size={16} />
                <span>{busy ? "Creating" : "Create"}</span>
              </button>
            </form>

            <div className="admin-list">
              {invites.length === 0 ? (
                <p className="muted">No invites yet.</p>
              ) : (
                invites.map((invite) => (
                  <article className="admin-row invite-admin-row" key={invite.id}>
                    <div>
                      <strong>{invite.label}</strong>
                      <code>{invite.code}</code>
                      <small>
                        {invite.role} · used {invite.usedCount} · {invite.active ? "active" : "disabled"}
                      </small>
                    </div>
                    {invite.active && (
                      <button type="button" onClick={() => void disableInvite(invite)} title="Disable invite">
                        <X size={16} />
                      </button>
                    )}
                  </article>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="admin-tab-body">
            <div className="admin-list">
              {users.length === 0 ? (
                <p className="muted">No users yet.</p>
              ) : (
                users.map((user) => (
                  <article className="admin-row user-admin-row" key={user.id}>
                    <div>
                      <strong>{user.fullName}</strong>
                      <span>{user.email}</span>
                    </div>
                    <div>
                      <span>{user.role}</span>
                      <small>{user.workspace?.displayName ?? "No workspace"}</small>
                    </div>
                    <div>
                      <span>{user.invite ? user.invite.label : "First/admin seed"}</span>
                      <small>{user.invite?.code ?? "No invite"}</small>
                    </div>
                    <time dateTime={new Date(user.createdAt * 1000).toISOString()}>
                      {new Date(user.createdAt * 1000).toLocaleDateString()}
                    </time>
                  </article>
                ))
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function LoadingScreen({ text, error, onRetry }: { text: string; error?: string; onRetry?: () => void }) {
  return (
    <main className="auth-shell">
      <div className="auth-form">
        <div className="brand auth-brand">
          <div className="brand-mark">G2</div>
          <div>
            <h1>Agent Granny 2</h1>
            <p>{text}</p>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        {onRetry && (
          <button type="button" className="auth-switch" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </main>
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

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}, got: ${text.slice(0, 120)}`);
  }
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
