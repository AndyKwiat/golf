// Mouse-swing scoring (pure, deterministic). The player draws a line straight DOWN the screen:
//  - power   = selected power x (drawn length / target length), capped at MOUSE.maxPower (120%).
//              The target length is MOUSE.targetFrac (30%) of the screen height.
//  - accuracy: how straight the stroke is. Two parts, both relative to the stroke length:
//      slant  = mean sideways offset from the vertical through the start point (signed)
//      wobble = spread of the sideways offset around that mean (jitter)
//    The error is an ANGLE added to the aim (so long shots miss by more), pushed toward the side
//    the stroke drifted. Overshooting the target multiplies the error, so only a perfectly straight
//    line gets the full 120% for free. Putts ignore accuracy (power only).
// Points are screen pixels [x, y] with y pointing down (DOM coordinates).

export const MOUSE = {
  targetFrac: 0.3,   // target line is 30% of the screen height below the press point
  maxPower: 1.2,     // power multiplier cap (perfectly straight + long stroke)
  minFrac: 0.03,     // strokes shorter than 3% of the screen height cancel the swing
  errK: 1.0,         // radians of aim error per unit of (slant + wobble) / length
  overshootK: 2.5,   // error multiplier per unit of overshoot past the target
};

/**
 * @param {Array<[number, number]>} pts  stroke samples in screen px (first = press point)
 * @param {number} screenH  screen (canvas) height in px
 * @param {{putter?: boolean}} opts
 * @returns {null | {ratio, powerMul, aimErr, slant, wobble, accuracy}}  null = cancelled
 */
export function scoreMouseSwing(pts, screenH, { putter = false } = {}) {
  if (!pts || pts.length < 2 || !(screenH > 0)) return null;
  const [x0, y0] = pts[0], yEnd = pts[pts.length - 1][1];
  const len = yEnd - y0;
  if (len < MOUSE.minFrac * screenH) return null;
  const ratio = len / (MOUSE.targetFrac * screenH);
  let n = 0, sum = 0, sq = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (y <= y0) continue;
    const dx = x - x0; sum += dx; sq += dx * dx; n++;
  }
  const mean = n ? sum / n : 0, varc = n ? Math.max(0, sq / n - mean * mean) : 0;
  const slant = mean / len, wobble = Math.sqrt(varc) / len;
  const straight = Math.abs(slant) + wobble;
  const over = Math.max(0, ratio - 1);
  const aimErr = putter ? 0 : (slant < 0 ? -1 : 1) * straight * MOUSE.errK * (1 + over * MOUSE.overshootK);
  return {
    ratio, powerMul: Math.min(MOUSE.maxPower, ratio), aimErr, slant, wobble,
    accuracy: putter ? 1 : Math.max(0, 1 - straight * 10),   // 1 = perfect (display only)
  };
}
