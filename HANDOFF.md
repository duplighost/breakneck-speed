# Breakneck Speed — Handoff / Agent Guide

A handoff for whoever (or whatever) picks this up next. Read this top-to-bottom once;
it'll save you an afternoon of spelunking. Written for a coding agent or a developer
landing cold.

---

## 0. TL;DR

- **What:** *Breakneck Speed* (a.k.a. *Rocket Shoes*) — a fast top-down neon-cyberpunk
  arcade game. Strap on rocket boots, grind glowing rails up and across a procedurally
  generated city, dash through enemies, chase combos, never stop moving.
- **Stack:** Vanilla JS **ES modules**, HTML5 **Canvas 2D**, **Web Audio** (procedural).
  **No build step, no dependencies, no framework, no bundler.** The files you edit are the
  files that ship.
- **Entry:** `index.html` → `<script type="module">import { boot } from './src/main.js'`.
- **Run it:** serve the repo root over HTTP and open it (ES modules don't load from
  `file://`):
  ```sh
  python3 -m http.server 8000      # or: npx serve .   /   any static server
  # open http://localhost:8000/
  ```
- **Current version:** see `VERSION` in `src/config.js` (`2.6.0-breakneck-skyline`).
- **~13k LOC** across `src/`. The two giants are `render/draw.js` (~2.4k) and
  `systems/roomRoller.js` (~2.2k).

There is **no `docs/` directory** — some source comments reference `docs/architecture.md`,
`docs/no-moon-systems.md`, `docs/boon-moots-notes.md`. Those are lineage notes from the
games this evolved from; they are **not in this repo**. This file is the architecture doc now.

---

## 1. Repo layout

```
index.html            entry HTML: the canvas, the DOM overlay/HUD, the module <script>
_headers              Netlify cache rules (revalidate the HTML + JS so redeploys win)
netlify.toml          "build" = assemble dist/ from index.html+src+assets (no compile)
src/
  main.js             boot(), the rAF game loop, input wiring, window.oneRoomDebug (debug API)
  config.js           ALL tuning constants + VERSION. Start here to change feel.
  state.js            the global `state` object + `newRun()` + save/persistence
  rng.js              seeded RNG (mulberry32), Bag (no-repeat deck), math helpers (clamp, dist, norm, damp)
  data/               PURE DATA tables (no logic, no imports from systems/). The "content".
    biomes.js enemies.js bosses-ish… layouts.js floorplans.js patterns.js items.js
    mutators.js hazardKits.js lines.js
  systems/            GAME LOGIC. Consumes data/ + rng. The "rules".
    rooms.js          round lifecycle: transition → live → clear → portal → next
    roomRoller.js     THE generator. Builds a room per round (tiers, rails, vents, enemies…)
    director.js       wave budget + spawning + mini-boss/elite rolls
    player.js         movement, dash, auto-fire/aim, rails/grinds, air-hops, tricks
    enemies.js        enemy AI (8 archetypes) + mini-bosses + their attack patterns
    combat.js bullets.js breakables.js hazards.js
    score.js          combo, REDLINE, rings, STYLE RANK, rank streak
    items.js draft.js itemEffects.js shop.js pickups.js   (relics / build variety)
    levels.js         levelAt()/surfaceAt() — the binary ground/roof model (see §3)
    bosses.js events.js juice.js notices.js meta.js
  render/
    draw.js           the whole frame (see §4 for the draw order). World → screen.
    sprites.js        the player + enemy sprite drawing
    camera.js         follow cam + clamp; view.{W,H,DPR,scale,photoScale}
    particles.js      particles, floats (rising text), ripples, bursts
  audio/
    bgm.js            procedural music (intensity follows the action)
    sfx.js            WebAudio SFX (one `case` per sound in sfx())
  ui/
    input.js          keyboard / mouse / touch / gamepad → aim+move+dash
    overlays.js       DOM overlays: title, death recap, codex, shrine, HUD
assets/               sprites (moots/*.webp), boss cards, favicon, og + title art
```

