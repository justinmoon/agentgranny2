import { ExternalLink, RefreshCw, Rocket, Terminal, Trash2 } from "lucide-react";
import React, { useState } from "react";
import type { DeploymentRecord } from "../src/types.js";

export function DeployPane({
  deployments,
  error,
  log,
  onPublish,
  onDelete,
  onLogs,
  onError
}: {
  deployments: DeploymentRecord[];
  error: string | undefined;
  log: string;
  onPublish: (input: { path: string; slug?: string; port?: number }) => Promise<void>;
  onDelete: (deployment: DeploymentRecord) => Promise<void>;
  onLogs: (deployment: DeploymentRecord) => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const [path, setPath] = useState("");
  const [slug, setSlug] = useState("");
  const [port, setPort] = useState("3000");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError(undefined);
    try {
      await onPublish({
        path,
        slug: slug.trim() || undefined,
        port: port.trim() ? Number.parseInt(port, 10) : undefined
      });
    } catch (err) {
      onError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function redeploy(deployment: DeploymentRecord) {
    setBusy(true);
    onError(undefined);
    try {
      await onPublish({
        path: deployment.projectPath,
        slug: deployment.slug,
        port: deployment.containerPort
      });
    } catch (err) {
      onError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(deployment: DeploymentRecord) {
    setBusy(true);
    onError(undefined);
    try {
      await onDelete(deployment);
    } catch (err) {
      onError(readError(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadLogs(deployment: DeploymentRecord) {
    onError(undefined);
    try {
      await onLogs(deployment);
    } catch (err) {
      onError(readError(err));
    }
  }

  return (
    <section className="deploy-pane">
      <form className="deploy-form" onSubmit={(event) => void submit(event)}>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="Project folder, e.g. knicks-site"
        />
        <input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="Slug" />
        <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder="Port" />
        <button type="submit" disabled={busy || !path.trim()}>
          <Rocket size={15} />
          <span>{busy ? "Working" : "Publish"}</span>
        </button>
      </form>

      {error && <div className="deploy-error">{error}</div>}

      <div className="deployment-list">
        {deployments.length === 0 ? (
          <div className="deploy-empty">
            <Rocket size={22} />
            <span>No deployments yet.</span>
          </div>
        ) : (
          deployments.map((deployment) => (
            <article className="deployment-card" key={deployment.slug}>
              <div className="deployment-card-main">
                <div>
                  <strong>{deployment.name}</strong>
                  <span>{deployment.status}</span>
                </div>
                <code title={deployment.projectPath}>{deployment.projectPath}</code>
                <small>
                  {deployment.slug} · {deployment.hostPort}:{deployment.containerPort}
                </small>
              </div>
              <div className="deployment-actions">
                <a className="panel-icon-button" href={deployment.urlPath} target="_blank" rel="noreferrer" title="Open deployment">
                  <ExternalLink size={15} />
                </a>
                <button
                  type="button"
                  className="panel-icon-button"
                  onClick={() => void redeploy(deployment)}
                  disabled={busy}
                  title="Redeploy"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  type="button"
                  className="panel-icon-button"
                  onClick={() => void loadLogs(deployment)}
                  disabled={busy}
                  title="Logs"
                >
                  <Terminal size={14} />
                </button>
                <button
                  type="button"
                  className="panel-icon-button"
                  onClick={() => void remove(deployment)}
                  disabled={busy}
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {deployment.error && <pre className="deployment-error">{deployment.error}</pre>}
            </article>
          ))
        )}
      </div>

      <pre className="deploy-log">{log || "Deployment logs appear here."}</pre>
    </section>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
