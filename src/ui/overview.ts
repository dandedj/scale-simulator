/**
 * System overview: a modal that lays out the RTB Fabric end to end — the
 * ordered gates a new connection passes through, the request lifecycle on a
 * warm connection, the shared-CPU coupling that drives the storm, the full
 * shed/drop/fail taxonomy, and the explicit modeling assumptions.
 *
 * Every gate is written against the engine (simulation.ts) in the same order
 * the engine applies it, and the value chips read the live config, so the
 * dialog doubles as a spec to validate the model against the real fabric.
 */

import type { SimulationConfig } from '../engine/types';

type OutcomeKind = 'rst' | 'drop' | 'emfile' | 'wait' | 'pass';

interface Gate {
  /** Stage label, e.g. the order index within the fabric. */
  n?: string;
  title: string;
  /** Live config readout (e.g. the limit's current value). */
  value?: (c: SimulationConfig) => string;
  /** On/off chip for opt-in mechanisms (null = always-on core mechanism). */
  enabled?: (c: SimulationConfig) => boolean;
  how: string;
  outcome?: { kind: OutcomeKind; text: string };
}

interface Lane {
  key: string;
  title: string;
  blurb?: string;
  gates: Gate[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The connection + request pipeline, top to bottom, in engine order. */
const LANES: Lane[] = [
  {
    key: 'net',
    title: 'Client → fabric',
    blurb:
      'A request with no warm pooled connection makes the client open one (up to its pool size), then a SYN crosses the network (½ RTT). Under load this rebuild happens inside the client’s single deadline — handshake included.',
    gates: [],
  },
  {
    key: 'kernel',
    title: 'Kernel ingress',
    blurb: 'The OS layer beneath the application, reached before the fabric calls accept().',
    gates: [
      {
        n: '1',
        title: 'TCP accept queue (somaxconn)',
        value: (c) => `depth ${c.fabric.acceptQueueDepth}`,
        enabled: (c) => c.fabric.acceptQueueEnabled,
        how: 'Completed TCP 3-way handshakes wait here for the fabric to call accept() — the kernel backlog ahead of, and separate from, the TLS permit wait. The accept loop drains at ~1000/s ÷ the CPU slowdown, so a saturated fabric (workers in TLS crypto) backs it up.',
        outcome: { kind: 'drop', text: 'queue full → drop·acceptq — silent drop (client SYN-retransmits, ~1s) or RST with tcp_abort_on_overflow' },
      },
      {
        n: '2',
        title: 'File-descriptor ceiling (RLIMIT_NOFILE)',
        value: (c) => `${c.fabric.maxFileDescriptors} fds`,
        enabled: (c) => c.fabric.fdLimitEnabled,
        how: 'accept() — and each outbound connect() — spends one descriptor from a single shared budget (client-facing connections + the downstream pool).',
        outcome: { kind: 'emfile', text: 'at the ceiling → EMFILE — the connection can’t be taken and withers on the client deadline (no clean RST)' },
      },
    ],
  },
  {
    key: 'admit',
    title: 'Fabric admission (before TLS)',
    gates: [
      {
        n: '3',
        title: 'Accept-rate limiter (token bucket)',
        value: (c) => `${c.fabric.connRateLimitPerSec}/s · burst ${c.fabric.connRateBurst}`,
        enabled: (c) => c.fabric.connRateShedEnabled,
        how: 'A per-server, in-memory token bucket at TCP accept; each accepted connection spends a token. The first and cheapest admission check — it caps the rate of new connections, throttling handshake demand at the source.',
        outcome: { kind: 'rst', text: 'bucket empty → RST shed·rate, before the connection limit and any TLS work' },
      },
      {
        n: '4',
        title: 'Connection limit',
        value: (c) => `${c.fabric.maxConnections} max`,
        how: 'Hard cap on concurrent client-facing connections — a cap on the count, not the rate.',
        outcome: { kind: 'rst', text: 'at the cap → RST shed·conn, before any TLS work' },
      },
      {
        n: '5',
        title: 'Accept-site lock (optional)',
        value: (c) => lockSummary(c, 'accept'),
        enabled: (c) => c.fabric.locks.some((l) => l.site === 'accept' && l.enabled),
        how: 'If modeled, the shared max-conns counter (e.g. Arc<Mutex<usize>>) is taken on every accept — a single-server FIFO that adds wait, not CPU.',
        outcome: { kind: 'wait', text: 'contention adds latency (no rejection); past 1 ÷ hold-time acquisitions/s the wait grows without bound' },
      },
    ],
  },
  {
    key: 'tls',
    title: 'TLS handshake',
    gates: [
      {
        n: '6',
        title: 'TLS permits + permit wait',
        value: (c) => `${c.fabric.tlsHandshakeConcurrency} permits · wait ${c.fabric.tlsPermitWaitMs}ms`,
        how: 'At most N handshakes run concurrently. There is no TLS queue — a connection without a permit waits up to the permit wait for one to free. TLS error pacing, when on, holds the shed RST for the pacing delay so shed clients don’t reconnect in lockstep.',
        outcome: { kind: 'rst', text: 'no permit before the wait expires → RST shed·tls' },
      },
      {
        n: '7',
        title: 'Handshake — fabric CPU + wire',
        value: (c) => `${c.fabric.tlsHandshakeCpuMs}ms / ${c.fabric.tlsCpuCost}u · resume ${pct(c.fabric.tlsResumptionRate)} @ ${pct(c.fabric.tlsResumptionCostFactor)}`,
        how: 'The crypto loads the shared CPU at ~25× a proxied request (resumed = the cost factor × a full handshake). The wire part — 2×RTT hellos (1× resumed) plus any client TLS delay — holds the permit but burns no fabric CPU. A handshake-site lock (session cache) can be modeled. This is the storm amplifier: a flood of handshakes melts the CPU.',
        outcome: { kind: 'pass', text: 'on completion → an established, idle pooled connection' },
      },
    ],
  },
  {
    key: 'req',
    title: 'Established connection → request',
    blurb:
      'A warm connection carries one in-flight request at a time (HTTP/1.1) and is reused across retries. A pooled request travels to the fabric (½ RTT) and is served:',
    gates: [
      {
        n: '8',
        title: 'Request-site lock (optional)',
        value: (c) => lockSummary(c, 'request'),
        enabled: (c) => c.fabric.locks.some((l) => l.site === 'request' && l.enabled),
        how: 'A shared router/state lock taken on every request, if modeled — wait added to request latency, no CPU. Scaled to the representative per-server QPS.',
        outcome: { kind: 'wait', text: 'serialization wall: a 2µs lock tops out near 500k/s no matter the core count' },
      },
      {
        n: '9',
        title: 'Fabric processing',
        value: (c) => `${c.fabric.processingMs}ms / ${c.fabric.requestCpuCost}u · CPU ${(c.fabric.cpuCapacity / 1000).toFixed(1)}ku/s`,
        how: 'Each request demands its CPU cost (work-units) over its processing time on the shared CPU, stretched by the slowdown factor under contention.',
        outcome: { kind: 'pass', text: 'then routed to a downstream' },
      },
      {
        n: '10',
        title: 'Route to a downstream (random IP)',
        value: (c) => `${c.downstreams.count} downstreams · pool ${c.downstreamPool.poolSizePerDownstream} · timeout ${c.downstreamPool.requestTimeoutMs}ms`,
        how: 'Random IP selection across all downstreams — the fabric does not circuit-break or eject them. Uses an idle pooled connection or opens one (connect time), else the request waits in that downstream’s time-bounded queue.',
        outcome: { kind: 'rst', text: 'queue wait + call past the downstream timeout → error returned + the outbound connection is poisoned' },
      },
      {
        n: '11',
        title: 'Downstream service',
        value: (c) => `${c.downstreams.responseTimeMedianMs}ms p50 · err ${pct(c.downstreams.errorRate)} · cap ${c.downstreams.concurrencyCapacity}`,
        how: 'Log-normal service time (median + tail); past the concurrency cap the downstream’s own latency inflates. An error returns to the client (distinct from a timeout — it does not poison the connection).',
        outcome: { kind: 'pass', text: 'response travels back to the client (½ RTT)' },
      },
    ],
  },
];

/** The single client deadline wraps the whole attempt — the storm trigger. */
const DEADLINE = {
  title: 'Client deadline (single, per attempt)',
  body: 'One deadline traps everything above — the wait for a connection (including a hot-path rebuild and its handshake) and the request itself. Expire while still waiting for a connection → rejected (poisons nothing). Expire on a connection → timeout, which tears down (poisons) that connection. Under scarcity clients dispatch the freshest waiting request first (adaptive LIFO). This is the loop the whole storm turns on: timeout → teardown → re-handshake → CPU contention → more timeouts.',
};

/** Cross-cutting: the processor-sharing model that couples everything. */
const CPU_ENGINE = {
  title: 'Shared CPU — the storm engine',
  body: 'Requests and handshakes draw on one CPU budget. Demand = Σ of every in-flight operation’s work-rate; when demand exceeds capacity, every operation slows proportionally (utilization >1 → ×slowdown on all service times). Because a handshake costs ~25× a proxied request, a burst of reconnects saturates the CPU and stretches everything at once — turning connection churn into system-wide latency, which feeds more timeouts. Locks are the one exception: they serialize (add wait) without consuming CPU, so a lock can be the wall while the CPU sits idle.',
};

interface FailRow {
  tag: string;
  cls: string;
  level: string;
  cause: string;
}

const FAILURES: FailRow[] = [
  { tag: 'shed·tls', cls: 'ov-rst', level: 'connection', cause: 'TLS permits stayed occupied past the permit wait → RST.' },
  { tag: 'shed·conn', cls: 'ov-rst', level: 'connection', cause: 'Connection limit exceeded → RST, before any TLS work.' },
  { tag: 'shed·rate', cls: 'ov-rst', level: 'connection', cause: 'Accept-rate token bucket empty → RST at TCP accept (opt-in).' },
  { tag: 'drop·acceptq', cls: 'ov-drop', level: 'connection', cause: 'Kernel accept queue overflowed → silent drop (SYN retransmit) or RST (opt-in).' },
  { tag: 'emfile', cls: 'ov-emfile', level: 'connection', cause: 'File-descriptor ceiling hit → accept()/connect() fails; connection withers (opt-in).' },
  { tag: 'timeout', cls: 'ov-timeout', level: 'request', cause: 'Client deadline expired on a connection → the connection is poisoned (torn down).' },
  { tag: 'error', cls: 'ov-error', level: 'request', cause: 'Downstream error, or fabric→downstream timeout, returned to the client.' },
  { tag: 'rejected', cls: 'ov-reject', level: 'request', cause: 'Client-side: no connection in time, or the client’s own circuit breaker is open.' },
];

/** Explicit modeling decisions — the checklist to validate against the real fabric. */
const ASSUMPTIONS: string[] = [
  'One client deadline per attempt traps both the connection build (handshake included) and the request; a timeout poisons (tears down) the connection (HTTP/1.1).',
  'No application TLS queue — only the bounded permit wait, then an RST. The kernel accept queue is a separate, earlier layer.',
  'No request-level admission control and no fixed downstream-queue size — the downstream queue is bounded only by time (the downstream timeout).',
  'The fabric does not circuit-break or eject downstreams: routing is random IP across all of them; a slow or erroring bidder keeps its share, bounded only by the per-call timeout. The client→fabric breaker is real and optional.',
  'A connection carries one in-flight request at a time and is reused across retries; pools are pre-warmed at start (a cold start is its own storm, excluded from the presets).',
  'Locks model serialization orthogonal to CPU (wait, not compute), scaled to a representative per-server QPS so a µs-scale lock is visible at demo rates.',
];

function lockSummary(c: SimulationConfig, site: 'accept' | 'request' | 'handshake'): string {
  const on = c.fabric.locks.filter((l) => l.site === site && l.enabled);
  if (on.length === 0) return 'none enabled';
  return on.map((l) => `${l.holdTimeUs}µs`).join(', ');
}

const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  rst: 'RST',
  drop: 'DROP',
  emfile: 'EMFILE',
  wait: 'WAIT',
  pass: 'PASS',
};

export class SystemOverview {
  private dialog: HTMLDialogElement;
  private body: HTMLElement;
  private getCfg: () => SimulationConfig;
  private btn!: HTMLButtonElement;

