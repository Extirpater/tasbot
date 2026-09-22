import { parseArgs } from "node:util";
import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openGameBrowser } from "./browser.js";
import { MotionTracker } from "./observe.js";
import { planResponsiveActions } from "./planner.js";
import { LIVE_PROFILE, prepareLivePlanning } from "./live-models.js";
import { JevPolicy } from "./jev.js";
import { speedUpgradeKey } from "./upgrades.js";
import { InputTiming, ObservationClock, PacketClock } from "./timing.js";
import { MovementPolicy } from "./movement.js";
import { Navigation } from "./navigation.js";
import { CandyPolicy } from "./candy.js";
import { RescuePolicy } from "./rescue.js";
import { DecisionLoop, PageController } from "./controller.js";
import { RAVEL_BROWSER_PROFILE, ravelControlScript, prepareRavelPlanning } from "./ravel/browser.js";

const { values: options } = parseArgs({
  options: {
    policy: { type: "string", default: "jev" },
    game: { type: "string", default: "evades" },
    heading: { type: "string", default: "right" },
    inspect: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    attach: { type: "boolean", default: false },
    "cdp-url": { type: "string" },
    duration: { type: "string", default: "0" },
    "no-upgrades": { type: "boolean", default: false },
    "no-candy": { type: "boolean", default: false },
    "max-speed": { type: "string", default: "510" },
    help: { type: "boolean", short: "h" },
  },
});

if (options.help) {
  console.log(`Evades.io + Jev experimental controller

npm start                      Jev + local collision guard (requires .env key)
npm run baseline               Local controller, no model or API key
npm run inspect                Read game state without controlling the player
npm run baseline -- --attach   Use the Evades tab in your running Chrome
npm run ravel:play             Open Ravel with the assisted controller
npm run ravel:play -- --attach  Use your existing Ravel tab

Options: --heading right|left|up|down  --duration SECONDS  --headless
         --max-speed 510  --no-upgrades  --no-candy  --attach
         --cdp-url http://127.0.0.1:9222  --game evades|ravel
For --attach: enable chrome://inspect/#remote-debugging in Chrome,
log in normally, then accept Chrome's connection prompt when this starts.
Attach keeps your existing tab and leaves Chrome open on exit.
In the browser: join a game, select a hero, click outside chat, press P.
P pauses/resumes; Escape stops; switching windows pauses. Ctrl+C quits.
In Evades, R rescues the nearest downed player. In Ravel, R keeps its native action.
Ravel supports Candy/Basic, FPS Limit 60, Input/Tick Delay 0, and keyboard steering.
Objective: fastest safe progress toward the exit (right by default).
Uses full speed whenever predicted safe; Shift is a temporary dodge option.
--max-speed limits automatic upgrades only (510 = 17 in the legacy HUD).
Use --no-upgrades to manage all upgrades yourself.
Candy automatically uses Sweet Tooth (X) to refresh the boost or restore energy.
Use --no-candy to manage Sweet Tooth yourself.`);
  process.exit(0);
}

let browserSession, decisions, pageController;
let stop = false;
process.once("SIGINT", () => {
  stop = true;
});
process.once("SIGTERM", () => {
  stop = true;
});

