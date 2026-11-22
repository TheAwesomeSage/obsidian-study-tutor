import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { usageLine } from "./claude";
import { callModel, compileStrategyFor, COMPILE_STRATEGIES, modelCliPath, modelFor, MODEL_PROVIDERS, providerFor, type CompileStrategy } from "./model-provider";
import { braveResearch, DEFAULT_RESEARCH_LIMITS, researchLimits, type ResearchLimits } from "./compile-research";
import { CompileCancelled, type CompileMetrics, type ExpansionRequest } from "./compiler";
import { CompileResult, Engine, EngineSettings, Material } from "./engine";
import { Frontmatter, SourceMode, fmList, fmStr, splitFrontmatter, words } from "./formats";
import { DEFAULT_WEIGHTS, PolicyWeights, WEIGHT_LABELS } from "./policy";
import { DEFAULT_LOCAL_MODEL, DEFAULT_OLLAMA_URL, OllamaClient, locateLocal } from "./ollama";
import { LocalPassageSelector } from "./semantic-retrieval";
import { FS, Store } from "./store";
import { BundleFiles, SympyWorker } from "./sympy";
import { LocalCodeRunner } from "./coderun";
import { PythonRunner, browserPyPorts } from "./coderun-python";
import { NativeRunner } from "./coderun-native";
import { TutorView, VIEW_TYPE } from "./view";
import { courseExpansions, courseLessons, courseSources } from "./tutoring-adapters";
import { SavedActivityModal, configureVisualRuntime } from "./visuals/obsidian";
import { join } from "path";
import { existsSync, promises as fsp, readFileSync } from "fs";
import { createHash } from "crypto";
import * as visualRegistry from "./visuals/registry";
import { adaptRegistry } from "./visualcontract";
import { EXAMPLES, installExample } from "./examples";
import type {GraphLayoutStyle, Positions} from "./graphlayout";
import { DEFAULT_RETENTION, RETENTION_RANGE, ScheduleOwner, SchedulerChoice, SchedulerId, clampRetention, scheduleOwner, schedulerFor, schedulerLabel, schedulerRef } from "./scheduler";

export interface TutorSettings extends EngineSettings {
  root: string;
  newCardsPerDay: number;
  /** Quiz mode, and unaided practice in Adaptive mode, ask from the question bank and mark with plain code first. */
  bankQuiz: boolean;
  /** Hand flashcard review and scheduling to the Spaced Repetition community plugin when it is enabled. */
  useSpacedRepetition: boolean;
  /** The built-in review's card scheduler. SM-2 is what every version before 0.10 used. */
  scheduler: SchedulerId;
  /** FSRS only: the chance of recall each card is scheduled for. */
  desiredRetention: number;
  /** Compute and check maths with SymPy. On by default: SymPy ships with the plugin and runs offline. */
  mathCheck: boolean;
  /** A new learner is placed with bank questions marked by code, not model turns. */
  codePlacement: boolean;
  /** How the study policy weighs its components when choosing what to suggest. */
  weights: PolicyWeights;
  /** Minutes available for this sitting, chosen on the home screen. */
  minutes: number;
  /** Configure existing visual modules with a local Ollama model when no saved configuration fits. */
  localActivities: boolean;
  /** Optional semantic source selection using the configured local model. */
  semanticRetrieval: boolean;
  /** Which models compile a course (model-provider.ts). Settings from before it was added are migrated from `localCompilation`. */
  compileStrategy: CompileStrategy;
  /** Plan diagrams and simulations at compile time with the main provider ("main" compile strategy only). */
  compileBlueprints: boolean;
  /** The local model, an Ollama tag. */
  localModel: string;
  /** The local Ollama server. Only loopback addresses are used. */
  ollamaUrl: string;
  /** Run Python answers to code questions in the bundled Pyodide. On by default: it is sandboxed WebAssembly. */
  pythonRunner: boolean;
  /** Compile and run C and C++ answers with a local compiler. Off by default: no sandbox. */
  nativeRunner: boolean;
  /** The C or C++ compiler to use; blank searches PATH. */
  compilerPath: string;
}

interface PluginData {
  settings: TutorSettings;
  activeTopic: string;
  activeChat: Record<string, string>;
  /** Fingerprint of each skill file as this plugin last wrote it, to spot the user's edits. */
  skills: Record<string, string>;
  /** Bumped when a default changes, so the old default can be moved forward once. */
  settingsVersion: number;
  /** Unsent text per chat, so a draft survives switching screens and restarting. */
  drafts: Record<string, string>;
  /** Where each concept sits on the knowledge graph, so the map stays familiar. */
  graphLayout: Record<string, [number, number]>;
  /** Each layout keeps its own saved coordinates; the previous map survives tree adoption. */
  graphLayoutMode?: GraphLayoutStyle;
  graphLayouts?: Partial<Record<GraphLayoutStyle,Positions>>;
}

const DEFAULTS: TutorSettings = {
  root: "Tutor",
  modelProvider: "claude",
  claudePath: "",
  codexPath: "",
  chatModel: "sonnet",
  compileModel: "sonnet",
  utilityModel: "haiku",
  codexChatModel: "",
  codexCompileModel: "",
  codexUtilityModel: "",
  effort: "low",
  targetLevel: 4,
  maxChatWords: 600,
  maxTopicWords: 2000,
  singlePassWords: 6000,
  newCardsPerDay: 10,
  bankQuiz: true,
  useSpacedRepetition: true,
  scheduler: "sm2",
  desiredRetention: DEFAULT_RETENTION,
  mathCheck: true,
  codePlacement: true,
  smartRouting: true,
  hardEffort: "high",
  weights: { ...DEFAULT_WEIGHTS },
  minutes: 25,
  localActivities: true,
  semanticRetrieval: false,
  compileStrategy: "hybrid",
  compileBlueprints: true,
  researchLimits: DEFAULT_RESEARCH_LIMITS,
  localModel: DEFAULT_LOCAL_MODEL,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  pythonRunner: true,
  nativeRunner: false,
  compilerPath: "",
};

const SR_PLUGIN = "obsidian-spaced-repetition";

/**
 * Reads the SymPy runtime shipped in the plugin's `pyodide` folder (listed with SHA-256 hashes in
 * its bundle.json). Null when the folder is not there; an error when a file is missing or damaged,
 * so a broken install says so instead of failing somewhere inside Python. `keep` picks which
 * files are read: the code runner needs Python without the SymPy wheels.
 */
