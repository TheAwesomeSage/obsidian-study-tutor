import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { ClaudeError, callClaude, findClaude, usageLine } from "./claude";
import { CompileResult, Engine, EngineSettings, Material } from "./engine";
import { Frontmatter, SourceMode, fmList, fmStr, splitFrontmatter, words } from "./formats";
import { FS, Store } from "./store";
import { TutorView, VIEW_TYPE } from "./view";

export interface TutorSettings extends EngineSettings {
  root: string;
  newCardsPerDay: number;
  /** Quiz mode asks from the question bank and marks with plain code before using the model. */
  bankQuiz: boolean;
  /** Tutor mode places a new learner with bank questions marked by code, not model turns. */
  codePlacement: boolean;
}

interface PluginData {
  settings: TutorSettings;
  activeTopic: string;
  activeChat: Record<string, string>;
  /** Fingerprint of each skill file as this plugin last wrote it, to spot the user's edits. */
  skills: Record<string, string>;
  /** Bumped when a default changes, so the old default can be moved forward once. */
  settingsVersion: number;
}

const DEFAULTS: TutorSettings = {
  root: "Tutor",
  claudePath: "",
  chatModel: "sonnet",
  compileModel: "sonnet",
  utilityModel: "haiku",
  effort: "low",
  targetLevel: 4,
  maxChatWords: 600,
  maxTopicWords: 2000,
  singlePassWords: 6000,
  newCardsPerDay: 10,
  bankQuiz: true,
  codePlacement: true,
  smartRouting: true,
  hardEffort: "high",
};

export type SourceKind = "links" | "active" | "folder" | "spec" | "subject";

const MAX_NOTES = 80;
const MAX_WORDS = 60000;

export default class StudyTutorPlugin extends Plugin {
  data!: PluginData;
  store!: Store;
  engine!: Engine;

  get opts(): TutorSettings {
    return this.data.settings;
  }

  async onload(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.data = { settings: { ...DEFAULTS, ...(saved.settings ?? {}) }, activeTopic: saved.activeTopic ?? "", activeChat: saved.activeChat ?? {}, skills: saved.skills ?? {}, settingsVersion: saved.settingsVersion ?? 1 };
    if (this.data.settingsVersion < 2) {
      // 0.1 shipped with 1,200-word chat parts. Move anyone still on that default to 600.
      if (this.data.settings.maxChatWords === 1200) this.data.settings.maxChatWords = 600;
      this.data.settingsVersion = 2;
      if (saved.settings) await this.saveData(this.data);
    }
    this.buildStore();

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TutorView(leaf, this));
    this.addRibbonIcon("graduation-cap", "Open Study Tutor", () => void this.activateView());
    this.addCommand({ id: "open", name: "Open tutor", callback: () => void this.activateView() });
    this.addCommand({ id: "new-topic", name: "New topic", callback: () => this.openNewTopic() });
    this.addCommand({ id: "review", name: "Review due flashcards", callback: async () => (await this.activateView())?.showTab("review") });
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
    this.engine = new Engine(this.store, () => this.opts);
  }

  async save(): Promise<void> {
    await this.saveData(this.data);
  }

  async activateView(): Promise<TutorView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return null;
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof TutorView ? leaf.view : null;
  }

  openNewTopic(): void {
    new NewTopicModal(this.app, this).open();
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
      material.push({ name: f.basename, text });
      total += words(text);
    }
    if (!material.length) throw new Error("The source notes are empty.");
    const fm: Frontmatter = { kind, sources: material.map((m) => `[[${m.name}]]`) };
    if (kind === "folder") fm.folder = folder.replace(/^\/+|\/+$/g, "");
    return { mode, material, fm, truncated };
  }

  async compileTopic(p: { title: string; kind: SourceKind; folder: string; goal: string; research?: boolean; existingDir?: string; sources?: string[] }): Promise<CompileResult | null> {
    const notice = new Notice("Study Tutor: gathering notes…", 0);
    try {
      const g = await this.gather(p.kind, p.folder, p.sources);
      const res = await this.engine.compile({ title: p.title, mode: g.mode, goal: p.goal, material: g.material, fm: g.fm, existingDir: p.existingDir, research: p.research }, (msg) => notice.setMessage(`Study Tutor: ${msg}`));
      notice.hide();
      new Notice(`Topic ready: ${res.subskills} subskills, ${res.questions} questions.${g.truncated ? " Some notes were left out (size limit)." : ""}\n${usageLine(res.usage)} in ${res.usage.calls} call(s)`, 10000);
      this.data.activeTopic = res.dir;
      await this.save();
      const view = await this.activateView();
      await view?.reload();
      return res;
    } catch (e) {
      notice.hide();
      new Notice(`Study Tutor: ${(e as Error).message}`, 12000);
      return null;
    }
  }

  async recompile(dir: string): Promise<void> {
    const topic = await this.store.loadTopic(dir);
    const kind = (fmStr(topic.fm, "kind", "subject") as SourceKind) || "subject";
    await this.compileTopic({ title: topic.title, kind, folder: fmStr(topic.fm, "folder"), goal: fmStr(topic.fm, "goal"), research: fmStr(topic.fm, "research") === "yes", existingDir: dir, sources: fmList(topic.fm, "sources") });
  }
}

