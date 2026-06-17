# RTB Fabric — Connection Storm Simulator

An animated, browser-based discrete-event simulation of **TLS connection
retry storms** in a high-throughput RTB proxy fabric. It models the full
feedback loop — timeouts, connection teardown, TLS handshake cost, shared
CPU — and lets you experiment live with limit settings and protection
mechanisms (TLS handshake permits with a bounded wait, TLS error pacing,
session resumption, and circuit breakers on both the clients and the
fabric→downstream pools) to see how each changes the system's response to
load surges.

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

1. **A client timeout poisons its connection** (HTTP/1.1 semantics) — and
   the client runs a *single* deadline per attempt that traps both phases:
   the wait for a connection and the request itself. In healthy periods
   connections are prewarmed outside the hot path; under pressure the client
   is forced to rebuild connections inside that same deadline, handshake
   included. At storm CPU no handshake finishes inside it, so goodput can
   collapse to a hard zero. (Clients with high RTTs typically run higher
   timeouts.)
2. **A full TLS handshake costs ~25× the CPU** of proxying a request over a
   warm connection (measured range 15–70×; see sources). Resumed handshakes
   cost a configurable fraction of that (default 40%); the resumption rate
   is a knob.
3. **Fabric CPU is shared** (processor sharing): when demanded work exceeds
   capacity, *every* in-flight operation stretches proportionally.

A handshake's wall-clock time has two parts: the fabric-side crypto (the only
part that loads the fabric CPU) and the wire — two hello round trips at the
client RTT (one when resumed), plus any client TLS delay (a burdened client
answering slowly). The wire part holds the handshake's permit without
consuming fabric CPU, so changing the client RTT changes how fast clients
come back — not the fabric's load per handshake. The client RTT also drives
every other client↔fabric leg (SYN, request, response, RST), which is what
makes very fast clients dangerous: their retries return quickly.

When connections are scarce, clients dispatch the *freshest* waiting request
first (adaptive LIFO): the oldest requests have the least deadline budget
left and would only poison a freshly rebuilt connection by timing out on it;
they fail by rejection instead, which poisons nothing.

So: latency rises → timeouts fire → connections die → handshakes flood →
CPU contention stretches everything → more timeouts. The control mechanisms:

| Mechanism | What it does |
|---|---|
| TLS permits + permit wait | At most N handshakes run concurrently. A connection without a permit waits up to the permit wait time, then is **shed with an RST** (the connection is invalidated). There is no TLS queue — only this bounded wait. |
| Connection limit | Beyond the cap, new connections are **shed with an RST** before any TLS work happens. |
| Accept-rate shedding | A per-server, in-memory **token bucket** at TCP accept: new connections refill it at the accept-rate limit (with a burst allowance), and when it runs dry, connections are **shed with an RST** at accept — before the connection-limit check and before any TLS work. Unlike the connection limit (a cap on *concurrent* connections) or the TLS permit cap (a cap on *concurrent* handshakes), this caps the *rate* of new connections, throttling handshake demand at the source. The cheapest rejection there is, and the most direct defense against a connection storm. |
| TLS error pacing | When a connection is shed at TLS admission, the RST is held for the pacing delay (typically 0–5ms, up to 100ms) before being sent, so shed clients don't learn — and reconnect — in lockstep. The held connection stays live for the delay and carries a small trickle of fabric CPU, so a long hold under a heavy shed is not free. |
| TLS session resumption | A configurable share of handshakes resume a prior session, skipping most of the asymmetric crypto. |
| Client circuit breaker | A client that sees sustained failures stops sending entirely, removing its load until a half-open probe succeeds. |

**"Shed" here means connection-level rejection**, and the simulator counts
the causes separately: `shed·tls` (TLS permits stayed occupied past the
wait), `shed·conn` (connection limit exceeded), and `shed·rate` (accept-rate
limit exceeded — bounced at TCP accept before any TLS work).

Faithfully modeled wasted work: the fabric completes handshakes for clients
that already gave up, downstreams finish responses the fabric already timed
out, and requests waiting for a downstream connection are discovered dead
only at dequeue.

