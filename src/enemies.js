import catalog from "../data/enemies.json" with { type: "json" };

// These clients expose velocity but not the phase governing the next turn or
// teleport. Do not assume they continue straight for the whole planning window.
const uncertainFamilies = new Set([
  "wavy",
  "zigzag",
  "spiral",
  "zoning",
  "oscillating",
  "confectioner",
  "dorito",
  "penny",
  "infinity",
  "teleporting",
  "liquid",
  "icicle",
]);

export const ENEMY_TYPES = Object.fromEntries(
  catalog.entities.map(({ id, name }) => {
    const family = name.replace(/_switch_enemy$|_enemy$|_projectile$/, "");
    return [id, { name, uncertainMotion: uncertainFamilies.has(family) }];
  }),
);
