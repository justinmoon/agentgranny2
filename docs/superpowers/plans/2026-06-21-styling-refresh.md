# Elevated Warm Styling Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the agentmom web UI to look like a polished, designer-made agent interface — warm dark + amber identity, fewer hard borders, Fraunces headings + DM Sans body — across every screen, with no functional changes.

**Architecture:** The app is already token-driven: `web/styles.css` `:root` holds design tokens that all four stylesheets consume. We self-host two variable fonts, retune the central tokens (fonts, border colors, radii, a tinted-surface convention), apply the serif to real headings via selectors, then refine component rules in each stylesheet to the softer "elevated" treatment. No component/markup restructuring.

**Tech Stack:** React 19 + Vite + plain CSS (custom properties). Fonts via `@fontsource-variable/*` npm packages.

## Global Constraints

- **No functional, layout-structure, routing, or component-logic changes** — CSS + font imports only. If a heading is unreachable by selector, add a `className` rather than restructuring markup.
- **No copy/brand renaming** — "Agent Mom" / "AM" text stays as-is.
- **Fonts self-hosted** — no Google Fonts CDN or other external font network calls at runtime.
- **`npm run typecheck` must stay green** after every task (guards against accidental `.tsx` breakage).
- **Verification is visual** (CSS has no unit tests): run `npm run dev` and inspect the affected screen(s). Each task ends with a visual check + typecheck + commit.
- Preserve existing token *names* — only change their values and add new tokens; do not rename `--line`, `--accent`, etc.
- Keep `prefers-reduced-motion` behavior intact.

---

### Task 1: Self-host fonts and switch the body typeface

**Files:**
- Modify: `package.json` (dependencies — via `npm install`)
- Modify: `web/main.tsx` (add two font imports near the existing CSS imports, ~lines 38-41)
- Modify: `web/styles.css:1-48` (`:root` — add font tokens; swap the global `font-family`)

**Interfaces:**
- Produces: CSS variables `--font-sans` and `--font-serif`, consumed by all later tasks.

- [ ] **Step 1: Install the font packages**

```bash
cd ~/agentgranny2
npm install @fontsource-variable/dm-sans@^5 @fontsource-variable/fraunces@^5
```
Expected: both added to `package.json` `dependencies`, lockfile updated, exit 0.

- [ ] **Step 2: Import the fonts in `web/main.tsx`**

Add these two lines alongside the existing `import "./pages.css";` / `import "./styles.css";` / `import "./thread.css";` block (around line 38). Put them **before** the local CSS imports so token CSS can win cascade ties:

```ts
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/fraunces";
```
(The variable packages expose the families `"DM Sans Variable"` and `"Fraunces Variable"`.)

- [ ] **Step 3: Add font tokens and switch the global font in `web/styles.css`**

In the `:root` block, add these two tokens (e.g. just under the `--ease` line):

```css
  --font-sans: "DM Sans Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-serif: "Fraunces Variable", Georgia, "Times New Roman", serif;
```

Then replace the existing `font-family: Inter, …;` declaration in `:root` with:

```css
  font-family: var(--font-sans);
```

- [ ] **Step 4: Verify in the running app**

```bash
npm run dev
```
Open the dashboard. Expected: all body text now renders in DM Sans (rounder, softer than Inter). Open DevTools → Network → filter "font": confirm fonts load from the local bundle (same origin), **no requests to fonts.googleapis.com / fonts.gstatic.com**.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json web/main.tsx web/styles.css
git commit -m "feat(ui): self-host DM Sans + Fraunces, switch body font"
```

---

### Task 2: Retune core tokens + apply the serif to headings

**Files:**
- Modify: `web/styles.css` (`:root` token values; add a serif-headings rule)

**Interfaces:**
- Consumes: `--font-serif` from Task 1.
- Produces: softened `--line`/`--line-strong`, larger radii, and new `--accent-tint` / `--accent-tint-ring` tokens consumed by Tasks 3-6.

- [ ] **Step 1: Soften borders and enlarge radii in `:root`**

Replace these existing token values:

```css
  --line: rgb(255 255 255 / 8%);
  --line-strong: rgb(255 255 255 / 14%);

  --radius-sm: 8px;
  --radius: 11px;
  --radius-lg: 14px;
```

(Was `--line: #2f2f35; --line-strong: #3d3d45;` and radii `7/9/12`.)

- [ ] **Step 2: Add the tinted-surface convention tokens**