## Scenarios

- **Healthy** — conservative limits, protections on, mostly-resumed
  handshakes. Pulse it and watch the response.
- **Storm-prone** — raised limits: 16× the TLS permits, the permit wait maxed
  out, 3 un-jittered retries, pacing off. Stable at baseline;
  after a 3× pulse the storm **persists once the pulse ends** (a metastable
  failure — the trigger is gone, the retry/handshake feedback loop sustains
  the overload).
- **Protected** — the counterpart to Storm-prone: identical client settings
  (3 un-jittered retries, tight timeouts), with the fabric's limits and
  protections enabled, so the pair isolates the fabric-side differences
  under the same pulse.
- **Overwhelmed** — offered load beyond capacity, no protections: goodput → ~0
  and stays there until traffic is removed.

Every run is deterministic for a given seed: a demo replays identically.

## Comparison mode

The **⇆ COMPARE** toggle runs two simulations stacked on the same virtual
clock, each with its own scene, charts, and totals. The traffic shape (the
Traffic knob group: client count and per-client rate), pulse, speed, pause,
and reset are shared, so both sims always see the same offered load. Client
behavior (timeout, RTT, retries, jitter, breakers) and the RTB Fabric,
downstream-pool, and downstream knobs are per-sim, selected with the
SIM A / SIM B tabs in the Tuning panel. A scenario button applies the whole
preset — clients included — to its sim, propagating only the traffic shape
to both. Storm-prone and Protected share identical client settings by
construction, so that pair isolates the fabric-side differences under the
same pulse; per-sim client knobs also allow client-side A/B experiments
(e.g. jittered vs un-jittered retries) against the same fabric tuning.
Run totals and the event log report both sims side by side.

## Reading the screen

- **Particles**: blue = in flight, purple halo = retry attempt. On resolution:
  green ring = success, red spiked star = timeout, yellow square = error,
  orange X = rejected client-side — no connection in time, or the client's own
  breaker was open (color is always paired with shape).
- **Lanes** (connections): dim = idle, blue = busy, dashed cyan + pulsing
  rings = TLS handshaking, red fade = torn down.
- **Fabric internals**: connection gauge vs limit, TLS permit slots with the
  count of connections in the permit wait, the CPU column (overflow hatching +
  slowdown factor when demand exceeds capacity), per-downstream queues,
  lifetime shed counters split by cause, and the PACE / RATE chips (TLS error
  pacing and accept-rate shedding on/off).
- **Breaker dots**: when a client's circuit breaker is enabled it shows its
  state — green dot closed; orange arc = open with cooldown progress; an orange
  ring while its half-open probe is out. The fabric does not circuit-break
  downstreams, so bidder nodes carry no breaker dot.
- **The graveyard**: failures pile up under the fabric and settle downward as
  they fade. Squares are request fates (red timeout, orange rejection, yellow
  error); hollow rings are TLS-permit sheds; hollow triangles are
  connection-limit sheds; hollow diamonds are accept-rate sheds.
- **Success rate + amplification (HUD)**: rolling success rate (successes ÷
  arrivals) and attempts sent ÷ successes over the last couple of seconds.
- **Charts** (60s rolling): latency p50/p99 vs the client-timeout line,
  offered vs goodput, failure rates, TLS permit pressure (starts, active,
  shed·tls) vs the permit count, fabric CPU demand vs the capacity line,
  connections vs limit (+ shed·conn and downstream queue depth), and
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
- Sy et al. (arXiv 1902.02531) — full vs resumed handshake CPU (~7ms vs
  ~1–3ms), grounding the resumption cost factor.
- Google SRE Book, *Handling Overload* — retry budgets; Google Authorized
  Buyers RTB guidance — tmax 100–300ms; "the first request on a new connection
  has a shorter effective deadline and is more likely to time out."
- HAProxy `maxsslconn`/`maxsslrate` and tarpit — the production analogs of the
  handshake cap and TLS error pacing.