**The one architectural rule:** `data/` is pure data and must not import from `systems/`.
`systems/` consume `data/` + `rng`. `render/` reads `state` and draws; it never mutates game
logic. Keep that and the codebase stays untangled.

---

## 2. The loop & state

- `boot()` (main.js) sets up the canvas, input, audio, the title screen, and `window.oneRoomDebug`,
  then starts a `requestAnimationFrame` loop.
- Each frame: advance timers → `updatePlayer` → `updateEnemies` → `updateBullets` →
  hazards/pickups/particles → `tickCombo`/`tickRedline`/`tickRings` → `drawFrame`.
- **`state`** (state.js) is the single source of truth:
  - `state.mode` — `'title' | 'play' | 'transition' | 'portalDraft' | 'pause' | 'dead'`
  - `state.run` — the active run (score, combo, round, player, REDLINE, bestCombo, sRanks, rankStreak…)
  - `state.run.player` — position, velocity, level, hp, dash state, `rail`, `air`, perks…
  - `state.room` — the current generated room (everything below in §3)
  - `state.save` — persisted across runs (bests, sparks, shrine unlocks, lifetime stats)
- **Determinism:** a run is seeded. `roomRoller` pulls every random choice from
  `run.rng` / no-repeat `Bag`s, so a seed reproduces the same rooms. **Don't call `Math.random()`
  in generation** — use the passed `rng`. (Render/particles may use `Math.random()` freely; they're
  cosmetic and not part of the seed.)

---

## 3. THE most important concept: the binary level system + visual lift

This trips up everyone. Read it twice.

- **Gameplay elevation is binary: level `0` (street) or level `1` (rooftop/platform).**
  `levelAt(room, x, y)` (systems/levels.js) tells you which. That's the whole collision model —
  there is no continuous z.
- **Visual height is separate and purely cosmetic.** A building (`tier`) is *drawn* lifted by
  `TIER_LIFT * tier.rise` pixels (`TIER_LIFT = 112` in config; `rise` ~1–2.5 normally, up to ~5 for
  spire skyscrapers). Taller-looking ≠ a different gameplay level. It's still just level 1 on top.
- In `drawFrame`, every drawable is pushed to a `renderables` list with `{ y, lv (level), lift, draw }`,
  sorted by `(level, then y)`, and drawn with `ctx.translate(0, -lift)`. That painter's-sort is the
  fake-3D. The **shadow/footprint stays at world `(x,y)`; the sprite is raised by `lift`.**
- **Rails carry their own lift:**
  - normal **sky rail**: constant lift `TIER_LIFT * rail.rise` (roof-to-roof).
  - **off-routes** (skyway/underground) and **spiral climb-rails**: *variable* lift along the ride,
    `skywayLift(rail, u) = liftStart + (liftEnd-liftStart)*u`. The rider's height is computed from
    `u` (their 0→1 position along the rail). This is how you "climb."
- **Bullets are level-gated:** a player bullet hits an enemy iff `bullet.level >= enemy.level`
  (you can shoot *down* a level, never *up*). Auto-aim respects the same rule. Enemy bullets hit the
  player by the same comparison. If you add anything that "shoots," honor this or things will feel buggy.

If you ever see a sprite at the wrong height, it's almost always a `lift` mismatch between the
draw side and the gameplay-`level`/`rail` side.

### The room object (what `roomRoller` builds)
`tiers` (buildings, each with `ramp`), `obstacles` (incl. `ledge` walls with `tierId`), `vents`
(launch pads → hop to a roof/level), `skyRails` (straight, bowed, **spiral**, bridges, off-routes,
escape rail), `rings` (collectibles strung on rails), `flowLanes` (ground speed boulevards),
`districts` (named neighborhoods), `hazards`/`lanes`, `pickups`, `enemies` + `spawnQueue` +
`pendingWaves`, `portal`, `biome`, `mutator`, `weather`, and flags like `spire`, `bossId`.

---

## 4. Rendering pipeline (draw.js)

