// One rescue per key press. Keep the chosen person until revival, disappearance,
// cancellation or an area change; never chase player markers in another area.
export class RescuePolicy {
  target;
  request = 0;
  message = "";
  epoch;
  document;

  update(state, control, active) {
    const requested = control.rescueRequest ?? 0;
    const pressed = requested !== this.request;
    const interrupted =
      this.epoch !== undefined &&
      (this.epoch !== control.epoch || this.document !== control.document);
    this.request = requested;
    this.epoch = control.epoch;
    this.document = control.document;
    if (!active || (interrupted && !pressed)) {
      this.target = undefined;
      this.message = "";
      return;
    }
    const eligible = (p) =>
      p.downed &&
      p.rescueable !== false &&
      p.areaId === state.area.id &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x >= state.area.x &&
      p.x <= state.area.x + state.area.width &&
      p.y >= state.area.y &&
      p.y <= state.area.y + state.area.height;
    if (pressed) {
      if (this.target) {
        this.target = undefined;
        this.message = "Rescue cancelled";
        return;
      }
      const nearest = (state.otherPlayers ?? [])
        .filter(eligible)
        .sort(
          (a, b) =>
            Math.hypot(a.x - state.player.x, a.y - state.player.y) -
            Math.hypot(b.x - state.player.x, b.y - state.player.y),
        )[0];
      this.target = nearest && { ...nearest };
      this.message = nearest
        ? `Rescuing player ${nearest.id}`
        : "No downed player to rescue in this area";
    }
    if (!this.target) return;
    const person = state.otherPlayers?.find(
      (p) => p.id === this.target.id && eligible(p),
    );
    if (!person || this.target.areaId !== state.area.id) {
      this.target = undefined;
      this.message = "Rescue finished — resuming run";
      return;
    }
    this.target = { ...person };
    return {
      kind: "rescue",
      id: person.id,
      areaId: state.area.id,
      x: person.x,
      y: person.y,
      // Contact revives. Aim slightly inside the touching distance, and keep
      // checking hazards after contact until the server confirms revival.
      radius: Math.max(1, state.player.radius + (person.radius ?? 0) - 3),
    };
  }
}