export async function readSympyBundle(dir: string, keep: (name: string) => boolean = () => true): Promise<BundleFiles | null> {
  let list: { files?: Record<string, string> };
  try {
    list = JSON.parse(await fsp.readFile(join(dir, "bundle.json"), "utf8"));
  } catch {
    return null;
  }
  const entries = Object.entries(list.files ?? {}).filter(([name]) => keep(name));
  if (!entries.some(([name]) => name === "pyodide.js")) return null;
  const out: BundleFiles = {};
  for (const [name, sha] of entries) {
    if (!/^[\w.+-]+$/.test(name)) throw new Error(`the bundled SymPy list names "${name}", which is not a plain file name`);
    const data = await fsp.readFile(join(dir, name)).catch(() => null);
    if (!data) throw new Error(`the bundled SymPy file ${name} is missing; reinstall the whole plugin folder`);
    if (createHash("sha256").update(data).digest("hex") !== sha) throw new Error(`the bundled SymPy file ${name} is damaged; reinstall the whole plugin folder`);
    // A copy that owns its memory, so it can be moved to the worker.
    out[name] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return out;
}

/** Which models compiled the topic and where the local one ran, for the compile notice. */
function strategyLine(m: CompileMetrics, provider: string): string {
  if (!m.strategy) return "";
  const parts = [`Strategy: ${COMPILE_STRATEGIES[m.strategy]}`];
  if (m.mainModel) parts.push(`${provider} answered as ${m.mainModel}`);
  if (m.localModel) parts.push(`Ollama ${m.localModel} ${m.localRuns === "cloud" ? "ran in the cloud (cloud inference)" : m.localRuns === "local" ? "ran on this computer" : "was not proven to run on this computer"}`);
  if (m.localEscalations) parts.push(`${m.localEscalations} passage selection${m.localEscalations === 1 ? "" : "s"} escalated to ${provider} after Ollama's reply failed its checks`);
  return parts.join(" · ");
}

export type SourceKind = "links" | "active" | "folder" | "spec" | "subject";

const MAX_NOTES = 80;
const MAX_WORDS = 60000;

export default class StudyTutorPlugin extends Plugin {
  data!: PluginData;
  store!: Store;
  engine!: Engine;
  private activeCompile: AbortController | null = null;
  /** SymPy in a worker. Nothing is downloaded or started until a check is actually asked for. */
  sympy = new SympyWorker();
  /** Runs answers to code questions: Python in its own Pyodide worker, C and C++ with a local compiler when switched on. */
  codeRunner!: LocalCodeRunner;

  get opts(): TutorSettings {
    return this.data.settings;
  }

  async onload(): Promise<void> {
    const adapter = this.app.vault.adapter as unknown as {getBasePath?:()=>string};
    const pluginDir = adapter.getBasePath && this.manifest.dir ? join(adapter.getBasePath(), this.manifest.dir) : "";
    if (pluginDir) configureVisualRuntime(this.app, pluginDir);
    // SymPy ships in the plugin folder; the worker is given those files instead of downloading them.
    const bundled = !!pluginDir && existsSync(join(pluginDir, "pyodide", "bundle.json"));
    if (bundled) this.sympy.useBundle(() => readSympyBundle(join(pluginDir, "pyodide")));
    // The code runner uses the same Python, without the SymPy wheels, and never downloads it.
    let label = "Pyodide (bundled)";
    try {
      const info = (bundled ? JSON.parse(readFileSync(join(pluginDir, "pyodide", "bundle.json"), "utf8")) : {}) as { pyodide?: string; python?: string };
      if (info.pyodide && info.python) label = `Pyodide ${info.pyodide} (Python ${info.python.split(".").slice(0, 2).join(".")})`;
    } catch {
      /* not installed: the runner says so when asked */
    }
    this.codeRunner = new LocalCodeRunner({
      settings: () => ({ python: this.opts.pythonRunner, native: this.opts.nativeRunner }),
      python: new PythonRunner(bundled ? browserPyPorts(() => readSympyBundle(join(pluginDir, "pyodide"), (name) => !name.endsWith(".whl"))) : null, label),
      native: new NativeRunner(() => this.opts.compilerPath),
    });
    const saved = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    const layoutMode=saved.graphLayoutMode&&["tree","connected","clusters"].includes(saved.graphLayoutMode)?saved.graphLayoutMode:undefined;
    this.data = { settings: { ...DEFAULTS, ...(saved.settings ?? {}) }, activeTopic: saved.activeTopic ?? "", activeChat: saved.activeChat ?? {}, skills: saved.skills ?? {}, settingsVersion: saved.settingsVersion ?? 1, drafts: saved.drafts ?? {}, graphLayout: saved.graphLayout ?? {}, graphLayoutMode:layoutMode, graphLayouts:saved.graphLayouts??{} };
    // Settings saved by an older version have no weights; a partly filled set is completed from the defaults.
    this.data.settings.weights = { ...DEFAULT_WEIGHTS, ...(saved.settings?.weights ?? {}) };
    // Up to 0.9 a toggle chose whether Ollama selected passages; off is the main strategy now.
    const legacy = this.data.settings as TutorSettings & { localCompilation?: boolean };
    if (!saved.settings?.compileStrategy && legacy.localCompilation === false) legacy.compileStrategy = "main";
    legacy.compileStrategy = compileStrategyFor(legacy);
    delete legacy.localCompilation;
    const before = this.data.settingsVersion;
    if (this.data.settingsVersion < 2) {
      // 0.1 shipped with 1,200-word chat parts. Move anyone still on that default to 600.
      if (this.data.settings.maxChatWords === 1200) this.data.settings.maxChatWords = 600;
      this.data.settingsVersion = 2;
    }
    let sympyOn = false;
    if (this.data.settingsVersion < 3) {
      // Up to 0.7 SymPy was off by default because switching it on downloaded it. Now it ships with
      // the plugin, so it is switched on once, where the bundled copy is actually installed.
      if (bundled && !this.data.settings.mathCheck) this.data.settings.mathCheck = sympyOn = true;
      this.data.settingsVersion = 3;
    }
    if (saved.settings && this.data.settingsVersion !== before) await this.saveData(this.data);
    if (sympyOn && saved.settings) new Notice("Study Tutor: SymPy now ships with the plugin and runs offline, so maths checking is switched on. You can turn it off in Settings → Study Tutor → Maths.", 12000);
    this.buildStore();

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TutorView(leaf, this));
    this.addRibbonIcon("graduation-cap", "Open Study Tutor", () => void this.activateView());
    this.addCommand({ id: "open", name: "Open tutor", callback: () => void this.activateView() });
    this.addCommand({ id: "new-topic", name: "New topic", callback: () => this.openNewTopic() });
    this.addCommand({ id: "expand-topic", name: "Compile a linked prerequisite or extension", callback: () => {
      if (!this.data.activeTopic) { new Notice("Open a study topic first."); return; }
      new ExpandTopicModal(this.app, this, this.data.activeTopic).open();
    } });
    this.addCommand({ id: "home", name: "Open home screen", callback: async () => (await this.activateView())?.go("home") });
    this.addCommand({ id: "review", name: "Review due flashcards", callback: async () => (await this.activateView())?.go("review") });
    this.addCommand({ id: "graph", name: "Open knowledge graph", callback: async () => (await this.activateView())?.go("graph") });
    this.addCommand({ id: "open-saved-activity", name: "Open saved visual lesson", callback: () => new SavedActivityModal(this.app).open() });
    this.addSettingTab(new TutorSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      try {
        const r = await this.store.installSkills(this.data.skills);
        if (JSON.stringify(r.record) !== JSON.stringify(this.data.skills)) {
          this.data.skills = r.record;
          await this.save();
        }
        if (r.updated) new Notice(`Study Tutor: ${r.updated} teaching rule file(s) updated to the new version. Files you have edited were left alone.`, 8000);
        await this.store.writeDashboard();
      } catch (e) {
        console.error("Study Tutor: could not set up its folder", e);
      }
    });
  }

  buildStore(): void {
    const root = this.opts.root.replace(/^\/+|\/+$/g, "") || "Tutor";
    this.store = new Store(this.app.vault.adapter as FS, root);
    this.store.scheduler = () => this.schedulerChoice();
    this.engine = new Engine(this.store, () => ({ ...this.opts, externalFlashcards: this.usesSr() }));
    const searchKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
    this.engine.researchProvider = searchKey ? braveResearch(searchKey) : null;
    this.engine.maths = this.sympy;
    this.engine.codeRunner = this.codeRunner;
    // Source notes are read by name, for the short excerpts a teaching step may need.
    const readNote = async (name: string) => {
      const f = this.app.metadataCache.getFirstLinkpathDest(name, "");
      if (!f || f.extension !== "md" || f.path.startsWith(this.store.root + "/")) return null;
      return splitFrontmatter(await this.app.vault.cachedRead(f)).body;
    };
    this.engine.readNote = readNote;
    // The same, with the note's vault path, for the provenance of activities. Read only.
    this.engine.readSource = async (name: string) => {
      const f = this.app.metadataCache.getFirstLinkpathDest(name, "");
      if (!f || f.extension !== "md" || f.path.startsWith(this.store.root + "/")) return null;
      return { path: f.path, text: splitFrontmatter(await this.app.vault.cachedRead(f)).body };
    };
    const engine = this.engine;
    engine.sources = courseSources(this.store, readNote);
    engine.material = courseLessons(this.store);
    engine.expander = courseExpansions(this.store, async (request, signal) => {
      if (this.activeCompile) return { status: "failed", reason: "Another compilation is running. Try again after it finishes." };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      this.activeCompile = controller;
      try {
        return await engine.expandCourse(request, controller.signal);
      } finally {
        signal?.removeEventListener("abort", abort);
        this.activeCompile = null;
      }
    });
    this.buildLocal();
    this.engine.visuals = adaptRegistry(visualRegistry as unknown as Record<string, unknown>);
  }

  /** Share one generation queue between compilation and visual activities. */
  buildLocal(): void {
    const compiles = compileStrategyFor(this.opts) !== "main";
    const client = this.opts.localActivities || compiles || this.opts.semanticRetrieval ? new OllamaClient({ model: this.opts.localModel || DEFAULT_LOCAL_MODEL, baseUrl: this.opts.ollamaUrl || DEFAULT_OLLAMA_URL }) : null;
    this.engine.local = this.opts.localActivities ? client : null;
    this.engine.compilationLocal = compiles ? client : null;
    this.engine.semanticSelector = this.opts.semanticRetrieval && client ? new LocalPassageSelector(client) : null;
  }

  /** Opens Obsidian's settings on this plugin's tab. The settings API is not typed, so every step is guarded. */
  openSettings(): void {
    try {
      const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
      setting?.open?.();
      setting?.openTabById?.(this.manifest.id);
    } catch {
      new Notice("Open Settings, then Community plugins, then Study Tutor.");
    }
  }

  onunload(): void {
    this.activeCompile?.abort();
    this.sympy.dispose();
    this.codeRunner?.dispose();
  }

  /** Whether the Spaced Repetition community plugin is installed and switched on in this vault. */
  srAvailable(): boolean {
    // `plugins` and `commands` are not in Obsidian's typed API, so every use is guarded.
    try {
      return !!(this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins?.has(SR_PLUGIN);
    } catch {
      return false;
    }
  }

  /** Who keeps the flashcard schedule (scheduler.ts decides): Spaced Repetition when the setting is on and that plugin is there. */
  scheduleOwner(): ScheduleOwner {
    return scheduleOwner(this.opts.useSpacedRepetition, this.srAvailable());
  }

  usesSr(): boolean {
    return this.scheduleOwner() === "spaced-repetition";
  }

  /** The built-in review's scheduler, as the settings choose it. */
  schedulerChoice(): SchedulerChoice {
    return { id: this.opts.scheduler === "fsrs" ? "fsrs" : "sm2", retention: clampRetention(this.opts.desiredRetention) };
  }

  /** Brings the topic's flashcard note up to date, opens it, and starts that plugin's review on it. */
  async reviewInSr(dir: string): Promise<void> {
    const path = await this.store.exportFlashcards(dir);
    await this.app.workspace.openLinkText(path, "", false);
    // Give Obsidian a moment to make the note the active one before the command reads it.
    window.setTimeout(() => {
      try {
        const ok = (this.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands?.executeCommandById?.(`${SR_PLUGIN}:srs-review-flashcards-in-note`);
        if (!ok) new Notice('The flashcard note is open. Run "Spaced Repetition: Review flashcards in this note" from the command palette.', 9000);
      } catch {
        new Notice('The flashcard note is open. Run "Spaced Repetition: Review flashcards in this note" from the command palette.', 9000);
      }
    }, 300);
  }

  async save(): Promise<void> {
    await this.saveData(this.data);
  }

  async activateView(): Promise<TutorView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const right = workspace.getLeaf("tab");
      if (!right) return null;
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf.getRoot() !== workspace.rootSplit) {
      const previous = leaf;
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      previous.detach();
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof TutorView ? leaf.view : null;
  }

  /**
   * Saves a bundled example course as a topic (no model call) and opens it. One already in the
   * vault is opened as it is, so a learner's progress on it is never replaced.
   */
  async addExample(id: string): Promise<string | null> {
    try {
      const { dir, added } = await installExample(this.store, id, this.opts.targetLevel);
      new Notice(added ? "Study Tutor: example course added. It was written by hand, so no model was called." : "Study Tutor: the example course is already in your vault, so it was opened as it is.");
      this.data.activeTopic = dir;
      await this.save();
      const view = await this.activateView();
      await view?.reload();
      view?.go("topic");
      return dir;
    } catch (e) {
      new Notice(`Study Tutor: ${(e as Error).message}`);
      return null;
    }
  }

  /** Opens the New topic dialog. A seed (from a free chat) fills in the title and goal and links the course back to that chat. */
  openNewTopic(seed?: TopicSeed): void {
    new NewTopicModal(this.app, this, seed).open();
  }

  /** Reads the source notes itself, so the model needs no tools. */
  async gather(kind: SourceKind, folder: string, sources?: string[]): Promise<{ mode: SourceMode; material: Material[]; fm: Frontmatter; truncated: boolean }> {
    const mode: SourceMode = kind === "subject" ? "subject" : kind === "spec" ? "spec" : "notes";
    if (kind === "subject") return { mode, material: [], fm: { kind }, truncated: false };

    let files: TFile[] = [];
    if (sources && sources.length && kind !== "folder") {
      for (const link of sources) {
        const f = this.app.metadataCache.getFirstLinkpathDest(link.replace(/^\[\[|\]\]$/g, "").split("|")[0], "");
        if (f && f.extension === "md") files.push(f);
      }
    } else if (kind === "folder") {
      const dir = folder.replace(/^\/+|\/+$/g, "");
      if (!dir) throw new Error("Enter a folder path.");
      files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(dir + "/") && !f.path.startsWith(this.store.root + "/"));
      files.sort((a, b) => a.path.localeCompare(b.path));
    } else {
      const active = this.app.workspace.getActiveFile();
      if (!active || active.extension !== "md") throw new Error("Open the note you want to learn from first.");
      files = [active];
      if (kind === "links") {
        for (const p of Object.keys(this.app.metadataCache.resolvedLinks[active.path] ?? {})) {
          const f = this.app.vault.getAbstractFileByPath(p);
          if (f instanceof TFile && f.extension === "md" && !p.startsWith(this.store.root + "/")) files.push(f);
        }
      }
    }
    if (!files.length) throw new Error("No notes found for this source.");

    const material: Material[] = [];
    let total = 0;
    let truncated = false;
    for (const f of files) {
      if (material.length >= MAX_NOTES || total >= MAX_WORDS) {
        truncated = true;
        break;
      }
      const text = splitFrontmatter(await this.app.vault.cachedRead(f)).body.trim();
      if (!text) continue;
      material.push({ name: f.basename, path: f.path, text });
      total += words(text);
    }
    if (!material.length) throw new Error("The source notes are empty.");
    const fm: Frontmatter = { kind, sources: material.map((m) => `[[${m.name}]]`) };
    if (kind === "folder") fm.folder = folder.replace(/^\/+|\/+$/g, "");
    return { mode, material, fm, truncated };
  }

  async compileTopic(p: { title: string; kind: SourceKind; folder: string; goal: string; research?: boolean; existingDir?: string; sources?: string[]; fromAsk?: string }): Promise<CompileResult | null> {
    return this.runCompilation(async (signal, progress) => {
      progress("Gathering notes…");
      const g = await this.gather(p.kind, p.folder, p.sources);
      const origin = p.fromAsk ?? (p.existingDir ? fmStr((await this.store.loadTopic(p.existingDir).catch(() => null))?.fm ?? {}, "from_ask") : "");
      const fm = origin ? { ...g.fm, from_ask: origin } : g.fm;
      const req = { title: p.title, mode: g.mode, goal: p.goal, material: g.material, fm, existingDir: p.existingDir, research: p.research, truncated: g.truncated, signal };
      const res = await (p.existingDir && !g.truncated ? this.engine.refresh({ ...req, existingDir: p.existingDir }, progress) : this.engine.compile(req, progress));
      // The free chat it grew from can open the course from now on. A chat deleted meanwhile changes nothing.
      if (p.fromAsk) await this.engine.linkAskCourse(p.fromAsk, res.dir).catch(() => undefined);
      return res;
    }, p.fromAsk);
  }

  async compileExpansion(request: ExpansionRequest, existingDir?: string): Promise<CompileResult | null> {
    return this.runCompilation(async (signal, progress) => {
      const result = await this.engine.expandCourse(request, signal, progress, existingDir);
      if ("result" in result) return result.result;
      throw new Error(result.reason);
    });
  }

  /** `keepChat`: the free chat a course grew from. If it is still open, it stays open when the compile ends. */
  private async runCompilation(run: (signal: AbortSignal, progress: (msg: string) => void) => Promise<CompileResult>, keepChat?: string): Promise<CompileResult | null> {
    if (this.activeCompile) {
      new Notice("Study Tutor: a compilation is already running.");
      return null;
    }
    const controller = new AbortController();
    this.activeCompile = controller;
    const notice = new Notice("Study Tutor: preparing compilation…", 0);
    const progress = (msg: string) => {
      if (controller.signal.aborted) return;
      const content = document.createDocumentFragment();
      content.append(`Study Tutor: ${msg} `);
      if (!msg.startsWith("Saving ")) {
        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", e => {
          e.stopPropagation();
          controller.abort();
          notice.setMessage("Study Tutor: stopping compilation…");
        }, { once: true });
        content.append(cancel);
      }
      notice.setMessage(content);
    };
    try {
      progress("Preparing compilation…");
      const res = await run(controller.signal, progress);
      notice.hide();
      const how = res.refresh === "unchanged" ? `Nothing changed (${res.why}); no model was called.` : res.refresh === "partial" ? `Refreshed subskill ${(res.subskillsRefreshed ?? []).join(", ")} (${res.why}).` : res.refresh === "full" ? `Compiled in full: ${res.why}.` : "";
      const stats = res.metrics;
      const activity = stats ? `\n${stats.searches} search attempts · ${stats.pages} pages requested · ${stats.cacheHits} cache hits · Ollama ${(stats.localMs / 1000).toFixed(1)}s (${stats.localCalls} calls)${stats.generators || stats.generatorsRejected ? ` · question generators: ${stats.generators ?? 0} kept, ${stats.generatorsRejected ?? 0} dropped` : ""}${stats.codeTasks || stats.codeTasksRejected ? ` · code tasks: ${stats.codeTasks ?? 0} kept, ${stats.codeTasksRejected ?? 0} dropped` : ""}` : "";
      const where = stats ? strategyLine(stats, MODEL_PROVIDERS[providerFor(this.opts)]) : "";
      const nSealed = (await this.store.loadSealed(res.dir)).length;
      const sealedNote = nSealed > 0 ? ` ${nSealed} sealed for cold probes.` : "";
      new Notice(`${res.status === "partial" ? "Partial topic saved" : "Topic ready"}: ${res.subskills} subskills, ${res.questions} questions.${sealedNote}${res.preservedCourse ? " The previous topic was kept." : ""}${how ? `\n${how}` : ""}${res.coverage ? `\n${res.coverage}` : ""}${activity}${where ? `\n${where}` : ""}\nModel: ${usageLine(res.usage)} in ${res.usage.calls} call(s)`, 12000);
      this.data.activeTopic = res.preservedCourse ?? res.dir;
      await this.save();
      // Keep the flashcard note in step with the new question bank; existing schedules are kept.
      if (this.usesSr()) await this.store.exportFlashcards(res.dir);
      const view = await this.activateView();
      if (view && keepChat && view.chatPath === keepChat) await view.refreshAround(keepChat);
      else await view?.reload();
      return res;
    } catch (e) {
      notice.hide();
      new Notice(`Study Tutor: ${e instanceof CompileCancelled ? e.message : controller.signal.aborted ? new CompileCancelled().message : (e as Error).message}`, 12000);
      return null;
    } finally {
      this.activeCompile = null;
    }
  }

  async recompile(dir: string): Promise<void> {
    const expansion = (await this.store.loadPackage(dir))?.staged?.expansion;
    if (expansion) { await this.compileExpansion(expansion, dir); return; }
    const topic = await this.store.loadTopic(dir);
    const kind = (fmStr(topic.fm, "kind", "subject") as SourceKind) || "subject";
    await this.compileTopic({ title: topic.title, kind, folder: fmStr(topic.fm, "folder"), goal: fmStr(topic.fm, "goal"), research: fmStr(topic.fm, "research") === "yes", existingDir: dir, sources: fmList(topic.fm, "sources") });
  }
}

