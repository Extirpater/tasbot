# Pre-Wacky rollback

Historical record: the user's subsequent Ravel-to-live port request supersedes this active-profile description. The current profile is `ravel-transfer-v1`; see [the live port](live-port.md). The broad period learner remains disabled. Validated live-specific models were added individually rather than restoring the old expansion wholesale.

Subsequent targeted exceptions: revision `e6eda42e4f39` restored Switch-body visibility and activation countdown checks after a Wacky Wonderland 36 death exposed the harmless-body omission. Revision `d4fd8dc24640` adds a bounded recent-curvature fit only for Spiral/Spiral Switch bodies after an Area 14 death. The broad period learner, uncertainty regions and other removed enemy models remain disabled. See [the latest death review](recent-deaths.md) for evidence and validation limits. The rollback details below describe the original rollback state.

The user requested restoring enemy handling from before the Wacky/MM expansion after reporting worse Ominous Occult Hard (OOH) and Catastrophic Core performance. The active CLI identifies itself as `Controller profile: pre-Wacky enemy handling`; logs and death recordings include `controllerProfile: "pre-wacky"`. The validated runtime revision is `7bc9234b634f`.

There are no persistent trained weights to reset. The rollback changes the live observer and planner. The removed pattern learner previously learned only from a few seconds of the current run.

## Provenance

The earliest Git commit already contained Wacky support. A saved source snapshot, `/tmp/tas-before-timed-navigation/`, predates that expansion. The restored observer and planner use this snapshot, with the earlier timed-route arrival/packet-age calculations and forward-route shortcut retained. The existing movement policy, including acceleration after Shift, is preserved. Navigation uses the simpler constant-radius enemy forecasts and swept collision checks again.

The complete newer implementation is preserved on local branch `backup/enemy-support-20260921`, pointing to `2b456478aa2927156e85a8b0be98481d978efd2d`. This branch was created before any rollback edits. No branch switch, hard reset, force push or source-history rewrite was performed. This is a reconstruction of the earlier behavior, not a byte-identical checkout of a historical pre-Wacky commit. The running project has no dependency on the temporary snapshot.

## Active behavior

- Removed the Wacky pattern learner, reachable-region fallback, Switch activation timing, Sizing/Turning phase forecasts, Slippery steering, Pumpkin phase forecasts and Star/Teleporting landings.
- Restored filtering of currently harmless enemies, fixed observed-radius collision geometry and the earlier normal/Wall/Dasher/Homing motion handling. Specialized enemies outside those models receive generic forecasts again; this deliberately gives up the newer models' coverage.
- Preserved timed navigation, committed-input prediction, snapshot-age compensation, latency calibration, Candy support, dense spatial indexing, focused recovery and acceleration after a dodge.
- Preserved Chrome attach, P/Escape/watchdog behavior, WASD manual takeover and repair of missing native arrow keys.
- Kept raw recordings, fixtures, catalog data and historical analysis. Removed the 24 specialized-model tests with the reverted implementations and moved their independent keyboard-repair check into the main tests. The active suite has 97 checks.
- Updated `simulate:enemies` to validate the restored controller's normal/dasher courses. It no longer claims to run or validate the removed Wacky model.

Restart the CLI to load the rollback:

```sh
npm run baseline -- --attach
```

## Validation

`npm test` passed all 97 active checks. `npm run simulate:enemies -- --seeds 3` also passed and cleared all six generated normal/dasher courses. Offline Chrome checks verified observation, harmless-body filtering, P start, Escape pause and controller disposal. Logs are in `artifacts/rollback-pre-wacky-tests.log` and `artifacts/rollback-pre-wacky/suite-validation.log`.

Paired replays compare the saved newer engine with the rollback on OOH 10 (`death-1790018040585.json`) and Catastrophic Core 35 (`death-1789980648310.json`), starting at frame 140 and varying input arrival by −1, 0 and +1 tick. Both engines survive all six windows, with the same progress, clearance, turn counts and Shift fractions. The windows cover only 1.17 and 1.83 seconds respectively.

| On-time replay       | Newer engine median planning | Rollback median planning |
| -------------------- | ---------------------------- | ------------------------ |
| OOH 10               | 11.75 ms                     | 8.67 ms                  |
| Catastrophic Core 35 | 20.06 ms                     | 15.66 ms                 |

These local measurements include route updates but exclude browser I/O, and use the same recorded command budget for both engines. They demonstrate reduced computation overhead in this paired run, not a measured increase in full-level completion rate. Results are in `artifacts/rollback-pre-wacky/replays.json`. Fresh live OOH/Catastrophic Core performance remains to be checked.
