# Evades.io + Jev

An experimental browser controller for [Evades.io](https://evades.io). **Its objective is to finish areas as quickly as possible by moving right while surviving.** It uses full speed whenever the predicted route is clear and selects Shift temporarily when a dodge needs finer movement. There is no automatic permanent-Shift threshold.

The controller reads the game state already present in the browser and presses ordinary keys through Playwright. A local planner handles immediate motion; optional Jev choices are checked against the latest predictions. This is a model-assisted controller, not a trained Evades policy.

The live controller now uses the adapted [Ravel improvements](docs/live-port.md): Icicle pauses, Liquid acceleration, Turning curves, Slippery steering, impending Ice Sniper shots, longer lookahead around giant Dashers, and turns spaced to the measured command cadence. The startup profile is `ravel-transfer-v1`. Existing Switch/Spiral, latency, Candy and rescue fixes remain. Live mechanics are checked against the public client; Wavy phase timing and complete live MM clears remain unverified.

The latest [WW19 fix](docs/recent-deaths.md) learns observed Zoning deceleration and keeps checking scheduled dodge turns during short packet gaps. Repeated browser reads preserve the original game-state timestamp; they cannot make old positions appear fresh. Zoning's later turn direction and timing remain unverified.

## Run

For **assisted play in the Ravel browser game**, run:

```sh
npm run ravel:play
# Or attach to the Ravel tab already open in Chrome:
npm run ravel:play -- --attach
```

Choose **Candy or Basic (Normal)**, enter the game, then press **P** to toggle assist. **Escape** or **WASD** pauses for manual control. After a death, assistance stays paused until you press P again, including Ravel's immediate Easy-mode respawns. **R** keeps its native Ravel action and pauses assistance before a manual teleport. Ctrl+C releases keys and disconnects; attach leaves the tab open. The new-browser command uses a separate Ravel Chrome profile.

Use **FPS Limit 60**, **Input Delay 0**, **Tick Delay 0**, normal game speed, mouse steering off, and default arrow/Shift/X/1 bindings. Candy consumption and safe-zone speed upgrades remain automatic. Other heroes and timing configurations pause with an explanation. The mode uses Ravel's trained planner settings and native phase models, observes the current area without resetting it, and advances through the browser's ordinary game loop. There is no simulated network delay added. It is separate from offline training and the Evades profile; see [Ravel browser assist](docs/ravel-assist.md).

For offline MM practice and parameter training, see [Ravel training](docs/ravel-training.md). The requested continuous 420–480 run reached victory with zero deaths in 6m 45.92s of simulated time. That result uses fixed simulated delay and does not certify a live clear. `npm run ravel:train` searches planner settings on separate training and validation seeds. The live port adapts the transferable mechanics; it does not load simulator state or phase clocks into Evades.

Requires Node 22+ and Google Chrome.

```sh
npm install
npm run baseline
```

Join a game, select a hero, click outside chat, and press **P**. P starts/pauses, Escape stops movement, and Ctrl+C quits. WASD pauses the controller for manual steering; release those keys before resuming with P. Switching windows, opening menus, spectating, death, or stale updates suspends movement. Use the game's default arrow, Shift, and numeric upgrade bindings.

While running, click **Rescue nearest (R)** in the top-right corner or press **R** to approach the nearest downed, revivable player in your current area. The button appears when a rescue is available. The bot keeps dodging and avoids area exits during the rescue, then resumes the run after the target revives or disappears. Click **Cancel rescue** or press **R** again to cancel. P, Escape, manual takeover, death and area changes also cancel the rescue. Enable the controller with P before using rescue.

Clear rescue approaches release each axis as it lines up with the person, then brake near contact. Those planned turns retain their server-tick deadlines while fresh hazard checks remain safe, reducing overshoot and repeated corrections. Switching between rescue and running preserves the current input; pauses and emergency stops still release it.

Status appears in the terminal and session logs. The controller keeps its page state through Playwright object handles, without adding named agent globals. The rescue button is its only in-game overlay. Reloading the page reconnects paused. Emergency key releases remain in place, including the 1.5-second controller heartbeat timeout. These changes do not conceal movement patterns, emergency synthetic events, or other browser automation signals, and do not establish that automation is undetectable.

The default direction is right. Automatic speed upgrades are spent only in safe zones, up to **510 world units/second = 17 in the legacy HUD**. `--max-speed` limits stat spending only; it does not force Shift when you manually upgrade above it.

Candy uses **Sweet Tooth (X)** automatically when its boost has at most three seconds left or energy is at most half full, provided the ability is unlocked, enabled, off cooldown, and affordable. Starting or changing the boost waits for a safe zone; refreshing the same boost works while moving. The controller waits for temporary Shift dodges to end before pressing X. It reads confirmed consumption and the boost timer from the game, and forecasts expiry. This uses the default X binding and does not chase candy dropped elsewhere. Disable it with `--no-candy`.

```sh
npm run baseline -- --max-speed 510
npm run baseline -- --no-upgrades
npm run baseline -- --heading up --duration 60
```

Restart the CLI after a code change; an already running process keeps its loaded version.

For Jev, copy `.env.example` to `.env`, set `TYPESAFE_API_KEY` using [TypeSafe's console](https://console.typesafe.ai/), and run `npm start`. The key stays in Node and is sent only to TypeSafe. Usernames, chat, cookies, and credentials are not sent to the model. `npm run inspect` observes without controlling or making model calls.

If Chrome is unavailable, install Chromium with `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`. The browser uses the separate `.browser-profile/` directory. Complete any normal login verification in that window.

### Use Chrome you opened yourself

If guest login works in your normal Chrome but stalls in the launched browser, you can connect to the existing game tab:

1. Open Evades in Chrome and log in normally. Keep one Evades game tab open.
2. In another tab, open `chrome://inspect/#remote-debugging` and enable **Allow remote debugging for this browser instance** (Chrome 144 or newer).
3. Run `npm run baseline -- --attach`, then accept Chrome's connection prompt.
4. Return to the game, choose a hero, and press **P**.

Attach preserves the existing page and its login session. Ctrl+C releases the controller's keys, removes its listeners, and disconnects while leaving Chrome open. Status remains in the terminal. Chrome displays its own debugging indicator. This uses Chrome's [supported connection workflow](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session); it does not guarantee that the site will continue accepting an automated session. Live guest login through this workflow still requires manual verification.

For a browser already exposing a local debugging port, use `npm run baseline -- --cdp-url http://127.0.0.1:9222`. This is an alternative to `--attach`; both modes require an existing Evades tab and do not reload it. The default command still launches the separate `.browser-profile/` browser.

## Movement and timing

- Target a 60 Hz loop. Observation and controls share a browser call, and status updates share the pause check. Actual loop and planning times are recorded.
- Rebuild routes at 5 Hz using a grid of positions and arrival times, with hazard forecasts approximately 2.4 seconds ahead (bounded to 48 time slices). Compare detours and waits at their expected arrival times, using per-axis diagonal speed, slowing auras, zone speed limits, and Candy expiry. Keep a small preference for the previous lane. Necessary retreat counts toward escaping a pocket.
- Score each short dodge's endpoint against the route map at that endpoint's predicted time. Server-packet timestamps age a cached map, so reusing it cannot make a closing opening look newly available. The coarse map guides the route; the local planner still checks exact collisions and movement.
- First test the full-speed forward trajectory. If it has sufficient clearance and agrees with the route, use it directly. A straight trajectory also qualifies when it preserves the timed route's travel budget, even if a coarse waypoint bends sideways. Skip the turn search and model request for that clear advance.
- When a dodge is needed, search short turn sequences over 0.9 seconds after committed inputs. Full-speed, half-speed, sideways, retreat, and waiting actions remain available. Progress toward the exit is the objective; predicted collisions carry a large penalty.
- Reserve 18 ms for local dodge search after navigation finishes, or 8 ms when rechecking an aging packet. Check full fallback paths and the previous turn sequence first, then find cheap multi-turn escapes before widening the search. Stop optional branching at the deadline; never return an unfinished path as safe. Recheck timing once if the calculation finishes more than a server tick earlier or later than forecast. Mandatory collision checks and operating-system pauses can exceed this soft budget.
- Limit the first turn to approximately 66 units per axis (100 ms at 660 speed). Recheck the previously selected sequence with its original server-packet deadlines so repeated replanning cannot keep postponing its next turn. When all routes breach the safety buffer, penalize the clearance deficit strongly enough to favor an escape over a near-zero-clearance advance.
- If the usual search and retained plan have no buffered route, try additional Shift directions on later turns. Reuse the first segments, keep one follow-up per branch, and stop at the first buffered escape. Skip this pass when already queued movement is unsafe. A clear full-speed route still takes priority.
- Index predicted enemy sweeps and aura bounds by time and position. Keep exact checks for nearby threats, including fast crossings and large balls. Far-away clearance is a conservative bound once the score has saturated; candidates flag this as `clearanceCapped`.
- Defer discretionary direction changes while the previous command is still within the estimated input-delay window, provided both routes remain safe. Predicted danger, scheduled follow-ups, stalls and clear full-speed shortcuts override this settling period.
- Apply movement and Candy key changes in one browser call through ordinary keyboard events, together with the final pause/epoch check. Hold unchanged keys without resending them; release and press a reversal within the same event-loop task so input sampling cannot observe half the change.
- Keep a dodge for roughly 100 ms while rechecking safety on every fresh packet. New predicted impacts, walls, or substantial losses of clearance override that commitment immediately. Small score differences need a larger advantage to reverse direction or toggle Shift. Repeated packets trigger a bounded recheck after 25 ms, preserving scheduled turns and all inputs queued since the original capture. Packet age above 750 ms pauses movement.
- Once a focused dodge completes, release Shift along the same direction when the preferred full-speed plan improves clearance and immediate progress. The ordinary turn-switching threshold must not preserve a slower, worse route.
- Detect stalled movement and commands that only push into a boundary. Prefer a collision-checked escape that moves now, instead of repeatedly promising a turn in a later plan segment. Waiting remains available when no safe escape is predicted.
- After a short wait, take a similarly scored safe route that advances immediately instead of renewing the wait indefinitely. Preserve waiting when moving would breach the buffer, lose route progress, or give up a much better predicted opening.
- Replay recent key changes during the estimated command-to-observation delay. Fit that delay from movement, starting at 150 ms, and retain the calibration across area changes and pauses. Record key releases as queued commands; reset timing on a new server packet sequence. Cover timing uncertainty with a speed-dependent clearance buffer rather than shifting queued turns later.
- Apply each queued turn on the first server update after its arrival, matching latency fitting. Align browser and controller clocks using the fastest observation round trip, and date snapshots at capture. Include read lag and measured input overhead in the next command's timing budget.
- Model full per-axis keyboard speed, friction, safe zones, ordinary ball reflections, circulating wall balls, and dasher preparation, launch, deceleration, and rest. Slowing/freezing/withering auras affect predicted player speed.
- Keep harmless Switch bodies visible and reserve their collision geometry when the native countdown expires, with a one-tick allowance. Both local dodges and route planning use activation timing; bodies that remain harmless beyond the forecast horizon skip trajectory work. Missing countdowns grant no safe crossing.
- Fit Spiral and Spiral Switch curvature from at most nine recent native velocity observations, with newer observations validating the fit. Share the curved server-tick path between dodges and route planning. Gaps, stops and inconsistent observations discard the fit; other enemy families do not train it.
- Fit Zoning deceleration only after two consecutive intervals agree with both velocity changes and displacement. Apply speed changes before native-tick movement. Phase changes, long gaps and inconsistent observations discard the fit; the later perpendicular turn is not yet modeled.
- Keep a safety buffer at refuge entrances until a retreat is well inside shelter; a predicted stop barely across the boundary is vulnerable to input timing error. Wall balls clamp at each corner and move down the next edge on the following server tick, including in the coarse route forecast.
- Read active mouse/gamepad steering. Releasing all arrow keys can resume analog movement; the planner now predicts that movement instead of assuming `stay` brakes.
- Simulate homing enemies turning toward each candidate's player path, with their observed range, turn rate, speed, reverse flag, and stop/slow effects. Candidate branches keep separate enemy states. The coarse route map uses the current player position as its homing target.
- Share exact no-target homing motion until a candidate enters targeting range, then keep private pursuit state for that candidate. Spatial bounds include targeting range as well as collision radius. This avoids repeatedly simulating every distant pursuer during each dodge search.
- Preserve enemy stop/slow effects, including Sugar Rush, Spark, Stomp, poison, and Vengeance. Forecast timed expirations and keep dash phases advancing during a stop. If a dasher's measured motion contradicts its phase model, respect the measured suppression instead of assuming it moves out of the way.
- Use ordinary velocity/radius forecasts outside the supported live models and timed Switch activation. The [enemy directory](docs/enemy-types.md) is retained as reference data and is not loaded by the live controller.
- Reconcile commanded keys with the game's local held-key state and re-press a movement key if it drops.
- Include known Flow, Night, Stream, and candy speed bonuses before applying Shift. Do not fit latency across changes in speed bonuses or immobilization.
- Continue fitting latency inside known slowing fields by replaying their observed positions, applying each aura type once and retaining safe-zone immunity. Skip nearby fields with missing or changing parameters. Log the number of timing samples so a stalled calibration is visible.
- Derive player velocity from packet positions. The native local-player prediction velocity stayed zero in the recorded failure. Enemy tick displacement is converted using the server tick rate.
- Ask Jev at most four times a second when multiple safe choices exist. Reject stale answers and unnecessary waiting or slowing when a better safe advancing route is available. Full-speed forward shortcuts use the local controller immediately.

## Validation and diagnosis

Run the [enemy simulation suite](docs/enemy-simulations.md) with `npm run simulate:enemies` (or `npm run simulate:enemies -- --seeds 10`). It runs regression and public-client parity tests plus generated normal/dasher courses. New reports at `artifacts/enemy-suite.json` identify the `ravel-transfer-v1` profile and list the actual family checks. These partial checks do not establish survival against every enemy or a complete live level.

`npm test` covers movement, route planning out of pockets, crowded lanes, wall stalls, stable dodge commitments and emergency overrides, queued inputs, latency fitting, ability speed bonuses, dasher launches, full-speed progress after Shift, collision checks, upgrades, model guards, and pause/key release.

Seeded simulations at base speed 510 and 135 ms configured delay are saved in `artifacts/benchmark-speedrun-normal.json` and `artifacts/benchmark-speedrun-dash.json`. The simulator rounds delay to 60 Hz ticks. These tests are simplified courses, not completed live Evades runs. The recorded-frame performance comparison is `artifacts/profile-speedrun.json`.

The earlier speedrun revision cleared 6/6 normal-ball courses and 9/10 courses containing dashers at speed 17. One dasher course still ended in a collision. Across 201 calls on recorded death-trace frames, median planning time fell from 10.39 ms to 4.41 ms (95th percentile: 12.09 ms to 5.14 ms). Full live speedruns remain unverified.

The jitter fix is compared with the previous controller in `artifacts/benchmark-jitter-normal.json`: both cleared all six courses at speed 17 and 135 ms configured delay. Direction changes fell from 13.71 to 3.83 per second (72% fewer), with mean crossing time decreasing from 5.81 to 5.48 seconds. These are simulated results, not a claim that the recorded live death would have been avoided.

The paired dasher comparison in `artifacts/benchmark-jitter-dash.json` cleared 10/10 courses after the fix versus 9/10 before it. Both comparisons use the same planner and delay estimator; the new movement policy adds commitment and switching hysteresis. The benchmark records direction changes and reversals as well as survival and time.

The route-awareness pocket test in `artifacts/benchmark-navigation-pocket.json` starts inside a deep U-shaped obstacle. At speed 17 and 135 ms configured delay, the previous controller timed out after 20 seconds. The new controller backed out and reached the exit in 5.02 seconds. This demonstrates detour planning in a simplified course; it does not establish live survival against every enemy type.

The same revision cleared 6/6 normal courses and 10/10 dasher courses, recorded in `artifacts/benchmark-navigation-normal.json` and `artifacts/benchmark-navigation-dash.json`. These course sets do not cover all live hazards, network jitter, or hero mechanics.

The later Area 20 death (`death-1789974540548.json`) exposed a stopped-dasher prediction error. Enemy 1375 remained stationary during preparation, but the old phase forecast moved it away. The recorded-decision regression in `test/fixtures/stopped-dasher.json` and `artifacts/stopped-dasher-replay.json` shows the downward command changing from +10.05 pixels predicted clearance to -2.66 pixels, triggering an immediate rightward escape instead of finishing the dodge. This checks the observed failure mechanism, not full-run survival. Future traces include enemy effect timers and each candidate's closest predicted hazard and approach time.

The [recent death review](docs/recent-deaths.md) covers lost timing calibration in Area 12, unexpected movement after `stay` in Area 13, and the homing collision in Area 30. Recorded regressions exercise these failures. The homing path comparison and measured planning costs are saved in `artifacts/latest-death-review.json`; these checks do not establish full-run survival.

The subsequent Area 35 trace exposed 80–128 ms live planning times among 100 enemies and 22 slowing auras. Spatial indexing preserves the scored plans while reducing repeated distant collision checks. Paired local timings are in `artifacts/profile-area35.json` and `artifacts/profile-area16.json`. The dense-area fixture compares every candidate with the previous exhaustive planner, and boundary regressions cover fast crossings and large enemy radii.

The next Catastrophic Core deaths at 660 speed exposed tight-gap scoring and postponed turns. `artifacts/replay-clearance-matrix.json` compares both controllers against recorded enemy positions in two short encounters, with command arrival one server tick early, on time, or late. Both survived all 12 counterfactual windows; the updated controller's worst clearance was 24.9 units versus 4.1. These simulations do not reproduce every live input or establish full-run survival. `scripts/replay-encounter.js` supports one area with player-independent enemies and recorded slowing auras; it rejects homing encounters.

The later Area 22 death had 34 homing enemies and 60–100 ms live planning times during the final encounter. Lazy pursuit simulation and vector turn checks preserve all 510 compared candidates from its last 30 frames. Paired local planning improved from 41.48 to 22.97 ms median (`artifacts/profile-homing-dense.json`); browser and navigation time are excluded. The dense homing fixture checks against the previous exhaustive simulation. New death traces also retain other player positions to help diagnose homing target changes.

Area 26 then exposed repeated waiting beside frozen enemies near the top wall. The recorded wait regression now chooses an immediately advancing route with 41.3 units of predicted physical clearance before the long stall timeout. Homing enemies frozen throughout the entire forecast share a static collision path; they remain collidable. This preserves all 340 compared candidate results from that trace while reducing median local planning from 21.35 to 14.28 ms (`artifacts/profile-homing-trap.json`).

Two later traces exposed timing errors. Area 22's fatal upward reversal was simulated one update later than the latency estimator expected. Area 35's apparent drift included a roughly 79 ms delay between capturing and receiving the last snapshot. Corrected timing detects the actual colliders and finds earlier alternatives in recorded decisions. Regressions are in `input-tick-phase.json` and `snapshot-age.json`; the updated benchmark also uses update-end input arrivals. These checks do not establish survival of either complete live run.

The following Catastrophic Core 35 death stopped a retreat just outside the refuge and then crossed a wall ball rounding the top corner. The corrected corner forecast matches all recorded samples, and the retreat regression continues left instead of stopping near the boundary. Six short replay variants all survived with both versions, but the worst gap increased from 1.25 to 33.06 units (`artifacts/replay-refuge-corner.json`). This tests the local escape and retains full-speed progress when clear; it does not establish a complete speedrun.

```sh
npm test
npm run benchmark -- --seeds 6 --speed 510 --delay-ms 135
npm run benchmark -- --seeds 10 --speed 510 --delay-ms 135 --scenario dash
npm run benchmark -- --seeds 1 --speed 510 --delay-ms 135 --scenario pocket
node scripts/profile-planner.js --trace artifacts/death-1789972367756.json
```

Each session writes status, speed, planning time, loop time, input-delay estimate, action source, movement decision reason, time holding the current action, stall detection, route waypoint, route-planning time, and model usage to `logs/*.jsonl`. Logs also include a controller source fingerprint, observed held keys, native last-sent key state and sequence (not server acknowledgement), active analog input, per-decision key-change counts, and the queued inputs used for prediction. Snapshot age, observation round-trip time, and input overhead distinguish a late read from slow planning. A death saves the last 200 full observations and decisions in `artifacts/death-*.json`. The [earlier death diagnosis](docs/latency-fix.md) explains why input timing mattered; its permanent speed governor has since been removed. The [video review](docs/speedrun-review.md) records the speedrun observations that motivated turn planning.

## Remaining limits

Full-speed live reliability and complete speedruns are unverified. This agent can still die. The client internals may change. Homing retargeting between teammates, homing projectiles, many special attacks and force effects, enemy bounces off internal obstacles, irregular maps, and many hero-specific mechanics are incomplete. Sweet Tooth is the only automated hero ability; live automatic consumption still needs verification. Rescue targets one teammate in the same current area on request. Whole-world navigation is not implemented; ordinary running targets the farthest exit in the selected direction. No model was trained from the video.
