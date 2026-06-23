// Enemy AI — all 8 No Moon archetypes per docs/no-moon-systems.md §1
// (source anchors game_inline.js:8906-9024). Scaling inputs come from the room:
// room.idx (0-9 compressed depth) and room.stage (danger stage 0-5+).
import { state } from '../state.js';
import { TAU, DIRECTOR, HUNT } from '../config.js';
import { clamp, damp, dist, norm } from '../rng.js';
import { particle, addFloat, burst, ripple } from '../render/particles.js';
import { fireEnemyBurst, fireEnemyRing, fireEnemyShot } from './bullets.js';
import { addShake, addFlash, slowMo } from './juice.js';
import { hurtPlayer } from './combat.js';
import { resolveCircleObstacle } from './player.js';
import { ENEMY_TYPES } from '../data/enemies.js';
import { sfx } from '../audio/sfx.js';
import { levelAt } from './levels.js';
import { damageObstacle } from './breakables.js';

// Charging enemies should make the room react: they pulverize soft cover, but never
// secret doors, cracked architecture, dash bells, altars, or volatile shards.
const RAMMABLE = new Set(['rubble', 'marrowJar', 'rootCyst', 'bellHusk', 'moonseedUrn']);
function smashThroughCover(room, e) {
  for (const o of room.obstacles) {
    if (o.gone || !o.breakable || !RAMMABLE.has(o.species)) continue;
    const ox = o.type === 'circle' ? o.x : o.x + o.w / 2;
    const oy = o.type === 'circle' ? o.y : o.y + o.h / 2;
    const orad = o.type === 'circle' ? o.rad : Math.max(o.w, o.h) / 2;
    if (dist(e.x, e.y, ox, oy) < e.r + orad) damageObstacle(room, o, 99);
  }
}

let nextId = 1;

export function makeEnemy(type, x, y, room) {
  const def = ENEMY_TYPES[type];
  const idx = room.idx, stage = room.stage;
  const hpScale = 1 + idx * DIRECTOR.HP_IDX + stage * DIRECTOR.HP_STAGE;
  const spdScale = 1 + idx * DIRECTOR.SPD_IDX + stage * DIRECTOR.SPD_STAGE;
  return {
    id: nextId++, type, display: def.display,
    x, y, vx: 0, vy: 0, r: def.r,
    hp: def.hp * hpScale, maxHp: def.hp * hpScale,
    speed: def.speed * spdScale, score: def.score, color: def.color,
    phase: Math.random() * TAU, seed: Math.random() * TAU, level: 0,
    cd: 0.4 + Math.random() * 1.4, hit: 0, stun: 0, tele: 0,
    slowTimer: 0, slowMul: 1,
    captain: null, captainDeath: null, boss: false,
    state: 'idle', aimT: 0, chargeX: 0, chargeY: 0, dashT: 0, hopCd: 0,
  };
}