class NewTopicModal extends Modal {
  constructor(
    app: App,
    private plugin: StudyTutorPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    const active = this.app.workspace.getActiveFile();
    let title = active && active.extension === "md" ? active.basename : "";
    let kind: SourceKind = active ? "links" : "subject";
    let folder = active?.parent && active.parent.path !== "/" ? active.parent.path : "";
    let goal = "";
    // Web research is offered by default only when there are no notes to teach from.
    const noNotes = (k: SourceKind) => k === "spec" || k === "subject";
    let research = noNotes(kind);
    let researchToggle: { setValue(v: boolean): unknown } | null = null;
    this.titleEl.setText("New topic");
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
      .addText((t) => t.onChange((v) => (goal = v)));
    new Setting(contentEl)
      .setName("Research on the web")
      .setDesc("Lets the compile step search the web for what a course at this level covers, and cite its sources. Uses several times more tokens for that one step. Chat turns are unaffected.")
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
          void this.plugin.compileTopic({ title: title.trim(), kind, folder, goal, research });
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TutorSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: StudyTutorPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.opts;
    containerEl.empty();
    const text = (name: string, desc: string, key: "root" | "claudePath" | "chatModel" | "compileModel" | "utilityModel", placeholder = "", after?: () => void) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t
          .setPlaceholder(placeholder)
          .setValue(s[key])
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
    const detected = findClaude(s.claudePath);
    text("Claude CLI path", detected ? `Using: ${detected}` : "Not found. Install Claude Code or enter the full path to the claude binary.", "claudePath", "auto-detect").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        const p = findClaude(s.claudePath);
        if (!p) {
          new Notice("Claude CLI not found.");
          return;
        }
        b.setDisabled(true);
        try {
          const r = await callClaude({ claudePath: p, model: s.utilityModel, system: "Reply with exactly: OK", input: "Test.", timeoutMs: 60000 });
          new Notice(`Claude replied "${r.text.trim().slice(0, 40)}".\nOverhead for this call: ${usageLine(r.usage)}`, 10000);
        } catch (e) {
          new Notice(`Test failed: ${e instanceof ClaudeError ? e.message : String(e)}`, 12000);
        }
        b.setDisabled(false);
      }),
    );

    new Setting(containerEl).setName("Models").setHeading();
    text("Chat model", "Used for tutor, quiz and expert turns. An alias (sonnet, opus, haiku, fable) or a full model name.", "chatModel", "sonnet");
    text("Compile model", "Used once per topic to build the topic card and question bank.", "compileModel", "sonnet");
    text("Utility model", "Cheap model for reading large note sets, summarising chats and grading flashcards.", "utilityModel", "haiku");
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
    num("New flashcards per day", "Unseen cards added to each day's review, per topic.", "newCardsPerDay", 0);

    new Setting(containerEl).setName("Token saving").setHeading();
    const toggle = (name: string, desc: string, key: "bankQuiz" | "codePlacement" | "smartRouting") =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key]).onChange(async (v) => {
          s[key] = v;
          await this.plugin.save();
        }),
      );
    toggle("Placement without the model", "When you start the tutor on a new topic, the plugin asks one question per subskill from the question bank and marks them itself to set your starting levels. Off: the tutor runs its own diagnostic, one model turn per question.", "codePlacement");
    toggle("Quiz from the question bank first", "Quiz mode asks bank questions and marks multiple-choice and exact answers itself, using no tokens. The model is called only for answers that need judgement, or once the bank runs out.", "bankQuiz");
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
    num("Single-pass compile size (words)", "Note sets above this size are first read in parallel batches by the utility model.", "singlePassWords", 1000);
  }
}
