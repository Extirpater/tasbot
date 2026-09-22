import test from "node:test";
import assert from "node:assert/strict";
import { RescuePolicy } from "../src/rescue.js";
import { Navigation } from "../src/navigation.js";
import { planActions, bestAction, advancePlayer } from "../src/planner.js";
import { MovementPolicy } from "../src/movement.js";
import { InputTiming } from "../src/timing.js";

const state = () => ({
  ready: true,
  packet: 1,
  tickRate: 60,
  area: {
    id: "map:1",
    x: 0,
    y: 0,
    width: 1000,
    height: 500,
    zones: [
      { type: 0, x: 40, y: 0, width: 920, height: 500 },
      { type: 2, x: 0, y: 0, width: 40, height: 500 },
      { type: 2, x: 960, y: 0, width: 40, height: 500 },
    ],
    walls: [],
  },
  player: { id: 1, x: 500, y: 250, radius: 15, speed: 510 },
  hazards: [],
  auras: [],
  otherPlayers: [
    { id: 2, areaId: "map:1", x: 700, y: 250, radius: 15, downed: true },
    { id: 3, areaId: "map:1", x: 400, y: 250, radius: 15, downed: true },
    { id: 4, areaId: "map:2", x: 501, y: 250, radius: 15, downed: true },
    { id: 5, areaId: "map:1", x: 501, y: 250, radius: 15, downed: false },
    {
      id: 6,
      areaId: "map:1",
      x: 502,
      y: 250,
      radius: 15,
      downed: true,
      rescueable: false,
    },
    { id: 7, areaId: "map:1", x: -1, y: 250, radius: 15, downed: true },
  ],
});

test("rescue selects only the nearest downed, revivable player in the current area", () => {
  const policy = new RescuePolicy(),
    s = state();
  assert.equal(policy.update(s, { rescueRequest: 0 }, true), undefined);
  assert.equal(policy.update(s, { rescueRequest: 1 }, true).id, 3);
  s.otherPlayers[0].x = 505;
  assert.equal(policy.update(s, { rescueRequest: 1 }, true).id, 3);
  assert.equal(policy.update(s, { rescueRequest: 2 }, true), undefined);
  const resumed = new RescuePolicy();
  assert.ok(resumed.update(s, { epoch: 1, rescueRequest: 1 }, true));
  // A pause/resume between observations still cancels the old rescue.
  assert.equal(
    resumed.update(s, { epoch: 3, rescueRequest: 1 }, true),
    undefined,
  );
  assert.equal(policy.update(s, { rescueRequest: 3 }, true).id, 2);
});

test("revival, disappearance, area changes and pauses end one rescue without retargeting", () => {
  for (const finish of [
    (s) => {
      s.otherPlayers[1].downed = false;
    },
    (s) => {
      s.otherPlayers.splice(1, 1);
    },
    (s) => {
      s.area.id = "map:2";
    },
    (s) => {
      s.otherPlayers[1].rescueable = false;
    },
  ]) {
    const policy = new RescuePolicy(),
      s = state();
    assert.ok(policy.update(s, { rescueRequest: 1 }, true));
    finish(s);
    assert.equal(policy.update(s, { rescueRequest: 1 }, true), undefined);
    assert.equal(policy.update(s, { rescueRequest: 1 }, true), undefined);
  }
  const policy = new RescuePolicy(),
    s = state();
  assert.ok(policy.update(s, { rescueRequest: 1 }, true));
  assert.equal(policy.update(s, { rescueRequest: 1 }, false), undefined);
  assert.equal(policy.update(s, { rescueRequest: 1 }, true), undefined);
  assert.equal(policy.update(s, { rescueRequest: 2 }, false), undefined);
  assert.equal(policy.update(s, { rescueRequest: 2 }, true), undefined);
});

test("rescue changes the exit route into contact with a player behind us", () => {
  const s = state(),
    navigation = new Navigation();
  const run = navigation.update(s, 0);
  assert.ok(run.distanceAt({ x: 800, y: 250 }) < run.distanceAt(s.player));
  const objective = new RescuePolicy().update(s, { rescueRequest: 1 }, true);
  const route = navigation.update(s, 1, "right", objective);
  assert.notEqual(route, run);
  assert.ok(route.distanceAt({ x: 420, y: 250 }) < route.distanceAt(s.player));
  const choices = planActions(s, {
    navigation: route,
    objective,
    reactionTime: 0,
  });
  const chosen = choices.find((c) => c.action === bestAction(choices));
  assert.equal(chosen.action, "left");
  assert.equal(chosen.collision, false);
  let p = s.player,
    touched = false;
  for (let tick = 1; tick <= 54; tick++) {
    const action =
      chosen.plan.inputs.findLast((input) => input.tick < tick)?.action ??
      "stay";
    p = advancePlayer(p, action, s.player, s.area);
    if (Math.hypot(p.x - objective.x, p.y - objective.y) <= objective.radius)
      touched = true;
  }
  assert.ok(touched);
  assert.notEqual(navigation.update(s, 2), route);
});

