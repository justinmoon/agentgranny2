import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { DeploymentRecord } from "./types.js";
import type { PreviewFetchRequest, PreviewFetchResponse } from "./previews.js";

type DeploymentState = {
  deployments: DeploymentRecord[];
};

export type PublishDeploymentInput = {
  path: string;
  slug?: string;
  port?: number;
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

  list(): DeploymentRecord[] {
    return this.readState().deployments.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
        displayName: input.slug?.trim() || basename(projectPath)
      })
    );
  }

  private async publishUnlocked(input: {
    projectPath: string;
    slug: string;
    containerPort: number;
    displayName: string;
  }): Promise<DeploymentRecord> {
    const now = new Date().toISOString();
    const existing = this.find(input.slug);
    const hostPort = await allocatePort();
    const version = Date.now().toString(36);
    const image = `localhost/agentgranny2/${input.slug}:${version}`;
    const container = `agentgranny2-${input.slug}-${version}`;

    let deployment: DeploymentRecord = {
      id: existing?.id ?? input.slug,
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
        "--label",
        `agentgranny2.deployment=${input.slug}`,
        "--label",
        `agentgranny2.version=${version}`,
        "-e",
        `PORT=${input.containerPort}`,
        "-p",
        `127.0.0.1:${hostPort}:${input.containerPort}`,
        image
      ]);

      deployment = {
        ...deployment,
        status: "running",
        error: undefined,
        buildLog: truncateLog(`${deployment.buildLog ?? ""}\n${run.output}`.trim()),
        updatedAt: new Date().toISOString()
      };
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

  async remove(slug: string): Promise<boolean> {
    return this.withLock(slug, async () => {
      const deployment = this.find(slug);
      if (!deployment) return false;
      await this.removeContainerAndImage(deployment);
      const state = this.readState();
      state.deployments = state.deployments.filter((entry) => entry.slug !== slug);
      this.writeState(state);
      return true;
    });
  }

  async logs(slug: string, tail = 200): Promise<string> {
    const deployment = this.find(slug);
    if (!deployment) throw new Error(`Unknown deployment: ${slug}`);
    const result = await runCommand(
      this.config.podman.command,
      ["logs", "--tail", String(Math.max(1, Math.min(tail, 1000))), deployment.container],
      { allowFailure: true }
    );
    return result.output.trim();
  }

  async fetch(slug: string, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
    const deployment = this.find(slug);
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

    return rewriteDeploymentResponse(deployment, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer())
    });
  }

  private find(slug: string): DeploymentRecord | undefined {
    return this.readState().deployments.find((deployment) => deployment.slug === slug);
  }

  private upsert(deployment: DeploymentRecord): void {
    const state = this.readState();
    state.deployments = [deployment, ...state.deployments.filter((entry) => entry.slug !== deployment.slug)];
    this.writeState(state);
  }

  private resolveProjectPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    if (!trimmed) throw new Error("Deployment path is required");
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(this.config.agentCwd, trimmed);
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

export function deploymentPath(pathname: string): { slug: string; upstreamPath: string } | undefined {
  const prefix = "/deploy/";
  if (!pathname.startsWith(prefix)) return undefined;

  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return { slug: rest, upstreamPath: "/" };
  }

  const slug = rest.slice(0, slash);
  const upstreamPath = `/${rest.slice(slash + 1)}`;
  return { slug, upstreamPath };
}

type CommandResult = {
  output: string;
};

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    allowFailure?: boolean;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const chunks: Buffer[] = [];

    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => chunks.push(data));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed (${exitCode}): ${truncateLog(output)}`));
        return;
      }
      resolvePromise({ output });
    });
  });
}

function allocatePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server: Server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePromise(address.port);
        else reject(new Error("Could not allocate host port"));
      });
    });
    server.on("error", reject);
  });
}

function rewriteDeploymentResponse(
  deployment: DeploymentRecord,
  response: PreviewFetchResponse
): PreviewFetchResponse {
  const headers = cleanResponseHeaders(response.headers);
  rewriteLocationHeader(headers, deployment);
  const contentType = headers["content-type"] ?? "";
  if (!shouldRewrite(contentType)) {
    return { ...response, headers };
  }

  const body = Buffer.from(rewriteText(response.body.toString("utf8"), deployment.slug, contentType), "utf8");
  headers["content-length"] = String(body.byteLength);
  return {
    status: response.status,
    headers,
    body
  };
}

function cleanResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (name === "content-encoding" || name === "content-length" || name === "transfer-encoding") continue;
    result[name] = value;
  }
  return result;
}

function rewriteLocationHeader(headers: Record<string, string>, deployment: DeploymentRecord): void {
  const location = headers.location;
  if (!location) return;

  const prefix = `/deploy/${deployment.slug}`;
  if (location.startsWith("/")) {
    headers.location = `${prefix}${location}`;
    return;
  }

  try {
    const url = new URL(location);
    if (url.hostname === "127.0.0.1" && url.port === String(deployment.hostPort)) {
      headers.location = `${prefix}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Relative redirects like "next" are already relative to /deploy/<slug>/.
  }
}

function shouldRewrite(contentType: string): boolean {
  return (
    contentType.includes("text/html") ||
    contentType.includes("text/css") ||
    contentType.includes("javascript") ||
    contentType.includes("ecmascript")
  );
}

function rewriteText(content: string, slug: string, contentType: string): string {
  const prefix = `/deploy/${slug}/`;
  let next = content
    .replace(/(\s(?:src|href|action|poster)=["'])\/(?!\/)/gi, `$1${prefix}`)
    .replace(/(url\(["']?)\/(?!\/)/gi, `$1${prefix}`);

  if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
    next = next
      .replace(/(\bfrom\s*["'])\/(?!\/)/g, `$1${prefix}`)
      .replace(/(\bimport\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}`)
      .replace(/(\bnew\s+URL\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}`);
  }

  return next;
}

function textResponse(status: number, text: string): PreviewFetchResponse {
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(text))
    },
    body: Buffer.from(text, "utf8")
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function truncateLog(value: string, max = 24000): string {
  return value.length > max ? `${value.slice(-max)}\n[truncated]` : value;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
