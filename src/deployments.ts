import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { type DeploymentRouteMode, slugify } from "./deployment-routing.js";
import { allocatePort, runCommand, sleep, truncateLog } from "./process-utils.js";
import type { DeploymentRecord } from "./types.js";
import type { PreviewFetchRequest, PreviewFetchResponse } from "./previews.js";
import {
  cleanResponseHeaders,
  rewriteRootRelativeText,
  shouldRewriteText,
  textResponse
} from "./proxy-utils.js";

type DeploymentState = {
  deployments: DeploymentRecord[];
};

export type DeploymentScope = {
  workspaceId?: string;
  workspaceDirName?: string;
};

export type PublishDeploymentInput = {
  path: string;
  slug?: string;
  port?: number;
  workspaceId?: string;
  workspaceDirName?: string;
};

export class DeploymentManager {
  private readonly statePath: string;
  private readonly deploymentDir: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly config: AppConfig) {
    this.deploymentDir = this.config.deploymentDir;
    this.statePath = join(this.deploymentDir, "deployments.json");
    mkdirSync(this.deploymentDir, { recursive: true });
  }

  async list(scope: DeploymentScope = {}): Promise<DeploymentRecord[]> {
    const deployments = await Promise.all(this.readState().deployments.map((entry) => this.reconcile(entry)));
    return deployments
      .filter((deployment) => this.matchesScope(deployment, scope))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async publish(input: PublishDeploymentInput): Promise<DeploymentRecord> {
    const projectPath = this.resolveProjectPath(input.path);
    const dockerfile = join(projectPath, "Dockerfile");
    if (!existsSync(dockerfile)) {
      throw new Error(`Dockerfile not found in ${projectPath}. Ask the agent to add one, then publish again.`);
    }

    const slug = slugify(input.slug || basename(projectPath));
    if (!slug) throw new Error("Deployment slug is required");

    const containerPort = input.port ?? 3000;
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw new Error(`Invalid container port: ${input.port}`);
    }

    return this.withLock(slug, () =>
      this.publishUnlocked({
        projectPath,
        slug,
        containerPort,
        displayName: input.slug?.trim() || basename(projectPath),
        workspaceId: input.workspaceId,
        workspaceDirName: input.workspaceDirName
      })
    );
  }

  private async publishUnlocked(input: {
    projectPath: string;
    slug: string;
    containerPort: number;
    displayName: string;
    workspaceId?: string;
    workspaceDirName?: string;
  }): Promise<DeploymentRecord> {
    const now = new Date().toISOString();
    let existing = await this.find(input.slug);
    if (existing && input.workspaceId && !existing.workspaceId) {
      if (this.matchesScope(existing, { workspaceId: input.workspaceId, workspaceDirName: input.workspaceDirName })) {
        existing = { ...existing, workspaceId: input.workspaceId };
      } else if (existing.status === "running") {
        throw new Error(`Deployment slug is already used by a legacy deployment: ${input.slug}`);
      } else {
        await this.removeContainerAndImage(existing);
        this.deleteRecord(existing.slug);
        existing = undefined;
      }
    }
    if (!this.matchesScope(existing, { workspaceId: input.workspaceId, workspaceDirName: input.workspaceDirName })) {
      throw new Error(`Deployment slug is already used by another workspace: ${input.slug}`);
    }
    const hostPort = await allocatePort();
    const version = Date.now().toString(36);
    const image = `localhost/agentmom/${input.slug}:${version}`;
    const container = `agentmom-${input.slug}-${version}`;

    let deployment: DeploymentRecord = {
      id: existing?.id ?? input.slug,
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.displayName,
      projectPath: input.projectPath,
      image,
      container,
      containerPort: input.containerPort,
      hostPort,
      urlPath: `/deploy/${input.slug}/`,
      status: "building",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastDeployAt: now
    };
    if (existing?.status !== "running") {
      this.upsert(deployment);
    }

    try {
      const build = await runCommand(this.config.podman.command, ["build", "-t", image, "."], { cwd: input.projectPath });
      deployment = {
        ...deployment,
        buildLog: truncateLog(build.output),
        updatedAt: new Date().toISOString()
      };
      if (existing?.status !== "running") {
        this.upsert(deployment);
      }

      const run = await runCommand(this.config.podman.command, [
        "run",
        "-d",
        "--name",
        container,
        "--log-driver",
        "k8s-file",
        "--label",
        `agentmom.deployment=${input.slug}`,
        "--label",
        `agentmom.version=${version}`,
        "-e",
        `PORT=${input.containerPort}`,
        "-p",
        `127.0.0.1:${hostPort}:${input.containerPort}`,
        image
      ]);
      await this.waitUntilReady(hostPort, container);

      deployment = {
        ...deployment,
        status: "running",
        error: undefined,
        buildLog: truncateLog(`${deployment.buildLog ?? ""}\n${run.output}`.trim()),
        updatedAt: new Date().toISOString()
      };
      deployment = this.decorate(deployment);
      this.upsert(deployment);
      await this.removeContainerAndImage(existing);
      return deployment;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.removeContainerAndImage({ container, image });
      if (existing?.status === "running") {
        this.upsert({
          ...existing,
          error: message,
          updatedAt: new Date().toISOString()
        });
      } else {
        deployment = {
          ...deployment,
          status: "failed",
          error: message,
          updatedAt: new Date().toISOString()
        };
        this.upsert(deployment);
      }
      throw error;
    }
  }

  async remove(slug: string, scope: DeploymentScope = {}): Promise<boolean> {
    return this.withLock(slug, async () => {
      const deployment = await this.find(slug, scope);
      if (!deployment) return false;
      await this.removeContainerAndImage(deployment);
      const state = this.readState();
      state.deployments = state.deployments.filter((entry) => entry.slug !== slug);
      this.writeState(state);
      return true;
    });
  }

  async logs(slug: string, tail = 200, scope: DeploymentScope = {}): Promise<string> {
    const deployment = await this.find(slug, scope);
    if (!deployment) throw new Error(`Unknown deployment: ${slug}`);
    if (deployment.status !== "running") {
      return [deployment.error, deployment.buildLog].filter(Boolean).join("\n").trim();
    }
    const result = await runCommand(
      this.config.podman.command,
      ["logs", "--tail", String(Math.max(1, Math.min(tail, 1000))), deployment.container],
      { allowFailure: true }
    );
    return result.output.trim();
  }

  async fetch(
    slug: string,
    request: PreviewFetchRequest,
    mode: DeploymentRouteMode = "path"
  ): Promise<PreviewFetchResponse> {
    const deployment = await this.find(slug);
    if (!deployment) {
      return textResponse(404, `Unknown deployment: ${slug}`);
    }
    if (deployment.status !== "running") {
      return textResponse(503, `Deployment is ${deployment.status}`);
    }

    const body =
      request.body && request.method !== "GET" && request.method !== "HEAD"
        ? (new Uint8Array(request.body) as BodyInit)
        : undefined;

    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${deployment.hostPort}${request.path}`, {
        method: request.method,
        headers: request.headers,
        body,
        redirect: "manual"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResponse(502, `Deployment proxy failed: ${message}`);
    }

    return rewriteDeploymentResponse(
      deployment,
      {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer())
      },
      mode
    );
  }

  private async find(slug: string, scope: DeploymentScope = {}): Promise<DeploymentRecord | undefined> {
    const deployment = this.readState().deployments.find((entry) => entry.slug === slug);
    if (!deployment || !this.matchesScope(deployment, scope)) return undefined;
    return this.reconcile(deployment);
  }

  private matchesScope(deployment: DeploymentRecord | undefined, scope: DeploymentScope): boolean {
    if (!deployment) return true;
    if (!scope.workspaceId) return true;
    if (deployment.workspaceId) return deployment.workspaceId === scope.workspaceId;
    if (!scope.workspaceDirName) return false;
    return this.projectPathBelongsToWorkspaceDir(deployment.projectPath, scope.workspaceDirName);
  }

  private upsert(deployment: DeploymentRecord): void {
    const state = this.readState();
    state.deployments = [this.decorate(deployment), ...state.deployments.filter((entry) => entry.slug !== deployment.slug)];
    this.writeState(state);
  }

  private deleteRecord(slug: string): void {
    const state = this.readState();
    state.deployments = state.deployments.filter((entry) => entry.slug !== slug);
    this.writeState(state);
  }

  private decorate(deployment: DeploymentRecord): DeploymentRecord {
    const baseDomain = this.config.deploymentBaseDomain;
    const urlHost = baseDomain ? `${deployment.slug}.${baseDomain}` : undefined;
    return {
      ...deployment,
      urlPath: `/deploy/${deployment.slug}/`,
      urlHost,
      url: urlHost ? `https://${urlHost}/` : `/deploy/${deployment.slug}/`
    };
  }

  private async reconcile(deployment: DeploymentRecord): Promise<DeploymentRecord> {
    const decorated = this.decorate(deployment);
    if (decorated.status !== "running") return decorated;

    const running = await this.containerIsRunning(decorated.container);
    if (running) return decorated;

    const stopped: DeploymentRecord = {
      ...decorated,
      status: "stopped",
      error: "Container is not running",
      updatedAt: new Date().toISOString()
    };
    this.upsert(stopped);
    return stopped;
  }

  private async containerIsRunning(container: string): Promise<boolean> {
    const result = await runCommand(
      this.config.podman.command,
      ["container", "inspect", "--format", "{{.State.Running}}", container],
      { allowFailure: true }
    );
    return result.exitCode === 0 && result.output.trim() === "true";
  }

  private async waitUntilReady(hostPort: number, container: string): Promise<void> {
    const timeoutMs = Number.parseInt(process.env.AGENTMOM_DEPLOYMENT_READY_TIMEOUT_MS ?? "30000", 10);
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 30_000);
    let lastError = "no response yet";

    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(`http://127.0.0.1:${hostPort}/`, {
          method: "GET",
          signal: controller.signal
        });
        await response.arrayBuffer();
        if (response.status < 500) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
      }
      await sleep(250);
    }

    const logs = await runCommand(this.config.podman.command, ["logs", "--tail", "80", container], { allowFailure: true });
    throw new Error(
      `Deployment did not become ready on 127.0.0.1:${hostPort}: ${lastError}\n${truncateLog(logs.output.trim(), 4000)}`
    );
  }

  private resolveProjectPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    if (!trimmed) throw new Error("Deployment path is required");
    const projectPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(this.config.agentCwd, trimmed);
    if (this.pathIsInside(projectPath, this.config.projectsDir) || this.pathIsInsideWorkspaceProjects(projectPath)) {
      return projectPath;
    }
    throw new Error("Deployment path must be inside a workspace projects directory");
  }

  private readState(): DeploymentState {
    if (!existsSync(this.statePath)) return { deployments: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as DeploymentState;
      return { deployments: Array.isArray(parsed.deployments) ? parsed.deployments : [] };
    } catch {
      return { deployments: [] };
    }
  }

  private projectPathBelongsToWorkspaceDir(projectPath: string, workspaceDirName: string): boolean {
    const projectsDir = resolve(this.config.workspaceRoot, workspaceDirName, "projects");
    return this.pathIsInside(projectPath, projectsDir);
  }

  private pathIsInside(path: string, root: string): boolean {
    const pathRelative = relative(resolve(root), resolve(path));
    return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
  }

  private pathIsInsideWorkspaceProjects(projectPath: string): boolean {
    const projectRelative = relative(resolve(this.config.workspaceRoot), resolve(projectPath));
    if (!projectRelative || projectRelative.startsWith("..") || isAbsolute(projectRelative)) return false;

    const [, directory] = projectRelative.split(/[\\/]+/);
    return directory === "projects";
  }

  private writeState(state: DeploymentState): void {
    mkdirSync(this.deploymentDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.statePath);
  }

  private async removeContainerAndImage(target: { container?: string; image?: string } | undefined): Promise<void> {
    if (!target) return;
    if (target.container) {
      await runCommand(this.config.podman.command, ["rm", "-f", target.container], { allowFailure: true });
    }
    if (target.image) {
      await runCommand(this.config.podman.command, ["rmi", "-f", target.image], { allowFailure: true });
    }
  }

  private async withLock<T>(slug: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(slug) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const lock = previous.catch(() => undefined).then(() => next);
    this.locks.set(slug, lock);

    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(slug) === lock) {
        this.locks.delete(slug);
      }
    }
  }
}

