import { parseArgs } from "node:util";
import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openGameBrowser } from "./browser.js";
import { MotionTracker } from "./observe.js";
import { planActions } from "./planner.js";
import { JevPolicy } from "./jev.js";
import { speedUpgradeKey } from "./upgrades.js";
import { InputTiming, ObservationClock } from "./timing.js";
import { MovementPolicy } from "./movement.js";
import { Navigation } from "./navigation.js";
import { CandyPolicy } from "./candy.js";
import {
  KeyboardController,
  DecisionLoop,
  PageController,
} from "./controller.js";

const { values: options } = parseArgs({
  options: {
    policy: { type: "string", default: "jev" },
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

Options: --heading right|left|up|down  --duration SECONDS  --headless
         --max-speed 510  --no-upgrades  --no-candy  --attach
         --cdp-url http://127.0.0.1:9222
For --attach: enable chrome://inspect/#remote-debugging in Chrome,
log in normally, then accept Chrome's connection prompt when this starts.
Attach keeps your existing tab and leaves Chrome open on exit.
In the browser: join a game, select a hero, click outside chat, press P.
P pauses/resumes; Escape stops; switching windows pauses. Ctrl+C quits.
Objective: fastest safe progress toward the exit (right by default).
Uses full speed whenever predicted safe; Shift is a temporary dodge option.
--max-speed limits automatic upgrades only (510 = 17 in the legacy HUD).
Use --no-upgrades to manage all upgrades yourself.
Candy automatically uses Sweet Tooth (X) to refresh the boost or restore energy.
Use --no-candy to manage Sweet Tooth yourself.`);
  process.exit(0);
}

let browserSession, keyboard, decisions, pageController;
let stop = false;
process.once("SIGINT", () => {
  stop = true;
});
process.once("SIGTERM", () => {
  stop = true;
});

async function run() {
  const controllerRevision = createHash("sha256")
    .update(
      (
        await Promise.all(
          [
            "cli",
            "browser",
            "enemies",
            "enemy-motion",
            "controller",
            "observe",
            "planner",
            "timing",
            "movement",
            "navigation",
            "candy",
            "upgrades",
            "jev",
          ].map((name) =>
            readFile(new URL(`./${name}.js`, import.meta.url), "utf8"),
          ),
        )
      ).join("\n"),
    )
    .update(await readFile(new URL("../data/enemies.json", import.meta.url)))
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
  });
  const { context, page } = browserSession;
  context.on("close", () => {
    stop = true;
  });
  page.on("close", () => {
    stop = true;
  });
  keyboard = new KeyboardController(page.keyboard);
  pageController = new PageController(page);
  await pageController.read();
  console.log(
    `${browserSession.attached ? "Attached to your Evades tab" : "Opened Evades.io"} (${options.inspect ? "inspect only" : options.policy}). Join a game and choose a hero.`,
  );
  console.log(
    "Press P in the game to enable movement. Escape pauses; Ctrl+C quits. Status appears in this terminal.",
  );
  console.log(`Session log: ${logPath}`);
  console.log(`Controller revision: ${controllerRevision}`);
  const tracker = new MotionTracker();
  const timing = new InputTiming();
  const observationClock = new ObservationClock();
  const movement = new MovementPolicy();
  const navigation = new Navigation();
  const candy = new CandyPolicy();
  const started = performance.now();
  let lastArea,
    lastEpoch,
    lastDocument,
    lastPacket,
    lastPacketAt = started,
    wasActive = false;
  let previousAction = "stay";
  let lastPlannedPacket, lastCandidates;
  let lastPlanMs = 5,
    lastInputMs = 5,
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
    const newSession = raw.ready && raw.packet < lastPacket;
    if (newSession) timing.reset();
    if (raw.ready && (raw.packet !== lastPacket || raw.area.id !== lastArea)) {
      lastPacket = raw.packet;
      lastPacketAt = tick;
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
    const stale = tick - lastPacketAt > 750;
    const active =
      !options.inspect &&
      control.enabled &&
      validGeometry &&
      !state.player.downed &&
      !stale;
    if (
      lastEpoch !== control.epoch ||
      lastDocument !== control.document ||
      lastArea !== state.area?.id ||
      newSession ||
      (wasActive && !active)
    ) {
      decisions?.reset();
      // Area changes and brief pauses do not change network latency. Keep the
      // calibrated delay and commands still in flight, including this release.
      movement.reset();
      navigation.reset();
      candy.release();
      lastPlannedPacket = undefined;
      lastCandidates = undefined;
      await keyboard.release();
      timing.record("stay", performance.now());
      previousAction = "stay";
    }
    lastEpoch = control.epoch;
    lastDocument = control.document;
    lastArea = state.area?.id;
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
      status = "Player downed — waiting for revival.";
    else if (stale) status = "Game state stopped updating — paused.";
    else if (options.inspect)
      status = `Inspect · area ${state.area.number} · ${state.hazards.length} hazards · speed ${state.player.speed}`;
    else if (!control.enabled) status = "Paused — P to start";
    else {
      timing.observe(state, observation.at);
      movement.observe(state, observedAt);
      if (lastCandidates && state.packet === lastPlannedPacket) {
        action = previousAction;
        candidates = lastCandidates;
        planMs = 0;
        decisionReason = "await fresh packet";
        source = "baseline";
      } else {
        const planStarted = performance.now();
        const route = navigation.update(state, observedAt, options.heading);
        navigationMs = performance.now() - planStarted;
        // Commands are dated against the captured state. Read/serialization
        // lag belongs in the new command's budget, not in old turn timestamps.
        prediction = timing.pending(
          observation.at,
          observedAt - observation.at + lastPlanMs + Math.max(5, lastInputMs),
        );
        candidates = planActions(state, {
          heading: options.heading,
          ...movement.planOptions(observedAt, options.heading),
          ...prediction,
          navigation: route,
        });
        planMs = performance.now() - planStarted;
        lastPlanMs = planMs;
        lastPlannedPacket = state.packet;
        lastCandidates = candidates;
        if (decisions && candidates.filter((c) => !c.collision).length > 1)
          decisions.request(candidates, state.area.id, tick);
        const decision = decisions?.get(state.area.id, tick);
        action = movement.select(candidates, decision?.action, observedAt);
        decisionReason = movement.reason;
        source = decision && decision.action === action ? "jev" : "baseline";
      }
      status = `${source} → ${action} · area ${state.area.number} · fastest safe ${options.heading} · delay ${timing.delayMs} ms`;
    }
    const inputStarted = performance.now();
    // Reject a pause or navigation that happened while planning this action.
    const stillActive = await pageController.isActive(control, active);
    const candyKeys =
      stillActive && !options["no-candy"]
        ? candy.keys(state, action, performance.now())
        : [];
    if (!stillActive) candy.release();
    await keyboard.set(
      stillActive ? action : "stay",
      candyKeys,
      stillActive ? state.input?.controllerKeys : undefined,
    );
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
        loopMs,
        inputDelayMs: timing.delayMs,
        prediction,
        observedAt: observedAt - started,
        capturedAt: observation.at - started,
        snapshotAgeMs: observation.ageMs,
        observationMs: observation.roundTripMs,
        inputMs: lastInputMs,
        appliedAt: appliedAt - started,
        decisionReason,
        actionAgeMs: movement.age(appliedAt),
        stalled: movement.stalled,
        waypoint: navigation.route?.waypoint,
        navigationMs,
        candyKeys,
      });
      if (recentFrames.length > 200) recentFrames.shift();
    } else if (!state.player?.downed) recentFrames.length = 0;
    if (state.player?.downed && !wasDowned && recentFrames.length) {
      await mkdir("artifacts", { recursive: true });
      const tracePath = resolve("artifacts", `death-${Date.now()}.json`);
      await writeFile(
        tracePath,
        JSON.stringify({
          controllerRevision,
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
          harmlessCount: state.hazards?.filter((h) => h.harmless).length,
          learnedEnemyCount: state.hazards?.filter((h) => h.learnedMotion)
            .length,
          predictionFallbackCount: state.hazards?.filter(
            (h) => h.uncertainMotion && !h.learnedMotion,
          ).length,
          uncertainEnemyTypes: [
            ...new Set(
              state.hazards
                ?.filter((h) => h.uncertainMotion)
                .map((h) => h.typeName ?? h.entityType),
            ),
          ],
          // Enough nearby motion data to diagnose the next collision.
          hazards: state.hazards?.filter(
            (h) => Math.hypot(h.x - state.player.x, h.y - state.player.y) < 500,
          ),
          tickRate: state.tickRate,
          planMs,
          loopMs,
          snapshotAgeMs: observation.ageMs,
          observationMs: observation.roundTripMs,
          inputMs: lastInputMs,
          inputDelayMs: timing.delayMs,
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
          })),
          actionAgeMs: movement.age(appliedAt),
          stalled: movement.stalled,
          waypoint: navigation.route?.waypoint,
          navigationMs,
          candyKeys,
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
  await keyboard?.release().catch(() => {});
  await pageController?.dispose().catch(() => {});
  await browserSession?.close().catch(() => {});
}
