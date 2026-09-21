import { circleInZone } from "./planner.js";

// Sweet Tooth uses the default X binding. Keep key pulses in the main loop so
// using an ability never blocks observations or holds movement for a timeout.
export class CandyPolicy {
  lastAttempt = -Infinity;
  releaseAt = -Infinity;

  release() {
    this.releaseAt = -Infinity;
  }

  keys(state, action, at) {
    const p = state.player,
      candy = p?.candy;
    if (!state.ready || p.downed || action.startsWith("focus_")) {
      this.release();
      return [];
    }
    if (at < this.releaseAt) return ["x"];
    if (
      !candy ||
      candy.locked ||
      candy.disabled ||
      !(candy.level > 0) ||
      !(candy.cooldownMs <= 0) ||
      !(p.energy >= candy.energyCost) ||
      at - this.lastAttempt < 1000
    )
      return [];
    const needsBoost = !candy.active || candy.remainingMs <= 3000;
    const needsEnergy = p.maxEnergy > 0 && p.energy <= p.maxEnergy * 0.5;
    if (!needsBoost && !needsEnergy) return [];
    // Refreshing the same boost preserves the dodge's speed. Start or change
    // the boost while sheltered, where its acknowledgement can arrive before
    // the next tight dodge. Never pretend a keypress guarantees consumption.
    if (
      (!candy.active || candy.boost !== 30 * candy.level) &&
      !state.area.zones.some(
        (z) => z.type === 4 && circleInZone(p, z, p.radius),
      )
    )
      return [];
    this.lastAttempt = at;
    this.releaseAt = at + 50;
    return ["x"];
  }
}