function rewriteDeploymentResponse(
  deployment: DeploymentRecord,
  response: PreviewFetchResponse,
  mode: DeploymentRouteMode
): PreviewFetchResponse {
  const headers = cleanResponseHeaders(response.headers, { stripSetCookie: true });
  rewriteLocationHeader(headers, deployment, mode);
  const contentType = headers["content-type"] ?? "";
  if (mode !== "path" || !shouldRewriteText(contentType)) {
    return { ...response, headers };
  }

  const body = Buffer.from(
    rewriteRootRelativeText(response.body.toString("utf8"), `/deploy/${deployment.slug}/`, contentType),
    "utf8"
  );
  headers["content-length"] = String(body.byteLength);
  return {
    status: response.status,
    headers,
    body
  };
}

function rewriteLocationHeader(
  headers: Record<string, string>,
  deployment: DeploymentRecord,
  mode: DeploymentRouteMode
): void {
  const location = headers.location;
  if (!location) return;

  const prefix = mode === "path" ? `/deploy/${deployment.slug}` : "";
  if (location.startsWith("/")) {
    headers.location = mode === "path" ? `${prefix}${location}` : location;
    return;
  }

  try {
    const url = new URL(location);
    if (url.hostname === "127.0.0.1" && url.port === String(deployment.hostPort)) {
      headers.location =
        mode === "path" || !deployment.urlHost
          ? `${prefix}${url.pathname}${url.search}${url.hash}`
          : `https://${deployment.urlHost}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Relative redirects like "next" are already relative to /deploy/<slug>/.
  }
}
