import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MotionTracker } from "../src/observe.js";
import { prepareLivePlanning } from "../src/live-models.js";
import { InputTiming, PacketClock } from "../src/timing.js";
import { MovementPolicy } from "../src/movement.js";
import { advancePlayer, circleInZone, planActions, predictHazardPath, sweptClearance } from "../src/planner.js";

const f = JSON.parse(readFileSync(new URL("./fixtures/ww19-zoning.json", import.meta.url)));
const warm = () => {
  const tracker = new MotionTracker();
  for (const state of f.warmup) tracker.update(state);
  return { tracker, state: tracker.update(f.state) };
};

test("WW19 Zoning learns slowing from past observations and matches held-out positions", () => {
  const { state } = warm(), prepared = prepareLivePlanning(state).state;
  const h = prepared.hazards.find(h => h.id === f.collider);
  assert.deepEqual(h.zoning, { deceleration: 450 });
  for (const later of f.future) {
    const n = later.packet - state.packet, actual = later.hazards.find(h => h.id === f.collider);
    const corrected = predictHazardPath(h, state.area, n, 1 / 60).at(-1);
    const original = predictHazardPath(f.state.hazards.find(h => h.id === f.collider), state.area, n, 1 / 60).at(-1);
    assert.ok(Math.hypot(corrected.x - actual.x, corrected.y - actual.y) < 0.01);
    assert.ok(Math.hypot(original.x - actual.x, original.y - actual.y) >= 15);
  }
  // Coarse navigation must use the same before-movement speed updates.
  const fine = predictHazardPath(h, state.area, 18, 1 / 60);
  const coarse = predictHazardPath(h, state.area, 4, 4.5 / 60);
  for (let i = 0; i < coarse.length; i++) {
    const expected = (fine[Math.floor(i * 4.5)].x + fine[Math.ceil(i * 4.5)].x) / 2;
    assert.ok(Math.abs(coarse[i].x - expected) < 1e-7);
  }
});

test("Zoning fits reject phase changes, uncertain packet gaps and contradictory displacement", () => {
  const { tracker, state } = warm(), model = state.hazards.find(h => h.id === f.collider).zoning;
  const repeated = tracker.update(f.state).hazards.find(h => h.id === f.collider).zoning;
  assert.equal(repeated, model);
  assert.equal(tracker.zoning.get(f.collider).samples.length, 3);
  for (const change of [
    s => { s.packet += 10; },
    s => { s.area.id = "new-area"; },
    s => { const h = s.hazards.find(h => h.id === f.collider); h.x += 100; },
    s => { const h = s.hazards.find(h => h.id === f.collider); h.vx = 0; h.vy = -142.5; },
    s => { const h = s.hazards.find(h => h.id === f.collider); h.motionEffects = [{ scale: 0, remainingMs: 500 }]; },
  ]) {
    const { tracker } = warm(), next = structuredClone(f.state);
    next.packet++;
    change(next);
    assert.equal(tracker.update(next).hazards.find(h => h.id === f.collider).zoning, undefined);
  }
  const ordinary = structuredClone(f.state);
  ordinary.hazards = ordinary.hazards.map(h => ({ ...h, entityType: 115 }));
  const clean = new MotionTracker(); clean.update(ordinary);
  assert.equal(clean.zoning.size, 0);
  tracker.update({ ...f.state, packet: f.state.packet + 1, hazards: [] });
  assert.equal(tracker.zoning.size, 0);
});

test("duplicate WW19 packets keep their original timestamp instead of appearing freshly observed", () => {
  const clock = new PacketClock();
  for (const row of f.gapReads.slice(0, -1)) {
    const sample = clock.observe({ ...f.state, packet: row.packet }, row.capturedAt, row.receivedAt);
    assert.equal(sample.at, f.capturedAt);
    assert.equal(sample.ageMs, row.receivedAt - f.capturedAt);
  }
  const last = f.gapReads.at(-2);
  assert.ok(clock.observe(f.state, last.capturedAt, last.receivedAt).ageMs > 230);
  const fresh = f.gapReads.at(-1);
  assert.equal(clock.observe({ ...f.state, packet: fresh.packet }, fresh.capturedAt, fresh.receivedAt).repeat, false);
  assert.equal(clock.at, fresh.capturedAt);
  assert.equal(clock.observe({ ...f.state, area: { id: "changed" } }, 900000).at, 900000);
  assert.equal(clock.observe({ ready: false }, 900100).repeat, false);
});

