import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  appCommit?: string;
  host: string;
  port: number;
  executor: "local" | "smolvm";
  workspace: string;
  projectsDir: string;
  agentCwd: string;
  stateDir: string;
  agentDir: string;
  sessionDir: string;
  deploymentDir: string;
  openRouterModel: string;
  openRouterEnvFile: string;
  openRouterApiKey?: string;
  rootDir: string;
  podman: {
    command: string;
  };
  smolvm: {
    command: string;
    name: string;
    image: string;
    guestWorkspace: string;
    cpus: number;
    memoryMb: number;
    network: boolean;
    storageGib: number;
    overlayGib: number;
  };
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readOpenRouterKeyFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;

  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || match[1] !== "OPENROUTER_API_KEY") continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }

  const rawKey = content.trim();
  return rawKey && !rawKey.includes("\n") ? rawKey : undefined;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readGitCommit(): string | undefined {
  try {
    return execFileSync("git", ["-c", `safe.directory=${rootDir}`, "rev-parse", "--short=12", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

export function loadConfig(): AppConfig {
  const workspace = resolve(process.env.AGENTGRANNY_WORKSPACE ?? process.cwd());
  const projectsDir = resolve(process.env.AGENTGRANNY_PROJECTS_DIR ?? `${workspace}/projects`);
  const agentCwd = resolve(process.env.AGENTGRANNY_AGENT_CWD ?? projectsDir);
  const openRouterEnvFile = resolve(process.env.AGENTGRANNY_OPENROUTER_ENV_FILE ?? `${rootDir}/.env`);
  const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? readOpenRouterKeyFile(openRouterEnvFile);

  if (openRouterApiKey && !process.env.OPENROUTER_API_KEY) {
    process.env.OPENROUTER_API_KEY = openRouterApiKey;
  }

  const stateDir = resolve(process.env.AGENTGRANNY_STATE_DIR ?? `${workspace}/.agentgranny2`);

  return {
    appCommit: process.env.AGENTGRANNY_COMMIT ?? readGitCommit(),
    host: process.env.AGENTGRANNY_HOST ?? "127.0.0.1",
    port: numberFromEnv("AGENTGRANNY_PORT", 7392),
    executor: process.env.AGENTGRANNY_EXECUTOR === "local" ? "local" : "smolvm",
    workspace,
    projectsDir,
    agentCwd,
    stateDir,
    agentDir: resolve(process.env.AGENTGRANNY_AGENT_DIR ?? `${stateDir}/pi`),
    sessionDir: resolve(process.env.AGENTGRANNY_SESSION_DIR ?? `${stateDir}/sessions`),
    deploymentDir: resolve(process.env.AGENTGRANNY_DEPLOYMENT_DIR ?? `${stateDir}/deployments`),
    openRouterModel: process.env.AGENTGRANNY_OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
    openRouterEnvFile,
    openRouterApiKey,
    rootDir,
    podman: {
      command: process.env.AGENTGRANNY_PODMAN_COMMAND ?? "podman"
    },
    smolvm: {
      command: process.env.AGENTGRANNY_SMOLVM_COMMAND ?? "smolvm",
      name: process.env.AGENTGRANNY_SMOLVM_NAME ?? "agentgranny2-default",
      image: process.env.AGENTGRANNY_SMOLVM_IMAGE ?? "node:24-bookworm",
      guestWorkspace: process.env.AGENTGRANNY_SMOLVM_GUEST_WORKSPACE ?? "/workspace",
      cpus: numberFromEnv("AGENTGRANNY_SMOLVM_CPUS", 4),
      memoryMb: numberFromEnv("AGENTGRANNY_SMOLVM_MEMORY_MB", 8192),
      network: process.env.AGENTGRANNY_SMOLVM_NETWORK !== "0",
      storageGib: numberFromEnv("AGENTGRANNY_SMOLVM_STORAGE_GIB", 20),
      overlayGib: numberFromEnv("AGENTGRANNY_SMOLVM_OVERLAY_GIB", 10)
    }
  };
}
