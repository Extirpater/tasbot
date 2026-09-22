# MM simulation and policy development

Recommendation: combine a complete MM enemy inventory with a repeatable Ravel test runner, using live recordings to calibrate the simulator. The existing controller uses explicit movement predictions and planning; repeated play does not train persistent policy weights. The first useful loop is automatic trials, reproducible failure capture, targeted model/planner improvements, and regression checks.

The [offline runner and parameter-training loop](ravel-training.md) now implement seeded trials, delayed input, first-death capture, exact action replays, a training/validation split and saved Ravel-only checkpoints. This document preserves the source audit and broader implementation plan; it is not a claim that the bot clears all MM or transfers unchanged to live Evades.

## Verified on September 21, 2026

Audited [Ravel](https://pifary-dev.github.io/ravel/) at commit [`563f5434f68d07b2d70ede3f307f857157d42107`](https://github.com/Pifary-dev/ravel/tree/563f5434f68d07b2d70ede3f307f857157d42107), licensed MIT, copyright 2024 Pifary-dev. The local checkout and its license are under `artifacts/ravel-source/`.

- Its MM map contains areas **1–480 plus victory area 481**, with **24 initial spawn families**. Projectile families created during play are additional. Counts, radii, speeds, zones and mixtures are available for every area; class behavior is readable in `entities.js`.
- An isolated headless Chrome loaded all 481 areas and instantiated 12,661 enemy bodies in total across those initial states. This checks map loading, not level completion or every behavior.
- Two area-32 trials with the same seed, reconstructed player, reset load counter and 180 fixed steps of 16.667 ms produced identical recorded enemy/player states. A different seed changed the state. An intentional collision registered a death, with cheats disabled.
- The fixed-step probe bypassed rendering. This establishes a practical way to repeat encounters without real-time browser animation; planner throughput and full-run training speed have not been benchmarked.

Artifacts:

- [Complete extracted Ravel MM map](../artifacts/ravel-mm-map.json).
- [Per-area spawns and per-family inventory](../artifacts/ravel-mm-inventory.json), with source provenance and unconverted map units.
- [Feasibility measurements](../artifacts/ravel-feasibility.json) and [reproduction probe](../artifacts/probe-ravel.mjs). From the repository root, run `node artifacts/probe-ravel.mjs`; it uses the local Ravel checkout and a separate headless Chrome, then closes both its browser and local server.

## Fidelity must be measured

Ravel is a community implementation, not production server code. One concrete discrepancy is already measured: over a short phase, its default Spiral angular acceleration has magnitude **3.6 rad/s²**, while our recorded Wacky 14 Spiral has **7.200004 rad/s²**. The live measurement comes from `test/fixtures/spiral14.json` and the causal motion fit already used by the controller. This is evidence to calibrate the implementation, not proof that every MM Spiral has the same discrepancy. Changing every simulator speed by a global factor would be unjustified.

The old MM video inventory also visually identified tiny bodies in areas 96–100 as possibly Immune; Ravel explicitly spawns Normal, Dasher, Homing and Wall there. Neither source establishes current live identities in those areas. Preserve both sources' provenance until a live trace resolves the difference.

Before treating a family as validated, compare short simulator trajectories to held-out live observations: position, heading, changing radius, activation/firing times, collision response and player effects. Separate errors in the simulator from errors in the planner. Test plausible parameter ranges when live evidence is incomplete, and retain an explicit unverified status.

## MM coverage inventory

First appearances below come from the pinned Ravel map, not the live game. Later blocks change counts, sizes and speeds; use the actual area entry instead of assuming an identical encounter every 120 areas.

| Spawn family | First area |
| --- | ---: |
| Normal | 1 |
| Wall | 4 |
| Dasher | 6 |
| Homing | 11 |
| Slowing | 16 |
| Draining | 21 |
| Wavy | 26 |
| Zigzag | 28 |
| Spiral | 31 |
| Zoning | 32 |
| Oscillating | 36 |
| Switch | 42 |
| Sizing | 46 |
| Turning | 51 |
| Freezing | 56 |
| Sniper | 61 |
| Speed Sniper | 66 |
| Regen Sniper | 69 |
| Liquid | 71 |
| Icicle | 76 |
| Slippery | 82 |
| Ice Sniper | 86 |
| Radiating Bullets | 106 |
| Disabling | 116 |

The active planner has explicit handling for straight/bouncing motion, walls, Dasher phases, candidate-dependent Homing, observed slowing effects, impending Switch activation, and a locally fitted Spiral trajectory. Those features are not equivalent to full-area validation. Future projectile firing, other turning/phase changes, changing body sizes and player-status interactions remain priorities for the MM audit. The broad experimental enemy expansion was previously rolled back; any reintroduction must pass the existing OOH/Cata checks.

## Implementation order

1. **Build an environment adapter around the existing controller.** Provide `reset(area, seed, hero, stats)`, `observe()`, and `step(action, elapsedMs)`. Ravel's world/player objects differ from the live React state; the current browser connector cannot just be pointed at its URL. Convert coordinates, velocities, type IDs and phase telemetry explicitly. Share the production planner and movement policy. Restrict policy inputs to information available live; the environment can retain complete state for scoring and replay.
2. **Make resets and timing exact.** Recreate the player, area entities, RNG and ability/effect state; clear controller history and pending inputs. Freeze or explicitly set the area's load counter. Use a fixed simulation step plus an input queue and observation cadence representing live latency. Measure planner wall-clock cost separately so expensive searches cannot gain artificial reaction time.
3. **Establish baseline failures across the map.** Start with isolated families and representative areas, then all 480 areas. Include speed 17, actual Candy/hero boosts, worn-off boosts, multiple entry positions and enemy phases, and measured input-delay variation. Stop a trial at the first death, exit or timeout. Save the seed, source and policy hashes, pre-death observations, actions and timing so failures are one-command replays.
4. **Improve the failing mechanism and rerun.** Prioritize mismatched predictions and omitted attacks before changing global pathfinding weights. Tune parameters on a designated seed set, validate on separate seeds, and preserve each discovered failure as a regression case. A candidate update must also pass OOH/Cata and the existing live death replays.
5. **Optimize clear time once survival is reliable.** Rank candidates primarily by completion rate and failure risk, then elapsed clear time; track wasted reversals, excess path length, clearance and planning latency for diagnosis. A short wait or deliberate slower turn can yield a faster successful run. Maximum instantaneous speed alone is the wrong score for completing MM quickly.
6. **Validate continuous runs and transfer.** Clearing areas independently misses ability depletion, transition state and accumulated errors. Run full 1–480 attempts with state carried between areas, then check the improved policy on live recordings and controlled live trials. A hundred passing seeds is a useful first gate, not proof of a near-zero failure rate. Even 99% success on each of 480 independent encounters would imply only about 0.8% full-run success; actual outcomes may be correlated.

## Ravel reset and timing details

The [engine](https://github.com/Pifary-dev/ravel/blob/563f5434f68d07b2d70ede3f307f857157d42107/game.js) exposes `game.inputPlayer(...)`, `game.update(time)` and `Area.load()`. The probe used these without starting animation.

- `Area.load()` reseeds with the configured seed, area-name hash and load count. Enabling `seeded_area_resets` increments that count, giving a deterministic sequence of different states rather than repeating the same state. Built-in `speedrun_mode` skips this seeded reset path.
- A safepoint restores player location, not the complete enemy, RNG, cooldown and input state. It is insufficient for controlled comparisons by itself.
- Default UI FPS is 60. Several physics formulas normalize elapsed time to 30 Hz, and the tick-delay UI text mentions 33 ms. Record actual elapsed time and queue length instead of inferring timing from that label.
- Defaults include cheats enabled and Easy respawning. Explicitly disable cheats and stop on the first death counter increment; otherwise an eventual area exit could conceal failed attempts.
- A sandbox controller should avoid reusing live hotkeys without remapping: Ravel already uses R for skipping areas and P for an advanced timer control.

A learned policy can be evaluated later using this same environment, if explicit models and planning plateau. Building and calibrating the runner first gives either approach a measurable development loop and avoids training against simulator mistakes.
