# Training in Ravel

For visible assisted play with P/Escape and manual takeover, use `npm run ravel:play` or `npm run ravel:play -- --attach`; see [browser assist](ravel-assist.md). The commands below remain offline evaluation/training.

The MM runner executes the pinned Ravel engine without rendering or a browser connection. It runs our existing planner, motion tracking, navigation, movement commitment and Candy policy against real simulator collisions. It can repeat an individual area or carry player state through a continuous range.

The [Ravel checkpoint](../data/ravel-policy.json) enables avoidance of backward exits. It improved selected-area training clears from 22/24 to 24/24 and separate validation clears from 23/24 to 24/24, preserving every baseline success. See the [parameter search](../artifacts/ravel/mm-training-01/report.json).

**Areas 420–480 cleared continuously with zero deaths**, reaching victory area 481 in **405.92 simulated seconds (6m 45.92s)** on seed 20001. This direct start follows the user's request to stop restarting the full course. The [verification](../artifacts/ravel/mm-420-480-01/verification.json) confirms all 62 consecutive area visits and matching physical and full-observation replays. The [run report](../artifacts/ravel/mm-420-480-01/report.json) records Candy, speed 17, automatic Candy/upgrades, maximum starting stats, 125 ms input delay and a fixed 50 ms compute allowance. Revision: `a6841643e4d2`. Planning p95 was 52.80 ms, with 514 measured allowance overruns that were not inserted into simulation time.

An earlier full attempt cleared 1–449 before dying in 450. Two prefix debug runs reached victory, combining earlier recorded inputs with a later policy. These results do not establish a fresh 1–480 clear with the final policy, success on every seed, or live Evades performance. The successful revision above predates the subsequent [live port](live-port.md); it identifies the tested historical source, not the current runtime hash.

Reproduce the requested range:

```sh
npm run ravel:eval -- --policy data/ravel-policy.json \
  --continuous --areas 420-480 --seeds 20001 \
  --compute-ms 50 --max-seconds 900
```

The following corrections came from reproducible failures. All model forecasts use current observations and geometry; they have no access to engine objects, future random values or actual future states.

| Mechanism | Correction and evidence |
| --- | --- |
| Icicle | Forecast clamped wall contact, one-second pauses and restarts; [20/20 targeted clears](../artifacts/ravel/icicle-complete-model-01/report.json), including ten fresh cases. |
| Slippery | Predict aura entry, locked steering, normalized diagonals, ignored Shift and wall recovery; use two seconds of look-ahead. [20/20 targeted clears](../artifacts/ravel/slippery-holdout-01/report.json) across regression and fresh seeds. |
| Liquid | Forecast fivefold acceleration separately for each candidate player route; [24/24 clears](../artifacts/ravel/liquid-complete-01/report.json) across six areas and four seeds. |
| Command cadence | Align planned turns to the actual decision interval. A retained plan previously promised a turn one tick later although the runner could only submit it three ticks later; `test/fixtures/ravel-slip84.json` reproduces the error. |
| Wavy, Turning, Spiral | Model native angular phases, timed changes and wall reversals. Three-second forecasts agree with the native engine in 15 sampled areas; [Wavy trials clear 10/10](../artifacts/ravel/wavy-01/report.json). |
| Dasher | Move using the current speed before updating phase, and discard wall overshoot as Ravel does. Six-second forecasts agree with the native engine in areas 6, 10, 120, 240, 360 and 480. |
| Giant-enemy traps | Use 1.5-second look-ahead when a Dasher spans at least a quarter of the room height (four current MM rooms). A recorded area-360 regression rejects a short-horizon route whose exit closes; replaying the native approach then clears the room. |
| Ice Sniper firing | Predict the next shot from the current clock, detection range and each candidate player route. A one-tick radius allowance covers both native projectile-spawn schedules. Native timing tests pass, and [14/14 targeted cases](../artifacts/ravel/ice-sniper-holdout-01/report.json) clear across seven areas and two seeds. |
| Speed Sniper losses | Restore speed using the delayed native `1` key and available upgrade points while waiting in shelter. Lost stats are never reset directly. |

