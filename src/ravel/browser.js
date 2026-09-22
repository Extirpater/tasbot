import { installControls } from "../controller.js";
import { createRavelObserver } from "./observe.js";
import { withRavelModels } from "./models.js";

export const RAVEL_BROWSER_PROFILE = "ravel-assisted-v1";

// Runs beside Ravel's ordinary scripts. Instrument update/death boundaries only;
// the browser's own loop still advances physics and its key handlers own inputs.
export function installRavelObservation(createObserver) {
  if (typeof game === "undefined" || typeof settings === "undefined")
    return () => ({ ready: false, reason: "Open the Ravel game page." });
  let tick = 0, physicsAt = performance.now(), fatalState, observationError;
  const ids = new WeakMap();
  let nextId = 1;
  const originalUpdate = game.update, originalKill = kill;
  const observeNative = createObserver({ game, getTick: () => tick, getTime: () => performance.now(),
    idFor: e => { if (!ids.has(e)) ids.set(e, nextId++); return ids.get(e); },
    areaId: p => `ravel:${p.world}:${p.area}:${game.worlds[p.world].name}`,
    downed: p => Boolean(p.isDead),
  });
  const update = function (...args) {
    tick++;
    const result = originalUpdate.apply(this, args);
    physicsAt = performance.now();
    return result;
  };
  const recordKill = function (player, ...args) {
    if (!fatalState && player === game.players[0]) {
      try {
        fatalState = observeNative();
        fatalState.player.downed = true;
        fatalState.physicsAt = fatalState.time;
      } catch (error) {
        // Instrumentation must never prevent Ravel from applying a real death.
        observationError = error.message;
      }
    }
    return originalKill.call(this, player, ...args);
  };
  game.update = update;
  kill = recordKill;
  const requiredBindings = { up: 38, down: 40, left: 37, right: 39, slow: 16,
    ability2: 88, upgrade_speed: 49 };
  const observe = () => {
    if (observationError) return { ready:false, reason:`Ravel observation failed; assist paused: ${observationError}` };
    if (inMenu || !game.players[0]) return { ready: false, reason: "Choose Candy or Basic, then Enter game." };
    if (!["Basic", "Candy"].includes(game.players[0].className))
      return { ready: false, reason: "Ravel assist currently supports Candy and Basic. Choose either hero." };
    if (settings.fps_limit !== "60" || tick_speed !== 1 || settings.input_delay || settings.tick_delay)
      return { ready: false, reason: "Ravel assist needs FPS Limit 60, normal game speed, Input Delay 0 and Tick Delay 0." };
    if (mouse) return { ready: false, reason: "Turn off mouse steering before enabling Ravel assist." };
    if (Object.entries(requiredBindings).some(([action, code]) => !keybinds[action]?.includes(code)))
      return { ready: false, reason: "Ravel assist needs default arrow/Shift/X/1 bindings." };
    if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]'))
      return { ready: false, reason: "Click outside the menu or text field, then press P." };
    const raw = fatalState ? { ...fatalState, time: performance.now() } : observeNative();
    return { ...raw, physicsAt: fatalState?.physicsAt ?? physicsAt,
      input: {
        manualDirectionHeld: [65, 68, 83, 87].some(code => keys[code]),
        controllerKeys: Object.entries({ ArrowUp:38, ArrowDown:40, ArrowLeft:37, ArrowRight:39, Shift:16, x:88 })
          .filter(([,code]) => keys[code]).map(([key]) => key),
      },
    };
  };
  observe.resume = () => { fatalState = undefined; observationError = undefined; };
  observe.dispose = () => {
    if (game.update === update) game.update = originalUpdate;
    if (kill === recordKill) kill = originalKill;
  };
  return observe;
}

export function ravelControlScript() {
  return `(${installControls.toString()})((` + installRavelObservation.toString() +
    `)(${createRavelObserver.toString()}), ${JSON.stringify({ rescue:false, keyTarget:"document", pauseOnDeath:true, exclusive:true,
      manualCodes:["KeyW","KeyA","KeyS","KeyD","KeyT","KeyE","KeyR","End","BracketLeft","BracketRight","Backslash"] })})`;
}

export function prepareRavelPlanning(state, { policy, heading = "right", decisionMs = 50,
  previousIntervalTicks } = {}) {
  let prepared = withRavelModels(state);
  if (policy.avoidBackExit && heading === "right") {
    const backwards = state.area.zones.filter(z => z.type === 2 && z.x + z.width / 2 < state.area.x + state.area.width / 2);
    prepared = { ...prepared, area: { ...prepared.area, walls: [...(prepared.area.walls ?? []), ...backwards] } };
  }
  const large = state.hazards.some(h => h.dash && h.radius * 2 >= state.area.height / 4);
  let interval = Math.max(1, Math.min(8, Math.round(decisionMs * 60 / 1000)));
  if (Number.isInteger(previousIntervalTicks) && previousIntervalTicks > interval &&
    decisionMs > (previousIntervalTicks - 1.5) * 1000 / 60) interval = previousIntervalTicks;
  return { state: prepared, options: { margin:policy.margin, beamWidth:policy.beamWidth,
    horizon:Math.max(policy.horizon, state.player.slip ? 2 : large ? 1.5 : 0), inputIntervalTicks:interval },
    models: { environment:"ravel", nativePhases:true } };
}
