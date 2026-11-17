// A small JSON Schema checker for the subset module settings use, and a cleaner that makes a
// schema acceptable to Ollama's grammar converter. The local model is constrained by the
// schema while it writes; everything it returns is checked again here, because constrained
// decoding fixes the structure, not the sense, and a model or server can still misbehave.
// Pure functions, no imports.

export type Schema = { [k: string]: unknown };

export const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/**
 * Checks `value` against `schema` and returns every problem as "path: message". Supported:
 * type (incl. lists), enum, const, properties, required, additionalProperties (boolean),
 * items, minItems, maxItems, uniqueItems, minimum, maximum, exclusiveMinimum,
 * exclusiveMaximum, multipleOf, minLength, maxLength, pattern, anyOf, oneOf. Keywords outside
 * the subset are ignored, so a module should not rely on them for safety.
 */
export function validateJson(value: unknown, schema: Schema, path = "$"): string[] {
  const out: string[] = [];
  const err = (m: string) => out.push(`${path}: ${m}`);
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (schema.anyOf ?? schema.oneOf) as Schema[];
    const passing = branches.filter((b) => isObj(b) && validateJson(value, b, path).length === 0).length;
    if (Array.isArray(schema.oneOf) ? passing !== 1 : passing === 0) err(Array.isArray(schema.oneOf) ? `must match exactly one of ${branches.length} alternatives (matches ${passing})` : `matches none of ${branches.length} alternatives`);
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) err(`must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) err(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  const t = schema.type;
  if (t !== undefined) {
    const allowed = Array.isArray(t) ? (t as string[]) : [t as string];
    const actual = typeOf(value);
    const ok = allowed.some((a) => a === actual || (a === "number" && actual === "integer"));
    if (!ok) {
      err(`must be ${allowed.join(" or ")}, not ${actual}`);
      return out;
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) err("must be a finite number");
    if (typeof schema.minimum === "number" && value < schema.minimum) err(`must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) err(`must be at most ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) err(`must be more than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) err(`must be less than ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) err(`must be a multiple of ${schema.multipleOf}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) err(`must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) err(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) err(`must match ${schema.pattern}`);
      } catch {
        err("has a pattern that cannot be checked");
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) err(`must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) err(`must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) err("must not repeat items");
    if (isObj(schema.items)) value.forEach((v, i) => out.push(...validateJson(v, schema.items as Schema, `${path}[${i}]`)));
  }
  if (isObj(value)) {
    const props = isObj(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
    for (const k of Array.isArray(schema.required) ? (schema.required as string[]) : []) if (!(k in value)) err(`is missing "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) out.push(...validateJson(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) err(`has an unexpected field "${k}"`);
      else if (isObj(schema.additionalProperties)) out.push(...validateJson(v, schema.additionalProperties as Schema, `${path}.${k}`));
    }
  }
  return out;
}

const KEEP = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "anyOf", "oneOf", "description"]);

/**
 * A copy of `schema` that Ollama's converter accepts and that keeps the model inside it:
 * unknown keywords dropped, every object closed (additionalProperties false), and an empty
 * enum (which the converter rejects) replaced by an impossible-to-fill array or a null.
 */
export function ollamaSchema(schema: Schema): Schema {
  const walk = (s: unknown): unknown => {
    if (!isObj(s)) return s;
    const out: Schema = {};
    for (const [k, v] of Object.entries(s)) {
      if (!KEEP.has(k)) continue;
      if (k === "properties" && isObj(v)) out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, walk(ps)]));
      else if (k === "items" || k === "additionalProperties") out[k] = typeof v === "boolean" ? v : walk(v);
      else if ((k === "anyOf" || k === "oneOf") && Array.isArray(v)) out[k] = v.map(walk);
      else out[k] = v;
    }
    if (Array.isArray(out.enum) && out.enum.length === 0) {
      delete out.enum;
      out.type = "null";
    }
    if (out.type === "array" && isObj(out.items) && (out.items as Schema).type === "null") {
      out.items = { type: "string" };
      out.maxItems = 0;
    }
    if (out.type === "object" || isObj(out.properties)) {
      out.type = "object";
      if (out.additionalProperties === undefined) out.additionalProperties = false;
    }
    return out;
  };
  return walk(schema) as Schema;
}

/** Strings anywhere in a value, with their paths, for content checks. */
export function stringsIn(value: unknown, path = "$"): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsIn(v, `${path}[${i}]`));
  if (isObj(value)) return Object.entries(value).flatMap(([k, v]) => stringsIn(v, `${path}.${k}`));
  return [];
}
