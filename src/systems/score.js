// Combo, streaks, bonuses, bests.
import { COMBO, SCORE, STREAK_NAMES, TIER_LIFT } from '../config.js';
import { state, saveNow } from '../state.js';
import { addFloat, burst, ripple } from '../render/particles.js';
import { addFlash, addShake } from './juice.js';
import { sfx } from '../audio/sfx.js';
import { damp, dist } from '../rng.js';

// Crossing an integer combo tier (×2, ×3 …) fires escalating juice — the climb feels huge.
function comboMilestone(tier, e) {
  const room = state.room; if (!room) return;
  const k = Math.min(1, (tier - 2) / 10);
  addFlash(0.12 + k * 0.30);
  addShake(0.22 + k * 0.75);
  const hot = tier >= 10 ? '#ffffff' : tier >= 6 ? '#ff9bf5' : (room.biome?.pal.accent3 || '#ffd36e');
  addFloat(room, e.x, e.y - 78, `×${tier}`, hot, true, 1.05 + k * 0.7);
  burst(room, e.x, e.y, hot, 10 + tier * 2, 210 + tier * 28, 0.5, 3);
  const p = state.run?.player;
  if (p) p.comboTierFx = Math.max(p.comboTierFx || 0, 0.65);
  maybeComboHeal(room, tier);
  sfx('pulse');
}


function maybeComboHeal(room, tier) {
  // Combo health is now early, loud, and deterministic: every fresh integer tier
  // from ×2 upward visibly repairs 1 missing HP. At full health it banks a tiny
  // one-hit guard instead, so the milestone still feels like it did something.
  if (!Number.isFinite(tier) || tier < 2) return false;
  const p = state.run?.player;
  if (!p) return false;
  if (!(room.comboHealedTiers instanceof Set)) room.comboHealedTiers = new Set(room.comboHealedTiers || []);
  if (room.comboHealedTiers.has(tier)) return false;
  room.comboHealedTiers.add(tier);
  state.run.lastComboHealTier = tier;
  p.comboHealFx = Math.max(p.comboHealFx || 0, 1.15);

  let didGain = false;
  if (p.hp < p.maxHp) {
    p.hp = Math.min(p.maxHp, p.hp + 1);
    didGain = true;
    addFloat(room, p.x, p.y - 64, `+1♥ ×${tier}`, '#7efab7', true, 0.98);
  } else {
    const guardCap = Math.max(1, p.shieldMax || 0);
    if ((p.shield || 0) < guardCap) {
      p.shield = Math.min(guardCap, (p.shield || 0) + 1);
      didGain = true;
      addFloat(room, p.x, p.y - 64, `◇ ×${tier}`, '#bdfcff', true, 0.86);
    } else {
      addFloat(room, p.x, p.y - 64, `×${tier}`, '#7efab7', true, 0.72);
    }
  }

  addFlash(0.20);
  addShake(0.42);
  ripple(room, p.x, p.y, didGain ? '#7efab7' : '#bdfcff', 132, 0.38);
  burst(room, p.x, p.y, didGain ? '#7efab7' : '#bdfcff', 26, 235, 0.48, 3.6);
  sfx('care');
  return didGain;
}


export function tickCombo(raw) {
  const run = state.run;
  if (!run) return;
  run.comboT = Math.max(0, run.comboT - raw);
  if (run.comboT <= 0) run.combo = damp(run.combo, 1, 3, raw);
  if (run.streakT > 0) {
    run.streakT = Math.max(0, run.streakT - raw);
    if (run.streakT <= 0) run.streak = 0;
  }
}

// ── REDLINE: the flow surge. Dashing, grinding, flow-lanes and kills fill the meter; at
// full it IGNITES a few seconds of hyperspeed — faster boots, fatter score, the screen gone
// electric. The reward for never, ever stopping. (HUD meter: overlays.js pulse bar.)
export const REDLINE = { DUR: 5, SPEED: 1.26, SCORE: 1.6 };
export function addRedline(amount) {
  const run = state.run;
  if (!run || run.redlineT > 0) return; // can't refill mid-surge
  if (state.room?.mutator?.redlineFast) amount *= 1.6; // REDLINE CITY: the meter runs hot
  run.redline = Math.min(1, (run.redline || 0) + amount);
  if (run.redline >= 1) igniteRedline();
}
function igniteRedline() {
  const run = state.run, room = state.room, p = run?.player;
  if (!run || !p || !room) return;
  run.redlineT = REDLINE.DUR; run.redline = 1;
  p.flowT = Math.max(p.flowT || 0, 0.4);
  addFloat(room, p.x, p.y - 82, 'REDLINE!', '#ff5d6c', true, 1.55);
  addFlash(0.4); addShake(0.72);
  ripple(room, p.x, p.y, '#ff5d6c', 290, 0.72); ripple(room, p.x, p.y, '#ffffff', 170, 0.5);
  burst(room, p.x, p.y, '#ff5d6c', 42, 470, 0.7, 5.2);
  sfx('redline');
}
export function tickRedline(raw) {
  const run = state.run; if (!run) return;
  if (run.redlineT > 0) {
    run.redlineT = Math.max(0, run.redlineT - raw);
    run.redline = run.redlineT / REDLINE.DUR;              // the bar drains over the surge
    if (run.redlineT <= 0) { run.redline = 0; if (run.player && state.room) addFloat(state.room, run.player.x, run.player.y - 58, 'cooldown', '#9eb0cc', false, 0.55); }
  } else {
    run.redline = Math.max(0, (run.redline || 0) - raw * 0.10); // gentle decay when not surging
  }
}
export const redlineActive = () => (state.run?.redlineT || 0) > 0;

