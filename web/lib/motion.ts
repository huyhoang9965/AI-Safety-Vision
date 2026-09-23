export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (start: number, end: number, amount: number) => start + (end - start) * amount;
export function smoothstep(start: number, end: number, value: number) {
  const t = clamp((value - start) / (end - start));
  return t * t * (3 - 2 * t);
}
export const segmentInOut = (value: number, enter: number, full: number, exit: number, end: number) =>
  smoothstep(enter, full, value) * (1 - smoothstep(exit, end, value));
