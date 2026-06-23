// THE generator. Deals one card per axis from no-repeat bags, cross-checks the
// axes, builds the room object, and bakes its background once. Consumes only
// data/ + rng (architecture.md §4 rule 2).
import { ROOM, TAU, TIER_LIFT } from '../config.js';
import { makeEnemy } from './enemies.js';
import { Bag, clamp, dist, rand, randi, chance, pick, mulberry32, hashString } from '../rng.js';
import { BIOMES, BIOMES_BY_TIER, tierForRound } from '../data/biomes.js';
import { LAYOUTS, LAYOUT_IDS } from '../data/layouts.js';
import { paintPattern, paintSignature } from '../data/patterns.js';
import { SPECIES } from './breakables.js';
import { seedHazards } from './hazards.js';
import { buildWaves, availableRecipes, dangerStage, depthIdx, RECIPES } from './director.js';
import { view } from '../render/camera.js';
import { ANNEX } from '../config.js';
import { rollEvent } from './events.js';
import { stacks } from './items.js';
import { bossForRound } from './bosses.js';
import { MUTATORS } from '../data/mutators.js';
import { MINIBOSSES } from '../data/enemies.js';
import { FLOORPLANS, FLOORPLAN_IDS } from '../data/floorplans.js';
import { seedRoomShop } from './shop.js';

// ── DEVICE PARITY ──────────────────────────────────────────────────────────
// The top-down game plays IDENTICALLY on phone and desktop: same map sizes, the same
// rooftop lattice + sky rails, the same district density. The generator used to shrink
// and thin everything on mobile — that's what made phones feel like a different, smaller
// game. With parity on, `genMobile()` reports false everywhere in generation, so every
// device rolls the desktop world. (Only two things stay screen-aware, on purpose: the
// camera zoom in camera.js — a small screen needs it — and the baked-texture memory cap
// in chooseBackgroundScale. Neither changes the actual map.) Set MOBILE_PARITY = false
// to restore the old lighter phone profile.
const MOBILE_PARITY = true;
function genMobile() { return view.mobile && !MOBILE_PARITY; }

export function rollRoom(run, round) {
  const rng = run.rng;
  const bags = run.bags;

  // ── axis 1: biome (tier-banded bag) ──
  const tier = tierForRound(round, run.overdrive);
  const tierKey = 'biome_' + tier;
  if (!bags[tierKey]) {
    const ids = tier === 'any' ? BIOMES.map(b => b.id) : BIOMES_BY_TIER[tier].map(b => b.id);
    bags[tierKey] = new Bag(ids, tier === 'any' ? 2 : 1);
  }
  const dealtBiomeId = bags[tierKey].deal(rng);
  const biome = BIOMES.find(b => b.id === dealtBiomeId);

  // ── axis 2+4: layout & recipe (recipe first: density cross-check) ──
  if (!bags.layout) bags.layout = new Bag(LAYOUT_IDS, 2);
  if (!bags.recipe) bags.recipe = new Bag(Object.keys(RECIPES), 1);
  const avail = availableRecipes(round);
  let recipeId = 'mixed';
  for (let i = 0; i < 8; i++) {
    const r = bags.recipe.deal(rng);
    if (avail.includes(r)) { recipeId = r; break; }
  }
  const bossId = bossForRound(round, run.overdrive);
  const layoutId = bossId ? pick(rng, ['ring', 'crossroads']) : bags.layout.deal(rng);

  // ── axis 6: mutator (rare, loud) ──
  // Big rooms need occasional rule-spice, but pure 10% RNG can ghost the run for
  // ages. Add a quiet pity counter so the system stays rare without becoming
  // invisible in unlucky seeds.
  let mutator = null;
  if (!bossId && round >= 5) {
    run.sinceMutator = run.sinceMutator ?? 0;
    // pity 12 (not 8): keeps the effective mutator rate ~10.6% — rare but never
    // ghosting a run. Deliberately tuned last session; kept over the base's 8.
    const forceMutator = run.sinceMutator >= 12;
    if (forceMutator || chance(rng, 0.10)) {
      mutator = MUTATORS[Math.floor(rng() * MUTATORS.length)];
      run.sinceMutator = 0;
    } else run.sinceMutator++;
  }
  const sizeScale = mutator?.sizeScale || 1;

  // ── the SPIRE DISTRICT: a vertical skyscraper playground — towers wrapped in spiral
  // climb-rails, linked at the summit by sky-bridges. A rare, distinct place in the world.
  const forceSpire = !!run._forceSpire; if (run) run._forceSpire = false;
  const spire = !bossId && (forceSpire || (round >= 4 && chance(rng, 0.16)));

  const portrait = genMobile() && view.portrait;
  // Giant sprawl on desktop; phones pull the landscape size back (portrait stays modest).
  // Safe to go big: floor/lanes are viewport-culled and the enemy budget is already capped.
  const deviceScale = genMobile() ? (portrait ? 1 : 0.7) : 1;
  const room = {
    round, idx: depthIdx(round), stage: dangerStage(round, run.overdrive),
    biome, layoutId, recipeId, mutatorId: mutator?.id || null, mutator, eventId: null, bossId, spire,
    floorplanId: 'none', openings: [], sanctum: null, tiers: [], vents: [], setpieces: [],
    surfaces: [], escapeRail: null,
    districts: [], flowLanes: [], skyRails: [], skyways: [], offRoutes: [], rings: [], signs: [], traffic: [], waypoints: [], districtName: '', districtSubtitle: '', backgroundScale: 1,
    weather: pick(rng, ['rain', 'rain', 'fog', 'snow', 'clear', 'clear']), // drawn in draw.js (rain/fog/snow)
    // XL city-scale sprawl — bigger than either fork. Density (cover, rooftops, rails,
    // surfaces, landmarks, enemy budget) all scale with area below so it stays packed.
    // Bigger arenas (~25% up): more room to grind, build, and hide secrets in.
    w: Math.round((portrait ? rand(rng, 3200, 3900) : rand(rng, bossId ? 6400 : 8700, bossId ? 7600 : 11000)) * sizeScale * deviceScale),
    h: Math.round((portrait ? rand(rng, 4500, 5600) : rand(rng, bossId ? 4900 : 6200, bossId ? 6100 : 7700)) * sizeScale * deviceScale),
    wall: ROOM.WALL,
    obstacles: [], landmarks: [], annex: null, hazards: [], lanes: [], edgeRail: { phase: rng() * TAU },
    enemies: [], bullets: [], pickups: [], particles: [], floats: [],
    ambient: [], spawnQueue: [], pendingWaves: null, spawnAnchors: [],
    cleared: false, clearT: 0, portal: null, time: 0,
    background: null,
  };
  const px = room.w / 2, py = room.h * 0.66; // player spawn
  const portalX = room.w / 2, portalY = room.h * 0.20;

  // ── neon districts + flow lanes (the sprawl reads as a city) — seeded BEFORE the
  // cover scatter so obstacles can keep clear of the boost boulevards. ──
  room.districtName = rollDistrictName(room, rng);
  room.districtSubtitle = rollDistrictSubtitle(room, rng);
  seedDistricts(room, rng, px, py, portalX, portalY);
  seedFlowLanes(room, rng, px, py, portalX, portalY);
  seedCityDressing(room, rng, px, py, portalX, portalY);

  // ── floorplan (Phase 8a): partition walls before the cover scatter ──
  if (!bags.floorplan) bags.floorplan = new Bag(FLOORPLAN_IDS, 2);
  // Weighted open-room roll happens outside the Bag. Duplicate 'none' cards get
  // suppressed by Bag recent-history, so this is the honest way to control partition rate.
  // 0.38 → ~62% of non-boss rooms get chambers (player likes the walls). Dial up for fewer.
  const openChance = 0.74;
  let floorplanId = (bossId || chance(rng, openChance)) ? 'none' : bags.floorplan.deal(rng);
  if (floorplanId !== 'none') {
    const plan = FLOORPLANS[floorplanId](room, rng, room.idx);
    const trial = plan.walls;
    // place, then validate: spawn must be clear of walls and the portal reachable
    const spawnInWall = trial.some(o => px > o.x - 24 && px < o.x + o.w + 24 && py > o.y - 24 && py < o.y + o.h + 24);
    room.obstacles.push(...trial);
    const reach = reachableFrom(room, px, py);
    if (spawnInWall || !reach.has(portalX, portalY)) {
      room.obstacles.length = 0;   // fall back to an open room rather than risk a softlock
      floorplanId = 'none';
    } else {
      room.openings = plan.openings;
      room.sanctum = plan.sanctum || null;
    }
  }
  room.floorplanId = floorplanId;
  const partitioned = floorplanId !== 'none';

  // ── axis 2 continued: obstacles from the layout generator ──
  const density = (RECIPES[recipeId]?.density || 0);
  // Big rooms need a visual/combat anchor before scatter, so cover arranges around
  // a designed thing instead of confetti. Validated later with the same reachability audit.
  const landmark = !bossId && chance(rng, partitioned ? 0.55 : 0.92) && placeLandmark(room, rng, px, py, portalX, portalY);
  // cover scales ~linearly with area so density holds across the much bigger floor
  // (kept moderate — the sprawl reads full from ambient/decals/enemies, not a cover maze).
  const areaBonus = Math.max(2, Math.round((roomAreaScale(room) - 1) * 6));
  // cap scales with area so cover density holds across the much bigger sprawl.
  // Measured trim for legibility: ~20% less cover than the website build (still WAY
  // denser than a clean-slate map), so the playfield reads without going to cubicle hell.
  const coverCap = Math.round((partitioned ? 18 : 24) * clamp(roomAreaScale(room) / 5.6, 1, 1.5));
  const count = clamp(6 + density + Math.floor(areaBonus * 0.62) + Math.floor(room.stage * 0.4) + randi(rng, 0, 1)
    - (partitioned ? 2 : 0) - (landmark ? 2 : 0), partitioned ? 4 : 6, coverCap);
  const spots = LAYOUTS[layoutId](room, rng, count);
  for (const s of spots) {
    if (dist(s.x, s.y, px, py) < ROOM.SPAWN_CLEAR) continue;
    let o;
    if (s.rect) {
      const w = s.wide ? rand(rng, 155, 260) : s.tall ? rand(rng, 72, 112) : rand(rng, 105, 210);
      const h = s.tall ? rand(rng, 155, 260) : s.wide ? rand(rng, 66, 108) : rand(rng, 72, 132);
      o = { type: 'rect', x: s.x - w / 2, y: s.y - h / 2, w, h, style: biome.obstacleStyle, round: 16 };
    } else {
      o = { type: 'circle', x: s.x, y: s.y, rad: s.big ? rand(rng, 66, 96) : rand(rng, 40, 70), style: biome.obstacleStyle };
    }
    if (!fits(room, o)) continue;
    room.obstacles.push(o);
  }
  // placement hygiene can reject spots; guarantee a minimum of cover
  for (let tries = 0; room.obstacles.length < (partitioned ? 5 : 7) && tries < 50; tries++) {
    const o = {
      type: 'circle', x: rand(rng, room.wall + 150, room.w - room.wall - 150),
      y: rand(rng, room.wall + 140, room.h - room.wall - 170),
      rad: rand(rng, 42, 66), style: biome.obstacleStyle,
    };
    if (dist(o.x, o.y, px, py) < ROOM.SPAWN_CLEAR || !fits(room, o)) continue;
    room.obstacles.push(o);
  }

  // Big-room architecture: short ribs, cracked barricades, landmarks, dash bells, and soft rubble.
  // These are validated for portal reachability, so they add traversal decisions without softlocks.
  addRoomStructures(room, rng, px, py, portalX, portalY, partitioned, !!landmark);
  const forceRubble = !bossId && !partitioned && !landmark;
  // less scattered rubble (it was a big chunk of the visual confetti / micro-collision)
  if (!bossId && (forceRubble || chance(rng, partitioned ? 0.24 : 0.34))) rubbleField(room, rng, px, py, portalX, portalY);

  // ── elevation: more second-layer rooms, plus vent launchers to make climbing
  // feel like movement tech instead of just walking at a ramp.
  seedVerticality(room, rng, px, py, portalX, portalY, partitioned);
  if (room.tiers.length) seedVents(room, rng, px, py, portalX, portalY);
  if (room.tiers.length) seedSkyRails(room, rng);
  if (room.skyRails.length) seedRailRings(room, rng);
  if (room.spire && room.tiers.length >= 2) seedSpireDistrict(room, rng, px, py, portalX, portalY);
  if (!bossId && room.tiers.length) seedHighGroundRewards(room, rng);
  seedSurfaces(room, rng, px, py, portalX, portalY);
  seedDistrictLandmarks(room, rng, px, py, portalX, portalY);
  seedLandmarkProps(room, rng, px, py, portalX, portalY);
  if (!bossId) seedRoomShop(room, rng, run, px, py, portalX, portalY);

  // ── glass biomes furnish breakable chain-glass (the shard/volatile projectile
  // hazard is retired; this cover IS their identity now — shoot or dash one and the
  // blast chains to its neighbours). Breakable circles never block reachability. ──
  if (biome.hazard === 'volatile' || biome.hazard === 'shard') {
    const n = randi(rng, 3, 5);
    for (let i = 0; i < n; i++) {
      const o = {
        type: 'circle', x: rand(rng, room.wall + 130, room.w - room.wall - 130),
        y: rand(rng, room.wall + 120, room.h - room.wall - 150),
        rad: rand(rng, 18, 26), style: 'glassNode',
        breakable: true, species: 'volatileShard', hp: SPECIES.volatileShard.hp, volatile: true,
      };
      if (dist(o.x, o.y, px, py) < 220 || !fits(room, o)) continue;
      room.obstacles.push(o);
    }
  }

  // ── biomes that lost their area hazard furnish breakable biome-styled cover in
  // its place, so they stay as furnished as the altar/laser biomes. Covers the
  // snare/thorn projectile-roots AND the removed fog/spore gas clouds (fen/mycelium)
  // — not the gas mechanic, just native furniture. rollSpecies already biases these
  // plant/fungal/bone biomes toward rootCyst/marrowJar, so the cover reads native. ──
  const COVER_FROM_HAZARD = new Set(['snare', 'thorn', 'fog', 'spore']);
  if (!bossId && COVER_FROM_HAZARD.has(biome.hazard)) {
    const n = randi(rng, 2, 4) + (room.idx >= 4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      for (let tries = 0; tries < 18; tries++) {
        const species = rollSpecies(rng, biome, room.idx, false);
        const o = {
          type: 'circle', x: rand(rng, room.wall + 130, room.w - room.wall - 130),
          y: rand(rng, room.wall + 120, room.h - room.wall - 150),
          rad: rand(rng, 34, 56), style: biome.obstacleStyle,
          breakable: true, species, hp: SPECIES[species].hp + room.idx * 0.6,
        };
        if (dist(o.x, o.y, px, py) < ROOM.SPAWN_CLEAR || dist(o.x, o.y, portalX, portalY) < 150 || !fits(room, o)) continue;
        room.obstacles.push(o);
        break;
      }
    }
  }

  // ── breakable conversion (species weights with biome bumps) ──
  const breakN = randi(rng, 1, 3) + (mutator?.breakBonus || 0);
  const candidates = room.obstacles.filter(o => !o.breakable && !o.landmark && o.type === 'circle' && o.rad < 72);
  for (let i = 0; i < breakN && candidates.length; i++) {
    const o = candidates.splice(Math.floor(rng() * candidates.length), 1)[0];
    o.breakable = true;
    o.species = rollSpecies(rng, biome, room.idx, mutator?.idolBump);
    o.hp = SPECIES[o.species].hp + room.idx * 0.8;
  }

  // ── sealed mystery vaults: obvious smashable shells whose contents are hidden until broken. ──
  if (!bossId) seedMysteryVaults(room, rng, px, py, portalX, portalY);

  // ── sealed annex (skip when a floorplan already partitions the room) ──
  const compass = stacks(run.player, 'cacheCompass');
  const annexChance = ANNEX.CHANCE + compass * 0.12;
  if (!bossId && !partitioned && chance(rng, annexChance)) buildAnnex(room, rng);

  // ── secret #1: a straight dash-run through the clouds to a power gem. Only a DASH
  // punches through the cloud gates; the prize sits in a sealed pocket at the far end. ──
  if (!bossId) seedCloudRun(room, rng, px, py, portalX, portalY);

  // ── secret #2: the SKYWAY — grind a rail off a rooftop, off the map, into open sky;
  // dash the sentinel gauntlet and grab the jackpot jewel at the apex. ──
  if (!bossId && room.tiers.length) seedSkyway(room, rng, px, py, portalX, portalY);

  // ── secret #3: the UNDERGROUND — a street pit whose grind rail dives off the map, DOWN
  // into a dark cavern to a buried jewel. The skyway's mirror. ──
  if (!bossId) seedUnderground(room, rng, px, py, portalX, portalY);

  // ── axis 3: hazard kit ──
  seedHazards(room, rng);
  if (mutator?.extraLane) {
    const pos = rand(rng, room.wall + 220, room.w - room.wall - 220);
    room.lanes.push({
      type: 'sightline', vertical: true, x1: pos, y1: room.wall + 40, x2: pos, y2: room.h - room.wall - 40,
      width: 26, t: rng() * 2, period: 3.2, telegraphFrom: 0.40, activeFrom: 0.74, activeTo: 0.98,
      active: false, tele: false, hitCd: 0, color: biome.pal.accent2,
    });
  }

  // ── ambient particles ──
  // ambient drift fills the sprawl with life (the cheap, non-obstructive kind of "full")
  const ambN = Math.round((genMobile() ? 48 : 96) * Math.min(4.2, Math.sqrt(roomAreaScale(room))));
  for (let i = 0; i < ambN; i++) {
    room.ambient.push({
      type: pick(rng, biome.ambient), x: rng() * room.w, y: rng() * room.h,
      vx: rand(rng, -12, 12), vy: rand(rng, -18, 8), phase: rng() * TAU, r: rand(rng, 1.5, 4),
    });
  }

  // ── axis 4: waves ──
  buildWaves(room, rng);
  if (room.spire) seedSpireEnemies(room, rng); // summit Warden + rooftop sentinels (needs pendingWaves)

  // ── axis 5: room event (the spice slot) ──
  rollEvent(room, rng);
  pruneUnreachableTiers(room, px, py);
  ensureMinimumVerticality(room, rng, px, py, portalX, portalY);
  sanitizePendingSpawns(room, rng, px, py, portalX, portalY);
  retargetFlowLanes(room, rng, px, py, portalX, portalY);

  // ── bake the background once ──
  room.background = bakeBackground(room, rng);
  return room;
}