class ExpandTopicModal extends Modal {
  constructor(app: App, private plugin: StudyTutorPlugin, private dir: string) { super(app); }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Compile a linked topic");
    try {
      const state = await this.plugin.store.loadState(this.dir, this.plugin.opts.targetLevel);
      const concepts = Object.entries(state.concepts);
      if (!concepts.length) { this.contentEl.createEl("p", { text: "This topic has no concept to extend yet." }); return; }
      let anchorConcept = concepts[0][1], kind: ExpansionRequest["kind"] = "prerequisite", gap = "", research = false;
      new Setting(this.contentEl).setName("From concept").addDropdown(d => {
        for (const [n, id] of concepts) d.addOption(id, state.names[Number(n)] ?? id);
        d.setValue(anchorConcept).onChange(v => { anchorConcept = v; });
      });
      new Setting(this.contentEl).setName("Scope").addDropdown(d => d.addOption("prerequisite", "Missing prerequisite").addOption("extension", "Beyond the specification").onChange(v => { kind = v === "extension" ? v : "prerequisite"; }));
      new Setting(this.contentEl).setName("What would you like to learn?").addTextArea(t => t.setPlaceholder("For example: why projecting twice gives the same result").onChange(v => { gap = v.trim(); }));
      new Setting(this.contentEl).setName("Research on the web if needed").addToggle(t => t.onChange(v => { research = v; }));
      new Setting(this.contentEl).addButton(b => b.setButtonText("Compile linked topic").setCta().onClick(() => {
        if (!gap || gap.length > 600) { new Notice("Describe one gap or application in at most 600 characters."); return; }
        this.close();
        void this.plugin.compileExpansion({ kind, anchorDir: this.dir, anchorConcept, gap, research });
      }));
    } catch (e) { this.contentEl.createEl("p", { text: (e as Error).message }); }
  }

  onClose(): void { this.contentEl.empty(); }
}

