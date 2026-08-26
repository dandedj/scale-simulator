/**
 * Control panel for the Scaling sim: scenario presets, the SURGE and RAMP
 * triggers, live controls (demand ramp, capacity/buffer, the scaling policy, the
 * launch step sizes and bake, the 9 scale-up stages), run totals, and the event
 * ticker. Mirrors the DNS panel's structure and CSS.
 *
 * The Demand group is 'global' (shared across compare panes so offered load is
 * identical); the rest are 'sim' (edited per pane via the SIM A / SIM B tabs).
 */

import { compareSuccessRates } from '../../stats';
import { SCALING_PRESETS } from '../engine/presets';
import type { ScalingSimulation } from '../engine/scalingSimulation';
import type {
  ScalingAdjustmentType,
  ScalingPolicyType,
  ScalingSimulationConfig,
  ScalingTrafficShape,
  ScalingWarmupMode,
} from '../engine/types';
import { ScalingLegend } from './legend';
import { ScalingOverview } from './overview';

export const PANE_TAGS = ['A', 'B'] as const;
type KnobScope = 'global' | 'sim';

export interface ScalingControlHooks {
  getSims(): ScalingSimulation[];
  loadPreset(id: string): void;
  applyScenario(pane: number, id: string): void;
  reset(): void;
  surge(factor: number, durationMs: number): void;
  ramp(amountTps: number, durationMs: number): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setTimeScale(s: number): void;
  getTimeScale(): number;
  configChanged(kind: 'rate' | 'structure' | 'plain', target: number | 'all'): void;
  setCompare(on: boolean): void;
  isCompare(): boolean;
  showCompareHelp(): void;
  /** Open/close the annotated run timeline below the stage (single mode only). */
  setTimelineOpen(on: boolean): void;
  isTimelineOpen(): boolean;
}

interface SettingInfo {
  what: string;
  how: string;
  expect: string;
}
interface KnobDef {
  kind: 'knob';
  label: string;
  min: number;
  max: number;
  step: number;
  get(c: ScalingSimulationConfig): number;
  set(c: ScalingSimulationConfig, v: number): void;
  format?(v: number): string;
  /** Hide the row when it does not apply to the selected policy. */
  when?(c: ScalingSimulationConfig): boolean;
  /** Let the value be typed exactly, not just dragged to the nearest step. */
  entry?: EntryDef;
  info?: SettingInfo;
}

/**
 * A typed-in exact value. Sliders and quick-picks are for reaching a number
 * fast; this is for reaching a *specific* one — "offer exactly 1.75M TPS".
 */
interface EntryDef {
  /** Bounds the typed value is clamped into (wider than any quick-pick). */
  min: number;
  max: number;
  /** Text → value; null rejects the edit and restores the current value. */
  parse(text: string): number | null;
  /** Value → the text shown in the field. */
  format(v: number): string;
}
/** A segmented selector — a fixed set of choices rather than a continuous range. */
interface ChoiceDef {
  kind: 'choice';
  label: string;
  options: Array<{ value: string | number; label: string }>;
  get(c: ScalingSimulationConfig): string | number;
  set(c: ScalingSimulationConfig, v: string | number): void;
  when?(c: ScalingSimulationConfig): boolean;
  /** Present for numeric choices: quick-picks plus an exact typed value. */
  entry?: EntryDef;
  info?: SettingInfo;
}
type ControlDef = KnobDef | ChoiceDef;