async function run() {
  if (!["evades", "ravel"].includes(options.game)) throw new Error("--game must be evades or ravel");
  const ravel = options.game === "ravel", gameName = ravel ? "Ravel" : "Evades";
  const profile = ravel ? RAVEL_BROWSER_PROFILE : LIVE_PROFILE;
  const ravelPolicy = ravel ? JSON.parse(await readFile(new URL("../data/ravel-policy.json", import.meta.url))).policy : undefined;
  const controllerRevision = createHash("sha256")
    .update(
      (
        await Promise.all(
          [
            "cli",
            "browser",
            "controller",
            "observe",
            "planner",
            "live-models",
            "timing",
            "movement",
            "navigation",
            "candy",
            "rescue",
            "upgrades",
            "jev",
            ...(ravel ? ["ravel/browser", "ravel/observe", "ravel/models"] : []),
          ].map((name) =>
            readFile(new URL(`./${name}.js`, import.meta.url), "utf8"),
          ),
        )
      ).join("\n"),
    )
    .digest("hex")
    .slice(0, 12);
  if (!["jev", "baseline"].includes(options.policy))
    throw new Error("--policy must be jev or baseline");
  if (!["right", "left", "up", "down"].includes(options.heading))
    throw new Error("Invalid --heading");
  const duration = Number(options.duration);
  const maxSpeed = Number(options["max-speed"]);
  if (!Number.isFinite(maxSpeed) || maxSpeed < 150 || maxSpeed > 510)
    throw new Error(
      "--max-speed must be between 150 and 510 world units/second",
    );
  if (!Number.isFinite(duration) || duration < 0)
    throw new Error("--duration must be a nonnegative number");
  if (!options.inspect && options.policy === "jev") {
    decisions = new DecisionLoop(
      new JevPolicy({
        apiKey: process.env.TYPESAFE_API_KEY,
        model: process.env.JEV_MODEL || "jev-latest",
      }),
      {
        onError: (error, disabled) =>
          console.error(
            `${error.message}; using baseline${disabled ? ". Fix configuration and restart." : " during backoff."}`,
          ),
      },
    );
  }
  await mkdir("logs", { recursive: true });
  const logPath = resolve(
    "logs",
    `${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
  );
  if (options.attach)
    console.log(
      "Connecting to your running Chrome. Enable chrome://inspect/#remote-debugging and accept Chrome's connection prompt.",
    );
  browserSession = await openGameBrowser({
    attach: options.attach,
    cdpUrl: options["cdp-url"],
    channel: process.env.BROWSER_CHANNEL || "chrome",
    headless: options.headless,
    game: options.game,
  });
  const { context, page } = browserSession;
  context.on("close", () => {
    stop = true;
  });
  page.on("close", () => {
    stop = true;
  });
  pageController = new PageController(page, ravel ? { installScript: ravelControlScript() } : {});
  await pageController.read();
  console.log(
    `${browserSession.attached ? "Attached to your" : "Opened"} ${gameName} (${options.inspect ? "inspect only" : options.policy}). ${ravel ? "Choose Candy or Basic and Enter game." : "Join a game and choose a hero."}`,
  );
  console.log(
    ravel ? "P toggles assist. Escape or WASD pauses; Ctrl+C quits. R keeps its native Ravel action. After a death, press P to retry. Use FPS Limit 60, Input/Tick Delay 0 and mouse steering off."
      : "Press P to enable movement. R rescues the nearest downed player here (press again to cancel). Escape pauses; Ctrl+C quits. Status appears in this terminal.",
  );
  console.log(`Session log: ${logPath}`);
  console.log(`Controller revision: ${controllerRevision}`);
  console.log(`Controller profile: ${profile}`);
  const tracker = new MotionTracker();
  const timing = new InputTiming();
  if (ravel) timing.delayMs = 0;
  const observationClock = new ObservationClock();
  const packetClock = new PacketClock();
  const movement = new MovementPolicy(ravelPolicy);
  const navigation = new Navigation();
  const candy = new CandyPolicy();
  const rescue = new RescuePolicy();
  const started = performance.now();
  let lastArea,
    lastEpoch,
    lastDocument,
    lastRescueRequest,
    lastObjective,
    lastPacket,
    wasActive = false;
  let previousAction = "stay";
  let lastPlannedPacket, lastCandidates, lastPlanAt;
  let decisionCadenceMs = 50, lastDecisionAt, lastPlanning;
  let lastInputMs = 5,
    previousTick = started;
  let lastUpgradeAt = 0,
    wasDowned = false;
  const recentFrames = [];
  let lastLog = 0,
    lastMessage = "";
  const message = (text) => {
    if (text !== lastMessage) {
      console.log(text);
      lastMessage = text;
    }
  };
  while (
    !stop &&
    (!duration || performance.now() - started < duration * 1000)
  ) {
    const tick = performance.now();
    const loopMs = tick - previousTick;
    previousTick = tick;
    const observationStarted = performance.now();
    const { control, raw } = await pageController.read();
    const receivedAt = performance.now();
    const observation = observationClock.observe(
      raw.time,
      observationStarted,
      receivedAt,
    );
    const stateAt = ravel && Number.isFinite(raw.physicsAt)
      ? observation.at - Math.max(0, raw.time - raw.physicsAt) : observation.at;
    const packetObservation = packetClock.observe(raw, stateAt, receivedAt);
    const newSession = raw.ready && raw.packet < lastPacket;
    if (newSession) { timing.reset(); if (ravel) timing.delayMs = 0; }
    if (raw.ready && (raw.packet !== lastPacket || raw.area.id !== lastArea)) {
      lastPacket = raw.packet;
    }
    const state = raw.ready ? tracker.update(raw) : raw;
    const validGeometry =
      state.ready &&
      [
        state.player.x,
        state.player.y,
        state.player.radius,
        state.player.speed,
        state.area.x,
        state.area.y,
        state.area.width,
        state.area.height,
      ].every(Number.isFinite) &&
      state.area.width > 2 * state.player.radius &&
      state.area.height > 2 * state.player.radius;
    const stale = packetObservation.ageMs > 750;
    const active =
      !options.inspect &&
      control.enabled &&
      validGeometry &&
      !state.player.downed &&
      !stale;
    const objective = rescue.update(state, control, active && !newSession);
    const objectiveId = objective
      ? `rescue:${objective.areaId}:${objective.id}`
      : "exit";
    const rescueRetarget =
      active &&
      wasActive &&
      !newSession &&
      lastDocument === control.document &&
      lastArea === state.area?.id &&
      (lastEpoch === control.epoch ||
        (control.epoch === lastEpoch + 1 &&
          lastRescueRequest !== control.rescueRequest));
    if (
      lastEpoch !== control.epoch ||
      lastDocument !== control.document ||
      lastArea !== state.area?.id ||
      newSession ||
      lastObjective !== objectiveId ||
      (wasActive && !active)
    ) {
      decisions?.reset();
      // Area changes and brief pauses do not change network latency. Keep the
      // calibrated delay and commands still in flight, including this release.
      if (rescueRetarget) movement.retarget();
      else movement.reset();
      navigation.reset();
      lastPlannedPacket = undefined;
      lastCandidates = undefined;
      lastPlanAt = undefined;
      lastDecisionAt = undefined;
      lastPlanning = undefined;
      if (!rescueRetarget) {
        candy.release();
        await pageController.release();
        timing.record("stay", performance.now());
        previousAction = "stay";
      }
    }
    lastEpoch = control.epoch;
    lastDocument = control.document;
    lastRescueRequest = control.rescueRequest;
    lastArea = state.area?.id;
    lastObjective = objectiveId;
    wasActive = active;
    let status,
      action = "stay",
      source = "paused";
    let candidates, planMs, prediction;
    let decisionReason;
    let navigationMs = 0;
    const observedAt = performance.now();
    if (!state.ready) status = state.reason;
    else if (!validGeometry)
      status = "Unsupported game state: missing geometry or speed.";
    else if (state.player.downed)
      status = ravel ? "Died — assist paused. Press P when ready to retry." : "Player downed — waiting for revival.";
    else if (stale) status = "Game state stopped updating — paused.";
    else if (options.inspect)
      status = `Inspect · area ${state.area.number} · ${state.hazards.length} hazards · speed ${state.player.speed}`;
    else if (!control.enabled) status = "Paused — P to start";
    else {
      if (!ravel) timing.observe(state, packetObservation.at);
      movement.observe(state, observedAt, timing.delayMs);
      if (lastCandidates && state.packet === lastPlannedPacket &&
        observedAt - lastPlanAt < Math.max(25, 1000 / (state.tickRate ?? 60))) {
        action = previousAction;
        candidates = lastCandidates;
        planMs = 0;
        decisionReason = "retain checked input";
        source = "baseline";
      } else {
        const planStarted = performance.now();
        lastPlanAt = planStarted;
        if (lastDecisionAt !== undefined && planStarted - lastDecisionAt < 250)
          decisionCadenceMs = 0.8 * decisionCadenceMs + 0.2 * (planStarted - lastDecisionAt);
        lastDecisionAt = planStarted;
        const prepared = (ravel ? prepareRavelPlanning : prepareLivePlanning)(state, {
          policy: ravelPolicy,
          heading: options.heading, objective, decisionMs: decisionCadenceMs,
          previousIntervalTicks: lastPlanning?.inputIntervalTicks,
        });
        lastPlanning = { ...prepared.options, models: prepared.models };
        const route = navigation.update(
          prepared.state,
          observedAt,
          options.heading,
          objective,
        );
        navigationMs = performance.now() - planStarted;
        const planned = planResponsiveActions(prepared.state, {
          heading: options.heading,
          ...movement.planOptions(observedAt, options.heading),
          ...prepared.options,
          predictionAt: (commandAt) =>
            timing.pending(packetObservation.at, commandAt - packetObservation.at),
          inputMs: lastInputMs,
          maxPlanMs: packetObservation.repeat ? 8 : 18,
          navigation: route,
          objective,
        });
        ({ candidates, prediction } = planned);
        prediction.lagRecheck = planned.lagRecheck;
        prediction.timingRecheck = planned.timingRecheck;
        planMs = performance.now() - planStarted;
        lastPlannedPacket = state.packet;
        lastCandidates = candidates;
        if (
          !objective &&
          decisions &&
          candidates.filter((c) => !c.collision).length > 1
        )
          decisions.request(candidates, state.area.id, tick);
        const decision = objective ? null : decisions?.get(state.area.id, tick);
        action = movement.select(
          candidates,
          decision?.action,
          performance.now(),
        );
        decisionReason = movement.reason;
        source = decision && decision.action === action ? "jev" : "baseline";
      }
      status = `${source} → ${action} · area ${state.area.number} · ${objective ? rescue.message : `fastest safe ${options.heading}${rescue.message ? ` · ${rescue.message}` : ""}`} · delay ${timing.delayMs} ms`;
    }
    const inputStarted = performance.now();
    // Reject a pause or navigation that happened while planning this action.
    const candyKeys =
      active && !options["no-candy"]
        ? candy.keys(state, action, performance.now())
        : [];
    const applied = await pageController.apply(
      control,
      active,
      action,
      candyKeys,
      state.input?.controllerKeys,
      Boolean(objective),
    );
    const stillActive = applied.active;
    if (!stillActive) candy.release();
    const appliedAt = performance.now();
    lastInputMs = appliedAt - inputStarted;
    timing.record(stillActive ? action : "stay", appliedAt);
    movement.record(stillActive ? action : "stay", appliedAt);
    previousAction = stillActive ? action : "stay";
    if (
      stillActive &&
      !options["no-upgrades"] &&
      !action.startsWith("focus_") &&
      tick - lastUpgradeAt >= 250
    ) {
      const key = speedUpgradeKey(state, maxSpeed);
      if (key) {
        await page.keyboard.press(key, { delay: 20 });
        lastUpgradeAt = tick;
      }
    }
    if (stillActive) {
      recentFrames.push({
        elapsedMs: Math.round(tick - started),
        state,
        action,
        candidates,
        planMs,
        planning: lastPlanning,
        loopMs,
        inputDelayMs: timing.delayMs,
        inputTimingSamples: timing.samples,
        prediction,
        observedAt: observedAt - started,
        capturedAt: observation.at - started,
        snapshotAgeMs: observation.ageMs,
        packetAgeMs: packetObservation.ageMs,
        stateAt: packetObservation.at - started,
        observationMs: observation.roundTripMs,
        inputMs: lastInputMs,
        keyChanges: applied.changes,
        appliedAt: appliedAt - started,
        decisionReason,
        actionAgeMs: movement.age(appliedAt),
        stalled: movement.stalled,
        waypoint: navigation.route?.waypoint,
        navigationMs,
        candyKeys,
        objective,
      });
      if (recentFrames.length > 200) recentFrames.shift();
    } else if (!state.player?.downed) recentFrames.length = 0;
    if (state.player?.downed && !wasDowned && recentFrames.length) {
      await mkdir("artifacts", { recursive: true });
      const tracePath = resolve("artifacts", `${ravel ? "ravel-browser-death" : "death"}-${Date.now()}.json`);
      await writeFile(
        tracePath,
        JSON.stringify({
          controllerRevision,
          controllerProfile: profile,
          frames: recentFrames,
          finalState: state,
        }),
      );
      console.log(
        `Saved the last ${recentFrames.length} decisions before death: ${tracePath}`,
      );
      recentFrames.length = 0;
    }
    wasDowned = Boolean(state.player?.downed);
    if (tick - lastLog >= 1000) {
      message(status);
      await appendFile(
        logPath,
        JSON.stringify({
          controllerRevision,
          controllerProfile: profile,
          elapsedMs: Math.round(tick - started),
          status,
          action: stillActive ? action : "stay",
          source,
          area: state.area?.id,
          areaGeometry: state.area,
          packet: state.packet,
          player: state.player,
          input: state.input,
          hazardCount: state.hazards?.length,
          // Enough nearby motion data to diagnose the next collision.
          hazards: state.hazards?.filter(
            (h) => Math.hypot(h.x - state.player.x, h.y - state.player.y) < 500,
          ),
          tickRate: state.tickRate,
          planMs,
          planning: lastPlanning,
          loopMs,
          snapshotAgeMs: observation.ageMs,
          packetAgeMs: packetObservation.ageMs,
          observationMs: observation.roundTripMs,
          inputMs: lastInputMs,
          keyChanges: applied.changes,
          inputDelayMs: timing.delayMs,
          inputTimingSamples: timing.samples,
          prediction,
          decisionReason,
          // Successful runs need route-choice evidence too, not only a death
          // trace. Keep the alternatives compact at the existing 1 Hz cadence.
          choices: candidates?.map((c) => ({
            action: c.action,
            collision: c.collision,
            clearance: c.physicalClearance,
            score: c.score,
            firstProgress: c.firstProgress,
            firstMovement: c.firstMovement,
            progress: c.progress,
            searchLimited: c.searchLimited,
            searchedRoots: c.searchedRoots,
          })),
          actionAgeMs: movement.age(appliedAt),
          stalled: movement.stalled,
          waypoint: navigation.route?.waypoint,
          navigationMs,
          candyKeys,
          objective,
          maxSpeed,
          modelCalls: decisions?.calls ?? 0,
          inputTokens: decisions?.inputTokens ?? 0,
          modelLatencyMs: decisions?.latencyMs,
        }) + "\n",
      );
      lastLog = tick;
    }
    await delay(Math.max(0, 1000 / 60 - (performance.now() - tick)));
  }
}

try {
  await run();
} catch (error) {
  if (!stop) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  decisions?.reset();
  await pageController?.release().catch(() => {});
  await pageController?.dispose().catch(() => {});
  await browserSession?.close().catch(() => {});
}
