// A small typed registry for the things the plugin does without a language model: checking
// maths with SymPy, pulling text back out of the vault, and reading the course graph.
// Every call validates its input, runs under a timeout, can be cancelled, and returns a
// structured result that says what kind of evidence it is and what it assumed. A failure is
// a result with ok false and an error. It is never an answer.

export type ToolKind =
  /** A value SymPy worked out. */
  | "computed"
  /** Two expressions simplify to the same thing, for all values of their symbols. */
  | "symbolic-equivalence"
  /** Two expressions agree at sampled points, or to the decimal places written. Strong evidence, not a proof. */
  | "numeric-check"
  /** A stated result of a derivation step was recomputed independently. Says nothing about the steps between. */
  | "step-validation"
  | "retrieval"
  | "inspection";

export interface ToolResult<O = unknown> {
  tool: string;
  ok: boolean;
  kind: ToolKind;
  output: O | null;
  /** What the result takes for granted. Shown wherever the result is used as evidence. */
  assumptions: string[];
  error: string;
  ms: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ToolContext {
  signal?: AbortSignal;
}

export interface Tool<I, O> {
  name: string;
  description: string;
  kind: ToolKind;
  timeoutMs: number;
  /** Returns the cleaned input, or a string saying what is wrong with it. */
  validate(raw: unknown): I | string;
  run(input: I, ctx: ToolContext): Promise<{ output: O; assumptions?: string[]; kind?: ToolKind }>;
}

export class ToolError extends Error {}

export class ToolRegistry {
  private tools = new Map<string, Tool<unknown, unknown>>();
  /** The most recent calls, newest last, for the diagnostics view. */
  readonly log: ToolResult[] = [];

  register<I, O>(tool: Tool<I, O>): void {
    this.tools.set(tool.name, tool as unknown as Tool<unknown, unknown>);
  }

  list(): { name: string; description: string; kind: ToolKind }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, kind: t.kind }));
  }

  /** Runs a tool. Never throws: a bad input, an error, a timeout and a cancellation all come back as results. */
  async run<O = unknown>(name: string, raw: unknown, ctx: ToolContext & { timeoutMs?: number } = {}): Promise<ToolResult<O>> {
    const started = Date.now();
    const tool = this.tools.get(name);
    const done = (r: Partial<ToolResult<O>>): ToolResult<O> => {
      const result: ToolResult<O> = { tool: name, ok: false, kind: tool?.kind ?? "inspection", output: null, assumptions: [], error: "", ms: Date.now() - started, timedOut: false, cancelled: false, ...r };
      this.log.push(result as ToolResult);
      if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
      return result;
    };
    if (!tool) return done({ error: `Unknown tool: ${name}.` });
    let input: unknown;
    try { input = tool.validate(raw); } catch (error) { return done({ error: `Invalid input: ${(error as Error).message}` }); }
    if (typeof input === "string") return done({ error: `Invalid input: ${input}` });
    if (ctx.signal?.aborted) return done({ error: "Cancelled.", cancelled: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const limit = ctx.timeoutMs ?? tool.timeoutMs;
    const controller = new AbortController();
    const stop = new Promise<"timeout" | "cancel">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), limit);
      onAbort = () => resolve("cancel");
      ctx.signal?.addEventListener("abort", onAbort);
    });
    try {
      const work = Promise.resolve().then(() => tool.run(input, { signal: controller.signal })).then(
        (r) => ({ r }),
        (e: unknown) => ({ e }),
      );
      const first = await Promise.race([work, stop]);
      if (first === "timeout") { controller.abort(); return done({ error: `Timed out after ${Math.round(limit / 1000)}s.`, timedOut: true }); }
      if (first === "cancel") { controller.abort(); return done({ error: "Cancelled.", cancelled: true }); }
      if ("e" in first) return done({ error: (first.e as Error)?.message || String(first.e) });
      return done({ ok: true, output: first.r.output as O, assumptions: first.r.assumptions ?? [], kind: first.r.kind ?? tool.kind });
    } finally {
      clearTimeout(timer);
      if (onAbort) ctx.signal?.removeEventListener("abort", onAbort);
    }
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Helpers for writing validators. */
export const need = {
  object(raw: unknown): Record<string, unknown> | string {
    return isObj(raw) ? raw : "expected an object";
  },
  text(o: Record<string, unknown>, key: string, max = 4000): string | null {
    const v = o[key];
    return typeof v === "string" && v.trim() && v.length <= max ? v : null;
  },
  int(o: Record<string, unknown>, key: string): number | null {
    const v = o[key];
    return typeof v === "number" && Number.isInteger(v) ? v : null;
  },
};

/** One line for the diagnostics view. */
export function toolLine(r: ToolResult): string {
  const kind = { computed: "computed", "symbolic-equivalence": "symbolic equivalence", "numeric-check": "numeric check", "step-validation": "result check", retrieval: "retrieval", inspection: "inspection" }[r.kind];
  const outcome = r.ok ? "ok" : r.timedOut ? "timed out" : r.cancelled ? "cancelled" : `failed: ${r.error}`;
  return `${r.tool} · ${kind} · ${outcome} · ${r.ms} ms${r.assumptions.length ? ` · assumes: ${r.assumptions.join("; ")}` : ""}`;
}