Add to `:root` (near the accent tokens):

```css
  --accent-tint: rgb(225 148 78 / 10%);
  --accent-tint-ring: inset 0 0 0 1px rgb(225 148 78 / 28%);
```

- [ ] **Step 3: Add the serif-headings rule**

Add this block right after the base `button { cursor: pointer; }` rule near the top of `styles.css`. **Only true headings** — not the uppercase mini-labels (`.sessions h2`, `.workspace-block span`), which must stay DM Sans:

```css
.brand h1,
.topbar strong,
.empty-thread h2 {
  font-family: var(--font-serif);
  font-weight: 500;
  letter-spacing: -0.01em;
}

.brand-mark {
  font-family: var(--font-serif);
  font-weight: 600;
}
```

- [ ] **Step 4: Verify in the running app**

Reload the dashboard. Expected: the "Agent Mom" wordmark, the active-session title in the topbar, and the empty-thread heading render in Fraunces serif; borders look like faint hairlines (not hard grey lines); corners are slightly rounder. The uppercase "SESSIONS" label stays DM Sans.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add web/styles.css
git commit -m "feat(ui): soften borders, enlarge radii, add serif headings"
```

---

### Task 3: Elevated treatment for the shell (styles.css components)

**Files:**
- Modify: `web/styles.css` (sidebar, sessions, `.actions` buttons, topbar, status strip)

**Interfaces:**
- Consumes: `--accent-tint`, `--accent-tint-ring` from Task 2.

- [ ] **Step 1: Tint the active session instead of bordering it**

Replace the existing `.session.active` rule:

```css
.session.active {
  border-color: transparent;
  background: var(--accent-tint);
  box-shadow: var(--accent-tint-ring);
  color: var(--accent-strong);
}
```

- [ ] **Step 2: Calm the secondary buttons' resting state**

The `.actions button, .actions a, .session` rule currently stacks `--shadow-sm` + `--highlight`. Soften the resting look by removing the drop shadow at rest (keep it for hover). Change the shared rule's `box-shadow: var(--shadow-sm), var(--highlight);` to:

```css
  box-shadow: var(--highlight);
```

Leave the existing `:hover` rule (which adds `--shadow-md`) unchanged so buttons still lift on hover.

- [ ] **Step 3: Soften the status strip seams**

The `.status-strip` uses `background: var(--line)` with `gap: 1px` to draw seams. With the new translucent `--line` those seams vanish, so set an explicit hairline seam color:

```css
.status-strip {
  border-bottom: 1px solid var(--line);
  background: rgb(255 255 255 / 6%);
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
}
```

- [ ] **Step 4: Verify in the running app**

Reload. Expected: active session reads as a soft amber-tinted pill with no hard outline; sidebar buttons sit flat at rest and lift on hover; the status strip shows faint hairline dividers (not a heavy grey grid).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add web/styles.css
git commit -m "feat(ui): elevated shell — tinted active state, calmer buttons, hairline status strip"
```

---

### Task 4: Refine the chat thread (thread.css)

**Files:**
- Modify: `web/thread.css` (`.user-bubble`, `.thread-panel`)

**Interfaces:**
- Consumes: `--accent-tint` from Task 2.

- [ ] **Step 1: Give the user bubble a soft amber tint instead of a hard border**

Replace the existing `.user-bubble` rule:

```css
.user-bubble {
  background: var(--accent-tint);
  color: var(--text);
  border: 1px solid rgb(225 148 78 / 22%);
  border-bottom-right-radius: 6px;
  box-shadow: none;
}
```

- [ ] **Step 2: Lighten the thread panel container shadow**

The `.thread-panel` rule keeps `box-shadow: var(--shadow-md);` — leave the shadow but the now-hairline `--line` border (from Task 2) already softens it. No value change needed; confirm it reads cleanly in Step 3. (No edit in this step.)

- [ ] **Step 3: Verify in the running app**

