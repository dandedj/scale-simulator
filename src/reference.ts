/**
 * The options reference: every setting in every simulator, on one page, with
 * the dot-path a deep link uses to set it.
 *
 * Nothing here is written down twice. Each mode's control panel describes
 * itself from the definitions it already renders, and each path is recovered by
 * running the real setter — so a knob that is added, renamed, retuned or removed
 * shows up here on its own, and a path this page prints is one the link parser
 * will accept.
 *
 * It is a mode like the simulators, so it is reachable from the same nav and
 * addressable by the same links (`?m=reference`).
 */

import { LINK_KEYS } from './deeplink';
import { describeDnsOptions } from './dns/ui/controls';
import type { Experience, ExperienceHosts, PlaybackController } from './experience';
import type { OptionDoc, OptionSection } from './optionDoc';
import { describePoolOptions } from './pools/ui/controls';
import { describeScalingOptions } from './scaling/ui/controls';
import { describeStormOptions } from './ui/controls';

const LINK_EXAMPLES: Array<{ label: string; query: string; note: string }> = [
  {
    label: 'A scenario, as-is',
    query: '?m=scaling&s=sustained',
    note: 'Mode plus scenario id. Everything else comes from the scenario.',
  },
  {
    label: 'A scenario with one thing changed',
    query: '?m=scaling&s=sustained&launch.bakeMs=600000',
    note: 'Any dot-path below, appended as a query parameter. Only what differs needs stating.',
  },
  {
    label: 'A comparison, running on load',
    query: '?m=scaling&cmp=1&s=sustained&s2=long-bake&run=1',
    note: '<code>cmp=1</code> opens comparison mode, <code>s2</code> is pane B, <code>run=1</code> skips the start gate.',
  },
  {
    label: 'Changing pane B only',
    query: '?m=scaling&cmp=1&s=sustained&s2=sustained&b.launch.bakeMs=900000',
    note: 'Prefix a path with <code>b.</code> to aim it at pane B. Bare paths address pane A.',
  },
];

function sections(): OptionSection[] {
  return [
    {
      id: 'storm',
      title: '⚡ Connection Storm',
      blurb:
        'Clients, the RTB Fabric’s limits and shared CPU, downstream pools, and the lock model. Link with <code>?m=storm</code>.',
      options: describeStormOptions(),
    },
    {
      id: 'dns',
      title: '⌖ DNS Distribution',
      blurb:
        'Zone TTL, client re-resolution and pinning, server capacity, and the RST-shedding fast loop. Link with <code>?m=dns</code>.',
      options: describeDnsOptions(),
    },
    {
      id: 'pools',
      title: '⇉ Outbound Pools',
      blurb:
        'RTB Fabric Links and Link endpoints, pool ownership and key cardinality, Hyper idle behavior, hypothetical active caps, and customer responder limits. Link with <code>?m=pools</code>.',
      options: describePoolOptions(),
    },
    {
      id: 'scaling',
      title: '↗ Scaling',
      blurb:
        'The demand ramp, the fleet’s buffer, the scaling policy and its bake, and the nine pipeline stages. Link with <code>?m=scaling</code>.',
      options: describeScalingOptions(),
    },
  ];
}

export class ReferenceExperience implements Experience {
  /** Nothing advances here; the shell still needs a number. */
  readonly maxSimStepMs = 0;

  private hosts!: ExperienceHosts;
  private root: HTMLElement | null = null;
  private filter = '';
  private filterInput: HTMLInputElement | null = null;

  mount(hosts: ExperienceHosts, playback: PlaybackController): void {
    this.hosts = hosts;
    // No clock, no gate — this is a document.
    playback.setPaused(true);
    document.getElementById('app')?.classList.add('reference-mode');
    this.build();
  }

  unmount(): void {
    document.getElementById('app')?.classList.remove('reference-mode');
    this.root?.remove();
    this.hosts.header.replaceChildren();
    this.hosts.side.replaceChildren();
    this.hosts.stage.replaceChildren();
    this.hosts.hud.replaceChildren();
  }

  step(): void {}
  render(): void {}
  resize(): void {}
  simTimeMs(): number {
    return 0;
  }

  deepLink() {
    return { mode: 'reference' };
  }

  private build(): void {
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'ref-search';
    search.placeholder = 'Filter settings…';
    search.spellcheck = false;
    search.addEventListener('input', () => {
      this.filter = search.value.trim().toLowerCase();
      this.renderList();
    });
    this.filterInput = search;
    this.hosts.header.appendChild(search);

    const root = document.createElement('div');
    root.className = 'reference-page';
    this.root = root;
    this.hosts.stage.appendChild(root);
    this.renderList();
  }

