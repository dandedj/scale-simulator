/**
 * The palette. Semantic colors are the Okabe-Ito colorblind-safe set,
 * brightened for a dark background; surfaces follow Grafana dark theme —
 * the visual language an SRE/AdTech audience already trusts.
 * Color is always paired with shape (spiked = timeout, hollow = shed,
 * square = error) so no meaning rides on hue alone.
 */

export const SURFACE = {
  canvas: '#0E0F13',
  panel: '#181B1F',
  panelRaised: '#1F2329',
  border: '#2C3235',
  grid: '#1A1D22',
  text: '#CCCCDC',
  textDim: '#7B8087',
  textFaint: '#4D525A',
} as const;

export const SEMANTIC = {
  success: '#00C49A',
  inFlight: '#56B4E9',
  connEstablished: '#3A8FD9',
  timeout: '#FF6E40',
  shed: '#E69F00',
  error: '#F0E442',
  retry: '#CC79A7',
  idle: '#3A4148',
  tlsPulse: '#A3D9F5',
  cpuOk: '#00C49A',
  cpuWarn: '#E69F00',
  cpuBad: '#FF6E40',
} as const;

/** Utilization 0..1+ → green → amber → red. */
export function loadColor(u: number): string {
  if (u < 0.6) return SEMANTIC.cpuOk;
  if (u < 0.9) return SEMANTIC.cpuWarn;
  return SEMANTIC.cpuBad;
}

/** Hex + alpha (0..1) → rgba() string. */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
