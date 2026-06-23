// Shared damage/kill/hurt resolution — the one place hp changes hands.
import { state } from '../state.js';
import { PLAYER, TAU } from '../config.js';
import { norm, clamp } from '../rng.js';
import { particle, burst, addFloat, ripple } from '../render/particles.js';
import { addShake, addFlash, hitPause, haptic, slowMo } from './juice.js';
import { sfx } from '../audio/sfx.js';
import { killScore, addRedline } from './score.js';
import { hooks } from './items.js';
import { autoGrant } from './draft.js';

export function damageEnemy(e, dmg, kx = 0, ky = 0, kind = 'shot') {
  if (e.hp <= 0) return;
  if (e.invulnT > 0) { e.shieldSpark = 0.1; return; } // mid phase-shift transformation: untouchable
  const wasStaggered = (e.stun || 0) > 0.12;   // already reeling before this blow?
  dmg = hooks.reduce('modDamage', dmg, e, kind);
  // Warden's rotating shield gap: only hits/dashes that come through the GAP land full
  // damage; everything else sparks off the armour. (kx,ky is the hit direction.)
  if (e.shield && (kx || ky)) {
    const hitAng = Math.atan2(-ky, -kx);
    const diff = Math.abs(((hitAng - (e.shieldAngle || 0) + Math.PI) % TAU + TAU) % TAU - Math.PI);
    if (diff > (e.gapHalf || 0.6)) { dmg *= 0.12; e.shieldSpark = 0.12; }
  }
  e.hp -= dmg;
  e.vx += kx; e.vy += ky;
  // brighter, slightly longer white hit-flash so every connect registers on the body
  e.hit = Math.max(e.hit || 0, kind === 'dash' ? 0.22 : 0.15);
  // a dash blow STAGGERS non-boss enemies: their AI is gated on stun, so they reel
  // (and read as off-balance) long enough to set up a satisfying finish.
  e.stun = Math.max(e.stun || 0, kind === 'dash' && !e.boss ? 0.35 : 0.032);
  const room = state.room;
  const dead = e.hp <= 0;
  const heavy = kind === 'dash' || kind === 'pulse';
  hitPause(kind === 'pulse' ? 'pulse' : kind === 'dash' ? 'dash' : kind === 'chain' ? 'chain' : 'shot');
  addShake(kind === 'pulse' ? 0.28 : kind === 'dash' ? 0.18 : 0.07);
  // Impact polish: a bright white contact pop + a directional spark spray thrown along
  // the hit so blows read as physically connecting. Spray scales with the blow weight.
  const km = Math.hypot(kx, ky);
  const hasDir = km > 1;
  const dx = hasDir ? kx / km : 0, dy = hasDir ? ky / km : 0;
  const accent = kind === 'pulse' ? room.biome.pal.accent3 : e.color;
  particle(room, e.x + dx * e.r * 0.5, e.y + dy * e.r * 0.5, '#ffffff',
    dx * 130, dy * 130, 0.11, heavy ? 4.4 : 3.2);
  const sparks = heavy ? 8 : 5;
  const baseAng = Math.atan2(dy, dx);
  for (let i = 0; i < sparks; i++) {
    const a = hasDir ? baseAng + (Math.random() - 0.5) * 1.15 : Math.random() * TAU;
    const sp = 150 + Math.random() * (heavy ? 340 : 210);
    particle(room, e.x, e.y, i % 3 ? accent : '#ffffff',
      Math.cos(a) * sp, Math.sin(a) * sp, 0.2 + Math.random() * 0.16, 2 + Math.random() * 2.3);
  }
  // crisp contact ring on heavier blows (kept off plain shots so it doesn't smear)
  if (heavy && !dead) ripple(room, e.x, e.y, kind === 'pulse' ? room.biome.pal.accent3 : '#ffffff', 44, 0.2);
  hooks.run('onHit', e, dmg, kind);
  if (dead) killEnemy(e, kind, wasStaggered);
}

