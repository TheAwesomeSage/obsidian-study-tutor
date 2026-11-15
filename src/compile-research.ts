import { lookup } from "node:dns";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { isIPv4 } from "node:net";
import { parse, serializeOuter, type DefaultTreeAdapterMap } from "parse5";
import { indexSource, type SourceRevision } from "./compile-sources";

export interface SearchHit { title: string; url: string }
export interface ResearchProvider {
  search(query: string, signal?: AbortSignal): Promise<SearchHit[]>;
  fetch(url: string, signal?: AbortSignal): Promise<SourceRevision>;
}

export interface ResearchLimits { searches: number; pages: number; largeSearches: number; largePages: number }
export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = { searches: 12, pages: 20, largeSearches: 20, largePages: 40 };

const limit = (n: number | undefined, base: number, max: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : base;

export function researchLimits(p?: Partial<ResearchLimits>): ResearchLimits {
  const searches = limit(p?.searches, 12, 40), pages = limit(p?.pages, 20, 80);
  return { searches, pages, largeSearches: Math.max(searches, limit(p?.largeSearches, 20, 40)), largePages: Math.max(pages, limit(p?.largePages, 40, 80)) };
}

export function publicIPv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a, b, c] = value.split(".").map(Number);
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function canonicalPage(raw: string): string {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) throw new Error("Only public HTTP(S) pages on standard ports are supported.");
  if (!u.hostname.includes(".") || /(?:\.localhost|\.local|\.internal|\.home\.arpa)\.?$/.test(u.hostname) || (isIPv4(u.hostname) && !publicIPv4(u.hostname))) {
    throw new Error("Local addresses and IPv6-only hosts are unsupported.");
  }
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
  return u.href;
}

interface ResponseData { status: number; location?: string; type: string; body: string }
const MAX_BYTES = 1_500_000;

/** Resolve and pin the actual connection to a public IPv4 address, on every hop. */
function get(url: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<ResponseData> {
  const u = new URL(canonicalPage(url));
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http)(u, {
      signal, agent: false, headers: { "accept-encoding": "identity", ...headers }, family: 4,
      lookup: (hostname, _, cb) => lookup(hostname, { family: 4, all: true }, (err, addresses) => {
        if (err) return cb(err, "", 4);
        if (!addresses.length || addresses.some(x => !publicIPv4(x.address))) return cb(new Error("Page resolved to a non-public address."), "", 4);
        return cb(null, addresses[0].address, 4);
      }),
    }, res => {
      const status = res.statusCode ?? 0, location = res.headers.location;
      const type = String(res.headers["content-type"] ?? "").split(";")[0].toLowerCase();
      if (status !== 200) {
        res.destroy();
        resolve({ status, location, type, body: "" });
        return;
      }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        res.destroy();
        reject(new Error("Server returned unsupported content encoding."));
        return;
      }
      if (!/^(text\/(html|plain|markdown)|application\/(xhtml\+xml|json))$/.test(type)) {
        res.destroy();
        reject(new Error(`Unsupported content type: ${type || "unknown"}.`));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on("data", (x: Buffer) => {
        bytes += x.length;
        if (bytes > MAX_BYTES) req.destroy(new Error("Page exceeds the response size limit."));
        else chunks.push(x);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Page response was interrupted.")));
      res.on("end", () => resolve({ status, location, type, body: Buffer.concat(chunks).toString("utf8") }));
    });
    const timer = setTimeout(() => req.destroy(new Error("Research request timed out.")), 12000);
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

type HtmlNode = DefaultTreeAdapterMap["node"];
export function readablePage(html: string): { title: string; text: string } {
  const doc = parse(html);
  const ignored = new Set(["script", "style", "nav", "footer", "aside", "noscript", "button", "form", "template", "iframe", "svg"]);
  const tag = (n: HtmlNode) => "tagName" in n ? n.tagName : "";
  const kids = (n: HtmlNode): HtmlNode[] => "childNodes" in n ? n.childNodes : [];
  const find = (n: HtmlNode, names: string[], depth = 0): HtmlNode | null => {
    if (depth > 100 || ignored.has(tag(n))) return null;
    if (names.includes(tag(n))) return n;
    for (const k of kids(n)) { const match = find(k, names, depth + 1); if (match) return match; }
    return null;
  };
  function text(n: HtmlNode, raw = false, depth = 0): string {
    const el = tag(n);
    if (el === "script" && "attrs" in n && n.attrs.some(a => a.name === "type" && /^math\/tex(?:\s*;|$)/i.test(a.value))) {
      const latex = kids(n).map(c => "value" in c ? c.value : "").join("").trim();
      return latex ? "\n\n$$\n" + latex + "\n$$\n\n" : "";
    }
    if (depth > 100 || ignored.has(el) || ("attrs" in n && n.attrs.some(a => a.name === "hidden" || (a.name === "aria-hidden" && a.value === "true")))) return "";
    if ("value" in n) return raw ? n.value : n.value.replace(/\s+/g, " ");
    const body = kids(n).map(k => text(k, raw || el === "pre", depth + 1)).join("");
    if (raw) return body;
    if (el === "br") return "\n";
    if (el === "pre") return "\n\n~~~\n" + body + "\n~~~\n\n";
    if (el === "math") return "\n\n~~~mathml\n" + serializeOuter(n) + "\n~~~\n\n";
    if (/^h[1-6]$/.test(el)) return "\n\n" + "#".repeat(Number(el[1])) + " " + body.trim() + "\n\n";
    if (el === "li") return "\n- " + body.trim() + "\n";
    if (el === "td" || el === "th") return body.trim() + " | ";
    if (["p", "section", "div", "blockquote", "tr", "math", "ul", "ol"].includes(el)) return "\n\n" + body.trim() + "\n\n";
    return body;
  }
  const title = find(doc, ["title"]);
  const main = find(doc, ["main", "article"]) ?? find(doc, ["body"]) ?? doc;
  return { title: title ? text(title).trim().slice(0, 200) : "", text: text(main).trim() };
}

/** Fixed search endpoint. The key is sent only to Brave and never to the model or pages. */
export function braveResearch(key: string): ResearchProvider {
  return {
    async search(query, signal) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", "6");
      const r = await get(url.href, signal, { accept: "application/json", "X-Subscription-Token": key });
      if (r.status !== 200) throw new Error(`Search returned HTTP ${r.status}.`);
      const hits: unknown = JSON.parse(r.body).web?.results;
      if (!Array.isArray(hits)) return [];
      return hits.slice(0, 6).flatMap((h: { title?: unknown; url?: unknown } | null) => {
        if (typeof h?.url !== "string" || typeof h.title !== "string") return [];
        try { return [{ title: h.title.slice(0, 200), url: canonicalPage(h.url) }]; } catch { return []; }
      });
    },
    async fetch(raw, signal) {
      let url = canonicalPage(raw);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const r = await get(url, signal, { accept: "text/html,application/xhtml+xml,text/plain,text/markdown" });
        if ([301, 302, 303, 307, 308].includes(r.status) && r.location) {
          url = canonicalPage(new URL(r.location, url).href);
          continue;
        }
        if (r.status !== 200) throw new Error(`Page returned HTTP ${r.status}.`);
        if (r.type === "application/json") throw new Error("JSON pages are unsupported.");
        const p = r.type === "text/plain" || r.type === "text/markdown" ? { title: "", text: r.body.trim() } : readablePage(r.body);
        if (!p.text) throw new Error("Page has no readable text.");
        return indexSource({ name: p.title || new URL(url).hostname, text: p.text, url });
      }
      throw new Error("Page exceeded the redirect limit.");
    },
  };
}
