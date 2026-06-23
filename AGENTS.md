# AGENTS.md — working in Breakneck Speed

Operational rules for coding agents. The **full** architecture, the `window.oneRoomDebug` API,
and a system-by-system tour live in **`HANDOFF.md`** — read it before any non-trivial work.
This file is the short, imperative version.

## What this is
A vanilla-JS, top-down neon arcade game (*Breakneck Speed* / *Rocket Shoes*). **No build step,
no dependencies, no bundler** — the files in `src/` are exactly what ships. ES modules, Canvas 2D,
procedural Web Audio. Entry: `index.html` → `import { boot } from './src/main.js'`.

## Run it
ES modules need HTTP (not `file://`):
```sh
python3 -m http.server 8000      # then open http://localhost:8000/
```
The browser console exposes **`window.oneRoomDebug`** — the inspect/force API (HANDOFF.md §6):
`start(seed)`, `live()`, `roll(n)`, `spire()`, `tp()`, `photo()`, `killAll()`, `miniboss(i)`, …

## Test every change — there are NO unit tests
Use a headless browser (Playwright/Puppeteer) + `oneRoomDebug`. Minimum bar before committing:
1. `node --check <file>` on every file you touched.
2. Load the page, run `window.oneRoomDebug.roll(40)` → assert **0 unreachable portals and
   0 `pageerror` events** (generation is still sound). Listen for `page.on('pageerror', …)`.
3. Script a few seconds of real play (move + dash) → **0 page errors**.
4. If the change is visual, screenshot it and actually look at it.
HANDOFF.md §7 has the exact pattern. The sandbox HTTP server dies often — just restart it.

## The #1 gotcha — internalize this or you WILL ship bugs
Gameplay elevation is **binary**: level `0` (street) or `1` (roof/platform), via
`levelAt(room,x,y)`. **Visual height is separate and purely cosmetic** — a building is *drawn*
lifted by `TIER_LIFT * tier.rise` px (TIER_LIFT=112), but it's still just level 1 on top. Rails
carry their own lift (constant `rise`, or variable `liftStart→liftEnd` along the rider's `u` for
climbs/off-routes). Bullets and auto-aim are **level-gated**: you can hit a same-or-lower-level
enemy, never one above you (`bullet.level >= enemy.level`). Nearly every "why is it floating / why
can't I hit it" bug is a lift/level mismatch between the draw side and the gameplay side.
Full detail: HANDOFF.md §3.

## Conventions
- **Match the surrounding code:** dense why-comments, small helpers, plain mutable objects in
  arrays (no classes for game state). No TypeScript/JSX. Don't reformat files you're editing.
- **No build / no deps.** Don't add a bundler, transpiler, or npm package without a very strong
  reason — `src/` shipping verbatim is the whole point.
- **Relative ES imports with extensions** (`./foo.js`). Keep the layering: `data/` is pure data and
  must not import from `systems/`; `systems/` consume `data/` + `rng`; `render/` reads `state` and
  draws, never mutating game logic.
- **Determinism:** room generation must pull randomness from the passed `rng` (mulberry32 / `Bag`),
  **never `Math.random()`** — that desyncs seeds. Cosmetic render/particle code may use `Math.random()`.
- **Filenames are case-sensitive in production** (Netlify/Linux). Files are camelCase
  (`roomRoller.js`, `itemEffects.js`, `hazardKits.js`). A wrong-case import "works" on a Mac and
  404s in prod.
- Tuning constants live in `src/config.js`; game content (biomes, enemies, items, patterns) lives
  in `src/data/`.

## Deploy
Static site, no compile — `netlify.toml` just assembles `dist/` from `index.html`+`src`+`assets`+
`_headers`. The HTML and JS module graph aren't content-hashed, so `_headers` must keep them
revalidating or a redeploy serves stale code. Also embedded at `qualiacology.com/rocket-shoes/`
(all refs are relative, so it works at any subpath).
