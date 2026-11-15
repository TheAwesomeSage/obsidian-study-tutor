// A client for a local Ollama server, used for visual modules and bounded evidence selection.
// One request at a time, a short context, bounded output, low temperature and a JSON schema
// passed as Ollama's `format`, so the model is constrained while it writes. The reply is still
// checked again by the caller. Note excerpts never leave the machine: only loopback addresses
// are accepted. Node only (it uses the http module), no Obsidian imports.

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
  signal?: AbortSignal;
}

/** What the configuration step needs from a local model. Tests supply a scripted one. */
export interface LocalModel {
  readonly model: string;
  chatJson(o: ChatJsonOptions): Promise<LocalReply>;
}

export type Transport = (method: "GET" | "POST", url: string, body: string | null, timeoutMs: number, signal?: AbortSignal) => Promise<{ status: number; body: string }>;

/** True for http(s) URLs on a loopback host. */
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
      options: { temperature: o.temperature ?? 0.1, num_predict: o.maxTokens ?? 400, num_ctx: this.numCtx, seed: o.seed ?? 7 },
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