const OLD_ROOM_AREA = 1500 * 1020;
function roomAreaScale(room) { return (room.w * room.h) / OLD_ROOM_AREA; }

function architecturalWall(x, y, w, h, breakable, idx) {
  const o = { type: 'rect', x, y, w: Math.max(12, w), h: Math.max(12, h), wall: true, ledgeHeight: Infinity, style: breakable ? 'door' : 'wall', round: breakable ? 4 : 5 };
  if (breakable) Object.assign(o, { breakable: true, species: 'wallSegment', hp: 8 + idx * 1.6 });
  return o;
}

function clearOfPoint(o, x, y, pad) {
  const b = aabb(o);
  const cx = clamp(x, b.x, b.x + b.w), cy = clamp(y, b.y, b.y + b.h);
  return dist(x, y, cx, cy) > pad;
}

function tryAddGroup(room, group, px, py, portalX, portalY) {
  const before = room.obstacles.length;
  for (const o of group) {
    const spawnPad = o.wall ? (o.breakable ? 300 : 335) : 285;
    if (!clearOfPoint(o, px, py, spawnPad) || !clearOfPoint(o, portalX, portalY, o.wall ? 150 : 120) || !fits(room, o, o.wall ? 28 : 22)) {
      room.obstacles.length = before;
      return false;
    }
    room.obstacles.push(o);
  }
  const reach = reachableFrom(room, px, py);
  if (!reach.has(portalX, portalY)) { room.obstacles.length = before; return false; }
  return true;
}

function addRoomStructures(room, rng, px, py, portalX, portalY, partitioned, hasLandmark = false) {
  const target = room.bossId ? 1 : partitioned ? 1 : (hasLandmark ? 1 : 2);
  const tries = room.bossId ? 4 : partitioned ? 7 : 12;
  let placed = 0;
  const kinds = partitioned ? ['island', 'barricade', 'pillarCrown'] : ['ribGate', 'barricade', 'brokenSpine', 'island', 'pillarCrown'];
  for (let t = 0; t < tries && placed < target; t++) {
    const group = makeStructureGroup(room, rng, pick(rng, kinds));
    if (group.length && tryAddGroup(room, group, px, py, portalX, portalY)) {
      placed++;
      room.landmarks.push({ kind: group[0].archKind || 'structure', x: group.reduce((a, o) => a + (o.x || 0) + (o.w || 0) / 2, 0) / group.length, y: group.reduce((a, o) => a + (o.y || 0) + (o.h || 0) / 2, 0) / group.length });
    }
  }

  if (!room.bossId) {
    const bells = chance(rng, 0.56) ? 1 + (roomAreaScale(room) > 1.8 && chance(rng, 0.12) ? 1 : 0) : 0;
    for (let i = 0; i < bells; i++) placeDashBell(room, rng, px, py, portalX, portalY);
  }
}

function makeStructureGroup(room, rng, kind) {
  const cx = rand(rng, room.w * 0.28, room.w * 0.72);
  const cy = rand(rng, room.h * 0.26, room.h * 0.58);
  const idx = room.idx;
  const style = room.biome.obstacleStyle;
  if (kind === 'ribGate') {
    const gap = rand(rng, 245, 350), len = rand(rng, 235, 370), thick = rand(rng, 24, 34);
    const a = architecturalWall(cx - gap / 2 - thick, cy - len / 2, thick, len, false, idx);
    const b = architecturalWall(cx + gap / 2, cy - len / 2, thick, len, false, idx);
    a.archKind = b.archKind = 'ribGate';
    return [a, b];
  }
  if (kind === 'brokenSpine') {
    const horizontal = chance(rng, 0.55), n = 3, out = [];
    const len = rand(rng, 145, 220), thick = rand(rng, 24, 32), gap = rand(rng, 96, 132);
    for (let i = 0; i < n; i++) {
      const off = (i - 1) * (len + gap);
      const breakable = i === 1 && chance(rng, 0.65);
      const o = horizontal
        ? architecturalWall(cx + off - len / 2, cy - thick / 2, len, thick, breakable, idx)
        : architecturalWall(cx - thick / 2, cy + off - len / 2, thick, len, breakable, idx);
      o.archKind = 'brokenSpine'; out.push(o);
    }
    return out;
  }
  if (kind === 'barricade') {
    const horizontal = chance(rng, 0.5), len = rand(rng, 250, 410), thick = rand(rng, 25, 34);
    const o = horizontal
      ? architecturalWall(cx - len / 2, cy - thick / 2, len, thick, true, idx)
      : architecturalWall(cx - thick / 2, cy - len / 2, thick, len, true, idx);
    o.archKind = 'barricade';
    return [o];
  }
  if (kind === 'pillarCrown') {
    const out = [];
    const rad = rand(rng, 58, 78), rr = rand(rng, 150, 225), start = rng() * TAU;
    for (let i = 0; i < 3; i++) {
      const a = start + (i / 3) * TAU;
      out.push({ type: 'circle', x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * 0.72, rad, style, archKind: 'pillarCrown' });
    }
    return out;
  }
  // island: one big readable landmark plus a small smashable satellite
  return [
    { type: 'circle', x: cx, y: cy, rad: rand(rng, 78, 106), style, archKind: 'island' },
    { type: 'circle', x: cx + rand(rng, -150, 150), y: cy + rand(rng, -115, 115), rad: rand(rng, 38, 52), style: 'basilicaIdol', breakable: true, species: rollSpecies(rng, room.biome, idx, false), hp: 4 + idx * 0.7, archKind: 'island' },
  ];
}

function placeDashBell(room, rng, px, py, portalX, portalY) {
  for (let tries = 0; tries < 50; tries++) {
    const o = {
      type: 'circle', x: rand(rng, room.wall + 190, room.w - room.wall - 190),
      y: rand(rng, room.wall + 160, room.h - room.wall - 190),
      rad: rand(rng, 28, 36), style: 'basilicaIdol', breakable: true,
      species: 'dashBell', hp: SPECIES.dashBell.hp + room.idx * 0.35, archKind: 'dashBell',
    };
    if (dist(o.x, o.y, px, py) < ROOM.SPAWN_CLEAR + 70 || dist(o.x, o.y, portalX, portalY) < 150 || !fits(room, o, 28)) continue;
    room.obstacles.push(o);
    room.landmarks.push({ kind: 'dashBell', x: o.x, y: o.y });
    return true;
  }
  return false;
}

function pointBlockedForSpawn(room, x, y, pad = 42) {
  const a = room.annex;
  if (a && !a.opened && a.rect && x > a.rect.x - pad && x < a.rect.x + a.rect.w + pad && y > a.rect.y - pad && y < a.rect.y + a.rect.h + pad) return true;
  for (const o of room.obstacles) {
    if (o.gone) continue;
    if (o.type === 'circle') { if (dist(x, y, o.x, o.y) < o.rad + pad) return true; }
    else {
      const cx = clamp(x, o.x, o.x + o.w), cy = clamp(y, o.y, o.y + o.h);
      if (dist(x, y, cx, cy) < pad) return true;
    }
  }
  return false;
}

function findReachableSpawn(room, rng, reach, px, py) {
  const legal = (x, y, minD = 420) => dist(x, y, px, py) >= minD && pointBlockedForSpawn(room, x, y) === false && reach.has(x, y);
  // Most anchors are near the boost lanes. Huge maps stay exciting only when
  // combat spawns in the movement network, not in quiet corners the player has to search.
  for (let tries = 0; tries < 70 && room.flowLanes?.length; tries++) {
    const l = pick(rng, room.flowLanes);
    const at = rand(rng, 0.08, 0.92), dx = l.x2 - l.x1, dy = l.y2 - l.y1;
    const len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const off = rand(rng, -(l.width || 96) * 1.15, (l.width || 96) * 1.15);
    const x = clamp(l.x1 + dx * at + nx * off, room.wall + 92, room.w - room.wall - 92);
    const y = clamp(l.y1 + dy * at + ny * off, room.wall + 92, room.h - room.wall - 92);
    if (legal(x, y, 520)) return { x, y };
  }
  // District fallback keeps the spawn clusters inside actual places instead of
  // at arbitrary wall edges.
  for (let tries = 0; tries < 54 && room.districts?.length; tries++) {
    const d = pick(rng, room.districts.filter(d => d.kind !== 'spawn' && d.kind !== 'exit') || []);
    if (!d) break;
    const x = clamp(d.cx + rand(rng, -d.w * 0.34, d.w * 0.34), room.wall + 92, room.w - room.wall - 92);
    const y = clamp(d.cy + rand(rng, -d.h * 0.34, d.h * 0.34), room.wall + 92, room.h - room.wall - 92);
    if (legal(x, y, 520)) return { x, y };
  }
  for (let tries = 0; tries < 80; tries++) {
    const side = randi(rng, 0, 3), w = room.wall;
    const x = side === 1 ? room.w - w - rand(rng, 90, 230)
      : side === 3 ? w + rand(rng, 90, 230)
      : rand(rng, w + 130, room.w - w - 130);
    const y = side === 0 ? w + rand(rng, 90, 210)
      : side === 2 ? room.h - w - rand(rng, 90, 210)
      : rand(rng, w + 120, room.h - w - 120);
    if (legal(x, y, 460)) return { x, y };
  }
  const cells = Array.from(reach.cells || []);
  for (let tries = 0; tries < 120 && cells.length; tries++) {
    const raw = cells[Math.floor(rng() * cells.length)];
    const c = typeof raw === 'number' ? raw % reach.cols : Number(String(raw).split(',')[0]);
    const r = typeof raw === 'number' ? Math.floor(raw / reach.cols) : Number(String(raw).split(',')[1]);
    const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
    if (dist(x, y, px, py) >= 460 && !pointBlockedForSpawn(room, x, y)) return { x, y };
  }
  return { x: room.w / 2, y: room.wall + 120 };
}

function sanitizePendingSpawns(room, rng, px, py, portalX, portalY) {
  const reach = reachableFrom(room, px, py);
  const fix = (s) => {
    if (!s || (reach.has(s.x, s.y) && !pointBlockedForSpawn(room, s.x, s.y) && dist(s.x, s.y, px, py) >= 460)) return;
    const p = findReachableSpawn(room, rng, reach, px, py);
    s.x = p.x; s.y = p.y;
  };
  if (room.pendingWaves) {
    for (const w of room.pendingWaves) if (w.spawns) for (const s of w.spawns) fix(s);
  }
  for (const s of room.spawnQueue) fix(s);
  // Cache safe edge-biased anchors for late reinforcement waves. Without this,
  // a big-room wall structure can make a random edge spawn technically legal
  // but unreachable — the worst kind of haunted bullshit.
  room.spawnAnchors = [];
  for (let i = 0; i < (genMobile() ? 28 : 42); i++) {
    const p = findReachableSpawn(room, rng, reach, px, py);
    if (!room.spawnAnchors.some(a => dist(a.x, a.y, p.x, p.y) < 125)) room.spawnAnchors.push(p);
  }
  // If a generated solid accidentally boxed the portal after late event placement, fail open.
  if (!reach.has(portalX, portalY)) room.obstacles = room.obstacles.filter(o => !(o.archKind && o.wall && !o.breakable));
}

function aabb(o) {
  return o.type === 'circle'
    ? { x: o.x - o.rad, y: o.y - o.rad, w: o.rad * 2, h: o.rad * 2 }
    : { x: o.x, y: o.y, w: o.w, h: o.h };
}

// AABB overlap with a margin (correct for long walls; the old center-distance
// test rejected most of the room around a partition wall).
function fits(room, o, margin = 20) {
  const w = room.wall, b = aabb(o);
  if (b.x < w + 10 || b.y < w + 10 || b.x + b.w > room.w - w - 10 || b.y + b.h > room.h - w - 10) return false;
  if (!o.allowLane && nearProtectedFlowLane(room, o, margin)) return false; // keep boost boulevards clear
  for (const other of room.obstacles) {
    const a = aabb(other);
    if (b.x < a.x + a.w + margin && b.x + b.w + margin > a.x &&
        b.y < a.y + a.h + margin && b.y + b.h + margin > a.y) return false;
  }
  return true;
}

// Coarse-grid flood-fill from the player spawn. Breakable walls count as passable
// (the player can smash them). Used to guarantee no unclearable/softlocked rooms.
const CELL = 44;
export function reachableFrom(room, sx, sy) {
  const cols = Math.ceil(room.w / CELL), rows = Math.ceil(room.h / CELL);
  const total = cols * rows;
  const blocked = new Uint8Array(total);
  const inset = room.wall + 8;
  const cellIndex = (c, r) => r * cols + c;

  // Boundary cells: marked once so the flood-fill does not re-test wall math for
  // every neighbor. Solid walls/ledges are rasterized into the same cheap mask.
  for (let r = 0; r < rows; r++) {
    const cy = r * CELL + CELL / 2;
    for (let c = 0; c < cols; c++) {
      const cx = c * CELL + CELL / 2;
      if (cx < inset || cy < inset || cx > room.w - inset || cy > room.h - inset) blocked[cellIndex(c, r)] = 1;
    }
  }
  for (const o of room.obstacles) {
    if (!o.wall || o.breakable) continue;
    const x0 = o.x - 16, y0 = o.y - 16, x1 = o.x + o.w + 16, y1 = o.y + o.h + 16;
    const c0 = clamp(Math.floor((x0 - CELL / 2) / CELL) + 1, 0, cols - 1);
    const c1 = clamp(Math.ceil((x1 - CELL / 2) / CELL) - 1, 0, cols - 1);
    const r0 = clamp(Math.floor((y0 - CELL / 2) / CELL) + 1, 0, rows - 1);
    const r1 = clamp(Math.ceil((y1 - CELL / 2) / CELL) - 1, 0, rows - 1);
    if (c1 < c0 || r1 < r0) continue;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked[cellIndex(c, r)] = 1;
  }

  const seenBits = new Uint8Array(total);
  const seen = new Set();
  const sc = clamp(Math.floor(sx / CELL), 0, cols - 1), sr = clamp(Math.floor(sy / CELL), 0, rows - 1);
  const start = cellIndex(sc, sr);
  const stack = [start];
  seenBits[start] = 1; seen.add(start);
  while (stack.length) {
    const id = stack.pop();
    const c = id % cols, r = Math.floor(id / cols);
    const push = (nc, nr) => {
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) return;
      const ni = cellIndex(nc, nr);
      if (seenBits[ni] || blocked[ni]) return;
      seenBits[ni] = 1; seen.add(ni); stack.push(ni);
    };
    push(c + 1, r); push(c - 1, r); push(c, r + 1); push(c, r - 1);
  }
  return {
    cols, rows, cells: seen,
    has: (x, y) => {
      const c = Math.floor(x / CELL), r = Math.floor(y / CELL);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
      return seenBits[cellIndex(c, r)] === 1;
    },
  };
}

function seedVerticality(room, rng, px, py, portalX, portalY, partitioned) {
  // The second layer is no longer a novelty perch: every city rolls a
  // readable rooftop lattice, then fills any gaps with extra roof districts. The
  // platforms are organized by the visual district grid, so the map feels built
  // instead of scattered.
  const wantsTier = true;
  if (!wantsTier) return 0;
  // Fewer rooftop platforms than the website build: the second layer was a major source
  // of overlapping silhouettes. Still a real lattice (rails + high-ground routes), just
  // legible instead of a stacked thicket.
  const cap = room.bossId ? (genMobile() ? 5 : 8) : genMobile() ? (partitioned ? 8 : 11) : (partitioned ? 21 : 28);
  let made = seedRooftopGrid(room, rng, px, py, portalX, portalY, partitioned, cap);
  const target = room.bossId
    ? clamp(genMobile() ? 3 : 5, 3, cap)
    : clamp((partitioned ? 13 : 19) + (room.idx >= 4 ? 1 : 0) + (room.idx >= 7 && !genMobile() ? 1 : 0), genMobile() ? 8 : 13, cap);
  for (let tries = 0; room.tiers.length < target && tries < cap * 4; tries++) {
    if (maybeTier(room, rng, px, py, portalX, portalY, { smaller: tries > 0, partitioned, dense: true, fullMap: true })) made++;
  }
  const minRoofs = room.bossId ? (genMobile() ? 4 : 5) : (genMobile() ? 5 : 7);
  if (room.tiers.length < minRoofs) made += seedOpenRooftopFallback(room, rng, px, py, portalX, portalY, minRoofs, cap);
  return made;
}