test("rescue keeps checking hazards after contact and never targets an exit", () => {
  const s = state();
  s.hazards = [
    { id: 10, x: 320, y: 250, radius: 22, vx: 0, vy: 0, bounce: false },
  ];
  const objective = new RescuePolicy().update(s, { rescueRequest: 1 }, true);
  const choices = planActions(s, {
    objective,
    reactionTime: 0,
    fastPath: false,
  });
  const chosen = choices.find((c) => c.action === bestAction(choices));
  assert.equal(chosen.collision, false);
  assert.ok(chosen.physicalClearance > 25);
  let p = s.player;
  for (let tick = 1; tick <= 54; tick++) {
    const action =
      chosen.plan.inputs.findLast((input) => input.tick < tick)?.action ??
      "stay";
    p = advancePlayer(p, action, s.player, s.area);
    assert.ok(Math.hypot(p.x - 320, p.y - 250) > 37);
    assert.ok(p.x > 55 && p.x < 945);
  }
  s.area.walls.push({ x: 430, y: 0, width: 30, height: 350 });
  const route = new Navigation().update(s, 0, "right", objective);
  assert.ok(route.path.some((p) => p.y > 365));
  assert.ok(route.path.every((p) => p.x > 55 && p.x < 945));
});

// Execute actual queued commands independently of the planner, observing every
// two server ticks. Keep the estimator at 150 ms and vary actual arrival by a
// tick: a point approach must not keep reversing to chase its exact centre.
function approachPerson(start, target, offset = 0) {
  const s = state();
  s.player = { ...s.player, ...start, vx: 0, vy: 0 };
  s.area.zones[0].friction = 0.75;
  s.otherPlayers = [
    { ...target, id: 2, radius: 15, downed: true, areaId: s.area.id },
  ];
  const rescue = new RescuePolicy(),
    navigation = new Navigation();
  const movement = new MovementPolicy(),
    timing = new InputTiming();
  const commands = [],
    actions = [];
  timing.record("stay", -1000);
  let closest = Infinity;
  for (let tick = 0; tick < 150; tick++) {
    const at = (tick * 1000) / 60;
    s.packet = tick;
    if (tick % 2 === 0) {
      const objective = rescue.update(s, { epoch: 1, rescueRequest: 1 }, true);
      movement.observe(s, at);
      const candidates = planActions(s, {
        ...timing.pending(at),
        ...movement.planOptions(at),
        objective,
        navigation: navigation.update(s, at, "right", objective),
      });
      const action = movement.select(candidates, undefined, at);
      movement.record(action, at);
      timing.record(action, at);
      if (commands.at(-1)?.action !== action) {
        commands.push({ action, tick: tick + 9 + offset });
        actions.push(action);
      }
    }
    const action =
      commands.findLast((c) => c.tick <= tick + 1)?.action ?? "stay";
    s.player = {
      ...s.player,
      ...advancePlayer(s.player, action, s.player, s.area),
    };
    const gap = Math.hypot(s.player.x - target.x, s.player.y - target.y);
    closest = Math.min(closest, gap);
    if (gap < s.player.radius + 15)
      return { tick, actions, x: s.player.x, y: s.player.y };
  }
  assert.fail(
    `Rescue missed contact: ${JSON.stringify({ start, target, offset, closest, actions })}`,
  );
}

test("high-speed rescues make contact without overshooting and reversing in a clear area", () => {
  for (const offset of [-1, 0, 1]) {
    for (const [start, target] of [
      [
        { x: 200, y: 250, speed: 660 },
        { x: 780, y: 380 },
      ],
      [
        { x: 300, y: 250, speed: 660 },
        { x: 550, y: 350 },
      ],
      [
        { x: 300, y: 250, speed: 660 },
        { x: 370, y: 280 },
      ],
      [
        { x: 600, y: 450, speed: 690 },
        { x: 330, y: 465 },
      ],
    ]) {
      const result = approachPerson(start, target, offset);
      assert.ok(result.tick < 70, JSON.stringify(result));
      assert.ok(result.actions.length <= 6, JSON.stringify(result));
      if (target.x > start.x)
        assert.ok(
          result.actions.every((a) => !a.includes("left")),
          JSON.stringify(result),
        );
      else
        assert.ok(
          result.actions.every((a) => !a.includes("right")),
          JSON.stringify(result),
        );
      assert.ok(
        result.actions.every((a) => !a.includes("up")),
        JSON.stringify(result),
      );
    }
  }
});

test("a ball arriving after contact rejects the direct rescue and retains a checked escape", () => {
  const s = state();
  const objective = new RescuePolicy().update(s, { rescueRequest: 1 }, true);
  const direct = planActions(s, { objective, reactionTime: 0 })[0];
  assert.ok(direct.rescueDirect);
  s.hazards.push({
    id: 10,
    x: 280,
    y: 250,
    radius: 20,
    vx: 210,
    vy: 0,
    bounce: false,
  });
  const candidates = planActions(s, {
    objective,
    reactionTime: 0,
    continuation: direct.plan,
  });
  assert.ok(candidates.every((c) => !c.rescueDirect));
  const chosen = candidates.find((c) => c.action === bestAction(candidates));
  assert.equal(chosen.collision, false);
  assert.ok(chosen.physicalClearance > 25);
});

test("retargeting drops old turns and commitments while preserving the held input", () => {
  const movement = new MovementPolicy();
  movement.record("left", 1000);
  movement.plan = { inputs: [{ tick: 20, action: "up" }] };
  movement.retarget();
  const options = movement.planOptions(1010);
  assert.equal(options.previousAction, "left");
  assert.equal(options.continuation, undefined);
  const candidate = (action, score) => ({
    action,
    score,
    collision: false,
    physicalClearance: 50,
    clearance: 25,
    firstMovement: 20,
    firstProgress: 10,
    firstDuration: 0.1,
  });
  assert.equal(
    movement.select(
      [candidate("left", 10), candidate("right", 15)],
      undefined,
      1010,
    ),
    "right",
  );
});