export function killEnemy(e, kind = 'shot', staggered = false) {
  const room = state.room, run = state.run, p = run.player;
  e.hp = 0;
  if (e.boss && room.pendingWaves) {
    // the head dies, the summons stop coming (live escorts still fight)
    for (const w of room.pendingWaves) w.fired = true;
    room.spawnQueue.length = 0;
  }
  killScore(e);
  p.dashCd = Math.max(0, p.dashCd - PLAYER.DASH_KILL_REFUND); // every kill feeds the dash loop a little
  if (kind === 'dash') {
    const a = p.lastDashAngle ?? Math.atan2(p.vy || 0, p.vx || 1);
    const minCarry = 1780;
    const sp = Math.hypot(p.vx || 0, p.vy || 0);
    if (sp < minCarry) { p.vx = Math.cos(a) * minCarry; p.vy = Math.sin(a) * minCarry; }
    p.flowT = Math.max(p.flowT || 0, 0.24);
    p.inv = Math.max(p.inv || 0, 0.22);
  }
  // spark scatter (meta currency)
  const n = (e.boss ? 24 : e.miniboss ? 16 : (e.captain ? 8 : 3 + Math.floor(Math.random() * 3)))
    + (room.mutator?.sparkBonus || 0);
  for (let i = 0; i < n; i++) {
    room.pickups.push({
      type: 'spark', x: e.x + Math.random() * 24 - 12, y: e.y + Math.random() * 24 - 12,
      vx: Math.random() * 240 - 120, vy: Math.random() * 240 - 120, r: 6, life: 8,
    });
  }
  const repairsAllowed = !room.mutator?.noRepairDrops || e.boss;
  if (repairsAllowed && (e.boss || Math.random() < 0.035) && p.hp < p.maxHp) {
    room.pickups.push({ type: 'repair', x: e.x, y: e.y, vx: Math.random() * 160 - 80, vy: Math.random() * 160 - 80, r: 11, life: 8 });
  }
  // death FX: a BOSS going down is the run's climax (below); a dash-kill gets the big
  // "pop"; anything else the standard burst.
  if (e.boss) {
    bossDeathFX(room, e);
  } else if (e.miniboss) {
    minibossDeathFX(room, e);
    grantMinibossReward(room, p, e);
  } else if (kind === 'dash') {
    dashKillPop(room, e, p);
    sfx('kill'); sfx('break'); // shatter crunch layered on the kill chime
  } else {
    burst(room, e.x, e.y, e.color, 13, 170, 0.5, 3);
    hitPause('kill');
    addShake(0.18);
    sfx('kill');
  }
  // executing an already-reeling enemy is a skill beat — punctuate it
  if (staggered && !e.boss) {
    ripple(room, e.x, e.y, room.biome.pal.accent3, 70, 0.32);
    addFloat(room, e.x, e.y - (e.r || 16) - 10, '✕', '#ffffff', false, 0.4);
  }
  // STYLE: reward the signature moves — grinding, airborne, and multi-cut kills — with a
  // callout + bonus points so the breakneck/vertical loop pays you for flowing.
  if (!e.boss) styleKill(room, run, p, e, kind);
  // mowing a room down should CRESCENDO — rapid consecutive kills escalate with
  // callouts + juice (the dash loop is the whole game; make it sing). Boss death is
  // its own climax, so it's excluded.
  if (!e.boss) killChainFlourish(room, run, e);
  if (e.captainDeath) e.captainDeath(e);
  hooks.run('onKill', e);
}

// Style payout for killing in motion. Rail/air kills + multi-cut dashes get a callout and
// bonus points scaled by the live combo — the loop pays you for never stopping.
function styleKill(room, run, p, e, kind) {
  let label = null, col = '#bdfcff';
  if (p.rail?.active) { label = p.rail.kind === 'escape' ? 'EXPRESS KILL' : 'RAIL KILL'; col = '#ffce5a'; }
  else if (p.air) { label = 'AIR KILL'; col = '#9fe8ff'; }
  if (kind === 'dash') {
    p._dashKills = (p._dashKills || 0) + 1;
    if (p._dashKills >= 2) { label = 'SLICE ×' + p._dashKills; col = '#ffe24a'; }
  }
  if (!label) return;
  run.score += Math.floor((e.score || 60) * 0.5 * (run.combo || 1));
  addRedline(0.05); // stylish kills feed the surge harder
  addFloat(room, e.x, e.y - (e.r || 16) - 24, label, col, true, 0.72);
}

