// Deterministic math for the simulation.
//
// Math.exp / sin / cos / atan2 / log are NOT bit-identical across JS engines: Node 24 and current
// Chrome ship different libm implementations and differ in the last bits, which makes a putt end
// 1e-14 m apart and breaks exact browser<->node replays. Everything here uses only + - * / sqrt,
// Math.round/abs and float bit tricks, which IEEE-754 makes identical everywhere.
//
// RULE: sim code (src/sim/*) must use these instead of Math.exp/sin/cos/atan2/hypot/pow/log.

export function len2(x, z) { return Math.sqrt(x * x + z * z); }

const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INV_LN2 = 1.44269504088896338700e+00;
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0; // little-endian => high word at index 1

function pow2(k) { // exact 2^k for -1022 <= k <= 1023
  u32[HI] = (k + 1023) << 20; u32[1 - HI] = 0;
  return f64[0];
}

export function exp(x) {
  if (x !== x) return x;
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;   // |r| <= ~0.347
  // Taylor series to r^13 (error < 1e-17 relative)
  let p = 1 / 6227020800;
  p = p * r + 1 / 479001600; p = p * r + 1 / 39916800; p = p * r + 1 / 3628800; p = p * r + 1 / 362880;
  p = p * r + 1 / 40320; p = p * r + 1 / 5040; p = p * r + 1 / 720; p = p * r + 1 / 120; p = p * r + 1 / 24;
  p = p * r + 1 / 6; p = p * r + 0.5; p = p * r + 1; p = p * r + 1;
  if (k < -1021) return p * pow2(k + 60) * pow2(-60);
  return p * pow2(k);
}

const PIO2_HI = 1.57079632673412561417e+00, PIO2_LO = 6.07710050650619224932e-11, INV_PIO2 = 6.36619772367581382433e-01;

function sinPoly(r) { const r2 = r * r; let p = -1 / 1307674368000; p = p * r2 + 1 / 6227020800; p = p * r2 - 1 / 39916800; p = p * r2 + 1 / 362880; p = p * r2 - 1 / 5040; p = p * r2 + 1 / 120; p = p * r2 - 1 / 6; return r + r * r2 * p; }
function cosPoly(r) { const r2 = r * r; let p = 1 / 20922789888000; p = p * r2 - 1 / 87178291200; p = p * r2 + 1 / 479001600; p = p * r2 - 1 / 3628800; p = p * r2 + 1 / 40320; p = p * r2 - 1 / 720; p = p * r2 + 1 / 24; p = p * r2 - 0.5; return 1 + r2 * p; }

/** Accurate for |x| up to ~1e6, which is far beyond anything the sim uses. */
export function sin(x) {
  const k = Math.round(x * INV_PIO2);
  const r = (x - k * PIO2_HI) - k * PIO2_LO;
  switch (((k % 4) + 4) % 4) { case 0: return sinPoly(r); case 1: return cosPoly(r); case 2: return -sinPoly(r); default: return -cosPoly(r); }
}
export function cos(x) {
  const k = Math.round(x * INV_PIO2);
  const r = (x - k * PIO2_HI) - k * PIO2_LO;
  switch (((k % 4) + 4) % 4) { case 0: return cosPoly(r); case 1: return -sinPoly(r); case 2: return -cosPoly(r); default: return sinPoly(r); }
}

const PI = 3.141592653589793, PIO2 = 1.5707963267948966;
function atanSmall(t) { // |t| <= ~0.2
  const t2 = t * t; let p = 0, sgn = (11 % 2 === 0) ? 1 : -1;
  for (let n = 11; n >= 1; n--, sgn = -sgn) p = p * t2 + sgn / (2 * n + 1);
  return t + t * t2 * p;
}
export function atan(t) {
  if (t !== t) return t;
  const neg = t < 0; let a = neg ? -t : t, inv = false;
  if (a > 1) { a = 1 / a; inv = true; }
  // two half-angle reductions: atan(a) = 2 atan(a / (1 + sqrt(1 + a^2)))
  a = a / (1 + Math.sqrt(1 + a * a));
  a = a / (1 + Math.sqrt(1 + a * a));
  let r = 4 * atanSmall(a);
  if (inv) r = PIO2 - r;
  return neg ? -r : r;
}
export function atan2(y, x) {
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  if (y > 0) return PIO2;
  if (y < 0) return -PIO2;
  return 0;
}
