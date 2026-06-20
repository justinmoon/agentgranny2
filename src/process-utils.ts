import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";

export type CommandResult = {
  exitCode: number;
  output: string;
};

export function runCommand(
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
      const code = exitCode ?? 1;
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${truncateLog(output)}`));
        return;
      }
      resolvePromise({ exitCode: code, output });
    });
  });
}

export function allocatePort(): Promise<number> {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function truncateLog(value: string, max = 24000): string {
  return value.length > max ? `${value.slice(-max)}\n[truncated]` : value;
}