const tps = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M/s` : v >= 1e3 ? `${Math.round(v / 1e3)}K/s` : `${Math.round(v)}/s`);
const secs = (v: number) => `${Math.round(v / 1000)}s`;
/**
 * Accepts what someone would actually type for a throughput: `1500000`,
 * `1,500,000`, `1.5M`, `750k`, `2 m`. Returns null on anything else so the
 * field can refuse the edit rather than silently reading it as zero.
 */
function parseTps(text: string): number | null {
  const m = /^\s*([\d,]*\.?\d+)\s*([kKmM])?\s*(?:\/\s*s|tps)?\s*$/.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const scale = m[2] ? (m[2].toLowerCase() === 'm' ? 1e6 : 1e3) : 1;
  return n * scale;
}

/** `90s`, `4m`, `1.5h`, or a bare number read as minutes. */
function parseDuration(text: string): number | null {
  const m = /^\s*(\d*\.?\d+)\s*(ms|s|m|h|min|hr)?\s*$/i.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? 'm').toLowerCase()) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'h':
    case 'hr':
      return n * 3_600_000;
    default:
      return n * 60_000;
  }
}

const TPS_ENTRY = (min: number, max: number): EntryDef => ({ min, max, parse: parseTps, format: tps });

/** Compact duration: 45s · 5m · 7.5m · 1h · 1.5h. */
const mins = (v: number) => {
  if (v < 60_000) return `${Math.round(v / 1000)}s`;
  const [n, unit] = v >= 3_600_000 ? [v / 3_600_000, 'h'] : [v / 60_000, 'm'];
  return `${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`;
};
const pct = (v: number) => `${Math.round(v * 100)}%`;

function stageKnob(label: string, key: keyof ScalingSimulationConfig['stages'], info: SettingInfo): KnobDef {
  return {
    kind: 'knob',
    label,
    min: 0,
    max: 300_000,
    step: 5_000,
    get: (c) => c.stages[key],
    set: (c, v) => (c.stages[key] = v),
    format: mins,
    info,
  };
}

/** One rung of the step-scaling ladder, as a knob over its adjustment. */
function stepKnob(index: number, label: string, info: SettingInfo): KnobDef {
  return {
    kind: 'knob',
    label,
    min: 0,
    max: 200,
    step: 5,
    get: (c) => c.policy.steps[index]?.adjustment ?? 0,
    set: (c, v) => {
      if (c.policy.steps[index]) c.policy.steps[index].adjustment = v;
    },
    format: (v) => String(Math.round(v)),
    when: (c) => c.policy.type === 'step',
    info,
  };
}

const RAMP_AMOUNTS = [250_000, 500_000, 1_000_000, 2_000_000, 3_000_000];
const RAMP_RATES = [60_000, 300_000, 600_000, 1_800_000, 3_600_000];

const GROUPS: Array<{ name: string; scope: KnobScope; open?: boolean; controls: ControlDef[] }> = [
  {
    name: 'Demand',
    scope: 'global',
    open: true,
    controls: [
      {
        kind: 'choice',
        label: 'Demand shape',
        options: [
          { value: 'steady', label: 'steady' },
          { value: 'ramp', label: 'ramp' },
          { value: 'step', label: 'step' },
        ],
        get: (c) => c.traffic.shape,
        set: (c, v) => (c.traffic.shape = v as ScalingTrafficShape),
        info: {
          what: 'How the ramp amount is delivered.',
          how: 'Steady holds the base rate. Ramp climbs base → base + amount over the ramp rate. Step jumps there all at once.',
          expect: 'Step is the worst case — the whole add arrives before anything can be launched. Ramp is the realistic one.',
        },
      },
      {
        kind: 'knob',
        label: 'Base rate', min: 20_000, max: 1_000_000, step: 10_000, get: (c) => c.traffic.baseRateTps, set: (c, v) => (c.traffic.baseRateTps = v), format: tps,
        entry: TPS_ENTRY(1_000, 20_000_000),
        info: {
          what: 'Steady demand and the floor of the ramp (TPS).',
          how: 'The fleet is pre-warmed to serve this at the target utilization, so the run starts calm. Type an exact figure into the value field — the slider is only a quick way to get near one.',
          expect: 'Sets the baseline the ramp climbs from.',
        },
      },
      {
        kind: 'choice',
        label: 'Ramp amount',
        options: RAMP_AMOUNTS.map((v) => ({ value: v, label: v >= 1e6 ? `+${v / 1e6}M` : `+${v / 1e3}K` })),
        get: (c) => c.traffic.rampAmountTps,
        set: (c, v) => (c.traffic.rampAmountTps = v as number),
        entry: TPS_ENTRY(1_000, 20_000_000),
        info: {
          what: 'How much demand the ramp adds on top of base (TPS).',
          how: 'The buttons are quick picks; type an exact figure into the value field for anything else (“1.75M”, “750k”, “1750000” all work). The scheduled shape climbs base → base + this; ▲ RAMP adds this much from wherever demand currently sits, and stacks. At 50K/instance a +1M add needs 20 more instances at 100% util, ≈33 at a 60% buffer — +3M needs ≈100.',
          expect: 'Larger adds need more scale-out steps, and every step costs a full pipeline + bake — so the recovery time grows faster than the amount does. Check the fleet ceiling covers the add, or the run can never fully recover.',
        },
      },
      {
        kind: 'choice',
        label: 'Ramp rate',
        // Spelled out: the segment CSS uppercases, and a bare "1M" next to the
        // ramp-amount row would read as a million rather than a minute.
        options: RAMP_RATES.map((v) => ({ value: v, label: v >= 3_600_000 ? '1hr' : `${v / 60_000}min` })),
        get: (c) => c.traffic.rampDurationMs,
        set: (c, v) => (c.traffic.rampDurationMs = v as number),
        entry: { min: 1_000, max: 14_400_000, parse: parseDuration, format: mins },
        info: {
          what: 'How long the ramp amount takes to arrive.',
          how: 'The buttons are quick picks; type an exact duration into the value field (“90s”, “45m”, “2h”). The offered ramp rate is amount ÷ this. Compare it against the max sustainable ramp in the readout (max step × capacity ÷ decision interval).',
          expect: 'Faster than the fleet can add capacity and availability dips until it catches up. Slow enough — an hour for +1M — and the scale-out keeps pace with no visible dip at all.',
        },
      },
      {
        kind: 'knob',
        label: 'Ramp start', min: 0, max: 120_000, step: 5_000, get: (c) => c.traffic.rampStartMs, set: (c, v) => (c.traffic.rampStartMs = v), format: secs,
        info: {
          what: 'How long demand holds at base before the ramp begins.',
          how: 'A short lead-in so the calm baseline is visible before the surge.',
          expect: 'Cosmetic — shifts when the ramp starts.',
        },
      },
    ],
  },
  {
    name: 'Capacity & buffer',
    scope: 'sim',
    open: true,
    controls: [
      {
        kind: 'knob',
        label: 'Capacity / instance', min: 5_000, max: 200_000, step: 5_000, get: (c) => c.capacity.capacityPerInstanceTps, set: (c, v) => (c.capacity.capacityPerInstanceTps = v), format: tps,
        entry: TPS_ENTRY(500, 1_000_000),
        info: {
          what: 'TPS one instance serves at 100%.',
          how: 'Reference: 50K on a c7g.2xlarge (100K on two). Fleet capacity = instances × this.',
          expect: 'Bigger instances mean fewer to launch for a given add — fewer steps, so fewer bakes to sit through.',
        },
      },
      {
        kind: 'knob',
        label: 'Target utilization (buffer)', min: 0.2, max: 0.95, step: 0.05, get: (c) => c.capacity.targetUtilization, set: (c, v) => (c.capacity.targetUtilization = v), format: pct,
        info: {
          what: 'The utilization the autoscaler holds — the buffer. ECS calls it targetCapacity (default 100%).',
          how: 'Steady-state util sits here; (1 − this) is headroom. Scale-out triggers when util exceeds it. AWS suggests 60–80% for workloads that burst.',
          expect: 'A lower target = more headroom that absorbs a ramp during the scaling lag (shallower dip) — at the cost of more idle instances.',
        },
      },
    ],
  },
  {
    name: 'Scaling policy',
    scope: 'sim',
    open: true,
    controls: [
      {
        kind: 'choice',
        label: 'Policy type',
        options: [
          { value: 'target-tracking', label: 'target' },
          { value: 'step', label: 'step' },
          { value: 'simple', label: 'simple' },
        ],
        get: (c) => c.policy.type,
        set: (c, v) => (c.policy.type = v as ScalingPolicyType),
        info: {
          what: 'Which AWS policy decides how much capacity to add.',
          how: 'Target tracking computes the capacity that would hold utilization at target and closes the gap. Step picks an adjustment from a ladder keyed on how far past target the metric is. Simple applies one fixed adjustment per alarm and then blocks for a cooldown.',
          expect: 'Target tracking lands on the right size and stops. Step reacts harder to a deep breach and can overshoot. Simple is the slowest — it can only act once per cooldown however far behind it is.',
        },
      },
      {
        kind: 'knob',
        label: 'Scale-out gain', min: 0.5, max: 2, step: 0.1, get: (c) => c.policy.scaleOutGain, set: (c, v) => (c.policy.scaleOutGain = v), format: (v) => `${v.toFixed(1)}×`,
        when: (c) => c.policy.type === 'target-tracking',
        info: {
          what: 'Multiplier on the capacity target tracking computes.',
          how: '1.0× is the AWS arithmetic — provision exactly what holds the metric at target. Above 1 deliberately over-provisions each step; below 1 walks up in fractions of the gap.',
          expect: 'Above 1 recovers sooner and leaves idle instances behind. Below 1 needs several bakes to close the same gap.',
        },
      },
      {
        kind: 'choice',
        label: 'Adjustment type',
        options: [
          { value: 'percent-change-in-capacity', label: '% of fleet' },
          { value: 'change-in-capacity', label: 'instances' },
        ],
        get: (c) => c.policy.adjustmentType,
        set: (c, v) => (c.policy.adjustmentType = v as ScalingAdjustmentType),
        when: (c) => c.policy.type !== 'target-tracking',
        info: {
          what: 'How a step or simple adjustment is read (the AWS AdjustmentType).',
          how: 'PercentChangeInCapacity scales the add with the fleet — 30% of 10 instances is 3, of 100 is 30. ChangeInCapacity adds a flat count whatever the fleet size.',
          expect: 'Percent keeps recovery time roughly constant as the fleet grows; a flat count gets relatively weaker the bigger the fleet, so large adds crawl.',
        },
      },
      stepKnob(0, 'Step 1 — over target', {
        what: 'The adjustment applied for a shallow breach — utilization just past target.',
        how: 'The first rung of the ladder, from the breach threshold up to the next bound.',
        expect: 'Keep it small: this rung fires on ordinary noise around the target.',
      }),
      stepKnob(1, 'Step 2 — 25% over', {
        what: 'The adjustment once utilization is 25% past target (e.g. 75% util against a 60% target).',
        how: 'The middle rung — a real but survivable breach.',
        expect: 'This is the rung most ramps sit on; it does most of the work.',
      }),
      stepKnob(2, 'Step 3 — 2× target', {
        what: 'The adjustment once utilization is double the target — the fleet is saturated and shedding.',
        how: 'The top rung. AWS only applies the difference between the fleet it scales from and what has already been requested, so a deep breach tops up rather than double-adding.',
        expect: 'The lever that turns a deep dip around fast — and the one that overshoots if it is set far above what the demand actually needs.',
      }),
      {
        kind: 'knob',
        label: 'Simple adjustment', min: 1, max: 100, step: 1, get: (c) => c.policy.simpleAdjustment, set: (c, v) => (c.policy.simpleAdjustment = v), format: (v) => String(Math.round(v)),
        when: (c) => c.policy.type === 'simple',
        info: {
          what: 'The single adjustment a simple-scaling policy applies per alarm.',
          how: 'Read as instances or a percent of the fleet, per the adjustment type. However deep the breach, this is all that gets added — then the cooldown blocks everything.',
          expect: 'Set too small against a big ramp and the fleet can never catch up: each cooldown buys one adjustment.',
        },
      },
    ],
  },
  {
    name: 'Launch step & bake',
    scope: 'sim',
    open: true,
    controls: [
      {
        kind: 'choice',
        label: 'Warmup rules',
        options: [
          { value: 'ecs', label: 'ECS' },
          { value: 'asg', label: 'ASG' },
        ],
        get: (c) => c.launch.warmupMode,
        set: (c, v) => (c.launch.warmupMode = v as ScalingWarmupMode),
        info: {
          what: 'Whose warmup semantics the bake follows. The two differ in what the bake gates and when its clock starts.',
          how: 'ECS cluster auto scaling blocks the next scale-out until every instance has passed its warmup, timed from the launch — “the scale-out is blocked for instances that are within the instanceWarmupPeriod”. EC2 Auto Scaling blocks nothing: a warming instance is left out of the aggregated metrics and out of the capacity the policy scales from, while still counting toward what has been requested, and its clock starts when it reaches InService.',
          expect: 'ECS gives fewer, larger steps — the fleet waits out the whole bake between them. ASG keeps deciding throughout, just from a fleet it is under-counting. And because the ECS clock runs from the launch, a bake shorter than the pipeline expires before the capacity it covers has even landed.',
        },
      },
      {
        kind: 'knob',
        label: 'Bake (instance warmup)', min: 0, max: 900_000, step: 30_000, get: (c) => c.launch.bakeMs, set: (c, v) => (c.launch.bakeMs = v), format: mins,
        entry: { min: 0, max: 3_600_000, parse: parseDuration, format: mins },
        info: {
          what: 'How long new capacity settles before the autoscaler counts it. ECS instanceWarmupPeriod / ASG DefaultInstanceWarmup — 300s is the documented default for both.',
          how: 'A baking instance is in service and carrying traffic, but the policy does not count it in the capacity it scales *from* — while still counting it in what it has already requested. So repeated breaches of the same size collapse into one scaling activity instead of launching the same capacity twice. Under ECS rules it also blocks the next step outright. See Warmup rules above.',
          expect: 'This, not the cooldown, is what paces a target-tracking or step policy. Its cost lands on a sustained ramp, not an instant jump: against a step change the policy sizes the whole gap before anything lands, so the bake never binds.',
        },
      },
      {
        kind: 'knob',
        label: 'Min step size', min: 1, max: 20, step: 1, get: (c) => c.launch.minStepSize, set: (c, v) => (c.launch.minStepSize = v), format: (v) => String(Math.round(v)),
        info: {
          what: 'Fewest instances a scale-out launches (ECS minimumScalingStepSize, default 1).',
          how: 'When the policy asks for less than this, it launches this many anyway.',
          expect: 'A floor under tiny adds — it stops a large fleet inching up one instance at a time.',
        },
      },
      {
        kind: 'knob',
        label: 'Max step size', min: 1, max: 120, step: 1, get: (c) => c.launch.maxStepSize, set: (c, v) => (c.launch.maxStepSize = v), format: (v) => String(Math.round(v)),
        info: {
          what: 'Most instances one scale-out launches (ECS maximumScalingStepSize, default 10000 — effectively no ceiling).',
          how: 'With the decision interval it sets the sustained add rate: max step × capacity ÷ (pipeline + bake). The readout shows the result as the max sustainable ramp.',
          expect: 'The throughput lever. Set below what the ramp needs and the fleet is capped at one step per bake — recovery takes as many bakes as it takes steps.',
        },
      },
      {
        kind: 'knob',
        label: 'Cooldown (simple)', min: 0, max: 900_000, step: 30_000, get: (c) => c.launch.cooldownMs, set: (c, v) => (c.launch.cooldownMs = v), format: mins,
        when: (c) => c.policy.type === 'simple',
        info: {
          what: 'The simple-scaling cooldown (AWS default 300s).',
          how: 'AWS accepts Cooldown only on a simple-scaling policy: it blocks every decision until it expires, however far behind the fleet has fallen. Target-tracking and step policies throttle themselves with the bake instead.',
          expect: 'Stacked on top of the pipeline and bake, a long cooldown is the slowest configuration in the model.',
        },
      },
      {
        kind: 'knob',
        label: 'Max instances', min: 1, max: 400, step: 1, get: (c) => c.launch.maxInstances, set: (c, v) => (c.launch.maxInstances = v), format: (v) => String(Math.round(v)),
        entry: { min: 1, max: 5_000, parse: parseTps, format: (v) => String(Math.round(v)) },
        info: {
          what: 'Ceiling on fleet size.',
          how: 'Scale-out stops here; the FLEET panel turns red at the ceiling. Peak demand ÷ (target util × capacity per instance) is what the run actually needs — a +3M add on the defaults wants ≈104.',
          expect: 'Below what the peak needs and availability can never fully recover.',
        },
      },
    ],
  },
  {
    name: 'Scale-up stages',
    scope: 'sim',
    controls: [
      stageKnob('Detection', 'detectionMs', {
        what: 'Metric emit + alarm before any launch.',
        how: 'ECS and EC2 publish these metrics once a minute, and the breach must hold for the configured datapoints-to-alarm before the policy acts.',
        expect: 'Often a big, overlooked chunk — nothing is even requested until it fires.',
      }),
      stageKnob('Signal → ECS', 'signalMs', {
        what: 'Accept the scaling signal and notify ECS.',
        how: 'Control-plane handoff before an instance is requested.',
        expect: 'Usually small.',
      }),
      stageKnob('Launch EC2', 'launchMs', {
        what: 'Request + start the EC2 instance.',
        how: 'Capacity request through to a running instance.',
        expect: 'Warm pools / pre-provisioned capacity shrink this sharply.',
      }),
      stageKnob('Cloud-init / user-data', 'cloudInitMs', {
        what: 'Run cloud-init and user-data on boot.',
        how: 'Per-instance bootstrap before the app can start.',
        expect: 'A baked AMI moves this work to build time — big win.',
      }),
      stageKnob('Task placement', 'placeMs', {
        what: 'ECS schedules the task onto the instance.',
        how: 'Scheduler placement latency.',
        expect: 'Usually small.',
      }),
      stageKnob('Task boot', 'bootMs', {
        what: 'Container / app process start.',
        how: 'Image pull + process init + warm-up before it can serve.',
        expect: 'Slow app/JVM starts dominate here; pre-pulled images help.',
      }),
      stageKnob('Health check', 'healthCheckMs', {
        what: 'Pass health checks before it is added.',
        how: 'Grace period + consecutive passes before it is considered ready.',
        expect: 'Stricter checks are safer but slower to admit new capacity.',
      }),
      stageKnob('DNS publish', 'dnsPublishMs', {
        what: 'Register the instance in DNS (advertised).',
        how: 'After this the instance is serving/ready, but clients haven’t resolved it yet.',
        expect: 'The record-set update lag before clients can even learn about it.',
      }),
      stageKnob('Client pickup', 'clientPickupMs', {
        what: 'Clients re-resolve and start using it.',
        how: 'DNS TTL / CoreDNS cache before traffic actually flows to the new IP. The bake clock starts once this passes and the instance is truly in service.',
        expect: 'Until this passes the instance is provisioned but idle — see the DNS tab for how this lag behaves.',
      }),
    ],
  },
];

type Totals = ScalingSimulation['metrics']['totals'];

const TOTAL_METRICS: Array<{ key: string; color: string; value(t: Totals): string }> = [
  { key: 'availability', color: 'var(--ok)', value: (t) => `${(t.offered > 0 ? (t.served / t.offered) * 100 : 100).toFixed(2)}%` },
  { key: 'lost req', color: 'var(--bad)', value: (t) => fmtBig(t.lost) },
  { key: 'served', color: 'var(--ok)', value: (t) => fmtBig(t.served) },
  { key: 'scale-outs', color: 'var(--info)', value: (t) => String(t.launches) },
  { key: 'instances +', color: 'var(--info)', value: (t) => String(t.instancesLaunched) },
  { key: 'peak fleet', color: 'var(--tls)', value: (t) => String(t.peakInstances) },
];

/** Overshoot reads off the readout, not the totals, so it gets its own accessor. */
const OVERSHOOT = { key: 'overshoot', color: 'var(--warn)' };

export class ScalingControlPanel {
  private refreshers: Array<() => void> = [];
  private logList!: HTMLElement;
  private totalsEl!: HTMLElement;
  private lastTotalsHtml = '';
  private renderedEvents: number[] = [];
  private surgeFactor = 2;
  private surgeDurationMs = 60_000;
  private pauseBtn!: HTMLButtonElement;
  private rampBtn!: HTMLButtonElement;
  private compareBtn!: HTMLButtonElement;
  private timelineBtn!: HTMLButtonElement;
  private paneTabBtns: HTMLButtonElement[] = [];
  private activePane = 0;
  private side: HTMLElement;
  private header: HTMLElement;
  private hooks: ScalingControlHooks;
  private legend!: ScalingLegend;
  private overview!: ScalingOverview;

  constructor(side: HTMLElement, header: HTMLElement, hooks: ScalingControlHooks) {
    this.side = side;
    this.header = header;
    this.hooks = hooks;
    this.buildHeaderControls();
    this.buildPresets();
    this.buildKnobs();
    this.buildTotals();
    this.buildEventLog();
  }

  destroy(): void {
    this.legend.destroy();
    this.overview.destroy();
  }

  private buildHeaderControls(): void {
    const wrap = el('div', 'time-controls');
    const surgeBtn = el('button', 'btn btn-pulse', '◉ SURGE ×2');
    surgeBtn.title = 'Step demand up by the factor for the set duration (on top of the shape)';
    surgeBtn.addEventListener('click', () => this.hooks.surge(this.surgeFactor, this.surgeDurationMs));
    wrap.appendChild(surgeBtn);
    const factor = this.miniSlider(1.2, 5, 0.1, this.surgeFactor, (v) => {
      this.surgeFactor = v;
      surgeBtn.textContent = `◉ SURGE ×${v.toFixed(1)}`;
    });
    factor.title = 'Surge intensity';
    wrap.appendChild(factor);

    this.rampBtn = el('button', 'btn', '▲ RAMP') as HTMLButtonElement;
    this.rampBtn.title = 'Add the configured ramp amount, at the configured ramp rate, on top of demand right now (Demand group). Ramps stack and persist until reset.';
    this.rampBtn.addEventListener('click', () => {
      const t = this.cfgFor('global').traffic;
      this.hooks.ramp(t.rampAmountTps, t.rampDurationMs);
    });
    wrap.appendChild(this.rampBtn);

    this.pauseBtn = el('button', 'btn', '▶') as HTMLButtonElement;
    this.pauseBtn.title = 'Pause / resume (space)';
    this.pauseBtn.addEventListener('click', () => this.hooks.setPaused(!this.hooks.isPaused()));
    wrap.appendChild(this.pauseBtn);

    const speedWrap = el('div', 'speed-wrap');
    const speedLabel = el('span', 'speed-label');
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0';
    speed.max = '1';
    speed.step = '0.005';
    const toScale = (t: number) => Math.pow(10, lerp(Math.log10(1), Math.log10(600), t));
    const fromScale = (s: number) => (Math.log10(s) - Math.log10(1)) / (Math.log10(600) - Math.log10(1));
    const syncSpeed = () => {
      const s = this.hooks.getTimeScale();
      speedLabel.textContent = s >= 1 ? `${Math.round(s)}× speed` : `${(1 / s).toFixed(0)}× slower`;
    };
    speed.value = String(fromScale(Math.min(600, Math.max(1, this.hooks.getTimeScale()))));
    speed.addEventListener('input', () => {
      this.hooks.setTimeScale(toScale(parseFloat(speed.value)));
      syncSpeed();
    });
    syncSpeed();
    speedWrap.append(speed, speedLabel);
    wrap.appendChild(speedWrap);

    const resetBtn = el('button', 'btn', '↺ RESET');
    resetBtn.title = 'Restart with the current settings';
    resetBtn.addEventListener('click', () => this.hooks.reset());
    wrap.appendChild(resetBtn);

    this.compareBtn = el('button', 'btn', '⇆ COMPARE') as HTMLButtonElement;
    this.compareBtn.title = 'Run two configs side by side under the same demand';
    this.compareBtn.addEventListener('click', () => this.hooks.setCompare(!this.hooks.isCompare()));
    wrap.appendChild(this.compareBtn);

    // Single mode only: two panes on one shared axis would misrepresent both.
    this.timelineBtn = el('button', 'btn single-only', '⧗ TIMELINE') as HTMLButtonElement;
    this.timelineBtn.title = 'Open an annotated timeline of the run — when demand was offered, and what the fleet did about it';
    this.timelineBtn.addEventListener('click', () => this.hooks.setTimelineOpen(!this.hooks.isTimelineOpen()));
    wrap.appendChild(this.timelineBtn);

    this.overview = new ScalingOverview(wrap, () => this.cfgFor('sim'));
    this.legend = new ScalingLegend(wrap);
    this.header.appendChild(wrap);
  }

  private miniSlider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'mini';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => onInput(parseFloat(input.value)));
    return input;
  }

  private buildPresets(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Scenarios'));
    const grid = el('div', 'preset-grid single-only');
    for (const preset of SCALING_PRESETS) {
      const card = el('button', 'preset-card');
      card.dataset.preset = preset.id;
      card.appendChild(el('div', 'preset-name', preset.name));
      card.appendChild(el('div', 'preset-desc', preset.description));
      card.addEventListener('click', () => {
        this.hooks.loadPreset(preset.id);
        this.setActivePreset(preset.id);
        this.refreshKnobs();
      });
      grid.appendChild(card);
    }
    section.appendChild(grid);

    const cmp = el('div', 'compare-only');
    PANE_TAGS.forEach((tag, pane) => {
      const row = el('div', 'scenario-row');
      row.appendChild(el('span', `scenario-tag tag-${tag.toLowerCase()}`, `SIM ${tag}`));
      const btns = el('div', 'scenario-btns');
      for (const preset of SCALING_PRESETS) {
        const b = el('button', 'preset-mini', preset.name);
        b.dataset.preset = preset.id;
        b.dataset.pane = String(pane);
        b.title = preset.description;
        b.addEventListener('click', () => {
          this.hooks.applyScenario(pane, preset.id);
          this.setActiveScenario(pane, preset.id);
        });
        btns.appendChild(b);
      }
      row.appendChild(btns);
      cmp.appendChild(row);
    });
    cmp.appendChild(el('div', 'scenario-note', 'A scenario sets that sim’s capacity, stages & launch tuning; the demand ramp applies to both sims.'));
    const helpBtn = el('button', 'btn btn-small', 'ⓘ INSTRUCTIONS');
    helpBtn.addEventListener('click', () => this.hooks.showCompareHelp());
    cmp.appendChild(helpBtn);
    section.appendChild(cmp);
    this.side.appendChild(section);
    this.setActivePreset(SCALING_PRESETS[0].id);
  }

  setActivePreset(id: string | null): void {
    this.side.querySelectorAll<HTMLElement>('.preset-card').forEach((c) => c.classList.toggle('active', c.dataset.preset === id));
  }
  private setActiveScenario(pane: number, id: string | null): void {
    this.side.querySelectorAll<HTMLElement>(`.preset-mini[data-pane='${pane}']`).forEach((b) => b.classList.toggle('active', b.dataset.preset === id));
  }

  private cfgFor(scope: KnobScope): ScalingSimulationConfig {
    const sims = this.hooks.getSims();
    const idx = scope === 'sim' ? Math.min(this.activePane, sims.length - 1) : 0;
    return sims[idx].cfg;
  }

  private buildKnobs(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Tuning'));
    for (const group of GROUPS) {
      if (group.scope === 'sim' && this.paneTabBtns.length === 0) section.appendChild(this.buildPaneTabs());
      const details = document.createElement('details');
      details.className = 'knob-group';
      details.open = group.open === true;
      const summary = document.createElement('summary');
      summary.textContent = group.name;
      details.appendChild(summary);
      for (const control of group.controls) {
        details.appendChild(control.kind === 'knob' ? this.buildKnobRow(group.scope, control) : this.buildChoiceRow(group.scope, control));
      }
      section.appendChild(details);
    }
    this.side.appendChild(section);
  }

  private buildKnobRow(scope: KnobScope, knob: KnobDef): HTMLElement {
    const row = el('div', 'knob-row');
    const fmt = knob.format ?? ((v: number) => String(Math.round(v * 100) / 100));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(knob.min);
    input.max = String(knob.max);
    input.step = String(knob.step);
    const read = () => knob.get(this.cfgFor(scope));
    const write = (v: number) => this.applyControl(scope, (c, x) => knob.set(c, x as number), v);
    const value = this.valueField(knob.entry, fmt, read, write);
    const sync = () => {
      const cfg = this.cfgFor(scope);
      row.classList.toggle('hidden', knob.when ? !knob.when(cfg) : false);
      const v = knob.get(cfg);
      // A typed value can sit outside the slider's range; pin the thumb to the end.
      input.value = String(Math.min(knob.max, Math.max(knob.min, v)));
      value.set(v);
    };
    input.addEventListener('input', () => {
      write(parseFloat(input.value));
      value.set(knob.get(this.cfgFor(scope)));
    });
    this.refreshers.push(sync);
    row.append(this.rowTop(knob.label, value.el, knob.info, row), input);
    sync();
    return row;
  }

  private buildChoiceRow(scope: KnobScope, choice: ChoiceDef): HTMLElement {
    const row = el('div', 'knob-row');
    const seg = el('div', 'shape-seg');
    const btns: HTMLButtonElement[] = [];
    const read = () => Number(choice.get(this.cfgFor(scope)));
    const write = (v: number) => this.applyControl(scope, (c, x) => choice.set(c, x), v);
    const value = choice.entry ? this.valueField(choice.entry, choice.entry.format, read, write) : null;
    const sync = () => {
      const cfg = this.cfgFor(scope);
      row.classList.toggle('hidden', choice.when ? !choice.when(cfg) : false);
      const cur = choice.get(cfg);
      // A typed value that matches no quick-pick simply leaves them all inactive.
      btns.forEach((b) => b.classList.toggle('active', b.dataset.value === String(cur)));
      value?.set(Number(cur));
    };
    for (const opt of choice.options) {
      const b = el('button', 'shape-btn', opt.label) as HTMLButtonElement;
      b.dataset.value = String(opt.value);
      b.addEventListener('click', () => {
        this.applyControl(scope, (c, v) => choice.set(c, v), opt.value);
        // A policy change shows or hides the rows that belong to it.
        this.refreshKnobs();
      });
      btns.push(b);
      seg.appendChild(b);
    }
    this.refreshers.push(sync);
    row.append(this.rowTop(choice.label, value?.el ?? null, choice.info, row), seg);
    sync();
    return row;
  }

  /**
   * The row's value readout. Without an `entry` it is static text; with one it
   * is a field you can type an exact value into — committed on Enter or blur,
   * reverted on Escape or on anything that doesn't parse.
   */
  private valueField(
    entry: EntryDef | undefined,
    fmt: (v: number) => string,
    read: () => number,
    write: (v: number) => void,
  ): { el: HTMLElement; set(v: number): void } {
    if (!entry) {
      const node = el('div', 'knob-value');
      return { el: node, set: (v) => (node.textContent = fmt(v)) };
    }
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'knob-value knob-entry';
    field.spellcheck = false;
    field.title = 'Type an exact value';
    let editing = false;
    const commit = () => {
      const parsed = entry.parse(field.value);
      if (parsed !== null) write(Math.min(entry.max, Math.max(entry.min, parsed)));
      editing = false;
      field.value = fmt(read());
      this.refreshKnobs();
    };
    field.addEventListener('focus', () => {
      editing = true;
      field.select();
    });
    field.addEventListener('blur', commit);
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') field.blur();
      else if (e.key === 'Escape') {
        editing = false;
        field.value = fmt(read());
        field.blur();
      }
      e.stopPropagation(); // the shell binds space to pause
    });
    // While the field has focus the user's own text wins over the live value.
    return { el: field, set: (v) => !editing && (field.value = fmt(v)) };
  }

  /** Label + optional live value + the ⓘ disclosure, shared by both row kinds. */
  private rowTop(label: string, valueEl: HTMLElement | null, info: SettingInfo | undefined, row: HTMLElement): HTMLElement {
    const top = el('div', 'knob-top');
    top.appendChild(el('div', 'knob-label', label));
    const meta = el('div', 'knob-meta');
    if (valueEl) meta.appendChild(valueEl);
    const built = info ? this.buildInfo(info) : null;
    if (built) {
      meta.appendChild(built.btn);
      row.appendChild(built.panel);
    }
    top.appendChild(meta);
    return top;
  }

  private buildInfo(info: SettingInfo): { btn: HTMLButtonElement; panel: HTMLElement } {
    const btn = el('button', 'info-btn', 'ⓘ') as HTMLButtonElement;
    btn.type = 'button';
    const panel = el('div', 'setting-info');
    for (const [tag, text] of [['What', info.what], ['How', info.how], ['Expect', info.expect]] as const) {
      const p = el('p', '');
      p.appendChild(el('b', '', tag));
      p.appendChild(document.createTextNode(` ${text}`));
      panel.appendChild(p);
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = panel.classList.toggle('open');
      btn.classList.toggle('active', open);
    });
    return { btn, panel };
  }

  private buildPaneTabs(): HTMLElement {
    const tabs = el('div', 'pane-tabs compare-only');
    tabs.appendChild(el('span', 'pane-tabs-label', 'These knobs edit'));
    PANE_TAGS.forEach((tag, i) => {
      const b = el('button', `pane-tab tag-${tag.toLowerCase()}`, `SIM ${tag}`) as HTMLButtonElement;
      b.addEventListener('click', () => {
        this.activePane = i;
        this.syncPaneTabs();
        this.refreshKnobs();
      });
      this.paneTabBtns.push(b);
      tabs.appendChild(b);
    });
    this.syncPaneTabs();
    return tabs;
  }
  private syncPaneTabs(): void {
    this.paneTabBtns.forEach((b, i) => b.classList.toggle('active', i === this.activePane));
  }

  private applyControl(scope: KnobScope, set: (c: ScalingSimulationConfig, v: string | number) => void, v: string | number): void {
    const sims = this.hooks.getSims();
    if (scope === 'global') {
      for (const sim of sims) set(sim.cfg, v);
      this.hooks.configChanged('rate', 'all');
    } else {
      const idx = Math.min(this.activePane, sims.length - 1);
      set(sims[idx].cfg, v);
      this.hooks.configChanged('plain', idx);
    }
    this.markCustom(scope);
  }

  private markCustom(scope: KnobScope): void {
    if (!this.hooks.isCompare()) {
      this.setActivePreset(null);
      return;
    }
    if (scope === 'global') {
      this.setActiveScenario(0, null);
      this.setActiveScenario(1, null);
    } else {
      this.setActiveScenario(this.activePane, null);
    }
  }

  refreshKnobs(): void {
    for (const r of this.refreshers) r();
  }

  setTimelineUI(on: boolean): void {
    this.timelineBtn.classList.toggle('active', on);
  }

  setCompareUI(on: boolean): void {
    this.compareBtn.classList.toggle('active', on);
    this.activePane = 0;
    this.syncPaneTabs();
    this.setActiveScenario(0, null);
    this.setActiveScenario(1, null);
    if (!on) this.setActivePreset(null);
    this.lastTotalsHtml = '';
    this.refreshKnobs();
  }

  private buildTotals(): void {
    const section = el('div', 'panel-section');
    section.appendChild(el('h2', 'panel-title', 'Run totals'));
    this.totalsEl = el('div', 'totals-grid');
    section.appendChild(this.totalsEl);
    this.side.appendChild(section);
  }

  private buildEventLog(): void {
    const section = el('div', 'panel-section eventlog-section');
    section.appendChild(el('h2', 'panel-title', 'Events'));
    this.logList = el('div', 'eventlog');
    section.appendChild(this.logList);
    this.side.appendChild(section);
  }

  update(): void {
    const glyph = this.hooks.isPaused() ? '▶' : '⏸';
    if (this.pauseBtn.textContent !== glyph) {
      this.pauseBtn.textContent = glyph;
      this.pauseBtn.classList.toggle('active', this.hooks.isPaused());
    }
    const t = this.cfgFor('global').traffic;
    const amt = t.rampAmountTps >= 1e6 ? `${t.rampAmountTps / 1e6}M` : `${Math.round(t.rampAmountTps / 1e3)}K`;
    const rampLabel = `▲ RAMP +${amt}/${mins(t.rampDurationMs)}`;
    if (this.rampBtn.textContent !== rampLabel) this.rampBtn.textContent = rampLabel;
    const sims = this.hooks.getSims();
    const compare = sims.length > 1;
    const html = compare ? totalsHtmlCompare(sims) : totalsHtmlSingle(sims[0]);
    if (this.lastTotalsHtml !== html) {
      this.lastTotalsHtml = html;
      this.totalsEl.className = compare ? 'totals-cmp' : 'totals-grid';
      this.totalsEl.innerHTML = html;
    }
    sims.forEach((sim, pane) => {
      const { events, totalLogged } = sim.metrics;
      const seen = this.renderedEvents[pane] ?? 0;
      if (totalLogged < seen) this.renderedEvents[pane] = 0;
      const unseen = Math.min(totalLogged - (this.renderedEvents[pane] ?? 0), events.length);
      for (let i = events.length - unseen; i < events.length; i++) {
        const ev = events[i];
        const row = el('div', `event event-${ev.severity}`);
        if (compare) row.appendChild(el('span', `event-tag tag-${PANE_TAGS[pane].toLowerCase()}`, PANE_TAGS[pane]));
        row.appendChild(el('span', 'event-time', `${(ev.time / 1000).toFixed(0)}s`));
        row.appendChild(el('span', 'event-msg', ev.message));
        this.logList.prepend(row);
        while (this.logList.children.length > 60) this.logList.lastChild?.remove();
      }
      this.renderedEvents[pane] = totalLogged;
    });
  }

  resetLog(): void {
    this.renderedEvents = [];
    this.logList.innerHTML = '';
  }
}

function totalsHtmlSingle(sim: ScalingSimulation): string {
  const t = sim.metrics.totals;
  const cells = TOTAL_METRICS.map((m) => `<div class="total"><span style="color:${m.color}">${m.value(t)}</span><label>${m.key}</label></div>`);
  cells.push(
    `<div class="total"><span style="color:${OVERSHOOT.color}">${sim.scaleReadout().overshootInstances}</span><label>${OVERSHOOT.key}</label></div>`,
  );
  return cells.join('');
}

function totalsHtmlCompare(sims: ScalingSimulation[]): string {
  const head =
    `<div class="cmp-row cmp-head"><label></label>` +
    sims.map((_, i) => `<span class="tag-${PANE_TAGS[i].toLowerCase()}">SIM ${PANE_TAGS[i]}</span>`).join('') +
    `</div>`;
  const rows = TOTAL_METRICS.map((m) => {
    const cells = sims.map((s) => `<span style="color:${m.color}">${m.value(s.metrics.totals)}</span>`).join('');
    return `<div class="cmp-row"><label>${m.key}</label>${cells}</div>`;
  }).join('');
  const overshoot =
    `<div class="cmp-row"><label>${OVERSHOOT.key}</label>` +
    sims.map((s) => `<span style="color:${OVERSHOOT.color}">${s.scaleReadout().overshootInstances}</span>`).join('') +
    `</div>`;
  return head + rows + overshoot + significanceHtml(sims);
}

function significanceHtml(sims: ScalingSimulation[]): string {
  if (sims.length < 2) return '';
  const a = sims[0].metrics.totals;
  const b = sims[1].metrics.totals;
  const g = compareSuccessRates(Math.round(a.offered), Math.round(a.served), Math.round(b.offered), Math.round(b.served));
  let cls: string;
  let verdict: string;
  if (!g.enough) {
    cls = 'sig-wait';
    verdict = 'gathering data…';
  } else if (g.confidence >= 0.95) {
    cls = 'sig-strong';
    verdict = `significant (${Math.round(g.confidence * 100)}%)${g.better ? ` · SIM ${g.better} better` : ''}`;
  } else if (g.confidence > 0) {
    cls = 'sig-some';
    verdict = `weak (90%)${g.better ? ` · SIM ${g.better} better` : ''}`;
  } else {
    cls = 'sig-none';
    verdict = 'not significant';
  }
  const stats = g.enough ? `z=${g.z.toFixed(2)} · p=${g.pValue < 0.001 ? '<0.001' : g.pValue.toFixed(3)}` : `n=${Math.round(a.offered)}/${Math.round(b.offered)}`;
  return (
    `<div class="cmp-sig ${cls}"><div class="cmp-sig-head"><label>Δ availability (B−A)</label>` +
    `<b>${g.deltaPp >= 0 ? '+' : '−'}${Math.abs(g.deltaPp).toFixed(2)}pp</b></div>` +
    `<div class="cmp-sig-verdict">${verdict}</div><div class="cmp-sig-stats">${stats}</div></div>` +
    `<div class="cmp-sig-note">availability = served ÷ offered; directional (correlated failures inflate confidence)</div>`
  );
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function fmtBig(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
