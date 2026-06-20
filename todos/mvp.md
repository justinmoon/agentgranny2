Living plan. Revise it as we learn. Do not treat this as a fixed contract.

# Agent Mom MVP

## Intent

Build the smallest useful Agent Mom around Pi, not beside Pi.

The first milestone is a trustworthy local coding-agent loop that can be dogfooded immediately: open a small Vite web app, use a Pi session in a real workspace, stream tool activity, resume the same session, and understand what happened when something goes wrong.

The philosophy is Grug-brained: keep the system obvious, local, and boring. Avoid clever platform machinery until the simple thing hurts in a specific way.

## Scope

[x] Use Pi coding-agent as the agent substrate.
[x] Use local Pi checkout at `/Users/justin/code/pi-mono` only as reference material.
[x] Use assistant-ui as a light React chat rendering layer only.
[x] Use local assistant-ui checkout at `/Users/justin/code/assistant-ui` only as reference material.
[x] Use Vite, not Next.js.
[x] Use Pi's built-in default active tools: `read`, `bash`, `edit`, `write`.
[x] Use Pi's session manager / JSONL session persistence.
[x] Use Pi's model/provider abstractions for OpenRouter.
[x] Default the workspace to the current directory; allow `AGENTMOM_WORKSPACE=/path` override.
[x] Build only the thin product shell Pi does not provide: local web app, API bridge, workspace display, runtime display, event presentation, and dev ergonomics.
[x] Skip TUI for MVP.
[x] Use one smolvm instance as the default runtime.
[x] Keep local execution available only as a smoke/dev fallback.

Out of scope for the first trustworthy loop:

[ ] Custom Agent Mom tools that duplicate Pi tools.
[ ] Custom Agent Mom session history format.
[ ] Custom tool gating or content-specific routing.
[ ] Assistant-ui as source of truth or thread persistence.
[ ] Absurd tasks, Postgres app state, leases, cost accounting, auth, multi-user support, polished deployment.

## Approach

Start by making Pi feel good through a tiny web/API wrapper.

Do not port the old prototype architecture. Port only proven setup details:

- Nix-first dev shell.
- OpenRouter key loading from this repo's local `.env`.
- Tools available by default.
- Nostr as a smoke test prompt, not runtime routing.

Use Pi's session as the source of truth. Use assistant-ui only to render chat state in React. Keep the assistant-ui adapter shallow and replaceable: convert Pi session messages/events into the minimal message shape the UI needs, and do not let assistant-ui own durable state.

The core local loop:

1. Start `agentmom` from a workspace, or pass `AGENTMOM_WORKSPACE`.
2. Create or resume a Pi session for that workspace.
3. Browser sends a user message.
4. Server forwards it to Pi.
5. Pi streams assistant text and built-in tool events.
6. Server relays events to the browser.
7. Pi persists the session.
8. Browser can reload and show the same session.

Runtime rule:

- Agent Mom owns a single persistent smolvm machine per server/workspace.
- Pi still sees `bash`; Agent Mom swaps only the `bash` backend so commands execute inside smolvm.
- The app repo root is not the agent cwd. Pi and smolvm work in `<workspace>/projects`, mounted into the guest at `/workspace`.
- Prefer project subfolders under `projects/` as dogfooding gets real, but keep the first guard simple.

## Steps

[x] Create minimal repo skeleton: `flake.nix`, `package.json`, `tsconfig.json`, `justfile`, `src/`, `web/`, `todos/`.
[x] Wire dependencies to published Pi and assistant-ui packages with the smallest import surface possible.
[x] Add config: workspace path, sessions root, API port, OpenRouter model, OpenRouter env file.
[x] Create a smoke that starts a Pi session with default tools and asks a no-tool question.
[x] Create a smoke that asks Pi to read/write/edit in a temp workspace using only Pi built-ins.
[x] Build tiny API: health, list sessions, create/resume session, send message, stream events.
[x] Build Vite web app: session list, chat transcript via assistant-ui, live assistant stream, simple tool event log, current workspace header.
[x] Add visible failure states: missing key, missing workspace, Pi session load failure, model error, tool error.
[x] Move agent cwd out of the app root so dogfood output does not overwrite Agent Mom files.
[x] Add smolvm as the default executor behind Pi's existing `bash` tool name.
[x] Add smolvm workspace mounting and command smoke.
[x] Add smolvm web indicators for runtime facts users need: executor, VM name, state, pid.
[~] Dogfood against this repo: ask small questions, make small edits, verify session reload.
[ ] Add Nostr smoke as a normal prompt through Pi, with assertions on files/build output, no hardcoded routing.

