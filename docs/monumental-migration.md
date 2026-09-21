# Monumental Migration reference

The supplied [Fortish run](https://www.youtube.com/watch?v=wnRV3TGMMsA) is a Rameses run through MM 120, published May 1, 2019. I reviewed 102 frames sampled about ten seconds apart, including the area labels. The video and nine contact sheets are saved under `artifacts/mm-reference/`; [the frame index](../artifacts/mm-reference/frame-areas.json) records approximate timestamps and recognized area numbers.

[The machine-readable reference](../data/monumental-migration.json) groups enemy families for simulation coverage. Its early groups are also supported by current live entity IDs from the user's logs through area 44. Later identities are visual matches against public-client colors and observed behavior, and still need current telemetry confirmation. Each range summarizes several encounters; it is not an exact spawn list for every area.

| Areas in the first 120 | Main families to exercise                             | Video example, approximately                                |
| ---------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| 1–5                    | Normal; Wall joins the mix                            | [0:45](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=45s)   |
| 6–10                   | Dasher, Normal, Wall                                  | [0:55](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=55s)   |
| 11–15                  | Homing mixed with Normal/Dasher                       | [1:05](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=65s)   |
| 16–20                  | Slowing fields with Homing/Dasher                     | [1:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=95s)   |
| 21–25                  | Draining fields, then Homing                          | [2:15](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=135s)  |
| 26–30                  | Wavy/Zigzag with aura and Homing mixtures             | [2:45](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=165s)  |
| 31–35                  | Spiral/Zoning, with other moving bodies               | [3:25](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=205s)  |
| 36–40                  | Oscillating, Normal, Homing                           | [4:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=275s)  |
| 42–45                  | Switch with Normal/Homing; area 41 is a checkpoint    | [5:05](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=305s)  |
| 46–50                  | Sizing with Slowing/Homing; very large boss bodies    | [5:55](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=355s)  |
| 51–55                  | Turning                                               | [6:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=395s)  |
| 56–60                  | Freezing fields with Normal/Homing                    | [7:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=455s)  |
| 61–65                  | Sniper bodies and their projectiles                   | [8:15](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=495s)  |
| 66–70                  | Speed Sniper; Regen Sniper joins the mix              | [8:55](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=535s)  |
| 71–75                  | Liquid                                                | [9:25](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=565s)  |
| 76–80                  | Icicle with Normal; large boss bodies                 | [10:05](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=605s) |
| 82–85                  | Slippery fields with Normal                           | [10:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=635s) |
| 86–90                  | Ice Sniper with Normal and slowing/draining fields    | [11:15](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=675s) |
| 91–95                  | Mixed Liquid, Icicle, Freezing and Ice Sniper         | [12:15](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=735s) |
| 96–100                 | Tiny black bodies, visually consistent with Immune    | [12:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=755s) |
| 101–105                | Mixed Wavy, Zigzag, Spiral, Zoning, Oscillating       | [13:25](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=805s) |
| 106–110                | Radiating Bullets and Normal                          | [14:25](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=865s) |
| 111–115                | Regen/Speed Sniper mixtures                           | [15:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=935s) |
| 116–120                | Disabling fields with other bodies; large boss bodies | [16:35](https://www.youtube.com/watch?v=wnRV3TGMMsA&t=995s) |

Wall enemies occur throughout most groups. A camera viewport can omit enemies that are elsewhere in the area; absence from a sampled frame does not prove absence from the area.

## Repetition through 480

The user reports that the type sequence repeats every 120 areas through 480. The reference records the four blocks, 1–120, 121–240, 241–360 and 361–480, as a way to group future tests. This video only supplies the first block. A repeated family must still be tested with each later area's actual radii, speeds, counts, phase offsets, auras and projectile behavior. Checkpoints and boss mixtures prevent using a simple modulo formula as a complete spawn table.

The runtime continues to read every observed enemy rather than using this historical reference to select threats. No numeric difficulty multiplier or open-loop key sequence is taken from the video.

## Simulation priorities exposed by the video

1. **Attacks that have not spawned yet.** Existing projectile tracking starts once a projectile exists. Snipers and Radiating Bullets need firing-phase observations, spawn geometry, targeting and effect checks. A safe path past the shooter can become unsafe after it fires.
2. **Liquid and Icicle phase changes.** Their current fallback bounds use observed speed. That does not establish unseen acceleration, stop/turn timing or complete trajectories.
3. **Interactions with abilities and stats.** Draining, Disabling and projectile effects require energy, ability and speed-state checks. Tiny black bodies need current type-ID confirmation before assuming their immunity behavior. Rameses' successful path is not proof of a safe path for a different hero.
4. **Mixed encounters across difficulty settings.** Preserve the existing movement/phase checks, then vary density, radius, speed, phase offset and latency independently. Add MM recordings as ground truth before claiming an area or repetition is validated.

`npm run simulate:enemies` includes an MM coverage inventory in its report. It links these groups to existing family checks and explicitly lists the missing ones and outstanding mechanics. Reviewing a video does not add a passing behavior test.
