import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { SmolvmRuntime } from "../src/smolvm.js";

const workspace = resolve(".smoke-smolvm-workspace");
const machineName = `agentmom-smoke-${Date.now().toString(36)}`;

rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

process.env.AGENTMOM_EXECUTOR = "smolvm";
process.env.AGENTMOM_WORKSPACE = workspace;
process.env.AGENTMOM_STATE_DIR = join(workspace, ".agentmom");
process.env.AGENTMOM_SMOLVM_NAME = machineName;

const config = loadConfig();
const runtime = new SmolvmRuntime(config);

try {
  await runtime.ensureReady();
  const ops = runtime.createBashOperations();
  const output: Buffer[] = [];
  const result = await ops.exec("pwd && node --version && printf smolvm-ok > vm-smoke.txt", config.agentCwd, {
    onData: (data) => output.push(data),
    timeout: 180
  });

  if (result.exitCode !== 0) {
    throw new Error(`smolvm command failed (${result.exitCode}): ${Buffer.concat(output).toString("utf8")}`);
  }

  const smokeFile = join(config.projectsDir, "vm-smoke.txt");
  if (!existsSync(smokeFile)) {
    throw new Error(`smolvm did not write mounted file: ${smokeFile}`);
  }

  const content = readFileSync(smokeFile, "utf8").trim();
  if (content !== "smolvm-ok") {
    throw new Error(`unexpected smolvm smoke content: ${JSON.stringify(content)}`);
  }

  console.log(`smolvm smoke ok: ${machineName}`);
  console.log(Buffer.concat(output).toString("utf8").trim());
} finally {
  await runtime.dispose();
  try {
    execFileSync(config.smolvm.command, ["machine", "delete", "--name", machineName, "-f"], { stdio: "ignore" });
  } catch {
    // Best-effort cleanup for the disposable smoke machine.
  }
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(workspace, { recursive: true, force: true });
  }
}
