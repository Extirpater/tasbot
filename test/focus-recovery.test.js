import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planActions, bestAction } from "../src/planner.js";
import { Navigation } from "../src/navigation.js";
import { MovementPolicy } from "../src/movement.js";

const f = JSON.parse(
  readFileSync(new URL("./fixtures/focus-recovery.json", import.meta.url)),
);

for (const routed of [false, true])
  test(`Area 39 finds a buffered full-speed escape with later focused turns${routed ? " and a route map" : ""}`, () => {
    const options = {
      ...f.options,
      navigation: routed ? new Navigation().update(f.state, 0) : undefined,
    };
    assert.equal(f.state.player.baseSpeed + f.state.player.speedBonus, 660);
    assert.equal(f.state.hazards.filter((h) => h.homing).length, 15);
    assert.equal(f.state.auras.length, 23);
    const before = planActions(f.state, { ...options, focusRecovery: false });
    assert.ok(before.every((c) => c.collision));
    assert.ok(Math.max(...before.map((c) => c.physicalClearance)) < 27);

    const after = planActions(f.state, options);
    const movement = new MovementPolicy();
    movement.record(f.options.previousAction, 0);
    const action = movement.select(after, undefined, 10);
    const selected = after.find((c) => c.action === action);
    assert.equal(action, bestAction(after));
    assert.equal(movement.reason, "safety override");
    assert.ok(selected.recoveredFocusPlan);
    assert.ok(!selected.collision);
    assert.ok(selected.physicalClearance > 30.5);
    assert.ok(!selected.action.startsWith("focus_"));
    assert.equal(selected.firstDuration, 0.1);
    const focusedTurns = new Set(
      selected.path.slice(1).filter((a) => a.startsWith("focus_")),
    );
    assert.ok(focusedTurns.size > 1);
    // The recovery augments an unsafe choice, retaining every other baseline
    // candidate instead of losing routes to a different beam-pruning order.
    for (const prior of before)
      if (prior.action !== selected.action)
        assert.deepEqual(
          after.find((c) => c.action === prior.action),
          prior,
        );

    movement.record(action, 11);
    assert.deepEqual(movement.planOptions(12).continuation, selected.plan);
    // All focused follow-ups survive ordinary continuation rechecking; no
    // second recovery pass or renewed first-turn deadline is needed.
    const retained = planActions(f.state, {
      ...options,
      focusRecovery: false,
      continuation: selected.plan,
    }).find((c) => c.action === action);
    assert.ok(retained.continuedPlan);
    assert.ok(!retained.collision);
    assert.deepEqual(retained.plan.inputs, selected.plan.inputs);
    assert.equal(retained.physicalClearance, selected.physicalClearance);
  });

test("recovery cannot change already colliding queued inputs", () => {
  const state = structuredClone(f.state);
  state.hazards.push({
    id: "unavoidable",
    x: state.player.x,
    y: state.player.y,
    radius: 100,
    vx: 0,
    vy: 0,
    bounce: false,
  });
  const before = planActions(state, { ...f.options, focusRecovery: false });
  const after = planActions(state, f.options);
  assert.ok(after.every((c) => c.physicalClearance <= 0));
  assert.deepEqual(after, before);
});

test("recovery leaves a safe ordinary search unchanged and releases Shift in the open", () => {
  const state = { ...f.state, hazards: [], auras: [] };
  const options = { ...f.options, fastPath: false };
  const before = planActions(state, { ...options, focusRecovery: false });
  assert.ok(before.some((c) => !c.collision));
  assert.deepEqual(planActions(state, options), before);

  const forward = planActions(state, {
    previousAction: "focus_right",
    reactionTime: f.options.reactionTime,
  });
  assert.equal(forward.length, 1);
  assert.equal(forward[0].action, "right");
  assert.ok(forward[0].fastPath);
});
