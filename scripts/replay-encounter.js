import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { advancePlayer, circleInZone, sweptClearance } from "../src/planner.js";
import { Navigation } from "../src/navigation.js";

// Counterfactual local controller replay. Enemy positions come from the recorded
// observations, independently of the planner's enemy forecast. Interpolate only
// the missing server ticks. Slowing auras also use recorded source positions.
// Player-dependent pursuers still need a different simulator.
export function replayEncounter(
  trace,
  planner,
  MovementPolicy,
  { fromFrame = 140, delayTicks = 0, NavigationClass = Navigation } = {},
) {
  const first = trace.frames[fromFrame];
  const rows = trace.frames
    .slice(fromFrame)
    .filter(
      (f, i, all) => i === 0 || f.state.packet !== all[i - 1].state.packet,
    );
  if (trace.finalState?.packet > rows.at(-1).state.packet)
    rows.push({ state: trace.finalState });
  if (
    rows.some(
      ({ state: s }) =>
        s.area.id !== first.state.area.id || s.hazards.some((h) => h.homing),
    )
  )
    throw new Error("Replay requires one area and player-independent enemies");
  const rate = first.state.tickRate ?? 60,
    dt = 1 / rate;
  const packet0 = first.state.packet;
  const movement = new MovementPolicy(),
    navigation = new NavigationClass();
  for (const f of trace.frames.slice(0, fromFrame)) {
    movement.record(
      f.action,
      f.appliedAt - (first.capturedAt ?? first.observedAt),
    );
    navigation.update(f.state, (f.state.packet - packet0) * dt * 1000);
  }
  let player = Object.fromEntries(
    ["x", "y", "vx", "vy"].map((key) => [key, first.state.player[key]]),
  );
  const commands = first.prediction.pendingInputs.map((input) => ({
    tick: packet0 + input.time * rate,
    action: input.action,
  }));
  const actualCommands = commands.map((command) => ({
    ...command,
    tick: command.tick + (command.tick > packet0 ? delayTicks : 0),
  }));
  const times = [],
    decisions = [];
  let minimumClearance = Infinity,
    collision;
  for (let i = 0; i < rows.length - 1 && !collision; i++) {
    const frame = rows[i],
      next = rows[i + 1];
    const state = {
      ...frame.state,
      player: { ...frame.state.player, ...player },
    };
    const packet = state.packet,
      at = (packet - packet0) * dt * 1000;
    // Keep the recorded capture/compute/input budget fixed across policies.
    // Local wall-clock timing is reported separately from simulated arrivals.
    const reactionTime =
      first.prediction?.reactionTime ?? (first.inputDelayMs + 1000 * dt) / 1000;
    const reactionTicks = Math.ceil(reactionTime * rate);
    const currentAction =
      commands.findLast((c) => c.tick <= packet)?.action ?? "stay";
    const pendingInputs = [
      { time: 0, action: currentAction },
      ...commands
        .filter((c) => c.tick > packet)
        .map((c) => ({
          time: (c.tick - packet) * dt,
          action: c.action,
        })),
    ];
    movement.observe(state, at);
    const started = performance.now();
    const route = navigation.update(state, at);
    const candidates = planner.planActions(state, {
      ...movement.planOptions(at),
      reactionTime,
      pendingInputs,
      navigation: route,
    });
    times.push(performance.now() - started);
    const action = movement.select(candidates, undefined, at);
    const chosen = candidates.find((c) => c.action === action);
    movement.record(action, at + dt * 1000);
    if (commands.at(-1)?.action !== action) {
      commands.push({ tick: packet + reactionTicks, action });
      actualCommands.push({
        tick: packet + reactionTicks + delayTicks,
        action,
      });
    }
    decisions.push({
      packet,
      action,
      clearance: chosen.physicalClearance,
      continued: chosen.continuedPlan ?? false,
    });
    const ticks = next.state.packet - packet;
    const following = new Map(next.state.hazards.map((h) => [h.id, h]));
    const auraKey = (a, i) => `${a.id ?? i}:${a.type}`;
    const followingAuras = new Map(
      (next.state.auras ?? []).map((a, i) => [auraKey(a, i), a]),
    );
    const interpolate = (a, b, fraction) => ({
      x: a.x + (b.x - a.x) * fraction,
      y: a.y + (b.y - a.y) * fraction,
    });
    for (let tick = 0; tick < ticks && !collision; tick++) {
      const executed =
        actualCommands.findLast((c) => c.tick <= packet + tick + 1)?.action ??
        "stay";
      let auraMultiplier = 1;
      const inShelter = state.area.zones.some(
        (z) => z.type === 4 && circleInZone(player, z, state.player.radius),
      );
      if (!state.player.ignoreAuras && !inShelter) {
        const applied = new Set();
        for (const [index, aura] of (state.auras ?? []).entries()) {
          const after = followingAuras.get(auraKey(aura, index));
          if (!after) throw new Error("Aura sources changed during replay");
          const at = interpolate(aura, after, tick / ticks);
          const reach = aura.auraRadius + state.player.radius;
          if (
            !applied.has(aura.type) &&
            (player.x - at.x) ** 2 + (player.y - at.y) ** 2 < reach ** 2
          ) {
            applied.add(aura.type);
            auraMultiplier *= Math.max(
              0,
              1 - aura.reduction * (state.player.effectsMultiplier ?? 1),
            );
          }
        }
      }
      const position = advancePlayer(
        player,
        executed,
        state.player,
        state.area,
        dt,
        auraMultiplier,
      );
      const sheltered = state.area.zones.some(
        (z) =>
          z.type === 4 &&
          circleInZone(player, z, state.player.radius) &&
          circleInZone(position, z, state.player.radius),
      );
      if (!sheltered)
        for (const h of state.hazards) {
          const other = following.get(h.id);
          if (!other)
            throw new Error(`Enemy ${h.id} disappeared during replay`);
          const gap = sweptClearance(
            player,
            position,
            interpolate(h, other, tick / ticks),
            interpolate(h, other, (tick + 1) / ticks),
            state.player.radius + h.radius * (h.square ? Math.SQRT2 : 1),
          );
          minimumClearance = Math.min(minimumClearance, gap);
          if (gap <= 0) {
            collision = { packet: packet + tick + 1, enemy: h.id, gap };
            break;
          }
        }
      player = { ...player, ...position };
    }
  }
  times.sort((a, b) => a - b);
  return {
    fromFrame,
    delayTicks,
    survivedRecordedWindow: !collision,
    collision,
    seconds: (rows.at(-1).state.packet - packet0) * dt,
    minimumClearance,
    progress: player.x - first.state.player.x,
    decisions: decisions.length,
    turns: decisions.filter((c, i) => i && c.action !== decisions[i - 1].action)
      .length,
    continuedPlans: decisions.filter((c) => c.continued).length,
    focusFraction:
      decisions.filter((c) => c.action.startsWith("focus_")).length /
      decisions.length,
    medianPlanMs: times[Math.floor(times.length * 0.5)],
    p95PlanMs: times[Math.floor(times.length * 0.95)],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      trace: { type: "string" },
      baseline: { type: "string" },
      "from-frame": { type: "string", default: "140" },
      "delay-ticks": { type: "string", default: "0" },
      output: { type: "string" },
    },
  });
  if (!values.trace) throw new Error("Pass --trace artifacts/death-....json");
  const trace = JSON.parse(await readFile(values.trace, "utf8"));
  const policies = [["current", new URL("../src/", import.meta.url)]];
  if (values.baseline)
    policies.unshift(["baseline", pathToFileURL(`${values.baseline}/`)]);
  const results = [];
  for (const [name, directory] of policies) {
    const planner = await import(new URL("planner.js", directory));
    const { MovementPolicy } = await import(new URL("movement.js", directory));
    const { Navigation: NavigationClass } = await import(
      new URL("navigation.js", directory)
    );
    results.push({
      name,
      ...replayEncounter(trace, planner, MovementPolicy, {
        fromFrame: Number(values["from-frame"]),
        delayTicks: Number(values["delay-ticks"]),
        NavigationClass,
      }),
    });
  }
  const report = {
    trace: values.trace,
    scope:
      "Recorded enemy positions; simulated player and command delay. Covers only the recorded window, not a complete level or live run.",
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (values.output)
    await writeFile(values.output, JSON.stringify(report, null, 2));
}