At the successful tail revision, all 153 tests passed with the pinned source installed. Independent testing also cleared all 120 final-block areas, 361–480: 116 combat areas cleared within 20 seconds, area 465 cleared in 32.45 seconds on an extended retry, and the three checkpoints cleared separately. These individual starts do not prove a continuous clear.

Training currently means **automatic search over planner parameters**, followed by evaluation on disjoint seeds. It saves a policy checkpoint. It does not train neural network weights or automatically rewrite enemy mechanics. Failures become deterministic replays for the next model/planner improvement. Ravel checkpoints are not loaded by the live controller.

## Setup and a first run

```sh
npm run ravel:setup
npm run ravel:eval -- --areas families --seeds 1-3
```

To evaluate the accepted checkpoint instead of the original baseline:

```sh
npm run ravel:eval -- --policy data/ravel-policy.json --areas families --seeds 20001-20003
```

Setup downloads source at commit `563f5434f68d07b2d70ede3f307f857157d42107` if needed, then checks SHA-256 hashes of every engine file used. It leaves an existing checkout intact and rejects altered source. Ravel's MIT license is preserved with the checkout. No Chrome or API key is required for offline runs.

`families` selects the first MM area containing each of 24 spawn families. These introductory encounters are a smoke test; later mixtures and difficulty blocks need separate runs.

Defaults are Candy at speed 17, maximum energy/regen and level-5 abilities, automatic Sweet Tooth, 125 ms input delay, 25 ms simulated computation, a 60 Hz engine step, and observations every two ticks. Candy is cast through input and must be collected before its actual boost appears. Basic is also supported. Other heroes are rejected until their observation adapters are implemented.

The runner stops on the first death, a backward exit, the intended forward exit, or the time limit. Easy mode's automatic respawn is never counted as a successful recovery. Continuous runs preserve stats, cooldowns, generated hazards and pending input across transitions; entering the victory area completes a 1–480 run.

## Train and validate

```sh
npm run ravel:train -- \
  --areas 30,45,105,120,240,360,475,480 \
  --seeds 1-3 --validation-seeds 10001-10003 \
  --candidates 5 --compute-ms 50 --max-seconds 15
```

Each run prints its output directory under `artifacts/ravel/`. `--output <directory>` chooses an explicit destination; use a fresh directory to preserve prior experiments.

The search evaluates the starting policy and bounded alternatives for collision margin, prediction horizon, beam width, turn commitment and avoidance of backward exits. `--candidates 8` exercises every alternative. The backward-exit candidate lets the player retreat within the entry shelter but treats its backward portal as a planning barrier; the simulator's real geometry is unchanged.

The objective ranks completion count first, then clear time. Failed attempts incur the full time allowance plus a penalty; dying quickly cannot improve the score. The training winner is selected before any validation seeds are run. It is accepted only if it improves the validation score and preserves every validation case the baseline cleared. A failed gate retains the starting policy. A checkpoint is written either way and records the gate result.

Use `--policy <checkpoint.json>` to start another search or evaluation from saved parameters. Use fresh validation seeds for subsequent iterations; repeatedly adapting to the same held-out set eventually makes it training data.

```sh
npm run ravel:eval -- \
  --policy artifacts/ravel/EXPERIMENT/checkpoint.json \
  --areas 1-480 --seeds 20001-20003

npm run ravel:eval -- \
  --policy artifacts/ravel/EXPERIMENT/checkpoint.json \
  --continuous --areas 1-480 --seeds 30001 --compute-ms 50 --max-seconds 3600
```

An individual-area suite reconstructs the hero at each start. It cannot establish that energy, cooldowns and movement state will remain viable across a complete run. The continuous evaluation addresses that separately.

## Failure capture and replay

Each evaluation directory contains `results.json` and one trace per area/seed. A trace includes the source and controller hashes, full configuration, submitted actions and timing, recent observations, and initial/final state digests. `report.json` records completed evaluations, training selection, validation results and any infrastructure error. Traces are local artifacts and are excluded from Git.

```sh
npm run ravel:eval -- \
  --replay artifacts/ravel/EXPERIMENT/baseline/area-480-seed-1.json
```

