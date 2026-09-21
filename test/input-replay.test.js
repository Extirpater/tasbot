import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advancePlayer, planActions, bestAction } from "../src/planner.js";
import { InputTiming, ObservationClock } from "../src/timing.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test("releasing directions resumes active pointer steering; arrows override it", () => {
  const { state } = fixture("pointer-drift");
  const p = { ...state.player, mouseInput: { x: 300, y: 0 }, vx: 270, vy: 0 };
  assert.equal(advancePlayer(p, "stay", p, state.area).vx, 540);
  assert.equal(advancePlayer(p, "focus_left", p, state.area).vx, -202.5);
  assert.equal(
    advancePlayer(p, "stay", { ...p, mouseInput: null }, state.area).vx,
    67.5,
  );
  assert.equal(
    advancePlayer(p, "stay", { ...p, mouseInput: { x: 0, y: 0 } }, state.area)
      .vx,
    0,
  );
  // Analog input within 150 units of center scales the speed ceiling too.
  assert.equal(
    advancePlayer(p, "stay", { ...p, mouseInput: { x: 75, y: 0 } }, state.area)
      .vx,
    270,
  );
});

test("Area 13 no longer treats active mouse drift as a safe stop", () => {
  const f = fixture("pointer-drift");
  const timing = new InputTiming();
  timing.delayMs = f.recordedDelayMs;
  for (const command of f.commands) timing.record(command.action, command.at);
  const options = {
    previousAction: f.previousAction,
    ...timing.pending(f.observedAt, f.extraMs),
    firstSegmentTime: 0.15,
  };
  const before = planActions(f.state, options);
  assert.ok(before.find((c) => c.action === "stay").physicalClearance > 30);
  // Mouse coordinates were missing in the old log. Check the observed drift
  // hypothesis explicitly, without representing this as a complete live replay.
  f.state.player.mouseInput = f.inferredMouseInput;
  const after = planActions(f.state, options);
  const stop = after.find((c) => c.action === "stay");
  assert.ok(stop.physicalClearance < -5);
  assert.equal(stop.closestHazard, 238);
  const escape = after.find((c) => c.action === bestAction(after));
  assert.notEqual(escape.action, "stay");
  assert.ok(escape.physicalClearance > 30);
});

test("Area 12 retained calibration rejects the recorded late downward dodge", () => {
  const f = fixture("area-delay");
  const retained = new InputTiming(),
    discarded = new InputTiming();
  let lastArea;
  for (const row of f.warmup) {
    const sample = Object.fromEntries(f.columns.map((key, i) => [key, row[i]]));
    const state = {
      packet: sample.packet,
      tickRate: f.state.tickRate,
      area: f.areas[sample.areaId],
      player: {
        ...f.state.player,
        ...Object.fromEntries(
          f.columns.slice(5).map((key) => [key, sample[key]]),
        ),
      },
    };
    if (sample.areaId !== lastArea) discarded.reset();
    lastArea = sample.areaId;
    for (const timing of [retained, discarded]) {
      timing.observe(state, sample.observedAt);
      timing.record(sample.action, sample.appliedAt);
    }
  }
  retained.observe(f.state, f.observedAt);
  discarded.observe(f.state, f.observedAt);
  assert.equal(discarded.delayMs, 150);
  assert.equal(retained.delayMs, 100);
  const plan = (timing) =>
    planActions(f.state, {
      previousAction: f.previousAction,
      ...timing.pending(f.observedAt, f.extraMs),
    });
  const before = plan(discarded),
    after = plan(retained);
  assert.equal(bestAction(before), "down_right");
  const unsafe = after.find((c) => c.action === "down_right");
  assert.ok(unsafe.collision);
  assert.ok(unsafe.physicalClearance < 2);
  assert.equal(bestAction(after), "right");
  assert.ok(after.find((c) => c.action === "right").physicalClearance > 30);
});

test("queued turns use the same server update as movement-based latency fitting", () => {
  const timing = new InputTiming();
  timing.delayMs = 100;
  timing.record("right", 0);
  timing.record("down", 925); // Arrives 25 ms after the observation below.
  const state = {
    packet: 100,
    tickRate: 60,
    player: { x: 100, y: 100, vx: 600, vy: 0, radius: 2, speed: 600 },
    area: { id: "timing", x: 0, y: 0, width: 1000, height: 500, zones: [] },
    hazards: [
      { id: 1, x: 110, y: 110, radius: 2, vx: 0, vy: 0, bounce: false },
    ],
  };
  timing.observe(state, 1000);
  // Tick 1 moves right to (110,100); tick 2 sees the turn and reaches (110,110).
  timing.observe(
    {
      ...state,
      packet: 102,
      player: { ...state.player, x: 110, y: 110, vx: 0, vy: 600 },
    },
    1000 + 1000 / 30,
  );
  assert.equal(timing.fits.find((fit) => fit.ms === 100).error, 0);
  assert.ok(timing.fits.find((fit) => fit.ms === 125).error > 0);
  const candidates = planActions(state, {
    ...timing.pending(1000, 25),
    previousAction: "down",
    fastPath: false,
  });
  // This collision is already committed. A tick-start forecast falsely passes
  // six units beside the ball by executing an extra rightward step.
  assert.ok(candidates.every((c) => c.physicalClearance === -4));
  assert.ok(candidates.every((c) => c.closestAt === 2 / 60));
});