/** What a free chat hands the New topic dialog. */
export interface TopicSeed {
  title: string;
  goal: string;
  /** The free chat's path, linked to the course once it is compiled. */
  fromAsk: string;
}

class NewTopicModal extends Modal {
  constructor(
    app: App,
    private plugin: StudyTutorPlugin,
    private seed?: TopicSeed,
  ) {
    super(app);
  }

  onOpen(): void {
    const active = this.app.workspace.getActiveFile();
    const seed = this.seed;
    let title = seed?.title ?? (active && active.extension === "md" ? active.basename : "");
    // A course grown from a question teaches the subject unless the learner picks notes.
    let kind: SourceKind = active && !seed ? "links" : "subject";
    let folder = active?.parent && active.parent.path !== "/" ? active.parent.path : "";
    let goal = seed?.goal ?? "";
    // Web research is offered by default only when there are no notes to teach from.
    const noNotes = (k: SourceKind) => k === "spec" || k === "subject";
    let research = noNotes(kind);
    let researchToggle: { setValue(v: boolean): unknown } | null = null;
    this.titleEl.setText(seed ? "Make this a course" : "New topic");
    const { contentEl } = this;

    new Setting(contentEl).setName("Title").addText((t) => t.setValue(title).onChange((v) => (title = v)));
    let folderSetting: Setting | null = null;
    new Setting(contentEl)
      .setName("Teach from")
      .setDesc(active ? `Active note: ${active.basename}` : "No note is open.")
      .addDropdown((d) =>
        d
          .addOptions({ links: "Active note and the notes it links to", active: "Active note only", folder: "A folder of notes", spec: "Active note is a spec or syllabus", subject: "The subject alone (no notes)" })
          .setValue(kind)
          .onChange((v) => {
            kind = v as SourceKind;
            folderSetting?.settingEl.toggle(kind === "folder");
            research = noNotes(kind);
            researchToggle?.setValue(research);
          }),
      );
    folderSetting = new Setting(contentEl).setName("Folder").addText((t) => t.setPlaceholder("Maths/Linear algebra").setValue(folder).onChange((v) => (folder = v)));
    folderSetting.settingEl.toggle(false);
    new Setting(contentEl)
      .setName("Goal (optional)")
      .setDesc("Level or purpose, for example: first-year university course, exam in June.")
      .addText((t) => t.setValue(goal).onChange((v) => (goal = v)));
    new Setting(contentEl)
      .setName("Research on the web")
      .setDesc("Searches through Brave and reads selected public pages. Requires BRAVE_SEARCH_API_KEY in Obsidian's environment. Without it, compilation uses available notes and reports research gaps.")
      .addToggle((t) => {
        researchToggle = t;
        t.setValue(research).onChange((v) => (research = v));
      });
    new Setting(contentEl).setDesc("Compiling reads the notes once and writes a topic card and question bank. Chat turns then load only that card.").addButton((b) =>
      b
        .setButtonText("Compile")
        .setCta()
        .onClick(() => {
          if (!title.trim()) {
            new Notice("Give the topic a title.");
            return;
          }
          this.close();
          void this.plugin.compileTopic({ title: title.trim(), kind, folder, goal, research, fromAsk: seed?.fromAsk });
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TutorSettingTab extends PluginSettingTab {
  /** What the last check of the code runners found, shown under its button. */
  private codeStatus = "";

  constructor(
    app: App,
    private plugin: StudyTutorPlugin,
  ) {
    super(app, plugin);
  }

  /** Who keeps the schedule, the built-in scheduler, and what the active topic's state records. */
  private schedulerSettings(containerEl: HTMLElement): void {
    const s = this.plugin.opts;
    const choice = this.plugin.schedulerChoice();
    const external = this.plugin.scheduleOwner() === "spaced-repetition";
    new Setting(containerEl)
      .setName("Flashcard schedule kept by")
      .setDesc(external ? "The Spaced Repetition plugin. Study Tutor does not schedule these cards itself; the scheduler below applies only to the built-in review." : `Study Tutor, with ${schedulerLabel(choice)} (${schedulerRef(choice)}).`);
    // Every view reloads, so each topic's state moves onto the new scheduler now and records the switch.
    const switched = async () => {
      await this.plugin.save();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof TutorView) await leaf.view.reload();
      this.display();
    };
    const row = new Setting(containerEl)
      .setName("Card scheduler")
      .setDesc("Built-in review only. Every card keeps a log of its latest reviews and its SM-2 dates, so going back to SM-2 restores them exactly. Switching to FSRS rebuilds each card from its log; a card not reviewed since this version starts from its SM-2 interval and ease. Each topic's state records the scheduler and every switch.")
      .addDropdown((d) =>
        d
          .addOptions({ sm2: `${schedulerFor({ id: "sm2", retention: DEFAULT_RETENTION }).label} (default)`, fsrs: schedulerFor({ id: "fsrs", retention: DEFAULT_RETENTION }).label })
          .setValue(s.scheduler)
          .onChange(async (v) => {
            s.scheduler = v === "fsrs" ? "fsrs" : "sm2";
            await switched();
          }),
      );
    const active = this.plugin.data.activeTopic;
    if (active) {
      void this.plugin.store.schedulerRecord(active).then((rec) => {
        const last = rec?.switches[rec.switches.length - 1];
        const text = `This topic's cards: ${schedulerLabel(rec)} (${schedulerRef(rec)})${last ? `, last switched ${last.at} from ${last.from}` : ""}.`;
        (row.descEl ?? row.settingEl).createDiv({ cls: "st-scheduler-record", text });
      }).catch(() => undefined);
    }
    if (s.scheduler !== "fsrs") return;
    const options: Record<string, string> = {};
    for (const r of [0.8, 0.85, 0.9, 0.95, choice.retention].sort((a, b) => a - b)) options[String(r)] = r === DEFAULT_RETENTION ? `${r} (default)` : String(r);
    new Setting(containerEl)
      .setName("Desired retention")
      .setDesc(`FSRS only: the chance of recall each card is scheduled for, from ${RETENTION_RANGE[0]} to ${RETENTION_RANGE[1]}. Higher means shorter intervals and more reviews.`)
      .addDropdown((d) =>
        d
          .addOptions(options)
          .setValue(String(choice.retention))
          .onChange(async (v) => {
            s.desiredRetention = clampRetention(Number(v));
            await switched();
          }),
      );
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.opts;
    containerEl.empty();
    type TextSetting = "root" | "claudePath" | "codexPath" | "chatModel" | "compileModel" | "utilityModel" | "codexChatModel" | "codexCompileModel" | "codexUtilityModel";
    const text = (name: string, desc: string, key: TextSetting, placeholder = "", after?: () => void) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t
          .setPlaceholder(placeholder)
          .setValue(s[key] ?? "")
          .onChange(async (v) => {
            s[key] = v.trim();
            await this.plugin.save();
            after?.();
          }),
      );
    const num = (name: string, desc: string, key: "targetLevel" | "maxChatWords" | "maxTopicWords" | "singlePassWords" | "newCardsPerDay", min: number, max = Infinity) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(String(s[key])).onChange(async (v) => {
          const n = Math.round(Number(v));
          if (!Number.isFinite(n) || n < min || n > max) return;
          s[key] = n;
          await this.plugin.save();
        }),
      );

    text("Tutor folder", "Where topics, chats and the editable skill files live in this vault.", "root", "Tutor", () => this.plugin.buildStore());
    const provider = providerFor(s);
    const codex = provider === "codex";
    new Setting(containerEl)
      .setName("Model provider")
      .setDesc("Choose the signed-in CLI for tutoring, course compilation, and grading.")
      .addDropdown(d => d.addOptions(MODEL_PROVIDERS).setValue(provider).onChange(async value => {
        s.modelProvider = value === "codex" ? "codex" : "claude";
        await this.plugin.save();
        this.display();
      }));
    const detected = modelCliPath(s);
    const name = MODEL_PROVIDERS[provider];
    const signIn = codex ? "codex login" : "claude";
    text(`${name} path`, detected ? `Using ${detected}` : `Install ${name} or enter the full path to its executable. Sign in by running ${signIn}.`,
      codex ? "codexPath" : "claudePath", "Auto-detect").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        const settings = { ...s };
        b.setDisabled(true);
        try {
          const r = await callModel(settings, { model: modelFor(settings, "chatModel"), system: "Reply with exactly OK.", input: "Test.", timeoutMs: 60000 });
          new Notice(`${MODEL_PROVIDERS[providerFor(settings)]} replied "${r.text.trim().slice(0, 40)}".\n${usageLine(r.usage)}`, 10000);
        } catch (e) {
          new Notice(`Connection test failed. ${e instanceof Error ? e.message : String(e)}`, 12000);
        } finally {
          b.setDisabled(false);
        }
      }),
    );

