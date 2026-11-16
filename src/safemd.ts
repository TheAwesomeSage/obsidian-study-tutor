// Model replies and researched web pages are untrusted text that ends up rendered as Markdown: in
// the study view, and in the notes the plugin saves, which Obsidian renders whenever they are
// opened. Obsidian fetches a remote image, frame or stylesheet as soon as it renders one, and the
// address can carry whatever the text's author wanted sent. That is how an instruction hidden in
// a web page turns into notes leaving the machine. Nothing the tutor writes needs to load from
// outside the vault, so anything that would is made inert before it is saved or shown:
//
//   ![alt](https://host/x.png)     ->  [alt](https://host/x.png)      a link, fetched only on a click
//   <img src="https://host/x">     ->  &lt;img src="https://host/x">   shown as text
//   `<img src="https://host/x">`   ->  the same code as an inert <code> element, so it still reads right
//   ```dataviewjs                  ->  ```js                           shown, never run
//
// This is a filter over text, not a Markdown parser. Wherever the two could disagree about what is
// code, it assumes prose, so it errs towards defusing something harmless. Fenced code that is
// certainly code is left exactly as written. No Obsidian imports.

/**
 * Elements that fetch something, or change what others fetch. One of these is defused whatever
 * its attributes say: a tutor's reply has no use for them outside code, and reading attributes
 * the way a browser does (quotes that do not pair, a tag left open) is where a filter goes wrong.
 */