export function updateEnemies(room, dt) {
  const p = state.run.player;
  const idx = room.idx, stage = room.stage;
  for (let i = room.enemies.length - 1; i >= 0; i--) {
    const e = room.enemies[i];
    if (e.hp <= 0) { room.enemies.splice(i, 1); continue; }
    e.phase += dt;
    e.cd -= dt;
    e.hit = Math.max(0, e.hit - dt * 5);
    e.stun = Math.max(0, e.stun - dt);
    e.invulnT = Math.max(0, (e.invulnT || 0) - dt); // boss phase-shift untouchable window
    e.tele = Math.max(0, e.tele - dt);
    e.hopCd = Math.max(0, (e.hopCd || 0) - dt);
    if (e.slowTimer > 0) { e.slowTimer -= dt; if (e.slowTimer <= 0) e.slowMul = 1; }
    if (e.miniboss) e.introT = Math.max(0, (e.introT || 0) - dt);
    const minIntro = !!(e.miniboss && (e.introT || 0) > 0); // elite strut-in: holds + untouchable

    const to = norm(p.x - e.x, p.y - e.y);
    const d = to.m;
    let spd = e.speed * e.slowMul;
    // City-scale arenas need hunter pressure: far enemies accelerate into the
    // player's lane so the action comes to you, but close combat still uses the
    // normal archetype movement.
    if (!e.boss && d > HUNT.FAR) {
      const hf = clamp((d - HUNT.FAR) / Math.max(1, HUNT.FULL - HUNT.FAR), 0, 1);
      spd *= 1 + HUNT.SPEED_BONUS * hf;
    }
    let ax = 0, ay = 0, lambda = 6.2;

    if (!minIntro && e.stun <= 0 && (e.boss ? updateBoss(e, room, p, to, d, dt) : true)) {
      switch (e.boss ? 'none' : e.type) {
        case 'skitter': {
          const wig = 1.08 + Math.sin(e.phase * 5) * 0.12;
          ax = to.x * spd * wig + Math.cos(e.phase * 6 + e.seed) * 52;
          ay = to.y * spd * wig + Math.sin(e.phase * 5 + e.seed) * 52;
          if (e.cd <= 0 && d < 205) { e.cd = 0.55 + Math.random() * 0.28; e.vx += to.x * 380; e.vy += to.y * 380; }
          lambda = 8.4;
          break;
        }
        case 'gunner': {
          const want = d < 245 ? -1 : d > 390 ? 1 : 0.18;
          const orbit = Math.sin(e.seed) >= 0 ? 1 : -1;
          ax = to.x * spd * want + (-to.y) * orbit * spd * 0.7;
          ay = to.y * spd * want + (to.x) * orbit * spd * 0.7;
          if (e.cd <= 0 && d < 980) {
            e.cd = Math.max(0.72, 1.28 - idx * 0.04);
            const count = 1 + (stage >= 2 ? 1 : 0) + (stage >= 4 ? 1 : 0);
            fireEnemyBurst(room, e, p.x, p.y, count, 0.16, 385 + idx * 16, 3.05);
          }
          break;
        }
        case 'charger': {
          if (e.state === 'windup') {
            ax = ay = 0;
            if (e.tele <= 0.02) {
              e.state = 'dash'; e.dashT = 0.48;
              const thrust = 620 + 26 * stage;
              e.vx = e.chargeX * thrust; e.vy = e.chargeY * thrust;
            }
          } else if (e.state === 'dash') {
            e.dashT -= dt;
            e.vx *= Math.pow(0.96, dt * 60); e.vy *= Math.pow(0.96, dt * 60);
            smashThroughCover(room, e);
            if (e.dashT <= 0) { e.state = 'idle'; e.cd = Math.max(1.15, 2.0 - stage * 0.13); }
          } else {
            ax = to.x * spd * 0.96; ay = to.y * spd * 0.96;
            if (e.cd <= 0 && d < 390) {
              e.state = 'windup'; e.tele = 0.38;
              e.chargeX = to.x; e.chargeY = to.y;
              addFloat(room, e.x, e.y - e.r - 12, '»', room.biome.pal.bad, false, 0.42);
              sfx('telegraph');
            }
          }
          break;
        }
        case 'turret': {
          const orbit = Math.sin(state.room.time * 1.8 + e.seed) * 22;
          ax = -to.y * orbit; ay = to.x * orbit;
          if (e.cd <= 0 && d < 980) {
            e.cd = Math.max(0.82, 1.82 - idx * 0.05);
            if (stage >= 2 && Math.random() < 0.45) {
              fireEnemyRing(room, e, 8 + (stage >= 4 ? 2 : 0), 265 + idx * 10, 3.7, e.color, e.seed + e.phase * 0.3);
            } else {
              fireEnemyBurst(room, e, p.x, p.y, 4 + (stage >= 4 ? 1 : 0), 0.46, 340 + idx * 14, 3.2);
            }
          }
          lambda = 7;
          break;
        }
        case 'brute': {
          ax = to.x * spd; ay = to.y * spd;
          if (e.cd <= 0 && d < 620) {
            e.cd = Math.max(1.25, 2.05 - idx * 0.045);
            fireEnemyBurst(room, e, p.x, p.y, 5 + (stage >= 4 ? 1 : 0), 0.50, 300 + idx * 12, 3.4);
          }
          lambda = 5;
          break;
        }
        case 'sniper': {
          const want = d < 420 ? -1 : d > 860 ? 1 : 0.08;
          ax = to.x * spd * want + Math.cos(e.phase * 1.2) * 38;
          ay = to.y * spd * want + Math.sin(e.phase * 1.1) * 38;
          if (e.aimT > 0) {
            e.aimT -= dt; ax *= 0.2; ay *= 0.2;
            if (e.aimT <= 0.03 && e.snipeX !== undefined) {
              fireEnemyShot(room, e, e.snipeX, e.snipeY, 620 + idx * 20, 4.9, 3.0, '#bfe6ff');
              e.snipeX = undefined;
            }
          } else if (e.cd <= 0 && d < 1250) {
            e.cd = Math.max(1.35, 2.25 - stage * 0.09);
            e.aimT = 0.68; e.tele = 0.68;
            e.snipeX = to.x; e.snipeY = to.y;
            addFloat(room, e.x, e.y - e.r - 10, '◇', room.biome.pal.bad, false, 0.42);
            sfx('telegraph');
          }
          lambda = 5.5;
          break;
        }
        case 'hexer': {
          const orbDir = Math.sin(e.seed * 3) >= 0 ? 1 : -1;
          const want = d > 280 ? 1 : -0.22;
          ax = to.x * spd * want + (-to.y) * orbDir * spd * 0.72;
          ay = to.y * spd * want + (to.x) * orbDir * spd * 0.72;
          if (e.cd <= 0 && d < 1080) {
            e.cd = Math.max(1.28, 2.18 - stage * 0.09);
            fireEnemyRing(room, e, 6 + (stage >= 4 ? 2 : 0), 280 + idx * 11, 3.6, '#97ffd6', e.phase * 0.7);
          }
          lambda = 6;
          break;
        }
        case 'myrmidon': {
          const orbDir = Math.sin(e.seed * 2) >= 0 ? 1 : -1;
          ax = (-to.y) * orbDir * spd * 0.72 + (d > 240 ? to.x * spd * 0.82 : 0) + (-to.y) * orbDir * spd * 0.48 * Math.sin(e.phase * 2);
          ay = (to.x) * orbDir * spd * 0.72 + (d > 240 ? to.y * spd * 0.82 : 0) + (to.x) * orbDir * spd * 0.48 * Math.sin(e.phase * 2);
          if (e.hopCd <= 0 && d < 310) {
            e.hopCd = 1.15;
            e.vx -= to.x * 230; e.vy -= to.y * 230;
          }
          if (e.cd <= 0 && d < 860) {
            e.cd = Math.max(0.82, 1.55 - stage * 0.055);
            fireEnemyBurst(room, e, p.x, p.y, 3 + (stage >= 4 ? 2 : 1), 0.36, 380 + idx * 16, 3.0);
          }
          lambda = 7;
          break;
        }
      }
      // HUNT override: anything far from the player blends its archetype steering
      // toward a direct pursuit (and steers harder) so distant enemies converge on
      // the player instead of wandering the sprawl. Chargers mid-charge keep their line.
      if (!e.boss && d > HUNT.FAR && (e.type !== 'charger' || e.state === 'idle')) {
        const hf = clamp((d - HUNT.FAR) / Math.max(1, HUNT.FULL - HUNT.FAR), 0, 1);
        const chase = e.speed * e.slowMul * (1 + HUNT.SPEED_BONUS * hf);
        ax = ax * (1 - 0.62 * hf) + to.x * chase * (0.92 + hf * 0.50);
        ay = ay * (1 - 0.62 * hf) + to.y * chase * (0.92 + hf * 0.50);
        lambda = Math.max(lambda, 6.4 + HUNT.STEER * hf);
      }
      if (e.type !== 'charger' || e.state === 'idle') {
        e.vx = damp(e.vx, ax, lambda, dt);
        e.vy = damp(e.vy, ay, lambda, dt);
      }
    }

    if (e.miniboss) {
      if (minIntro) { e.vx = damp(e.vx, 0, 5, dt); e.vy = damp(e.vy, 0, 5, dt); } // hold, coiled
      else updateMinibossPattern(e, room, p, to, d, dt);
    }
    e.x += e.vx * dt; e.y += e.vy * dt;
    if (e.offRoute) {
      e.level = e.offRoute.kind === 'under' ? 0 : 1; // off-map sentinels hold the rail at its level
      if (e.anchorX != null) { e.x = e.anchorX; e.y = e.anchorY; } // pinned: they fire but never drift into play
      e.vx = 0; e.vy = 0;
    } else {
      const w = room.wall - 22;
      e.x = clamp(e.x, w + e.r, room.w - w - e.r);
      e.y = clamp(e.y, w + e.r, room.h - w - e.r);
      for (const o of room.obstacles) if (!o.gone) resolveCircleObstacle(e, o);
      e.level = levelAt(room, e.x, e.y);
    }

    if (p.inv <= 0 && e.level === p.level && dist(e.x, e.y, p.x, p.y) < e.r + p.r + 2) {
      hurtPlayer(e.boss || e.miniboss ? 2 : 1, e.x, e.y, 'contact');
      const k = norm(e.x - p.x, e.y - p.y);
      e.vx += k.x * 90; e.vy += k.y * 90;
    }
  }
  separate(room);
}

