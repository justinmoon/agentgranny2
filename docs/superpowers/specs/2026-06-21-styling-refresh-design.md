# Styling Refresh — "Elevated Warm" — Design

**Date:** 2026-06-21
**Project:** agentmom (agentgranny2)
**Type:** Visual restyle (no functional or structural changes)

## Problem

The current UI works but reads as "developer-made": dense, technical, and boxy. Nearly every
element is a 1px-bordered, shadowed box on near-black, and the body font (Inter) feels
mechanical. The goal is for the app to look like a real company's agent interface designed by a
UX/UI designer — sleek, polished, and intentional — while keeping its existing warm dark + amber
identity.

This was validated interactively via rendered mockups. The user chose:
- **Direction:** "Elevated Terminal" — keep the warm dark + amber look, make it premium.
- **Typography:** Fraunces (serif) for the brand/titles/headings + DM Sans for body/chat/controls.
- **Scope:** the entire app (dashboard, login, admin, Telegram settings).

## Goals

- Reduce the "boxy / dense" feel: fewer hard borders, tinted backgrounds for active/selected
  states, rounder corners, more breathing room.
- Reserve the amber gradient for primary actions so it carries meaning instead of decorating
  everything.
- Establish clear typographic hierarchy with Fraunces headings + DM Sans body.
- Apply consistently across all four screens so nothing looks half-finished.

## Non-Goals

- No changes to functionality, layout structure, component logic, or routing.
- No renaming of brand text or copy ("Agent Mom" / "AM" stay as-is).
- No new components or pages. This is a CSS-and-fonts layer only.

## Why this is low-risk

The app is already token-driven: `web/styles.css` `:root` defines design tokens
(`--bg`, `--panel`, `--line`, `--radius`, `--accent*`, shadows, `--ease`) and every stylesheet
reads from them. Re-theming therefore means adjusting tokens centrally and refining a set of
known selectors — not rewriting components. The four stylesheets (`styles.css`, `thread.css`,
`right-panel.css`, `pages.css`) and the React components already use stable class names.

## Approach

### 1. Self-host the fonts

Add npm packages and import them once so they load with the bundle (no external CDN — works
offline, no privacy/performance cost):

- `@fontsource-variable/fraunces`
- `@fontsource-variable/dm-sans`

Import the font CSS at the top of `web/main.tsx` (alongside the existing `./styles.css` imports).
Variable fonts give us the weights we need (DM Sans 400/500/600/700; Fraunces 400/500/600) from a
single file each.

### 2. Update design tokens (`web/styles.css` `:root`)

- Add font tokens:
  - `--font-sans: "DM Sans Variable", ui-sans-serif, system-ui, -apple-system, sans-serif;`
  - `--font-serif: "Fraunces Variable", Georgia, "Times New Roman", serif;`
- Point the global `font-family` (currently Inter) at `--font-sans`.
- Soften borders: lighten/lower the opacity of `--line` and `--line-strong` so outlines read as
  hairlines rather than hard edges. Introduce a tinted-surface convention for active states
  (`rgba(225,148,78,0.1)` fill + inset accent ring) in place of solid borders.
- Slightly increase radii for a softer feel (`--radius-sm`, `--radius`, `--radius-lg` bumped a
  step).

### 3. Apply the serif to headings

Via CSS selectors only (no/minimal `.tsx` edits). Target the brand wordmark, page titles, and
section headings so Fraunces carries the "personality":
- `.brand h1`, `.brand-mark`
- `.topbar strong` (active session title)
- `.sessions h2`, `.empty-thread h2`, and the workspace-prompt `h2`
- Admin / Telegram / Auth page `h1`s (covered by `.brand h1` plus page-specific headings)

Set Fraunces with a slightly reduced weight (500) and tightened letter-spacing for an elegant,
non-blocky look. Everything else inherits DM Sans.

### 4. Refine each stylesheet to the "elevated" treatment

Across all four files, applying the same visual language:

- **`styles.css`** — app shell, sidebar, session items (tinted active state, no hard border),
  `.actions` buttons, `.run-state`, topbar, `.status-strip`, `.brand-mark`. Reserve the amber
  gradient for the single primary action ("New session" / Send); secondary buttons get a calm
  panel surface with a hairline border that only strengthens on hover.
- **`thread.css`** — chat bubbles (rounder, asymmetric tail radius, tinted "you" bubble with a
  soft accent border instead of a hard outline), composer (softer container, gradient send
  button), empty-thread heading in Fraunces.
- **`right-panel.css`** — preview panel surfaces aligned to the softened border/tint convention.
- **`pages.css`** — login card, admin, and Telegram settings: same hairline borders, tinted
  surfaces, Fraunces headings, and refined inputs/buttons so these screens match the dashboard.

### 5. Inputs and focus states

Keep the existing accent focus ring but align it to the softened palette: hairline default
border, accent border + soft amber glow on focus (already present; refine to match new tokens).

## Affected files

| File | Change |
|------|--------|
| `package.json` | add `@fontsource-variable/fraunces`, `@fontsource-variable/dm-sans` |
| `web/main.tsx` | import the two font CSS entrypoints |
| `web/styles.css` | tokens (fonts, borders, radii), serif headings, elevated treatment |
| `web/thread.css` | chat bubbles, composer, serif empty-state heading |
| `web/right-panel.css` | softened surfaces/borders |
| `web/pages.css` | login / admin / telegram restyle to match |

No other `.tsx` changes expected; if a heading can't be reached by selector, add a class rather
than restructuring markup.

## Verification

Primarily visual. After implementation:
- Run the dev server and view each screen (dashboard, login, admin `/admin`, Telegram settings
  `/settings/telegram`) at desktop width and at the existing responsive breakpoints (980px,
  640px) to confirm nothing breaks.
- Confirm fonts load from the bundle with no network calls to Google.
- `npm run typecheck` stays green (guards against accidental `.tsx` breakage).
- Compare against the approved mockups in `.superpowers/brainstorm/` for fidelity.

## Out of scope / future

- Light theme, icon redesign, animation/motion polish beyond existing transitions, and any copy
  changes are explicitly not part of this pass.