const LOADERS = new Set("img image picture source track audio video iframe frame frameset embed object applet link base meta input use feimage mglyph animate set bgsound portal style script".split(" "));
/** The start of a tag: its name, then a space, a slash, the closing bracket or the end of the text. */
const TAG_NAME = /<([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>]|$)/y;
/** The rest of a tag with quoted values kept whole, and the rest read simply up to the first closing bracket. */
const TAG_QUOTED = /(?:"[^"]*"|'[^']*'|[^>"'])*>/y;
const TAG_PLAIN = /[^>]*>/y;
/** A picture written into the text itself. It is the one address that loads nothing. */
const INLINE_PICTURE = /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]*/gi;
/** Fence labels that a widely used plugin runs as JavaScript when the note is rendered. */
const RUNS_ON_RENDER = /^([ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(?:`{3,}|~{3,})[ \t]*)(?:dataviewjs|js-engine)(?![\w-])/gim;

/** Whether a tag's attributes point anywhere but a file in the vault. */
function reachesOut(attrs: string): boolean {
  // A browser drops tabs and line breaks inside an address, and decodes entities and CSS escapes,
  // before it reads it. So any of those is treated as hiding one.
  const t = attrs.replace(/[\t\r\n\f]/g, "").replace(INLINE_PICTURE, "");
  return /\/\/|\\|&#|&(?!(?:amp|lt|gt|quot|apos|nbsp);)[a-z][a-z0-9]*;|\b(?:https?|ftp|wss?|file|data|blob|javascript|vbscript|filesystem)\s*:|url\s*\(|image-set|image\s*\(|src\s*\(|@import|expression\s*\(/i.test(t);
}

/** Whether the tag starting at `at` would load something. Any other element can only do that through a style, a background or a ping. */
function loads(text: string, at: number): boolean {
  TAG_NAME.lastIndex = at;
  const name = TAG_NAME.exec(text);
  if (!name) return false;
  const n = name[1].toLowerCase();
  if (LOADERS.has(n)) return true;
  // Where the tag ends depends on how its quotes are read, so the longest reading is the one
  // checked. A tag never closed runs on into whatever is rendered after it.
  const from = TAG_NAME.lastIndex;
  let end = text.length;
  for (const re of [TAG_QUOTED, TAG_PLAIN]) {
    re.lastIndex = from;
    if (re.test(text)) {
      end = re.lastIndex;
      break;
    }
  }
  const attrs = text.slice(from, end);
  // A link's own address is followed only on a click.
  const rest = n === "a" ? attrs.replace(/(^|\s)href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i, " ") : attrs;
  return /(?:^|[\s"'/])(?:style|background|ping)\s*=/i.test(rest) && reachesOut(rest);
}

/** Whether a Markdown link destination is anything but a file in the vault. */
export function isRemote(dest: string): boolean {
  // Markdown removes a backslash before punctuation, and a browser ignores leading control
  // characters, so "https\://host" and "\x01https://host" are still addresses.
  const d = dest
    .replace(/[\t\r\n]/g, "")
    .replace(/^[\x00-\x20<]+/, "")
    .replace(/\\([!-\/:-@\[-\x60{-~])/g, "$1")
    .slice(0, 2048);
  if (!d || /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(d)) return false;
  // A backslash left after that is a Windows share, or a slash to a browser.
  return /^[a-z][a-z0-9+.-]*:/i.test(d) || /^\/\/|\\/.test(d) || /&#|&[a-z][a-z0-9]*;/i.test(d.slice(0, 200));
}

interface Part {
  text: string;
  code: boolean;
}

/**
 * Splits the text into fenced code and everything else. A fence is taken as code only where
 * Markdown is certain to agree: not inside an HTML block, where "```" is just text, and not once
 * a fence indented under a list item has been cut short by the item ending.
 */
function split(md: string): Part[] {
  const parts: Part[] = [];
  let buf = "";
  let code = false;
  let fence = "";
  let indent = 0;
  /** Inside an HTML block: what ends it. "blank" is the kind that runs to the next blank line. */
  let raw: RegExp | "blank" | null = null;
  let trust = true;
  const flush = (next: boolean): void => {
    if (buf) parts.push({ text: buf, code });
    buf = "";
    code = next;
  };
  for (const line of md.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const body = line.replace(/\r?\n$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        buf += line;
        fence = "";
        flush(false);
        continue;
      }
      if (indent && body.trim() && body.search(/\S/) < indent) {
        // The list item this fence sat in has ended, and the fence with it. Where a later
        // "```" opens or closes can no longer be told, so the rest is read as prose.
        trust = false;
        fence = "";
        flush(false);
      }
      buf += line;
      continue;
    }
    if (raw) {
      buf += line;
      if (raw === "blank" ? !body.trim() : raw.test(body)) raw = null;
      continue;
    }
    const open = trust ? /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(body) : null;
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
      flush(true);
      fence = open[2];
      indent = open[1].length;
      buf = line;
      continue;
    }
    const html = /^ {0,3}<(!--|\?|!\[CDATA\[|![A-Za-z]|(?:script|pre|style|textarea)(?=[\s>]|$)|\/?[A-Za-z])/i.exec(body);
    if (html) {
      const start = html[1].toLowerCase();
      raw = start === "!--" ? /-->/ : start === "?" ? /\?>/ : start === "![cdata[" ? /\]\]>/ : start[0] === "!" ? />/ : /^(script|pre|style|textarea)$/.test(start) ? /<\/(?:script|pre|style|textarea)>/i : "blank";
      if (raw !== "blank" && raw.test(body)) raw = null;
    }
    buf += line;
  }
  flush(false);
  return parts;
}

/** Code as an element with every mark written as a character reference: it reads the same and can never be parsed as anything. */
function inert(code: string): string {
  const inner = /^ .*[^ ].* $/s.test(code) ? code.slice(1, -1) : code;
  return "<code>" + Array.from(inner, (c) => (/[A-Za-z0-9 ]/.test(c) ? c : `&#${c.codePointAt(0)};`)).join("") + "</code>";
}

function defuse(text: string, refs: boolean): string {
  const edits: { at: number; tag: boolean }[] = [];
  // Every "<" is looked at on its own, so a tag tucked inside another's attribute is still found.
  for (let i = text.indexOf("<"); i >= 0; i = text.indexOf("<", i + 1)) if (loads(text, i)) edits.push({ at: i, tag: true });
  // A picture's address can sit a long way after its "![", past brackets and code nested in its
  // label. Rather than pair them up the way a parser would, every "![" with a remote "](...)"
  // anywhere later in its paragraph is defused. With a remote reference definition in the text,
  // every "![" is.
  for (const para of text.matchAll(/(?:[^\n]|\n(?![ \t]*\n))+/g)) {
    const p = para[0];
    let last = -1;
    for (const c of p.matchAll(/\]\(/g)) {
      const from = c.index! + 2;
      if (isRemote(p.slice(from, from + 2100).trimStart().split(/[ \n]/)[0])) last = c.index!;
    }
    for (const b of p.matchAll(/!\[/g)) if (refs || b.index! < last) edits.push({ at: para.index! + b.index!, tag: false });
  }
  if (!edits.length) return text;
  edits.sort((a, b) => a.at - b.at);

  // What looks like inline code, line by line. Only how the result reads depends on this guess:
  // inside it or not, the mark that would have loaded something is defused.
  const spans: { start: number; end: number; ticks: number }[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    for (const s of line.matchAll(/(`+)(?!`).+?(?<!`)\1(?!`)/g)) spans.push({ start: offset + s.index!, end: offset + s.index! + s[0].length, ticks: s[1].length });
    offset += line.length + 1;
  }

  let out = "";
  let pos = 0;
  for (const e of edits) {
    if (e.at < pos) continue;
    const span = spans.find((s) => s.start < e.at && e.at < s.end);
    if (span) {
      out += text.slice(pos, span.start) + inert(text.slice(span.start + span.ticks, span.end - span.ticks));
      pos = span.end;
    } else if (e.tag) {
      out += text.slice(pos, e.at) + "&lt;";
      pos = e.at + 1;
    } else {
      // Dropping the "!" leaves a link. One with no text would show nothing to click.
      const empty = text.startsWith("[]", e.at + 1);
      out += text.slice(pos, e.at) + (empty ? "[image]" : "");
      pos = e.at + (empty ? 3 : 1);
    }
  }
  return out + text.slice(pos);
}

/**
 * Returns the Markdown with everything that would load from outside the vault made inert.
 * Running it again changes nothing. `trustFences: false` is for text whose author also chose
 * where its fences fall (a web page), so nothing in it is skipped as code.
 */
export function neutraliseRemote(md: string, o: { trustFences?: boolean } = {}): string {
  if (!md || !/[<!`~]/.test(md)) return md;
  const relabelled = md.replace(RUNS_ON_RENDER, "$1js");
  // A reference definition can give a picture its address from anywhere in the text, with the
  // address on the next line, inside a quote or not.
  let refs = false;
  for (const d of relabelled.matchAll(/\[[^\]\n]+\]:[\s>]*(\S+)/g)) if (isRemote(d[1])) refs = true;
  const parts = o.trustFences === false ? [{ text: relabelled, code: false }] : split(relabelled);
  // "`$= ...`" is Dataview's inline JavaScript.
  return parts.map((p) => (p.code ? p.text : defuse(p.text.replace(/(`+)\$=/g, "$1$ ="), refs))).join("");
}

/** The same for a parsed reply: every string in it, however deeply nested. */
export function neutraliseDeep<T>(value: T): T {
  if (typeof value === "string") return neutraliseRemote(value) as T;
  if (Array.isArray(value)) return value.map((v) => neutraliseDeep(v)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, neutraliseDeep(v)])) as T;
  return value;
}

/**
 * A second pass over what was rendered: anything that still points outside the vault is taken
 * out. The text filter is the real guard, since a browser may start a fetch before this runs;
 * this covers whatever the filter did not foresee.
 */
export function dropRemote(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("[src],[srcset],[poster],[data],[background],link[href],image[href],use[href]"))) {
    const addresses = ["src", "srcset", "poster", "data", "background", "href"].map((a) => el.getAttribute(a) ?? "").join(" ");
    // Obsidian serves vault files from app:// and plugins draw into blob: and data: pictures.
    const out = addresses.split(/[\s,]+/).some((u) => !!u && !/^(?:app|blob|capacitor):/i.test(u) && !/^data:image\//i.test(u) && (/^[a-z][a-z0-9+.-]*:/i.test(u) || /^[\\/]{2}/.test(u)));
    if (out) el.replaceWith(el.ownerDocument.createTextNode("[remote content blocked]"));
  }
}