test("replanning an old snapshot includes inputs sent since it was captured", () => {
  const timing = new InputTiming(); timing.delayMs = 125;
  timing.record("right", 0);
  timing.record("up_right", 1040);
  timing.record("up", 1090);
  assert.deepEqual(timing.pending(1000, 120).pendingInputs, [
    { time: 0, action: "right" },
    { time: 0.165, action: "up_right" },
    { time: 0.215, action: "up" },
  ]);
  assert.equal(timing.pending(1000, 120).reactionTime, 0.245);
  // A command not yet inside the queried delivery window remains excluded.
  assert.equal(timing.pending(1000, 20).pendingInputs.length, 1);
});

// Actual enemies come from later recorded positions, never the model under test.
// This short interpolation replay includes the measured one-tick input ambiguity;
// it does not simulate a whole level or unobserved server/network behavior.
function gapReplay(replan, delayTicks, budget = Infinity) {
  const { state } = warm(), prepared = prepareLivePlanning(state, { decisionMs: 1000 / 30 }).state;
  const at = f.capturedAt, timing = new InputTiming(); timing.delayMs = 125;
  for (const input of f.options.pendingInputs) timing.record(input.action, at - 125 + input.time * 1000);
  const commands = timing.commands.map(c => ({ action: c.action,
    at: c.at + 125 + (c.at + 125 > at ? delayTicks * 1000 / 60 : 0) }));
  const movement = new MovementPolicy(); movement.record("up_right", f.commands[0].at);
  movement.plan = f.recordedPlan; movement.inputDelayMs = 125;
  const actual = (id, tick) => {
    const rows = [{ tick: 0, state: f.state }, ...f.future.map(state => ({ tick: state.packet - f.state.packet, state }))];
    const b = rows.find(r => r.tick >= tick) ?? rows.at(-1);
    const a = rows.findLast(r => r.tick < tick) ?? rows[0];
    const p = a.state.hazards.find(h => h.id === id), q = b.state.hazards.find(h => h.id === id);
    const t = b.tick === a.tick ? 0 : (tick - a.tick) / (b.tick - a.tick);
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };
  let player = f.state.player, minimumClearance = Infinity, collided = false, turns = 0;
  for (let tick = 1; tick <= 18 && !collided; tick++) {
    if (replan && tick <= 14 && tick % 2 === 0) {
      const now = at + (tick - 1) * 1000 / 60;
      const candidates = planActions(prepared, { ...movement.planOptions(now), inputIntervalTicks: 2,
        ...timing.pending(at, now - at + 13), maxPlanMs: budget, now: () => 0 });
      const action = movement.select(candidates, undefined, now);
      movement.record(action, now + 13); timing.record(action, now + 13);
      if (commands.at(-1).action !== action) {
        commands.push({ action, at: now + 138 + delayTicks * 1000 / 60 }); turns++;
      }
    }
    const action = commands.findLast(c => c.at <= at + tick * 1000 / 60)?.action ?? "stay";
    const next = advancePlayer(player, action, f.state.player, f.state.area);
    const sheltered = f.state.area.zones.some(z => z.type === 4 && circleInZone(player, z, 15) && circleInZone(next, z, 15));
    if (!sheltered) for (const h of f.state.hazards) {
      const gap = sweptClearance(player, next, actual(h.id, tick - 1), actual(h.id, tick), 15 + h.radius);
      minimumClearance = Math.min(minimumClearance, gap);
      if (gap <= 0) collided = true;
    }
    player = next;
  }
  return { collided, minimumClearance, turns, progress: player.x - f.state.player.x };
}

test("WW19 duplicate-packet replans escape the recorded Zoning collision at three input timings", () => {
  assert.ok(gapReplay(false, 1).collided);
  for (const ticks of [-1, 0, 1]) {
    const result = gapReplay(true, ticks);
    assert.ok(!result.collided);
    assert.ok(result.minimumClearance > 24);
    assert.equal(result.progress, 207);
    assert.ok(result.turns > 0 && result.turns <= 3);
  }
});

test("an exhausted optional-search budget can still follow the checked turn during the packet gap", () => {
  for (const ticks of [-1, 0, 1]) {
    const result = gapReplay(true, ticks, 0);
    assert.ok(!result.collided, JSON.stringify(result));
    assert.ok(result.minimumClearance > 10, JSON.stringify(result));
  }
});
