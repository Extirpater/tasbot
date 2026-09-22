# Ravel improvements in live Evades

The live CLI now enables `ravel-transfer-v1` for both baseline and Jev modes. Restart the process, then enable movement with P:

```sh
npm run baseline -- --attach
```

Automatic Candy, full-speed movement, temporary Shift dodges, rescue R, manual takeover, P/Escape and input timing remain available. The controller uses the player's observed speed and bonus, including speed 17 plus Candy. The Ravel checkpoint remains a simulator artifact; the live adapter reads current browser telemetry.

## Mechanics and scope

| Mechanism | Live implementation |
| --- | --- |
| Icicle | Reads `wallHit`, `wallTimeLeft` and remembered movement. Clamps wall contact, reverses both axes and waits through the unlock tick. Handles internal wall corners. |
| Liquid | Reads activation, native base velocity and detection radius. Tests the next player position against the current enemy position, then moves with the previous activation multiplier. Simulates separately for each candidate; other visible players can also activate it. |
| Turning | Uses the public client's inferred turn magnitude/sign, rotates before movement, and reverses curvature on wall contact. Falls back when telemetry is missing or motion effects suppress the model. |
| Zoning | Learns deceleration from two agreeing observed intervals, checking velocity and displacement. Updates speed before movement at native ticks. Stops, turns, effects and inconsistent observations invalidate the fit; the later perpendicular turn remains unknown. |
| Slippery | Reads the aura, last movement and shield angle. Predicts lock, ignored Shift, normalized motion, delayed steering after stopping/wall contact, and wall boost. Uses two seconds of lookahead and respects Candy expiry. |
| Dasher | Preserves live phase-before-movement semantics. Large bodies spanning a quarter of room height get 1.5 seconds of lookahead and native-tick navigation samples. Ordinary Dasher navigation keeps its established behavior after a broader sampling change regressed progress in a delayed Cata replay. |
| Ice Sniper | Reads the release countdown and public projectile defaults (480 speed, 10 radius). Adds the next potential shot aimed at each candidate and other visible players, with one tick of spatial allowance. Existing freeze projectiles remain hazards even when marked harmless. |
| Command timing | Aligns follow-up turns to measured decision cadence, with hysteresis to preserve retained plans. Repeated packets preserve their first capture time and replan after 25 ms, including commands sent since that capture. Optional search uses 18 ms on fresh packets and 8 ms on repeats; 750 ms without a new packet pauses movement. Preserves calibrated delay near Slippery auras and rechecks timing. These budgets are not hard end-to-end latency caps. |
| Routing | Blocks backward portals during forward runs while leaving the entry refuge usable. Rescue keeps its existing same-area exit restrictions. |

The observer records serializable telemetry. `src/live-models.js` adds prediction callbacks only in Node, before navigation and local planning. Death traces keep raw observations plus model counts, horizon and command interval under `planning`; forecasting does not mutate game state. Runtime hashes now include the adapter.

The inspected [public client](https://evades.io/index.e75284cc.js) has SHA-256 `cb71f0d3aca1be25961c7e9bc3f789d9863e545753da65d996422fe3577c57b2`, matching the existing catalog. `test/fixtures/live-client-models.json` contains the independent client functions used in parity tests. No network, renderer or live game is executed by those tests.

## Validation

`npm test` includes native-client parity across 30/60 Hz, Icicle pauses/corners, Turning curves, Liquid activation, giant Dasher phases, coarse sampling, slide lock, delayed steering, Shift, wall boost, Candy expiry, forecasted Ice shots inside the response window, telemetry fallback and observer export. Existing rescue, latency, Switch, Spiral and Ravel checks remain.

The original port revision `cead0cca1cc2` passed **165 tests**. Both versions survived all six recorded OOH 10 / Cata 35 windows at −1/0/+1 tick input perturbations, with identical progress, minimum clearance, turn counts and Shift fractions. These windows last only 1.17 and 1.83 seconds. A wall-check optimization also matched the pre-port checker on 100,000 independent generated segment/rectangle cases.

The subsequent [WW19 correction](recent-deaths.md) passes **171 tests**. It matches two held-out Zoning positions within 0.01 units, where constant velocity misses by 15 and 21.375 units. In a 0.3-second recorded-position replay with three input timings, the old held input reproduces the collision at the latest arrival; the corrected controller survives all three with full forward progress. Zero optional-search budget also preserves a surviving follow-up. These checks do not establish a complete WW clear.

An interleaved profile measured OOH median total planning at **11.96 → 15.71 ms** (p95 **32.79 → 39.65 ms**), and Cata at **18.08 → 18.17 ms** (p95 **34.34 → 34.35 ms**). The adapter itself was below 0.07 ms at p95 in those samples. The extra backward-portal check adds work to ordinary routes; the port is a coverage improvement, not a general latency reduction. Synthetic twenty-enemy snapshots also showed occasional Ice navigation spikes. See `profile-paired.json` and `synthetic-profile.json` before interpreting this as a real-time guarantee.

Paired recorded-window checks and runtime profiles are in `artifacts/live-port/`. Reproduce one comparison with the saved pre-port snapshot:

```sh
node scripts/replay-encounter.js \
  --trace artifacts/death-1789980648310.json \
  --baseline artifacts/live-port/before/src --live --delay-ticks 1

node scripts/profile-planner.js \
  --trace artifacts/death-1789980648310.json --from-frame 140 \
  --baseline artifacts/live-port/before/src/planner.js --live
```

Recorded replays use independently recorded enemy positions and fixed command arrival times. They cover short encounter windows, not whole levels. They reject Liquid, firing, pursuit and Slippery observations because recorded paths cannot establish those counterfactual outcomes. The profiler includes model preparation, navigation and local planning, but excludes browser I/O; both profiles receive the same optional-search budget. The synthetic stress profile tests twenty enemies at a time, including Ice shots toward two other players, with fresh navigation on every sample.

## Remaining gaps

The public client does not expose Wavy or Zoning phase timers. Zoning's confirmed slowing phase is modeled, but its later stop duration and perpendicular turn are unknown: the forecast holds the stop position until another observation establishes motion. The existing bounded causal Spiral model remains; Ravel's hidden clocks are not copied into live play. Sizing, unknown phase changes and future shots from other projectile families still need live evidence.

Ice firing is an approximation: server target selection, area-specific projectile overrides, firing range and repeated shots have not been verified. Other players are projected from their current positions, so future retargeting can disagree. The source comparison verifies client prediction behavior, not perfect server physics. No new live MM clear or fresh Ravel 1–480 run was performed for this port.
