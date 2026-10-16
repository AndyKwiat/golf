// All simulation constants live here. SI units: meters, seconds, radians.
// The simulation is pure JS (no three.js, no DOM) so it runs identically in Node and the browser.

export const TICK_RATE = 60;            // fixed simulation ticks per second
export const DT = 1 / TICK_RATE;        // seconds per tick
export const SUBSTEPS = 4;              // physics substeps per tick (accuracy around the cup)

export const G = 9.81;
export const ROLL_FACTOR = 5 / 7;       // a rolling solid sphere accelerates at 5/7 g sin(theta)

export const BALL_R = 0.02135;          // regulation ball radius
export const CUP_R = 0.054;             // regulation cup radius (4.25in diameter)
export const CUP_CAPTURE_SPEED = 1.63;  // max speed (m/s) a dead-center ball can still drop

// Rolling resistance coefficients (deceleration = mu * g). Green ~ stimp 10.
export const FRICTION = { green: 0.055, fringe: 0.16, rough: 0.45 };
export const REST_SPEED = 0.025;        // below this speed (and on a gentle enough slope) the ball stops

// Surface bands, measured as distance outside the green edge.
export const FRINGE_WIDTH = 1.2;
export const ROUGH_WIDTH = 8;           // beyond fringe+rough the ball is out of bounds
export const WORLD_SIZE = 100;          // rendered terrain is a WORLD_SIZE x WORLD_SIZE square centered at origin

// Power: power in [0,1] maps to the distance the ball would roll on a FLAT green.
// So power 0.5 always means "15 m on flat" which makes the bar readable.
export const MAX_FLAT_DIST = 40;

// Normal-mode swing meter (Mario-Golf style 3-press meter). Rates are per second.
export const SWING = {
  upRate: 1 / 1.3,      // marker climbs 0 -> 1 in 1.3 s, then falls back
  returnRate: 1 / 0.8,  // after power is set the marker sweeps back toward impact
  zoneMin: -0.15,       // marker runs past the impact line down to here, then auto-hits (worst accuracy)
  perfect: 0.02,        // |offset| inside this window = perfectly straight
  errPerUnit: 0.3,      // radians of push/pull per unit of offset beyond the perfect window
};

export const MAX_ROLL_TICKS = 60 * 90;  // safety cap on a single putt