    new Setting(containerEl).setName("Models").setHeading();
    text("Chat model", codex ? "Used in study chats. Leave blank to use the CLI default." : "Used in study chats. Enter an alias or a full model name.",
      codex ? "codexChatModel" : "chatModel", codex ? "CLI default" : "sonnet");
    text("Compile model", "Plans objectives, writes lessons and questions, and checks coverage.",
      codex ? "codexCompileModel" : "compileModel", codex ? "CLI default" : "sonnet");
    text("Utility model", "Used for summaries, flashcard grading and simpler requests.",
      codex ? "codexUtilityModel" : "utilityModel", codex ? "CLI default" : "haiku");
    new Setting(containerEl)
      .setName("Chat effort")
      .setDesc("How hard the chat model thinks before replying. Low uses the least. Raise it for proof-heavy maths.")
      .addDropdown((d) =>
        d
          .addOptions({ "": "Model default", low: "Low", medium: "Medium", high: "High" })
          .setValue(s.effort)
          .onChange(async (v) => {
            s.effort = v;
            await this.plugin.save();
          }),
      );

    new Setting(containerEl).setName("Teaching").setHeading();
    num("Target level", "Level (3 to 5) each subskill must reach for a new topic to count as mastered.", "targetLevel", 3, 5);
    new Setting(containerEl)
      .setName("Review flashcards in the Spaced Repetition plugin")
      .setDesc(
        (this.plugin.srAvailable() ? "Spaced Repetition is enabled in this vault. " : "Spaced Repetition is not enabled in this vault, so the built-in review is used. ") +
          "When on, each topic's question bank is kept as a flashcard note that Spaced Repetition schedules and reviews, alongside your other decks and on mobile. Off: this plugin's own review tab and schedule are used.",
      )
      .addToggle((t) =>
        t.setValue(s.useSpacedRepetition).onChange(async (v) => {
          s.useSpacedRepetition = v;
          await this.plugin.save();
          this.display();
        }),
      );
    num("New flashcards per day", "Built-in review only: unseen cards added to each day's review, per topic.", "newCardsPerDay", 0);
    this.schedulerSettings(containerEl);

