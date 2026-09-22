import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advancePlayer, planActions, bestAction } from "../src/planner.js";
import { InputTiming, ObservationClock } from "../src/timing.js";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test("Cata 37 continues fitting delay in slow fields and rejects the falsely safe downward turn", () => {
  const f = fixture("cata-delay");
  for (const [index, run] of f.runs.entries()) {
    const timing = new InputTiming();
    timing.delayMs = 125;
    for (const [
      i,
      [packet, at, appliedAt, action, player, auras],
    ] of run.rows.entries()) {
      timing.observe(
        { packet, player, auras, tickRate: run.tickRate, area: run.area },
        at,
      );
      if (index === 0 && i === f.turn.frame) {
        assert.equal(timing.delayMs, 150);
        const options = {
          previousAction: f.turn.previousAction,
          fastPath: false,
        };
        const stale = planActions(f.turn.state, {
          ...options,
          ...f.turn.prediction,
        });
        const updated = planActions(f.turn.state, {
          ...options,
          ...timing.pending(at, f.turn.extraMs),
        });
        assert.ok(
          stale.find((c) => c.action === f.turn.action).physicalClearance > 20,
        );
        assert.ok(
          updated.find((c) => c.action === f.turn.action).physicalClearance < 0,
        );
        assert.notEqual(bestAction(updated), f.turn.action);
        assert.ok(
          updated.find((c) => c.action === bestAction(updated))
            .physicalClearance > 20,
        );
      }
      timing.record(action, appliedAt);
    }
    assert.ok(timing.samples > (index === 0 ? 60 : 150));
    assert.equal(timing.delayMs, 150);
  }
});

test("delay adapts after lag changes while overlapping slowing fields remain active", () => {
  const timing = new InputTiming(),
    commands = [],
    sequence = ["right", "down", "left", "up"];
  const vectors = {
    right: [1, 0],
    down: [0, 1],
    left: [-1, 0],
    up: [0, -1],
    stay: [0, 0],
  };
  let x = 1000,
    y = 1000;
  for (let at = 0; at <= 7000; at += 25) {
    const lag = at < 3000 ? 125 : 225;
    const action = commands.findLast((c) => c.at <= at - lag)?.action ?? "stay";
    const [dx, dy] = vectors[action];
    // Known physical speed: 510 * .7 + 150 = 507, even with two same-type auras.
    x += (dx * 507) / 40;
    y += (dy * 507) / 40;
    const aura = {
      id: 1,
      type: 48,
      reduction: 0.3,
      auraRadius: 900,
      x: 1000 + at / 100,
      y: 1000,
      vx: 10,
      vy: 0,
    };
    timing.observe(
      {
        packet: at / 25,
        tickRate: 40,
        area: {
          id: "slowed",
          x: 0,
          y: 0,
          width: 3000,
          height: 3000,
          zones: [],
        },
        player: {
          x,
          y,
          radius: 15,
          speed: 507,
          baseSpeed: 510,
          speedBonus: 150,
          vx: dx * 507,
          vy: dy * 507,
        },
        auras: [aura, { ...aura, id: 2 }],
      },
      at,
    );
    const next = sequence[Math.floor(at / 200) % sequence.length];
    commands.push({ at, action: next });
    timing.record(next, at);
    if (at === 2900) assert.equal(timing.delayMs, 125);
  }
  assert.equal(timing.delayMs, 225);
  assert.ok(timing.samples > 100);
});

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