// pairwise separation (No Moon game_inline.js:9089-9111)
function separate(room) {
  const es = room.enemies;
  for (let i = 0; i < es.length; i++) {
    const a = es[i];
    if (a.type === 'charger' && a.state === 'dash') continue;
    for (let j = i + 1; j < es.length; j++) {
      const b = es[j];
      if (b.type === 'charger' && b.state === 'dash') continue;
      const minD = a.r + b.r + 12;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dd = Math.hypot(dx, dy) || 1;
      if (dd < minD) {
        const f = (minD - dd) / minD * 140;
        const nx = dx / dd, ny = dy / dd;
        a.vx -= nx * f * 0.016; a.vy -= ny * f * 0.016;
        b.vx += nx * f * 0.016; b.vy += ny * f * 0.016;
        a.x -= nx * (minD - dd) * 0.3; a.y -= ny * (minD - dd) * 0.3;
        b.x += nx * (minD - dd) * 0.3; b.y += ny * (minD - dd) * 0.3;
      }
    }
  }
}

// Boss brains live in data/bosses via director (Phase 5); placeholder hook keeps
// the switch clean — returns true to fall through to normal AI.
function updateBoss(e, room, p, to, d, dt) {
  if (e.brain) {
    e.brain(e, room, p, to, d, dt);
    maybeBossDesperation(e, room);   // shared FINAL STAND across every boss
    return false;
  }
  return true;
}