// Mini-boss death: a mid-tier climax between a normal kill and the full boss wipe.
function minibossDeathFX(room, e) {
  slowMo(0.42); addFlash(0.42); addShake(0.7); hitPause('boss');
  burst(room, e.x, e.y, e.color, 40, 420, 0.8, 5);
  burst(room, e.x, e.y, '#ffffff', 20, 260, 0.6, 3.6);
  ripple(room, e.x, e.y, '#ffffff', 260, 0.85);
  ripple(room, e.x, e.y, e.color, 180, 0.7);
  for (const b of room.bullets) if (b.owner === 'enemy' && Math.hypot(b.x - e.x, b.y - e.y) < 360) b.life = 0;
  addFloat(room, e.x, e.y - (e.r || 24) - 30, 'ELITE DOWN', '#ffd36e', true, 1.4);
  sfx('kill'); sfx('clear'); sfx('break');
}

// Mini-boss reward: a visible heart, a spark shower (handled above), a power-up graft, and
// a full dash refund + flow so you rocket straight out of the kill.
function grantMinibossReward(room, p, e) {
  if (p.hp < p.maxHp + 4) room.pickups.push({ type: 'heart', x: e.x, y: e.y, vx: 0, vy: 0, r: 11, life: 12 });
  autoGrant();
  p.dashCd = 0;
  p.flowT = Math.max(p.flowT || 0, 0.5);
  p.inv = Math.max(p.inv || 0, 0.3);
  // ELITE RUSH payoff: beating the whole gauntlet (no elites left, none still queued)
  // pays a fat bonus + a full heal on top of the per-kill rewards.
  if (room._eliteRush && !room._eliteRushDone) {
    const moreElites = room.enemies.some(x => x.miniboss && x.hp > 0 && x !== e)
      || (room.pendingWaves || []).some(w => w.miniboss && !w.fired);
    if (!moreElites) { room._eliteRushDone = true; eliteRushComplete(room, p); }
  }
}

function eliteRushComplete(room, p) {
  const run = state.run;
  const bonus = 1500 + (run?.round || 1) * 250;
  if (run) run.score += bonus;
  p.hp = Math.min(p.maxHp + 4, p.hp + 3);          // full-ish heal as the gauntlet payoff
  p.flowT = Math.max(p.flowT || 0, 0.8);
  addFloat(room, p.x, p.y - 92, 'ELITE RUSH CLEAR', '#ff5d6c', true, 1.7);
  addFloat(room, p.x, p.y - 58, `+${bonus.toLocaleString()}`, '#ffd36e', true, 1.1);
  addFlash(0.4); addShake(0.7); slowMo(0.12);
  ripple(room, p.x, p.y, '#ff5d6c', 320, 0.8); ripple(room, p.x, p.y, '#ffffff', 200, 0.55);
  burst(room, p.x, p.y, '#ff5d6c', 46, 480, 0.8, 5.2);
  sfx('redline'); sfx('clear');
}

// Kill-chain crescendo. Consecutive kills inside a short window stack a counter; each
// new escalation tier slams a word in with growing shake/flash/slow-mo. Announces once
// per tier (not every kill) so it punches instead of flickering.
const CHAIN_TIERS = [
  [12, 'ANNIHILATION', '#ff5d6c'],
  [9, 'MASSACRE', '#ff7b3c'],
  [6, 'RAMPAGE', '#ffb13c'],
  [4, 'OVERKILL', '#ffe24a'],
  [3, 'TRIPLE', '#9fffe0'],
  [2, 'DOUBLE KILL', '#bdeaff'],
];
function killChainFlourish(room, run, e) {
  const t = room.time || 0;
  run._killChain = (t - (run._lastKillAt ?? -99) <= 1.2) ? (run._killChain || 0) + 1 : 1;
  run._lastKillAt = t;
  run.bestKillChain = Math.max(run.bestKillChain || 0, run._killChain);
  const n = run._killChain;
  if (n < 2) return;
  const tier = CHAIN_TIERS.find(c => n >= c[0]);
  if (!tier) return;
  // fire on the exact tier threshold, then re-announce the top tier every 4 beyond it
  if (n !== tier[0] && !(n > 12 && n % 4 === 0)) return;
  const p = run.player;
  const scale = clamp(0.78 + n * 0.1, 0.85, 1.85);
  addFloat(room, p.x, p.y - 66, tier[1], tier[2], true, scale);
  addShake(clamp(0.12 + n * 0.03, 0.12, 0.52));
  addFlash(clamp(0.05 + n * 0.018, 0.05, 0.3));
  ripple(room, e.x, e.y, tier[2], 78 + n * 7, 0.34);
  if (n >= 3) slowMo(clamp(0.045 + n * 0.011, 0.045, 0.16));
  sfx(n >= 6 ? 'clear' : 'care');
}