    new Setting(containerEl).setName("Study policy").setHeading();
    new Setting(containerEl).setDesc("These weights decide which concept Adaptive mode and the home screen suggest next. They only rank suggestions. A level changes through marked answers and nothing else, whatever the weights are. 0 switches a component off.").addButton((b) =>
      b.setButtonText("Reset to defaults").onClick(async () => {
        s.weights = { ...DEFAULT_WEIGHTS };
        await this.plugin.save();
        this.display();
      }),
    );
    for (const key of Object.keys(WEIGHT_LABELS) as (keyof PolicyWeights)[]) {
      new Setting(containerEl)
        .setName(WEIGHT_LABELS[key][0])
        .setDesc(`${WEIGHT_LABELS[key][1]} Default ${DEFAULT_WEIGHTS[key]}.`)
        .addText((t) =>
          t.setValue(String(s.weights[key])).onChange(async (v) => {
            const n = Number(v);
            if (v.trim() === "" || !Number.isFinite(n) || n < 0 || n > 5) return;
            s.weights[key] = n;
            await this.plugin.save();
          }),
        );
    }

    new Setting(containerEl).setName("Maths").setHeading();
    const sympy = this.plugin.sympy;
    new Setting(containerEl)
      .setName("Compute and check maths with SymPy")
      .setDesc(
        "Runs SymPy, a computer algebra system, inside the plugin. Typed answers in quizzes, placement and review are compared by SymPy with no model call, so 1/2 is accepted for 0.5. In chats on mathematical topics the tutor hands its computations to SymPy and every result it states is checked; if SymPy disagrees, the reply is rewritten once before you see it. " +
          (sympy.hasBundle()
            ? "Python and SymPy are included with the plugin (its pyodide folder) and run offline: nothing is downloaded, and your maths is never sent anywhere. "
            : "The bundled copy was not found (the plugin's pyodide folder), so the first use downloads Python and SymPy (about 20 MB) from the jsDelivr CDN; your maths is never sent anywhere. Reinstall the whole release folder to run it offline. ") +
          `Status: ${sympy.status()}${sympy.status() === "ready" && sympy.source() ? `, ${sympy.source()}` : ""}.`,
      )
      .addToggle((t) =>
        t.setValue(s.mathCheck).onChange(async (v) => {
          s.mathCheck = v;
          await this.plugin.save();
          if (v) {
            sympy.reset();
            sympy.warm();
          } else sympy.dispose();
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("Loading…");
          sympy.reset();
          const t0 = Date.now();
          // SymPy integrates, then its own answer is differentiated back: both must work.
          const r = await sympy.check([
            { type: "compute", expr: "integrate(x*exp(x), x)", name: "r1" },
            { type: "derivative", f: "r1", var: "x", result: "x*exp(x)" },
          ]);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          if (r.length === 2 && r[0].ok && r[1].ok) new Notice(`SymPy works (${sympy.source()}). It integrated x·eˣ to ${r[0].value} and confirmed the result by differentiating it (${secs}s).`, 10000);
          else new Notice(`SymPy could not be used: ${sympy.status()}. Maths falls back to the model.`, 12000);
          this.display();
        }),
      );