// Final stand: dropping a boss below 25% HP ROARS it into a desperation phase — a fair
// bullet-wipe, a screen-rocking double shockwave, a speed/aggression spike, and an
// instant closing barrage. Every boss gets this climax on top of its own 50% phase
// shift, so the last quarter of the bar is always the loudest. One-shot via e.desperate.
function maybeBossDesperation(e, room) {
  if (e.desperate || (e.introT || 0) > 0 || e.hp <= 0) return;
  if (e.hp / e.maxHp >= 0.25) return;
  const p = state.run.player;
  e.desperate = true;
  e.enraged = true;
  e.invulnT = Math.max(e.invulnT || 0, 0.6);
  e.phaseLock = Math.max(e.phaseLock || 0, 0.6);
  e.speed *= 1.14;
  e.fireCd = 0; e.ringCd = 0;                                  // resume firing hot
  for (const b of room.bullets) if (b.owner === 'enemy') b.life = 0; // fair reset, never reassign mid-loop
  fireEnemyRing(room, e, 22, 248, 4.2, '#ff5d6c', e.phase);
  fireEnemyRing(room, e, 16, 198, 3.5, '#ffffff', e.phase + 0.3);
  burst(room, e.x, e.y, '#ff5d6c', 52, 520, 0.9, 5.5);
  ripple(room, e.x, e.y, '#ffffff', 380, 1.1);
  ripple(room, e.x, e.y, '#ff5d6c', 270, 0.95);
  addFlash(0.55); addShake(1.05); slowMo(0.5);
  addFloat(room, e.x, e.y - e.r - 40, 'FINAL STAND', '#ff5d6c', true, 1.6);
  if (p) { addFloat(room, p.x, p.y - 70, e.display.toUpperCase() + ' IS DESPERATE', '#ff9b9b', false, 0.7); }
  sfx('pulse'); sfx('clear');
}