`drawFrame(room, pal, p)` paints back-to-front, roughly:

```
outer skyline → floor (baked bg) → floor motion → atmosphere/motes → flow lanes + traffic
→ ground surfaces → [renderables: obstacles/enemies/player sorted by level,y] is interleaved with:
edge rail → tiers (buildings) → holo ads → district holograms → rooftop surfaces
→ sky rails → climb rails (spirals) → rings → off-routes → sky life (aircraft/searchlights)
→ escape rail → setpieces → vents → hazards → boss arena fx → pickups
→ (the level/y-sorted sprite pass) → mini-boss bars → bullets → particles → floats
→ bloom composite → weather (rain+lightning / fog / snow / aurora) → REDLINE screen fx
→ speed streaks → minimap → HUD
```

- **Camera** (camera.js): follows the player, `clampCam` keeps it in bounds (with a margin).
  `view.photoScale` is a dev zoom override; `freeCam` is used for off-route rides that leave the map.
- **Bloom**: half-res screen-blend composite (cheap). Gated off under `reduced()` / `state.lowFx`.
- **Colors:** palettes are mostly hex, but some building skins are `hsl(...)` strings.
  `mix()`/`hexA()` were hex-only once and silently produced `NaN`/black — they're now hardened, but
  if you add color math, **bake to hex** (`colorToHex`) or test with `hsl()` inputs.

---

## 5. The mechanics, briefly (so you know what the systems mean)

- **Dash** (player.js `tryDash`): the centerpiece. Invincible, hits wide, refunds on kills. Tuning in
  `config.PLAYER` (`DASH_IMPULSE`, `DASH_DUR`, `DASH_HOMING_*`). A faint dash aim-assist curves you
  toward a near-dead-ahead enemy.
- **Auto-fire / auto-aim:** the gun fires on its own. With no manual aim it locks the nearest enemy
  you can legally hit (same-or-lower level); if enemies exist but none are hittable, it fires the way
  you're moving so shots always come out. Baseline shot homing is **deliberately tiny**
  (`SHOT_HOMING_*` in config) — the `hunterMycelia` relic is what makes shots actually track.
- **Rails / grinds** (player.js): edge rail (room perimeter), sky rails (roof-to-roof, some bowed),
  **spiral climb-rails** (wind up the spire towers), off-routes (skyway/underground → jackpot jewel),
  escape rail (victory-lap express to the portal on clear). Latching samples the *curve* for bowed/
  spiral rails (the straight chord is meaningless for a helix). Dash off the end at the right moment
  = **PERFECT** bonus.
- **Air tricks:** dash-vent hops backflip and land a STYLE bonus (`BACKFLIP` / `DOUBLE BACKFLIP`).
- **REDLINE** (score.js): a flow meter filled by dashing/grinding/kills; at full it ignites a few
  seconds of hyperspeed. The "reward for never stopping."
- **STYLE RANK + rank streak:** every room clear is graded S/A/B/C/D (combo, no-hit, skill moves,
  speed). Consecutive A+ clears chain an escalating bonus. Lifetime S-ranks persist.
- **Enemies** (enemies.js): 8 host archetypes (skitter/gunner/charger/turret/brute/sniper/hexer/
  myrmidon) with simple state-machine AI. **Mini-bosses** (`data/enemies.js MINIBOSSES`) reuse a host
  AI + buffs + a signature `pattern` (slamRings, dashVolley, orbitRing, crossfire, spiral, summon,
  ringGap, sweep, chargeBurst…). **Bosses** are bespoke (bosses.js).
- **Director** (director.js): scales an enemy budget to room size, fires `pendingWaves`, rolls
  mini-bosses + the rare **ELITE RUSH** gauntlet.
- **The Spire District** (`room.spire`, ~1 in 6 rooms from round 4): towers become skyscrapers
  wrapped in spiral climb-rails, linked at the summit by sky-bridges, rings up each climb, **updraft
  vents** (express elevators) at each base, and a **Spire Warden** elite perched on the tallest roof
  as the mandatory capstone. Force it with `oneRoomDebug.spire()`.
