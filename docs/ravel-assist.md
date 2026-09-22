# Assisted play in Ravel

Run `npm run ravel:play` to open [Ravel](https://pifary-dev.github.io/ravel/) in a separate Chrome profile. To use an existing Ravel tab, enable Chrome remote debugging as described in the main README and run `npm run ravel:play -- --attach`. Keep one Ravel game tab open when attaching. Existing Evades tabs are not selected or navigated.

Choose Candy or Basic (shown as Normal), then Enter game. The controller uses your current map, area, stats and abilities; attaching does not reset a run, choose an area, or grant upgrades. Enable assist with **P**. You can move manually with WASD, which pauses assist; release your manual keys and press P to resume. Escape also pauses. Clicking into mouse steering pauses with an explanation. After death, including an immediate Easy-mode respawn, press P when you want to retry.

Ravel's **R/T/E**, End and safepoint keys keep their native behavior and pause assistance first. They are available only when the corresponding native game options allow them. P is reserved for assistance while attached, replacing Ravel's optional advanced timer shortcut. Rescue is unavailable in this single-player mode. Ctrl+C releases arrow/Shift/X inputs, removes controller listeners, and restores the update/death instrumentation. Attach keeps Chrome open; the new-browser command closes the browser it launched. Reload reconnects paused. A second Ravel controller is rejected; if a prior process crashed without cleaning up, reload the tab before attaching again.

Before entering the game, use:

| Setting | Value |
| --- | --- |
| Hero | Candy or Basic/Normal |
| FPS Limit | 60 |
| Input Delay / Tick Delay | 0 / 0 |
| Game speed | Normal (1×) |
| Steering | Keyboard; mouse movement inactive |
| Movement, slow, Candy, speed upgrade | Default arrows, Shift, X, 1 |

Max Stats and Max Abilities are optional native Ravel settings if you want to practice at full strength immediately. The controller otherwise uses your current stats and spends available speed points in shelter, up to legacy speed 17. It uses Sweet Tooth when available through the native X key; `--no-candy` and `--no-upgrades` retain manual control. It does not collect an ability you have not unlocked or rewrite game settings.

The startup profile is `ravel-assisted-v1`. The same shared observation conversion supplies the offline runner and browser mode, and the browser planner loads the accepted settings from `data/ravel-policy.json`. Ravel-specific Icicle, Wavy, Turning, Spiral, Dasher, Liquid, Slippery and Ice Sniper forecasts run before navigation and local dodges. Backward-exit avoidance and longer giant-Dasher/Slippery lookahead are preserved. This mode uses measured planning and input overhead with zero artificial network delay; it does not import the Evades latency estimate or the offline runner's fixed compute allowance.

The native browser loop retains control of simulation time. Small wrappers count completed updates, timestamp observations and capture death contact before Easy mode respawns; they call the original engine methods and do not advance extra ticks, change positions or suppress collisions. These wrappers are removed on disconnect. Pausing the assistant releases its inputs while Ravel's world continues running. Native game lag or browser rendering cost can still affect responsiveness.

Session records are under `logs/`; deaths use `artifacts/ravel-browser-death-*.json` with the profile/revision, state, queued inputs and candidate plans. They remain separate from Evades death recordings.

Validation includes browser attach selection, shared-model equivalence with the training runner, native movement and Candy input, P/Escape/WASD, R's native action, stale-command rejection, death/retry, unsupported settings, duplicate-controller rejection, reload and cleanup. An isolated headless Chrome smoke run attached the full CLI to the native game loop at MM420, seed 20001, with Candy/max stats, and reached 421 without a death. It stopped at that first transition; it was not another full run or proof of every level. Reports are in `artifacts/ravel-assist/`. The public engine scripts checked during implementation matched the pinned Ravel source used by training.
