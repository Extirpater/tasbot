import { ACTIONS } from "./planner.js";
import { observeGame } from "./observe.js";
import { ENEMY_TYPES } from "./enemies.js";

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
// globals or DOM. Emergency releases remain local so a stalled Node process
// cannot leave the last movement command held indefinitely.
export function installControls(observe) {
  const control = {
    enabled: false,
    epoch: 0,
    heartbeat: performance.now(),
  };
  const releaseKeys = () => {
    for (const [key, keyCode] of [
      ["ArrowUp", 38],
      ["ArrowDown", 40],
      ["ArrowLeft", 37],
      ["ArrowRight", 39],
      ["Shift", 16],
      ["x", 88],
    ]) {
      window.dispatchEvent(
        new KeyboardEvent("keyup", {
          key,
          code: key === "Shift" ? "ShiftLeft" : key === "x" ? "KeyX" : key,
          keyCode,
          which: keyCode,
          bubbles: true,
        }),
      );
    }
  };
  const pause = () => {
    control.enabled = false;
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
      ["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)
    )
      pause();
    if (
      event.code === "KeyP" &&
      !typing &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        control.enabled = !control.enabled;
        control.epoch++;
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
      return {
        control: { enabled: control.enabled, epoch: control.epoch },
        raw,
      };
    },
    isActive(epoch) {
      return control.enabled && control.epoch === epoch;
    },
    dispose() {
      pause();
      clearInterval(watchdog);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", pause);
      window.removeEventListener("pagehide", pause);
      document.removeEventListener("visibilitychange", visibilitychange);
    },
  };
}

// Handles belong to one document. Reconnect paused after a reload, and reject
// decisions made from an observation of the previous document.
export class PageController {
  handle = null;
  document = 0;

  constructor(page) {
    this.page = page;
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
            `(() => {
              const types = ${JSON.stringify(ENEMY_TYPES)};
              return (${installControls.toString()})(() => (${observeGame.toString()})(types));
            })()`,
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

  async isActive(control, active) {
    if (!active || !this.handle || control.document !== this.document)
      return false;
    try {
      return await this.handle.evaluate(
        (controls, epoch) => controls.isActive(epoch),
        control.epoch,
      );
    } catch (error) {
      if (this.navigationInterrupted(error, control.document)) return false;
      throw error;
    }
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