- **Build variety:** items/relics (draft.js, itemEffects.js, `hooks` event bus), a room shop,
  rare floor **mutators** (`data/mutators.js`), biomes (`data/biomes.js`).
- **Audio:** `sfx(name)` is a `switch` of WebAudio recipes (add a `case`); `bgm.js` ramps musical
  intensity with the action (REDLINE/mini-bosses crank it).

---

## 6. The debug API — `window.oneRoomDebug` (your best friend)

Open the browser console (or drive it headlessly, see §7). Everything inspectable/forceable:

| call | does |
|---|---|
| `start(seed?)` | start a run (optional seed → reproducible) |
| `state()` | JSON snapshot (version, mode, run/room summaries, save) |
| `live()` | the **raw** `state` object — mutate it directly in tests |
| `skipRound()` | jump to the next room |
| `spire()` | force the next room to be a **Spire District**; returns `{spire, spirals, rings}` |
| `roll(n)` | headlessly generate `n` rooms, return per-room axis summary + reachability (the audit backbone). Includes biome/layout/mutator/tiers/rails/rings/vents/portalReachable |
| `tp(x,y,level)` | teleport the player |
| `photo(scale)` | dev camera zoom (e.g. `0.3` to see a whole room; `null` to clear) |
| `killAll()` | kill every enemy in the room |
| `miniboss(i)` | spawn mini-boss index `i` at room center |
| `grant(id)` | grant an item/relic by id |
| `pick(i)` | pick a portal-draft card |
| `lineup()` | freeze one of each enemy type in a row (sprite QA) |
| `mapPNG()` | the baked floor as a data URL |
| `selfTest()` | UI/perf check (tiny tap targets, frame p95, overflow) |
| `sfxTest()` | play a sound |

---

## 7. Testing / verifying changes (do this — the game has no unit tests)

The reliable pattern is a **headless browser + `oneRoomDebug`**. Load the page, wait for the API,
drive it, assert on `live()`/`state()`, screenshot if visual. Example (Playwright/Puppeteer):

```js
await page.goto('http://localhost:8000/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.oneRoomDebug?.version);
const audit = await page.evaluate(() => {
  window.oneRoomDebug.start('audit');
  const { rooms } = window.oneRoomDebug.roll(40);     // generate 40 rooms
  return {
    unreachablePortals: rooms.filter(r => !r.portalReachable).length,
    avgTiers: rooms.reduce((s,r)=>s+r.tiers,0)/rooms.length,
  };
});
// also: page.on('pageerror', ...) to catch runtime errors
```

The repo's `_extracted/*.mjs` are real examples of this (`audit.mjs` = 40-room reachability +
0-page-errors; `realplay2.mjs` = scripted keyboard play; plus per-feature checks like `perfect`,
`airtrick`, `rank`, `streak`, `minibosses`, `eliterush`, `autofire`, `offroutes`). **`_extracted/`
is gitignored and uses sandbox-specific absolute paths** — treat it as reference, not a suite.