Replay resets the engine and replays recorded actions without running the planner. It compares the outcome and physical observation digest, with a nonzero exit code on mismatch, and separately reports whether the full observation matches. New forecast annotations can therefore be added without invalidating an old physics replay. Projectile IDs are assigned at spawn, so observing less often does not change their identity. Exact digests require compatible runtime math; current traces record Node/V8/platform versions. A four-area Node/Chrome comparison agreed within 9e-13 in the sampled numerical fields, but cross-runtime bit-for-bit identity is not promised. Replay confirms reproducibility; it does not validate the policy on another seed.

To verify every transition in a completed run:

```sh
npm run ravel:verify -- \
  --trace artifacts/ravel/EXPERIMENT/baseline/area-1-seed-20001.json \
  --output artifacts/ravel/EXPERIMENT/verification.json
```

The verifier requires consecutive visits from the configured starting area through the exit after its final area, no deaths, a matching physical replay, and a fresh run in which one policy planned every action. It saves area split times and reports `requestedRangeVerified` separately from `fullCourseVerified`, which requires the entire 1–480 course. A debug run assembled from a recorded prefix cannot pass the fresh-policy check.

To investigate a late failure quickly, replay the previous inputs up to the failed area and resume planning there:

```sh
npm run ravel:eval -- \
  --policy data/ravel-policy.json --continuous --areas 1-480 \
  --seeds 20001 --compute-ms 50 --max-seconds 3600 \
  --prefix artifacts/ravel/PRIOR-RUN/baseline/area-1-seed-20001.json \
  --resume-area 360 --output artifacts/ravel/PREFIX-DEBUG
```

Prefix debugging still runs every native physics tick from the original reset. It preserves accumulated stats, cooldowns and queued inputs, and rejects incompatible reset/timing configurations. The report labels this `prefix-debug`; its trace records the prefix provenance. Use a fresh full attempt after fixing the failure.

## Timing and coverage limits

Trials use a fixed computation allowance so policy comparisons are deterministic. Simulation time advances while that allowance and the configured input delay elapse. Input jitter is deterministic, separate from enemy RNG, and preserves command order. The policy receives nominal pending input times rather than the future jitter samples.

The runner separately measures actual planning time and reports p95 and computation-budget overruns. **Those measured overruns are not added to simulated delay.** A clear with overruns is therefore not evidence of equivalent live performance. Use a sufficient `--compute-ms` allowance, then perform a real-time integration check before transferring a checkpoint to live play. Fixed search effort differs from the live controller's wall-clock search deadline.

Additional cases should vary `--jitter-ms 25`, `--warmup-ticks 120`, `--entry-y 0.2`, `--hero Basic`, and `--no-candy`. Current training uses one such configuration per invocation; it does not claim validation across untested combinations. Defaults start at maximum stats and restore lost speed using available upgrade points while waiting in shelter. Use `--no-upgrades` to preserve projectile losses.

The adapter exposes present geometry, movement, effects, current projectiles and native phase telemetry. The offline runner and Ravel browser assist share the observation conversion and Ravel-specific movement/enemy models. Evades uses its separate production adapter.

Known gaps include future firing by other projectile families, changing Sizing radii, several other enemy phase transitions, and the acceleration from a previously inactive Candy pickup. A separate speed-13 Slippery suite clears 9/10 cases: area 324, seed 33001 fails when its first Candy pickup accelerates it immediately before aura entry. A late-game prefix debug run also died in area 455: a newly fired Ice Sniper projectile appeared only 100 ms before freezing the player, inside the configured 175 ms input-plus-compute window. See the [failure review](../artifacts/ravel/ice455-review.json). The new Ice Sniper forecast addresses this class of delayed warning; other shooters do not yet have this model. One completed seed would not establish success on every seed, build or starting condition. Ravel also differs from live Evades; see the [source audit and calibration plan](mm-training-plan.md).

`npm test` includes Ravel reset, input-delay, collision, Candy, transition, projectile-replay and training-gate checks. Engine integration checks explicitly skip when the pinned source has not been installed; run `npm run ravel:setup` first to exercise them.
