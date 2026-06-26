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
import type { Experience, ExperienceDef, ExperienceHosts, PlaybackController } from './experience';

/** Ignore wall-time gaps bigger than this (background tab, debugger). */
const MAX_FRAME_WALL_MS = 100;

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
];

export class Shell {
  private timeScale = 1;
  private paused = true;
  private gateArmed = true;
  private pausedByVisibility = false;
  private lastWall = 0;

  private active!: Experience;
  private activeId = '';
  private modeTabs = new Map<string, HTMLButtonElement>();

  private appEl = document.getElementById('app')!;
  private modeSwitchEl = document.getElementById('mode-switch')!;
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
    window.addEventListener('resize', () => this.active.resize());
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

    this.mountExperience(EXPERIENCES[0]);

    requestAnimationFrame((t) => {
      this.lastWall = t;
      this.active.resize();
      requestAnimationFrame(this.frame);
    });
  }

  private buildModeSwitch(): void {
    for (const def of EXPERIENCES) {
      const btn = document.createElement('button');
      btn.className = 'btn mode-tab';
      btn.textContent = def.label;
      btn.addEventListener('click', () => this.switchTo(def.id));
      this.modeTabs.set(def.id, btn);
      this.modeSwitchEl.appendChild(btn);
    }
  }

  private mountExperience(def: ExperienceDef): void {
    this.active = def.create();
    this.activeId = def.id;
    this.appEl.classList.add(`mode-${def.id}`);
    this.active.mount(this.hosts, this.playback);
    this.pausedByVisibility = false;
    this.gateArmed = true;
    this.setPaused(true);
    this.syncModeTabs();
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
    requestAnimationFrame(this.frame);
  };
}