**Minimum bar before committing a change:**
1. `node --check <file>` every file you touched (catches syntax fast).
2. `roll(40)` → **0 unreachable portals, 0 page errors** (generation didn't break).
3. A scripted real-play step (move/dash a few seconds) → **0 page errors**.
4. If it's visual, screenshot it and actually look.

The HTTP server in a sandbox **dies a lot** — restart it (`python3 -m http.server 8000`) when you
get `ERR_CONNECTION_REFUSED`.

---

## 8. Conventions & footguns

- **Match the surrounding code.** Dense, comment-the-why one-liners; small helpers; no classes for
  game objects (plain mutable objects in arrays). No TypeScript, no JSX. Mirror the existing
  formatting (semicolons, 2-space indent) rather than reformatting files.
- **No build.** Don't introduce a bundler/transpiler/npm dep without a very good reason — the whole
  point is that `src/` ships verbatim.
- **Relative ES imports only** (`./foo.js`, with the extension). Keep the `data/` ↔ `systems/` rule.
- **Filenames are case-sensitive in production** (Netlify/Linux). The files are camelCase
  (`roomRoller.js`, `itemEffects.js`, `hazardKits.js`). If you develop on a Mac, beware: an import
  with the wrong case "works" locally and 404s in prod.
- **Determinism in generation** — use the passed `rng`, never `Math.random()`, or you desync seeds.
- **Mutating shared arrays mid-iteration** (bullets/enemies splicing) — the existing loops guard for
  it (`if (!b) continue;`). Keep that defensiveness if you add similar loops.
- **`reduced()` / `state.lowFx`** gate expensive FX — respect them in new render code.
- The **level/lift split (§3)** is the single biggest source of "why is it floating / why can't I hit
  it" bugs. When in doubt, log `p.level`, the rail's `rise`/`liftStart`/`liftEnd`, and `liftAt`.

---

## 9. Deployment

- **Standalone:** it's a static site; any host works. Currently live at `breakneck-speed.netlify.app`.
  `netlify.toml` assembles a clean `dist/` (just `index.html`+`src`+`assets`+`_headers`) so the deploy
  never drags in dev folders. No compile.
- **Embedded** on `qualiacology.com/rocket-shoes/` — the game's `index.html` canonical already points
  there and all its refs are relative (`./src`, `./assets`), so it drops into any subpath. The site's
  `_headers` revalidates `/rocket-shoes/index.html` + `/rocket-shoes/src/*` so a redeploy wins
  immediately (no stale-module mismatch).
- The cache lesson, generally: the HTML + JS module graph are **not** content-hashed, so they must be
  set to revalidate or browsers/CDNs serve an old build after a redeploy.

---

## 10. Current state / recent additions

Latest work (so you're not surprised): the **Spire District** (spiral climb-rails + sky-bridges +
updraft elevators + Spire Warden), **STYLE RANK + rank streak**, **PERFECT rail dismounts**, **air
backflip tricks**, four replay **mutators** (GOLD RUSH / ELITE STORM / RING RUSH / REDLINE CITY),
two mini-bosses (**The Aperture** ring-gap, **Lighthouse** sweep), the **ELITE RUSH** gauntlet payoff,
a **death recap**, a drifting **advertising airship**, plus feel-tuning passes (gentler dash/shot
homing, shorter dash, fewer/softer vents) and the **auto-fire cross-level fix**. All verified via the
headless `roll(40)` audit + per-feature checks.

---

## 11. "Could you make it an FPS?" — read before you try 😄

Honest scoping, because the request will come up:

**What's a near-total rewrite:** everything in `render/` (it's a 2D top-down `Canvas2D` painter), the
**binary level + visual-lift** model (§3 — an FPS needs real 3D z), all rail/grind geometry and the
camera, and the input/aim layer (mouse-look + a first-person camera instead of top-down aim). You'd
stand up a real 3D renderer (WebGL, probably **Three.js**) and a first-person controller. That is the
bulk of the game's code by line count.

**What can largely carry over (the game's actual DNA):** the **content/data tables** (`data/*` —
biomes, enemy archetypes, attack patterns, items, mutators, lines), the **wave director**, the
**enemy AI state machines** (retargeted to 3D positions), the **item/relic + draft** system and its
`hooks` event bus, the **score/combo/REDLINE/rank** loop, the **procedural audio**, and the overall
"never stop moving, grind→dash→combo" design language. The *systems* are mostly 2D-vector math that
ports; the *rendering and spatial model* do not.

**If you really want to try:** don't fork the renderer in place — start a parallel `render3d/` + a new
entry, keep `data/` and the score/director/item systems as the shared brain, and replace the spatial
layer (positions become `{x,y,z}`, "level" becomes real height, rails become 3D splines you already
have the parametric math for in `skyRailPoint`). It's a fun project; it's just a *new game wearing
this one's content*, not a flag you flip.

Good luck. Keep it breakneck.
