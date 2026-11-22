// Only the host's DOM conveniences. GraphScreen/GraphCanvas themselves are production code.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.createEl = function(this:HTMLElement, tag:string, o:Record<string,unknown>={}) {
  const e=document.createElement(tag);if(o.cls)e.className=String(o.cls);if(o.text!==undefined)e.textContent=String(o.text);
  for(const [k,v] of Object.entries((o.attr??{}) as Record<string,string>))e.setAttribute(k,v);
  if(o.type)e.setAttribute("type",String(o.type));if(o.value!==undefined)(e as HTMLInputElement).value=String(o.value);this.append(e);return e;
};
proto.createDiv=function(this:HTMLElement,o:Record<string,unknown>){return this.createEl("div",o);};
proto.createSpan=function(this:HTMLElement,o:Record<string,unknown>){return this.createEl("span",o);};
proto.empty=function(this:HTMLElement){this.replaceChildren();};proto.setText=function(this:HTMLElement,s:string){this.textContent=s;};
proto.addClass=function(this:HTMLElement,s:string){this.classList.add(s);};proto.removeClass=function(this:HTMLElement,s:string){this.classList.remove(s);};
proto.toggleClass=function(this:HTMLElement,s:string,on:boolean){this.classList.toggle(s,on);};proto.hasClass=function(this:HTMLElement,s:string){return this.classList.contains(s);};
export class Notice { constructor(s:string){console.info(s);} }
export class TFile {}
/** The graph never opens a dialog; this exists only because the shared UI helpers import it. */
export class Modal { constructor(public app:unknown){} open(){} close(){} }
export function setIcon(e:HTMLElement,s:string){e.textContent=({"zoom-in":"+","zoom-out":"−","maximize":"⛶","shuffle":"↻","x":"×","check":"✓"} as Record<string,string>)[s]??"◇";e.setAttribute("aria-hidden","true");}
export const addUsage=(a:unknown)=>a;
export class ModelCliError extends Error {}
export class ClaudeError extends Error {}
export const findClaude=()=>"";
export const findCodex=()=>"";
export const callClaude=async()=>{throw new Error("Model calls are disabled in browser fixtures");};
export const callCodex=callClaude;
export const zeroUsage=()=>({input:0,cacheRead:0,cacheWrite:0,output:0,costUsd:0,calls:0});
