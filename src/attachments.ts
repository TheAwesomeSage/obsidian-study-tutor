import { App, Modal } from "obsidian";
import type { Material } from "./engine";
import { splitFrontmatter } from "./formats";

export const ATTACHMENT_MAX_BYTES = 128 * 1024;
export const TEXT_ATTACHMENT = /\.(md|txt|py|c|cc|cpp|cxx|h|hpp|js|jsx|ts|tsx|json|csv|html|css|java|rs|go|sh|sql|yaml|yml)$/i;
/** Preserve indentation, newlines and code fences; refuse binary or oversized input rather than silently cutting it. */
export function attachmentMaterial(name: string, source: string): Material {
  if (!TEXT_ATTACHMENT.test(name)) throw new Error("Choose a note, text file or source-code file.");
  if (new TextEncoder().encode(source).length > ATTACHMENT_MAX_BYTES) throw new Error("Attachments can be up to 128 KB. Choose a smaller file; nothing was truncated.");
  if (source.includes("\0")) throw new Error("This appears to be a binary file. Choose text or source code.");
  const text = /\.md$/i.test(name) ? splitFrontmatter(source).body : source;
  if (!text.trim()) throw new Error("This file is empty.");
  return { name, text };
}

/** The paperclip always opens this picker, independent of the active editor. */
export function chooseAttachment(app: App, current?: Material): Promise<Material | null | undefined> {
  return new Promise(resolve => {
    let chosen: Material | null | undefined;
    const modal = new (class extends Modal {
      onOpen(): void {
        this.titleEl.setText("Attach a note or file");
        if (current) {
          const remove = this.contentEl.createEl("button", { text: `Remove ${current.name}` });
          remove.onclick = () => { chosen = null; this.close(); };
        }
        this.contentEl.createEl("p", { text: "Choose an Obsidian note or a text/code file. Its text will accompany your next message." });
        const status = this.contentEl.createDiv({ attr: { role: "status" } });
        const finish = (name: string, text: string) => {
          try { chosen = attachmentMaterial(name, text); this.close(); } catch (e) { status.setText((e as Error).message); }
        };
        const label = this.contentEl.createEl("label", { text: "File from this computer" });
        const file = label.createEl("input", { attr: { type: "file", accept: ".md,.txt,.py,.c,.cpp,.h,.hpp,.js,.ts,.json,.csv,.html,.css,.java,.rs,.go,.sql,.yaml,.yml" } });
        file.onchange = () => { const item = file.files?.[0]; if (!item) return; if (item.size > ATTACHMENT_MAX_BYTES) { status.setText("Choose a file up to 128 KB."); return; } void item.text().then(text => finish(item.name, text)).catch(() => status.setText("Could not read this file. Try choosing it again.")); };
        const search = this.contentEl.createEl("input", { attr: { type: "search", placeholder: "Search vault notes…", "aria-label": "Search vault notes" } });
        const list = this.contentEl.createDiv({ cls: "st-attachment-list" });
        const notes = app.vault.getMarkdownFiles().sort((a,b) => a.path.localeCompare(b.path));
        const render = () => {
          list.empty();
          const matches = notes.filter(n => n.path.toLowerCase().includes(search.value.toLowerCase()));
          if (!matches.length) list.createEl("p", { text: "No matching notes. You can choose a file above." });
          for (const note of matches.slice(0, 100)) {
            const b = list.createEl("button", { text: note.path });
            b.onclick = () => { b.disabled = true; void app.vault.cachedRead(note).then(text => finish(note.path, text)).catch(() => { status.setText("Could not read this note."); b.disabled = false; }); };
          }
        };
        search.oninput = render; render();
      }
      onClose(): void { resolve(chosen); }
    })(app);
    modal.open();
  });
}
