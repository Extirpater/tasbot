import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planActions, bestAction } from "../src/planner.js";
import { MovementPolicy } from "../src/movement.js";

const f = JSON.parse(
  readFileSync(new URL("./fixtures/turn-deadline.json", import.meta.url)),
);

test("recorded Candy-speed escape retains its turn deadline across packets", () => {
  const previous = planActions(f.prior.state, f.prior.options).find(
    (c) => c.action === "down",
  );
  assert.equal(
    f.prior.state.player.baseSpeed + f.prior.state.player.speedBonus,
    660,
  );
  assert.equal(previous.firstDuration, 0.1);
  const candidates = planActions(f.current.state, {
    ...f.current.options,
    continuation: previous.plan,
  });
  const continued = candidates.find((c) => c.action === "down");
  assert.ok(continued.continuedPlan);
  assert.ok(continued.physicalClearance > 27);
  assert.equal(continued.firstDuration, 5 / 60);
  assert.equal(
    previous.plan.packet + previous.plan.inputs[1].tick,
    continued.plan.packet + continued.plan.inputs[1].tick,
  );
  const movement = new MovementPolicy();
  const action = movement.select([continued], undefined, 0);
  movement.record(action, 10);
  assert.deepEqual(movement.planOptions(20).continuation, continued.plan);
  movement.reset();
  assert.equal(movement.planOptions(30).continuation, undefined);
});

test("continuations are freshly collision-checked and rejected after area changes", () => {
  const previous = planActions(f.prior.state, f.prior.options).find(
    (c) => c.action === "left",
  );
  const changed = structuredClone(f.current.state);
  changed.hazards.push({
    id: "new",
    x: changed.player.x,
    y: changed.player.y,
    radius: 2000,
    vx: 0,
    vy: 0,
    bounce: false,
  });
  const blocked = planActions(changed, {
    ...f.current.options,
    continuation: previous.plan,
  });
  assert.ok(blocked.every((c) => c.physicalClearance < 0));
  const differentArea = planActions(f.current.state, {
    ...f.current.options,
    continuation: { ...previous.plan, areaId: "different area" },
  });
  assert.ok(differentArea.every((c) => !c.continuedPlan));
});

test("when no padded route fits, the crowded lane keeps clearance over a graze", () => {
  const candidates = planActions(f.tight.state, f.tight.options);
  assert.ok(candidates.every((c) => c.collision));
  const selected = candidates.find((c) => c.action === bestAction(candidates));
  assert.ok(selected.physicalClearance > 21);
  assert.ok(candidates.find((c) => c.action === "right").physicalClearance < 0);
  const movement = new MovementPolicy();
  movement.record("right", 0);
  // A 5px safety improvement must interrupt debounce in an already unsafe gap.
  const action = movement.select(
    [
      {
        ...selected,
        action: "right",
        clearance: -29,
        physicalClearance: 1,
        score: -12000,
      },
      {
        ...selected,
        action: "up_left",
        clearance: -24,
        physicalClearance: 6,
        score: -11000,
      },
    ],
    undefined,
    10,
  );
  assert.equal(action, "up_left");
  assert.equal(movement.reason, "safety override");
});

test("recorded wall wait takes a safe advancing route before the long stall timeout", () => {
  const f = JSON.parse(
    readFileSync(new URL("./fixtures/frozen-wait.json", import.meta.url)),
  );
  const movement = new MovementPolicy();
  movement.record("stay", f.previousAppliedAt);
  assert.equal(movement.stalled, false);
  assert.equal(bestAction(f.candidates), "stay");
  const action = movement.select(f.candidates, undefined, f.observedAt);
  const escape = f.candidates.find((c) => c.action === action);
  assert.equal(action, "right");
  assert.equal(movement.reason, "end wait");
  assert.ok(escape.firstProgress > 60);
  assert.ok(escape.physicalClearance > 40);
});

test("ending a wait cannot force an unsafe move or abandon a much better timed opening", () => {
  const f = JSON.parse(
    readFileSync(new URL("./fixtures/frozen-wait.json", import.meta.url)),
  );
  for (const change of [
    (c) => ({ ...c, collision: true, clearance: -1 }),
    (c) => ({ ...c, score: -500 }),
    (c) => ({ ...c, firstProgress: -30 }),
  ]) {
    const movement = new MovementPolicy();
    movement.record("stay", f.previousAppliedAt);
    const candidates = f.candidates.map((c) =>
      c.action === "stay" ? c : change(c),
    );
    assert.equal(movement.select(candidates, undefined, f.observedAt), "stay");
  }
});

test("recorded Area 35 releases Shift when the same full-speed direction improves progress and clearance", () => {
  const f = JSON.parse(
    readFileSync(new URL("./fixtures/accelerate.json", import.meta.url)),
  );
  const movement = new MovementPolicy();
  movement.record(f.previousAction, f.previousAppliedAt);
  assert.equal(
    movement.select(f.candidates, undefined, f.observedAt),
    "up_right",
  );
  assert.equal(movement.reason, "accelerate");
  const focused = f.candidates.find((c) => c.action === f.previousAction);
  const full = f.candidates.find((c) => c.action === "up_right");
  assert.ok(full.physicalClearance > focused.physicalClearance + 7);
  assert.ok(full.firstProgress > focused.firstProgress + 30);
});

test("acceleration respects the active dodge commitment and cannot spend its clearance buffer", () => {
  const f = JSON.parse(
    readFileSync(new URL("./fixtures/accelerate.json", import.meta.url)),
  );
  const movement = new MovementPolicy();
  movement.record(f.previousAction, f.previousAppliedAt);
  assert.equal(
    movement.select(f.candidates, undefined, f.previousAppliedAt + 50),
    f.previousAction,
  );
  const candidates = f.candidates.map((c) =>
    c.action === "up_right"
      ? { ...c, physicalClearance: 30.6, clearance: 0.1 }
      : c,
  );
  assert.equal(
    movement.select(candidates, undefined, f.observedAt),
    f.previousAction,
  );
});
