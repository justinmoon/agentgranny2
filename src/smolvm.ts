import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { posix as pathPosix } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config.js";
import type { PreviewFetchRequest, PreviewFetchResponse } from "./previews.js";

export type SmolvmSnapshot = {
  name: string;
  state: string;
  pid: number | null;
  guestWorkspace: string;
};

export type SmolvmResumeTestResult = {
  before?: SmolvmSnapshot;
  stopped?: SmolvmSnapshot;
  after?: SmolvmSnapshot;
  output: string;
};

export class SmolvmRuntime {
  private currentState?: SmolvmSnapshot;
  private startPromise?: Promise<void>;
  private processes = new Set<ChildProcess>();

  constructor(private readonly config: AppConfig) {}

  async ensureReady(): Promise<void> {
    this.startPromise ??= this.ensureRunning();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  snapshot(): SmolvmSnapshot | undefined {
    return this.currentState;
  }

  createBashOperations(): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        await this.ensureReady();
        if (options.signal?.aborted) throw new Error("aborted");

        const result = await this.execInGuest(command, this.hostCwdToGuest(cwd), {
          timeout: options.timeout,
          signal: options.signal,
          onData: options.onData
        });

        if (options.signal?.aborted) throw new Error("aborted");
        return { exitCode: result.exitCode };
      }
    };
  }

  async fetchHttp(port: number, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
    await this.ensureReady();

    const payload = Buffer.from(
      JSON.stringify({
        method: request.method,
        url: `http://127.0.0.1:${port}${request.path}`,
        headers: request.headers,
        bodyBase64: request.body?.toString("base64")
      }),
      "utf8"
    ).toString("base64");

    const result = await this.execInGuest(
      `node -e ${shellQuote(GUEST_FETCH_SCRIPT)} ${shellQuote(payload)}`,
      this.config.smolvm.guestWorkspace,
      { timeout: 30 }
    );

    if (result.exitCode !== 0) {
      throw new Error(`guest preview fetch failed: ${result.stderr || result.stdout}`);
    }

    const parsed = JSON.parse(result.stdout) as {
      status: number;
      headers: Record<string, string>;
      bodyBase64: string;
    };

    return {
      status: parsed.status,
      headers: parsed.headers,
      body: Buffer.from(parsed.bodyBase64, "base64")
    };
  }

  async startProcess(command: string, cwd: string, onData?: (data: Buffer) => void): Promise<ChildProcess> {
    await this.ensureReady();

    const child = spawn(
      this.config.smolvm.command,
      [
        "machine",
        "exec",
        "--stream",
        "--name",
        this.config.smolvm.name,
        "--workdir",
        this.hostCwdToGuest(cwd),
        "--",
        "sh",
        "-lc",
        command
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    this.processes.add(child);
    child.stdout?.on("data", onData ?? (() => {}));
    child.stderr?.on("data", onData ?? (() => {}));
    child.on("close", () => this.processes.delete(child));
    return child;
  }

  async dispose(): Promise<void> {
    for (const child of this.processes) {
      child.kill("SIGTERM");
    }
    this.processes.clear();
  }

  async testResume(): Promise<SmolvmResumeTestResult> {
    await this.ensureReady();
    const before = this.snapshot();

    await this.stop();
    const stopped = this.snapshot();

    await this.ensureReady();
    const probe = await this.execInGuest("printf agentmom-resume-ok", this.config.smolvm.guestWorkspace, {
      timeout: 30
    });
    if (probe.exitCode !== 0) {
      throw new Error(`smolvm resume probe failed: ${probe.stderr || probe.stdout}`);
    }

    await this.refreshState();
    return {
      before,
      stopped,
      after: this.snapshot(),
      output: probe.stdout
    };
  }

  private async stop(): Promise<void> {
    for (const child of this.processes) {
      child.kill("SIGTERM");
    }
    this.processes.clear();

    await this.runSmolvm(["machine", "stop", "--name", this.config.smolvm.name], {
      allowFailure: true
    });
    await this.refreshState();
  }

  private async ensureRunning(): Promise<void> {
    mkdirSync(this.config.workspace, { recursive: true });
    mkdirSync(this.config.projectsDir, { recursive: true });
    mkdirSync(this.config.agentCwd, { recursive: true });

    if (!(await this.machineExists())) {
      await this.runSmolvm([
        "machine",
        "create",
        "--name",
        this.config.smolvm.name,
        "--image",
        this.config.smolvm.image,
        "--cpus",
        String(this.config.smolvm.cpus),
        "--mem",
        String(this.config.smolvm.memoryMb),
        "--storage",
        String(this.config.smolvm.storageGib),
        "--overlay",
        String(this.config.smolvm.overlayGib),
        "--volume",
        `${this.config.projectsDir}:${this.config.smolvm.guestWorkspace}`,
        "--workdir",
        this.config.smolvm.guestWorkspace,
        ...(this.config.smolvm.network ? ["--net"] : [])
      ]);
    }

    await this.refreshState();
    if (this.currentState?.state !== "running") {
      await this.runSmolvm(["machine", "start", "--name", this.config.smolvm.name]);
      await this.refreshState();
    }

    const check = await this.execInGuest(`test -d ${shellQuote(this.config.smolvm.guestWorkspace)} && pwd`, this.config.smolvm.guestWorkspace, {
      timeout: 30
    });
    if (check.exitCode !== 0) {
      throw new Error(`smolvm workspace check failed: ${check.stderr || check.stdout}`);
    }
  }

  private hostCwdToGuest(cwd: string): string {
    const projectsDir = resolve(this.config.projectsDir);
    const resolvedCwd = resolve(cwd);
    const rel = relative(projectsDir, resolvedCwd);
    const insideProjects = rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
    if (!insideProjects) return this.config.smolvm.guestWorkspace;
    return pathPosix.join(this.config.smolvm.guestWorkspace, rel.split(sep).join("/"));
  }

  private async machineExists(): Promise<boolean> {
    const result = await this.runSmolvm(["machine", "status", "--name", this.config.smolvm.name, "--json"], {
      allowFailure: true
    });
    return result.exitCode === 0;
  }

  private async refreshState(): Promise<void> {
    const result = await this.runSmolvm(["machine", "status", "--name", this.config.smolvm.name, "--json"]);
    const parsed = JSON.parse(result.stdout) as { state?: string; pid?: number | null };
    this.currentState = {
      name: this.config.smolvm.name,
      state: parsed.state ?? "unknown",
      pid: parsed.pid ?? null,
      guestWorkspace: this.config.smolvm.guestWorkspace
    };
  }

  private async execInGuest(
    command: string,
    workdir: string,
    options: {
      timeout?: number;
      signal?: AbortSignal;
      onData?: (data: Buffer) => void;
    } = {}
  ): Promise<CommandResult> {
    return this.runSmolvm(
      [
        "machine",
        "exec",
        "--stream",
        "--name",
        this.config.smolvm.name,
        "--workdir",
        workdir,
        ...(options.timeout ? ["--timeout", `${options.timeout}s`] : []),
        "--",
        "sh",
        "-lc",
        command
      ],
      {
        signal: options.signal,
        onData: options.onData
      }
    );
  }

  private async runSmolvm(
    args: string[],
    options: {
      allowFailure?: boolean;
      signal?: AbortSignal;
      onData?: (data: Buffer) => void;
    } = {}
  ): Promise<CommandResult> {
    return runCommand(this.config.smolvm.command, args, options);
  }
}

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function runCommand(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    signal?: AbortSignal;
    onData?: (data: Buffer) => void;
  }
): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.reject(new Error("aborted"));

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (data: Buffer) => {
      stdout.push(data);
      options.onData?.(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr.push(data);
      options.onData?.(data);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      options.signal?.removeEventListener("abort", onAbort);
      const result = {
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed (${exitCode}): ${result.stderr || result.stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const GUEST_FETCH_SCRIPT = `
const payload = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const init = {
  method: payload.method,
  headers: payload.headers,
  redirect: "manual"
};
if (payload.bodyBase64 && payload.method !== "GET" && payload.method !== "HEAD") {
  init.body = Buffer.from(payload.bodyBase64, "base64");
}
const response = await fetch(payload.url, init);
const body = Buffer.from(await response.arrayBuffer());
process.stdout.write(JSON.stringify({
  status: response.status,
  headers: Object.fromEntries(response.headers.entries()),
  bodyBase64: body.toString("base64")
}));
`;
