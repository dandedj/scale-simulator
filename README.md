# RTB Fabric — Connection Storm Simulator

An animated, browser-based discrete-event simulation of **TLS connection
retry storms** in a high-throughput RTB proxy fabric. It models the full
feedback loop — timeouts, connection teardown, TLS handshake cost, shared
CPU — and lets you experiment live with limit settings and protection
mechanisms (load shedding, error pacing, TLS handshake concurrency limits,
bounded queues, circuit breakers) to see how each changes the system's
response to load surges.

## Run it

```bash
npm install
npm run dev        # open the printed localhost URL
```

```bash
npm test           # engine invariant tests (also the preset-tuning harness)
npm run build      # static bundle in dist/ — host anywhere
```

## The model

Topology: **N clients → RTB Fabric (proxy) → M downstreams**, all on a virtual
clock in real-world milliseconds, played back in slow motion (default 10×
slower; slider from 100× slower to 2× faster).

The storm is **not scripted**. It emerges from three coupled rules:

1. **A request timeout poisons its connection** (HTTP/1.1 semantics). The
   client tears it down and must eventually re-handshake.
2. **A full TLS handshake costs ~25× the CPU** of proxying a request over a
   warm connection (measured range 15–70×; see sources).
3. **Fabric CPU is shared** (processor sharing): when demanded work exceeds
   capacity, *every* in-flight operation stretches proportionally.

So: latency rises → timeouts fire → connections die → handshakes flood →
CPU contention stretches everything → more timeouts. Each protection breaks
one link of that loop:

| Protection | Link it breaks |
|---|---|
| Load shedding | A cheap, instant "no" instead of an expensive timeout — and the client's connection *survives* a shed response |
| Error pacing | A client slot can only retry once per (pacing delay + backoff) — the tight retry loop is rate-limited by error latency |
| TLS handshake concurrency cap | Bounds handshake CPU demand; excess connects wait in a cheap accept queue instead of melting the CPU |
| Bounded queues | Prevents the latency death spiral where every dequeued request is already dead (client gave up while it queued) |
| Circuit breaker | One slow downstream can't absorb the fabric's entire connection/queue budget |

Faithfully modeled wasted work: the fabric completes handshakes for clients
that already gave up, downstreams finish responses the fabric already timed
out, and queued requests are discovered dead only at dequeue.

## Scenarios

- **Healthy** — conservative limits, all protections on. Pulse it: brief
  shedding, fast recovery.
- **Storm-prone** — raised limits with protections disabled: 16× the
  handshake concurrency, shedding off, 3 un-jittered retries. Stable at
  baseline; after a 3× pulse the storm **persists once the pulse ends** (a
  metastable failure — the trigger is gone, the retry/handshake feedback loop
  sustains the overload).
- **Protected** — the counterpart to Storm-prone: identical client settings,
  with the fabric's limits and protections enabled, so the two configurations
  can be compared under the same pulse.
- **Overwhelmed** — offered load beyond capacity, no protections: goodput → ~0
  and stays there until traffic is removed.

Every run is deterministic for a given seed: a demo replays identically.

## Reading the screen

- **Particles**: blue = in flight, purple halo = retry attempt. On resolution:
  green ring = success, red spiked star = timeout, orange hollow ring = shed,
  yellow square = downstream error (color is always paired with shape).
- **Lanes** (connections): dim = idle, blue = busy, dashed cyan + pulsing
  rings = TLS handshaking, red fade = torn down.
- **Fabric internals**: connection gauge vs limit, TLS "airlock" slots with
  the accept-queue count, the CPU column (overflow hatching + slowdown factor
  when demand exceeds capacity), per-downstream queues, the error-pacing tray,
  and the protection chips (SHED / PACE / QCAP).
- **The graveyard**: failed requests pile up under the fabric. Orange motes
  are shed requests (rejected cheaply, connections kept alive); red motes are
  timeouts (connections torn down, retries and re-handshakes follow).
- **Amplification (HUD)**: attempts sent ÷ successes over the last second.
  Green ≤1.1; red >1.5 means the retry feedback loop is winning.
- **Charts** (60s rolling): latency p50/p99 vs the client-timeout line,
  offered vs goodput (the gap *is* the storm), failure rates, TLS handshake
  pressure vs the concurrency cap, connections vs limit + queue depth, and
  amplification.

## Extending it

The engine (`src/engine/`) is renderer-agnostic; the renderer and charts only
read public simulation state. To add a component (e.g., a DNS resolver, a
sidecar rate limiter, session resumption, retry token buckets):

1. Add config to `types.ts`, defaults to `presets.ts`.
2. Model it in `simulation.ts` (schedule events via `queue`, CPU work via
   `cpu.add`, counters via `metrics`).
3. Add an invariant test in `simulation.test.ts` proving the dynamics.
4. Draw it in `renderer.ts` / add knobs in `ui/controls.ts`.

`npm test` is the safety net: it asserts each preset still demonstrates its
scenario (healthy stays healthy, storm-prone storms *and stays stormed* after
the pulse, protected recovers, accounting never leaks).

## Grounding

The dynamics and default numbers come from measured sources, scaled ~30× down
to stay animatable while preserving the ratios that drive the physics:

- Bronson et al., *Metastable Failures in Distributed Systems* (HotOS '21) and
  Huang et al., *Metastable Failures in the Wild* (OSDI '22) — trigger vs
  sustaining effect; every observed recovery involved load shedding.
- AWS Builders' Library — *Using load shedding to avoid overload*; *Timeouts,
  retries, and backoff with jitter* (full-jitter backoff; the goodput cliff at
  latency = timeout).
- Krizhanovsky & Koveshnikov, *Performance study of kernel TLS handshakes*
  (Tempesta) — the 10–12× full-handshake throughput penalty.
- Sy et al. (arXiv 1902.02531) — full vs resumed handshake CPU (~7ms vs ~1–3ms).
- Google SRE Book, *Handling Overload* — retry budgets; Google Authorized
  Buyers RTB guidance — tmax 100–300ms; "the first request on a new connection
  has a shorter effective deadline and is more likely to time out."
- HAProxy `maxsslconn`/`maxsslrate` and tarpit — the production analogs of the
  handshake cap and error pacing.
