import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type { PlayerHandle, PlayerOptions, PresentationRequest } from "./contracts";
import { validateLesson } from "./registry";
import { button, el } from "./dom";

/** No generator is called here. Backend gates pass already stored lesson data to this entry. */
export class ActivityModal extends Modal {
  private player:PlayerHandle|null=null;
  private closed=false;
  constructor(app:App,private lesson:unknown,private options:PlayerOptions){super(app);}
  async onOpen(){
    this.closed=false;this.modalEl.classList.add("stv-modal");
    const {mountPlayer}=await import("./player");
    if(this.closed)return;
    const player=await mountPlayer(this.contentEl,this.lesson,this.options);
    if(this.closed)player.destroy();else this.player=player;
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
