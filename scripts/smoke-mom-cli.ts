import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { previewRequestHeaders } from "../src/http-utils.js";
import { PreviewManager } from "../src/previews.js";

const root = mkdtempSync(join(tmpdir(), "agentmom-cli-"));

process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "local";

try {
  const config = loadConfig();
  const previews = new PreviewManager(config);
  const { hostBinDir, guestBinDir } = previews.cliInstall();
  const mom = join(hostBinDir, "mom");

  assert.equal(guestBinDir, hostBinDir);
  assert.equal(existsSync(mom), true);
  chmodSync(mom, 0o444);
  previews.cliInstall();

  const exposeOutput = execFileSync(mom, ["expose", "4321", "demo app"], { encoding: "utf8" });
  assert.deepEqual(previews.parseSentinelOutput(exposeOutput), [{ port: 4321, name: "demo app" }]);
  assertCliFails(mom, ["expose", "4321xyz", "bad port"], /Usage/);

  const serveOutput = execFileSync(mom, ["serve", "4321", "demo app", "--", "node", "server.js"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.deepEqual(previews.parseSentinelOutput(serveOutput), [
    { port: 4321, name: "demo app", cwd: realpathSync(root), command: "node server.js" }
  ]);
  assertCliFails(mom, ["serve", "4321", "missing command"], /Usage/);

  const deployOutput = execFileSync(
    mom,
    ["deploy", "--cwd", "/tmp/demo", "--port=4321", "--slug", "demo-app"],
    { encoding: "utf8" }
  );
  assert.deepEqual(previews.parseDeploymentOutput(deployOutput), [
    { cwd: "/tmp/demo", slug: "demo-app", port: 4321 }
  ]);
  assertCliFails(mom, ["deploy", "--cwd", "/tmp/demo", "--port", "12abc", "--slug", "bad-port"], /Usage/);

  process.env.AGENTMOM_EXECUTOR = "smolvm";
  process.env.AGENTMOM_SMOLVM_GUEST_WORKSPACE = "/workspace";
  const smolvmInstall = new PreviewManager(loadConfig()).cliInstall();
  assert.equal(smolvmInstall.guestBinDir, "/workspace/.agentmom/bin");
  const smolvmPreviews = new PreviewManager(loadConfig());
  assert.equal(smolvmPreviews.register({ port: 4322, name: "guest app" }).runtime, "smolvm");
  assert.equal(smolvmPreviews.register({ port: 4323, name: "host static", runtime: "local" }).runtime, "local");

  const previewHeaders = previewRequestHeaders({
    headers: {
      cookie: "agentmom_session=secret; preview_session=keep",
      authorization: "Bearer secret",
      "proxy-authorization": "Basic secret",
      accept: "text/html"
    }
  } as never);
  assert.equal(previewHeaders.cookie, "preview_session=keep");
  assert.equal(previewHeaders.authorization, "Bearer secret");
  assert.equal(previewHeaders["proxy-authorization"], undefined);
  assert.equal(previewHeaders.accept, "text/html");

  console.log("mom cli smoke ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assertCliFails(command: string, args: string[], stderrPattern: RegExp): void {
  try {
    execFileSync(command, args, { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    assert.match(commandOutput(error), stderrPattern);
    return;
  }
  throw new Error(`Expected command to fail: ${command} ${args.join(" ")}`);
}

function commandOutput(error: unknown): string {
  const failedCommand = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  return [failedCommand.stderr, failedCommand.stdout, failedCommand.message]
    .filter((value): value is Buffer | string => Boolean(value))
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : value)
    .join("\n");
}
