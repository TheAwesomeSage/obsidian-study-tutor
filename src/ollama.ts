// A client for a local Ollama server, used for visual modules and bounded evidence selection.
// One request at a time, a short context, bounded output, low temperature and a JSON schema
// passed as Ollama's `format`, so the model is constrained while it writes. The reply is still
// checked again by the caller. Only loopback servers are accepted, but a loopback Ollama can
// still forward a cloud model (such as gpt-oss:120b-cloud) to ollama.com, so the server address
// alone does not prove that inference is local: `locateLocal` asks Ollama where the model runs,
// and a caller that promises local inference refuses a model that is not proven local.
// Node only (it uses the http module), no Obsidian imports.

import { Schema, ollamaSchema } from "./jsonschema";

export const DEFAULT_LOCAL_MODEL = "qwen2.5:3b";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface LocalTiming {
  /** Wall-clock time of the request as the plugin saw it. */
  wallMs: number;
  /** Time Ollama spent loading the model (large on a cold start, near zero when warm). */
  loadMs: number;
  promptTokens: number;
  promptMs: number;
  evalTokens: number;
  evalMs: number;
  totalMs: number;
}

export interface LocalReply {
  text: string;
  model: string;
  /** "stop" normally; "length" when the output limit cut the reply short. */
  doneReason: string;
  timing: LocalTiming;
}

export type LocalErrorKind = "unreachable" | "model-missing" | "timeout" | "http" | "bad-response" | "not-local";

export class LocalModelError extends Error {
  constructor(public kind: LocalErrorKind, message: string) {
    super(message);
  }
}

export interface ChatJsonOptions {
  system: string;
  user: string;
  schema: Schema;
  temperature?: number;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
  seed?: number;
  timeoutMs?: number;
  /** Context window for this request, in tokens; the client's own setting when unset. */
  numCtx?: number;
  signal?: AbortSignal;
}

/** Where a local model's inference runs, as far as it could be established. */
export interface LocalModelInfo {
  /** The tag requests name. */
  model: string;
  /**
   * "local": Ollama on this computer reports the model as its own. "cloud": the name or Ollama
   * says it runs elsewhere (an Ollama cloud model, or a server that is not this computer).
   * "unknown": Ollama could not be asked, which is not proof that it runs here.
   */
  runs: "local" | "cloud" | "unknown";
  /** The model's digest as /api/tags lists it, empty when not listed: its concrete identity. */
  digest: string;
  /** Why, in a few words, for notices. */
  detail: string;
}

/** What the configuration step needs from a local model. Tests supply a scripted one. */
export interface LocalModel {
  readonly model: string;
  chatJson(o: ChatJsonOptions): Promise<LocalReply>;
  /** Asks the server where the model runs and which build it is. The Ollama client always has it. */
  describe?(signal?: AbortSignal): Promise<LocalModelInfo>;
}

export type Transport = (method: "GET" | "POST", url: string, body: string | null, timeoutMs: number, signal?: AbortSignal) => Promise<{ status: number; body: string }>;

/**
 * True for the names Ollama gives its cloud models: a tag of "cloud" or ending in "-cloud", as in
 * glm-4.6:cloud or gpt-oss:120b-cloud. Ollama forwards their requests to ollama.com.
 */
export function cloudModelName(name: string): boolean {
  return /(?:^|[:-])cloud$/i.test(name.trim());
}

/**
 * Where a local model runs. A cloud name settles it without asking. A model without `describe`
 * (a test double) is judged by its name alone; the Ollama client always asks the server, and an
 * error there gives "unknown".
 */
export async function locateLocal(m: LocalModel, signal?: AbortSignal): Promise<LocalModelInfo> {
  if (cloudModelName(m.model)) return { model: m.model, runs: "cloud", digest: "", detail: `${m.model} is an Ollama cloud model, which Ollama runs on ollama.com` };
  if (!m.describe) return { model: m.model, runs: "local", digest: "", detail: `${m.model} is not named as a cloud model` };
  try {
    return await m.describe(signal);
  } catch (e) {
    return { model: m.model, runs: "unknown", digest: "", detail: `could not ask Ollama where ${m.model} runs: ${(e as Error).message}` };
  }
}

