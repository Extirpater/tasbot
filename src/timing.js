import { advancePlayer } from "./planner.js";

// Browser and Node performance clocks have different origins. Use the fastest
// observation round trip to align them, then date each snapshot at capture,
// rather than when its serialized state finally reaches the controller.
export class ObservationClock {
  offset;
  bestRoundTripMs = Infinity;
  lastSample;

  observe(sampledAt, sentAt, receivedAt) {
    if (!Number.isFinite(sampledAt))
      return { at: receivedAt, ageMs: 0, roundTripMs: receivedAt - sentAt };
    if (sampledAt < this.lastSample) {
      this.offset = undefined;
      this.bestRoundTripMs = Infinity;
    }
    this.lastSample = sampledAt;
    const roundTripMs = Math.max(0, receivedAt - sentAt);
    if (this.offset === undefined || roundTripMs < this.bestRoundTripMs) {
      this.offset = (sentAt + receivedAt) / 2 - sampledAt;
      this.bestRoundTripMs = roundTripMs;
    }
    // Timestamp resolution and long-term clock drift can put the estimate just
    // outside the request interval. A capture cannot precede its request.
    const at = Math.max(sentAt, Math.min(receivedAt, sampledAt + this.offset));
    return { at, ageMs: receivedAt - at, roundTripMs };
  }
}

// Estimate command-to-observation delay from movement, not API latency. Keep
// recent key changes so prediction replays the inputs already in flight.
export class InputTiming {
  commands = [];
  previous;
  samples = 0;
  delayMs = 150;
  fits = Array.from({ length: 11 }, (_, i) => ({ ms: 50 + 25 * i, error: 0 }));

  reset() {
    this.commands = [];
    this.previous = undefined;
    this.samples = 0;
    this.delayMs = 150;
    for (const fit of this.fits) fit.error = 0;
  }

  record(action, at) {
    if (this.commands.at(-1)?.action !== action)
      this.commands.push({ action, at });
    while (this.commands.length > 1 && this.commands[1].at < at - 3000)
      this.commands.shift();
  }

  actionAt(at) {
    return (
      this.commands.findLast((command) => command.at <= at)?.action ?? "stay"
    );
  }

  observe(state, at) {
    const previous = this.previous;
    if (previous?.state.packet === state.packet) return;
    this.previous = { state, at };
    if (
      !previous ||
      previous.state.area.id !== state.area.id ||
      state.player.downed ||
      previous.state.player.downed
    )
      return;
    const ticks = state.packet - previous.state.packet;
    const elapsed = at - previous.at;
    if (
      ticks <= 0 ||
      ticks > 6 ||
      elapsed > 150 ||
      previous.state.player.baseSpeed !== state.player.baseSpeed ||
      previous.state.player.speedBonus !== state.player.speedBonus ||
      previous.state.player.speedMultiplier !== state.player.speedMultiplier ||
      previous.state.player.immobilized !== state.player.immobilized ||
      previous.state.player.ignoreAuras !== state.player.ignoreAuras ||
      previous.state.player.mouseInput?.x !== state.player.mouseInput?.x ||
      previous.state.player.mouseInput?.y !== state.player.mouseInput?.y ||
      !this.commands.length ||
      this.commands[0].at > previous.at - 300
    )
      return;
    const rate = state.tickRate ?? 60;
    // An aura elsewhere in the area must not freeze the delay estimate. Skip
    // only samples whose possible movement could intersect an aura, including
    // the aura's own travel during the observed packet interval.
    if (
      [previous.state, state].some((sample) => {
        const p = sample.player;
        if (p.ignoreAuras) return false;
        const speed = Math.max(
          p.speed,
          (p.baseSpeed ?? p.speed) * (p.speedMultiplier ?? 1) +
            (p.speedBonus ?? 0),
        );
        return sample.auras?.some((aura) => {
          const reach =
            p.radius +
            aura.auraRadius +
            ((Math.SQRT2 * speed +
              Math.max(
                Math.hypot(aura.vx ?? 0, aura.vy ?? 0),
                aura.dash?.peak ?? 0,
              )) *
              ticks) /
              rate;
          return (p.x - aura.x) ** 2 + (p.y - aura.y) ** 2 <= reach ** 2;
        });
      })
    )
      return;
    // Straight, steady movement provides no evidence about latency.
    if (!this.commands.some((c) => c.at > previous.at - 300 && c.at < at - 50))
      return;
    const errors = this.fits.map((fit) => {
      let position = previous.state.player;
      for (let tick = 1; tick <= ticks; tick++) {
        const commandAt = previous.at + (elapsed * tick) / ticks - fit.ms;
        position = advancePlayer(
          position,
          this.actionAt(commandAt),
          previous.state.player,
          state.area,
          1 / rate,
        );
      }
      return (
        (position.x - state.player.x) ** 2 + (position.y - state.player.y) ** 2
      );
    });
    if (Math.max(...errors) - Math.min(...errors) < 1) return;
    for (let i = 0; i < errors.length; i++)
      this.fits[i].error =
        this.fits[i].error * 0.95 + Math.min(errors[i], 2500) * 0.05;
    this.samples++;
    if (this.samples >= 12) {
      const best = this.fits.reduce((a, b) => (a.error < b.error ? a : b));
      // Replay queued commands at the measured delay. Adding jitter time here
      // shifts old turns to the wrong positions; the planner now covers jitter
      // with a speed-dependent clearance buffer instead.
      this.delayMs = best.ms;
    }
  }

  pending(at, extraMs = 0) {
    const delayMs = this.delayMs + Math.max(0, extraMs);
    const start = at - this.delayMs;
    return {
      reactionTime: delayMs / 1000,
      pendingInputs: [
        { time: 0, action: this.actionAt(start) },
        ...this.commands
          .filter((c) => c.at > start && c.at <= at)
          .map((c) => ({ time: (c.at - start) / 1000, action: c.action })),
      ],
    };
  }
}
