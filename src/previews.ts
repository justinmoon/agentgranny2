import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { posix as pathPosix } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.js";
import {
  cleanResponseHeaders,
  rewriteRootRelativeText,
  shouldRewriteText,
  textResponse,
  type ProxyFetchResponse
} from "./proxy-utils.js";
import type { PreviewService } from "./types.js";

type MomCliProtocol = {
  previewSentinel: string;
  deploySentinel: string;
};

const MOM_CLI_SOURCE = fileURLToPath(new URL("./mom-cli.cjs", import.meta.url));
const MOM_CLI_PROTOCOL_SOURCE = fileURLToPath(new URL("./mom-cli-protocol.json", import.meta.url));
const MOM_CLI_PROTOCOL = JSON.parse(readFileSync(MOM_CLI_PROTOCOL_SOURCE, "utf8")) as MomCliProtocol;
export const PREVIEW_SENTINEL = MOM_CLI_PROTOCOL.previewSentinel;
export const DEPLOY_SENTINEL = MOM_CLI_PROTOCOL.deploySentinel;

export type PreviewFetchRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
};

export type PreviewFetchResponse = ProxyFetchResponse;

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
    copyFileSync(MOM_CLI_SOURCE, hostCliPath);
    copyFileSync(MOM_CLI_PROTOCOL_SOURCE, join(hostBinDir, "mom-cli-protocol.json"));
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
  if (!shouldRewriteText(contentType)) {
    return { ...response, headers };
  }

  const body = Buffer.from(rewriteRootRelativeText(response.body.toString("utf8"), service.path, contentType), "utf8");
  headers["content-length"] = String(body.byteLength);
  return {
    status: response.status,
    headers,
    body
  };
}