## After Trustworthy Local Loop

[ ] Add process ergonomics only if Pi `bash` is insufficient for dogfooding: clearer long-running command display, stop button, output truncation policy, and process cleanup.
[x] Package Agent Mom with Nix so deployment can reference a store path instead of a mutable checkout.
[~] Deploy the current single-user smolvm app to `mom.agentmom.xyz` with the smallest NixOS/Caddy/systemd change that fits Agent Mom's host layout.
[x] Put production workspace/state under `/var/lib/agentmom`, with the existing Agent Mom age secret for OpenRouter.
[~] Keep deploy single-instance and protect it with Caddy basic auth before exposing it.
[ ] Add a live deploy smoke: health endpoint, UI render, and one `bash` turn proving `/workspace`.
[ ] Add Absurd only after direct Pi sessions are reliable. First use: durable background turn execution for web requests that should survive server restart.
[ ] Add Postgres only if Absurd or multi-session metadata requires it. Keep Pi JSONL sessions as the agent transcript unless there is a concrete reason to migrate.
[ ] Add resume/recovery semantics after Absurd: a restarted server can find an interrupted session, show what completed, and avoid rerunning unsafe tool calls automatically.

## Implementation Notes

- Pi default active tools are `read`, `bash`, `edit`, `write`; do not expand this list for MVP.
- Pi has additional built-ins (`grep`, `find`, `ls`) available if we later choose a read-only or all-tools profile.
- Agent Mom should not parse prompts to decide behavior.
- Agent Mom should not maintain a second durable conversation log unless Pi's session API cannot support the web UI.
- If the web UI needs display-only event history that Pi does not persist, keep it explicitly separate from agent context.
- Keep assistant-ui integration deliberately thin. It is a rendering layer, not the agent runtime.
- Prefer fewer abstractions until one is forced by a test or dogfooding pain.
- Implementation uses published Pi packages from npm, not local `file:` dependencies. Local checkouts are reference material only unless explicitly forked.
- Implementation uses the published `@assistant-ui/react` package for runtime because `/Users/justin/code/assistant-ui` is a source checkout without package `dist` outputs; keep the checkout as the reference source.
- `src/pi-bridge.ts` is the intentional boundary: Pi owns agent state/session/tools, Agent Mom owns HTTP/SSE/UI projection only.
- `src/smolvm.ts` shells out to the `smolvm` CLI instead of depending on the unpublished `smolvm-embedded` Node SDK.
- Deployment packages the upstream `smolvm` v1.1.1 release tarball, not the stale local checkout. The release includes `smolvm-bin`, runtime libs, disk templates, and `agent-rootfs`.
- Default smolvm image is `node:24-bookworm`; the host app remains Nix-managed, the guest does not run Nix by default.
- `scripts/smoke-smolvm.ts` verifies smolvm command execution and the host-mounted `/workspace`.
- `.env` was copied into the repo root for local dev and ignored by git; no cross-repo env file dependency.
- Default OpenRouter model changed from `qwen/qwen3-coder-30b-a3b-instruct` to `anthropic/claude-sonnet-4.5` because Qwen sometimes emits textual `<function=write>` blocks instead of real tool calls.
- Verified with `npx agent-browser`: opened the Vite UI, submitted a no-tool prompt through the composer, saw `UI_READY` render, and captured a screenshot at `/tmp/agentmom-ui.png`.
- Verified server restart resumes the same Pi JSONL session and transcript from `.agentmom/sessions`.
- `scripts/smoke-local.ts` covers both no-tool inference and a real Pi `write` tool invocation in an isolated workspace.
- Verified default smolvm runtime on 2026-06-18: API state showed `agentmom-default` running, UI rendered `Runtime smolvm`, and an end-to-end Pi turn called `bash` with output `/workspace` and `v24.17.0`.
- Verified `nix build .#agentmom`; packaged binary served `/api/health` with local executor on port 7393.
