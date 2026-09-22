# Enemy simulation suite

Run from the project directory:

```sh
npm run simulate:enemies
npm run simulate:enemies -- --seeds 10
```

`--seeds` accepts 1–100 and controls generated course count. `--output path/to/report.json` changes the main report location. The command exits unsuccessfully if an active regression fails or a generated course collides or times out. Catalog entries without checks are reported but do not fail the suite.

The default run writes `artifacts/enemy-suite.json`, plus separate normal/dasher course reports. New reports identify `controllerProfile: "ravel-transfer-v1"`, contain individual course outcomes and movement/planning metrics, and explicitly list `unvalidatedEnemyTypes`. The catalog is used for reporting; the live controller does not load it.

The report also includes `monumentalMigration`: the [MM video reference](monumental-migration.md), its family coverage, missing checks and outstanding mechanics. The user-reported 120-area repetition organizes this inventory; the suite does not simulate four complete MM runs.

| Validation            | What supplies the expected behavior                                                                   | What it establishes                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Regression tests      | Recorded positions, manually derived geometric cases, public phase rules and explicit synthetic cases | Observation, movement, collision, timing and selected enemy behavior checks                              |
| Normal/dasher courses | Seeded synthetic enemy motion in `scripts/benchmark.js`                                               | End-to-end movement through simplified courses at 660 speed and 135 ms configured delay                  |
| Catalog inventory     | The 143 enemy entries in `data/enemies.json`                                                          | Which families have checks, which Switch variants share those checks, and which types remain unvalidated |

With three seeds the simulation command runs six normal/dasher courses. Regression tests also compare the new live models with independent functions extracted from the public client. The former broad Wacky learner remains disabled. Its source and historical results remain in the backup commit identified in [rollback notes](pre-wacky-rollback.md).

Family entries include Normal, Wall, Dasher, Homing, Icicle, Liquid, Turning, Slippery, Ice Sniper, Spiral and Zoning, with each entry naming its actual evidence. Zoning has recorded deceleration and short packet-gap checks; later turns remain unverified. Ice Sniper firing is an approximation, not verified server parity. Switch variants are not automatically counted under their base-family checks. The 88 projectile catalog entries do not have a separate per-type coverage inventory. Generic forecasts can miss special movement or attacks.

## Extending coverage

1. Identify the type in [the directory](enemy-types.md), then inspect its public schema/defaults and prediction routine. Area overrides and live values take precedence over defaults.
2. Record its phase fields and actual future positions over multiple complete cycles. Preserve changes of direction, wall contacts, player-dependent targeting, effects and projectile spawns. Label reconstructed or missing fields explicitly.
3. Add an independent expected trajectory or recorded encounter to `test/fixtures`, with regression assertions in a focused test file. Forecasts should be checked against held-out observations. A simulator that uses the planner's forecast as the enemy's true motion cannot reveal errors in that forecast.
4. Compare safe progress, clearance, collision rate and unnecessary turns across timings, initial phases and positions. Add mixed encounters after isolated mechanics agree with observations.
5. Add the family to the coverage mapping in `scripts/simulate-enemies.js` only once its checks exist. Preserve the distinction between forecast accuracy, short-window survival and a complete live clear.

The user authorized the [Ravel-to-live port](live-port.md). Preserve OOH/Catastrophic Core behavior when adding mechanics; retain the distinction between native-client parity, recorded-window survival and a complete live clear. Historical enemy analyses remain in [the death analysis](recent-deaths.md).