function seedOpenRooftopFallback(room, rng, px, py, portalX, portalY, minRoofs, cap) {
  const reach = reachableFrom(room, px, py);
  const districts = (room.districts || [])
    .filter(d => d.kind !== 'spawn' && d.kind !== 'exit')
    .sort((a, b) => Math.abs(a.cy - room.h * 0.48) - Math.abs(b.cy - room.h * 0.48));
  let made = 0;
  const pushTier = (rect, districtId = null) => {
    if (room.tiers.length >= cap) return false;
    const tw = clamp(rect.w, genMobile() ? 230 : 300, genMobile() ? 560 : 760);
    const th = clamp(rect.h, genMobile() ? 180 : 220, genMobile() ? 430 : 560);
    const tx = clamp(rect.x, room.wall + 96, room.w - room.wall - 96 - tw);
    const ty = clamp(rect.y, room.wall + 96, room.h - room.wall - 112 - th);
    const candidate = { x: tx, y: ty, w: tw, h: th };
    const cx = tx + tw / 2, cy = ty + th / 2;
    if (dist(cx, cy, px, py) < 390 || dist(cx, cy, portalX, portalY) < 260 || !reach.has(cx, cy)) return false;
    if (room.tiers.some(t => rectOverlap(candidate, t, 76))) return false;
    const tierId = room._nextTierId = (room._nextTierId || 0) + 1;
    const gap = clamp(tw * 0.42, 170, 300);
    const rampX = tx + tw * rand(rng, 0.34, 0.66);
    const tier = { id: tierId, districtId, open: true, x: tx, y: ty, w: tw, h: th, height: 1, ramp: { x: rampX, y: ty + th, w: gap, edge: 's' }, phase: rng() * TAU };
    decorateBuilding(room, rng, tier, districtId);
    room.tiers.push(tier);
    room.landmarks.push({ kind: 'openRoof', x: cx, y: cy });
    made++;
    return true;
  };
  for (const d of districts) {
    if (room.tiers.length >= minRoofs || room.tiers.length >= cap) break;
    for (let tries = 0; tries < 5; tries++) {
      const tw = clamp(d.w * rand(rng, 0.42, 0.62), genMobile() ? 230 : 300, genMobile() ? 520 : 720);
      const th = clamp(d.h * rand(rng, 0.36, 0.55), genMobile() ? 180 : 220, genMobile() ? 390 : 520);
      if (pushTier({ x: d.cx - tw / 2 + rand(rng, -d.w * 0.08, d.w * 0.08), y: d.cy - th / 2 + rand(rng, -d.h * 0.08, d.h * 0.08), w: tw, h: th }, d.id)) break;
    }
  }
  // Absolute safety net: use reachable cells in quiet spaces if an aggressive
  // floorplan left too few district-sized roof pads.
  const cells = Array.from(reach.cells || []);
  for (let tries = 0; room.tiers.length < minRoofs && tries < 180 && cells.length; tries++) {
    const raw = cells[Math.floor(rng() * cells.length)];
    const c = typeof raw === 'number' ? raw % reach.cols : Number(String(raw).split(',')[0]);
    const r = typeof raw === 'number' ? Math.floor(raw / reach.cols) : Number(String(raw).split(',')[1]);
    const cx = c * CELL + CELL / 2, cy = r * CELL + CELL / 2;
    const tw = rand(rng, genMobile() ? 240 : 320, genMobile() ? 420 : 560);
    const th = rand(rng, genMobile() ? 180 : 220, genMobile() ? 330 : 440);
    pushTier({ x: cx - tw / 2, y: cy - th / 2, w: tw, h: th }, null);
  }
  return made;
}

function seedRooftopGrid(room, rng, px, py, portalX, portalY, partitioned, cap) {
  const districts = (room.districts || [])
    .filter(d => d.kind !== 'spawn' && d.kind !== 'exit')
    .map((d, i) => ({ d, i, score: Math.abs(d.cy - room.h * 0.48) + Math.abs(d.cx - room.w * 0.5) * 0.18 + rng() * 180 }))
    .sort((a, b) => a.score - b.score);
  // Alternate center-out with edge districts so the top layer crosses the whole city,
  // not just the middle.
  const edge = [...districts].sort((a, b) => Math.abs(b.d.cx - room.w / 2) + Math.abs(b.d.cy - room.h / 2) - (Math.abs(a.d.cx - room.w / 2) + Math.abs(a.d.cy - room.h / 2)));
  const order = [];
  while (districts.length || edge.length) {
    if (districts.length) order.push(districts.shift());
    if (edge.length) order.push(edge.shift());
  }
  let made = 0;
  for (const entry of order) {
    if (room.tiers.length >= cap) break;
    const d = entry.d;
    // Bigger rooftops: real standing room up top so the second layer is a place to fight
    // and flow across, not just landing pads. (Brought over from the rooftop-grid fork.)
    const tw = clamp(d.w * rand(rng, 0.74, 0.94), genMobile() ? 320 : 400, genMobile() ? 780 : 1160);
    const th = clamp(d.h * rand(rng, 0.64, 0.86), genMobile() ? 240 : 300, genMobile() ? 620 : 900);
    const rect = {
      x: d.cx - tw / 2 + rand(rng, -d.w * 0.06, d.w * 0.06),
      y: d.cy - th / 2 + rand(rng, -d.h * 0.06, d.h * 0.06),
      w: tw,
      h: th,
    };
    if (tryPlaceTierRect(room, rng, px, py, portalX, portalY, rect, { districtId: d.id, ordered: true, partitioned })) made++;
  }
  return made;
}

// Place one raised platform: a rect tier whose perimeter is ledge walls, with a
// ramp gap. Ledges block movement always and block low bullets (high-ground); the
// ramp/vents/sky-rails make the roof reachable. Validated for spawn clearance,
// portal reachability, and older rooftop reachability.
function maybeTier(room, rng, px, py, portalX, portalY, opts = {}) {
  const scale = opts.smaller ? rand(rng, opts.dense ? 0.50 : 0.66, opts.dense ? 0.76 : 0.86) : (opts.dense ? rand(rng, 0.82, 1.0) : 1);
  const tw = room.w * rand(rng, opts.partitioned ? 0.12 : 0.13, opts.partitioned ? 0.20 : 0.23) * scale;
  const th = room.h * rand(rng, opts.partitioned ? 0.10 : 0.11, opts.partitioned ? 0.18 : 0.20) * scale;
  for (let tries = 0; tries < 42; tries++) {
    const upperBias = opts.fullMap ? rand(rng, 0.18, 0.72) : rand(rng, 0.18, opts.partitioned ? 0.58 : 0.54);
    const tx = rand(rng, room.wall + 92, room.w - room.wall - 92 - tw);
    const ty = clamp(room.h * upperBias - th / 2 + rand(rng, -180, 180), room.wall + 92, room.h - room.wall - 160 - th);
    if (tryPlaceTierRect(room, rng, px, py, portalX, portalY, { x: tx, y: ty, w: tw, h: th }, opts)) return true;
  }
  return false;
}

function tryPlaceTierRect(room, rng, px, py, portalX, portalY, rawRect, opts = {}) {
  const T = 26;
  const tw = clamp(rawRect.w, genMobile() ? 270 : 330, genMobile() ? 820 : 1180);
  const th = clamp(rawRect.h, genMobile() ? 200 : 240, genMobile() ? 700 : 900);
  const tx = clamp(rawRect.x, room.wall + 92, room.w - room.wall - 92 - tw);
  const ty = clamp(rawRect.y, room.wall + 92, room.h - room.wall - 120 - th);
  const rect = { x: tx, y: ty, w: tw, h: th };
  const pad = opts.partitioned ? 110 : 150;
  const hit = (qx, qy, extra = 0) => qx > tx - pad - extra && qx < tx + tw + pad + extra && qy > ty - pad - extra && qy < ty + th + pad + extra;
  if (hit(px, py, 80) || hit(portalX, portalY, 70)) return false;
  if (room.tiers.some(t => rectOverlap(rect, t, opts.ordered ? 44 : 74))) return false;
  if (nearProtectedFlowLane(room, { type: 'rect', x: tx, y: ty, w: tw, h: th }, opts.ordered ? -86 : -48, opts.ordered ? 'tierCore' : 'tier')) return false;

  // ramp on the bottom edge: because spawn is low in the room, this keeps roof access
  // intuitive. Vents/rails provide the breakneck access everywhere else.
  const gap = clamp(tw * rand(rng, 0.22, 0.31), 165, 265);
  const rgx = clamp(tx + tw * rand(rng, 0.34, 0.66), tx + gap / 2 + T, tx + tw - gap / 2 - T);
  const tierId = room._nextTierId = (room._nextTierId || 0) + 1;
  const ledges = [
    wallSlab(tx - T / 2, ty - T / 2, tw + T, T),
    wallSlab(tx - T / 2, ty + th - T / 2, (rgx - gap / 2) - (tx - T / 2), T),
    wallSlab(rgx + gap / 2, ty + th - T / 2, (tx + tw + T / 2) - (rgx + gap / 2), T),
    wallSlab(tx - T / 2, ty - T / 2, T, th + T),
    wallSlab(tx + tw - T / 2, ty - T / 2, T, th + T),
  ];
  for (const l of ledges) l.tierId = tierId;
  const before = room.obstacles.length;
  room.obstacles.push(...ledges);
  const reach = reachableFrom(room, px, py);
  const keepsOlderTiersReachable = room.tiers.every(t => reach.has(t.x + t.w / 2, t.y + t.h / 2));
  if (!reach.has(portalX, portalY) || !reach.has(tx + tw / 2, ty + th / 2) || !keepsOlderTiersReachable) {
    room.obstacles.length = before;
    return false;
  }
  const tier = { id: tierId, districtId: opts.districtId ?? null, x: tx, y: ty, w: tw, h: th, height: 1, ramp: { x: rgx, y: ty + th, w: gap, edge: 's' }, phase: rng() * TAU };
  decorateBuilding(room, rng, tier, opts.districtId ?? null);
  room.tiers.push(tier);
  room.landmarks.push({ kind: 'highGround', x: tx + tw / 2, y: ty + th / 2 });
  return true;
}

function wallSlab(x, y, w, h) {
  return { type: 'rect', x, y, w: Math.max(8, w), h: Math.max(8, h), wall: true, ledge: true, ledgeHeight: 1, style: 'ledge', round: 3 };
}

