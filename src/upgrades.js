// Spend earned points on speed only while sheltered. Leave the rest of the
// hero build to the player. This uses the default in-game 1 key binding.
export function speedUpgradeKey(state, maxSpeed = 510) {
  const p = state.player;
  if (
    p.downed ||
    !(p.upgradePoints > 0) ||
    !(p.baseSpeed + 15 <= Math.min(510, maxSpeed))
  )
    return null;
  const sheltered = state.area.zones.some(
    (z) =>
      z.type === 4 &&
      p.x - p.radius >= z.x - 0.01 &&
      p.x + p.radius <= z.x + z.width + 0.01 &&
      p.y - p.radius >= z.y - 0.01 &&
      p.y + p.radius <= z.y + z.height + 0.01,
  );
  return sheltered ? "1" : null;
}
