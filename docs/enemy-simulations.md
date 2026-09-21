# Enemy simulation suite

Run from the project directory:

```sh
npm run simulate:enemies
npm run simulate:enemies -- --seeds 10
```

`--seeds` accepts 1–100 and controls generated course count. `--output path/to/report.json` changes the main report location. The command exits unsuccessfully if a regression fails, a generated course collides or times out, or a replay fails to survive its recorded window. Catalog entries without checks are reported but do not fail the suite.

The default run writes `artifacts/enemy-suite.json`, plus separate normal/dasher course reports. The main report contains individual outcomes, progress, minimum clearance, turn counts, Shift use, planning times and a per-enemy coverage inventory. It explicitly lists `unvalidatedEnemyTypes`.

The report also includes `monumentalMigration`: the [MM video reference](monumental-migration.md), its family coverage, missing checks and outstanding mechanics. The user-reported 120-area repetition organizes this inventory; the suite does not simulate four complete MM runs.

| Validation              | What supplies the expected behavior                                                                   | What it establishes                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regression tests        | Recorded positions, manually derived geometric cases, public phase rules and explicit synthetic cases | Observation, movement, collision, timing and selected enemy behavior checks                                                                                |
| Normal/dasher courses   | Seeded synthetic enemy motion in `scripts/benchmark.js`                                               | End-to-end movement through simplified courses at 660 speed and 135 ms configured delay                                                                    |
| Wacky encounter replays | Enemy positions from the saved Area 16 recording, independent of the planner's forecast               | Survival and progress over a 1.03-second window, comparing broad fallback with learned patterns at input arrival one tick early, on time and one tick late |
| Catalog inventory       | The 143 enemy entries in `data/enemies.json`                                                          | Which families have checks, which Switch variants share those checks, and which types remain unvalidated                                                   |

The current default run passes 120 tests, six courses and six replay windows. In the on-time Wacky comparison, learned motion advances 620 units with two turns and no Shift, versus 498.3 units and five turns with the fallback. Both survive the window. Increasing seeds expands the normal/dasher courses; it does not add enemy families or extend the recorded replay.

124 enemy types currently have no separate family check. A checked family is also only partially validated: isolated mechanics, a short encounter or a shared base-family check cannot certify every variant, combination or level. The 88 projectile catalog entries do not yet have a separate per-type coverage inventory. Unknown enemy bodies still receive a generic forecast, which may miss special movement or attacks.

## Extending coverage

1. Identify the type in [the directory](enemy-types.md), then inspect its public schema/defaults and prediction routine. Area overrides and live values take precedence over defaults.
2. Record its phase fields and actual future positions over multiple complete cycles. Preserve changes of direction, wall contacts, player-dependent targeting, effects and projectile spawns. Label reconstructed or missing fields explicitly.
3. Add an independent expected trajectory or recorded encounter to `test/fixtures`, with regression assertions in `test/enemies.test.js` or a focused test file. Forecasts should be checked against held-out observations. A simulator that uses the planner's forecast as the enemy's true motion cannot reveal errors in that forecast.
4. Compare safe progress, clearance, collision rate and unnecessary turns across timings, initial phases and positions. Add mixed encounters after isolated mechanics agree with observations.
5. Add the family to the coverage mapping in `scripts/simulate-enemies.js` only once its checks exist. Preserve the distinction between forecast accuracy, short-window survival and a complete live clear.

Switch and Elite Star regressions reconstruct phase information absent from the old recordings. Slippery movement checks use recorded locked movement plus synthetic aura cases; the old recording lacks the aura radius. Pumpkin checks cover public phase behavior without claiming a faithful replay of its old death trace. These limitations are detailed in [the death analysis](recent-deaths.md).
