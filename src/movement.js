import { ACTIONS, bestAction, guardAction } from "./planner.js";

// Replan on every fresh observation, but do not turn every time two routes
// exchange places in the beam search. Commit only while a fresh escape remains.
export class MovementPolicy {
  constructor({ commitmentMs = 100 } = {}) {
    this.commitmentMs = commitmentMs;
    this.reset();
  }

  reset() {
    this.action = "stay";
    this.changedAt = undefined;
    this.reason = "reset";
    this.observations = [];
    this.stalled = false;
    this.plan = undefined;
    this.pendingPlan = undefined;
    this.commitUntil = -Infinity;
  }

  observe(state, at) {
    if (this.observations.at(-1)?.packet === state.packet) return;
    this.observations.push({
      at,
      packet: state.packet,
      x: state.player.x,
      y: state.player.y,
    });
    while (this.observations.length > 1 && this.observations[1].at < at - 500)
      this.observations.shift();
    const first = this.observations[0];
    this.stalled =
      !state.player.immobilized &&
      at - first.at >= 400 &&
      Math.hypot(state.player.x - first.x, state.player.y - first.y) < 8;
  }

  age(at) {
    return this.changedAt === undefined ? Infinity : at - this.changedAt;
  }

  planOptions(at, heading = "right") {
    return {
      previousAction: this.action,
      continuation: this.plan,
      // A forward shortcut must not erase the dodge we are still checking.
      // Always allow a clear full-speed route to release temporary Shift.
      fastPath:
        this.age(at) >= this.commitmentMs ||
        this.action === heading ||
        this.action.startsWith("focus_"),
    };
  }

  select(candidates, preferred, at) {
    const action = this.choose(candidates, preferred, at);
    const candidate = candidates.find((c) => c.action === action);
    this.pendingPlan = {
      action,
      plan: candidate.plan,
      duration: candidate.firstDuration,
    };
    return action;
  }

  choose(candidates, preferred, at) {
    const guarded = guardAction(
      preferred ?? bestAction(candidates),
      candidates,
    );
    const proposed = candidates.find((c) => c.action === guarded);
    const current = candidates.find((c) => c.action === this.action);
    this.reason = "better route";
    if (!current || this.changedAt === undefined || proposed.fastPath)
      return proposed.action;
    // Finishing a focused dodge must not leave Shift stuck behind the ordinary
    // turn hysteresis. Accelerate along the SAME direction only when the full
    // plan preserves clearance, advances sooner, and is the preferred route.
    if (
      at >= this.commitUntil &&
      current.action === `focus_${proposed.action}` &&
      !proposed.collision &&
      proposed.score >= current.score &&
      proposed.physicalClearance > current.physicalClearance + 5 &&
      proposed.firstProgress > current.firstProgress + 8 &&
      proposed.firstMovement > current.firstMovement + 5
    ) {
      this.reason = "accelerate";
      return proposed.action;
    }
    // A plan that always promises to move on its SECOND segment can otherwise
    // keep pressing into a boundary forever. Take a freshly checked escape now.
    const waited =
      this.action === "stay" &&
      this.age(at) >= this.commitmentMs &&
      current.firstMovement < 4;
    if (
      current.ineffective ||
      (this.stalled && current.firstMovement < 4) ||
      waited
    ) {
      const escape = candidates
        .filter(
          (c) =>
            !c.collision &&
            c.firstMovement > 4 &&
            (!waited ||
              this.stalled ||
              current.ineffective ||
              (c.firstProgress > 2 && c.score >= current.score - 35)),
        )
        .sort((a, b) => b.score - a.score)[0];
      if (escape) {
        this.reason = waited && !this.stalled ? "end wait" : "escape stall";
        return escape.action;
      }
    }
    if (current.action === proposed.action) {
      this.reason = "continue";
      return current.action;
    }
    // Never debounce a newly predicted impact, wall, or substantial loss of
    // safety margin. A collision shared by all routes still needs best effort.
    if (
      current.blocked ||
      current.physicalClearance <= 0 ||
      (current.clearance < 0 &&
        (proposed.clearance >= 0 || proposed.clearance > current.clearance + 2))
    ) {
      this.reason = "safety override";
      return proposed.action;
    }
    if (at < this.commitUntil) {
      this.reason = "finish dodge";
      return current.action;
    }
    const from = ACTIONS[current.action],
      to = ACTIONS[proposed.action];
    const reverses = from.dx * to.dx < 0 || from.dy * to.dy < 0;
    const changesFocus = (from.scale ?? 1) !== (to.scale ?? 1);
    const patience = this.stalled ? 0.2 : 1;
    const switchCost =
      (25 + (reverses ? 20 : 0) + (changesFocus ? 10 : 0)) * patience;
    if (proposed.score - current.score < switchCost) {
      this.reason = "stable route";
      return current.action;
    }
    return proposed.action;
  }

  record(action, at) {
    if (this.changedAt === undefined || action !== this.action) {
      this.action = action;
      this.changedAt = at;
      this.commitUntil = at + this.commitmentMs;
    }
    if (this.pendingPlan?.action === action) {
      this.plan = this.pendingPlan.plan;
      if (this.pendingPlan.duration !== undefined)
        this.commitUntil = Math.min(
          this.commitUntil,
          at + this.pendingPlan.duration * 1000,
        );
    }
    this.pendingPlan = undefined;
  }
}