  private renderList(): void {
    if (!this.root) return;
    const all = sections();
    const q = this.filter;
    const parts: string[] = [];

    parts.push(`
      <header class="ref-head">
        <h1>Options reference</h1>
        <p>Every setting in every simulator, with the key a deep link uses to set it.
        This page is generated from the control panels themselves, so it lists what they
        actually offer.</p>
      </header>`);

    parts.push('<section class="ref-links"><h2>Deep links</h2>');
    parts.push(
      `<p>The address bar always shows the current configuration — tune anything and copy it,
      or press <b>🔗 LINK</b> to copy it directly. A link is a scenario plus whatever differs
      from it, so it stays short and stays readable.</p>`,
    );
    parts.push('<div class="ref-link-list">');
    for (const ex of LINK_EXAMPLES) {
      parts.push(
        `<div class="ref-link"><code>${ex.query}</code><div class="ref-link-label">${ex.label}</div>` +
          `<div class="ref-link-note">${ex.note}</div></div>`,
      );
    }
    parts.push('</div>');
    parts.push(
      `<p class="ref-note">Reserved keys: <code>${LINK_KEYS.mode}</code> (mode),
      <code>${LINK_KEYS.scenario}</code> / <code>${LINK_KEYS.scenarioB}</code> (scenario per pane),
      <code>${LINK_KEYS.compare}</code> (comparison mode), <code>${LINK_KEYS.run}</code> (start immediately).
      Every other key is a setting path. An unknown path is ignored, so an old link degrades
      rather than breaking.</p>`,
    );
    parts.push('</section>');

    let shown = 0;
    for (const section of all) {
      const matches = section.options.filter((o) => matchesFilter(o, section.title, q));
      if (matches.length === 0) continue;
      shown += matches.length;
      parts.push(`<section class="ref-section"><h2>${section.title}</h2><p class="ref-blurb">${section.blurb}</p>`);
      for (const group of groupBy(matches)) {
        parts.push(`<h3>${group.name}</h3><div class="ref-options">`);
        for (const o of group.options) parts.push(optionHtml(o));
        parts.push('</div>');
      }
      parts.push('</section>');
    }
    if (shown === 0) parts.push(`<section class="ref-section"><p class="ref-blurb">Nothing matches “${escapeHtml(q)}”.</p></section>`);

    this.root.innerHTML = parts.join('');
  }

  onResume(): void {
    this.filterInput?.blur();
  }
}

// ---------------------------------------------------------------------------

function matchesFilter(o: OptionDoc, sectionTitle: string, q: string): boolean {
  if (!q) return true;
  const hay = [o.label, o.group, o.path ?? '', sectionTitle, o.info?.what ?? '', o.info?.how ?? '', o.info?.expect ?? '']
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function groupBy(options: OptionDoc[]): Array<{ name: string; options: OptionDoc[] }> {
  const out: Array<{ name: string; options: OptionDoc[] }> = [];
  for (const o of options) {
    let g = out.find((x) => x.name === o.group);
    if (!g) {
      g = { name: o.group, options: [] };
      out.push(g);
    }
    g.options.push(o);
  }
  return out;
}

function optionHtml(o: OptionDoc): string {
  const range =
    o.kind === 'range' && o.range
      ? `<span class="ref-range">${fmtNum(o.range.min)} – ${fmtNum(o.range.max)} · step ${fmtNum(o.range.step)}</span>`
      : o.choices
        ? `<span class="ref-range">${o.choices.map(escapeHtml).join(' · ')}</span>`
        : '';
  const path = o.path
    ? `<code class="ref-path" title="Deep-link key">${o.path}</code>`
    : `<span class="ref-path ref-path-none" title="This control writes more than one field">—</span>`;
  const info = o.info
    ? `<div class="ref-info">
         <p><b>What</b> ${escapeHtml(o.info.what)}</p>
         <p><b>How</b> ${escapeHtml(o.info.how)}</p>
         <p><b>Expect</b> ${escapeHtml(o.info.expect)}</p>
       </div>`
    : '';
  return `<div class="ref-option">
      <div class="ref-option-head">
        <span class="ref-label">${escapeHtml(o.label)}</span>
        ${path}
        <span class="ref-default">${escapeHtml(o.value)}</span>
      </div>
      ${range}
      ${info}
    </div>`;
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return String(+v.toFixed(4));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
