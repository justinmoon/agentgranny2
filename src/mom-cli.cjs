#!/usr/bin/env node

const { previewSentinel, deploySentinel } = require("./mom-cli-protocol.json");
const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail("Usage:\n  mom expose <port> <name>\n  mom deploy --cwd <absolute-path> --port <port> --slug <slug>");
}

function parsePort(value) {
  const rawPort = String(value || "").trim();
  if (!/^\d+$/.test(rawPort)) usage();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage();
  return port;
}

function readRequiredOption(name) {
  const prefix = `--${name}=`;
  const equalsArg = args.find((arg) => arg.startsWith(prefix));
  if (equalsArg) return equalsArg.slice(prefix.length).trim();

  const index = args.indexOf(`--${name}`);
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
  console.log(`Preview exposed: ${name} on port ${port}`);
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
  console.log(`Deployment requested: ${slug} from ${cwd} on port ${port}`);
  process.exit(0);
}

usage();
