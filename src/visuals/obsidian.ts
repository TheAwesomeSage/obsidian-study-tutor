import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type { PlayerHandle, PlayerOptions, PresentationRequest } from "./contracts";
import { validateLesson } from "./registry";
import { button, el } from "./dom";
import { join } from "path";
import type { mountPlayer } from "./player";
import type { mountPlot } from "./plot";

const runtimes = new WeakMap<App, string>();
export function configureVisualRuntime(app: App, directory: string): void { runtimes.set(app, directory); }

/** No generator is called here. Backend gates pass already stored lesson data to this entry. */
export class ActivityModal extends Modal {
  private player:PlayerHandle|null=null;
  private closed=false;
  constructor(app:App,private lesson:unknown,private options:PlayerOptions){super(app);}
  async onOpen(){
    this.closed=false;this.modalEl.classList.add("stv-modal");
    try {
      const directory = runtimes.get(this.app);
      // Node resolves explicit trusted build files. Native dynamic imports have no reliable
      // base URL inside Obsidian's plugin evaluator. Browser previews use the ordinary ESM path.
      const module: {mountPlayer:typeof mountPlayer} = directory ? require(join(directory,"player.js")) : await import("./player");
      if(this.closed)return;
      const player=await module.mountPlayer(this.contentEl,this.lesson,{...this.options, ...(directory ? {loadPlot:async()=>require(join(directory,"plot.js")) as {mountPlot:typeof mountPlot}} : {})});
      if(this.closed)player.destroy();else this.player=player;
    } catch(error) { el(this.contentEl,"p",`The activity could not load. Reinstall the complete release folder. ${(error as Error).message}`); }
  }
  onClose(){this.closed=true;this.player?.destroy();this.player=null;}
}
export function presentActivity(app:App,lesson:unknown,request:PresentationRequest,options:Pick<PlayerOptions,"onEvent">={}){
  const result=validateLesson(lesson);
  if(!result.valid){new Notice(`Activity rejected: ${result.errors.map(e=>`${e.path}: ${e.message}`).join("; ")}`);return;}
  new ActivityModal(app,result.lesson,{reason:request.reason,...options}).open();
}
/** Explicit saved-file entry for independently authored lessons and offline inspection. */
export class SavedActivityModal extends Modal {
  onOpen(){
    el(this.contentEl,"h2","Open a saved visual lesson");
    el(this.contentEl,"p","Paste stored lesson JSON. Playback validates it locally and makes no model calls.");
    const label=el(this.contentEl,"label","Saved lesson JSON");const input=el(label,"textarea","","stv-import");
    const error=el(this.contentEl,"p");error.setAttribute("role","status");
    button(this.contentEl,"Open activity",()=>{
      let value:unknown;try{value=JSON.parse(input.value);}catch{error.textContent="Enter valid JSON.";return;}
      const check=validateLesson(value);if(!check.valid){error.textContent=check.errors.map(e=>`${e.path}: ${e.message}`).join("; ");return;}
      this.close();new ActivityModal(this.app,check.lesson,{reason:"You explicitly requested this saved activity."}).open();
    });
  }
}
