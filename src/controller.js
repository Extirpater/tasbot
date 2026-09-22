import { ACTIONS } from "./planner.js";
import { observeGame } from "./observe.js";

export class KeyboardController {
  held = new Set();
  constructor(keyboard) {
    this.keyboard = keyboard;
  }
  async set(action, auxiliaryKeys = [], observedKeys) {
    const next = new Set([...(ACTIONS[action]?.keys ?? []), ...auxiliaryKeys]);
    if (observedKeys) {
      const observed = new Set(observedKeys);
      // The page (or a physical key release) can clear a direction independently
      // of Playwright. Re-press it with repeat=false instead of trusting our cache.
      for (const key of this.held)
        if (next.has(key) && !observed.has(key)) {
          await this.keyboard.up(key);
          this.held.delete(key);
        }
      for (const key of observed)
        if ((key.startsWith("Arrow") || key === "Shift") && !next.has(key)) {
          await this.keyboard.up(key);
          this.held.delete(key);
        }
    }
    for (const key of this.held) {
      if (!next.has(key)) {
        await this.keyboard.up(key);
        this.held.delete(key);
      }
    }
    for (const key of next) {
      if (!this.held.has(key)) {
        await this.keyboard.down(key);
        this.held.add(key);
      }
    }
  }
  async release() {
    await this.set("stay");
  }
}

// Inference is asynchronous; late answers must not resume movement after a
// pause, death, navigation, or transition into a different area.
export class DecisionLoop {
  pending = null;
  decision = null;
  epoch = 0;
  nextRequest = 0;
  failures = 0;
  disabled = false;
  calls = 0;
  inputTokens = 0;
  latencyMs = null;

  constructor(
    policy,
    { intervalMs = 250, maxAgeMs = 500, onError = () => {} } = {},
  ) {
    Object.assign(this, { policy, intervalMs, maxAgeMs, onError });
  }

  reset() {
    this.epoch++;
    this.decision = null;
    this.pending?.abort();
  }

  request(candidates, areaId, now = performance.now()) {
    if (this.pending || this.disabled || now < this.nextRequest) return;
    const epoch = this.epoch;
    const abort = new AbortController();
    this.pending = abort;
    this.nextRequest = now + this.intervalMs;
    this.calls++;
    const started = performance.now();
    this.policy
      .decide(candidates, { signal: abort.signal })
      .then((answer) => {
        if (abort.signal.aborted || epoch !== this.epoch) return;
        this.failures = 0;
        this.latencyMs = Math.round(performance.now() - started);
        if (answer) {
          this.inputTokens += answer.inputTokens;
          this.decision = { ...answer, requestedAt: now, areaId };
        }
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        this.failures++;
        this.decision = null;
        this.disabled = [400, 401, 403, 422].includes(error.status);
        this.nextRequest =
          performance.now() +
          Math.min(30000, 1000 * 2 ** Math.min(this.failures - 1, 5));
        this.onError(error, this.disabled);
      })
      .finally(() => {
        if (this.pending === abort) this.pending = null;
      });
  }

  get(areaId, now = performance.now()) {
    const d = this.decision;
    return d &&
      d.areaId === areaId &&
      now - d.requestedAt <= this.maxAgeMs &&
      d.confidence >= 0.25
      ? d
      : null;
  }
}

