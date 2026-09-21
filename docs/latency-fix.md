# Diagnosing the area-12 death

Historical diagnosis: the later speedrun update removes the permanent speed governor described below. Full-speed movement is now available at every stat level, Shift is chosen per dodge, and latency is fitted without adding jitter to the queued command timeline. Timing uncertainty instead increases the clearance buffer.

Source: `artifacts/death-1789972367756.json` and `logs/2026-09-21T06-30-23.647Z.jsonl`.

The last 200 decisions were all in Central Core area 12 at base speed 450. Median planning time was 9.55 ms (95th percentile 10.74 ms); the median loop interval was 25 ms (95th percentile 26 ms). The log recorded zero Jev calls. The player was hit by a dasher, entity 1612.

Matching recorded key changes against subsequent positions gives a best fit of approximately 135 ms from decision logging to observed movement. This includes planning and key delivery. Estimating delivery as log time plus measured planning time plus 3 ms gives a best command-to-observation fit of 125 ms. Delivery was not timestamped in this older trace, so these are estimates, not direct network RTT measurements. The new code logs observation and key-delivery timestamps separately.

The old planner assumed 50 ms and held only the latest direction during that delay. In the final sequence it selected `down_right` while the server observations still reflected earlier upward and rightward commands. Player `_pred` velocity was zero in all 200 frames, so its initial momentum was also wrong.

## Changes

- Stop automatic speed upgrades at 300 by default. At higher base speeds, restrict both immediate and future planned inputs to Shift movement; at 450 this means 225. Jev cannot choose a full-speed input that was excluded. `--max-speed` controls this threshold.
- Derive player momentum from position differences using server packet time.
- Begin with a 150 ms delay estimate. Fit subsequent estimates from recent observed turns, then allow another input frame for jitter. Replay the full queued input history before the newly selected action can take effect, including planning time. Reset history on pause or area change.
- Keep the 0.9-second planning horizon after the pending inputs, so a long delay cannot consume the first selectable movement entirely.

Unit tests cover pending inputs, latency fitting, speed upgrades, model-choice restrictions, and existing movement/control behavior. The simulation includes delayed commands and uses the same online timing estimator as the CLI. These checks do not prove a full live clear. Dasher acceleration cycles and other special enemy behavior remain incomplete.

In six seeded courses at base speed 450 with 135 ms configured delay (rounded to simulation ticks), the previous controller cleared two and collided in four. The updated controller cleared all six using half-speed movement, taking 10–11 seconds versus about 5 seconds for the previous controller's successful runs. Median planning time was about 7 ms, versus 12.5 ms before. Results are saved in `artifacts/benchmark-latency.json`; the changed speed threshold and timing model were evaluated together.
