/**
 * The shell/experience seam.
 *
 * The app hosts two independent simulators — the connection storm and the DNS
 * load-distribution model, and the autoscaling ramp-up model — and switches
 * between them with the collapsed ☰ nav in the header.
 * Each is a self-contained `Experience` that builds its own stage + control DOM;
 * the single `Shell` (shell.ts) owns the one requestAnimationFrame loop, the
 * time-dilation clock, the pause/start-gate, and the mode switch, and drives
 * whichever experience is active.
 */

import type { LinkState } from './deeplink';

/** DOM containers the shell hands an experience on mount; cleared on unmount. */
export interface ExperienceHosts {
  /** #header-controls — the experience builds its header buttons here. */
  header: HTMLElement;
  /** #side — the control panel. */
  side: HTMLElement;
  /** #panes — the stage where canvases live. */
  stage: HTMLElement;
  /** .stage-col — for overlays the experience owns (e.g. compare help). */
  stageCol: HTMLElement;
  /** #hud-extra — mode-specific HUD chips (the #hud-clock is shell-owned). */
  hud: HTMLElement;
}

/** The playback facet the shell exposes to experiences. */
export interface PlaybackController {
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setTimeScale(scale: number): void;
  getTimeScale(): number;
  /** Re-show the start gate for a fresh run and pause. */
  rearmGate(): void;
  setStartHint(text: string): void;
}

/**
 * One simulator mode. The shell calls `step` only while running (with a sim-ms
 * delta already clamped to `maxSimStepMs`), then `render` every frame.
 */
export interface Experience {
  mount(hosts: ExperienceHosts, playback: PlaybackController): void;
  /** Advance the model by `simDtMs` virtual milliseconds. */
  step(simDtMs: number): void;
  /** Draw everything (renderer, charts, controls, HUD). */
  render(): void;
  /** Re-size all canvases (DPR-aware). */
  resize(): void;
  /** Current virtual sim time (ms) — drives the shared #hud-clock. */
  simTimeMs(): number;
  /** Max sim-ms this experience may advance in one frame (caps speed spikes). */
  readonly maxSimStepMs: number;
  /** Called when the run resumes from the start gate (optional). */
  onResume?(): void;
  /**
   * This mode's share of a deep link: scenario, comparison state, and every
   * setting that differs from the scenario it started from. Omit for a mode with
   * nothing to encode.
   */
  deepLink?(): LinkState;
  /** Restore from a deep link, before the first frame. */
  applyDeepLink?(params: URLSearchParams): void;
  /** Tear down all DOM, listeners, and dialogs the experience created. */
  unmount(): void;
}

/** A registerable experience: its tab label and a factory. */
export interface ExperienceDef {
  id: string;
  /** Mode-switch tab label. */
  label: string;
  /** Brand subtitle shown while this mode is active. */
  subtitle: string;
  create(): Experience;
}
