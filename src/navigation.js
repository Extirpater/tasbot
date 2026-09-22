import {
  ACTIONS,
  circleInZone,
  hazardActiveFrom,
  hitsRectangle,
  predictHazardPath,
  trajectoryClearance,
  targetFor,
} from "./planner.js";

// Coarse routes account for WHEN a corridor is crossed, including waiting or
// detouring. Local search still checks exact movement, auras and pursuit.
export class Navigation {
  reset() {
    this.route = undefined;
    this.areaId = undefined;
    this.updatedAt = -Infinity;
    this.path = [];
  }

  constructor() {
    this.reset();
  }

  update(state, at, heading = "right", objective) {
    const objectiveKey = objective
      ? `${objective.kind}:${objective.id}:${objective.areaId}:${objective.x}:${objective.y}`
      : "exit";
    if (
      this.areaId !== state.area.id ||
      this.heading !== heading ||
      this.objectiveKey !== objectiveKey
    )
      this.reset();
    if (at - this.updatedAt < 200) return this.route;
    this.areaId = state.area.id;
    this.heading = heading;
    this.objectiveKey = objectiveKey;
    this.updatedAt = at;
    const { area, player: p } = state;
    const target = objective ?? targetFor(state, heading);
    const direction = ACTIONS[heading];
    const padding = p.radius + 2;
    const nx = Math.max(2, Math.ceil((area.width - 2 * padding) / 48) + 1);
    const ny = Math.max(2, Math.ceil((area.height - 2 * padding) / 48) + 1);
    // Bound work on very large or unsupported maps; retain the local guard.
    if (nx * ny > 6000) return (this.route = undefined);
    const left = area.x + padding,
      top = area.y + padding;
    const sx = (area.width - 2 * padding) / (nx - 1);
    const sy = (area.height - 2 * padding) / (ny - 1);
    if (!(sx > 0 && sy > 0)) return (this.route = undefined);
    const points = Array.from({ length: nx * ny }, (_, i) => ({
      x: left + (i % nx) * sx,
      y: top + Math.floor(i / nx) * sy,
    }));
    const walls = [
      ...(area.walls ?? []),
      ...area.zones.filter((z) => z.type === 3),
      // A rescue must not take a shortcut through an area-changing exit.
      ...(objective
        ? area.zones.filter((z) => z.type === 2 || z.type === 6)
        : []),
    ];
    const free = points.map(
      (point) =>
        (!area.zones.length ||
          area.zones.some((z) => z.type !== 3 && circleInZone(point, z))) &&
        !walls.some((w) => hitsRectangle(point, point, w, padding)),
    );
    const safeZones = area.zones.filter((z) => z.type === 4);
    const speed = Math.max(
      60,
      p.speed,
      (p.baseSpeed ?? p.speed) * (p.speedMultiplier ?? 1) + (p.speedBonus ?? 0),
      ...area.zones.map(
        (z) =>
          (z.minimumSpeed ?? 0) * (p.speedMultiplier ?? 1) +
          (p.speedBonus ?? 0),
      ),
    );
    // Keyboard diagonals have the same per-axis speed as straight movement.
    const stride = Math.min(sx, sy);
    const dt = stride / speed;
    const layers = Math.min(48, Math.ceil(2.4 / dt));
    const forecasts = state.hazards
      .filter((h) => hazardActiveFrom(h, state.tickRate ?? 60) <= layers * dt)
      .map((h) => ({
        id: h.id,
        radius:
          p.radius +
          h.radius * (h.square ? Math.SQRT2 : 1) +
          (h.spiral?.padding ?? 0),
        activeFrom: hazardActiveFrom(h, state.tickRate ?? 60),
        positions: predictHazardPath(
          h,
          area,
          layers,
          dt,
          () => p,
          state.tickRate ?? 60,
        ),
      }));
    const count = points.length;
    const sheltered = points.map((point) =>
      safeZones.some((z) => circleInZone(point, z, p.radius)),
    );
    // Travel time through a slowing field uses each aura type once and adds
    // Candy AFTER the base-speed reduction, just like local movement.
    const multipliers = new Float64Array(count * layers).fill(1);
    const auraTypes = new Map();
    if (!p.ignoreAuras)
      for (const aura of state.auras ?? []) {
        if (!auraTypes.has(aura.type)) auraTypes.set(aura.type, []);
        auraTypes.get(aura.type).push(aura);
      }
    const byId = new Map(
      forecasts
        .filter((h) => h.id !== undefined)
        .map((h) => [h.id, h.positions]),
    );
    for (const auras of auraTypes.values()) {
      const field = new Float64Array(multipliers.length).fill(1);
      for (const aura of auras) {
        const path =
          byId.get(aura.id) ??
          predictHazardPath(
            aura,
            area,
            layers,
            dt,
            undefined,
            state.tickRate ?? 60,
          );
        const reach = p.radius + aura.auraRadius;
        const scale = Math.max(
          0,
          1 - aura.reduction * (p.effectsMultiplier ?? 1),
        );
        for (let tick = 0; tick < layers; tick++) {
          const a = path[tick];
          const x0 = Math.max(0, Math.ceil((a.x - reach - left) / sx));
          const x1 = Math.min(nx - 1, Math.floor((a.x + reach - left) / sx));
          const y0 = Math.max(0, Math.ceil((a.y - reach - top) / sy));
          const y1 = Math.min(ny - 1, Math.floor((a.y + reach - top) / sy));
          for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
              const id = y * nx + x,
                index = tick * count + id;
              if (field[index] !== 1 || sheltered[id] || !free[id]) continue;
              if (
                (points[id].x - a.x) ** 2 + (points[id].y - a.y) ** 2 <
                reach ** 2
              )
                field[index] = scale;
            }
        }
      }
      for (let i = 0; i < multipliers.length; i++) multipliers[i] *= field[i];
    }
    const bases = points.map((point) => {
      const zone = area.zones.find((z) => circleInZone(point, z));
      let base = p.baseSpeed ?? p.speed;
      if (Number.isFinite(zone?.minimumSpeed))
        base = Math.max(base, zone.minimumSpeed);
      else if (Number.isFinite(zone?.maximumSpeed))
        base = Math.min(base, zone.maximumSpeed);
      return base * (p.speedMultiplier ?? 1);
    });
    for (let tick = 0; tick < layers; tick++) {
      const bonus =
        p.candy?.active &&
        tick * dt * 1000 >= p.candy.remainingMs &&
        Number.isFinite(p.speedBonusWithoutCandy)
          ? p.speedBonusWithoutCandy
          : (p.speedBonus ?? 0);
      for (let id = 0; id < count; id++) {
        const index = tick * count + id;
        const actualSpeed = p.immobilized
          ? 0
          : bases[id] * multipliers[index] + bonus;
        multipliers[index] = speed / Math.max(1, actualSpeed);
      }
    }
    const laneCost = points.map((point) =>
      this.path.length
        ? stride *
          Math.min(
            0.08,
            Math.min(
              ...this.path.map((q) => Math.hypot(point.x - q.x, point.y - q.y)),
            ) / 2000,
          )
        : 0,
    );
    // Rasterize only cells near each enemy's swept segment. This retains fast
    // crossings while avoiding a cells × ticks × enemies scan.
    const routeBuffer = 70;
    const danger = new Float64Array(count * layers);
    for (let tick = 0; tick < layers; tick++) {
      for (const h of forecasts) {
        if (h.activeFrom > (tick + 1) * dt) continue;
        const a = h.positions[tick],
          b = h.positions[tick + 1];
        const reach = h.radius + routeBuffer;
        const x0 = Math.max(
          0,
          Math.ceil((Math.min(a.x, b.x) - reach - left) / sx),
        );
        const x1 = Math.min(
          nx - 1,
          Math.floor((Math.max(a.x, b.x) + reach - left) / sx),
        );
        const y0 = Math.max(
          0,
          Math.ceil((Math.min(a.y, b.y) - reach - top) / sy),
        );
        const y1 = Math.min(
          ny - 1,
          Math.floor((Math.max(a.y, b.y) + reach - top) / sy),
        );
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const id = y * nx + x;
            if (!free[id] || sheltered[id]) continue;
            const gap = trajectoryClearance(
              points[id],
              points[id],
              a,
              b,
              h,
              tick * dt,
              (tick + 1) * dt,
            );
            if (gap < routeBuffer)
              danger[tick * count + id] +=
                stride *
                1.2 *
                Math.min(3, (routeBuffer - gap) / routeBuffer) ** 2;
          }
      }
    }
    const edges = points.map((point, id) => {
      if (!free[id]) return [];
      const x = id % nx,
        y = Math.floor(id / nx),
        links = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (
            (!dx && !dy) ||
            x + dx < 0 ||
            x + dx >= nx ||
            y + dy < 0 ||
            y + dy >= ny
          )
            continue;
          const to = id + dy * nx + dx;
          if (
            !free[to] ||
            (dx && dy && (!free[id + dx] || !free[id + dy * nx]))
          )
            continue;
          if (walls.some((w) => hitsRectangle(point, points[to], w, padding)))
            continue;
          links.push({
            to,
            cost: Math.max(Math.abs(dx * sx), Math.abs(dy * sy)),
            lateral:
              Math.abs(dx * direction.dy + dy * direction.dx) * stride * 0.005,
          });
        }
      return links;
    });
    const distances = new Float64Array(points.length).fill(Infinity);
    const next = new Int32Array(points.length).fill(-1);
    const queue = new MinHeap();
    const goal = area.zones.find(
      (z) =>
        !objective && (z.type === 2 || z.type === 6) && circleInZone(target, z),
    );
    const goals = points.flatMap((point, i) =>
      free[i] &&
      (objective
        ? Math.hypot(point.x - target.x, point.y - target.y) <= target.radius
        : goal && circleInZone(point, goal, p.radius))
        ? [i]
        : [],
    );
    if (!goals.length) {
      let nearest = -1,
        best = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.hypot(points[i].x - target.x, points[i].y - target.y);
        if (free[i] && d < best) {
          best = d;
          nearest = i;
        }
      }
      if (nearest >= 0) goals.push(nearest);
    }
    for (const i of goals) {
      distances[i] = 0;
      queue.push(i, 0);
    }
    while (queue.length) {
      const { id, cost } = queue.pop();
      if (cost !== distances[id]) continue;
      for (const { to, cost: travel } of edges[id]) {
        const candidate = cost + travel;
        if (candidate >= distances[to]) continue;
        distances[to] = candidate;
        next[to] = id;
        queue.push(to, candidate);
      }
    }
    // Dynamic programming backward through time. Waiting costs real travel
    // time; it is useful only if an opening saves more time/risk than a detour.
    const values = new Float64Array((layers + 1) * count).fill(Infinity);
    values.set(distances, layers * count);
    const turns = new Int32Array(layers * count).fill(-1);
    const durations = new Float32Array(layers * count).fill(1);
    const exits = new Set(goals);
    for (let tick = layers - 1; tick >= 0; tick--) {
      const offset = tick * count,
        future = offset + count;
      for (let id = 0; id < count; id++) {
        if (!Number.isFinite(distances[id])) continue;
        if (exits.has(id)) {
          values[offset + id] = 0;
          continue;
        }
        let best = stride + danger[offset + id] + values[future + id];
        let nextId = id;
        for (const { to, lateral, cost: travel } of edges[id]) {
          const duration = Math.max(
            1,
            ((travel / stride) *
              (multipliers[offset + id] + multipliers[offset + to])) /
              2,
          );
          const arrival = Math.min(layers, tick + duration);
          const lo = Math.floor(arrival),
            fraction = arrival - lo;
          const later =
            fraction > 0
              ? values[lo * count + to] * (1 - fraction) +
                values[(lo + 1) * count + to] * fraction
              : values[lo * count + to];
          const cost =
            stride * duration +
            ((danger[offset + id] + danger[offset + to]) / 2) * duration +
            lateral +
            laneCost[to] +
            later;
          if (cost < best) {
            best = cost;
            nextId = to;
            durations[offset + id] = duration;
          }
        }
        values[offset + id] = best;
        turns[offset + id] = nextId;
      }
    }
    const cell = (point) => ({
      x: Math.max(0, Math.min(nx - 1, (point.x - left) / sx)),
      y: Math.max(0, Math.min(ny - 1, (point.y - top) / sy)),
    });
    const c = cell(p);
    let start = Math.round(c.y) * nx + Math.round(c.x);
    // Connect the exact player position to a nearby reachable cell without
    // jumping through a thin wall that falls between grid centres.
    let bestStart = Infinity;
    for (
      let y = Math.max(0, Math.floor(c.y) - 1);
      y <= Math.min(ny - 1, Math.ceil(c.y) + 1);
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(c.x) - 1);
        x <= Math.min(nx - 1, Math.ceil(c.x) + 1);
        x++
      ) {
        const i = y * nx + x;
        const d = Math.hypot(points[i].x - p.x, points[i].y - p.y);
        if (
          Number.isFinite(distances[i]) &&
          d < bestStart &&
          !walls.some((w) => hitsRectangle(p, points[i], w, padding))
        ) {
          bestStart = d;
          start = i;
        }
      }
    }
    if (!Number.isFinite(bestStart)) {
      this.path = [];
      return (this.route = undefined);
    }
    const path = [];
    let pathId = start;
    for (let tick = 0; tick < layers && pathId >= 0;) {
      path.push({ ...points[pathId], time: tick * dt });
      const index = Math.floor(tick) * count + pathId;
      tick += durations[index];
      pathId = turns[index];
    }
    for (
      let i = pathId;
      i >= 0 && path.length < points.length + layers;
      i = next[i]
    )
      path.push(points[i]);
    this.path = path;
    let waypoint = path[0];
    for (const point of path) {
      waypoint = point;
      if (
        Math.hypot(point.x - p.x, point.y - p.y) >= Math.max(100, speed * 0.4)
      )
        break;
    }
    const along =
      (waypoint.x - p.x) * direction.dx + (waypoint.y - p.y) * direction.dy;
    const across = Math.abs(
      (waypoint.y - p.y) * direction.dx - (waypoint.x - p.x) * direction.dy,
    );
    this.route = {
      direct: along >= 0 && across < 36,
      waypoint,
      packet: state.packet,
      tickRate: state.tickRate ?? 60,
      horizon: layers * dt,
      timed: true,
      path,
      distanceAt(position, time = 0) {
        const { x, y } = cell(position);
        const ix = Math.min(nx - 2, Math.floor(x)),
          iy = Math.min(ny - 2, Math.floor(y));
        const fx = x - ix,
          fy = y - iy;
        const layer = Math.max(0, Math.min(layers, time / dt));
        const lo = Math.floor(layer),
          mix = layer - lo;
        const id = lo * count + iy * nx + ix;
        const value = (index) =>
          mix > 0
            ? values[index] * (1 - mix) + values[index + count] * mix
            : values[index];
        const a = value(id),
          b = value(id + 1);
        const c = value(id + nx),
          d = value(id + nx + 1);
        if (Number.isFinite(a + b + c + d))
          return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
        let sum = 0,
          weight = 0;
        if (Number.isFinite(a)) {
          const w = (1 - fx) * (1 - fy);
          sum += a * w;
          weight += w;
        }
        if (Number.isFinite(b)) {
          const w = fx * (1 - fy);
          sum += b * w;
          weight += w;
        }
        if (Number.isFinite(c)) {
          const w = (1 - fx) * fy;
          sum += c * w;
          weight += w;
        }
        if (Number.isFinite(d)) {
          const w = fx * fy;
          sum += d * w;
          weight += w;
        }
        return weight > 0
          ? sum / weight
          : distances[start] +
              Math.hypot(
                position.x - points[start].x,
                position.y - points[start].y,
              );
      },
    };
    return this.route;
  }
}

class MinHeap {
  items = [];
  get length() {
    return this.items.length;
  }
  push(id, cost) {
    const item = { id, cost };
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].cost <= cost) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0],
      last = this.items.pop();
    if (!this.items.length) return first;
    let i = 0;
    while (2 * i + 1 < this.items.length) {
      let child = 2 * i + 1;
      if (
        child + 1 < this.items.length &&
        this.items[child + 1].cost < this.items[child].cost
      )
        child++;
      if (this.items[child].cost >= last.cost) break;
      this.items[i] = this.items[child];
      i = child;
    }
    this.items[i] = last;
    return first;
  }
}