/** A remote host or model in an Ollama listing or model description, as text; empty when it has none. */
function remoteOf(x: unknown): string {
  if (!x || typeof x !== "object") return "";
  const { remote_host: host, remote_model: model } = x as { remote_host?: unknown; remote_model?: unknown };
  if (typeof host === "string" && host.trim() && !isLoopback(host)) return host.trim();
  return typeof model === "string" && model.trim() && !(typeof host === "string" && isLoopback(host)) ? `the remote model ${model.trim()}` : "";
}

/**
 * True for http(s) URLs on a loopback host. This checks the server's address only: a loopback
 * Ollama can still run a cloud model, which `locateLocal` detects.
 */
export function isLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

const nodeTransport: Transport = (method, url, body, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    // Loaded lazily so that importing this file never needs Node until a request is made.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = (url.startsWith("https:") ? require("https") : require("http")) as typeof import("http");
    const req = http.request(url, { method, signal, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        if (data.length + d.length > 1_000_000) req.destroy(new LocalModelError("bad-response", "Ollama returned an oversized response."));
        else data += d;
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new LocalModelError("bad-response", "Ollama interrupted the response.")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    const timer = setTimeout(() => req.destroy(new LocalModelError("timeout", `The local model took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`)), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e instanceof LocalModelError) reject(e);
      else if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET" || e.code === "EHOSTUNREACH") reject(new LocalModelError("unreachable", `Ollama is not reachable at ${url.replace(/\/api\/.*$/, "")} (${e.code}). Start Ollama, or turn local activities off.`));
      else reject(new LocalModelError("unreachable", `Could not reach Ollama: ${e.message}`));
    });
    if (body) req.write(body);
    req.end();
  });

export class OllamaClient implements LocalModel {
  readonly model: string;
  private baseUrl: string;
  private transport: Transport;
  private numCtx: number;
  private keepAlive: string;
  /** One generation at a time: a second request waits for the first. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: { model?: string; baseUrl?: string; transport?: Transport; numCtx?: number; keepAlive?: string } = {}) {
    this.model = o.model || DEFAULT_LOCAL_MODEL;
    this.baseUrl = (o.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
    this.transport = o.transport ?? nodeTransport;
    this.numCtx = o.numCtx ?? 2048;
    this.keepAlive = o.keepAlive ?? "10m";
  }

  /** Whether the server answers and which models it has. Never throws. */
  async status(): Promise<{ ok: boolean; version: string; models: string[]; hasModel: boolean; error: string }> {
    if (!isLoopback(this.baseUrl)) return { ok: false, version: "", models: [], hasModel: false, error: "Only a local Ollama server (127.0.0.1 or localhost) is used, so note excerpts stay on this machine." };
    try {
      const v = await this.transport("GET", `${this.baseUrl}/api/version`, null, 5000);
      const t = await this.transport("GET", `${this.baseUrl}/api/tags`, null, 5000);
      const models = (JSON.parse(t.body).models ?? []).map((m: { name?: string }) => String(m.name ?? "")).filter(Boolean);
      return { ok: v.status === 200, version: String(JSON.parse(v.body).version ?? ""), models, hasModel: models.includes(this.model), error: "" };
    } catch (e) {
      return { ok: false, version: "", models: [], hasModel: false, error: (e as Error).message };
    }
  }

