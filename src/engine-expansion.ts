// Requests for linked material made from a chat: starting one, cancelling it, and telling the tutor what came back.
// Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name that calls it. No Obsidian imports.

import { ExpansionRecord, ExpansionRequest, ExpansionResult, readResult } from "./expansion";
import type { Engine } from "./engine";

/** Writes one request record, one write at a time, so a result arriving mid-turn is not lost. */
export function saveExpansionRecord(eng: Engine, dir: string, rec: ExpansionRecord): Promise<void> {
  const next = eng.expansionWrites.then(() => eng.store.saveExpansion(dir, rec)).catch(() => undefined);
  eng.expansionWrites = next;
  return next;
}

/**
 * Sends one narrow request for linked material and returns at once, with the request pending.
 * The same request is not sent again while it runs or after it succeeded. Without a compiler
 * adapter it is recorded as unavailable. Nothing here reads or writes learner state.
 */
export async function requestExpansion(eng: Engine, dir: string, req: ExpansionRequest): Promise<ExpansionRecord> {
  const same = (await eng.store.loadExpansions(dir)).find((r) => r.request.id === req.id);
  if (same && ((same.status === "pending" && eng.inflight.has(req.id)) || same.status === "complete" || same.status === "partial")) return same;
  const at = new Date().toISOString();
  if (!eng.expander) {
    const rec: ExpansionRecord = { v: 1, request: req, status: "unavailable", result: null, updated: at, delivered: false };
    await eng.saveExpansionRecord(dir, rec);
    return rec;
  }
  const rec: ExpansionRecord = { v: 1, request: req, status: "pending", result: null, updated: at, delivered: false };
  await eng.saveExpansionRecord(dir, rec);
  const ctl = new AbortController();
  const expander = eng.expander;
  const done = (async (): Promise<ExpansionRecord> => {
    let result: ExpansionResult;
    try {
      result = readResult(await expander.request(req, ctl.signal), req);
    } catch (e) {
      result = { requestId: req.id, status: "failed", linked: [], coverage: [], beyondSpec: req.kind === "extension", message: e instanceof Error ? e.message.slice(0, 200) : "the request failed" };
    }
    // A cancelled request stays cancelled, whatever came back after.
    if (ctl.signal.aborted) result = { ...result, status: "cancelled", message: result.message || "cancelled" };
    const settled: ExpansionRecord = { ...rec, status: result.status, result, updated: new Date().toISOString() };
    eng.inflight.delete(req.id);
    await eng.saveExpansionRecord(dir, settled);
    eng.onExpansion?.(dir, settled);
    return settled;
  })();
  eng.inflight.set(req.id, { ctl, done });
  eng.runs.set(req.id, done);
  return rec;
}

/** Cancels a request. One still running settles as cancelled; one left pending by a closed app is marked so. */
export async function cancelExpansion(eng: Engine, dir: string, requestId: string): Promise<ExpansionRecord | null> {
  const live = eng.inflight.get(requestId);
  if (live) {
    live.ctl.abort();
    return live.done;
  }
  const rec = (await eng.store.loadExpansions(dir)).find((r) => r.request.id === requestId) ?? null;
  if (rec?.status !== "pending") return rec;
  const stopped: ExpansionRecord = { ...rec, status: "cancelled", updated: new Date().toISOString() };
  await eng.saveExpansionRecord(dir, stopped);
  return stopped;
}

/** Resolves when the latest run of a request settles; null when it was never run here. */
export function expansionSettled(eng: Engine, requestId: string): Promise<ExpansionRecord | null> {
  return eng.runs.get(requestId) ?? Promise.resolve(null);
}

/**
 * The requests to tell the tutor about this turn: the one just made, any still running, and any
 * settled since it was last told. A request left pending when the app closed is cancelled.
 */
export async function expansionsToTell(eng: Engine, dir: string, current: ExpansionRecord | null): Promise<ExpansionRecord[]> {
  let all: ExpansionRecord[];
  try {
    all = await eng.store.loadExpansions(dir);
  } catch {
    return current ? [current] : [];
  }
  const out: ExpansionRecord[] = current ? [current] : [];
  for (const rec of all) {
    if (rec.request.id === current?.request.id) continue;
    if (rec.status === "pending" && !eng.inflight.has(rec.request.id)) {
      const stopped: ExpansionRecord = { ...rec, status: "cancelled", result: { requestId: rec.request.id, status: "cancelled", linked: [], coverage: [], beyondSpec: rec.request.kind === "extension", message: "stopped when the app was closed" }, updated: new Date().toISOString() };
      await eng.saveExpansionRecord(dir, stopped);
      out.push(stopped);
    } else if (rec.status === "pending" || !rec.delivered) out.push(rec);
  }
  return out.slice(0, 3);
}
