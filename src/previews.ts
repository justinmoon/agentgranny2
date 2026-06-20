import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { posix as pathPosix } from "node:path";
import type { AppConfig } from "./config.js";
import type { PreviewService } from "./types.js";

export const PREVIEW_SENTINEL = "__AGENTMOM_EXPOSE__";
export const DEPLOY_SENTINEL = "__AGENTMOM_DEPLOY__";

export type PreviewFetchRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
};

export type PreviewFetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

type RegisterPreviewInput = {
  port: number;
  name: string;
};

export type PreviewRegistration = RegisterPreviewInput & {
  name: string;
};

export type DeploymentRegistration = {
  cwd: string;
  slug: string;
  port: number;
};

type GuestFetcher = (port: number, request: PreviewFetchRequest) => Promise<PreviewFetchResponse>;

export class PreviewManager {
  private services = new Map<string, PreviewService>();
  private guestFetcher?: GuestFetcher;

  constructor(private readonly config: AppConfig) {}

  setGuestFetcher(fetcher: GuestFetcher): void {
    this.guestFetcher = fetcher;
  }

  list(): PreviewService[] {
    return [...this.services.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  register(input: RegisterPreviewInput): PreviewService {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new Error(`Invalid preview port: ${input.port}`);
    }
    const name = input.name.trim();
    if (!name) {
      throw new Error("Preview name is required");
    }

    const now = new Date().toISOString();
    const id = `port-${input.port}`;
    const existing = this.services.get(id);
    const service: PreviewService = {
      id,
      name,
      port: input.port,
      runtime: this.config.executor,
      path: `${this.config.previewBasePath}/${id}/`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.services.set(id, service);
    return service;
  }

  remove(id: string): boolean {
    return this.services.delete(id);
  }

  async fetch(id: string, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
    const service = this.services.get(id);
    if (!service) {
      return textResponse(404, `Unknown preview: ${id}`);
    }

    const response =
      service.runtime === "smolvm"
        ? await this.fetchGuest(service, request)
        : await fetchLocal(service, request);

    return rewritePreviewResponse(service, response);
  }

  parseSentinelOutput(output: string): PreviewRegistration[] {
    const registrations: PreviewRegistration[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.startsWith(PREVIEW_SENTINEL)) continue;
      registrations.push(JSON.parse(line.slice(PREVIEW_SENTINEL.length)) as PreviewRegistration);
    }
    return registrations;
  }

  parseDeploymentOutput(output: string): DeploymentRegistration[] {
    const registrations: DeploymentRegistration[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.startsWith(DEPLOY_SENTINEL)) continue;
      registrations.push(JSON.parse(line.slice(DEPLOY_SENTINEL.length)) as DeploymentRegistration);
    }
    return registrations;
  }

  cliInstall(): { hostBinDir: string; guestBinDir: string } {
    const hostBinDir = join(this.config.projectsDir, ".agentmom", "bin");
    const hostCliPath = join(hostBinDir, "mom");
    mkdirSync(hostBinDir, { recursive: true });
    writeFileSync(hostCliPath, previewCliSource(), "utf8");
    chmodSync(hostCliPath, 0o755);

    const guestBinDir =
      this.config.executor === "smolvm"
        ? pathPosix.join(this.config.smolvm.guestWorkspace, ".agentmom", "bin")
        : hostBinDir;

    return { hostBinDir, guestBinDir };
  }

  private async fetchGuest(service: PreviewService, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
    if (!this.guestFetcher) {
      return textResponse(502, "Preview guest fetcher is not ready");
    }
    return this.guestFetcher(service.port, request);
  }
}

export function previewPath(pathname: string): { id: string; upstreamPath: string } | undefined {
  const prefix = "/preview/";
  if (!pathname.startsWith(prefix)) return undefined;

  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return { id: rest, upstreamPath: "/" };
  }

  const id = rest.slice(0, slash);
  const upstreamPath = `/${rest.slice(slash + 1)}`;
  return { id, upstreamPath };
}

export function requestHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (name === "host" || name === "content-length") continue;
    result[name] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
  }
  result["accept-encoding"] = "identity";
  return result;
}

async function fetchLocal(service: PreviewService, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
  const body =
    request.body && request.method !== "GET" && request.method !== "HEAD"
      ? (new Uint8Array(request.body) as BodyInit)
      : undefined;

  const response = await fetch(`http://127.0.0.1:${service.port}${request.path}`, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: "manual"
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer())
  };
}

function rewritePreviewResponse(service: PreviewService, response: PreviewFetchResponse): PreviewFetchResponse {
  const headers = cleanResponseHeaders(response.headers);
  const contentType = headers["content-type"] ?? "";
  if (!shouldRewrite(contentType)) {
    return { ...response, headers };
  }

  const body = Buffer.from(rewriteText(response.body.toString("utf8"), service.path, contentType), "utf8");
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

function shouldRewrite(contentType: string): boolean {
  return (
    contentType.includes("text/html") ||
    contentType.includes("text/css") ||
    contentType.includes("javascript") ||
    contentType.includes("ecmascript")
  );
}

function rewriteText(content: string, previewPath: string, contentType: string): string {
  const prefix = previewPath;
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

function previewCliSource(): string {
  return `#!/usr/bin/env node
const previewSentinel = ${JSON.stringify(PREVIEW_SENTINEL)};
const deploySentinel = ${JSON.stringify(DEPLOY_SENTINEL)};
const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail("Usage:\\n  mom expose <port> <name>\\n  mom deploy --cwd <absolute-path> --port <port> --slug <slug>");
}

function parsePort(value) {
  const port = Number.parseInt(value || "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage();
  return port;
}

function readRequiredOption(name) {
  const prefix = "--" + name + "=";
  const equalsArg = args.find((arg) => arg.startsWith(prefix));
  if (equalsArg) return equalsArg.slice(prefix.length).trim();

  const index = args.indexOf("--" + name);
  if (index === -1 || index + 1 >= args.length) usage();
  const value = args[index + 1].trim();
  if (!value || value.startsWith("--")) usage();
  return value;
}

function assertNoUnexpectedDeployArgs() {
  const allowed = new Set(["--cwd", "--port", "--slug"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--cwd=") || arg.startsWith("--port=") || arg.startsWith("--slug=")) continue;
    if (!allowed.has(arg)) usage();
    index += 1;
  }
}

if (command === "expose") {
  const port = parsePort(args[0]);
  const name = args.slice(1).join(" ").trim();
  if (!name) usage();

  console.log(previewSentinel + JSON.stringify({ port, name }));
  console.log("Preview exposed: " + name + " on port " + port);
  process.exit(0);
}

if (command === "deploy") {
  assertNoUnexpectedDeployArgs();
  const cwd = readRequiredOption("cwd");
  const slug = readRequiredOption("slug");
  const port = parsePort(readRequiredOption("port"));
  if (!cwd.startsWith("/")) fail("mom deploy requires --cwd to be an absolute path");
  if (!slug) usage();

  console.log(deploySentinel + JSON.stringify({ cwd, slug, port }));
  console.log("Deployment requested: " + slug + " from " + cwd + " on port " + port);
  process.exit(0);
}

usage();
`;
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
