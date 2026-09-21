import test from "node:test";
import assert from "node:assert/strict";
import { Navigation } from "../src/navigation.js";
import { planActions } from "../src/planner.js";

const state = () => ({
  packet: 100,
  tickRate: 60,
  player: {
    x: 100,
    y: 250,
    radius: 10,
    speed: 660,
    baseSpeed: 510,
    speedBonus: 150,
  },
  area: {
    id: "timed-corridor",
    x: 0,
    y: 0,
    width: 1000,
    height: 500,
    zones: [
      { type: 0, x: 0, y: 0, width: 900, height: 500 },
      { type: 2, x: 900, y: 0, width: 100, height: 500 },
    ],
  },
  hazards: [],
  auras: [],
});

test("the same crossing has a different route cost after the ball passes", () => {
  const s = state();
  s.hazards.push({
    id: 3,
    x: 650,
    y: 250,
    radius: 40,
    vx: 0,
    vy: 220,
    bounce: false,
  });
  const r = new Navigation().update(s, 0);
  const crossing = { x: 650, y: 250 };
  assert.ok(r.distanceAt(crossing, 0) > r.distanceAt(crossing, 1.2) + 60);
  assert.equal(r.packet, 100);
  assert.ok(r.horizon >= 2.4);
});

test("diagonal routes use per-axis travel time and open corridors stay straight", () => {
  const s = state();
  const straight = new Navigation().update(s, 0);
  assert.ok(straight.direct);
  assert.ok(straight.path.every((p) => p.y === s.player.y));
  assert.equal(planActions(s, { navigation: straight })[0].fastPath, true);
  s.player.y = 440;
  s.area.zones[1].height = 80;
  const diagonal = new Navigation().update(s, 0);
  // Reaching the upper exit takes horizontal travel time while climbing.
  // Charging Euclidean length would put this route above 1.5 seconds.
  assert.ok(diagonal.path.at(-1).time > 1.2);
  assert.ok(diagonal.path.at(-1).time < 1.4);
  assert.ok(diagonal.path.at(-1).y < 70);
});

test("route arrival includes slowing auras once per type and preserves the Candy bonus", () => {
  const s = state();
  const aura = {
    id: 1,
    type: 48,
    x: 500,
    y: 250,
    radius: 12,
    auraRadius: 2000,
    reduction: 0.3,
    vx: 0,
    vy: 0,
    bounce: false,
  };
  const arrival = (value) => new Navigation().update(value, 0).path.at(-1).time;
  const normal = arrival(s);
  const slowed = arrival({ ...s, auras: [aura] });
  const twice = arrival({ ...s, auras: [aura, { ...aura, id: 2 }] });
  assert.equal(slowed, twice);
  // 510 * .7 + 150 = 507. Candy is not multiplied by .7.
  assert.ok(Math.abs(slowed / normal - 660 / 507) < 0.04);
  assert.equal(
    arrival({
      ...s,
      auras: [aura],
      player: { ...s.player, ignoreAuras: true },
    }),
    normal,
  );
  const expired = arrival({
    ...s,
    auras: [aura],
    player: {
      ...s.player,
      candy: { active: true, remainingMs: 0 },
      speedBonusWithoutCandy: 0,
    },
  });
  assert.ok(expired > slowed + 0.5);
});

test("planner dates future route queries against the cached map's server packet", () => {
  const s = state(),
    queries = [];
  s.packet = 106;
  const navigation = {
    packet: 100,
    distanceAt(position, time) {
      queries.push(time);
      return 1000 - position.x + time * 100;
    },
  };
  const candidates = planActions(s, {
    navigation,
    fastPath: false,
    reactionTime: 0.1,
  });
  assert.ok(candidates.every((c) => Number.isFinite(c.score)));
  assert.ok(Math.abs(Math.min(...queries) - 0.1) < 1e-9);
  assert.ok(Math.abs(Math.max(...queries) - 1.1) < 1e-9);
  const stay = candidates.find((c) => c.action === "stay");
  // Waiting for 100 ms does not claim spatial progress when time gets worse.
  assert.ok(stay.firstProgress < -9.9);
});

test("a coarse waypoint cannot force a detour when full speed preserves the timed route", () => {
  const s = state();
  const navigation = {
    packet: s.packet,
    timed: true,
    direct: false,
    distanceAt: (p) => 1000 - p.x,
  };
  const fast = planActions(s, { navigation, previousAction: "focus_right" });
  assert.equal(fast.length, 1);
  assert.equal(fast[0].action, "right");
  assert.ok(fast[0].fastPath);
  const detour = planActions(s, {
    navigation: { ...navigation, distanceAt: (p) => 1000 - 0.4 * p.x },
  });
  assert.ok(detour.every((c) => !c.fastPath));
});