Send a message in the dashboard. Expected: your message bubble is a soft amber-tinted bubble with a gentle border (no hard grey outline, no drop shadow); the assistant reply stays as clean full-width markdown; the gradient send button is unchanged.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add web/thread.css
git commit -m "feat(ui): soften user chat bubble to amber tint"
```

---

### Task 5: Refine the right preview panel (right-panel.css)

**Files:**
- Modify: `web/right-panel.css` (`.preview-empty`, `.right-tab.active`)

**Interfaces:**
- Consumes softened tokens from Task 2 (most surfaces inherit automatically).

- [ ] **Step 1: Soften the empty-preview dashed box**

The `.preview-empty` uses `border: 1px dashed var(--line-strong);`. With the new translucent token this is already lighter; make it intentional:

```css
.preview-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px dashed rgb(255 255 255 / 12%);
  border-radius: var(--radius);
}
```

- [ ] **Step 2: Tint the active panel tab**

Replace the existing `.right-tab.active` rule:

```css
.right-tab.active {
  background: var(--accent-tint);
  color: var(--text);
  border-color: transparent;
  box-shadow: var(--accent-tint-ring);
}
```

- [ ] **Step 3: Verify in the running app**

Open the right panel (preview / event-log tabs). Expected: surfaces match the dashboard's softness; the active tab reads as an amber-tinted tab; the empty-preview placeholder has a faint dashed outline, not a hard one.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add web/right-panel.css
git commit -m "feat(ui): soften preview panel surfaces and active tab"
```

---

### Task 6: Refine login, admin, and Telegram screens (pages.css)

**Files:**
- Modify: `web/pages.css` (`.auth-form` corner brackets, `.auth-form .brand h1` size)

**Interfaces:**
- Consumes softened tokens + serif headings from Task 2 (cards/buttons inherit automatically).

- [ ] **Step 1: Remove the hard corner brackets on the login card**

The `.auth-form::before` / `.auth-form::after` rules draw sharp L-shaped accent corners that read as "techy/hacker." Delete both rule blocks (`.auth-form::before, .auth-form::after { … }`, `.auth-form::before { … }`, `.auth-form::after { … }`) for a cleaner card.

- [ ] **Step 2: Let the login heading breathe**

The auth wordmark is now serif (from Task 2). Bump its size slightly for presence — replace `.auth-form .brand h1`:

```css
.auth-form .brand h1 {
  font-size: 1.45rem;
}
```

- [ ] **Step 3: Verify in the running app**

Visit the login screen (log out, or open in a private window). Expected: the card is clean with no corner brackets; "Agent Mom" is an elegant serif headline; inputs/buttons match the dashboard's softened look. Then visit `/admin` and `/settings/telegram` — confirm cards, rows, tabs, and buttons all read consistently soft (they inherit the token changes).

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add web/pages.css
git commit -m "feat(ui): clean up login card, enlarge serif auth heading"
```

---

### Task 7: Full-app visual verification pass

**Files:** none (verification only)

- [ ] **Step 1: Walk every screen at desktop width**

With `npm run dev` running, view: dashboard (sidebar + chat + right panel), login, `/admin`, `/settings/telegram`. Confirm against the approved mockups in `.superpowers/brainstorm/`: serif headings, hairline borders, tinted active states, gradient reserved for primary actions, generous spacing.

- [ ] **Step 2: Check the responsive breakpoints**

Resize the browser through the existing breakpoints (≤980px and ≤640px). Expected: layouts still collapse correctly; nothing overflows or looks broken; fonts and tints hold up.

- [ ] **Step 3: Confirm no external font calls + typecheck**

DevTools → Network → reload: zero requests to Google font domains. Then:

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 4: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "chore(ui): final styling-refresh polish pass"
```
(Skip if Steps 1-3 required no changes.)

---

## Self-Review

**Spec coverage:**
- Self-host fonts → Task 1 ✓
- Update design tokens (fonts/borders/radii/tints) → Tasks 1-2 ✓
- Serif headings via selectors → Task 2 ✓
- Elevated treatment across styles.css / thread.css / right-panel.css / pages.css → Tasks 3-6 ✓
- All four screens (dashboard, login, admin, telegram) → Tasks 3-6 + 7 ✓
- Verification (run app, breakpoints, no Google calls, typecheck) → each task + Task 7 ✓
- Non-goals respected: no logic/layout/copy changes — all tasks are CSS/import only ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete selectors and values. Task 4 Step 2 is intentionally a no-edit confirmation step (called out explicitly), not a placeholder.

**Type/token consistency:** Token names used in Tasks 3-6 (`--accent-tint`, `--accent-tint-ring`, `--font-serif`) are all defined in Tasks 1-2. Font family strings (`"DM Sans Variable"`, `"Fraunces Variable"`) match the `@fontsource-variable` package exports and are used consistently.
