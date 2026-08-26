/**
 * The shell: the app's single driver. It owns the one requestAnimationFrame
 * loop, the time-dilation clock, the pause/start-gate, the visibility
 * auto-pause, Space-to-pause, the shared #hud-clock, and the header mode switch
 * that swaps between the registered experiences (connection storm, DNS
 * distribution). Each experience builds and tears down its own stage + control
 * DOM; the shell only ever steps and renders whichever one is active.
 */

import { StormExperience } from './app';
import { DnsExperience } from './dns/experience';
import { ScalingExperience } from './scaling/experience';
import { encode, LINK_KEYS, readParams, writeUrl } from './deeplink';
import type { Experience, ExperienceDef, ExperienceHosts, PlaybackController } from './experience';
import { ReferenceExperience } from './reference';

/** Ignore wall-time gaps bigger than this (background tab, debugger). */
const MAX_FRAME_WALL_MS = 100;
/** How often the address bar is refreshed from the live state (ms). */
const URL_SYNC_MS = 500;

/** The registered modes, in tab order. */
const EXPERIENCES: ExperienceDef[] = [
  {
    id: 'storm',
    label: '⚡ Connection Storm',
    subtitle: 'connection storm simulator',
    create: () => new StormExperience(),
  },
  {
    id: 'dns',
    label: '⌖ DNS Distribution',
    subtitle: 'DNS load-distribution simulator',
    create: () => new DnsExperience(),
  },
  {
    id: 'scaling',
    label: '↗ Scaling',
    subtitle: 'autoscaling ramp-up simulator',
    create: () => new ScalingExperience(),
  },
  {
    id: 'reference',
    label: '§ Options reference',
    subtitle: 'every setting, explained',
    create: () => new ReferenceExperience(),
  },
];

export class Shell {
  private timeScale = 1;
  private paused = true;
  private gateArmed = true;
  private pausedByVisibility = false;
  private lastWall = 0;
  private lastUrlSync = 0;
  private lastQuery = '';
  /** Deep-link params for the mode being mounted, consumed once. */
  private pendingLink: URLSearchParams | null = null;

  private active!: Experience;
  private activeId = '';
  private modeTabs = new Map<string, HTMLButtonElement>();

  private appEl = document.getElementById('app')!;
  private modeSwitchEl = document.getElementById('mode-switch')!;
  private modeTrigger: HTMLButtonElement | null = null;
  private modeMenu: HTMLElement | null = null;
  private modeMenuOpen = false;
  private startGate = document.getElementById('start-gate')!;
  private startBtn = document.getElementById('start-btn')!;
  private startHint = document.getElementById('start-hint')!;
  private hudClock = document.getElementById('hud-clock')!;
  private brandSub = document.querySelector('.brand-sub') as HTMLElement | null;

  private hosts: ExperienceHosts = {
    header: document.getElementById('header-controls')!,
    side: document.getElementById('side')!,
    stage: document.getElementById('panes')!,
    stageCol: document.getElementById('stage-col')!,
    hud: document.getElementById('hud-extra')!,
  };

  private playback: PlaybackController = {
    setPaused: (p) => this.setPaused(p),
    isPaused: () => this.paused,
    setTimeScale: (s) => {
      this.timeScale = s;
    },
    getTimeScale: () => this.timeScale,
    rearmGate: () => {
      this.gateArmed = true;
      this.setPaused(true);
    },
    setStartHint: (t) => {
      this.startHint.textContent = t;
    },
  };

