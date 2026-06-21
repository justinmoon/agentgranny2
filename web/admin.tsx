import { Check, Copy, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { MeState, PublicAdminUser, PublicInvite } from "../src/types.js";
import { readError, readJsonResponse } from "./http.js";

export function AdminPage({
  authEnabled,
  me,
  onLogout
}: {
  authEnabled: boolean;
  me: MeState;
  onLogout: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<"access" | "users">("access");
  const [accessCode, setAccessCode] = useState<PublicInvite | undefined>();
  const [users, setUsers] = useState<PublicAdminUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savingUserId, setSavingUserId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const loadAccessCode = useCallback(async () => {
    const response = await fetch("/api/admin/access-code");
    const payload = (await readJsonResponse(response)) as { accessCode: PublicInvite; error?: string };
    if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
    setAccessCode(payload.accessCode);
  }, []);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/admin/users");
    const payload = (await readJsonResponse(response)) as { users: PublicAdminUser[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
    setUsers(payload.users);
  }, []);

  useEffect(() => {
    if (me.user.role !== "admin") return;
    void Promise.all([loadAccessCode(), loadUsers()]).catch((err) => setError(readError(err)));
  }, [loadAccessCode, loadUsers, me.user.role]);

  // Keep the user list fresh so new sign-ups appear without a manual reload.
  useEffect(() => {
    if (me.user.role !== "admin") return;
    const id = window.setInterval(() => {
      void loadUsers().catch(() => {});
    }, 8000);
    return () => window.clearInterval(id);
  }, [loadUsers, me.user.role]);

  async function regenerate() {
    if (!window.confirm("Generate a new access code? The current code will stop working immediately.")) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/admin/access-code/regenerate", { method: "POST" });
      const payload = (await readJsonResponse(response)) as { accessCode: PublicInvite; error?: string };
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      setAccessCode(payload.accessCode);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(userId: string, role: string) {
    setSavingUserId(userId);
    setError(undefined);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role })
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error ?? JSON.stringify(payload));
      await loadUsers();
    } catch (err) {
      setError(readError(err));
    } finally {
      setSavingUserId(undefined);
    }
  }

  async function copyCode() {
    if (!accessCode) return;
    try {
      await navigator.clipboard.writeText(accessCode.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  if (me.user.role !== "admin") {
    return (
      <main className="admin-shell">
        <header className="admin-header">
          <div className="brand">
            <div className="brand-mark">AM</div>
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
          <div className="brand-mark">AM</div>
          <div>
            <h1>Admin</h1>
            <p>{me.user.email}</p>
          </div>
        </div>
        <div className="admin-header-actions">
          <button
            type="button"
            className="admin-link-button"
            onClick={() => void Promise.all([loadUsers(), loadAccessCode()]).catch((err) => setError(readError(err)))}
            title="Refresh"
          >
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
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
            className={activeTab === "access" ? "active" : ""}
            onClick={() => setActiveTab("access")}
            role="tab"
            aria-selected={activeTab === "access"}
          >
            Access code
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

        {activeTab === "access" ? (
          <div className="admin-tab-body">
            <div className="access-card">
              <div className="access-card-head">
                <div>
                  <strong>Weekly access code</strong>
                  <small>
                    Anyone with this code can create an account. Regenerate it at each meetup — the previous
                    code stops working immediately.
                  </small>
                </div>
              </div>

              <button
                type="button"
                className="access-code-value"
                onClick={() => void copyCode()}
                title="Click to copy"
              >
                <span>{accessCode?.code ?? "…"}</span>
                {copied ? <Check size={18} /> : <Copy size={16} />}
              </button>

              <div className="access-card-foot">
                <small>
                  {accessCode
                    ? `Generated ${new Date(accessCode.createdAt * 1000).toLocaleString()} · used ${accessCode.usedCount} ${accessCode.usedCount === 1 ? "time" : "times"}`
                    : "Loading…"}
                </small>
                <button type="button" className="settings-primary-button" onClick={() => void regenerate()} disabled={busy}>
                  <RotateCcw size={16} />
                  <span>{busy ? "Regenerating…" : "Regenerate code"}</span>
                </button>
              </div>
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
                      {user.id === me.user.id ? (
                        <span>{user.role} (you)</span>
                      ) : (
                        <select
                          className="role-select"
                          value={user.role}
                          disabled={savingUserId === user.id}
                          onChange={(event) => void changeRole(user.id, event.target.value)}
                          title="Change this user's role"
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </select>
                      )}
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