// The returned object is kept by a JSHandle, never assigned to the page's
// globals. The rescue button is ordinary UI. Emergency releases remain local
// so a stalled Node process cannot leave the last movement command held.
export function installControls(observe, { rescue = true, keyTarget = "window", pauseOnDeath = false,
  exclusive = false, manualCodes = ["KeyW", "KeyA", "KeyS", "KeyD"] } = {}) {
  let owner;
  if (exclusive) {
    if (document.querySelector("[data-ravel-assist-owner]")) {
      observe.dispose?.();
      throw new Error("Ravel assist is already attached. Stop its terminal first, or reload after a crashed session.");
    }
    owner = document.createElement("span");
    owner.hidden = true;
    owner.setAttribute("data-ravel-assist-owner", "");
    document.body.append(owner);
  }
  const inputTarget = keyTarget === "document" ? document : window;
  const control = {
    enabled: false,
    epoch: 0,
    rescueRequest: 0,
    heartbeat: performance.now(),
  };
  let rescuing = false;
  const held = new Set();
  const keyCodes = {
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Shift: 16,
    x: 88,
  };
  const dispatchKey = (type, key) => {
    if (type === "keydown") held.add(key);
    else held.delete(key);
    inputTarget.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code: key === "Shift" ? "ShiftLeft" : key === "x" ? "KeyX" : key,
        keyCode: keyCodes[key],
        which: keyCodes[key],
        shiftKey: held.has("Shift"),
        repeat: false,
        bubbles: true,
        cancelable: true,
      }),
    );
  };
  const rescueButton = document.createElement("button");
  rescueButton.type = "button";
  rescueButton.textContent = "Rescue nearest (R)";
  rescueButton.hidden = true;
  Object.assign(rescueButton.style, {
    position: "fixed",
    top: "12px",
    right: "12px",
    zIndex: "2147483647",
    padding: "9px 14px",
    borderRadius: "6px",
    border: "1px solid #8293ad",
    background: "#182234",
    color: "#fff",
    font: "14px system-ui",
    cursor: "pointer",
  });
  if (rescue) document.body.append(rescueButton);
  const requestRescue = () => {
    control.rescueRequest++;
    control.epoch++;
    control.heartbeat = performance.now();
  };
  const rescueClick = (event) => {
    event.stopImmediatePropagation();
    if (control.enabled) requestRescue();
    rescueButton.blur();
  };
  const stopPointer = (event) => event.stopPropagation();
  rescueButton.addEventListener("click", rescueClick);
  for (const name of ["pointerdown", "pointerup", "mousedown", "mouseup"])
    rescueButton.addEventListener(name, stopPointer);
  const releaseKeys = () => {
    for (const [key, keyCode] of [
      ["ArrowUp", 38],
      ["ArrowDown", 40],
      ["ArrowLeft", 37],
      ["ArrowRight", 39],
      ["Shift", 16],
      ["x", 88],
    ]) {
      inputTarget.dispatchEvent(
        new KeyboardEvent("keyup", {
          key,
          code: key === "Shift" ? "ShiftLeft" : key === "x" ? "KeyX" : key,
          keyCode,
          which: keyCode,
          bubbles: true,
        }),
      );
    }
    held.clear();
  };
  const pause = () => {
    control.enabled = false;
    rescuing = false;
    rescueButton.disabled = true;
    control.epoch++;
    releaseKeys();
  };
  const keydown = (event) => {
    const typing =
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      );
    // The controller only sends arrows. WASD is an unambiguous manual takeover;
    // leaving it mixed with bot arrows makes the actual direction unpredictable.
    if (
      control.enabled &&
      !typing &&
      manualCodes.includes(event.code)
    )
      pause();
    if (
      (event.code === "KeyP" || rescue && event.code === "KeyR") &&
      !typing &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        if (event.code === "KeyR") {
          requestRescue();
        } else {
          control.enabled = !control.enabled;
          control.epoch++;
          if (control.enabled) observe.resume?.();
        }
        control.heartbeat = performance.now();
        if (!control.enabled) releaseKeys();
      }
    }
    if (event.code === "Escape") pause();
  };
  const visibilitychange = () => {
    if (document.hidden) pause();
  };
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("blur", pause);
  window.addEventListener("pagehide", pause);
  document.addEventListener("visibilitychange", visibilitychange);
  const watchdog = setInterval(() => {
    if (control.enabled && performance.now() - control.heartbeat > 1500)
      pause();
  }, 100);
  return {
    read() {
      control.heartbeat = performance.now();
      const raw = observe();
      if (control.enabled && raw.input?.manualDirectionHeld) pause();
      if (control.enabled && pauseOnDeath && (!raw.ready || raw.player?.downed)) pause();
      const available =
        raw.ready &&
        raw.otherPlayers?.some(
          (p) =>
            p.downed &&
            p.rescueable !== false &&
            p.areaId === raw.area.id &&
            p.x >= raw.area.x &&
            p.x <= raw.area.x + raw.area.width &&
            p.y >= raw.area.y &&
            p.y <= raw.area.y + raw.area.height,
        );
      rescueButton.hidden = !raw.ready || (!available && !rescuing);
      rescueButton.disabled = !control.enabled || raw.player?.downed;
      rescueButton.textContent = rescuing
        ? "Cancel rescue (R)"
        : "Rescue nearest (R)";
      rescueButton.title = control.enabled
        ? "Rescue the nearest downed player in this area"
        : "Press P to enable the controller first";
      return {
        control: {
          enabled: control.enabled,
          epoch: control.epoch,
          rescueRequest: control.rescueRequest,
        },
        raw,
      };
    },
    isActive(epoch, rescue = false) {
      const active = control.enabled && control.epoch === epoch;
      if (active) rescuing = rescue;
      return active;
    },
    apply(epoch, active, keys, observedKeys, rescue = false) {
      // One synchronous batch: the game's input sampler cannot see only half
      // of a reversal, and a pause cannot race a separate key-down RPC.
      const typing = document.activeElement?.matches?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      );
      if (control.enabled && (typing || document.hidden)) pause();
      active = active && control.enabled && control.epoch === epoch;
      if (active) rescuing = rescue;
      const next = new Set(active ? keys.filter((key) => keyCodes[key]) : []);
      const observed = active && observedKeys ? new Set(observedKeys) : held;
      const releases = new Set(
        [...held, ...observed].filter(
          (key) =>
            keyCodes[key] &&
            (!next.has(key) || (held.has(key) && !observed.has(key))),
        ),
      );
      let changes = 0;
      for (const key of releases) {
        dispatchKey("keyup", key);
        changes++;
      }
      for (const key of next)
        if (!held.has(key)) {
          dispatchKey("keydown", key);
          changes++;
        }
      control.heartbeat = performance.now();
      return { active, changes };
    },
    release() {
      for (const key of [...held]) dispatchKey("keyup", key);
    },
    dispose() {
      pause();
      clearInterval(watchdog);
      rescueButton.remove();
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", pause);
      window.removeEventListener("pagehide", pause);
      document.removeEventListener("visibilitychange", visibilitychange);
      observe.dispose?.();
      owner?.remove();
    },
  };
}

