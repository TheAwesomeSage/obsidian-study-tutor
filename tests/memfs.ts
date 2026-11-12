import type { FS } from "../src/store";

/** An in-memory stand-in for Obsidian's vault adapter. */
export class MemFS implements FS {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
  async write(path: string, data: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.dirs.has(parent)) throw new Error(`ENOENT parent of ${path}`);
    this.files.set(path, data);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const direct = (p: string) => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/");
    return { files: [...this.files.keys()].filter(direct), folders: [...this.dirs].filter(direct) };
  }
}
