import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTIONS,
  bestAction,
  planActions,
  planResponsiveActions,
} from "../src/planner.js";
import { InputTiming } from "../src/timing.js";

const f = JSON.parse(
  readFileSync(new URL("./fixtures/cata34-latency.json", import.meta.url)),
);
const selected = (candidates) =>
  candidates.find((c) => c.action === bestAction(candidates));
// Expire at a deterministic search boundary, independent of machine/test load.
const expireAfter = (checks) => {
  let calls = 0;
  return () => (++calls <= checks ? 0 : 30);
};

test("Area 34 interrupted search never exposes a partially checked escape", () => {
  const fallback = planActions(f.state, {
    ...f.options,
    maxPlanMs: 0,
    now: () => 0,
  });
  const interrupted = planActions(f.state, {
    ...f.options,
    maxPlanMs: 24,
    now: expireAfter(3),
  });
  assert.equal(interrupted.length, Object.keys(ACTIONS).length);
  assert.ok(interrupted.every((c) => c.searchLimited && c.searchedRoots === 0));
  assert.deepEqual(
    interrupted.map((c) => [c.action, c.collision, c.score, c.plan]),
    fallback.map((c) => [c.action, c.collision, c.score, c.plan]),
  );
  assert.ok(interrupted.every((c) => c.collision));
});

test("Area 34 finds a complete buffered escape on its first cheap search", () => {
  const candidates = planActions(f.state, {
    ...f.options,
    maxPlanMs: 24,
    now: expireAfter(10),
  });
  const best = selected(candidates);
  assert.equal(best.searchedRoots, 1);
  assert.equal(best.action, "down");
  assert.ok(!best.collision && best.clearance > 10);
  assert.ok(best.physicalClearance > 42);
  assert.ok(best.plan.inputs.length > 5);
});

test("a checked continuation survives an exhausted budget and is invalidated by new danger", () => {
  const best = selected(
    planActions(f.state, { ...f.options, maxPlanMs: 24, now: expireAfter(10) }),
  );
  const options = {
    ...f.options,
    continuation: best.plan,
    maxPlanMs: 0,
    now: () => 0,
  };
  const retained = selected(planActions(f.state, options));
  assert.ok(retained.continuedPlan && !retained.collision);
  assert.deepEqual(retained.plan.inputs, best.plan.inputs);
  const changed = structuredClone(f.state);
  changed.hazards.push({
    id: "new-danger",
    x: changed.player.x,
    y: changed.player.y,
    radius: 50,
    vx: 0,
    vy: 0,
  });
  assert.ok(planActions(changed, options).every((c) => c.collision));
});

test("bounded search tries focused recovery before widening unsafe routes", () => {
  const recovery = JSON.parse(
    readFileSync(new URL("./fixtures/focus-recovery.json", import.meta.url)),
  );
  const best = selected(
    planActions(recovery.state, {
      ...recovery.options,
      maxPlanMs: 24,
      now: expireAfter(160),
    }),
  );
  assert.equal(best.searchedRoots, Object.keys(ACTIONS).length);
  assert.ok(best.recoveredFocusPlan && !best.collision);
});

test("command timing includes current route work and reserves the upcoming search", () => {
  const timing = new InputTiming();
  timing.delayMs = 125;
  timing.record("up", 800);
  timing.record("focus_right", 990);
  const capturedAt = 1000,
    afterNavigation = 1050;
  let calls = 0;
  const predictionAt = (at) => timing.pending(capturedAt, at - capturedAt);
  const result = planResponsiveActions(f.state, {
    ...f.options,
    predictionAt,
    now: () => (++calls <= 2 ? afterNavigation : afterNavigation + 10),
  });
  assert.equal(result.commandAt, 1073);
  assert.equal(result.prediction.reactionTime, 0.198);
  assert.deepEqual(
    result.prediction.pendingInputs,
    timing.pending(capturedAt).pendingInputs,
  );
  assert.equal(result.lagRecheck, false);
});

test("a quick shortcut corrects timing instead of sending the turn a tick early", () => {
  const predictedAt = [];
  const result = planResponsiveActions(
    { ...f.state, hazards: [], auras: [] },
    {
      ...f.options,
      fastPath: true,
      now: () => 1000,
      predictionAt: (at) => {
        predictedAt.push(at);
        return {
          ...f.options,
          fastPath: true,
          reactionTime: (125 + at - 1000) / 1000,
        };
      },
    },
  );
  assert.deepEqual(predictedAt, [1023, 1013]);
  assert.equal(result.timingRecheck, true);
  assert.equal(result.lagRecheck, false);
  assert.equal(result.prediction.reactionTime, 0.138);
  assert.ok(selected(result.candidates).fastPath);
});

test("a calculation overrun replaces the stale forecast using measured elapsed time", () => {
  let calls = 0;
  const predictedAt = [];
  const result = planResponsiveActions(f.state, {
    ...f.options,
    now: () => (++calls <= 2 ? 1000 : 1160),
    predictionAt: (at) => {
      predictedAt.push(at);
      return { ...f.options, reactionTime: (125 + 14 + at - 1000) / 1000 };
    },
  });
  assert.deepEqual(predictedAt, [1023, 1173]);
  assert.equal(result.lagRecheck, true);
  assert.equal(result.prediction.reactionTime, 0.312);
  assert.ok(result.candidates.every((c) => c.collision));
});