    new Setting(containerEl).setName("Code").setHeading();
    new Setting(containerEl)
      .setName("Run Python answers")
      .setDesc("Answers to Python code questions are run against their tests inside the plugin, with the bundled Python (Pyodide) in a sandboxed worker: offline, with no access to your vault or files, and a time limit on every test.")
      .addToggle((t) =>
        t.setValue(s.pythonRunner).onChange(async (v) => {
          s.pythonRunner = v;
          await this.plugin.save();
        }),
      );
    new Setting(containerEl)
      .setName("Run C and C++ answers")
      .setDesc("Compiles C and C++ answers with a compiler on this computer (g++ or clang++) and runs them against their tests. Warning: the program runs as you with no sandbox, so it could change or delete your files. Leave this off unless you trust the code.")
      .addToggle((t) =>
        t.setValue(s.nativeRunner).onChange(async (v) => {
          s.nativeRunner = v;
          await this.plugin.save();
        }),
      );
    new Setting(containerEl)
      .setName("C and C++ compiler")
      .setDesc("The full path to g++, clang++, gcc or clang. Leave blank to use the first one on PATH.")
      .addText((t) =>
        t
          .setPlaceholder("Auto-detect")
          .setValue(s.compilerPath)
          .onChange(async (v) => {
            s.compilerPath = v.trim();
            await this.plugin.save();
          }),
      );
    new Setting(containerEl)
      .setName("Check the code runners")
      .setDesc(this.codeStatus || "Runs a tiny program in each runner and says what was found, and whether it works.")
      .addButton((b) =>
        b.setButtonText("Check").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("Checking…");
          const found = await this.plugin.codeRunner.check();
          this.codeStatus = found.join(" ");
          new Notice(found.join("\n"), 15000);
          this.display();
        }),
      );

    new Setting(containerEl).setName("Interactive activities").setHeading();
    new Setting(containerEl).setName("Semantic source recovery").setDesc(
      "Optional: when keyword search finds too little source evidence, ask the configured local Ollama model to select relevant saved passages, including paraphrases. At most 8 short candidates and 4 seconds; otherwise keyword search continues. No cloud fallback, downloads, grading or mastery changes.",
    ).addToggle(t => t.setValue(s.semanticRetrieval).onChange(async enabled => {
      s.semanticRetrieval = enabled;
      this.plugin.buildLocal();
      await this.plugin.save();
    }));
    new Setting(containerEl)
      .setName("Configure activities with a local model")
      .setDesc("When you ask for a diagram, simulation or game, or the tutor offers one and you open it, an existing module is configured from a short excerpt of your notes by a small model on this computer, through Ollama. Saved activities reopen with no model at all, and moving their controls never calls a model. Nothing here ever calls Claude, and a model that Ollama runs in the cloud is refused. Off: only saved activities open.")
      .addToggle((t) =>
        t.setValue(s.localActivities).onChange(async (v) => {
          s.localActivities = v;
          await this.plugin.save();
          this.plugin.buildLocal();
        }),
      );
    new Setting(containerEl)
      .setName("Local model")
      .setDesc(`An Ollama model tag. ${DEFAULT_LOCAL_MODEL} is the tested default; qwen3:1.7b is a smaller option to compare.`)
      .addText((t) =>
        t.setValue(s.localModel).onChange(async (v) => {
          s.localModel = v.trim() || DEFAULT_LOCAL_MODEL;
          await this.plugin.save();
          this.plugin.buildLocal();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          const client = new OllamaClient({ model: s.localModel, baseUrl: s.ollamaUrl });
          const st = await client.status();
          const where = st.ok && st.hasModel ? await locateLocal(client) : null;
          b.setDisabled(false);
          if (!st.ok) new Notice(`Ollama is not reachable: ${st.error || "no answer"}. Start Ollama, or switch local activities off.`, 12000);
          else if (!st.hasModel) new Notice(`Ollama ${st.version} is running, but ${s.localModel} is not installed. Run: ollama pull ${s.localModel}`, 12000);
          else if (where?.runs === "cloud") new Notice(`Ollama ${st.version} has ${s.localModel}, but ${where.detail}. Local activities and the local compile strategy refuse it; hybrid compilation labels it as cloud inference.`, 15000);
          else if (where?.runs === "unknown") new Notice(`Ollama ${st.version} has ${s.localModel}, but where it runs could not be confirmed: ${where.detail}.`, 12000);
          else new Notice(`Ollama ${st.version} is running with ${s.localModel}, on this computer.`, 8000);
        }),
      );

    new Setting(containerEl).setName("Token saving").setHeading();
    const toggle = (name: string, desc: string, key: "bankQuiz" | "codePlacement" | "smartRouting") =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key]).onChange(async (v) => {
          s[key] = v;
          await this.plugin.save();
        }),
      );
    toggle("Placement without the model", "When you start Adaptive or Master mode on a new topic, the plugin asks one question per subskill from the question bank and marks them itself to set your starting levels. Off: the tutor runs its own diagnostic, one model turn per question.", "codePlacement");
    toggle("Question bank first", "Practise mode, and unaided practice in Adaptive mode, ask bank questions and marks multiple-choice and exact answers itself, using no tokens. The model is called only for answers that need judgement, or once the bank runs out.", "bankQuiz");
    toggle("Smart model routing", "The plugin reads each message and picks the model: the utility model for short look-up questions to the expert, the chat model for everything else, and the chat model with extra thinking for proofs, derivations, code and answers containing maths. Anything doubtful goes to the stronger option.", "smartRouting");
    new Setting(containerEl)
      .setName("Effort for hard turns")
      .setDesc("Thinking effort when the router marks a turn as complex. Higher is more reliable on proofs and maths, and uses more output tokens.")
      .addDropdown((d) =>
        d
          .addOptions({ medium: "Medium", high: "High" })
          .setValue(s.hardEffort)
          .onChange(async (v) => {
            s.hardEffort = v;
            await this.plugin.save();
          }),
      );
    num("Chat part size (words)", "When a chat passes this size it is summarised, and the chat continues in a new file that starts from the summary. Smaller means cheaper turns.", "maxChatWords", 200);
    num("Topic card size (words)", "Cards above this size are sent as an outline plus the current subskill only.", "maxTopicWords", 300);
    num("Short input size (words)", "Above this size, compilation reads the specification or notes in batches.", "singlePassWords", 100);
    const main = MODEL_PROVIDERS[providerFor(s)];
    new Setting(containerEl).setName("Compile strategy").setDesc(
      `Main provider only: ${main} does every stage, passage selection included, and Ollama is not used. ` +
      `Hybrid (default): Ollama selects relevant passages from long notes and research pages, and ${main} plans, writes and audits the course. If Ollama is not running, text matching is used; if its reply fails the checks, that selection goes to ${main}, and the compile notice says so. ` +
      `Local only: Ollama does every stage and ${main} is never called for compilation. A stage the local model cannot do is left as a gap in the course's coverage, and a model that Ollama runs in the cloud is refused.`,
    ).addDropdown(d =>
      d.addOptions(COMPILE_STRATEGIES).setValue(compileStrategyFor(s)).onChange(async v => {
        s.compileStrategy = compileStrategyFor({ ...s, compileStrategy: v as CompileStrategy });
        this.plugin.buildLocal();
        await this.plugin.save();
      }));
    new Setting(containerEl).setName("Plan diagrams and simulations when compiling").setDesc(
      `With the main provider only strategy, ${main} plans each diagram or simulation the course marks as worth one (up to 8 per compile, one or two calls each), so it is ready when you study. Ollama is not used for this. Skipped under Hybrid and Local only.`,
    ).addToggle(t => t.setValue(s.compileBlueprints).onChange(async v => {
      s.compileBlueprints = v;
      await this.plugin.save();
    }));
    for (const [key, name, max] of [
      ["searches", "Research search attempts", 40], ["pages", "Research page requests", 80],
      ["largeSearches", "Large specification search ceiling", 40], ["largePages", "Large specification page ceiling", 80],
    ] as const satisfies [keyof ResearchLimits, string, number][]) {
      new Setting(containerEl).setName(name).setDesc(`Per compilation (1–${max}). Large specifications can expand to the ceiling when a gap remains.`).addText(t =>
        t.setValue(String(researchLimits(s.researchLimits)[key])).onChange(async v => {
          const value = Number(v);
          if (!Number.isInteger(value) || value < 1 || value > max) return;
          s.researchLimits = { ...s.researchLimits, [key]: value };
          await this.plugin.save();
        }));
    }
  }
}