// A boss going down is the climax of the run — earn it: big bullet-time, a staged
// shatter, twin shockwaves, the screen wiped clear (you won the exchange), a callout.
function bossDeathFX(room, e) {
  slowMo(0.9);
  addFlash(0.6); addShake(1.2); hitPause('boss');
  burst(room, e.x, e.y, e.color, 60, 540, 0.95, 6);
  burst(room, e.x, e.y, '#ffffff', 30, 320, 0.7, 4);
  ripple(room, e.x, e.y, '#ffffff', 430, 1.2);
  ripple(room, e.x, e.y, e.color, 300, 1.0);
  // wipe incoming enemy fire — you won the exchange. MARK them dead (the bullet loop
  // culls life<=0) rather than reassigning room.bullets: this runs from inside the
  // bullet loop (boss killed by a shot), and swapping the array out mid-iteration
  // crashes it (undefined index) → froze the game on boss kills.
  for (const b of room.bullets) if (b.owner === 'enemy') b.life = 0;
  addFloat(room, e.x, e.y - (e.r || 40) - 30, '✕', '#ffffff', true, 1.7);
  sfx('kill'); sfx('clear'); sfx('break');
}

// The dash-kill "pop": a directional slice along the dash line, a white core, twin
// shockwave rings, and a brief slow-mo beat. Reads as Moots cutting clean through.
function dashKillPop(room, e, p) {
  const ang = (p.lastDashAngle ?? Math.atan2(p.vy, p.vx)) || 0;
  // bright core flash + a bigger, faster enemy-colour shatter than a normal kill
  burst(room, e.x, e.y, '#ffffff', 10, 150, 0.26, 3.4);
  burst(room, e.x, e.y, e.color, e.boss ? 46 : 20, 250, 0.5, 3.2);
  // directional "slice" — debris flung both ways along the cut line
  for (let i = 0; i < 12; i++) {
    const a = ang + (i % 2 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.55;
    const sp = 240 + Math.random() * 320;
    particle(room, e.x, e.y, i % 3 ? e.color : '#ffffff',
      Math.cos(a) * sp, Math.sin(a) * sp, 0.32 + Math.random() * 0.22, 2 + Math.random() * 2.6);
  }
  ripple(room, e.x, e.y, '#ffffff', 96, 0.4);
  ripple(room, e.x, e.y, e.color, 60, 0.32);
  slowMo(0.045);           // capped via Math.max — chained dash-kills don't turn into a brake
  addFlash(0.2);
  addShake(e.boss ? 0.55 : 0.34);
  hitPause(e.boss ? 'boss' : 'dashKill');
}

export function hurtPlayer(amount, sx, sy, source = 'hit') {
  const p = state.run?.player, room = state.room;
  if (!p || p.inv > 0 || state.mode !== 'play') return false;
  if (p.shield > 0) {
    p.shield--; amount = 0;
    p.inv = 0.36;
    addFloat(room, p.x, p.y - 44, '◆', '#aef3ff');
  } else {
    p.hp -= amount;
    p.inv = PLAYER.HURT_IFRAMES;
  }
  p.roomHit = true;
  p.hurt = 0.34;
  addShake(0.46); addFlash(0.32); hitPause('hurt'); haptic(48);
  sfx('hurt');
  const k = norm(p.x - sx, p.y - sy);
  p.vx += k.x * PLAYER.HURT_KNOCK; p.vy += k.y * PLAYER.HURT_KNOCK;
  burst(room, p.x, p.y, room?.biome?.pal.bad || '#ff6b6b', 20, 140, 0.45, 3);
  hooks.run('onPlayerHurt', amount, source);
  if (p.hp <= 0) p.dead = true; // rooms.js notices and runs the death flow
  return true;
}
