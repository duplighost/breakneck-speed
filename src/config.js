// All tuning lives here. Feel constants come from Boon Moots v50; content stats
// come from No Moon. Anchors refer to docs/ inventories.

export const TAU = Math.PI * 2;
export const SAVE_KEY = 'oneRoomNoMoon.v1';
export const VERSION = '2.6.0-breakneck-skyline';

// px a platform (level 1) rises; per-building height = TIER_LIFT * tier.rise. Shared by
// the generator (roomRoller) and the renderer (draw) so building heights stay in sync.
export const TIER_LIFT = 112;

export const ROOM = {
  W: 2050, H: 1460, H_PORTRAIT: 1820,   // base dims (the roller rolls actual sizes; these document the target)
  WALL: 56,                 // playfield inset
  SPAWN_CLEAR: 360,         // radius around player spawn kept obstacle-free (scales with the bigger arena)
};

export const PLAYER = {
  R: 20, MAX_HP: 6,
  // Moots is drawn at this fraction of his original art size; collision stays separate.
  // Body, gun, body-hugging FX, and bullet emitter all key off this one knob.
  DRAW_SCALE: 0.70,
  // Rocket Shoes should feel like ROCKETS. Top speed + dash reach bumped over the
  // website build so traversal across the gigantic sprawl reads fast, not sluggish.
  SPEED: 560, ACCEL: 64, STOP: 18.0, TURN: 70, LATERAL: 14.0,
  MAX_SPEED_MULT: 1.78, DASH_SPEED_MULT: 7.85,
  FIRE_DELAY: 0.15, DAMAGE: 0.88, SHOT_MULT: 0.72, SHOT_SPEED: 1280,
  // Small, fast bolts: drawBullets renders these as crisp glowing darts (not big lasers,
  // not specks). Snappier to fire and read than the old fat bolts.
  SHOT_R: 3.4, SHOT_LIFE: 1.14, TWIN_OFFSET: 6,
  // Baseline shot homing — barely-there. Only a whisper of correction for an enemy
  // basically dead ahead and close; otherwise shots fly straight where aimed. The
  // hunterMycelia relic stacks on top for players who actually want tracking.
  SHOT_HOMING_TURN: 0.12, SHOT_HOMING_RANGE: 230, SHOT_HOMING_CONE: 0.82,
  // Art-space gun offsets. firePlayer multiplies these by DRAW_SCALE so bullets leave the shrunken muzzle.
  EMITTER_Y: -16, EMITTER_LEN: 32,
  CRIT: 0.03, CRIT_MULT: 1.8,
  // the dash is the centerpiece: long, far, invincible throughout, hits hard+wide.
  // Reach + glide carried over from the faster "good speed / big rooms" fork.
  DASH_IMPULSE: 1850, DASH_DUR: 0.38, DASH_CD: 0.16, DASH_IFRAMES: 0.62,
  DASH_GLIDE: 1.35, DASH_HIT_RANGE: 255, DASH_SWEEP_RANGE: 236, DASH_HIT_MULT: 1.75, DASH_KNOCK: 860,
  DASH_KILL_REFUND: 0.145,   // every kill feeds the dash loop a little
  // Slight aim-assist: when you dash with an enemy almost dead ahead, curve gently toward
  // it. Deliberately subtle — a small correction on a near-aligned dash, not a magnet.
  DASH_HOMING_RANGE: 460, DASH_HOMING_CONE: 0.66, DASH_HOMING_MAX: 0.13,
  DASH_PRIME_MULT: 1.5, DASH_PRIME_PIERCE: 1, // "dash primes next shot" relic payload
  HURT_IFRAMES: 0.92, HURT_KNOCK: 370,
  PICKUP_RANGE: 138,
};

export const COMBO = { PER_KILL: 0.20, PER_BOSS: 1.1, CAP: 16, WINDOW: 3.15 };

export const SCORE = {
  CLEAR_BASE: 300, CLEAR_PER_ROUND: 82, NO_HIT: 400,
  SPEED_MAX: 900, SPEED_DRAIN: 20, SPEED_FROM_ROUND: 3,
  SPARK: 18, OVERDRIVE_MULT: 1.35,
};

export const CAPS = {
  // City-scale arenas: lift the ceilings so the sprawl stays full of action + flash.
  // Director budget scales with room area (see buildWaves); these are the hard caps.
  // TOP PLAYTEST DIAL: drop back if combat reads as soup or perf dips.
  // DEVICE PARITY: mobile == desktop so the fight feels identical on a phone (same world,
  // same enemy/bullet ceilings). Runtime adaptive quality (state.lowFx) still halves
  // particles + drops bloom if frames stay slow — on either platform — so this is safe.
  ENEMIES: { mobile: 104, desktop: 104 },
  ENEMY_BULLETS: { mobile: 240, desktop: 240 },
  PLAYER_BULLETS: { mobile: 210, desktop: 210 },
  PARTICLES: { mobile: 380, desktop: 380 },
};

export const DIRECTOR = {
  // spawn count: clamp(BASE + round*PER_ROUND + rand(0,2) , MIN, cap)
  // Tempo lifted toward the faster fork: more bodies sooner, shorter telegraph,
  // quicker reinforcements — the gigantic rooms stay hot instead of feeling empty.
  BASE: 6, PER_ROUND: 1.4, MIN: 6,
  TELEGRAPH: 0.34,            // warning glyph time before a spawn lands
  REINFORCE_AT: 0.74,         // fraction of count held for the second wave
  REINFORCE_DELAY: [1.05, 1.95],  // seconds (or when 2 enemies remain) — kept snappy for tempo
  // danger stage = min(5, floor(round / 4)) during the route
  STAGE_DIV: 4, STAGE_CAP: 5,
  // non-boss scaling per No Moon: hp ×(1 + stageIdx*0.13 + stage*0.08)
  HP_IDX: 0.13, HP_STAGE: 0.08, SPD_IDX: 0.045, SPD_STAGE: 0.045,
};

// On city-scale maps a distant enemy that just ambles toward you makes the room
// read as slow and empty. HUNT puts anything past FAR into active pursuit — it
// steers harder and gets a speed bonus that ramps to FULL — so the action always
// finds the player. This is the single biggest "feels faster" lever. (Ported from
// the faster fork; absent on the website build, which is why it dragged.)
export const HUNT = {
  FAR: 760, FULL: 2450, STEER: 3.05, SPEED_BONUS: 1.72,
};

export const FX = {
  SHAKE_DECAY: 2.25, FLASH_DECAY: 1.7, SLOWMO_SCALE: 0.55,
  // camera shake is quadratic in trauma (Grave Signal model): offset = trauma²·GAIN.
  // small hits stop buzzing; big hits still punch. GAIN tuned so peak ≈ the old linear feel.
  SHAKE_GAIN: 30,
  HIT_PAUSE: { shot: 8, chain: 12, dash: 11, pulse: 24, kill: 18, dashKill: 26, boss: 48, hurt: 60 }, // ms
};

export const BLOOM = { ALPHA: 0.26, FILTER: 'blur(13px) saturate(1.26)' };

export const ANNEX = { CHANCE: 0.48, AMBUSH: 0.45 };

export const STREAK_NAMES = ['', '', '×2', '×3', '', '×5', '', '', '×8'];