test("a new dodge executes on the first update after its input arrives", () => {
  const state = {
    tickRate: 60,
    player: { x: 100, y: 250, radius: 2, speed: 600, vx: 0, vy: 0 },
    area: { x: 0, y: 0, width: 1000, height: 500, zones: [] },
    hazards: [
      { id: 1, x: 115, y: 250, radius: 2, vx: -360, vy: 0, bounce: false },
    ],
  };
  const candidates = planActions(state, {
    reactionTime: 0.025,
    previousAction: "stay",
    pendingInputs: [{ time: 0, action: "stay" }],
    fastPath: false,
  });
  // On tick 2 the ball is at (103,250). The timely dodge is at (100,240);
  // delaying that dodge until tick 3 would leave overlapping collision bodies.
  assert.ok(candidates.find((c) => c.action === "up").physicalClearance > 3);
});

test("Area 22 detects the fatal upward reversal before it is queued", () => {
  const f = fixture("input-tick-phase");
  const before = planActions(f.beforeTurn.state, f.beforeTurn.options);
  const reversal = before.find((c) => c.action === f.beforeTurn.recordedAction);
  assert.equal(reversal.action, "up_right");
  assert.equal(reversal.closestHazard, f.collider);
  assert.ok(reversal.physicalClearance < -2);
  const escape = before.find((c) => c.action === bestAction(before));
  assert.equal(escape.action, "right");
  assert.ok(escape.physicalClearance > 2);
  // A later observation cannot cancel the reversal already sent to the server.
  const after = planActions(f.afterTurnQueued.state, f.afterTurnQueued.options);
  assert.ok(after.every((c) => c.physicalClearance < -2));
  assert.ok(after.every((c) => c.closestHazard === f.collider));
});

test("a delayed browser read does not make an in-flight turn look already applied", () => {
  const clock = new ObservationClock();
  assert.equal(clock.observe(6001, 1000, 1002).at, 1001);
  const observation = clock.observe(6100, 1099, 1180);
  assert.equal(observation.at, 1100);
  assert.equal(observation.ageMs, 80);
  const timing = new InputTiming();
  timing.delayMs = 100;
  timing.record("right", 0);
  timing.record("down", 1025);
  const pending = timing.pending(observation.at, observation.ageMs + 20);
  assert.deepEqual(pending.pendingInputs, [
    { time: 0, action: "right" },
    { time: 0.025, action: "down" },
  ]);
  assert.equal(pending.reactionTime, 0.2);
  // Dating the same snapshot at receipt would falsely say the turn completed.
  assert.equal(timing.pending(1180).pendingInputs[0].action, "down");
  // A page reload establishes a new browser clock origin.
  assert.equal(clock.observe(1, 2000, 2002).at, 2001);
});

test("Area 35 accounts for snapshot age before predicting a drift escape", () => {
  const f = fixture("snapshot-age");
  const clock = new ObservationClock();
  const observations = f.clockSamples.map((args) => clock.observe(...args));
  for (const [name, recoverable] of [
    ["beforeDrift", true],
    ["afterDrift", false],
  ]) {
    const row = f[name],
      observation = observations[row.frame];
    const timing = new InputTiming();
    timing.delayMs = row.inputDelayMs;
    for (const command of f.commands.filter((c) => c.at <= row.observedAt))
      timing.record(command.action, command.at);
    const extraMs = row.prediction.reactionTime * 1000 - row.inputDelayMs;
    const options = { previousAction: row.previousAction };
    const naive = planActions(row.state, { ...options, ...row.prediction });
    const dated = planActions(row.state, {
      ...options,
      ...timing.pending(observation.at, observation.ageMs + extraMs),
    });
    const original = naive.find((c) => c.action === row.recordedAction);
    const corrected = dated.find((c) => c.action === row.recordedAction);
    if (recoverable) {
      assert.ok(original.clearance > 0);
      assert.ok(corrected.clearance < -3);
      const escape = dated.find((c) => c.action === bestAction(dated));
      assert.notEqual(escape.action, row.recordedAction);
      assert.ok(escape.clearance > 0);
    } else {
      assert.ok(observation.ageMs > 75);
      assert.ok(original.physicalClearance > 20);
      assert.ok(dated.every((c) => c.physicalClearance < -20));
      assert.ok(dated.every((c) => c.closestHazard === f.collider));
    }
  }
});
