export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function formatGB(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  return `${gb.toFixed(1)} GB`;
}
