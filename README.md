# RTB Fabric Simulators

Four browser-based simulations of RTB Fabric behavior under load,
switched with the **☰** nav in the header:

- **Connection Storm** — TLS connection retry storms in a high-throughput RTB
  proxy fabric: the feedback loop of timeouts, connection teardown, TLS
  handshake cost, and shared CPU, with live limit and protection knobs.
- **DNS Distribution** — DNS-based load distribution across many RTB Fabric
  servers: Route53 advertising healthy IPs, clients caching resolutions for the
  TTL, overloaded servers shedding with RSTs, and the lag between the fast (RST)
  and slow (health + DNS + boot) control loops. See
  [DNS load distribution](#dns-load-distribution) below.
- **Outbound Pools** — connection cardinality from RTB Fabric workers and links
  to customer responder/Envoy systems: Hyper's on-demand HTTP/1 behavior, idle
  retention, per-link/per-IP partitioning, responder connection ceilings, and
  alternative keying, ownership, bounded-pool, and HTTP/2 designs. See
  [Outbound responder pools](#outbound-responder-pools) below.
- **Scaling** — how the fleet copes with a rapid demand ramp-up: the availability
  drop when capacity can't be added fast enough, and the scale rate the
  autoscaling pipeline (detection → provision → boot → health → DNS → client
  pickup) can actually achieve. See [Scaling](#scaling) below.

The connection-storm model is described first; the DNS, Outbound Pools, and
Scaling models have their own sections at the end. All four share the shell (one playback clock, the
start gate, the comparison mode) and the engine primitives (event queue, seeded
RNG, the strip charts).

This connection-storm mode models the full feedback loop — timeouts, connection
teardown, TLS handshake cost, shared CPU — and lets you experiment live with
limit settings and protection mechanisms (TLS handshake permits with a bounded
wait, TLS error pacing, session resumption, and circuit breakers on both the
clients and the fabric→downstream pools) to see how each changes the system's
response to load surges.

## Deep links

Every configuration is addressable. The address bar always shows the current
one — tune anything and copy it, or press **🔗 LINK** to copy it directly:

```
?m=scaling&s=sustained                              a scenario, as-is
?m=scaling&s=sustained&launch.bakeMs=600000         …with one thing changed
?m=scaling&cmp=1&s=sustained&s2=long-bake&run=1     a comparison, running on load
?m=scaling&cmp=1&s=sustained&s2=sustained&b.launch.bakeMs=900000   pane B only
```

A link is a **scenario plus what differs from it**, not a dump of every field,
so it stays short and stays readable. Reserved keys: `m` (mode), `s` / `s2`
(scenario per pane), `cmp` (comparison mode), `run` (skip the start gate).
Every other key is a dot-path into that mode's config; prefix one with `b.` to
aim it at pane B. An unknown path is ignored, so an old link degrades rather
than breaking.

The **§ Options reference** in the ☰ nav (`?m=reference`) lists every setting in
every simulator with the path that sets it, its range, its default, and its
what/how/expect. It is generated from the control panels themselves and the
paths are recovered by running each real setter, so the page cannot drift from
the app — and a test asserts every path it publishes is one the link parser
accepts.

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
*Shed early* vs *Kernel limited*. The **A/B experiments** cards in the Scenarios
panel load those pairings in one click, entering comparison mode and setting both
panes at once. Per-sim client knobs also allow client-side A/B experiments (e.g.
jittered vs un-jittered retries) against the same fabric tuning. Run totals and
the event log report both sims side by side.

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

The second mode (**☰** nav → **DNS Distribution**) models how RTB Fabric
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

## Outbound responder pools

Open it with **☰ → Outbound Pools** or `?m=pools`. This mode answers a different
connection question from Connection Storm: not whether inbound TLS retries melt
the fabric, but why a healthy RTB Fabric fleet can hold far more outbound sockets
to a customer than the load balancer it replaced.

### The cardinality model

The board keeps the multiplier visible:

```
owned pool keys = RTB nodes × pool owners/node × application keys/owner

Link→endpoint bindings = Links × configured endpoints/Link
unique endpoints = common endpoints + Links × private endpoints/Link
current application keys/owner = Link→endpoint bindings × IPs/endpoint
```

Links and Link endpoints are concrete entities in the model. Each Link owns a
list of endpoint references; each unique endpoint has a DNS authority,
certificate identity, port, resolved IP set, reverse Link membership, and its
share of traffic and connections. The **Shared endpoints / Link** control makes
some exact endpoint identities common to every Link, while the remaining
endpoints are private to one Link. The board draws those actual relationships,
so a shared endpoint visibly collects traffic from multiple Links.

In the default example, all eight Links reference the same endpoint identity,
which resolves to four IPs. The current pool design still creates
`24 nodes × 32 worker processes × 8 Link references × 4 IPs` = **24,576
independently owned keys** because the Link remains part of the application key.
A warm floor of one connection per key already exceeds eight Envoys at 1,024
connections each, even though the whole customer workload needs far less mean
HTTP concurrency. This is the main distinction the simulator is built to
expose: connection pressure can be driven by *partition cardinality* rather
than throughput.

Pool ownership is explicit. **worker-local** matches separate worker processes:
process memory and its Hyper client cannot share sockets with another process.
**node-shared** is a hypothetical architectural comparison. Within one process,
cloning a Hyper `Client` reuses its underlying pool; that does not make a pool
cross-process.

The application key choices are:

- **Link × endpoint × IP** — the current RTB Fabric shape. Every Link gets a
  separate pool for every configured endpoint reference and resolved IP, even
  when several Links reference the same endpoint identity.
- **IP + cert + port** — Links that reference the same endpoint identity share
  pool state for each IP. The Link multiplier disappears only for exact shared
  endpoints; Link-private endpoints remain isolated.
- **DNS authority** — one authority-keyed pool per unique endpoint and owner,
  resolving connections across that endpoint's IPs. This matches Hyper's native
  key shape when the same client is shared, but changes where DNS/address
  selection responsibility lives.

The fluid model first divides customer QPS across Links and then across each
Link's endpoint references. Traffic converges when Links share an endpoint and
remains separate for private endpoints. It converts each endpoint's traffic and
response occupancy into mean concurrency using Little's Law, applies a headroom
factor for arrival/latency variance, then rounds per independently owned key.
Sparse keys contribute according to the probability that they were touched
within the idle-retention window, so a theoretical key does not automatically
hold a socket at extremely low traffic. The configured warm floor is applied
afterward.

### Hyper behavior represented

The model follows the current `hyper-util` legacy client behavior that matters
for connection count:

- The library pool key is `(scheme, authority)`. RTB Fabric's link/IP split is
  therefore modeled as an application layer above the library pool.
- Cloned Clients share the underlying pool.
- `pool_idle_timeout` defaults to 90 seconds and requires a pool timer to take
  effect; `None` disables expiry.
- `pool_max_idle_per_host` defaults to `usize::MAX`. It limits connections that
  have returned *idle*, not busy or connecting sockets. It is deliberately not
  presented as an active connection limit.
- For HTTP/1, Hyper races an idle checkout against establishing a socket, and
  does not serialize in-progress connects for a key. A connect that already
  started can finish in the background after checkout wins, adding idle
  inventory. The **H1 checkout-race factor** is an empirical sensitivity knob,
  not a Hyper builder setting.
- HTTP/2 reservations share a connection, and Hyper prevents multiple concurrent
  H2 establishment tasks for the same key. The simulator applies the configured
  stream concurrency and ignores the H1 race factor in H2 mode.

Primary sources: the
[`hyper_util::client::legacy::Builder` documentation](https://docs.rs/hyper-util/latest/hyper_util/client/legacy/struct.Builder.html),
the [legacy client source](https://docs.rs/hyper-util/latest/src/hyper_util/client/legacy/client.rs.html),
and the [legacy pool source](https://docs.rs/hyper-util/latest/src/hyper_util/client/legacy/pool.rs.html).
The newer `client::pool` module is composable infrastructure, not a drop-in
claim that the legacy client now has an active max; it is useful design space for
a custom bounded pool.

RTB Fabric's **Warm floor / key** is modeled separately because it is an
application control, not one of those legacy Hyper builder options.

### Dynamics and responder pressure

Each connection is busy, idle, or connecting. A surge raises per-key concurrency
and starts on-demand connects; after it passes, excess sockets remain idle until
the idle timeout, unless max-idle trims them sooner. **⟳ RECONNECT ALL** models a
process/fleet recycle: existing sockets close and all required pools rebuild at
once. Failed coverage feeds a configurable retry fraction back into demand.

The responder side tracks the **hottest instance**, not only an aggregate. A
placement-skew knob makes one Envoy reach its limit before the theoretical total
budget is full. New connections past that point reset, requests lose pool-key
coverage, and retries can sustain connection-attempt churn. This is intentionally
a connection-capacity model: it does not model responder CPU, request queue
implementation, ephemeral-port limits, NAT, TLS CPU, or HTTP/2 protocol support.

The **bounded alternative** is hypothetical. Its max is per application key, so
it still multiplies by key count. A production implementation also needs an
explicit queue, deadline, and shed policy; the simulator shows the pressure and
unserved work but does not pretend the cap alone defines those semantics.

### Scenarios and comparison

- **Current RTB shape** — eight Links converge on one shared four-IP endpoint,
  but worker-local Link × endpoint × IP pools keep every copy separate; the
  1,024-per-Envoy example starts at the ceiling.
- **Previous LB shape** — fewer, node-shared endpoint pools under identical
  customer traffic.
- **Scale out ×2** — twice the nodes and therefore twice the independent warm
  key floor, despite unchanged total QPS.
- **Share links** — IP + cert + port pooling de-duplicates exact endpoints
  across Links while retaining one pool key per IP.
- **Mixed Link endpoints** — every Link has one common and two private endpoint
  identities, exposing which portions a sharing strategy can and cannot merge.
- **DNS authority** — one authority key per unique endpoint removes repeated
  Link references and the per-IP pool-state multiplier.
- **Bounded + shared** — combines endpoint sharing, a short idle lifetime, and a
  hypothetical active max.
- **HTTP/2 multiplexed** — shared authority keys plus 100 streams per connection,
  if the responder supports H2.

Comparison mode holds customer traffic identical while allowing topology, keying,
pool behavior, protocol, and responder limits to differ. Useful pairings are
Current vs Previous LB (migration), Current vs Scale out ×2 (horizontal scale),
Current vs Share links (key design), DNS authority HTTP/1 vs HTTP/2 (multiplexing),
and Hyper on-demand vs Bounded + shared (active admission).

The useful optimization order is visible in those comparisons: first verify how
many process-local Client/pool owners really exist; then remove unnecessary link
and IP key multipliers; tune the warm floor and idle retention; add an active
budget with explicit wait/shed semantics if a hard responder guarantee is needed;
and use HTTP/2 multiplexing where the responder contract supports it. Raising a
customer's Envoy limit treats capacity, while key sharing and bounded admission
treat connection creation. Horizontal or vertical RTB scaling should be checked
against the pool-key equation every time because either can add independent
floors even when customer QPS is unchanged.

`npm test` covers Link membership, shared/private endpoint identity and traffic
conservation, the pool multiplier, all key strategies, horizontal/vertical
scale, max-idle-versus-max-active semantics, H2 multiplexing, sparse-key idle
retention, responder resets, scenario traffic parity, and step-size stability.

## Scaling

The fourth mode (**☰** nav → **↗ Scaling**) focuses on a **rapid demand
ramp-up** and the autoscaling pipeline that has to keep up: how far availability
drops when capacity lags demand, and what **scale rate** (TPS added per minute)
the pipeline can actually achieve. Its own engine, renderer, and scenarios live
under `src/scaling/`.

### The model

Fluid, deterministic discrete-event model: demand and capacity are TPS rates;
pipeline stage transitions, autoscaler ticks, and demand ticks are the events.
`served = min(offered, usable capacity)`, so during a ramp availability =
capacity ÷ demand. Reference fleet: **50K TPS per c7g.2xlarge (100K on two)**.

The autoscaler holds utilization at the **buffer** target (e.g. 60% — the rest is
headroom) and launches instances when demand pushes past it. Each launched
instance runs a **9-stage pipeline**, every stage individually tunable:

1. **Detection** — metric emit + CloudWatch alarm (breach must persist this long).
2. **Signal → ECS** · 3. **Launch EC2** · 4. **Cloud-init / user-data** ·
   5. **Task placement** · 6. **Task boot** · 7. **Health check** ·
   8. **DNS publish** (⇒ serving/advertised) · 9. **Client pickup** (⇒ in service).

### Scaling policy — how aggressively capacity is added

The three AWS dynamic policy types are selectable, each with its own arithmetic:

- **Target tracking** — computes the capacity that would hold utilization at
  target and closes the gap (`newCapacity = currentCapacity × metric ÷ target`).
  A **scale-out gain** multiplies that result: 1.0× is the AWS arithmetic, above
  1 over-provisions on purpose, below 1 walks up in fractions of the gap.
- **Step scaling** — picks an adjustment off a ladder keyed on how far past
  target the metric is (three rungs: at target, 25% over, 2× target), read as a
  flat instance count or a percentage of the fleet (`ChangeInCapacity` /
  `PercentChangeInCapacity`, with AWS's rounding).
- **Simple scaling** — one fixed adjustment per alarm, then nothing at all until
  the **cooldown** expires. AWS accepts a `Cooldown` only on this policy type.

Whatever the policy asks for is clamped into the **min/max scaling step size**
(ECS `minimumScalingStepSize` / `maximumScalingStepSize`) and the fleet ceiling.

### Bake (instance warmup)

After a scale-out, new capacity **bakes** before the autoscaler counts it — ECS
`instanceWarmupPeriod` and ASG `DefaultInstanceWarmup`, both 300s by default.
A baking instance is in service and carrying traffic, but the policy does not
count it in the capacity it scales *from*, while still counting it in what it has
already requested:

```
newDesired = max(currentDesired, meteredCapacity + adjustment)
```

Repeated breaches of the same size therefore collapse into a single scaling
activity, and a deeper breach only tops up the difference — it reproduces the
worked example in the EC2 Auto Scaling step-scaling docs, and it is what stops an
autoscaler from ordering the same capacity twice.

**Whose warmup: ECS or ASG.** The clock is per instance under both, but they
differ in what the bake gates and when it starts. The **Warmup rules** toggle
picks between them:

| | ECS cluster auto scaling | EC2 Auto Scaling (target / step) |
|---|---|---|
| Gates | Blocks the next scale-out until **every** instance is warm | Blocks nothing — warming instances are left out of the metric and out of the capacity scaled from |
| Clock starts | Instance **launch** | Instance reaches **InService** |
| Cycle | Bake runs *alongside* the pipeline | Bake runs *after* the pipeline |

ECS is the default here, because this is an ECS-on-EC2 pipeline and because "the
scale-out is blocked for instances that are within the `instanceWarmupPeriod`"
is what an operator usually means by "our bake is 300s before another scale
decision is made". Instances launch together, so that per-instance check behaves
as a fleet-wide gate. The same 300s buys fewer, larger steps under ECS and
continuous but under-sized ones under ASG. One consequence catches people out:
because the ECS clock runs from the launch, **a bake shorter than the pipeline
expires before the capacity it covers has even landed**, and adds nothing to the
cycle at all.

Either way the cost lands on a **sustained** ramp, not an instant jump. Against a
step change the policy sizes the entire gap before anything lands, so the bake
never binds and pipeline latency is the whole story — 0s and 600s bakes lose
exactly the same. Against demand that keeps climbing, on the +1M-over-30-min ramp
a 600s bake loses roughly 3× what a 300s bake does, for identical demand and an
identical peak fleet.

Two limits govern the outcome, and the tab separates them:

- **Latency** (detection + Σ stages, ~5 min) — *when* the first new capacity
  lands and how deep the dip goes. "Add 1M TPS in 1 minute" is impossible if the
  pipeline is 5 minutes: capacity arrives after the surge, however many you
  launch.
- **Throughput** (`max step × capacity ÷ decision interval`, where the decision
  interval is the bake under ECS rules and `pipeline + bake` under ASG rules) —
  the *sustained* TPS/min you can add, and so the fastest ramp you can track.

The readout reports both: the event's **recover time** and **effective
add-rate**, the computed **max sustainable ramp**, the **pipeline latency**
floor, the **decision interval** with a live countdown of the bake hold, and
**overshoot** (instances beyond what the peak demand needed). A **per-stage
breakdown bar** splits a full scale cycle across detection, the 8 per-instance
stages, and the bake, so whichever one dominates is obvious. The board shows the
pipeline filling with instances, the demand-vs-capacity gap with a marker for how
much of the serving capacity is still uncounted, and the fleet by phase
(provisioning → ready → baking → in use).

### Demand

The ramp is described as an **amount** and a **rate**, delivered as a `steady`,
`ramp` or `step` shape — or fired on demand with **▲ RAMP**, which adds that
amount at that rate on top of whatever demand is running. Triggered ramps stack
and persist. The quick-pick buttons cover the common cases (+250K … +3M TPS
over 1 min … 1 hour); for anything else, type an exact figure into the value
field — `1.75M`, `750k`, `1750000` and `90s`, `45m`, `2h` all parse. Base rate,
capacity per instance and the fleet ceiling take exact values the same way. The
chart rail's view window grows with the run, so a 1-minute ramp and an hour-long
one are both fully on screen.

### Timeline

**⧗ TIMELINE** (single mode) opens an annotated strip below the stage: one axis
for the whole run, so what happened and why reads directly instead of being
reconstructed from the scrolling event ticker. **⤢** hands it the whole stage —
the board and charts step aside; Esc restores them.

Lanes, top to bottom:

- **Demand** — the offered curve against usable capacity, with every below-SLO
  stretch shaded red behind every lane and totalled in the header.
- **Spans** — each demand change and the stretch over which it arrived: the
  scheduled ramp, every triggered ▲ RAMP, every ◉ SURGE window. This is the
  "when was the throughput offered" view.
- **Alarm** — amber while the breach is accumulating datapoints, red once the
  alarm has fired. The amber stretch is the detection lag, made literal.
- **Scale-outs** — one Gantt row per scaling activity showing the whole scale
  process: each pipeline stage it ran (signal → launch → cloud-init → placement
  → boot → health check → DNS publish → client pickup), the bake as a bar
  beneath, and a hairline from the point the batch started counting as capacity.
  Because the bake is drawn separately, the ECS case — where it starts at the
  launch and runs *alongside* the stages — looks visibly different from the ASG
  case, where it follows them.
- **Metric** — a tick per publish. Nothing can be decided between two of them.

The **event ticker** carries the same pipeline: each batch reports one line per
stage it clears (`+20 · health check done`, `+20 · client pickup done — in
service, carrying traffic`, `+20 · bake done — counted as capacity`), reported by
one instance on the batch's behalf so a twenty-instance step is twenty times
quieter than it would otherwise be. Under ECS rules a bake shorter than the
pipeline reports *before* the batch lands, which is exactly the point.

**Hovering a scale-out row shows why it chose that size**, step by step:

```
11:52  scale-out +6
target-tracking · util 89% vs target 60%
11 counted × 89% ÷ 60% = 16.2
desired 17 − 11 already requested = 6
lands 15:52 · counts 16:52
```

— the metric it measured, the capacity it scaled *from* (post-bake, in service),
the policy's own arithmetic, the netting against what was already in flight, any
clamp that bound the result, and when the capacity would actually matter. Step
and simple policies show their rung and adjustment instead of the ratio.
Hovering anywhere else reports the demand, capacity, counted capacity,
availability and events at that moment.

**The axis is a fixed window, not the whole run** — 15 minutes by default, wide
enough to hold a couple of scale-outs with their pipelines and bakes, which is
the unit of the story. Its own control bar sits in the corner:

| | |
|---|---|
| `◀` `▶` | page back and forward through the history |
| `5m` `15m` `30m` `1h` | pick a fixed window, which follows the live edge |
| `ALL` | fit the whole run on one axis instead |
| `⏸ HOLD` | freeze the window where it is — the run carries on, the view stays put |
| `● LIVE` | appears when the view is off the live edge; click to catch up |
| `⤢` | maximize |

**HOLD** is the one to reach for while something is developing: scrolling back to
stop the view moving also moves you off what you were watching, and the live edge
would catch up and re-pin the moment it arrived. Held, the window stays exactly
where you left it however far the run travels past it — the header says
`15m window @ 1:05:37 — held` — and ● LIVE (or Esc) releases it.

Dragging and the wheel do the same by hand (drag to scroll, wheel to zoom), with
a few pixels of slop before a press counts as a drag so inspecting a row never
scrolls the view. Esc backs out one step at a time — re-pin a scrolled window
first, then un-maximize.

Only scale-outs active inside the window get a row, so the rows stay large and
about what is on screen; the demand curve scales to the window too, rather than
to a peak that happened an hour ago. Before the run starts the window sits at
the beginning, so a scheduled ramp is visible as a plan.

It stays single-mode only: two panes run one clock but tell two stories, and a
shared axis would misrepresent both.

### Scenarios

Scenarios are a picker at the top of the side panel rather than a wall of cards —
nine descriptions pushed the tuning controls off the panel entirely — with the
selected one's description a ⓘ away. Editing any knob switches it to
*— custom —* rather than keep claiming a scenario it no longer matches.

The tab opens on **RTB Fabric (prod)** — measured production configuration
rather than AWS-generic defaults: ten broker tasks serving 60K TPS in one AZ
(10K TPS/task at a 62% burst threshold, which lands on production's configured
`desiredCount` of ten), behind a step policy capped at +20% per decision with a
10-task `minAdjustmentMagnitude` and a 300s cooldown. Nothing is scheduled, so
it holds until you add demand.

It inverts the lesson of every scenario below it. ▲ RAMP's +500K over 30 min
takes eight scale-outs at one per five minutes to reach the ~91 tasks demand
needs — the ladder and its cooldown pace that, not the ~6-minute pipeline. Four
pipeline stages in it (`signalMs`, `launchMs`, `cloudInitMs`, `placeMs` — 105s,
about 28% of the total) have no counterpart in RTB Fabric configuration and are
carried over from the generic defaults; instrument them before quoting a total
pipeline latency.

**Steady baseline** is the same idea on the AWS-generic defaults — 50K TPS on
two instances, with nothing scheduled. It holds there until you add demand yourself
with ▲ RAMP or ◉ SURGE, which is the way to watch a single scale-out end to end
on the timeline. The rest run their ramp for you: four share the +1M-in-1-min
ramp and vary the pipeline, four share a +1M-over-30-min ramp and vary the
policy and bake.

- **RTB Fabric (prod)** — measured production config; you drive it.
- **Steady baseline** — 50K on the generic defaults, holding; you drive it.
- **Baseline ramp** — ~5-min pipeline vs a 1-min ramp. The policy orders the
  whole gap within two decisions, so pure pipeline latency is what is left.
- **Optimized pipeline** — warm pool / baked AMI collapses the per-stage lag;
  the loss drops by roughly three quarters.
- **Over-provisioned buffer** — a 35% target keeps ~3× the idle capacity ready
  and barely dents the loss: no affordable buffer covers a 10× jump.
- **Slow detection** — a 3-min detection dominates the lag (the breakdown bar
  makes it obvious).
- **Sustained ramp** — the same +1M over 30 minutes; the reference point for
  what a bake costs.
- **Long bake** — the sustained ramp with a 10-minute bake ⇒ ~3× the loss, same
  peak fleet.
- **Aggressive scale-out** — the sustained ramp at 1.3× gain: the deliberate
  over-order cancels the bake's under-counting, paid for in idle instances.
- **Step scaling ladder** — the sustained ramp under a flat-count step ladder;
  switch it to percentages and it collapses, because a percentage of the small
  fleet the bake still counts cannot chase a large add.

`npm test` covers the scaling engine too
(`src/scaling/engine/scalingSimulation.test.ts`): a calm start, a ramp that dips
then recovers and one gentle enough never to breach, more buffer / a faster
pipeline / a wider step ceiling / a shorter bake / a higher gain each reducing
the loss, the AWS step-scaling worked example, the decision-interval arithmetic,
and playback-speed determinism.

### Grounding (scaling specifics)

- Reference throughput: 100K TPS on 2× c7g.2xlarge ⇒ 50K TPS/instance, which is
  what the AWS-generic scenarios use. The **RTB Fabric (prod)** scenario instead
  uses RTB Fabric's own `BASIC_TPS_PER_INSTANCE` of 10K, commented in-source as
  conservative and varying with instance type, DSP response time and payload
  size. The two disagree 5×, and this single value scales the whole fleet —
  worth replacing with a measured number if you have one.
- The scale-up latency is the sum of real ASG/ECS stages — CloudWatch metric +
  alarm datapoints for detection, EC2 launch, cloud-init/user-data, ECS
  placement, container boot, health-check grace, and DNS registration + client
  re-resolution — typically ~5 min end to end.
- Sustained scale throughput is bounded by the scaling step size, the bake, and
  the max fleet, independent of the per-instance latency.
- Policy arithmetic, defaults, and rounding follow the AWS docs: target tracking
  is proportional to the metric; warming instances count toward desired capacity
  but not toward the capacity a policy scales from; `Cooldown` applies only to
  simple scaling (default 300s); ECS managed scaling defaults are
  `targetCapacity` 100%, `minimumScalingStepSize` 1, `maximumScalingStepSize`
  10000, `instanceWarmupPeriod` 300s. Warmup is a per-instance clock under both
  rule sets; ECS additionally blocks the next scale-out until every instance is
  warm. A policy acts at most once per 60s metric period. AWS suggests a 60–80%
  utilization target for workloads that burst.
- Scale-in, instance termination, and predictive scaling are out of scope —
  overshoot is reported but never reclaimed. ECS's fixed 15-minute
  post-scale-out scale-in hold is out of scope for the same reason.
