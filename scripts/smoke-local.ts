import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { PiBridge } from "../src/pi-bridge.js";
import { PreviewManager } from "../src/previews.js";

const workspace = resolve(".smoke-workspace");
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
process.env.AGENTMOM_WORKSPACE = workspace;
process.env.AGENTMOM_STATE_DIR = join(workspace, ".agentmom");

const config = loadConfig();
const bridge = new PiBridge(config, new PreviewManager(config));

try {
  await bridge.init();
  await bridge.sendMessage("Reply with exactly: AGENTMOM_READY. Do not use tools.");

  const noToolState = await bridge.snapshot();
  const noToolReply = [...noToolState.messages].reverse().find((message) => message.role === "assistant");
  if (!noToolReply?.content.includes("AGENTMOM_READY")) {
    console.error("no-tool reply did not contain the expected marker");
    console.error(JSON.stringify({ session: noToolState.session, messages: noToolState.messages }, null, 2));
    throw new Error("no-tool smoke failed");
  }

  await bridge.sendMessage(
    'Create a file named smoke.txt in the current workspace containing exactly: agentmom smoke ok'
  );

  const smokeFile = join(workspace, "projects", "smoke.txt");
  if (!existsSync(smokeFile)) {
    const state = await bridge.snapshot();
    console.error("smoke.txt was not created");
    console.error(JSON.stringify({ session: state.session, messages: state.messages, events: state.events }, null, 2));
    throw new Error("smoke.txt missing");
  }

  const output = readFileSync(smokeFile, "utf8").trim();
  if (output !== "agentmom smoke ok") {
    throw new Error(`unexpected smoke.txt content: ${JSON.stringify(output)}`);
  }

  const state = await bridge.snapshot();
  if (!state.session?.path) throw new Error("Pi did not expose a persisted session path");

  console.log(`smoke ok: ${workspace}`);
  console.log(`session: ${state.session.path}`);
} finally {
  bridge.dispose();
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(workspace, { recursive: true, force: true });
  }
}
