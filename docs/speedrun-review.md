# Speedrun review

Reviewed September 20, 2026: [Vikenti — Evades.io cch solo as necro](https://www.youtube.com/watch?v=kboqhJkuUpM), uploaded May 5, 2020, duration 12:22. Review used sampled frames across the full video and a denser sequence around the area-10 boss. This is Central Core **Hard**, while the user's logs were Central Core. The game's balance and abilities have changed since 2020.

## Visible behavior and implementation implications

- Around **0:33–0:47**, the player enters boss area 10, uses the upper lane, moves below a large ball, returns upward, and reaches the exit. A planner limited to one long straight action cannot evaluate those sequences. The new planner searches turns and replans after each short input.
- The HUD shows speed rising from **12.5 to 13.5** around areas 9–10 and **17** by approximately **1:15**. Those are legacy speed units. The new bot spends speed points while fully inside safe zones; `--no-upgrades` disables this.
- Later frames show the player in safe zones between crossings, including area 39 before boss 40. Reaching shelter is useful progress and the bot should preserve the ability to wait or retreat.
- These observations do **not** establish the player's keyboard inputs. Shift movement was added because the current client explicitly supports half-speed focus, not because the video proves Shift was pressed.

## Current client checks

Read-only inspection of the public [Evades client](https://evades.io/) confirmed full movement speed on each keyboard axis, Shift focus at half speed, per-zone friction and minimum/maximum speeds, wall enemies rotating 90 degrees at corners, and the current speed cap of 510. The observer now distinguishes base speed from a safe-zone speed boost, reads slowing auras, and records ball type and full pre-death decisions.

No model was trained from the video. The new controller remains a local predictive planner with optional Jev choices. Hero abilities and several enemy movement patterns still require separate handling.

## Validation

`npm test` checks the mechanics and controls. `scripts/benchmark.js` supplies seeded courses with an independent tick integrator, bounce-angle perturbations, and delayed input. Saved paired results compare the previous controller snapshot with this implementation. The simulation omits homing, dashes, abilities, force effects, and networking jitter, so it cannot certify a complete live run. A fresh guest browser remained at login verification; the user's next run is the live validation step.