  constructor() {
    this.buildModeSwitch();
    this.startBtn.addEventListener('click', () => this.setPaused(false));

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        this.setPaused(!this.paused);
      }
    });
    window.addEventListener('resize', () => {
      this.active.resize();
      this.syncControlOverflow();
    });
    document.addEventListener('visibilitychange', () => {
      // Browsers throttle rAF in background tabs; auto-pause instead of letting
      // the sim lurch when the tab returns.
      if (document.hidden && !this.paused) {
        this.paused = true;
        this.pausedByVisibility = true;
      } else if (!document.hidden && this.pausedByVisibility) {
        this.paused = false;
        this.pausedByVisibility = false;
      }
    });

    // Boot straight into whatever the link asks for.
    const params = readParams();
    const wanted = EXPERIENCES.find((d) => d.id === params.get(LINK_KEYS.mode));
    this.pendingLink = params;
    this.mountExperience(wanted ?? EXPERIENCES[0]);
    if (params.get(LINK_KEYS.run) === '1') this.setPaused(false);

    requestAnimationFrame((t) => {
      this.lastWall = t;
      this.active.resize();
      requestAnimationFrame(this.frame);
    });
  }

  /**
   * The mode switch is a collapsed nav rather than a row of tabs: which
   * simulator you are in is a different kind of choice from the per-mode
   * controls beside it, and three always-on tabs made the header read as one
   * undifferentiated strip. The trigger names the current mode, so the state is
   * still visible with the menu shut.
   */
  private buildModeSwitch(): void {
    const trigger = document.createElement('button');
    trigger.className = 'btn mode-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.title = 'Switch simulator';
    this.modeTrigger = trigger;

    const menu = document.createElement('div');
    menu.className = 'mode-menu';
    menu.setAttribute('role', 'menu');
    for (const def of EXPERIENCES) {
      const item = document.createElement('button');
      item.className = 'mode-item';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `<span class="mode-item-label">${def.label}</span><span class="mode-item-sub">${def.subtitle}</span>`;
      item.addEventListener('click', () => {
        this.setModeMenu(false);
        this.switchTo(def.id);
      });
      this.modeTabs.set(def.id, item);
      menu.appendChild(item);
    }
    this.modeMenu = menu;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setModeMenu(!this.modeMenuOpen);
    });
    // Any click elsewhere, or Escape, closes it.
    document.addEventListener('click', () => this.setModeMenu(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modeMenuOpen) this.setModeMenu(false);
    });
    menu.addEventListener('click', (e) => e.stopPropagation());

    // Sharing the current configuration is a global action, like the mode
    // itself — it belongs beside the nav, not among the per-mode controls.
    const link = document.createElement('button');
    link.className = 'btn mode-link';
    link.textContent = '🔗 LINK';
    link.title = 'Copy a link to this exact configuration';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyLink(link);
    });
    this.modeSwitchEl.append(trigger, menu, link);
  }

  private async copyLink(btn: HTMLButtonElement): Promise<void> {
    this.syncUrl();
    const url = window.location.href;
    const done = (label: string) => {
      btn.textContent = label;
      window.setTimeout(() => (btn.textContent = '🔗 LINK'), 1400);
    };
    try {
      await navigator.clipboard.writeText(url);
      done('✓ COPIED');
    } catch {
      // Clipboard access can be refused; the URL is in the address bar anyway.
      done('⌫ IN BAR');
    }
  }

  private setModeMenu(open: boolean): void {
    this.modeMenuOpen = open;
    this.modeMenu?.classList.toggle('open', open);
    this.modeTrigger?.classList.toggle('active', open);
    this.modeTrigger?.setAttribute('aria-expanded', String(open));
  }

  private mountExperience(def: ExperienceDef): void {
    this.active = def.create();
    this.activeId = def.id;
    this.appEl.classList.add(`mode-${def.id}`);
    this.active.mount(this.hosts, this.playback);
    // Restore before the first frame, so nothing is simulated at the wrong config.
    if (this.pendingLink) {
      this.active.applyDeepLink?.(this.pendingLink);
      this.pendingLink = null;
    }
    this.pausedByVisibility = false;
    this.gateArmed = true;
    this.setPaused(true);
    this.syncModeTabs();
    this.syncControlOverflow();
    if (this.brandSub) this.brandSub.textContent = def.subtitle;
  }

  private switchTo(id: string): void {
    if (id === this.activeId) return;
    const def = EXPERIENCES.find((d) => d.id === id);
    if (!def) return;
    this.active.unmount();
    this.appEl.classList.remove('compare');
    for (const d of EXPERIENCES) this.appEl.classList.remove(`mode-${d.id}`);
    this.mountExperience(def);
    this.active.resize();
  }

  private syncModeTabs(): void {
    for (const [id, btn] of this.modeTabs) btn.classList.toggle('active', id === this.activeId);
    const def = EXPERIENCES.find((d) => d.id === this.activeId);
    if (this.modeTrigger && def) this.modeTrigger.textContent = `☰  ${def.label}`;
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    this.pausedByVisibility = false;
    if (!p) {
      this.gateArmed = false;
      this.active.onResume?.();
    }
    // The gate shows only for a fresh (never-started) run; mid-run pauses just
    // freeze the scene.
    this.startGate.classList.toggle('hidden', !(this.paused && this.gateArmed));
  }

  private frame = (wallNow: number): void => {
    const wallDt = Math.min(MAX_FRAME_WALL_MS, wallNow - this.lastWall);
    this.lastWall = wallNow;
    if (!this.paused) {
      const simDt = Math.min(this.active.maxSimStepMs, wallDt * this.timeScale);
      this.active.step(simDt);
    }
    this.active.render();
    const clock = `${(this.active.simTimeMs() / 1000).toFixed(1)}s`;
    if (this.hudClock.textContent !== clock) this.hudClock.textContent = clock;
    if (wallNow - this.lastUrlSync > URL_SYNC_MS) {
      this.lastUrlSync = wallNow;
      this.syncUrl();
    }
    requestAnimationFrame(this.frame);
  };

  /** Flag the control strip when it holds more buttons than it can show. */
  private syncControlOverflow(): void {
    const host = this.hosts.header;
    const strip = host.firstElementChild;
    if (!strip) return;
    // Measured after layout settles, or a freshly mounted strip reads as empty.
    requestAnimationFrame(() => host.classList.toggle('scrolls', strip.scrollWidth > strip.clientWidth + 1));
  }

  /** Keep the address bar showing the live configuration, cheaply. */
  private syncUrl(): void {
    const state = this.active.deepLink?.() ?? { mode: this.activeId };
    const query = encode({ ...state, mode: this.activeId, run: !this.paused || undefined });
    if (query === this.lastQuery) return;
    this.lastQuery = query;
    writeUrl(query);
  }
}
