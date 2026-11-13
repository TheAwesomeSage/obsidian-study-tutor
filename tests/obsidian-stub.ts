// A minimal stand-in for the "obsidian" module so the view can be exercised under jsdom.
// It implements only what this plugin calls.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
(dom.window as any).confirm = () => true;

const proto = dom.window.HTMLElement.prototype as any;
proto.createEl = function (tag: string, o?: any) {
  const el = dom.window.document.createElement(tag) as any;
  if (typeof o === "string") el.className = o;
  else if (o) {
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
    if (o.text !== undefined) el.textContent = o.text;
    if (o.type) el.type = o.type;
    if (o.value !== undefined) el.value = o.value;
    for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, String(v));
  }
  this.appendChild(el);
  return el;
};
proto.createDiv = function (o?: any) {
  return this.createEl("div", o);
};
proto.createSpan = function (o?: any) {
  return this.createEl("span", o);
};
proto.empty = function () {
  while (this.firstChild) this.removeChild(this.firstChild);
};
proto.addClass = function (c: string) {
  this.classList.add(c);
};
proto.setText = function (t: string) {
  this.textContent = t;
};
proto.appendText = function (t: string) {
  this.appendChild(dom.window.document.createTextNode(t));
};
proto.toggle = function (show: boolean) {
  this.style.display = show ? "" : "none";
};

export const notices: string[] = [];

export class Notice {
  constructor(public message: string) {
    notices.push(message);
  }
  setMessage(m: string) {
    this.message = m;
    notices.push(m);
  }
  hide() {}
}

export class TFile {
  path = "";
  basename = "";
  extension = "md";
  parent: any = null;
}

export class Plugin {
  private stored: any = null;
  viewCreators: Record<string, (leaf: any) => any> = {};
  commands: any[] = [];
  constructor(
    public app: any,
    public manifest: any = {},
  ) {}
  async loadData() {
    return this.stored;
  }
  async saveData(d: any) {
    this.stored = JSON.parse(JSON.stringify(d));
  }
  registerView(type: string, creator: (leaf: any) => any) {
    this.viewCreators[type] = creator;
  }
  addRibbonIcon() {}
  addCommand(c: any) {
    this.commands.push(c);
  }
  settingTabs: any[] = [];
  addSettingTab(tab: any) {
    this.settingTabs.push(tab);
  }
}

export class Component {
  children: any[] = [];
  addChild<T>(c: T): T {
    this.children.push(c);
    return c;
  }
  removeChild(c: any) {
    this.children = this.children.filter((x) => x !== c);
  }
  registerDomEvent(el: any, type: string, cb: (e: any) => void) {
    el.addEventListener(type, cb);
  }
}

export class ItemView extends Component {
  app: any;
  contentEl: any;
  constructor(public leaf: any) {
    super();
    this.app = leaf.app;
    this.contentEl = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(this.contentEl);
  }
}

export class Modal {
  titleEl: any = dom.window.document.createElement("div");
  contentEl: any = dom.window.document.createElement("div");
  constructor(public app: any) {}
  open() {
    (this as any).onOpen();
  }
  close() {
    (this as any).onClose?.();
  }
}

export class PluginSettingTab {
  containerEl: any = dom.window.document.createElement("div");
  constructor(
    public app: any,
    public plugin: any,
  ) {}
}

class Control {
  el: any;
  constructor(parent: any, tag: string) {
    this.el = parent.createEl(tag);
  }
  setValue(v: string) {
    this.el.value = v;
    return this;
  }
  setPlaceholder() {
    return this;
  }
  onChange(cb: (v: string) => void) {
    this.el.onchange = () => cb(this.el.value);
    return this;
  }
  addOptions(o: Record<string, string>) {
    for (const [value, text] of Object.entries(o)) this.el.createEl("option", { value, text });
    return this;
  }
  setButtonText(t: string) {
    this.el.textContent = t;
    return this;
  }
  setCta() {
    return this;
  }
  setDisabled() {
    return this;
  }
  onClick(cb: () => void) {
    this.el.onclick = cb;
    return this;
  }
}

export class Setting {
  settingEl: any;
  constructor(parent: any) {
    this.settingEl = parent.createDiv({ cls: "setting-item" });
  }
  setName(t: string) {
    this.settingEl.createDiv({ text: t });
    return this;
  }
  setDesc(t: string) {
    this.settingEl.createDiv({ text: t });
    return this;
  }
  setHeading() {
    return this;
  }
  addText(cb: (c: Control) => void) {
    cb(new Control(this.settingEl, "input"));
    return this;
  }
  addDropdown(cb: (c: Control) => void) {
    cb(new Control(this.settingEl, "select"));
    return this;
  }
  addToggle(cb: (c: any) => void) {
    const el = this.settingEl.createEl("input", { type: "checkbox" });
    const t: any = {
      setValue(v: boolean) {
        el.checked = v;
        return t;
      },
      onChange(f: (v: boolean) => void) {
        el.onchange = () => f(el.checked);
        return t;
      },
    };
    cb(t);
    return this;
  }
  addButton(cb: (c: Control) => void) {
    cb(new Control(this.settingEl, "button"));
    return this;
  }
}

export const MarkdownRenderer = {
  async render(_app: any, md: string, el: any) {
    // Like Obsidian, turn [[links]] into anchors so the click handling can be tested.
    const div = el.createDiv();
    let last = 0;
    for (const m of md.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      div.appendText(md.slice(last, m.index));
      div.createEl("a", { cls: "internal-link", text: m[1], attr: { "data-href": m[1], href: m[1] } });
      last = m.index! + m[0].length;
    }
    div.appendText(md.slice(last));
  },
};

export type App = any;
export type WorkspaceLeaf = any;

export function setIcon(el: any, icon: string) {
  el.setAttribute("data-icon", icon);
}
