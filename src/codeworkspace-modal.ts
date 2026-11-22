import { Modal } from "obsidian";
import { addUsage } from "./claude";
import { planCodeWalkthrough } from "./codewalkthrough";
import { mountCodeWorkspace } from "./codeworkspace";
import type { CodeLanguage } from "./codetask";
import type { TutorView } from "./view";

export class CodeWorkspaceModal extends Modal {
  private workspace?: { dispose(): void };
  constructor(private view: TutorView, private source: string, private language: CodeLanguage) { super(view.app); }
  onOpen(): void {
    this.titleEl.setText("Code walkthrough");
    this.modalEl.addClass("st-code-modal");
    this.workspace = mountCodeWorkspace(this.contentEl, {
      source: this.source, language: this.language, runner: this.view.plugin.codeRunner,
      plan: async (source, language, stdin, onSpawn) => {
        const result = await planCodeWalkthrough(this.view.plugin.engine, source, language, stdin, onSpawn);
        this.view.sessionUsage = addUsage(this.view.sessionUsage, result.usage);
        return result.plan;
      },
      onHelp: async () => {
        const v = this.view;
        if (v.dir && v.chatPath && v.state && !v.free) await v.plugin.engine.noteActivityHelp(v.chatPath, v.state, "code walkthrough");
      },
    });
  }
  onClose(): void { this.workspace?.dispose(); }
}
