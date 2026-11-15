import { createHash } from "node:crypto";

export interface SourceInput { name: string; text: string; path?: string }
export interface SourcePassage {
  id: string;
  sourceId: string;
  title: string;
  heading: string;
  path?: string;
  url?: string;
  line: number;
  text: string;
}
export interface SourceRevision {
  id: string;
  sourceId: string;
  title: string;
  path?: string;
  url?: string;
  text: string;
  passages: SourcePassage[];
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Preserve the source and split on Markdown structure, keeping fenced code and display maths intact. */
export function indexSource({ name: title, text, path, url }: SourceInput & { url?: string }): SourceRevision {
  const sourceId = digest(url ? `web:${url}` : `note:${path ?? title}`).slice(0, 24);
  const id = digest(JSON.stringify([sourceId, title, text]));
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const passages: SourcePassage[] = [];
  let heading = "", block = "", line = 1, fence = "";
  const flush = () => {
    if (block.trim()) passages.push({ id: `p-${id.slice(0, 18)}-${line}`, sourceId, title, heading, path, url, line, text: block });
    block = "";
  };
  for (const [i, raw] of lines.entries()) {
    const t = raw.trim();
    if (fence) {
      block += raw;
      if (fence === "$$" ? t === "$$" : new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) {
        fence = "";
        flush();
      }
      continue;
    }
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(raw.trimEnd());
    const opening = /^(\x60{3,}|~{3,})/.exec(t)?.[1] || (t === "$$" ? "$$" : "");
    const clause = /^\s*(?:[-*+]\s|\d+(?:\.\d+)+(?:[.)])?\s|\d+[.)]\s|[A-Z]\d+[.:)\s])/.test(raw);
    if (h || !t || clause || opening) flush();
    if (h) heading = h[1];
    if (!t) continue;
    if (!block) line = i + 1;
    block += raw;
    fence = opening;
  }
  flush();
  return { id, sourceId, title, path, url, text, passages };
}

const common = new Set("the and for with are from this that what how can use using when into about your have an of in is to a".split(" "));
const terms = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(t => !common.has(t)));

export function rankPassages(passages: SourcePassage[], query: string): SourcePassage[] {
  const sought = terms(query);
  return passages.map(p => {
    const body = terms(p.text), head = terms(p.heading + " " + p.title);
    return { p, score: [...sought].reduce((n, t) => n + Number(body.has(t)) + 2 * Number(head.has(t)), 0) };
  }).sort((a, b) => b.score - a.score || a.p.sourceId.localeCompare(b.p.sourceId) || a.p.line - b.p.line).map(x => x.p);
}

export function passageWindow(sources: SourceRevision[], id: string, radius = 1): SourcePassage[] {
  for (const source of sources) {
    const i = source.passages.findIndex(p => p.id === id);
    if (i >= 0) {
      const n = Math.max(0, Math.min(2, Math.floor(radius))) || 0;
      return source.passages.slice(Math.max(0, i - n), i + n + 1);
    }
  }
  return [];
}

export function excerpt(p: SourcePassage, maxChars: number) {
  return {
    id: p.id, title: p.title, heading: p.heading, path: p.path, url: p.url, line: p.line,
    text: p.text.slice(0, maxChars), truncated: p.text.length > maxChars,
  };
}
