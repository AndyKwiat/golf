// Full-hole game constants. SI units (meters, seconds, radians). Pure: no DOM / three.js.
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const SUBSTEPS = 8;              // physics substeps per tick (fast ball vs thin tree trunks)

export const G = 9.81;
export const ROLL_FACTOR = 5 / 7;
export const BALL_R = 0.02135;
export const CUP_R = 0.054;
export const CUP_CAPTURE_SPEED = 1.63;
export const REST_SPEED = 0.03;

// Aerodynamics (simplified): drag accel = KD |v| v ; lift accel = KL * spin * |v|^2 perpendicular to v (upward)
export const KD = 0.0048;
export const KL = 0.0191;
export const SPIN_DECAY = 5;            // seconds (spin/lift e-folding time)

// Ground interaction per surface:
//  roll: rolling resistance mu (decel = mu g)   e: bounce restitution (normal)
//  tf: tangential speed lost per bounce          grip: how much backspin bites on landing
// Speeds: green is fastest (putting), fairway ~4x slower, rough ~13x slower.
export const SURF = {
  tee:     { roll: 0.24, e: 0.25, tf: 0.45, grip: 2.0 },
  fairway: { roll: 0.24, e: 0.25, tf: 0.45, grip: 2.0 },
  rough:   { roll: 0.70, e: 0.12, tf: 0.75, grip: 0.5 },
  fringe:  { roll: 0.20, e: 0.22, tf: 0.50, grip: 2.5 },
  green:   { roll: 0.055, e: 0.22, tf: 0.45, grip: 3.2 },
  sand:    { roll: 1.20, e: 0.04, tf: 0.85, grip: 0.5 },
  water:   { roll: 5, e: 0, tf: 1, grip: 0 },
  oob:     { roll: 0.70, e: 0.12, tf: 0.75, grip: 0.5 },
};
// Landing bite: tangential speed lost per bounce = tf + BACKSPIN_BITE * spin * grip.
export const BACKSPIN_BITE = 1.4;
export const BOUNCE_TO_ROLL = 1.2;      // m/s: below this rebound speed the ball starts rolling

// Launch modifiers by lie: speed multiplier and spin multiplier (wedges get a better sand factor)
export const LIE = {
  tee: { speed: 1, spin: 1 }, fairway: { speed: 1, spin: 1 }, fringe: { speed: 0.97, spin: 0.9 },
  green: { speed: 0.97, spin: 0.9 }, rough: { speed: 0.85, spin: 0.5 }, sand: { speed: 0.72, spin: 0.7, wedgeSpeed: 0.9 },
};

export const PUTT_MAX_FLAT = 30;        // putter: power 1 rolls 30 m on flat green

// Shot shape: curve = +-1 gives this much sidespin (same units as backspin/lift coefficient).
// Deliberately exaggerated (video-game banana balls): see tests/golf.test.mjs for the bend.
export const CURVE_SIDESPIN = 0.256;

export const FRINGE_WIDTH = 1.2;

export const SWING = { upRate: 1 / 1.3, returnRate: 1 / 0.8, zoneMin: -0.15, perfect: 0.02, errPerUnit: 0.3 };

export const MAX_SHOT_TICKS = 60 * 60;