// Dress a climbable tier as an actual TALL BUILDING rising out of its colorful city
// slab: it inherits the district's neon colour, gets a per-building height so the
// skyline varies (a lot of them stand HIGH), one of two facade texture sets, and a
// rooftop crown. Gameplay level stays 1 (you grind/vent/ramp up to the roof); only the
// drawn height varies, so this never destabilises the binary ground/roof level system.
const BUILDING_CROWNS = ['mast', 'ring', 'heli', 'billboard', 'garden', 'mast', 'none'];
// District colours are `hsl(...)` strings, but the building renderer's mix()/hexA() helpers
// only parse hex — feed them hsl and mix() silently goes black while hexA() yields an
// unparseable rgba(NaN,...) that throws inside a gradient. So bake a real hex skin here.
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const ch = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(8)}${ch(4)}`;
}
function colorToHex(c, fallback) {
  if (!c) return fallback;
  if (c[0] === '#') return c;
  const m = /hsl\(\s*([\d.]+)[, ]+([\d.]+)%[, ]+([\d.]+)%/.exec(c);
  return m ? hslToHex(+m[1], +m[2], +m[3]) : fallback;
}
function decorateBuilding(room, rng, tier, districtId) {
  const d = districtId != null ? (room.districts || []).find(x => x.id === districtId) : null;
  const tallKind = d && (d.kind === 'arcology' || d.kind === 'reactor' || d.kind === 'data' || d.kind === 'exit' || d.kind === 'plaza');
  // Height multiplier on TIER_LIFT. Most buildings stand tall; ~1 in 4 are skyscrapers.
  let rise = rand(rng, 1.0, 1.5) * (tallKind ? 1.18 : 1);
  if (chance(rng, 0.26)) rise = rand(rng, 1.7, 2.35);          // hero towers punch the skyline
  tier.rise = clamp(rise, 0.95, 2.5);
  tier.skin = colorToHex(d?.color, room.biome.pal.accent2);     // the colorful slab's hue, risen (as hex)
  tier.texSet = chance(rng, tallKind ? 0.62 : 0.45) ? 1 : 0;    // two facade treatments, mixed
  tier.crown = tier.rise > 1.7 ? pick(rng, ['mast', 'ring', 'billboard']) : pick(rng, BUILDING_CROWNS);
  tier.litSeed = rng();                                         // deterministic window lighting
  // tall towers (and some others) carry a giant animated holo-billboard on their face
  tier.ad = tier.rise > 1.3 || chance(rng, 0.35);
  tier.adKind = randi(rng, 0, 3);                               // 0 ticker / 1 ring / 2 logo / 3 glyphs
  tier.adHue = rng();
  return tier;
}

function rectOverlap(a, b, margin = 0) {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x
    && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}


function ensureMinimumVerticality(room, rng, px, py, portalX, portalY) {
  const minRoofs = room.bossId ? (genMobile() ? 2 : 4) : (genMobile() ? 3 : 4);
  if ((room.tiers || []).length >= minRoofs) return;
  const cap = room.bossId ? (genMobile() ? 4 : 6) : genMobile() ? 6 : 11;
  const before = room.tiers.length;
  seedOpenRooftopFallback(room, rng, px, py, portalX, portalY, minRoofs, cap);
  pruneUnreachableTiers(room, px, py);
  if (room.tiers.length > before || !room.vents?.length || !room.skyRails?.length) {
    room.vents = [];
    room.skyRails = [];
    room._nextVentId = 1;
    if (room.tiers.length) {
      seedVents(room, rng, px, py, portalX, portalY);
      seedSkyRails(room, rng);
    }
  }
}

function pruneUnreachableTiers(room, px, py) {
  if (!room.tiers?.length) return;
  const reach = reachableFrom(room, px, py);
  const keep = new Set();
  for (const t of room.tiers) if (reach.has(t.x + t.w / 2, t.y + t.h / 2)) keep.add(t.id);
  if (keep.size === room.tiers.length) return;
  room.tiers = room.tiers.filter(t => keep.has(t.id));
  room.obstacles = room.obstacles.filter(o => !o.tierId || keep.has(o.tierId));
  room.vents = (room.vents || []).filter(v => {
    const toOk = (v.toLevel || 0) === 0 || room.tiers.some(t => t.height === v.toLevel && pointInRect(v.toX, v.toY, t));
    const fromOk = (v.fromLevel || 0) === 0 || room.tiers.some(t => t.height === v.fromLevel && pointInRect(v.x, v.y, t));
    return toOk && fromOk;
  });
}

function pointInRect(x, y, r) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

function seedVents(room, rng, px, py, portalX, portalY) {
  const reach = reachableFrom(room, px, py);
  room._nextVentId = room._nextVentId || 1;
  const addVent = (x, y, toX, toY, toLevel, kind = 'updraft', fromLevel = 0) => {
    const v = { id: room._nextVentId++, x, y, r: 56, toX, toY, toLevel, fromLevel, kind, phase: rng() * TAU, flash: 0 };
    room.vents.push(v);
    room.landmarks.push({ kind: 'vent', x, y });
    return v;
  };
  const landingClear = (x, y, level, pad = 132) => {
    for (const v of room.vents || []) {
      const originLevel = v.fromLevel ?? 0;
      const destLevel = v.toLevel ?? 1;
      // Never drop a player onto another launcher/fan. This was the source of the
      // updraft→dropfan→updraft loop that made players fight the map instead of flow.
      if (originLevel === level && dist(x, y, v.x, v.y) < pad) return false;
      if (destLevel === level && dist(x, y, v.toX, v.toY) < pad * 0.78) return false;
    }
    return true;
  };
  const tiers = [...(room.tiers || [])].sort((a, b) => (a.y + a.h * 0.5) - (b.y + b.h * 0.5));
  for (const t of tiers) {
    // Fewer launchers: not every rooftop gets a vent — ramps and sky-rails still reach
    // them. Keeps the city from constantly flinging you around; most climbs are deliberate.
    if (!chance(rng, 0.58)) continue;
    const target = { x: t.x + t.w * rand(rng, 0.36, 0.64), y: t.y + t.h * rand(rng, 0.30, 0.56) };
    let placed = false;
    const candidates = [
      { x: t.ramp.x + rand(rng, -86, 86), y: t.y + t.h + rand(rng, 108, 235), tag: 'ramp' },
      { x: t.x - rand(rng, 126, 230), y: t.y + t.h * rand(rng, 0.35, 0.78), tag: 'left' },
      { x: t.x + t.w + rand(rng, 126, 230), y: t.y + t.h * rand(rng, 0.35, 0.78), tag: 'right' },
      { x: t.x + t.w * rand(rng, 0.22, 0.78), y: t.y - rand(rng, 112, 220), tag: 'north' },
    ];
    for (const c of candidates) {
      const x = clamp(c.x, room.wall + 105, room.w - room.wall - 105);
      const y = clamp(c.y, room.wall + 105, room.h - room.wall - 125);
      if (!reach.has(x, y) || !ventClear(room, x, y, 74) || !landingClear(x, y, 0, 164) || !landingClear(target.x, target.y, t.height, 126)
        || dist(x, y, px, py) < 180 || dist(x, y, portalX, portalY) < 130) continue;
      addVent(x, y, target.x, target.y, t.height, 'updraft', 0);
      placed = true;
      break;
    }
    // Matching drop fans are exits, not traps: they sit away from the updraft landing
    // and they are forbidden to land near another vent origin.
    if (placed && roomAreaScale(room) > 3.2 && chance(rng, 0.45)) {
      const fanX = clamp(t.x + t.w * rand(rng, 0.18, 0.82), t.x + 78, t.x + t.w - 78);
      const fanY = clamp(t.y + t.h * rand(rng, 0.68, 0.88), t.y + 72, t.y + t.h - 58);
      const outX = clamp(t.ramp.x + rand(rng, -150, 150), room.wall + 126, room.w - room.wall - 126);
      const outY = clamp(t.y + t.h + rand(rng, 190, 300), room.wall + 126, room.h - room.wall - 126);
      if (dist(fanX, fanY, target.x, target.y) > 180 && reach.has(outX, outY) && ventClear(room, outX, outY, 62)
        && landingClear(fanX, fanY, t.height, 138) && landingClear(outX, outY, 0, 154)) {
        addVent(fanX, fanY, outX, outY, 0, 'dropfan', t.height);
      }
    }
  }
}

function ventClear(room, x, y, pad) {
  for (const o of room.obstacles || []) {
    if (o.gone) continue;
    if (o.type === 'circle') { if (dist(x, y, o.x, o.y) < (o.rad || 0) + pad) return false; }
    else {
      const cx = clamp(x, o.x, o.x + o.w), cy = clamp(y, o.y, o.y + o.h);
      if (dist(x, y, cx, cy) < pad) return false;
    }
  }
  return true;
}

// Sonic-style collectible rings strung along the grindable sky rails — grind the rooftops
// to scoop them up for score + flow-surge + a chime. (Skips off-route rails — those have a
// jewel at the apex already.) Rings sit at the rail's level/height; collected by proximity.
function seedRailRings(room, rng) {
  room.rings = [];
  let id = 0;
  const rush = room.mutator?.ringBonus ? 1.8 : 1; // RING RUSH packs the rails
  for (const r of room.skyRails || []) {
    if (r.route || room.rings.length > 220) continue;
    const dx = r.x2 - r.x1, dy = r.y2 - r.y1, len = Math.hypot(dx, dy) || 1;
    const n = clamp(Math.round((len / 175) * rush), 4, 14);
    const cnx = -dy / len, cny = dx / len, k = r.twists || 1;
    for (let i = 1; i < n; i++) {
      const u = i / n;
      const off = r.bow ? r.bow * Math.sin(u * Math.PI * k) : 0;
      room.rings.push({ id: id++, x: r.x1 + dx * u + cnx * off, y: r.y1 + dy * u + cny * off, level: r.level || 1, rise: r.rise || 1, taken: false, phase: rng() * TAU });
    }
  }
}

// ── THE SPIRE DISTRICT ──────────────────────────────────────────────────────────────
// Turn the biggest towers into skyscrapers and wrap each in a SPIRAL climb-rail that
// winds up the outside (latch from the street, grind up and up). Link the summits with
// straight sky-bridges so you can run tower-to-tower at altitude. Rings reward the climb;
// an apex ring-cluster is the summit treasure. Pairs with the SPIRE WARDEN elite.
function seedSpireDistrict(room, rng, px, py, portalX, portalY) {
  // Pick a few big, well-separated towers with room for a spiral outside their footprint.
  const pickAt = (spread) => {
    const out = [];
    for (const t of (room.tiers || []).slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))) {
      const cx = t.x + t.w / 2, cy = t.y + t.h / 2, maxHalf = Math.max(t.w, t.h) / 2;
      const wallGap = Math.min(cx - room.wall, room.w - room.wall - cx, cy - room.wall, room.h - room.wall - cy) - 40;
      if (wallGap < maxHalf + 70) continue;               // room for the spiral OUTSIDE the footprint
      if (dist(cx, cy, px, py) < 680) continue;           // not right on top of spawn
      if (out.some(c => dist(cx, cy, c.cx, c.cy) < spread)) continue; // spread the towers out
      out.push({ tier: t, cx, cy, maxHalf, wallGap });
      if (out.length >= 3) break;
    }
    return out;
  };
  let chosen = pickAt(1000);
  if (chosen.length < 2) chosen = pickAt(600); // relax spread for sparse seeds
  if (chosen.length < 2) return;

  const spireRise = 5, liftEnd = TIER_LIFT * spireRise;   // skyscrapers — tall, so the climb reads big
  let ringId = (room.rings.length || 0) + 5000;
  room._nextVentId = room._nextVentId || 1;
  for (const c of chosen) {
    c.tier.rise = spireRise;                              // make the slab a skyscraper
    c.tier.crown = 'mast';                                // a spire reads "tall"
    const rad = clamp(c.maxHalf + 60, 130, c.wallGap);
    const turns = 1.7, a0 = rng() * TAU, dirSign = rng() < 0.5 ? 1 : -1;
    const W = dirSign * turns * TAU;
    const baseX = c.cx + Math.cos(a0) * rad, baseY = c.cy + Math.sin(a0) * rad;
    const topX = c.cx + Math.cos(a0 + W) * rad, topY = c.cy + Math.sin(a0 + W) * rad;
    room.skyRails.push({
      spiral: true, climb: true, cx: c.cx, cy: c.cy, rad, turns, a0, dirSign,
      liftStart: 0, liftEnd, arcLen: turns * TAU * rad, level: 1, color: '#9fe8ff', width: 44,
      boost: 2550, x1: baseX, y1: baseY, x2: topX, y2: topY, phase: rng() * TAU, // brisk-epic climb
    });
    c.top = { x: topX, y: topY };
    // UPDRAFT: an express elevator at the tower base — launch straight up to the roof
    // (an alternative to grinding the scenic spiral). Reuses the vent launcher.
    room.vents.push({
      id: room._nextVentId++, r: 58, kind: 'updraft', fromLevel: 0, toLevel: 1, flash: 0, spire: true,
      x: clamp(c.cx, room.wall + 80, room.w - room.wall - 80),
      y: clamp(c.tier.y + c.tier.h + 86, room.wall + 80, room.h - room.wall - 96),
      toX: c.cx, toY: c.cy, phase: rng() * TAU,
    });
    const nRings = 8;                                     // rings strung UP the helix
    for (let i = 1; i <= nRings; i++) {
      const u = i / (nRings + 1), ang = a0 + W * u;
      room.rings.push({ id: ringId++, x: c.cx + Math.cos(ang) * rad, y: c.cy + Math.sin(ang) * rad, level: 1, rise: spireRise * u, taken: false, phase: rng() * TAU, spire: true });
    }
  }
  // sky-bridges linking the summits (straight sky rails at the summit height)
  const tops = chosen.map(c => c.top);
  const bridges = tops.length >= 3 ? tops.length : 1;     // 3 towers → a triangle; 2 → one span
  for (let i = 0; i < bridges; i++) {
    const a = tops[i], b = tops[(i + 1) % tops.length];
    room.skyRails.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, rise: spireRise, level: 1, trunk: true, color: '#ffe6b0', width: 40, phase: rng() * TAU });
  }
  // summit treasure: a ring halo crowning the tallest tower
  const apex = chosen[0].top;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    room.rings.push({ id: ringId++, x: apex.x + Math.cos(a) * 48, y: apex.y + Math.sin(a) * 48, level: 1, rise: spireRise, taken: false, phase: rng() * TAU, spire: true });
  }
  // stash the summit geometry so seedSpireEnemies (after buildWaves) can perch the Warden
  // + rooftop sentinels. The Warden sits on the tallest ROOF CENTRE (over the tier → correct
  // height), not the spiral's edge-top.
  room._spireTops = tops;
  room._spireCenters = chosen.map(c => ({ x: c.cx, y: c.cy }));
  room._spireApex = { x: chosen[0].cx, y: chosen[0].cy };
}

// Populate the spire's heights: a SPIRE WARDEN elite on the tallest roof (the capstone you
// must climb to clear) and a perched turret on each other tower. Runs AFTER buildWaves so
// room.pendingWaves exists (buildWaves replaces it).
function seedSpireEnemies(room, rng) {
  const centers = room._spireCenters || [], apex = room._spireApex;
  if (!centers.length || !apex) return;
  centers.forEach((c, i) => {
    if (i === 0) return; // the tallest is the Warden's perch
    room.spawnQueue.push({ type: i % 2 ? 'turret' : 'gunner', x: c.x, y: c.y, level: 1, at: 1.6 + i * 0.5, glyphAt: 0.3 });
  });
  const def = MINIBOSSES.find(m => m.id === 'spirewarden');
  if (def && room.pendingWaves) {
    // the capstone: appears once the rest of the room is nearly cleared (you've climbed
    // and dealt with the rooftop sentinels), or after a long fallback timer.
    room.pendingWaves.push({ at: 13, fired: false, orWhenLeft: 1, miniboss: def, mx: apex.x, my: apex.y, mLevel: 1, spireBoss: true });
  }
}

function seedSkyRails(room, rng) {
  const tiers = room.tiers || [];
  if (tiers.length < 2) return;
  const point = (t, jitter = 0.24) => ({
    x: t.x + t.w * rand(rng, 0.50 - jitter, 0.50 + jitter),
    y: t.y + t.h * rand(rng, 0.42 - jitter * 0.35, 0.54 + jitter * 0.35),
  });
  const pairs = [];
  for (let i = 0; i < tiers.length; i++) for (let j = i + 1; j < tiers.length; j++) {
    const a = tiers[i], b = tiers[j];
    const ax = a.x + a.w / 2, ay = a.y + a.h * 0.48;
    const bx = b.x + b.w / 2, by = b.y + b.h * 0.48;
    pairs.push({ a, b, d: dist(ax, ay, bx, by) });
  }
  const used = new Set();
  const connected = new Set();
  const key = (a, b) => [a.id, b.id].sort((u, v) => u - v).join(':');
  const add = (pair, trunk = false) => {
    if (!pair) return false;
    const k = key(pair.a, pair.b);
    if (used.has(k)) return false;
    used.add(k);
    connected.add(pair.a.id); connected.add(pair.b.id);
    const A = point(pair.a, trunk ? 0.16 : 0.24), B = point(pair.b, trunk ? 0.16 : 0.24);
    // Most rails TWIST now: a sine-bow across the span (1-3 arcs), so the grind weaves and
    // corkscrews instead of running dead-straight. The trunk spine keeps a gentle single
    // sweep (still the readable highway); branches get the wild weaves.
    const span = dist(A.x, A.y, B.x, B.y);
    const bow = trunk
      ? (span > 700 && chance(rng, 0.5) ? rand(rng, 0.10, 0.18) * span * (chance(rng, 0.5) ? 1 : -1) : 0)
      : (span > 420 && chance(rng, 0.78) ? rand(rng, 0.22, 0.42) * span * (chance(rng, 0.5) ? 1 : -1) : 0);
    room.skyRails.push({
      x1: A.x, y1: A.y, x2: B.x, y2: B.y,
      level: 1, width: trunk ? 70 : 56, boost: trunk ? 2250 : 1900,
      rise: ((pair.a.rise || 1) + (pair.b.rise || 1)) / 2, // ride at the connected roofs' height
      trunk, bow, twists: bow ? (trunk ? 1 : randi(rng, 1, 3)) : 0,
      color: chance(rng, 0.5) ? room.biome.pal.accent2 : room.biome.pal.accent3,
      phase: rng() * TAU,
    });
    room.landmarks.push({ kind: trunk ? 'skyRailSpine' : 'skyRail', x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
    return true;
  };

  // One long express spine creates the city-wide rooftop route; then a minimum
  // connector pass turns the upper layer into an actual network instead of islands.
  const far = [...pairs].sort((a, b) => b.d - a.d);
  add(far[0], true);
  const maxRails = Math.min(genMobile() ? 8 : 16, pairs.length);
  const near = [...pairs].sort((a, b) => a.d - b.d);
  while (connected.size < tiers.length && room.skyRails.length < maxRails) {
    const bridge = near.find(p => !used.has(key(p.a, p.b)) && (connected.has(p.a.id) !== connected.has(p.b.id)));
    if (!bridge) break;
    add(bridge, false);
  }
  for (const t of tiers) {
    if (room.skyRails.length >= maxRails || connected.has(t.id)) continue;
    const pair = near.find(p => (p.a === t || p.b === t) && !used.has(key(p.a, p.b))) || near.find(p => !used.has(key(p.a, p.b)));
    add(pair, false);
  }
  // Extra loops matter at breakneck speed: they give the player choices instead of
  // a single forced commute across the roof layer.
  const loopOrder = [...pairs].sort((a, b) => Math.abs(a.d - 820) - Math.abs(b.d - 820));
  for (const pair of loopOrder) {
    if (room.skyRails.length >= maxRails) break;
    add(pair, false);
  }
}

function seedHighGroundRewards(room, rng) {
  const tiers = room.tiers || [];
  if (!tiers.length) return;
  const max = Math.min(genMobile() ? 3 : 6, tiers.length);
  const ordered = [...tiers].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  for (let i = 0; i < max; i++) {
    const t = ordered[i];
    const species = i === 0 || chance(rng, 0.55) ? 'mirrorVault' : 'cacheAltar';
    const rad = species === 'mirrorVault' ? 52 : 41;
    const o = {
      type: 'circle',
      x: t.x + t.w * rand(rng, 0.36, 0.64),
      y: t.y + t.h * rand(rng, 0.34, 0.60),
      rad,
      style: species === 'mirrorVault' ? 'glassNode' : 'basilicaIdol',
      breakable: true,
      species,
      hp: SPECIES[species].hp + room.idx * (species === 'mirrorVault' ? 1.7 : 1.25),
      altar: true,
      level: t.height || 1,
      secretSeal: species === 'mirrorVault',
      archKind: 'skyCache',
      phase: rng() * TAU,
    };
    if (!fits(room, o, 8)) continue;
    room.obstacles.push(o);
    room.landmarks.push({ kind: 'skyCache', x: o.x, y: o.y });
    room.setpieces.push({ kind: 'liftBeacon', x: o.x + rand(rng, -34, 34), y: o.y - 58, r: 26, level: o.level, color: room.biome.pal.accent2, phase: rng() * TAU });
  }
}

function seedMysteryVaults(room, rng, px, py, portalX, portalY) {
  const already = room.obstacles.some(o => !o.gone && (o.species === 'mirrorVault' || o.species === 'gambitAltar' || o.species === 'cacheAltar'));
  let target = already ? (chance(rng, 0.35) ? 1 : 0) : 1;
  if (room.round >= 3 && roomAreaScale(room) > 4.3 && chance(rng, 0.45)) target++;
  for (let i = 0; i < target; i++) placeMysteryVault(room, rng, px, py, portalX, portalY);
}

function placeMysteryVault(room, rng, px, py, portalX, portalY) {
  for (let tries = 0; tries < 70; tries++) {
    const x = rand(rng, room.wall + 210, room.w - room.wall - 210);
    const y = rand(rng, room.wall + 180, room.h - room.wall - 210);
    if (dist(x, y, px, py) < ROOM.SPAWN_CLEAR + 70 || dist(x, y, portalX, portalY) < 210) continue;
    const o = {
      type: 'circle', x, y, rad: 56, style: 'glassNode',
      breakable: true, species: 'mirrorVault', hp: SPECIES.mirrorVault.hp + room.idx * 1.8,
      altar: true, secretSeal: true, archKind: 'mysteryVault', phase: rng() * TAU,
    };
    if (!fits(room, o, 20)) continue;
    room.obstacles.push(o);
    for (let i = 0; i < 3; i++) room.setpieces.push({
      kind: 'moonPool', x: x + Math.cos((i / 3) * TAU) * 78, y: y + Math.sin((i / 3) * TAU) * 78,
      r: 13, color: room.biome.pal.accent2, phase: rng() * TAU,
    });
    room.landmarks.push({ kind: 'mysteryVault', x, y });
    return true;
  }
  return false;
}



// Ground surfaces (Moonless-inspired floor variety): non-colliding patches that change
// how the boots feel — slick chrome you drift across, sticky tar that drags (dash over
// it), and charge plates that shove you along. Read by player.js via levels.surfaceAt.
function seedSurfaces(room, rng, px, py, portalX, portalY) {
  room.surfaces = [];
  const pal = room.biome.pal;
  const scale = roomAreaScale(room);
  const onTier = (x, y, pad = 0) => (room.tiers || []).some(t => x > t.x - pad && x < t.x + t.w + pad && y > t.y - pad && y < t.y + t.h + pad);
  const clearSpot = (x, y, r) => dist(x, y, px, py) > 300 + r && dist(x, y, portalX, portalY) > 240 + r;

  const addGround = (kind, rad, color, tries = 26) => {
    for (let i = 0; i < tries; i++) {
      const x = rand(rng, room.wall + 180, room.w - room.wall - 180);
      const y = rand(rng, room.wall + 170, room.h - room.wall - 190);
      if (!clearSpot(x, y, rad) || onTier(x, y, 40)) continue;            // ground streets only
      if (room.surfaces.some(s => dist(x, y, s.x + (s.w || 0) / 2, s.y + (s.h || 0) / 2) < rad + (s.rad || Math.max(s.w, s.h) / 2) + 60)) continue;
      room.surfaces.push({ kind, x, y, rad, level: 0, color, phase: rng() * TAU });
      return true;
    }
    return false;
  };

  // charge boulevards: a couple of wide boost strips laid ALONG flow lanes so the city's
  // momentum highways have a physical "kick" surface, not just a tint.
  const lanes = (room.flowLanes || []).filter(l => l.kind !== 'artery');
  const nStrips = clamp(1 + Math.round(scale * 0.5), 1, room.bossId ? 2 : 4);
  for (let i = 0; i < nStrips && lanes.length; i++) {
    const l = pick(rng, lanes);
    const t0 = rand(rng, 0.12, 0.4), t1 = rand(rng, 0.6, 0.88);
    const ax = l.x1 + (l.x2 - l.x1) * t0, ay = l.y1 + (l.y2 - l.y1) * t0;
    const bx = l.x1 + (l.x2 - l.x1) * t1, by = l.y1 + (l.y2 - l.y1) * t1;
    const x = Math.min(ax, bx), y = Math.min(ay, by);
    const w = Math.max(120, Math.abs(bx - ax)), h = Math.max(120, Math.abs(by - ay));
    const cx = x + w / 2, cy = y + h / 2;
    if (!clearSpot(cx, cy, Math.max(w, h) / 2) || onTier(cx, cy, 0)) continue;
    room.surfaces.push({ kind: 'charge', x, y, w, h, level: 0, color: pal.accent3, phase: rng() * TAU });
  }
  if (room.bossId) return;

  // slick plazas (drift), charge pads, and sticky tar pools — scaled to the XL floor.
  const sBonus = Math.round(clamp(scale / 4, 0, 2));
  for (let i = 0, n = randi(rng, 2, 3) + sBonus; i < n; i++) addGround('slick', rand(rng, 160, 250), pal.accent2);
  for (let i = 0, n = randi(rng, 2, 3) + sBonus; i < n; i++) addGround('charge', rand(rng, 120, 180), pal.accent3);
  for (let i = 0, n = randi(rng, 1, 2) + sBonus; i < n; i++) addGround('tar', rand(rng, 120, 185), mixHexA(pal.bad, pal.bg, 0.5));

  // a slick or charge cap on a couple of rooftops, so the upper layer has its own feel.
  const roofs = [...(room.tiers || [])].sort((a, b) => (b.w * b.h) - (a.w * a.h)).slice(0, genMobile() ? 1 : 3);
  for (const t of roofs) {
    if (chance(rng, 0.5)) continue;
    const kind = chance(rng, 0.6) ? 'slick' : 'charge';
    room.surfaces.push({
      kind, x: t.x + t.w * 0.5, y: t.y + t.h * 0.52, rad: Math.min(t.w, t.h) * rand(rng, 0.30, 0.42),
      level: t.height || 1, color: kind === 'slick' ? pal.accent2 : pal.accent3, phase: rng() * TAU,
    });
  }
}

// small hex-blend helper (string '#rrggbb' a/b at t) for surface tints
function mixHexA(a, b, t) {
  const pa = parseInt(a.replace('#', ''), 16), pb = parseInt(b.replace('#', ''), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
}

// Grand district landmarks (Moonless-inspired centerpieces): a reflecting moon-pool you
// slide across, a backseat observatory dome, an arcade spire. Bigger and rarer than the
// ambient props — one or two per city so each map has a recognizable place in it.
function seedDistrictLandmarks(room, rng, px, py, portalX, portalY) {
  if (room.bossId) return;
  const pal = room.biome.pal;
  const onTier = (x, y, pad = 0) => (room.tiers || []).some(t => x > t.x - pad && x < t.x + t.w + pad && y > t.y - pad && y < t.y + t.h + pad);
  const kinds = ['reflectPool', 'observatory', 'arcadeSpire'];
  const target = genMobile() ? randi(rng, 1, 2) : randi(rng, 2, 3) + (roomAreaScale(room) > 7 ? 1 : 0);
  for (let i = 0; i < target; i++) {
    for (let tries = 0; tries < 44; tries++) {
      const x = rand(rng, room.w * 0.18, room.w * 0.82);
      const y = rand(rng, room.h * 0.20, room.h * 0.70);
      const r = rand(rng, 98, 150);
      if (dist(x, y, px, py) < 400 || dist(x, y, portalX, portalY) < 330) continue;
      if (onTier(x, y, 50)) continue;                                     // sit in an open street
      if ((room.setpieces || []).some(s => dist(x, y, s.x, s.y) < 340)) continue;
      const kind = kinds[(i + randi(rng, 0, kinds.length - 1)) % kinds.length];
      room.setpieces.push({ kind, x, y, r, level: 0, grand: true, phase: rng() * TAU, color: chance(rng, 0.5) ? pal.accent2 : pal.accent3 });
      room.landmarks.push({ kind, x, y });
      // the moon-pool reads as water you skate over — give it a slick surface to match
      if (kind === 'reflectPool') room.surfaces.push({ kind: 'slick', x, y, rad: r * 0.96, level: 0, color: pal.accent2, phase: rng() * TAU });
      break;
    }
  }
}

function seedLandmarkProps(room, rng, px, py, portalX, portalY) {
  const kinds = ['holoTower', 'moonPool', 'signalPylon', 'marketArch', 'ghostBillboard', 'bridgeMast', 'liftBeacon'];
  const target = room.bossId ? randi(rng, 4, 7) : randi(rng, genMobile() ? 11 : 20, genMobile() ? 17 : 34);
  for (let tries = 0; tries < 300 && room.setpieces.length < target; tries++) {
    let x = rand(rng, room.wall + 190, room.w - room.wall - 190);
    let y = rand(rng, room.wall + 170, room.h - room.wall - 190);
    // Bias a couple of landmarks toward high-ground destinations so vents have
    // an obvious place they are throwing you, not a random patch of floor.
    if (room.tiers.length && tries < room.tiers.length * 3) {
      const t = room.tiers[tries % room.tiers.length];
      x = t.x + t.w * rand(rng, 0.22, 0.78);
      y = t.y + t.h * rand(rng, 0.24, 0.72);
    }
    if (dist(x, y, px, py) < 250 || dist(x, y, portalX, portalY) < 170 || pointBlockedForSpawn(room, x, y, 58)) continue;
    if (room.setpieces.some(s => dist(x, y, s.x, s.y) < 190)) continue;
    const kind = pick(rng, kinds);
    room.setpieces.push({ kind, x, y, r: rand(rng, 34, 62), level: levelFor(room, x, y), phase: rng() * TAU, color: chance(rng, 0.5) ? room.biome.pal.accent2 : room.biome.pal.accent3 });
    room.landmarks.push({ kind, x, y });
  }
}

function levelFor(room, x, y) {
  for (const t of room.tiers || []) if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t.height;
  return 0;
}

function placeLandmark(room, rng, px, py, portalX, portalY) {
  const before = room.obstacles.length;
  const style = room.biome.obstacleStyle;
  const clearOf = (x, y, r) =>
    dist(x, y, px, py) > 210 + r * 0.4 && dist(x, y, portalX, portalY) > 135 + r;
  const tryPush = (o) => {
    const ax = o.type === 'circle' ? o.x : o.x + o.w / 2;
    const ay = o.type === 'circle' ? o.y : o.y + o.h / 2;
    const ar = o.type === 'circle' ? o.rad : Math.max(o.w, o.h) / 2;
    if (!clearOf(ax, ay, ar) || !fits(room, o, 22)) return false;
    o.landmark = true; o.archKind = o.archKind || 'setpiece';
    room.obstacles.push(o); return true;
  };

  let cx = room.w / 2, cy = room.h * 0.44;
  for (let t = 0; t < 10; t++) {
    const region = rng();
    cx = region < 0.4 ? room.w * rand(rng, 0.40, 0.60)
      : region < 0.7 ? room.w * rand(rng, 0.18, 0.34)
      : room.w * rand(rng, 0.66, 0.82);
    cy = room.h * rand(rng, 0.32, 0.56);
    if (clearOf(cx, cy, 90)) break;
  }

  const kind = pick(rng, ['monument', 'pillars', 'ruin', 'crater']);
  let placed = 0;
  if (kind === 'monument') {
    placed += tryPush({ type: 'circle', x: cx, y: cy, rad: rand(rng, 86, 116), style, archKind: 'monument' }) ? 1 : 0;
    const sat = randi(rng, 4, 6), rx = rand(rng, 150, 220), a0 = rng() * TAU;
    for (let i = 0; i < sat; i++) {
      const a = a0 + (i / sat) * TAU + rand(rng, -0.25, 0.25);
      placed += tryPush({ type: 'circle', x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * rx * 0.62, rad: rand(rng, 36, 58), style, archKind: 'monument' }) ? 1 : 0;
    }
  } else if (kind === 'pillars') {
    const n = randi(rng, 5, 7), rx = Math.min(room.w, room.h) * rand(rng, 0.17, 0.24), a0 = rng() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU;
      placed += tryPush({ type: 'circle', x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * rx * 0.6, rad: rand(rng, 48, 70), style, archKind: 'pillarCourt' }) ? 1 : 0;
    }
    if (rng() < 0.5) placed += tryPush({ type: 'circle', x: cx, y: cy, rad: rand(rng, 40, 56), style, archKind: 'pillarCourt' }) ? 1 : 0;
  } else if (kind === 'ruin') {
    const n = randi(rng, 3, 5);
    for (let i = 0; i < n; i++) {
      const horiz = rng() < 0.5;
      const sw = horiz ? rand(rng, 230, 360) : rand(rng, 66, 108);
      const sh = horiz ? rand(rng, 66, 108) : rand(rng, 190, 300);
      placed += tryPush({ type: 'rect', x: cx + rand(rng, -270, 270) - sw / 2, y: cy + rand(rng, -150, 150) - sh / 2, w: sw, h: sh, style, round: 14, archKind: 'ruin' }) ? 1 : 0;
    }
  } else {
    const n = randi(rng, 8, 11), rx = Math.min(room.w, room.h) * rand(rng, 0.18, 0.25), a0 = rng() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU;
      placed += tryPush({ type: 'circle', x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * rx * 0.6, rad: rand(rng, 32, 50), style, archKind: 'crater' }) ? 1 : 0;
    }
  }

  const ok = placed >= 3 && reachableFrom(room, px, py).has(portalX, portalY);
  if (!ok) { room.obstacles.length = before; return false; }
  room.landmarks.push({ kind, x: cx, y: cy });
  return true;
}

function rubbleField(room, rng, px, py, portalX, portalY) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const before = room.obstacles.length;
    const cx = rand(rng, room.wall + 240, room.w - room.wall - 240);
    const cy = rand(rng, room.wall + 200, room.h - room.wall - 220);
    if (dist(cx, cy, px, py) < ROOM.SPAWN_CLEAR + 40 || dist(cx, cy, portalX, portalY) < 180) continue;
    const n = randi(rng, 5, 9);
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, rr = rand(rng, 0, 142);
      const o = {
        type: 'circle', x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr,
        rad: rand(rng, 20, 32), style: room.biome.obstacleStyle,
        breakable: true, species: 'rubble', hp: SPECIES.rubble.hp + room.idx * 0.5,
        archKind: 'rubble', softCover: true,
      };
      if (dist(o.x, o.y, px, py) < ROOM.SPAWN_CLEAR || !fits(room, o, 6)) continue;
      room.obstacles.push(o); placed++;
    }
    if (placed >= 3 && reachableFrom(room, px, py).has(portalX, portalY)) {
      room.landmarks.push({ kind: 'rubble', x: cx, y: cy });
      return true;
    }
    room.obstacles.length = before;
  }
  return false;
}

function rollSpecies(rng, biome, idx, idolBump = false) {
  const w = { marrowJar: 18, bellHusk: 12, blackGlass: 12, rootCyst: 10, moonseedUrn: 7, falseIdol: 3 };
  if (idolBump) { w.falseIdol += 8; w.moonseedUrn += 6; }
  if (['mirror', 'shardreef', 'frostreliquary'].includes(biome.id)) w.blackGlass += 18;
  if (['verdigris', 'fen', 'mycelium', 'coilroot', 'rosewire', 'blacksungarden'].includes(biome.id)) { w.rootCyst += 14; w.marrowJar += 8; }
  if (['basilica', 'ossuary', 'empyrean', 'nullthrone', 'auricspire'].includes(biome.id)) { w.falseIdol += 7; w.bellHusk += 10; }
  if (idx >= 5) w.falseIdol += 3;
  const pool = Object.entries(w).map(([item, wt]) => ({ item, w: wt }));
  let total = 0; for (const p of pool) total += p.w;
  let roll = rng() * total;
  for (const p of pool) { roll -= p.w; if (roll <= 0) return p.item; }
  return 'marrowJar';
}

function buildAnnex(room, rng) {
  // Interior sealed vault. The old version hung the secret room off the OUTER wall, where
  // it intersected the perimeter edge-rail — so "grinding around the stage" could snag you
  // behind the secret door. Pulling the whole vault into the interior (well clear of the
  // wall loop) removes that interaction at the source. Paired with the smooth-slide
  // collision in player.js, the vault can never become a sticky dash coffin either.
  const span = rand(rng, 300, 390), depth = rand(rng, 190, 260);
  const side = pick(rng, ['n', 'e', 'w']); // which side carries the breakable door
  const wallPad = room.wall + 360;         // hard inset from every wall → off the edge-rail
  let rect = null, doorRect = null, cx = 0, cy = 0;
  const t = 18;
  const make = (x, y) => {
    const r = { x, y, w: side === 'n' ? span : depth, h: side === 'n' ? depth : span };
    if (side === 'n') doorRect = { x: r.x + r.w * 0.30, y: r.y + r.h - 16, w: r.w * 0.40, h: 18 };
    else if (side === 'e') doorRect = { x: r.x - 2, y: r.y + r.h * 0.30, w: 18, h: r.h * 0.40 };
    else doorRect = { x: r.x + r.w - 16, y: r.y + r.h * 0.30, w: 18, h: r.h * 0.40 };
    cx = r.x + r.w / 2; cy = r.y + r.h / 2;
    return r;
  };
  const outsideDoor = (r) => {
    if (side === 'n') return { x: r.x + r.w / 2, y: r.y + r.h + 80 };
    if (side === 'e') return { x: r.x - 80, y: r.y + r.h / 2 };
    return { x: r.x + r.w + 80, y: r.y + r.h / 2 };
  };
  for (let tries = 0; tries < 70; tries++) {
    const x = rand(rng, wallPad, room.w - wallPad - (side === 'n' ? span : depth));
    const y = rand(rng, room.wall + 260, room.h - room.wall - 360 - (side === 'n' ? depth : span));
    const r = make(x, y);
    const out = outsideDoor(r);
    if (dist(cx, cy, room.w / 2, room.h * 0.66) < ROOM.SPAWN_CLEAR + 260) continue;
    if (room.tiers?.some(tier => rectOverlap(r, tier, 120))) continue;
    const shellBox = { type: 'rect', x: r.x - t, y: r.y - t, w: r.w + t * 2, h: r.h + t * 2 };
    if (nearProtectedFlowLane(room, shellBox, -70, 'annex')) continue;
    if (!fits(room, shellBox, 28)) continue;
    const reach = reachableFrom(room, room.w / 2, room.h * 0.66);
    if (!reach.has(out.x, out.y)) continue;   // the door must be approachable from spawn
    rect = r;
    break;
  }
  if (!rect) return false;
  // secret #2: some sealed vaults are deep UNDERVAULTS — break the hatch and the floor
  // gives way to a buried chamber holding the special gem. Never an ambush (the descent
  // IS the payoff), darker themed, rarer than the ordinary cache.
  const underground = chance(rng, room.round >= 1 ? 0.30 : 0.18);
  const ambush = !underground && chance(rng, ANNEX.AMBUSH);
  room.annex = {
    side, rect, doorRect, opened: false, cx, cy, underground,
    kind: ambush ? 'ambush' : 'secret',
    ambushType: pick(rng, ['skitter', 'skitter', 'gunner']),
    ambushCount: randi(rng, 2, 3),
    reward: underground ? 'gem' : pick(rng, ['heart', 'repair', 'marrow']),
  };
  const wall = (x, y, w, h) => ({ type: 'rect', x, y, w, h, style: 'boundary', solidWall: true, wall: true, ledgeHeight: Infinity, archKind: 'interiorAnnex' });
  if (side === 'n') {
    room.obstacles.push(
      wall(rect.x - t, rect.y - t, t, rect.h + t * 2),
      wall(rect.x + rect.w, rect.y - t, t, rect.h + t * 2),
      wall(rect.x, rect.y - t, rect.w, t),
      wall(rect.x, rect.y + rect.h - 2, doorRect.x - rect.x, t),
      wall(doorRect.x + doorRect.w, rect.y + rect.h - 2, rect.x + rect.w - doorRect.x - doorRect.w, t),
    );
  } else if (side === 'e') {
    room.obstacles.push(
      wall(rect.x - t, rect.y - t, rect.w + t * 2, t),
      wall(rect.x - t, rect.y + rect.h, rect.w + t * 2, t),
      wall(rect.x + rect.w, rect.y, t, rect.h),
      wall(rect.x - 2, rect.y, t, doorRect.y - rect.y),
      wall(rect.x - 2, doorRect.y + doorRect.h, t, rect.y + rect.h - doorRect.y - doorRect.h),
    );
  } else {
    room.obstacles.push(
      wall(rect.x - t, rect.y - t, rect.w + t * 2, t),
      wall(rect.x - t, rect.y + rect.h, rect.w + t * 2, t),
      wall(rect.x - t, rect.y, t, rect.h),
      wall(rect.x + rect.w - t + 2, rect.y, t, doorRect.y - rect.y),
      wall(rect.x + rect.w - t + 2, doorRect.y + doorRect.h, t, rect.y + rect.h - doorRect.y - doorRect.h),
    );
  }
  room.obstacles.push({
    type: 'rect', ...doorRect, style: 'door', wall: true, underground,
    breakable: true, species: 'annexDoor', hp: SPECIES.annexDoor.hp + room.idx,
  });
  room.landmarks.push({ kind: underground ? 'undervault' : 'annexVault', x: cx, y: cy });
  return true;
}

// Secret #1 — the cloud dash-run. A straight, side-walled chute filled with cloud gates
// that only a DASH can punch through (they shrug off bullets), capped by a sealed pocket
// holding a power gem. A dead-end spur, validated so it can never strand the portal.
function seedCloudRun(room, rng, px, py, portalX, portalY) {
  if (!chance(rng, room.round >= 2 ? 0.24 : 0.15)) return false;
  const margin = room.wall + 200;
  const thick = 22, halfW = 86;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const onTier = (x, y, pad) => (room.tiers || []).some(t => x > t.x - pad && x < t.x + t.w + pad && y > t.y - pad && y < t.y + t.h + pad);
  for (let attempt = 0; attempt < 60; attempt++) {
    const [dx, dy] = pick(rng, dirs);
    const L = rand(rng, 540, 820);
    // mouth (open end) somewhere reachable-ish in the interior
    const mx = rand(rng, margin + 120, room.w - margin - 120);
    const my = rand(rng, margin + 120, room.h - margin - 120);
    const fx = mx + dx * L, fy = my + dy * L;                 // closed end
    // full footprint (chute + walls) must sit inside the playable inset
    const xLo = Math.min(mx, fx) - (dx ? 0 : halfW + thick);
    const xHi = Math.max(mx, fx) + (dx ? 0 : halfW + thick);
    const yLo = Math.min(my, fy) - (dy ? 0 : halfW + thick);
    const yHi = Math.max(my, fy) + (dy ? 0 : halfW + thick);
    if (xLo < margin || yLo < margin || xHi > room.w - margin || yHi > room.h - margin) continue;
    if (dist(mx, my, px, py) < ROOM.SPAWN_CLEAR + 80) continue;
    if (dist(fx, fy, portalX, portalY) < 240 || dist(mx, my, portalX, portalY) < 200) continue;
    // the whole footprint must be open ground (no obstacles, tiers, or protected lanes)
    let clear = true;
    for (let t = -0.05; t <= 1.05 && clear; t += 0.1) {
      const cxp = mx + dx * L * t, cyp = my + dy * L * t;
      if (pointBlockedForSpawn(room, cxp, cyp, halfW + thick + 20) || onTier(cxp, cyp, 70)) clear = false;
    }
    if (!clear) continue;
    const nx = -dy, ny = dx;                                   // unit perpendicular (axis-aligned)
    const wallObj = (x, y, w, h) => ({ type: 'rect', x, y, w: Math.max(10, w), h: Math.max(10, h), style: 'boundary', solidWall: true, wall: true, ledgeHeight: Infinity, archKind: 'cloudChute' });
    const before = room.obstacles.length, beforeFx = room.setpieces.length, beforePk = room.pickups.length;
    // two side rails + a back cap on the closed end
    const sideA = dx
      ? wallObj(Math.min(mx, fx), my + halfW, L, thick)
      : wallObj(mx + halfW, Math.min(my, fy), thick, L);
    const sideB = dx
      ? wallObj(Math.min(mx, fx), my - halfW - thick, L, thick)
      : wallObj(mx - halfW - thick, Math.min(my, fy), thick, L);
    const back = dx
      ? wallObj(fx - (dx > 0 ? 0 : thick), my - halfW - thick, thick, halfW * 2 + thick * 2)
      : wallObj(mx - halfW - thick, fy - (dy > 0 ? 0 : thick), halfW * 2 + thick * 2, thick);
    room.obstacles.push(sideA, sideB, back);
    // cloud gates strung down the centre — dash-only barricades (huge hp shrugs off shots)
    const gates = clamp(Math.round(L / 118), 3, 6);
    for (let i = 1; i <= gates; i++) {
      const t = i / (gates + 1);
      room.obstacles.push({
        type: 'circle', x: mx + dx * L * t, y: my + dy * L * t, rad: halfW * 0.92,
        style: 'cloud', breakable: true, species: 'cloudGate', hp: 999, cloud: true, dashKey: true, phase: rng() * TAU,
      });
    }
    // the gem, in the sealed pocket at the far end (persistent — no decay)
    const gx = fx - dx * 70, gy = fy - dy * 70;
    room.pickups.push({ type: 'gem', x: gx, y: gy, vx: 0, vy: 0, r: 13, life: Infinity, level: 0, secret: 'cloud', phase: rng() * TAU });
    // soft non-colliding cloud banks frame the run as a sky corridor
    for (let i = 0; i <= gates + 1; i++) {
      const t = i / (gates + 1);
      const bx = mx + dx * L * t, by = my + dy * L * t;
      room.setpieces.push({ kind: 'cloudBank', x: bx + nx * (halfW + 30), y: by + ny * (halfW + 30), r: rand(rng, 30, 46), level: 0, color: '#d4ecff', phase: rng() * TAU });
      room.setpieces.push({ kind: 'cloudBank', x: bx - nx * (halfW + 30), y: by - ny * (halfW + 30), r: rand(rng, 30, 46), level: 0, color: '#d4ecff', phase: rng() * TAU });
    }
    // validate: portal still reachable AND the mouth still reachable from spawn
    const reach = reachableFrom(room, px, py);
    if (!reach.has(portalX, portalY) || !reach.has(mx, my)) {
      room.obstacles.length = before;
      room.setpieces.length = beforeFx;
      room.pickups.length = beforePk;
      continue;
    }
    room.landmarks.push({ kind: 'cloudRun', x: (mx + fx) / 2, y: (my + fy) / 2 });
    return true;
  }
  return false;
}

// ── Off-routes: special grind rails that leave the map to a jackpot jewel and bounce you
// back. The SKYWAY climbs off a tall rooftop into open sky; the UNDERGROUND dives off a
// street pit DOWN into a dark cavern. Both string a turret gauntlet you dash through, and
// both reuse the sky-rail ride (player.updateSkyRailRide handles the rail.route branch). ──
function buildOffRoute(room, rng, opts) {
  const { kind, ex0, ey0, dx, dy, length, liftStart, liftEnd, color, level } = opts;
  const ex = ex0 + dx * length, ey = ey0 + dy * length;     // off-map apex (the jewel)
  const rail = {
    x1: ex0, y1: ey0, x2: ex, y2: ey, level, width: 66, boost: 2550,
    rise: 1, bow: 0, twists: 0, liftStart, liftEnd, color, phase: rng() * TAU,
  };
  const route = { rail, kind, launch: { x: ex0, y: ey0 }, jewel: { x: ex, y: ey }, color, taken: false };
  rail.route = route;
  (room.skyRails = room.skyRails || []).push(rail);
  (room.offRoutes = room.offRoutes || []).push(route);
  // turret sentinels along the off-map stretch (auto-dormant: turrets only fire within 980px)
  const n = randi(rng, 3, 5);
  for (let i = 0; i < n; i++) {
    const u = 0.34 + (n > 1 ? (i / (n - 1)) * 0.54 : 0);
    const e = makeEnemy('turret', ex0 + (ex - ex0) * u, ey0 + (ey - ey0) * u, room);
    e.level = level; e.offRoute = route; e.routeU = u;
    e.anchorX = e.x; e.anchorY = e.y;   // pinned to the rail so they never drift into play
    e.hp *= 0.7; e.maxHp = e.hp;
    room.enemies.push(e);
  }
  room.landmarks.push({ kind: kind === 'sky' ? 'skyway' : 'underway', x: ex0, y: ey0 });
  return route;
}

function seedSkyway(room, rng, px, py, portalX, portalY) {
  if (room.bossId || !chance(rng, room.round >= 2 ? 0.5 : 0.32)) return false;
  const tiers = room.tiers || [];
  if (!tiers.length) return false;
  const cx = room.w / 2, cy = room.h / 2;
  // launch from a TALL roof out near a city edge so the rail shoots cleanly off the map.
  const cands = tiers
    .map(t => ({ t, edge: Math.max(Math.abs(t.x + t.w / 2 - cx) / cx, Math.abs(t.y + t.h / 2 - cy) / cy), rise: t.rise || 1 }))
    .filter(o => o.edge > 0.32)
    .sort((a, b) => (b.edge * 0.6 + b.rise * 0.4) - (a.edge * 0.6 + a.rise * 0.4));
  const pickT = (cands[0] || { t: tiers[0] }).t;
  const lx = pickT.x + pickT.w / 2, ly = pickT.y + pickT.h / 2;
  let dx = lx - cx, dy = ly - cy; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  if (Math.abs(dx) >= Math.abs(dy)) dy *= 0.42; else dx *= 0.42;
  const dn = Math.hypot(dx, dy) || 1; dx /= dn; dy /= dn;
  const liftStart = TIER_LIFT * (pickT.rise || 1);
  buildOffRoute(room, rng, {
    kind: 'sky', ex0: lx, ey0: ly, dx, dy, length: rand(rng, 2700, 3500),
    liftStart, liftEnd: liftStart + rand(rng, 480, 740), color: '#9fe8ff', level: 1,
  });
  return true;
}

// The UNDERGROUND: a street-level grind rail that dives off a pit, off the map, DOWN into a
// dark cavern to a buried jewel. Mirrors the skyway but launches from the ground and the
// rail descends (liftEnd < 0). Latches at level 0 (see player.tryLatchSkyRail).
function seedUnderground(room, rng, px, py, portalX, portalY) {
  if (room.bossId || !chance(rng, room.round >= 2 ? 0.42 : 0.26)) return false;
  const margin = room.wall + 170;
  const onTier = (x, y) => (room.tiers || []).some(t => x > t.x - 90 && x < t.x + t.w + 90 && y > t.y - 90 && y < t.y + t.h + 90);
  // The pit sits in the lower city and the rail PLUNGES straight down off the bottom edge
  // into the cavern — world-down and screen-down (negative lift) agree, so it reads as a
  // real dive into a hole rather than fighting itself.
  for (let attempt = 0; attempt < 50; attempt++) {
    const ox = rand(rng, margin, room.w - margin);
    const oy = rand(rng, room.h * 0.60, room.h - margin);
    if (dist(ox, oy, px, py) < ROOM.SPAWN_CLEAR + 120 || dist(ox, oy, portalX, portalY) < 280) continue;
    if (pointBlockedForSpawn(room, ox, oy, 150) || onTier(ox, oy)) continue;
    let dx = rand(rng, -0.34, 0.34), dy = 1; const dn = Math.hypot(dx, dy); dx /= dn; dy /= dn; // steep plunge down
    buildOffRoute(room, rng, {
      kind: 'under', ex0: ox, ey0: oy, dx, dy, length: (room.h - oy) + rand(rng, 1500, 2100),
      liftStart: 0, liftEnd: -rand(rng, 380, 580), color: '#ffd9a6', level: 0,
    });
    return true;
  }
  return false;
}

// ── Neon districts + flow lanes (ported from ChatGPT's "neon districts" build) ──
// Districts are big NON-COLLIDING city slabs baked under the fight (the sprawl reads
// as a place, not added collision). Flow lanes are wide boost boulevards that speed
// you along them (player.js applyFlowLanes) — momentum highways across the sprawl.
const DISTRICT_PREFIX = ['Neon', 'Orbital', 'Nullstar', 'Chrome', 'Afterlight', 'Prism', 'Ghost', 'Blackglass', 'Void', 'Signal'];
const DISTRICT_CORE = ['Arcology', 'Market', 'Harbor', 'Rail', 'Stack', 'Canal', 'Sprawl', 'Exchange', 'Array', 'Boulevard'];
const DISTRICT_KIND = ['market', 'rail', 'dock', 'arcology', 'reactor', 'garden', 'data', 'shrine'];

function rollDistrictName(room, rng) {
  if (room.bossId) return `${pick(rng, DISTRICT_PREFIX)} ${pick(rng, ['Citadel', 'Apex', 'Kill-Stack', 'Throne'])}`;
  return `${pick(rng, DISTRICT_PREFIX)} ${pick(rng, DISTRICT_CORE)}`;
}
function rollDistrictSubtitle(room, rng) {
  const suffix = pick(rng, ['endless district', 'cyberpunk drift', 'orbital block', 'star-city floor', 'light-speed lane']);
  return `${room.biome.mech} · ${suffix}`;
}

function seedDistricts(room, rng, px, py, portalX, portalY) {
  const pal = room.biome.pal;
  const cols = room.w > 5600 ? 7 : room.w > 4200 ? 6 : 5;
  const rows = room.h > 4200 ? 6 : room.h > 3200 ? 5 : 4;
  const wall = room.wall + 118;
  // Dense, organized neighborhood grid: every slab becomes a proper city block, not an
  // empty neon square. The buildings are non-colliding, baked skyline detail, so the
  // player still gets clean breakneck pathing through the streets.
  const baseHue = Math.floor(rng() * 360);
  let id = 0;
  const addDistrict = (d) => {
    d.buildings = makeDistrictBuildings(room, rng, d);
    room.districts.push(d);
    return d;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // No missing city teeth: only skip truly tiny/unsafe cells near spawn/exit.
      const cw = (room.w - wall * 2) / cols;
      const ch = (room.h - wall * 2) / rows;
      const x = wall + c * cw + rand(rng, 10, 34);
      const y = wall + r * ch + rand(rng, 10, 34);
      const w = cw * rand(rng, 0.74, 0.94);
      const h = ch * rand(rng, 0.70, 0.90);
      const cx = x + w / 2, cy = y + h / 2;
      if (dist(cx, cy, px, py) < 315 || dist(cx, cy, portalX, portalY) < 235) continue;
      const hue = (baseHue + id * 43 + c * 19 + r * 31) % 360;
      addDistrict({
        id: id++, x, y, w, h, cx, cy,
        kind: pick(rng, DISTRICT_KIND),
        color: `hsl(${hue}, 86%, 64%)`,
        name: `${pick(rng, DISTRICT_PREFIX)} ${pick(rng, DISTRICT_CORE)}`, // floating holo sign
        phase: rng() * TAU,
        gridC: c, gridR: r,
      });
    }
  }
  // Functional anchors stay in the biome's own accents, but they still get perimeter
  // towers so the start/exit/plaza read as city places instead of blank UI pads.
  addDistrict({ id: id++, x: px - 420, y: py - 280, w: 840, h: 560, cx: px, cy: py, kind: 'spawn', color: pal.accent3, phase: rng() * TAU, anchor: true });
  addDistrict({ id: id++, x: portalX - 390, y: portalY - 250, w: 780, h: 500, cx: portalX, cy: portalY, kind: 'exit', color: pal.accent2, phase: rng() * TAU, anchor: true });
  addDistrict({ id: id++, x: room.w * 0.5 - 520, y: room.h * 0.47 - 360, w: 1040, h: 720, cx: room.w * 0.5, cy: room.h * 0.47, kind: 'plaza', color: pal.accent, phase: rng() * TAU, anchor: true });
}

function makeDistrictBuildings(room, rng, d) {
  const out = [];
  const area = d.w * d.h;
  const functional = d.kind === 'spawn' || d.kind === 'exit';
  const pad = functional ? 34 : d.kind === 'plaza' ? 26 : 22;
  const target = clamp(Math.round(area / (functional ? 36000 : 25500)), functional ? 10 : 16, functional ? 22 : 46);
  const clearRunway = (x, y, w, h) => {
    if (!functional && d.kind !== 'plaza') return false;
    const cx = x + w / 2, cy = y + h / 2;
    // leave a visible launch/exit throat, but pack towers around it
    return Math.abs(cx) < d.w * (functional ? 0.18 : 0.11) && Math.abs(cy) < d.h * (functional ? 0.20 : 0.13);
  };
  const overlaps = (b, m = 7) => out.some(o => b.x < o.x + o.w + m && b.x + b.w + m > o.x && b.y < o.y + o.h + m && b.y + b.h + m > o.y);
  for (let tries = 0; tries < target * 7 && out.length < target; tries++) {
    const bw = rand(rng, functional ? 42 : 50, d.kind === 'arcology' ? 122 : 104);
    const bh = rand(rng, functional ? 38 : 46, d.kind === 'rail' ? 78 : 112);
    const x = rand(rng, -d.w / 2 + pad, d.w / 2 - pad - bw);
    const y = rand(rng, -d.h / 2 + pad, d.h / 2 - pad - bh);
    const b = { x, y, w: bw, h: bh };
    if (clearRunway(x, y, bw, bh) || overlaps(b)) continue;
    const edge = Math.max(Math.abs(x + bw / 2) / (d.w / 2), Math.abs(y + bh / 2) / (d.h / 2));
    const tallBias = d.kind === 'arcology' || d.kind === 'reactor' || d.kind === 'data' || d.kind === 'exit' ? 1.22 : 1;
    const z = rand(rng, functional ? 64 : 86, functional ? 170 : 245) * tallBias * (0.82 + edge * 0.35);
    out.push({
      x, y, w: bw, h: bh,
      z: clamp(z, 58, d.kind === 'plaza' || d.kind === 'arcology' ? 310 : 270),
      floors: randi(rng, 4, 13),
      lit: rng(),
      roof: pick(rng, ['flat', 'dish', 'spire', 'antenna', 'garden']),
      shade: rand(rng, 0.10, 0.34),
      stripe: chance(rng, 0.42),
    });
  }
  // One to three heroic towers per big block: visible height and skyline drama.
  const heroic = functional ? 1 : clamp(Math.round(area / 260000), 1, 3);
  for (let i = 0; i < heroic; i++) {
    const bw = rand(rng, 58, 98), bh = rand(rng, 58, 112);
    const x = rand(rng, -d.w * 0.35, d.w * 0.35) - bw / 2;
    const y = rand(rng, -d.h * 0.34, d.h * 0.34) - bh / 2;
    const b = { x, y, w: bw, h: bh };
    if (clearRunway(x, y, bw, bh) || overlaps(b, 14)) continue;
    out.push({ x, y, w: bw, h: bh, z: rand(rng, 210, functional ? 260 : 345), floors: randi(rng, 9, 18), lit: 0.95, roof: 'spire', shade: 0.08, stripe: true, heroic: true });
  }
  return out;
}

function seedFlowLanes(room, rng, px, py, portalX, portalY) {
  const pal = room.biome.pal;
  const wall = room.wall + 92;
  const clampX = (x) => clamp(x, wall, room.w - wall);
  const clampY = (y) => clamp(y, wall, room.h - wall);
  const add = (x1, y1, x2, y2, width, boost, color, kind = 'boulevard', target = null) => {
    const lane = {
      x1: clampX(x1), y1: clampY(y1), x2: clampX(x2), y2: clampY(y2),
      width, boost, color, phase: rng() * TAU, kind,
    };
    if (target) Object.assign(lane, target);
    room.flowLanes.push(lane);
    return lane;
  };
  const mid = {
    x: clampX(room.w / 2 + rand(rng, -room.w * 0.10, room.w * 0.10)),
    y: clampY(room.h * rand(rng, 0.42, 0.52)),
  };
  const arteryW = room.bossId ? 166 : 188;
  add(px, py, mid.x, mid.y, arteryW, 740, pal.accent3, 'artery', { targetX: mid.x, targetY: mid.y, targetKind: 'midcity', targetLabel: 'MID' });
  add(mid.x, mid.y, portalX, portalY + 24, arteryW, 780, pal.accent2, 'artery', { targetX: portalX, targetY: portalY, targetKind: 'portal', targetLabel: 'EXIT' });

  // The city should always have an obvious high-speed grid. These are not walls;
  // they are readable boost roads that keep the player moving instead of searching.
  // Fewer ground roads — the upper layer (rooftops) is the playground now, not the street.
  // Keep a sparse cross so the city still reads as a city and you can rejoin speed, but
  // most traversal is meant to happen up top.
  const hBands = room.bossId ? [0.34, 0.66] : [0.30, 0.68];
  for (const f of hBands) {
    const y = clampY(room.h * f + rand(rng, -58, 58));
    add(wall + rand(rng, 0, 70), y, room.w - wall - rand(rng, 0, 70), y + rand(rng, -65, 65), rand(rng, 116, 166), rand(rng, 560, 720), chance(rng, 0.5) ? pal.accent : pal.accent3);
  }
  const vBands = room.bossId ? [0.40, 0.62] : [0.32, 0.66];
  for (const f of vBands) {
    const x = clampX(room.w * f + rand(rng, -64, 64));
    add(x, wall + rand(rng, 0, 70), x + rand(rng, -70, 70), room.h - wall - rand(rng, 0, 70), rand(rng, 108, 158), rand(rng, 540, 700), chance(rng, 0.5) ? pal.accent2 : pal.accent3);
  }
  const diagonals = room.bossId ? 1 : 2;
  for (let i = 0; i < diagonals; i++) {
    const leftStart = chance(rng, 0.5);
    add(leftStart ? wall : room.w - wall, rand(rng, room.h * 0.20, room.h * 0.42),
      leftStart ? room.w - wall : wall, rand(rng, room.h * 0.58, room.h * 0.82),
      rand(rng, 92, 128), rand(rng, 520, 690), chance(rng, 0.5) ? pal.accent : pal.accent2, 'side');
  }
}

function retargetFlowLanes(room, rng, px, py, portalX, portalY) {
  const points = [];
  const addPoint = (x, y, kind, label, value = 1, level = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    points.push({ x, y, kind, label, value, level });
  };
  addPoint(portalX, portalY, 'portal', 'EXIT', 6);
  addPoint(px, py, 'spawn', 'START', 1.2);
  if (room.shop && !room.shop.bought) addPoint(room.shop.x, room.shop.y, 'shop', 'SHOP', 4.8);
  for (const q of room.pickups || []) if (q.type === 'gem' || q.type === 'core' || q.secret) addPoint(q.x, q.y, q.type === 'gem' ? 'gem' : 'core', q.type === 'gem' ? 'GEM' : 'CORE', q.type === 'gem' ? 5.2 : 4.2, q.level || 0);
  for (const v of room.vents || []) addPoint(v.x, v.y, v.kind === 'dropfan' ? 'dropfan' : 'vent', v.kind === 'dropfan' ? 'DROP' : 'ROOF', 3.6 + (v.toLevel || 0), v.fromLevel || 0);
  for (const t of room.tiers || []) addPoint(t.ramp?.x || (t.x + t.w / 2), t.y + t.h, 'ramp', 'ROOF', 3.2, 0);
  for (const l of room.landmarks || []) {
    const val = l.kind === 'skyway' ? 5.8 : l.kind === 'underway' ? 5.6
      : l.kind === 'skyCache' || l.kind === 'mysteryVault' || l.kind === 'undervault' ? 5.2
      : l.kind === 'dashBell' ? 4.4 : l.kind === 'highGround' ? 3.8 : l.kind === 'vent' ? 3.6 : 2.2;
    const label = l.kind === 'dashBell' ? 'DASH' : l.kind === 'skyCache' ? 'CACHE' : l.kind === 'skyway' ? 'SKY' : l.kind === 'underway' ? 'DOWN' : 'GO';
    if (val >= 3.2) addPoint(l.x, l.y, l.kind, label, val);
  }
  room.waypoints = points;
  const lanes = room.flowLanes || [];
  if (!lanes.length || !points.length) return;
  for (const l of lanes) {
    // Arteries already know their explicit destination; everything else points to
    // the most valuable thing near/along the road, so arrows are never decorative nonsense.
    if (l.targetKind === 'portal') continue;
    const dx = l.x2 - l.x1, dy = l.y2 - l.y1, len2 = dx * dx + dy * dy || 1;
    let best = null, bestScore = -Infinity;
    for (const p of points) {
      if (p.kind === 'spawn' && l.kind !== 'artery') continue;
      const u = clamp(((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len2, 0, 1);
      const cx = l.x1 + dx * u, cy = l.y1 + dy * u;
      const d = dist(p.x, p.y, cx, cy);
      const endD = Math.min(dist(p.x, p.y, l.x1, l.y1), dist(p.x, p.y, l.x2, l.y2));
      const sidePenalty = d * 0.006 + endD * 0.0012;
      const kindBonus = p.kind === 'portal' ? 1.8 : p.kind === 'gem' ? 1.6 : p.kind === 'shop' ? 1.3 : p.kind === 'vent' ? 1.15 : 1;
      const score = p.value * kindBonus - sidePenalty + (l.kind === 'express' ? 0.4 : 0) + rng() * 0.08;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) best = points[0];
    l.targetX = best.x; l.targetY = best.y; l.targetKind = best.kind; l.targetLabel = best.label;
  }

  // Small destination spurs: thin, bright ramps off the main grid into roof fans,
  // cache/gem pockets, and the shop. These are not collision; they are the city's
  // “worth it, go here” bloodstream.
  const spurTargets = points
    .filter(p => ['gem', 'core', 'shop', 'vent', 'ramp', 'skyCache', 'mysteryVault', 'undervault', 'dashBell'].includes(p.kind))
    .sort((a, b) => b.value - a.value)
    .slice(0, room.bossId ? 3 : 8);
  for (const p of spurTargets) {
    let bestLane = null, bestInfo = null, bd = Infinity;
    for (const l of lanes) {
      if (l.kind === 'spur') continue;
      const info = segmentProjection(p.x, p.y, l.x1, l.y1, l.x2, l.y2);
      if (info.d < bd) { bd = info.d; bestLane = l; bestInfo = info; }
    }
    if (!bestLane || !bestInfo || bd < 150 || bd > 760) continue;
    const clear = !room.obstacles?.some(o => o.wall && !o.breakable && segmentBoxBlocked(bestInfo.cx, bestInfo.cy, p.x, p.y, o, 34));
    if (!clear) continue;
    const color = p.kind === 'gem' || p.kind === 'skyCache' || p.kind === 'mysteryVault' ? room.biome.pal.accent2 : bestLane.color || room.biome.pal.accent3;
    room.flowLanes.push({
      x1: bestInfo.cx, y1: bestInfo.cy, x2: p.x, y2: p.y,
      width: 74, boost: 640, color, phase: rng() * TAU,
      kind: 'spur', targetX: p.x, targetY: p.y, targetKind: p.kind, targetLabel: p.label,
    });
  }
}

function segmentProjection(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  const cx = x1 + dx * t, cy = y1 + dy * t;
  return { t, cx, cy, d: dist(px, py, cx, cy) };
}

function segmentBoxBlocked(x1, y1, x2, y2, o, pad = 0) {
  if (o.type === 'circle') return distPointSegment(o.x, o.y, x1, y1, x2, y2) < (o.rad || 0) + pad;
  const b = { x: o.x - pad, y: o.y - pad, w: o.w + pad * 2, h: o.h + pad * 2 };
  // Cheap segment-vs-AABB: endpoint inside or intersects any side.
  if ((x1 >= b.x && x1 <= b.x + b.w && y1 >= b.y && y1 <= b.y + b.h) || (x2 >= b.x && x2 <= b.x + b.w && y2 >= b.y && y2 <= b.y + b.h)) return true;
  const hit = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const den = (dx - cx) * (by - ay) - (dy - cy) * (bx - ax);
    if (Math.abs(den) < 1e-6) return false;
    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
    const v = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  };
  return hit(x1, y1, x2, y2, b.x, b.y, b.x + b.w, b.y)
    || hit(x1, y1, x2, y2, b.x + b.w, b.y, b.x + b.w, b.y + b.h)
    || hit(x1, y1, x2, y2, b.x + b.w, b.y + b.h, b.x, b.y + b.h)
    || hit(x1, y1, x2, y2, b.x, b.y + b.h, b.x, b.y);
}

// ── City dressing (ported from ChatGPT's Round 2): skyways, neon signs, traffic
// flecks. All NON-COLLIDING and BAKED into the background — the "well-fleshed world"
// without any per-frame cost or new collision. ──
const SIGN_WORDS = ['NULL', 'MOON', 'EXIT', 'EAT', 'LIVE', 'HUSH', 'GOD', 'WIRE', 'GRAFT', 'BLOOM', 'NOIR', 'OPEN', 'KILL', 'SAINT'];

function seedCityDressing(room, rng, px, py, portalX, portalY) {
  const pal = room.biome.pal;
  const districts = room.districts || [];
  const lanes = room.flowLanes || [];
  const byDist = (a, b) => dist(a.cx, a.cy, b.cx, b.cy);

  // Elevated transit rails between neighborhoods — depth without stealing pathing.
  // Trimmed for legibility: still reads as a layered skyline, far less background churn.
  const skyCount = room.bossId ? randi(rng, 4, 6) : randi(rng, genMobile() ? 6 : 9, genMobile() ? 9 : 15);
  for (let i = 0; i < skyCount && districts.length > 1; i++) {
    const a = pick(rng, districts);
    const options = districts.filter(d => d !== a).sort((u, v) => byDist(a, u) - byDist(a, v));
    const b = options[Math.min(options.length - 1, randi(rng, 1, Math.min(5, Math.max(1, options.length - 1))))] || pick(rng, districts);
    if (!b || dist(a.cx, a.cy, b.cx, b.cy) < 520) continue;
    room.skyways.push({
      x1: a.cx + rand(rng, -a.w * 0.18, a.w * 0.18), y1: a.cy + rand(rng, -a.h * 0.18, a.h * 0.18),
      x2: b.cx + rand(rng, -b.w * 0.18, b.w * 0.18), y2: b.cy + rand(rng, -b.h * 0.18, b.h * 0.18),
      color: chance(rng, 0.5) ? a.color : pal.accent3, width: rand(rng, 18, 34), phase: rng() * TAU,
    });
  }

  // Tiny neon signage gives each slab a "place" without becoming cover (district-tinted).
  // Heavily trimmed: 46–76 floating words per room was the #1 readability offender —
  // they cluttered the playfield and read like UI. A handful per district is plenty.
  const signCount = room.bossId ? randi(rng, 5, 8) : randi(rng, genMobile() ? 10 : 16, genMobile() ? 16 : 26);
  for (let i = 0; i < signCount && districts.length; i++) {
    const d = pick(rng, districts);
    const edge = randi(rng, 0, 3), pad = 36;
    const x = edge === 0 ? d.x + rand(rng, pad, d.w - pad) : edge === 1 ? d.x + d.w - rand(rng, 8, 26) : edge === 2 ? d.x + rand(rng, pad, d.w - pad) : d.x + rand(rng, 8, 26);
    const y = edge === 0 ? d.y + rand(rng, 8, 26) : edge === 1 ? d.y + rand(rng, pad, d.h - pad) : edge === 2 ? d.y + d.h - rand(rng, 8, 26) : d.y + rand(rng, pad, d.h - pad);
    if (dist(x, y, px, py) < 250 || dist(x, y, portalX, portalY) < 190) continue;
    room.signs.push({
      x, y, w: rand(rng, 56, 132), h: rand(rng, 18, 34),
      rot: edge === 1 || edge === 3 ? Math.PI / 2 + rand(rng, -0.08, 0.08) : rand(rng, -0.08, 0.08),
      color: chance(rng, 0.55) ? d.color : chance(rng, 0.5) ? pal.accent : pal.accent2,
      text: pick(rng, SIGN_WORDS),
    });
  }

  // Baked traffic flecks along the boost roads — the metropolis feels inhabited.
  // Pulled back so the boost roads still glitter with motion without speckling the floor.
  const trafficCount = room.bossId ? randi(rng, 38, 60) : randi(rng, genMobile() ? 80 : 120, genMobile() ? 130 : 190);
  for (let i = 0; i < trafficCount && lanes.length; i++) {
    const l = pick(rng, lanes);
    const at = rand(rng, 0.04, 0.96), dx = l.x2 - l.x1, dy = l.y2 - l.y1;
    const len = Math.hypot(dx, dy) || 1, lx = dx / len, ly = dy / len, nx = -ly, ny = lx;
    const off = rand(rng, -(l.width || 80) * 0.42, (l.width || 80) * 0.42);
    room.traffic.push({
      x: l.x1 + dx * at + nx * off, y: l.y1 + dy * at + ny * off,
      lx, ly, len: rand(rng, 18, 64), color: chance(rng, 0.58) ? l.color : '#ffffff', alpha: rand(rng, 0.08, 0.24),
    });
  }
}

// obstacles keep clear of the main arteries/boulevards so the boost routes stay open.
function nearProtectedFlowLane(room, o, margin = 0, mode = 'all') {
  if (!room.flowLanes?.length) return false;
  const b = aabb(o);
  const pts = [
    [b.x + b.w / 2, b.y + b.h / 2], [b.x, b.y], [b.x + b.w, b.y],
    [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
  ];
  const radius = o.type === 'circle' ? o.rad : Math.min(140, Math.hypot(b.w, b.h) * 0.36);
  for (const l of room.flowLanes) {
    if (mode === 'tierCore' && !(l.kind === 'artery' || l.kind === 'express')) continue;
    let laneProtect = l.kind === 'artery' ? 1.0 : l.kind === 'express' ? 0.82 : l.kind === 'boulevard' ? 0.58 : 0.28;
    if (mode === 'tier' || mode === 'tierCore') laneProtect *= l.kind === 'artery' ? 0.72 : l.kind === 'express' ? 0.58 : 0.18;
    const protect = (l.width || 90) * 0.5 * laneProtect + radius + margin;
    if (protect <= 24) continue;
    if (pts.some(([x, y]) => distPointSegment(x, y, l.x1, l.y1, l.x2, l.y2) < protect)) return true;
  }
  return false;
}

function distPointSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return dist(px, py, x1 + dx * t, y1 + dy * t);
}

function paintDistrictBuildings(ctx, d, pal, x, y) {
  const buildings = d.buildings || [];
  if (!buildings.length) return;
  ctx.save();
  // Keep the skyline married to its city slab, but let heroic spires kiss the edge.
  roundRect(ctx, x - 8, y - 24, d.w + 16, d.h + 36, 24);
  ctx.clip();
  for (const b of buildings) {
    const lift = (b.z || 120) * 0.40;
    const ox = -lift * 0.16, oy = -lift * 0.48;
    const ax = b.x, ay = b.y, bx = b.x + b.w, by = b.y + b.h;
    const A = [ax, ay], B = [bx, ay], C = [bx, by], D = [ax, by];
    const A2 = [ax + ox, ay + oy], B2 = [bx + ox, ay + oy], C2 = [bx + ox, by + oy], D2 = [ax + ox, by + oy];
    const tower = b.heroic ? 1 : 0;
    // Body: dark glass faces, color-tinted rim, tiny window runs. No shadows; this is baked.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.34 + Math.min(0.16, lift / 900);
    ctx.fillStyle = mixHexA(pal.bg, '#000000', 0.30 + (b.shade || 0.18));
    ctx.beginPath(); ctx.moveTo(...D2); ctx.lineTo(...C2); ctx.lineTo(...C); ctx.lineTo(...D); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = mixHexA(pal.floor, '#000000', 0.40 + (b.shade || 0.12));
    ctx.beginPath(); ctx.moveTo(...B2); ctx.lineTo(...C2); ctx.lineTo(...C); ctx.lineTo(...B); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.40;
    ctx.fillStyle = mixHexA(pal.floor, d.kind === 'exit' ? pal.accent2 : pal.accent, 0.12);
    ctx.beginPath(); ctx.moveTo(...A2); ctx.lineTo(...B2); ctx.lineTo(...C2); ctx.lineTo(...D2); ctx.closePath(); ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = b.heroic ? 0.55 : 0.34;
    ctx.strokeStyle = d.color || pal.accent3; ctx.lineWidth = b.heroic ? 1.7 : 1.1;
    ctx.beginPath(); ctx.moveTo(...A2); ctx.lineTo(...B2); ctx.lineTo(...C2); ctx.lineTo(...D2); ctx.closePath(); ctx.stroke();
    ctx.globalAlpha = 0.18 + (b.lit || 0) * 0.16;
    ctx.strokeStyle = b.lit > 0.75 ? '#ffffff' : (d.color || pal.accent2);
    ctx.lineWidth = b.heroic ? 1.25 : 0.85;
    const floors = Math.max(3, b.floors || 5);
    for (let i = 1; i < floors; i++) {
      const t = i / floors;
      const yy1 = D2[1] + (D[1] - D2[1]) * t;
      const yy2 = C2[1] + (C[1] - C2[1]) * t;
      ctx.beginPath(); ctx.moveTo(D2[0] + 5, yy1); ctx.lineTo(C2[0] - 5, yy2); ctx.stroke();
    }
    if (b.stripe) {
      ctx.globalAlpha = b.heroic ? 0.44 : 0.26;
      ctx.strokeStyle = d.color || pal.accent3; ctx.lineWidth = b.heroic ? 2.1 : 1.4;
      ctx.beginPath(); ctx.moveTo((A2[0] + B2[0]) / 2, A2[1] + 6); ctx.lineTo((D[0] + C[0]) / 2, D[1] - 5); ctx.stroke();
    }
    if (b.roof === 'antenna' || b.roof === 'spire' || b.heroic) {
      const mx = (A2[0] + B2[0] + C2[0] + D2[0]) / 4;
      const my = (A2[1] + B2[1] + C2[1] + D2[1]) / 4;
      ctx.globalAlpha = b.heroic ? 0.75 : 0.42;
      ctx.strokeStyle = b.heroic ? '#ffffff' : (d.color || pal.accent2);
      ctx.lineWidth = b.heroic ? 2.0 : 1.2;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx - lift * 0.05, my - (22 + tower * 22)); ctx.stroke();
      ctx.beginPath(); ctx.arc(mx - lift * 0.05, my - (24 + tower * 22), b.heroic ? 3.2 : 2.0, 0, TAU); ctx.stroke();
    } else if (b.roof === 'dish') {
      const mx = (A2[0] + C2[0]) / 2, my = (A2[1] + C2[1]) / 2;
      ctx.globalAlpha = 0.28; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.ellipse(mx, my, Math.min(12, b.w * 0.16), Math.min(6, b.h * 0.10), -0.4, 0, TAU); ctx.stroke();
    } else if (b.roof === 'garden') {
      const mx = (A2[0] + C2[0]) / 2, my = (A2[1] + C2[1]) / 2;
      ctx.globalAlpha = 0.25; ctx.fillStyle = pal.accent;
      ctx.beginPath(); ctx.arc(mx, my, Math.min(8, b.w * 0.11), 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

function paintNeonDistricts(ctx, room, rng, pal) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter'; // additive: each neighborhood's distinct neon hue glows
  // District slabs: big NON-COLLIDING city blocks under the fight, each its own neon colour.
  for (const d of room.districts || []) {
    ctx.save();
    ctx.translate(d.cx, d.cy);
    ctx.rotate(Math.sin(d.phase) * 0.035);
    const x = -d.w / 2, y = -d.h / 2;
    ctx.globalAlpha = d.kind === 'spawn' || d.kind === 'exit' ? 0.12 : 0.105;
    ctx.fillStyle = d.color || pal.accent3;
    roundRect(ctx, x, y, d.w, d.h, 22); ctx.fill();
    ctx.globalAlpha = 0.24;
    ctx.strokeStyle = d.color || pal.accent3;
    ctx.lineWidth = d.kind === 'plaza' ? 4 : 2.2;
    roundRect(ctx, x, y, d.w, d.h, 22); ctx.stroke();
    const cols = clamp(Math.floor(d.w / 150), 3, 9);
    const rows = clamp(Math.floor(d.h / 120), 2, 7);
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = d.kind === 'rail' ? pal.accent2 : d.color || pal.accent;
    ctx.lineWidth = 1.4;
    for (let c = 1; c < cols; c++) { const xx = x + (d.w * c) / cols; ctx.beginPath(); ctx.moveTo(xx, y + 18); ctx.lineTo(xx, y + d.h - 18); ctx.stroke(); }
    for (let r = 1; r < rows; r++) { const yy = y + (d.h * r) / rows; ctx.beginPath(); ctx.moveTo(x + 18, yy); ctx.lineTo(x + d.w - 18, yy); ctx.stroke(); }
    if (d.kind === 'reactor' || d.kind === 'plaza' || d.kind === 'exit') {
      ctx.globalAlpha = 0.20; ctx.strokeStyle = pal.accent2; ctx.lineWidth = 3;
      const rr = Math.min(d.w, d.h) * 0.26;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, rr * 0.58, 0, TAU); ctx.stroke();
    }
    paintDistrictBuildings(ctx, d, pal, x, y);
    ctx.restore();
  }
  // Baked road shadows under the live flow lanes (drawn animated in draw.js).
  ctx.globalCompositeOperation = 'lighter';
  for (const l of room.flowLanes || []) {
    ctx.globalAlpha = l.kind === 'artery' ? 0.12 : 0.07;
    ctx.strokeStyle = l.color || pal.accent3;
    ctx.lineWidth = (l.width || 90) * (l.kind === 'artery' ? 1.22 : 1.05);
    ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke();
    ctx.globalAlpha *= 0.5; ctx.strokeStyle = pal.bg; ctx.lineWidth *= 0.42;
    ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke();
  }
  ctx.restore(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

// Baked city dressing: skyways (aerial rails), traffic flecks, and neon signage.
function paintCityDressing(ctx, room, rng, pal) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';
  for (const sw of room.skyways || []) {
    ctx.globalAlpha = 0.05; ctx.strokeStyle = sw.color || pal.accent2; ctx.lineWidth = (sw.width || 24) * 1.9;
    ctx.beginPath(); ctx.moveTo(sw.x1, sw.y1); ctx.lineTo(sw.x2, sw.y2); ctx.stroke();
    ctx.globalAlpha = 0.20; ctx.lineWidth = 1.7; ctx.setLineDash([22, 18]); ctx.lineDashOffset = (sw.phase || 0) * 18;
    ctx.beginPath(); ctx.moveTo(sw.x1, sw.y1); ctx.lineTo(sw.x2, sw.y2); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const tr of room.traffic || []) {
    ctx.globalAlpha = tr.alpha || 0.12; ctx.strokeStyle = tr.color || pal.accent3; ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(tr.x - tr.lx * tr.len * 0.5, tr.y - tr.ly * tr.len * 0.5);
    ctx.lineTo(tr.x + tr.lx * tr.len * 0.5, tr.y + tr.ly * tr.len * 0.5);
    ctx.stroke();
  }
  for (const sg of room.signs || []) {
    ctx.save();
    ctx.translate(sg.x, sg.y); ctx.rotate(sg.rot || 0);
    ctx.globalAlpha = 0.15; ctx.fillStyle = sg.color || pal.accent;
    roundRect(ctx, -sg.w / 2, -sg.h / 2, sg.w, sg.h, 6); ctx.fill();
    ctx.globalAlpha = 0.40; ctx.strokeStyle = sg.color || pal.accent; ctx.lineWidth = 1.5;
    roundRect(ctx, -sg.w / 2, -sg.h / 2, sg.w, sg.h, 6); ctx.stroke();
    // abstract light-glyphs, not random words stamped into the floor
    ctx.globalAlpha = 0.48; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    const bars = 3 + Math.floor(((sg.x + sg.y) % 3));
    for (let i = 0; i < bars; i++) {
      const yy = -sg.h * 0.24 + i * (sg.h * 0.18);
      ctx.beginPath(); ctx.moveTo(-sg.w * 0.32, yy); ctx.lineTo(sg.w * (0.12 + i * 0.08), yy); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(sg.w * 0.32, 0, Math.min(7, sg.h * 0.20), 0, TAU); ctx.stroke();
    ctx.restore();
  }
  ctx.restore(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
}

function paintFloorIdentity(ctx, room, rng, pal) {
  const { w, h } = room, wall = room.wall;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // corner brackets frame the floor
  ctx.globalAlpha = 0.13; ctx.strokeStyle = pal.accent3; ctx.lineWidth = 4;
  const m = wall + 36, L = 70 + rng() * 46;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x = sx > 0 ? m : w - m, y = sy > 0 ? m : h - m;
    ctx.beginPath(); ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); ctx.stroke();
  }
  ctx.restore(); ctx.globalAlpha = 1;
  // the biome's signature emblem is the centre motif (replaces the old generic one),
  // so every biome reads as itself even when two share a colour family.
  paintSignature(room.biome, ctx, w, h, rng, pal);
}

function paintArchitecturalDecals(room, ctx, rng, pal) {
  const spawn = { x: room.w / 2, y: room.h * 0.66 }, portal = { x: room.w / 2, y: room.h * 0.20 };
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // A faint pilgrimage path gives the huge floor direction: spawn → middle → portal.
  const midY = room.h * (room.floorplanId === 'none' ? 0.46 : 0.50);
  ctx.strokeStyle = hexA(pal.accent3, 0.10); ctx.lineWidth = Math.max(46, Math.min(room.w, room.h) * 0.045);
  ctx.beginPath(); ctx.moveTo(spawn.x, spawn.y); ctx.bezierCurveTo(room.w * 0.44, midY, room.w * 0.56, midY, portal.x, portal.y); ctx.stroke();
  ctx.strokeStyle = hexA(pal.bg, 0.16); ctx.lineWidth *= 0.46;
  ctx.beginPath(); ctx.moveTo(spawn.x, spawn.y); ctx.bezierCurveTo(room.w * 0.46, midY, room.w * 0.54, midY, portal.x, portal.y); ctx.stroke();

  // Large room seals: one readable landmark beats fifty random freckles.
  const seals = room.bossId ? 3 : 2;
  for (let i = 0; i < seals; i++) {
    const x = room.w * rand(rng, 0.28, 0.72), y = room.h * rand(rng, 0.27, 0.62);
    const r = Math.min(room.w, room.h) * rand(rng, 0.08, 0.14);
    ctx.save(); ctx.translate(x, y); ctx.rotate(rng() * TAU);
    ctx.strokeStyle = hexA(i % 2 ? pal.accent2 : pal.accent, 0.12); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * rand(rng, 0.42, 0.72), 0, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 0.75;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35); ctx.lineTo(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92); ctx.stroke();
    }
    ctx.restore();
  }

  // Wall shadows and landmark halos baked into the floor so architecture feels rooted.
  for (const o of room.obstacles) {
    if (!o.archKind && !o.wall) continue;
    const b = aabb(o);
    ctx.fillStyle = hexA('#000000', o.wall ? 0.14 : 0.07);
    if (o.type === 'circle') {
      ctx.beginPath(); ctx.ellipse(o.x + 7, o.y + (o.rad || 20) * 0.72, (o.rad || 20) * 1.35, (o.rad || 20) * 0.38, 0, 0, TAU); ctx.fill();
    } else {
      roundRect(ctx, b.x + 5, b.y + b.h * 0.55, b.w, Math.max(12, b.h * 0.5), 8); ctx.fill();
    }
  }

  ctx.restore(); ctx.globalAlpha = 1;
}

function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function chooseBackgroundScale(room) {
  // Cap the baked canvas so giant rooms don't allocate a 100MB+ bitmap. We draw in
  // room-space and output at this fraction, then scale the image back up at draw time.
  // This stays SCREEN-aware (not parity-gated): a phone can't safely allocate a desktop-
  // sized bitmap, and it only affects baked-texture sharpness, never gameplay.
  const maxPixels = view.mobile ? 5_600_000 : 9_000_000;
  const maxDim = view.mobile ? 3072 : 4096;
  const byPixels = Math.sqrt(maxPixels / Math.max(1, room.w * room.h));
  const byDim = maxDim / Math.max(room.w, room.h);
  return clamp(Math.min(1, byPixels, byDim), 0.34, 1);
}

function bakeBackground(room, rng) {
  if (typeof document === 'undefined') return null; // headless tests
  // Visual baking gets its OWN deterministic stream so it never advances the gameplay
  // RNG. Headless skips baking but the browser doesn't — without this they diverge, so
  // tests would validate a room sequence the player never sees. [bug ChatGPT flagged]
  rng = mulberry32(hashString(`${room.round}|${room.biome.id}|${room.layoutId}|${room.recipeId}|${room.districtName}|bg`));
  const c = document.createElement('canvas');
  const scale = chooseBackgroundScale(room);
  room.backgroundScale = scale;
  c.width = Math.max(1, Math.round(room.w * scale));
  c.height = Math.max(1, Math.round(room.h * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale); // draw in room-space; the canvas is scaled-down (cheap for huge rooms)
  const pal = room.biome.pal;
  const g = ctx.createLinearGradient(0, 0, 0, room.h);
  g.addColorStop(0, pal.bg);
  g.addColorStop(1, pal.floor);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, room.w, room.h);

  // 2 feature patterns + 1 extra, dealt without in-room repeats
  const deck = [...room.biome.features];
  const picks = [];
  for (let i = 0; i < 2 && deck.length; i++) picks.push(deck.splice(Math.floor(rng() * deck.length), 1)[0]);
  picks.push(pick(rng, room.biome.extras));
  for (const name of picks) paintPattern(name, ctx, room.w, room.h, rng, pal);
  paintFloorIdentity(ctx, room, rng, pal);
  paintNeonDistricts(ctx, room, rng, pal);
  paintCityDressing(ctx, room, rng, pal);
  paintArchitecturalDecals(room, ctx, rng, pal);

  // annex floor tint
  if (room.annex) {
    const ar = room.annex.rect;
    if (room.annex.underground) {
      // an UNDERVAULT reads as a black pit cut into the floor, ringed with hazard grating
      ctx.globalAlpha = 0.86; ctx.fillStyle = '#05060a';
      ctx.fillRect(ar.x, ar.y, ar.w, ar.h);
      ctx.globalAlpha = 0.5; ctx.strokeStyle = hexA(pal.accent2, 0.9); ctx.lineWidth = 3;
      for (let gy = ar.y + 18; gy < ar.y + ar.h - 8; gy += 26) { ctx.beginPath(); ctx.moveTo(ar.x + 8, gy); ctx.lineTo(ar.x + ar.w - 8, gy); ctx.stroke(); }
      ctx.globalAlpha = 0.28;
      const gg = ctx.createRadialGradient(ar.x + ar.w / 2, ar.y + ar.h / 2, 4, ar.x + ar.w / 2, ar.y + ar.h / 2, Math.max(ar.w, ar.h) * 0.6);
      gg.addColorStop(0, hexA('#bdeaff', 0.5)); gg.addColorStop(1, hexA('#bdeaff', 0));
      ctx.fillStyle = gg; ctx.fillRect(ar.x, ar.y, ar.w, ar.h);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = pal.bg;
      ctx.fillRect(ar.x, ar.y, ar.w, ar.h);
      ctx.globalAlpha = 1;
    }
  }

  // biome lighting grade: a faint accent glow toward the portal gives each biome a
  // distinct light-source mood (warm forges, cold reliquaries) and pulls the eye up-room.
  const glow = ctx.createRadialGradient(room.w / 2, room.h * 0.2, 0, room.w / 2, room.h * 0.2, Math.max(room.w, room.h) * 0.5);
  glow.addColorStop(0, hexA(pal.accent, 0.05));
  glow.addColorStop(1, hexA(pal.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, room.w, room.h);

  // baked edge darkening
  const v = ctx.createRadialGradient(room.w / 2, room.h / 2, Math.min(room.w, room.h) * 0.3, room.w / 2, room.h / 2, Math.max(room.w, room.h) * 0.72);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, room.w, room.h);
  return c;
}