// ── Rail rings: Sonic-style collectibles strung along the sky rails. Scooped up by
// proximity (same level) while grinding — score + a flow-surge tick + a chime, with a
// RING ×N chain for sweeping a line in one pass. ──
export function tickRings(room, p) {
  const rings = room.rings;
  if (!rings || !rings.length || !p) return;
  const lv = p.level || 0;
  for (const ring of rings) {
    if (ring.taken || (ring.level || 0) !== lv) continue;
    if (dist(p.x, p.y, ring.x, ring.y) < p.r + 28) { ring.taken = true; collectRing(room, p, ring); }
  }
}
function collectRing(room, p, ring) {
  const run = state.run; if (!run) return;
  const fy = ring.y - TIER_LIFT * (ring.rise || 1) * (ring.level || 0); // pop at the ring's drawn height
  const now = room.time || 0;
  run._ringChain = (now - (run._ringAt ?? -99) < 0.85) ? (run._ringChain || 0) + 1 : 1;
  run._ringAt = now;
  run.score += Math.floor(45 * (run.combo || 1) * (1 + Math.min(2, run._ringChain * 0.08)) * (state.room?.mutator?.ringBonus ? 2 : 1));
  addRedline(0.02);
  burst(room, ring.x, fy, '#ffce5a', 7, 150, 0.26, 2.4);
  burst(room, ring.x, fy, '#ffffff', 3, 90, 0.2, 2);
  sfx('pickup');
  if (run._ringChain >= 5 && run._ringChain % 5 === 0) addFloat(room, ring.x, fy - 20, `RING ×${run._ringChain}`, '#ffce5a', true, 0.62);
}

export function killScore(e) {
  const run = state.run;
  const prevTier = Math.floor(run.combo);
  run.combo = Math.min(COMBO.CAP, run.combo + (e.boss ? COMBO.PER_BOSS : e.miniboss ? 0.7 : COMBO.PER_KILL));
  const tier = Math.floor(run.combo);
  if (run.combo > (run.bestCombo || 1)) run.bestCombo = run.combo; // run-long best, for the recap
  if (tier > prevTier && tier >= 2) comboMilestone(tier, e);
  run.comboT = COMBO.WINDOW;
  const pts = Math.floor(e.score * run.combo
    * (run.overdrive ? SCORE.OVERDRIVE_MULT : 1)
    * (state.room?.mutator?.scoreMult || 1)
    * (run.redlineT > 0 ? REDLINE.SCORE : 1));
  run.score += pts;
  addRedline(e.boss ? 0.4 : e.miniboss ? 0.3 : 0.045); // every kill feeds the flow surge
  run.kills++; run.roomKills++;
  state.save.lifetime.kills++;
  state.save.bestiary[e.type] = (state.save.bestiary[e.type] || 0) + 1;
  run.streak++; run.streakT = 0.8;
  if (run.streak < STREAK_NAMES.length && STREAK_NAMES[run.streak] && state.room) {
    addFloat(state.room, e.x, e.y - 58, STREAK_NAMES[run.streak], state.room.biome?.pal.accent3 || '#ffd36e', true);
  }
  return pts;
}

export function sparkScore() {
  const run = state.run;
  run.score += Math.floor(SCORE.SPARK * run.combo);
  state.save.sparks = (state.save.sparks || 0) + 1;
}

// ── Per-room STYLE RANK: a character-action grade at clear. Rewards exactly the
// breakneck play — a fat combo, a flawless room, skill moves (PERFECT dismounts, air
// tricks, grind chains, counted in run.roomStyle), and a swift clear. S is rare. ──
const GRADE_TIERS = [[7.5, 'S'], [5.5, 'A'], [3.5, 'B'], [1.5, 'C']];
export function roomGrade(room) {
  const run = state.run; if (!run) return 'C';
  let s = 0;
  s += Math.min(3.0, Math.max(0, (run.combo || 1) - 1) * 0.6); // a fat combo
  s += run.player?.roomHit ? 0 : 2.0;                          // flawless room
  s += Math.min(2.5, (run.roomStyle || 0) * 0.4);              // skill moves
  const tt = room.time || 0;                                   // swift clear
  s += tt < 20 ? 1.0 : tt < 34 ? 0.5 : 0;
  for (const [t, g] of GRADE_TIERS) if (s >= t) return g;
  return 'D';
}

export function roomClearScore(room) {
  const run = state.run;
  let total = Math.floor((SCORE.CLEAR_BASE + run.round * SCORE.CLEAR_PER_ROUND) * run.combo);
  const parts = [{ text: `+${total}`, big: true }];
  if (!run.player.roomHit) {
    const noHit = Math.floor(SCORE.NO_HIT * run.combo);
    total += noHit;
    parts.push({ text: `☆ +${noHit}` });
  }
  if (run.round >= SCORE.SPEED_FROM_ROUND) {
    const speed = Math.max(0, Math.floor(SCORE.SPEED_MAX - room.time * SCORE.SPEED_DRAIN));
    if (speed > 0) { total += speed; parts.push({ text: `⚡ +${speed}` }); }
  }
  run.score += total;
  saveNow();
  return parts;
}