  /**
   * Where the model runs, from the server itself: /api/show names a remote host or model for a
   * cloud model, and /api/tags gives the digest of the installed build. Asked afresh each time, so a
   * re-pulled model is noticed. Throws when the server cannot be asked; `locateLocal`, which also
   * checks the name first, reads that as "unknown".
   */
  async describe(signal?: AbortSignal): Promise<LocalModelInfo> {
    const named = { model: this.model, digest: "" };
    if (!isLoopback(this.baseUrl)) return { ...named, runs: "cloud", detail: `the Ollama server at ${this.baseUrl} is not on this computer` };
    const show = await this.transport("POST", `${this.baseUrl}/api/show`, JSON.stringify({ model: this.model }), 5000, signal);
    let shown: unknown;
    try { shown = JSON.parse(show.body); } catch { shown = null; }
    if (show.status !== 200 || !shown || typeof shown !== "object") {
      const msg = shown && typeof (shown as { error?: unknown }).error === "string" ? (shown as { error: string }).error : `HTTP ${show.status}`;
      throw new LocalModelError(/not found|pull/i.test(msg) ? "model-missing" : "http", `Ollama did not describe ${this.model}: ${msg.slice(0, 200)}`);
    }
    let listed: unknown = null;
    try {
      const tags = await this.transport("GET", `${this.baseUrl}/api/tags`, null, 5000, signal);
      const names = [this.model, `${this.model}:latest`];
      listed = ((JSON.parse(tags.body) as { models?: unknown[] }).models ?? []).find((m) => !!m && typeof m === "object" && names.some((n) => (m as { name?: unknown }).name === n || (m as { model?: unknown }).model === n)) ?? null;
    } catch {
      // The digest is optional: without it the model is identified by its tag alone.
    }
    const digest = listed && typeof (listed as { digest?: unknown }).digest === "string" ? (listed as { digest: string }).digest : "";
    const remote = remoteOf(shown) || remoteOf(listed);
    return remote
      ? { ...named, digest, runs: "cloud", detail: `Ollama reports that ${this.model} runs on ${remote}` }
      : { ...named, digest, runs: "local", detail: `Ollama runs ${this.model} on this computer` };
  }

  chatJson(o: ChatJsonOptions): Promise<LocalReply> {
    const run = this.queue.then(() => this.request(o), () => this.request(o));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(o: ChatJsonOptions): Promise<LocalReply> {
    if (o.signal?.aborted) throw new Error("Local request cancelled.");
    if (!isLoopback(this.baseUrl)) throw new LocalModelError("not-local", "Only a local Ollama server is used.");
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      format: ollamaSchema(o.schema),
      keep_alive: this.keepAlive,
      // Thinking models (qwen3) would spend most of a small budget on hidden reasoning.
      ...(/^qwen3/i.test(this.model) ? { think: false } : {}),
      options: { temperature: o.temperature ?? 0.1, num_predict: o.maxTokens ?? 400, num_ctx: o.numCtx ?? this.numCtx, seed: o.seed ?? 7 },
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
    });
    const started = Date.now();
    const r = await this.transport("POST", `${this.baseUrl}/api/chat`, body, o.timeoutMs ?? 120000, o.signal);
    const wallMs = Date.now() - started;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(r.body);
    } catch {
      throw new LocalModelError("bad-response", `Ollama returned something that is not JSON (HTTP ${r.status}).`);
    }
    if (r.status !== 200 || typeof j.error === "string") {
      const msg = String(j.error ?? `HTTP ${r.status}`);
      throw new LocalModelError(/not found|pull/i.test(msg) ? "model-missing" : "http", /not found|pull/i.test(msg) ? `The local model ${this.model} is not installed. Run: ollama pull ${this.model}` : `Ollama refused the request: ${msg.slice(0, 300)}`);
    }
    const message = (j.message ?? {}) as { content?: unknown };
    const ms = (k: string) => (typeof j[k] === "number" ? Math.round((j[k] as number) / 1e6) : 0);
    return {
      text: typeof message.content === "string" ? message.content : "",
      model: String(j.model ?? this.model),
      doneReason: String(j.done_reason ?? ""),
      timing: { wallMs, loadMs: ms("load_duration"), promptTokens: Number(j.prompt_eval_count) || 0, promptMs: ms("prompt_eval_duration"), evalTokens: Number(j.eval_count) || 0, evalMs: ms("eval_duration"), totalMs: ms("total_duration") },
    };
  }
}