  constructor(header: HTMLElement, getCfg: () => SimulationConfig) {
    this.getCfg = getCfg;

    this.dialog = document.createElement('dialog');
    this.dialog.id = 'overview-dialog';

    const head = document.createElement('div');
    head.className = 'legend-header';
    head.innerHTML = '<h2>System Overview</h2>';
    const close = document.createElement('button');
    close.className = 'btn legend-close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.dialog.close());
    head.appendChild(close);
    this.dialog.appendChild(head);

    this.body = document.createElement('div');
    this.body.className = 'ov-body';
    this.dialog.appendChild(this.body);

    document.body.appendChild(this.dialog);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });

    this.btn = document.createElement('button');
    this.btn.className = 'btn';
    this.btn.textContent = '◈ SYSTEM';
    this.btn.title = 'System overview — how the RTB Fabric processes connections and requests, and every setting';
    this.btn.addEventListener('click', () => this.toggle());
    header.appendChild(this.btn);
  }

  /** Remove the dialog (appended to body) and trigger button. */
  destroy(): void {
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
    this.btn.remove();
  }

  private toggle(): void {
    if (this.dialog.open) {
      this.dialog.close();
      return;
    }
    this.render(this.getCfg());
    this.dialog.showModal();
  }

  /** Rebuild the content from the current config each time it opens (live values). */
  private render(cfg: SimulationConfig): void {
    const parts: string[] = [];
    parts.push(
      `<p class="ov-intro">A bid request's journey through the fabric, in the order the engine applies each gate. ` +
        `Value chips read the live settings of the selected sim; <b>opt-in</b> mechanisms are off in the presets. ` +
        `Use it to check the design against the real fabric.</p>`,
    );

    parts.push('<div class="ov-flow">');
    for (const lane of LANES) {
      parts.push(`<div class="ov-lane ov-lane-${lane.key}">`);
      parts.push(`<div class="ov-lane-head">${lane.title}</div>`);
      if (lane.blurb) parts.push(`<p class="ov-lane-blurb">${lane.blurb}</p>`);
      for (const g of lane.gates) parts.push(this.gateHtml(g, cfg));
      parts.push('</div>');
      parts.push('<div class="ov-arrow">↓</div>');
    }
    // Deadline wrapper closes the flow.
    parts.push(
      `<div class="ov-deadline"><div class="ov-lane-head">${DEADLINE.title}</div>` +
        `<p class="ov-lane-blurb">${DEADLINE.body}</p></div>`,
    );
    parts.push('</div>'); // .ov-flow

    // Side panels: CPU engine, failure taxonomy, assumptions.
    parts.push('<div class="ov-panels">');

    parts.push(
      `<div class="ov-panel ov-engine"><h3>${CPU_ENGINE.title}</h3><p>${CPU_ENGINE.body}</p></div>`,
    );

    const rows = FAILURES.map(
      (f) =>
        `<div class="ov-fail-row"><span class="ov-tag ${f.cls}">${f.tag}</span>` +
        `<span class="ov-fail-level">${f.level}</span>` +
        `<span class="ov-fail-cause">${f.cause}</span></div>`,
    ).join('');
    parts.push(
      `<div class="ov-panel"><h3>Shed / drop / fail taxonomy</h3>` +
        `<p class="ov-panel-sub">“Shed” = connection-level rejection by RST; “drop”/EMFILE are kernel failures with no clean RST; the rest are request fates.</p>` +
        `<div class="ov-fail">${rows}</div></div>`,
    );

    const items = ASSUMPTIONS.map((a) => `<li>${a}</li>`).join('');
    parts.push(
      `<div class="ov-panel"><h3>Design assumptions to validate</h3><ul class="ov-assume">${items}</ul></div>`,
    );

    parts.push('</div>'); // .ov-panels

    this.body.innerHTML = parts.join('');
  }

  private gateHtml(g: Gate, cfg: SimulationConfig): string {
    const enabled = g.enabled ? g.enabled(cfg) : null;
    const stateChip =
      enabled === null
        ? '<span class="ov-chip ov-core">core</span>'
        : enabled
          ? '<span class="ov-chip ov-on">on</span>'
          : '<span class="ov-chip ov-off">opt-in · off</span>';
    const value = g.value ? `<span class="ov-val">${g.value(cfg)}</span>` : '';
    const n = g.n ? `<span class="ov-n">${g.n}</span>` : '';
    const outcome = g.outcome
      ? `<div class="ov-outcome ov-${g.outcome.kind}"><span class="ov-out-tag">${OUTCOME_LABEL[g.outcome.kind]}</span>${g.outcome.text}</div>`
      : '';
    return (
      `<div class="ov-gate">` +
      `<div class="ov-gate-head">${n}<span class="ov-title">${g.title}</span>${stateChip}${value}</div>` +
      `<div class="ov-gate-how">${g.how}</div>` +
      outcome +
      `</div>`
    );
  }
}
