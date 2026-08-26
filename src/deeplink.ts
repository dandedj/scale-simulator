/**
 * Deep links: the whole state of a run in the address bar, so a configuration
 * can be inspected, shared, and reproduced exactly.
 *
 * A link is a scenario plus the ways it was changed, not a dump of every field:
 *
 *   ?m=scaling&s=baseline&launch.bakeMs=600000
 *   ?m=scaling&cmp=1&s=sustained&s2=long-bake&run=1
 *
 * Keys are dot-paths into the mode's config, so they are the same strings the
 * options reference lists — and they are derived from the real setters rather
 * than written down twice (see `pathOfSetter`).
 */

/** Reserved keys; everything else in a link is a config override path. */
export const LINK_KEYS = {
  mode: 'm',
  scenario: 's',
  scenarioB: 's2',
  compare: 'cmp',
  run: 'run',
} as const;

/** Overrides for pane B in comparison mode carry this prefix. */
export const PANE_B_PREFIX = 'b.';

type Scalar = number | string | boolean;
type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null;
}

/**
 * Flatten a config to dot-paths. Arrays are indexed (`policy.steps.1.adjustment`)
 * so a step ladder is addressable rung by rung.
 */
export function flatten(obj: unknown, prefix = ''): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!isPlain(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v)) Object.assign(out, flatten(v, path));
    else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[path] = v;
  }
  return out;
}

/** Paths where `cfg` differs from `base`, with `cfg`'s values. */
export function diff(base: unknown, cfg: unknown): Record<string, Scalar> {
  const a = flatten(base);
  const b = flatten(cfg);
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(b)) if (a[k] !== v) out[k] = v;
  return out;
}

/**
 * Write one dot-path into a config, coercing to the type already there. An
 * unknown path is ignored rather than inventing a field — a stale link should
 * degrade, not corrupt the config.
 */
export function applyPath(cfg: unknown, path: string, raw: string): boolean {
  const parts = path.split('.');
  let node: Plain | undefined = isPlain(cfg) ? cfg : undefined;
  for (const part of parts.slice(0, -1)) {
    const next: unknown = node?.[part];
    if (!isPlain(next)) return false;
    node = next;
  }
  const key = parts[parts.length - 1];
  if (!node || !(key in node)) return false;
  const current = node[key];
  if (typeof current === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    node[key] = n;
  } else if (typeof current === 'boolean') {
    node[key] = raw === '1' || raw === 'true';
  } else if (typeof current === 'string') {
    node[key] = raw;
  } else return false;
  return true;
}

/** Apply every override in `params` that targets this config. */
export function applyOverrides(cfg: unknown, params: URLSearchParams, prefix = ''): void {
  const reserved = new Set<string>(Object.values(LINK_KEYS));
  for (const [key, value] of params) {
    if (reserved.has(key)) continue;
    const isPaneB = key.startsWith(PANE_B_PREFIX);
    const path = isPaneB ? key.slice(PANE_B_PREFIX.length) : key;
    // Bare paths address pane A / the single sim; `b.` ones address pane B.
    if ((prefix === PANE_B_PREFIX) !== isPaneB) continue;
    applyPath(cfg, path, value);
  }
}

/**
 * The dot-path a knob's setter writes, found by running the setter on a clone
 * and seeing what moved. Keeps the reference and the links honest: neither can
 * name a field the control does not actually touch.
 */
export function pathOfSetter<C>(base: C, set: (cfg: C, value: never) => void, sample: Scalar): string | null {
  const clone = structuredClone(base);
  try {
    set(clone, sample as never);
  } catch {
    return null;
  }
  const changed = Object.keys(diff(base, clone));
  return changed.length === 1 ? changed[0] : (changed[0] ?? null);
}

/** A value distinct from anything a config realistically holds. */
export const PROBE_NUMBER = -8675309.5;
export const PROBE_STRING = '__probe__';

export interface LinkState {
  mode: string;
  scenario?: string | null;
  scenarioB?: string | null;
  compare?: boolean;
  run?: boolean;
  /** Overrides for the single sim / pane A. */
  overrides?: Record<string, Scalar>;
  /** Overrides for pane B. */
  overridesB?: Record<string, Scalar>;
}

export function encode(state: LinkState): string {
  const p = new URLSearchParams();
  p.set(LINK_KEYS.mode, state.mode);
  if (state.scenario) p.set(LINK_KEYS.scenario, state.scenario);
  if (state.compare) {
    p.set(LINK_KEYS.compare, '1');
    if (state.scenarioB) p.set(LINK_KEYS.scenarioB, state.scenarioB);
  }
  if (state.run) p.set(LINK_KEYS.run, '1');
  for (const [k, v] of Object.entries(state.overrides ?? {})) p.set(k, String(v));
  if (state.compare) for (const [k, v] of Object.entries(state.overridesB ?? {})) p.set(`${PANE_B_PREFIX}${k}`, String(v));
  return p.toString();
}

export function readParams(): URLSearchParams {
  // Query first; the hash is accepted too so a copied `#?m=…` still works.
  const search = window.location.search.replace(/^\?/, '');
  const hash = window.location.hash.replace(/^#\??/, '');
  return new URLSearchParams(search || hash);
}

/** Replace the address bar without touching history — this fires on every knob. */
export function writeUrl(query: string): void {
  const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  window.history.replaceState(null, '', url);
}