export function spawnTelegraphed(room, type, x, y, delay = 0.55, captain = null) {
  const q = { type, x, y, level: levelAt(room, x, y), at: room.time + delay, glyphAt: room.time, captain };
  room.spawnQueue.push(q);
  return q;
}

// ── Mini-bosses: elite, telegraphed, HP-barred mid-room encounters (data/enemies MINIBOSSES).
// Built from a tough host enemy (so it reuses the host AI in updateEnemies) + buffs + a
// signature attack pattern. Kept here (not bosses.js) so it shares makeEnemy/fire helpers
// without an import cycle.
export function makeMiniBoss(def, room, x, y) {
  const e = makeEnemy(def.host, x, y, room);            // host AI + round-scaled base HP
  e.miniboss = true; e.miniId = def.id; e.display = def.title; e.miniName = def.title;
  e.pattern = def.pattern;
  e.hp *= def.hp; e.maxHp = e.hp;
  e.r *= def.r; e.speed *= def.speed; e.color = def.color;
  e.score = Math.floor(e.score * 4.2);
  e.introT = 0.8; e.invulnT = 0.8; e.patternCd = 1.5;   // brief untouchable strut-in
  return e;
}

export function spawnMiniBoss(room, def, x, y) {
  const e = makeMiniBoss(def, room, x, y);
  room.enemies.push(e);
  slowMo(0.3); addFlash(0.3); addShake(0.55); sfx('elite');
  ripple(room, x, y, e.color, 210, 0.75); ripple(room, x, y, '#ffffff', 130, 0.5);
  burst(room, x, y, e.color, 34, 380, 0.7, 4.4);
  addFloat(room, x, y - e.r - 36, '⚠ ELITE: ' + def.title.toUpperCase(), '#ffd36e', true, 1.25);
  return e;
}