// Handles belong to one document. Reconnect paused after a reload, and reject
// decisions made from an observation of the previous document.
export class PageController {
  handle = null;
  document = 0;

  constructor(page, { installScript } = {}) {
    this.page = page;
    this.installScript = installScript ?? `(${installControls.toString()})(() => (${observeGame.toString()})())`;
    this.onNavigation = (frame) => {
      if (frame !== page.mainFrame()) return;
      this.document++;
    };
    page.on("framenavigated", this.onNavigation);
  }

  async read() {
    for (let attempt = 0; ; attempt++) {
      const startedDocument = this.document;
      try {
        if (this.handle && this.handleDocument !== this.document)
          await this.clearHandle();
        if (!this.handle) {
          await this.page.waitForLoadState("domcontentloaded");
          this.handleDocument = this.document;
          this.handle = await this.page.evaluateHandle(
            this.installScript,
          );
        }
        const document = this.handleDocument;
        const snapshot = await this.handle.evaluate((controls) =>
          controls.read(),
        );
        return { ...snapshot, control: { ...snapshot.control, document } };
      } catch (error) {
        if (attempt >= 2 || !this.navigationInterrupted(error, startedDocument))
          throw error;
        await this.clearHandle();
      }
    }
  }

  async isActive(control, active, rescuing = false) {
    if (!active || !this.handle || control.document !== this.document)
      return false;
    try {
      return await this.handle.evaluate(
        (controls, { epoch, rescuing }) => controls.isActive(epoch, rescuing),
        { epoch: control.epoch, rescuing },
      );
    } catch (error) {
      if (this.navigationInterrupted(error, control.document)) return false;
      throw error;
    }
  }

  async apply(
    control,
    active,
    action,
    auxiliaryKeys = [],
    observedKeys,
    rescuing = false,
  ) {
    if (!this.handle || control.document !== this.document)
      return { active: false, changes: 0 };
    try {
      return await this.handle.evaluate(
        (controls, args) => controls.apply(...args),
        [
          control.epoch,
          active,
          [...ACTIONS[action].keys, ...auxiliaryKeys],
          observedKeys,
          rescuing,
        ],
      );
    } catch (error) {
      if (this.navigationInterrupted(error, control.document))
        return { active: false, changes: 0 };
      throw error;
    }
  }

  async release() {
    if (this.handle)
      await this.handle
        .evaluate((controls) => controls.release())
        .catch((error) => {
          if (!this.navigationInterrupted(error, this.handleDocument))
            throw error;
        });
  }

  navigationInterrupted(error, document) {
    return (
      !this.page.isClosed() &&
      (document !== this.document ||
        /Execution context was destroyed|Cannot find context with specified id/.test(
          error.message,
        ))
    );
  }

  async clearHandle() {
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    // A full navigation has already destroyed the old context; a same-document
    // navigation still needs its listeners and watchdog removed explicitly.
    await handle.evaluate((controls) => controls.dispose()).catch(() => {});
    await handle.dispose().catch(() => {});
  }

  async dispose() {
    this.page.off("framenavigated", this.onNavigation);
    await this.clearHandle();
  }
}
