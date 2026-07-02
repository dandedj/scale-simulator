# RTB Fabric Simulators

Three browser-based discrete-event simulations of RTB Fabric behavior under load,
switched with the **mode toggle** in the header:

- **Connection Storm** — TLS connection retry storms in a high-throughput RTB
  proxy fabric: the feedback loop of timeouts, connection teardown, TLS
  handshake cost, and shared CPU, with live limit and protection knobs.
- **DNS Distribution** — DNS-based load distribution across many RTB Fabric
  servers: Route53 advertising healthy IPs, clients caching resolutions for the
  TTL, overloaded servers shedding with RSTs, and the lag between the fast (RST)
  and slow (health + DNS + boot) control loops. See
  [DNS load distribution](#dns-load-distribution) below.
- **Scaling** — how the fleet copes with a rapid demand ramp-up: the availability
  drop when capacity can't be added fast enough, and the scale rate the
  autoscaling pipeline (detection → provision → boot → health → DNS → client
  pickup) can actually achieve. See [Scaling](#scaling) below.

The connection-storm model is described first; the DNS and Scaling models have
their own sections at the end. All three share the shell (one playback clock, the
start gate, the comparison mode) and the engine primitives (event queue, seeded
RNG, the strip charts).

This connection-storm mode models the full feedback loop — timeouts, connection
teardown, TLS handshake cost, shared CPU — and lets you experiment live with
limit settings and protection mechanisms (TLS handshake permits with a bounded
wait, TLS error pacing, session resumption, and circuit breakers on both the
clients and the fabric→downstream pools) to see how each changes the system's
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
| TCP accept queue (somaxconn) | The kernel `listen()` backlog: completed TCP handshakes wait here for the fabric to `accept()` them — the kernel queue *ahead of, and separate from,* the TLS permit wait. Its drain rate falls as the CPU saturates (workers busy in TLS crypto), so a storm backs it up. On overflow a new connection is **dropped silently** — the client waits out a multi-second TCP SYN retransmit, usually past its own deadline — or, with `tcp_abort_on_overflow`, gets an immediate **RST**. Off by default. |
| File-descriptor ceiling (RLIMIT_NOFILE) | Every live socket (client-facing connections plus the downstream pool) costs one descriptor, a single shared budget. At the ceiling `accept()` and outbound `connect()` fail with **EMFILE**: the connection can't be taken and withers on the client's deadline — a dirtier failure than a clean RST. Raising the connection limit without raising this ceiling just relocates the wall. Off by default. |
| Accept-rate shedding | A per-server, in-memory **token bucket** at TCP accept: new connections refill it at the accept-rate limit (with a burst allowance), and when it runs dry, connections are **shed with an RST** at accept — before the connection-limit check and before any TLS work. Unlike the connection limit (a cap on *concurrent* connections) or the TLS permit cap (a cap on *concurrent* handshakes), this caps the *rate* of new connections, throttling handshake demand at the source. The cheapest rejection there is, and the most direct defense against a connection storm. |
| TLS error pacing | When a connection is shed at TLS admission, the RST is held for the pacing delay (typically 0–5ms, up to 100ms) before being sent, so shed clients don't learn — and reconnect — in lockstep. The held connection stays live for the delay and carries a small trickle of fabric CPU, so a long hold under a heavy shed is not free. Off by default — at this scale it has little effect on the storm; it stays an opt-in knob. |
| TLS session resumption | A configurable share of handshakes resume a prior session, skipping most of the asymmetric crypto. |
| Client circuit breaker | A client that sees sustained failures stops sending entirely, removing its load until a half-open probe succeeds. |
| Locks (contention) | User-defined serialization points (mutexes / `Arc<Mutex<…>>`) the fabric holds around shared state — e.g. the max-connections counter. Each is a single-server FIFO with a hold time; the wait it imposes is added to latency but **consumes no CPU**. Under load the lock — not the CPU — becomes the wall. See [Locks](#locks-modeling-serialization-bottlenecks). |

**"Shed" here means connection-level rejection**, and the simulator counts
the causes separately: `shed·tls` (TLS permits stayed occupied past the
wait), `shed·conn` (connection limit exceeded), and `shed·rate` (accept-rate
limit exceeded — bounced at TCP accept before any TLS work). Two kernel-level
failures are counted apart, as *drops* rather than sheds, because they don't
end in a clean RST the client can act on: `drop·acceptq` (the accept queue
overflowed — a silent drop the client only discovers on a SYN retransmit) and
`emfile` (the file-descriptor ceiling was hit, so `accept()` failed and the
connection withered on the client's deadline). The lesson both reinforce: a
storm that the application would shed cheaply at the door instead hits a
*kernel* wall, where the failure is slower and dirtier.

Faithfully modeled wasted work: the fabric completes handshakes for clients
that already gave up, downstreams finish responses the fabric already timed
out, and requests waiting for a downstream connection are discovered dead
only at dequeue.

## Locks: modeling serialization bottlenecks

The fabric protects shared state (a global counter, a router table, a session
cache) with locks. Add them in the **Locks** group: each lock has a name, a
**site** (`accept` — every new connection, like the `Arc<Mutex<usize>>`
max-connections counter; `request` — every request; `handshake` — every
handshake), a **hold time** in microseconds, and an enable toggle.

Hold-time reference (measured on Graviton3 / c7g): a lock-free atomic
(`fetch_add`, e.g. an `Arc<AtomicUsize>`) is ~0.005µs (5ns); an uncontended
`Arc<Mutex>` lock+unlock is ~0.025µs (25ns); a contended lock that spins or
parks runs ~1–5µs. The seeded example locks use these values. Note that at
25ns a per-connection counter is essentially free even at 500k conn/s — the
interesting regime is a coarser or contended lock, or a fine lock at very high
representative throughput.

Each lock is a single-server FIFO: an acquisition waits behind the current
holder, then holds for its hold time. That wait is added to the operation's
latency but **costs no CPU** — the lock is a serialization resource orthogonal
to the compute model. Its ceiling is `1 / holdTime` acquisitions per second no
matter how many cores you add (Amdahl / USL); past that, the queue — and the
wait — grow without bound (a 25ns lock tops out near 40M/s, a 2µs lock at
500k/s).

**The scale bridge.** A nanosecond-scale lock is invisible at the demo's actual
event rate; it only bottlenecks near a real server's throughput. So lock
pressure is scaled to a **Representative QPS** — the real per-server request
rate the demo stands in for. A request-site lock's utilization then works out to
`Representative QPS × hold time` (so 500k/s × 2µs = 100%, or 500k/s × 25ns =
1.25%), and raising offered load or firing a pulse scales it further. Treat
Representative QPS as the
**vertical-scale dial**: crank it and a fixed-hold lock climbs to 100%
utilization and its wait time explodes — **while the CPU stays flat**. That is
the whole point: past a certain scale the limit isn't compute, it's the time
spent waiting on the lock. Watch the **LOCK CONTENTION %** chart peg at 100%
while **FABRIC CPU %** sits low.

## Scenarios

Each scenario is a **RTB Fabric configuration** — they vary only the fabric, not
the load. Traffic is yours to drive: the Traffic knobs (client count and rate)
and the **◉ PULSE** button. Five of the six share one fixed, deliberately
aggressive client profile (a generous pool, a tight deadline, three un-jittered
retries, no client breaker), so switching scenarios changes *only* the fabric
and the same pulse exposes how each configuration responds. They are calm at
baseline; the pulse is what reveals the difference.

- **Wide open** — few limits: a high connection cap, 16× the TLS permits, the
  permit wait maxed out, no rate or kernel limits. Pulse it and the storm
  **persists once the pulse ends** — a metastable failure where the
  retry/handshake feedback loop sustains the overload after the trigger is gone.
- **Shed early** — a tight connection cap and few TLS permits: the fabric sheds
  connections cheaply at the door (RST) before the CPU can melt. The same
  clients and pulse that storm *Wide open* are held off by rejecting the flood.
- **Rate limited** — loose static caps, but a per-server token bucket throttles
  the *rate* of new connections at TCP accept (`shed·rate`). Handshake demand is
  capped at the source, so the flood never forms — a different defense than
  concurrent caps.
- **Kernel limited** — high app limits, but the OS limits bite first: a shallow
  accept queue (`somaxconn`) and a file-descriptor ceiling. Connections drop at
  the kernel (`drop·acceptq`, `emfile`) before they reach TLS — a dirtier
  failure than a clean RST.
- **Lock contention** — a shared mutex on the request path, scaled to a high
  per-server throughput: the **LOCK CONTENTION** chart pegs red and latency
  climbs while the CPU column stays low — the wall is contention, not compute.
  (Deliberately uses calmer clients so the lock itself is the bottleneck, not a
  reconnect storm it would otherwise ignite.)
- **Well tuned** — balanced limits, high TLS resumption (cheap reconnects), and
  an accept-rate backstop: it absorbs the surge with little shedding and recovers
  fast. The reference — layered, modest protections instead of one big limit.

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
to both. Because the scenarios share one fixed client profile (Lock contention
aside), picking a different scenario per pane isolates the fabric-side
difference under the same pulse — e.g. *Wide open* vs *Rate limited*, or
*Shed early* vs *Kernel limited*. Per-sim client knobs also allow client-side
A/B experiments (e.g. jittered vs un-jittered retries) against the same fabric
tuning. Run totals and the event log report both sims side by side.

**Is the difference real?** Under the totals, three A/B significance callouts
answer whether the gap is signal or noise — goodput, mean latency, and the tail:

- **Δ goodput** — each request is a Bernoulli trial (it succeeds within the
  deadline or not), so a two-proportion z-test on arrivals vs successes reports
  Δ goodput (B − A in percentage points), the z-statistic, the p-value, and a
  verdict: "not significant — likely noise" until the gap clears a confidence
  band, then "significant (95% / 99%) · SIM X better".
- **Δ latency mean** — Welch's t-test on the mean latency of successful
  requests (computed from running moments, no samples retained), reporting Δ in
  ms, t, p, and "SIM X faster" when significant.
- **Δ p99 latency** — the tail. Mean latency can miss a heavier tail entirely
  (the slowest requests time out and drop from the successes-only mean), so the
  p99 is tested separately: pool the last-60s latency window per sim, estimate
  each p99 and its standard error from the order statistics (the distribution-
  free binomial method — no bootstrap), and run a two-sample z-test on the
  difference. Needs ~500 successes per sim before it offers a verdict.

Two identical sims sit at "not significant" no matter how long they run; a
small but real edge crosses into significance as the sample grows (reset to
start a clean comparison). It is common and instructive to see goodput and p99
significant while the mean is not. Caveats, stated on the callout: the tests
assume independent requests — storm failures are correlated (one poisoned
connection fails a burst), so the effective sample is smaller than the raw count
and the reported confidence is optimistic; the latency tests only see successful
requests, so a sim that sheds its slow work can look artificially faster; and
p99 is computed over the last 60s, not the whole run. Read these as "clearly
beyond noise," not precise p-values.

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
  lock contention vs saturation, connections vs limit (+ shed·conn and
  downstream queue depth), and amplification.
- **◈ SYSTEM** (header): the System Overview dialog — the full connection and
  request pipeline in the order the engine applies each gate, with live
  setting values, the shared-CPU coupling, the shed/drop/fail taxonomy, and
  the explicit modeling assumptions. **? LEGEND** explains every glyph.

## Extending it

The engine (`src/engine/`) is renderer-agnostic; the renderer and charts only
read public simulation state. To add a component to the connection-storm model
(e.g., a sidecar rate limiter, retry token buckets, a downstream breaker):

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
- Linux kernel networking (`man tcp`, `net.core.somaxconn`,
  `net.ipv4.tcp_abort_on_overflow`) and the "two queues" model (SYN queue +
  accept queue) — the kernel accept backlog ahead of the application and its
  silent-drop / RST overflow behavior. `somaxconn` defaults to 4096 (128 before
  kernel 5.4); overflow drops the completed connection unless
  `tcp_abort_on_overflow` is set, which sends an RST instead.
- `RLIMIT_NOFILE` / `fs.nr_open` (`man getrlimit`, `man accept` → EMFILE) — the
  per-process file-descriptor ceiling (soft default 1024, bounded by
  `fs.nr_open` = 1,048,576); every socket costs a descriptor and `accept()`
  returns EMFILE at the ceiling. Demo numbers are scaled down (the demo's pools
  cap live sockets near 100), keeping the dynamics, not the absolute limits.

## DNS load distribution

The second mode (header toggle → **DNS Distribution**) models how RTB Fabric
spreads traffic across many servers with Route53, and the lag between the
controls that move that traffic. It is a separate model with its own engine,
renderer, charts, and scenarios under `src/dns/`.

### The model

Topology: **many client cohorts → Route53 record set → many RTB Fabric servers →
bidders** (bidders are drawn but do not influence the model). It is a *fluid*
model: traffic is carried as piecewise-constant rates (requests/sec), not
per-request entities, so it stays correct and cheap at fleet scale under heavy
time compression. Discrete events fire only when the rate field changes — TTL
re-resolves, publisher-Lambda runs, server boots, traffic ticks.

The zone is a **private hosted zone managed by RTB Fabric**, so Route53 does not
health-check the servers. A **publisher Lambda runs every ~1 min**, evaluates
which servers are healthy, and updates the record set — and it returns **all**
healthy IPs to every client (no multivalue subset).

Two control loops at very different timescales decide where traffic lands, and
the separation is the whole point:

1. **Fast loop (ms–~1s).** An overloaded server sheds with an RST; the client
   immediately reconnects to *another IP already in its cached set*. A request to
   a removed/dead IP is refused and also re-picks. This smooths hot spots — but
   only within the capacity a client already holds (advertised **and** cached
   right now). Modeled as a water-filling fixed point solved inside each
   rebalance.
2. **Slow loop (minutes).** The publisher-Lambda interval (health is evaluated
   per run, with run-count hysteresis) **+** per-client TTL expiry **+** server
   boot/warm-up. This is the only loop that grows the healthy-and-cached capacity.

So **TTL is a failover lever** (how fast clients leave a dead IP), **not a
scale-out lever** (how fast new capacity absorbs a surge). When offered load
exceeds total fleet capacity, no distribution scheme keeps 100% — it only
decides where the loss lands. The Lambda's check detects *liveness, not load* by
default, so an overwhelmed-but-up server stays advertised (which is why the RST
loop exists); the Lambda *fails open* when no server is healthy, advertising all
records rather than publishing an empty set.

Resolver layering is collapsed into a per-cohort effective TTL with a
pinned/TTL-ignoring tail (connection- or JVM-pinned clients that only fail over
via an RST re-pick). A configurable fraction of cohorts are **EKS clusters
behind a shared CoreDNS cache** (marked ⎈): all pods in a cluster share one
cached answer and fail over together, on `min(zone TTL, CoreDNS cache)` — so
CoreDNS *caps* a long zone TTL (clusters can recover faster than direct/JVM
clients), while a whole cluster moving as one makes the stale blast radius
lumpier. The **? LEGEND** and **◈ SYSTEM** dialogs spell out every encoding and
the full list of modeling assumptions.

### Primary metric

**Availability = served ÷ offered**, shown as a time series (the dip and its
recovery curve), not just a scalar — adtech tolerates a brief dip if cost and
performance are good. Run totals also report **lost-impression-seconds**
(the area of the dip, the cleanest scenario comparator) and a **cost axis**
(served vs provisioned capacity-seconds), so the availability-vs-cost trade is
legible.

### Scenarios

Each shares one offered-load shape so the difference is isolated; drive an event
(**◉ PULSE**, **✕ KILL SERVER**, **＋ ADD SERVERS**, or a ramp shape) to reveal it:

- **Steady state** — the balanced reference; pulse past total capacity to see
  irreducible loss.
- **No RST shedding** — the fast loop off: hot spots fail instead of
  redistributing (the central scenario, vs Steady).
- **Long TTL / Short TTL** — kill a server and compare how long the dead-IP scar
  lasts (failover speed vs re-resolution churn; pinned clients stick regardless).
- **Reactive autoscale / Pre-provisioned headroom** — under the same surge,
  reactive capacity arrives after the surge (boot ~5 min) while headroom absorbs
  it instantly at higher steady-state cost.
- **EKS / CoreDNS cache** — a long zone TTL with most clients behind a shared
  CoreDNS cache; kill a server and watch the EKS clusters (⎈) clear off the dead
  IP in ~30s (CoreDNS caps the TTL) while direct and pinned clients stay stuck
  for the full 5 minutes.

`npm test` covers the DNS engine too (`src/dns/engine/dnsSimulation.test.ts`):
the timescale-separation invariant (a dead server's scar is bounded by TTL, not
fixed by the fast loop), playback-speed determinism (identical availability at
any step granularity), and that each scenario still demonstrates its lesson.

### Grounding (DNS specifics)

- RTB Fabric's private hosted zone is managed by a publisher Lambda that runs
  every ~1 min to update the record set with the healthy server IPs, returning
  all of them to every client; it fails open (advertises all) when none are
  healthy. Route53 itself does not health-check the servers.
- DNS TTL caching across recursive/stub resolvers and connection-/JVM-pinned
  clients that hold a resolution far past the authoritative TTL.
- Autoscaling lead time dominated by instance boot + warm-up, far longer than a
  short traffic surge — the reactive-vs-headroom trade.

## Scaling

The third mode (header toggle → **↗ Scaling**) focuses on a **rapid demand
ramp-up** and the autoscaling pipeline that has to keep up: how far availability
drops when capacity lags demand, and what **scale rate** (TPS added per minute)
the pipeline can actually achieve. Its own engine, renderer, and scenarios live
under `src/scaling/`.

### The model

Fluid, deterministic discrete-event model: demand and capacity are TPS rates;
pipeline stage transitions, autoscaler ticks, and demand ticks are the events.
`served = min(offered, usable capacity)`, so during a ramp availability =
capacity ÷ demand. Reference fleet: **50K TPS per c7g.2xlarge (100K on two)**.

The autoscaler is target-tracking: it holds utilization at the **buffer** target
(e.g. 60% — the rest is headroom) and launches instances when demand pushes past
it. Each launched instance runs a **9-stage pipeline**, every stage individually
tunable:

1. **Detection** — metric emit + ASG alarm (breach must persist this long).
2. **Signal → ECS** · 3. **Launch EC2** · 4. **Cloud-init / user-data** ·
   5. **Task placement** · 6. **Task boot** · 7. **Health check** ·
   8. **DNS publish** (⇒ serving/advertised) · 9. **Client pickup** (⇒ usable).

Two limits govern the outcome, and the tab separates them:

- **Latency** (Σ stages, ~5 min) — *when* the first new capacity lands and how
  deep the dip goes. "Add 1M TPS in 1 minute" is impossible if the pipeline is 5
  minutes: capacity arrives after the surge, regardless of how many you launch.
- **Throughput** (`batch × capacity ÷ cooldown`) — the *sustained* TPS/min you
  can add once the pipeline fills; the max ramp you can track.

The readout reports both: the event's **recover time** and **effective add-rate**,
the computed **max sustainable ramp**, the **pipeline latency** floor, and a
**per-stage lag breakdown** (which stage to optimize). The board shows the
pipeline filling with instances, the demand-vs-capacity gap, and the fleet by
phase (provisioning → ready → in use).

### Scenarios

Shared demand ramp (default +1M TPS in 1 min); vary the scaling config:

- **Baseline ramp** — ~5-min pipeline vs a 1-min ramp ⇒ deep dip, slow recovery
  (max sustainable ramp ≈ 200K/min « 1M/min offered).
- **Optimized pipeline** — warm pool / baked AMI ⇒ the per-stage lag collapses,
  shallow short dip.
- **Over-provisioned buffer** — big headroom (low target util) absorbs the ramp
  while the pipeline catches up, at the cost of idle instances.
- **Big batches** — larger batch + short cooldown lifts the sustained scale rate
  enough to track the ramp once the pipeline fills.
- **Slow detection** — a 3-min detection dominates the lag (the breakdown bar
  makes it obvious).

`npm test` covers the scaling engine too
(`src/scaling/engine/scalingSimulation.test.ts`): a calm start, a ramp that dips
then recovers, more buffer / a faster pipeline / bigger batches each reducing the
loss, the max-sustainable-ramp arithmetic, and playback-speed determinism.

### Grounding (scaling specifics)

- Reference throughput: 100K TPS on 2× c7g.2xlarge ⇒ 50K TPS/instance.
- The scale-up latency is the sum of real ASG/ECS stages — CloudWatch metric +
  alarm datapoints for detection, EC2 launch, cloud-init/user-data, ECS
  placement, container boot, health-check grace, and DNS registration + client
  re-resolution — typically ~5 min end to end.
- Sustained scale throughput is bounded by the launch batch size, cooldown, and
  max fleet, independent of the per-instance latency.