// Signature attack, fired on a cooldown once the strut-in finishes. Reuses the boss bullet
// helpers; escalates below 50% HP. Movement still comes from the host AI in updateEnemies.
function updateMinibossPattern(e, room, p, to, d, dt) {
  e.patternCd = Math.max(0, (e.patternCd || 0) - dt);
  if (e.patternCd > 0) return;
  const idx = room.idx, enraged = e.hp / e.maxHp < 0.5;
  switch (e.pattern) {
    case 'slamRings':
      e.patternCd = enraged ? 1.9 : 2.7; e.vx *= 0.3; e.vy *= 0.3;
      fireEnemyRing(room, e, enraged ? 16 : 11, 232 + idx * 8, 3.5, e.color, e.phase * 0.4);
      if (enraged) fireEnemyRing(room, e, 9, 180, 3.0, '#ffffff', e.phase * 0.4 + 0.3);
      ripple(room, e.x, e.y, '#ffffff', 130, 0.42); addShake(0.3); sfx('telegraph');
      break;
    case 'dashVolley':
      e.patternCd = enraged ? 1.5 : 2.2; e.vx += to.x * 540; e.vy += to.y * 540;
      fireEnemyBurst(room, e, p.x, p.y, enraged ? 5 : 3, 0.5, 330 + idx * 10, 3.2, e.color);
      sfx('telegraph');
      break;
    case 'orbitRing':
      e.patternCd = enraged ? 2.0 : 2.9;
      fireEnemyRing(room, e, enraged ? 18 : 13, 206 + idx * 8, 3.6, e.color, e.phase);
      fireEnemyRing(room, e, enraged ? 11 : 8, 168, 3.0, '#ffffff', e.phase + 0.42);
      break;
    case 'crossfire':
      e.patternCd = enraged ? 1.7 : 2.5;
      for (let k = 0; k < (enraged ? 4 : 3); k++) fireEnemyBurst(room, e, p.x, p.y, 1, 0, 360, 3.0, e.color);
      fireEnemyRing(room, e, enraged ? 12 : 8, 200, 3.2, e.color, e.phase * 0.5);
      break;
    case 'spiral': // rotating spiral of rings — successive rings offset by an advancing angle
      e.patternCd = enraged ? 1.1 : 1.7;
      e.spiralA = (e.spiralA || 0) + 0.7;
      fireEnemyRing(room, e, enraged ? 10 : 7, 220 + idx * 8, 3.4, e.color, e.spiralA);
      break;
    case 'summon': // calls in escorts + a covering burst
      e.patternCd = enraged ? 2.6 : 3.6;
      for (let k = 0; k < (enraged ? 3 : 2); k++) {
        const a = Math.random() * TAU, sx = clamp(e.x + Math.cos(a) * 130, room.wall + 40, room.w - room.wall - 40), sy = clamp(e.y + Math.sin(a) * 130, room.wall + 40, room.h - room.wall - 40);
        spawnTelegraphed(room, k % 2 ? 'gunner' : 'skitter', sx, sy, 0.6);
      }
      fireEnemyBurst(room, e, p.x, p.y, 2, 0.4, 300, 3.0, e.color);
      addFloat(room, e.x, e.y - e.r - 20, '❖', e.color, false, 0.5); sfx('telegraph');
      break;
    case 'ringGap': { // a full ring with a safe gap punched toward you — read it, dash the gap
      e.patternCd = enraged ? 1.7 : 2.5;
      const n = enraged ? 28 : 22, toA = Math.atan2(p.y - e.y, p.x - e.x), gap = enraged ? 0.5 : 0.72;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const da = Math.abs(((a - toA + Math.PI) % TAU + TAU) % TAU - Math.PI); // angular gap to your heading
        if (da < gap) continue;
        fireEnemyShot(room, e, Math.cos(a), Math.sin(a), 206 + idx * 8, 5.0, 3.7, e.color);
      }
      ripple(room, e.x, e.y, e.color, 124, 0.4); sfx('telegraph');
      break;
    }
    case 'sweep': { // a dense fan that walks around the arena like a searchlight — keep moving
      e.patternCd = enraged ? 0.5 : 0.82;
      e.sweepA = (e.sweepA ?? Math.random() * TAU) + (enraged ? 0.52 : 0.4);
      for (let k = -2; k <= 2; k++) {
        const a = e.sweepA + k * 0.12;
        fireEnemyShot(room, e, Math.cos(a), Math.sin(a), 252 + idx * 8, 5.0, 3.5, e.color);
      }
      if (enraged) sfx('telegraph');
      break;
    }
    default: // chargeBurst
      e.patternCd = enraged ? 1.7 : 2.5; e.vx += to.x * 660; e.vy += to.y * 660;
      fireEnemyBurst(room, e, p.x, p.y, enraged ? 6 : 4, 0.7, 300, 3.2, e.color);
      sfx('telegraph');
  }
}
export { updateMinibossPattern };

export function updateSpawnQueue(room, dt) {
  for (let i = room.spawnQueue.length - 1; i >= 0; i--) {
    const s = room.spawnQueue[i];
    if (room.time >= s.at) {
      room.spawnQueue.splice(i, 1);
      const e = makeEnemy(s.type, s.x, s.y, room);
      e.level = s.level ?? levelAt(room, s.x, s.y); // spawned on a platform → high ground
      if (s.rushX || s.rushY) { e.vx = s.rushX || 0; e.vy = s.rushY || 0; e.state = 'rush'; }
      if (s.captain) s.captain(e);
      room.enemies.push(e);
      particle(room, s.x, s.y, ENEMY_TYPES[s.type].color, 0, 0, 0.3, 16);
    }
  }
}
