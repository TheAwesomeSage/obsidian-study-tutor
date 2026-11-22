/** Module-owned equations and actual execution traces. All input is validated by registry. */
export interface PlotSettings {
  family: "polynomial" | "sin" | "cos" | "exp" | "decay" | "log" | "sqrt" | "reciprocal" | "abs";
  coefficients: number[]; scale: number; shiftX: number; shiftY: number;
  domain: [number, number]; viewport: [number, number, number, number]; pointX: number;
}
export function evaluate(s: PlotSettings, x: number): { y: number | null; slope: number | null } {
  if (x < s.domain[0] || x > s.domain[1]) return { y: null, slope: null };
  const u = x - s.shiftX;
  let y: number, d: number;
  switch (s.family) {
    case "polynomial":
      y = s.coefficients.reduceRight((a, c) => a * u + c, 0);
      d = s.coefficients.slice(1).map((c, i) => c * (i + 1)).reduceRight((a, c) => a * u + c, 0); break;
    case "sin": y = Math.sin(u); d = Math.cos(u); break;
    case "cos": y = Math.cos(u); d = -Math.sin(u); break;
    case "exp": y = Math.exp(u); d = y; break;
    case "decay": y = Math.exp(-u); d = -y; break;
    case "log": y = u > 0 ? Math.log(u) : NaN; d = u > 0 ? 1 / u : NaN; break;
    case "sqrt": y = u >= 0 ? Math.sqrt(u) : NaN; d = u > 0 ? 0.5 / Math.sqrt(u) : NaN; break;
    case "reciprocal": y = u !== 0 ? 1 / u : NaN; d = u !== 0 ? -1 / (u * u) : NaN; break;
    case "abs": y = Math.abs(u); d = u === 0 ? NaN : Math.sign(u); break;
  }
  y = s.scale * y + s.shiftY;
  d *= s.scale;
  return { y: Number.isFinite(y) ? y : null, slope: Number.isFinite(d) ? d : null };
}
export function formula(s: PlotSettings): string {
  const u = `(x − ${s.shiftX})`;
  const base = s.family === "polynomial" ? s.coefficients.map((c, i) => `${c}${i ? `·${u}${i > 1 ? `^${i}` : ""}` : ""}`).join(" + ")
    : s.family === "reciprocal" ? `1/${u}` : s.family === "decay" ? `exp(−${u})` : `${s.family}(${u})`;
  return `f(x) = ${s.scale}·[${base}] + ${s.shiftY}`;
}
/** Separate curve pieces so a renderer never joins across an asymptote/domain boundary. */
export function plotSegments(s: PlotSettings): [number, number][] {
  const [a, b] = s.domain, h = s.shiftX;
  const eps = Math.max(1e-8, (b - a) * 1e-7);
  if (s.family === "log") return b > h ? [[Math.max(a, h + eps), b]] : [];
  if (s.family === "sqrt") return b >= h ? [[Math.max(a, h), b]] : [];
  if (s.family === "reciprocal" && h >= a && h <= b) return [[a, h - eps], [h + eps, b]].filter(([x, y]) => x < y) as [number, number][];
  return [[a, b]];
}
export interface ProjectileSettings {
  speed: number; angle: number; gravity: number;
  speedRange: [number, number]; angleRange: [number, number]; target: number; tolerance: number;
}
export function projectile(s: Pick<ProjectileSettings, "speed" | "angle" | "gravity">, time = 0) {
  const theta = s.angle * Math.PI / 180;
  const vx = s.speed * Math.cos(theta), vy0 = s.speed * Math.sin(theta);
  const flight = 2 * vy0 / s.gravity, range = vx * flight, height = vy0 * vy0 / (2 * s.gravity);
  const t = Math.max(0, Math.min(flight, time));
  return { t, x: vx * t, y: t === flight ? 0 : Math.max(0, vy0 * t - s.gravity * t * t / 2), vx, vy: vy0 - s.gravity * t, ax: 0, ay: -s.gravity, flight, range, height };
}
/** R(v,θ) continuous on a connected control rectangle; extrema include 45° when allowed. */
export function rangeBounds(s: ProjectileSettings): [number, number] {
  const angles = [...s.angleRange];
  if (s.angleRange[0] <= 45 && s.angleRange[1] >= 45) angles.push(45);
  const values = s.speedRange.flatMap(speed => angles.map(angle => projectile({ speed, angle, gravity: s.gravity }).range));
  return [Math.min(...values), Math.max(...values)];
}
export function hitsTarget(s: ProjectileSettings): boolean { return Math.abs(projectile(s).range - s.target) <= s.tolerance; }
export interface AlgorithmSettings { algorithm: "index" | "bubble-sort" | "linear-search" | "binary-search"; values: number[]; target: number; index: number }
export interface TraceEvent {
  type: "read" | "write" | "compare" | "swap" | "complete";
  indices: number[]; values: number[]; detail: string; result?: number | number[];
}
export function traceAlgorithm(s: AlgorithmSettings): TraceEvent[] {
  const a = [...s.values], trace: TraceEvent[] = [];
  const emit = (type: TraceEvent["type"], indices: number[], detail: string, result?: number | number[]) => trace.push({ type, indices, detail, values: [...a], ...(result === undefined ? {} : { result }) });
  const read = (i: number) => { emit("read", [i], `Read a[${i}] = ${a[i]}`); return a[i]; };
  const done = (result: number | number[]) => emit("complete", [], "Execution complete", result);
  if (s.algorithm === "index") { done(read(s.index)); return trace; }
  if (s.algorithm === "bubble-sort") {
    for (let end = a.length - 1; end > 0; end--) {
      let changed = false;
      for (let j = 0; j < end; j++) {
        const left = read(j), right = read(j + 1);
        emit("compare", [j, j + 1], `${left} > ${right}: ${left > right}`);
        if (left > right) {
          a[j] = right; emit("write", [j], `Write ${right} to a[${j}]`);
          a[j + 1] = left; emit("write", [j + 1], `Write ${left} to a[${j + 1}]`);
          emit("swap", [j, j + 1], `Swapped indices ${j} and ${j + 1}`); changed = true;
        }
      }
      if (!changed) break;
    }
    done([...a]); return trace;
  }
  if (s.algorithm === "linear-search") {
    for (let i = 0; i < a.length; i++) {
      const value = read(i); emit("compare", [i], `${value} = ${s.target}: ${value === s.target}`);
      if (value === s.target) { done(i); return trace; }
    }
  } else {
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2), value = read(mid);
      emit("compare", [mid], `Bounds [${lo}, ${hi}]; ${value} = ${s.target}: ${value === s.target}`);
      if (value === s.target) { done(mid); return trace; }
      emit("compare", [mid], `${value} < ${s.target}: ${value < s.target}`);
      if (value < s.target) lo = mid + 1; else hi = mid - 1;
    }
  }
  done(-1); return trace;
}
/** Reproducible bounded variants; no inference, never replaces a saved lesson implicitly. */
export function numericVariant(seed: number, length = 8): number[] {
  if (!Number.isInteger(seed) || !Number.isInteger(length) || length < 1 || length > 16) throw new Error("Invalid variant seed/length");
  let state = seed >>> 0;
  return Array.from({ length }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % 100; });
}
