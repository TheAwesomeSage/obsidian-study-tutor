import type { AssessmentResponse, Json, JsonObject, PlayerEvent, PlayerHandle, PlayerOptions } from "./contracts";
import { assessLesson, validateLesson } from "./registry";
import { projectile, rangeBounds, hitsTarget, traceAlgorithm, type AlgorithmSettings, type PlotSettings, type ProjectileSettings } from "./models";
import { el, button, slider, svgEl } from "./dom";
import { ART } from "./art";
import { isSystemsModule } from "./systems-modules";
import { mountSystems, type AnswerSpec } from "./systems-view";

/** Stored JSON only. This module has no inference, vault, network or code evaluation interface. */
export async function mountPlayer(host: HTMLElement, value: unknown, options: PlayerOptions & {loadPlot?:()=>Promise<typeof import("./plot")>}): Promise<PlayerHandle> {
  const root = el(host, "section", "", "stv-player");
  const valid = validateLesson(value);
  if (!valid.valid) {
    el(root, "h2", "This activity cannot be played");
    el(root, "p", valid.errors.map(e => `${e.path}: ${e.message}`).join(" · "));
    return { destroy() { root.remove(); } };
  }
  const lesson = valid.lesson;
  let destroyed = false, playing = false, position = 0, lastTime = 0, frame = 0, predicted = false, hintsUsed = false, completed = false, inView = true;
  const emit = (event: PlayerEvent) => { if (!destroyed) options.onEvent?.(event); };
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const eyebrow = el(root, "div", "LOCAL ACTIVITY  /  " + lesson.moduleId.replace(/-/g, " ").toUpperCase(), "stv-eyebrow");
  eyebrow.setAttribute("aria-label", "Local activity, no inference during playback");
  el(root, "h2", lesson.objective);
  el(root, "p", options.reason || "Explore this representation to explain the current objective.", "stv-reason");
  const layout = el(root, "div", "", "stv-layout");
  const stage = el(layout, "div", "", "stv-stage");
  const side = el(layout, "div", "", "stv-side");
  el(side, "h3", "01 · Predict");
  const predictionLabel = el(side, "label", lesson.predictionQuestion, "stv-field");
  const prediction = el(predictionLabel, "textarea"); prediction.rows = 2; prediction.maxLength = 2000;
  prediction.setAttribute("aria-label", "Your prediction");
  const commit = button(side, "Save prediction", () => {
    if (!prediction.value.trim()) { prediction.focus(); return; }
    predicted = true; prediction.disabled = true; commit.disabled = true; emit({ version: 1, type: "prediction", text: prediction.value.trim() });
    controls.disabled = false; if (play) play.disabled = false; if (step) step.disabled = false;
    status.textContent = "Prediction saved. Explore, then explain what happened.";
  });
  el(side, "h3", "02 · Explore");
  const controls = el(side, "fieldset", "", "stv-controls"); controls.disabled = true;
  el(controls, "legend", "Model controls", "stv-sr-only");
  const toolbar = el(side, "div", "", "stv-toolbar");
  const status = el(side, "p", "Save a prediction to start.", "stv-status"); status.setAttribute("role", "status");
  const pause = () => { if (playing) emit({ version: 1, type: "pause", position }); playing = false; cancelAnimationFrame(frame); if (play) play.textContent = "Play"; };
  const settings = () => emit({ version: 1, type: "settings", settings: JSON.parse(JSON.stringify(lesson.settings)) });
  let render = () => {}, resetModule = () => {}, freeModule = () => {};
  let duration = 0, pace = 1;
  let play: HTMLButtonElement | null = null, step: HTMLButtonElement | null = null;
  let lockAttempt = () => {};
  let completedResponse = (): JsonObject => ({});
  let answerSpec: AnswerSpec | null = null;
  const finish = () => {
    pause();
    if (!completed) { completed = true; emit({ version: 1, type: "completed", response: completedResponse(), independentMastery: false }); }
    status.textContent = "Observation complete. Explain the result below; this is practice, not an independent mastery check.";
  };
  const advance = (amount: number) => { position = Math.min(duration, position + amount); render(); if (position >= duration) finish(); };
  const tick = (now: number) => {
    if (!playing || destroyed) return;
    if (document.hidden || !inView || !root.isConnected) { pause(); return; }
    const delta = Math.max(0, now - lastTime) / 1000; lastTime = now;
    advance(delta * pace);
    if (playing) frame = requestAnimationFrame(tick);
  };

  if (lesson.moduleId === "projectile") {
    const s = lesson.settings as unknown as ProjectileSettings, initial = structuredClone(s);
    const scene = el(stage,"div","","stv-scene"); scene.tabIndex=0;scene.setAttribute("role","region");scene.setAttribute("aria-label","Projectile diagram; scroll horizontally on narrow screens");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 800 450"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Projectile trajectory, velocity and acceleration components"); scene.append(svg);
    const telemetry = el(stage, "div", "", "stv-telemetry");
    const [lo, hi] = rangeBounds(s);
    // Fixed camera from the full permitted controls, never refitted during an attempt.
    const maxH = projectile({ speed: s.speedRange[1], angle: s.angleRange[1], gravity: s.gravity }).height;
    const worldW = Math.max(hi, s.target + s.tolerance) * 1.16, worldH = Math.max(maxH * 1.25, worldW / 3);
    const px = (x: number) => 50 + x / worldW * 700, py = (y: number) => 350 - y / worldH * 290;
    const velocityScale = Math.min(8, 65 / s.speedRange[1]), accelerationScale = Math.min(8, 65 / s.gravity);
    const speed = slider(controls, "Launch speed (m/s)", s.speedRange[0], s.speedRange[1], 0.01, s.speed, n => { s.speed = n; duration = projectile(s).flight; render(); settings(); });
    const angle = slider(controls, "Launch angle (°)", s.angleRange[0], s.angleRange[1], 0.01, s.angle, n => { s.angle = n; duration = projectile(s).flight; render(); settings(); });
    el(stage, "p", `No drag · constant g = ${s.gravity} m/s² · equal landing height. Reachable range ${lo.toFixed(2)}–${hi.toFixed(2)} m.`, "stv-caption");
    el(stage, "p", `Arrow scales: velocity ${velocityScale.toFixed(2)} drawing units per m/s; acceleration ${accelerationScale.toFixed(2)} drawing units per m/s².`, "stv-caption");
    const arrow = (x: number, y: number, dx: number, dy: number, color: string, name: string) => {
      svgEl(svg, "line", { x1:x, y1:y, x2:x+dx, y2:y+dy, stroke:color, "stroke-width":2.5 });
      if (Math.hypot(dx,dy) > 1) {
        const a = Math.atan2(dy,dx), q = 7;
        svgEl(svg, "path", { d:`M${x+dx-q*Math.cos(a-0.5)},${y+dy-q*Math.sin(a-0.5)} L${x+dx},${y+dy} L${x+dx-q*Math.cos(a+0.5)},${y+dy-q*Math.sin(a+0.5)}`, fill:"none", stroke:color, "stroke-width":2.5 });
      }
      svgEl(svg, "text", { x:x+dx+6, y:y+dy-6, fill:color, "font-size":13 }, name);
    };
    render = () => {
      const p = projectile(s, position); svg.replaceChildren();
      for (let i=0;i<=5;i++) {
        const x = worldW*i/5; svgEl(svg,"line",{x1:px(x),y1:45,x2:px(x),y2:350,stroke:"var(--stv-line)","stroke-dasharray":"3 6"});
        svgEl(svg,"text",{x:px(x),y:375,"text-anchor":"middle",fill:"var(--stv-muted)","font-size":12}, x.toFixed(1));
        const y = worldH*i/5; svgEl(svg,"text",{x:42,y:py(y)+4,"text-anchor":"end",fill:"var(--stv-muted)","font-size":12},y.toFixed(1));
      }
      svgEl(svg,"line",{x1:50,y1:350,x2:760,y2:350,stroke:"var(--stv-muted)","stroke-width":2});
      svgEl(svg,"text",{x:400,y:438,fill:"var(--stv-muted)","text-anchor":"middle"},"Horizontal distance (m)");
      svgEl(svg,"text",{x:50,y:24,fill:"var(--stv-muted)","font-size":13},"Height (m)");
      svgEl(svg,"rect",{x:px(s.target-s.tolerance),y:344,width:Math.max(2,px(s.target+s.tolerance)-px(s.target-s.tolerance)),height:12,rx:3,fill:"#d78a34"});
      if(lesson.assetIds.includes("kenney.physics.flag-blue"))svgEl(svg,"image",{href:ART["kenney.physics.flag-blue"],x:px(s.target),y:308,width:38,height:38,"aria-hidden":"true"});
      svgEl(svg,"text",{x:Math.min(700,px(s.target)),y:298,fill:"var(--stv-text)","text-anchor":"middle","font-size":13},`Target ${s.target.toFixed(2)} ± ${s.tolerance} m`);
      const points = Array.from({length:81},(_,i)=>{const q=projectile(s,p.t*i/80); return `${px(q.x)},${py(q.y)}`;}).join(" ");
      svgEl(svg,"polyline",{points,fill:"none",stroke:"#397bbd","stroke-width":3});
      const x=px(p.x), y=py(p.y);
      arrow(x,y,p.vx*velocityScale,0,"#397bbd","vx"); arrow(x,y,0,-p.vy*velocityScale,"#27917d","vy"); arrow(x+7,y,0,s.gravity*accelerationScale,"#b55ac7","g");
      svgEl(svg,"circle",{cx:x,cy:y,r:7,fill:"#397bbd",stroke:"var(--stv-surface)","stroke-width":2});
      telemetry.replaceChildren();
      for (const [label,val] of [["Time",`${p.t.toFixed(3)} s`],["Position",`${p.x.toFixed(2)}, ${p.y.toFixed(2)} m`],["Velocity vx / vy",`${p.vx.toFixed(2)} / ${p.vy.toFixed(2)} m/s`],["Acceleration ax / ay",`0 / ${-s.gravity} m/s²`]]) { const cell=el(telemetry,"div");el(cell,"span",label);el(cell,"strong",val); }
      if (position >= duration) el(telemetry,"strong",hitsTarget(s) ? "Target reached. Explain your reasoning." : "Target missed. Compare your prediction with the range.","stv-result");
    };
    lockAttempt = () => { speed.input.disabled = angle.input.disabled = true; };
    resetModule = () => { Object.assign(s,structuredClone(initial)); speed.set(s.speed);angle.set(s.angle);speed.input.disabled=angle.input.disabled=false;duration=projectile(s).flight; };
    completedResponse = () => ({ hit:hitsTarget(s), range:projectile(s).range, settings:JSON.parse(JSON.stringify(s)) });
    duration=projectile(s).flight;
  } else if (lesson.moduleId === "algorithm") {
    const s=lesson.settings as unknown as AlgorithmSettings, trace=traceAlgorithm(s);
    const title=el(stage,"p",s.algorithm.replace(/-/g," "),"stv-equation");
    const array=el(stage,"div","","stv-array"); array.setAttribute("aria-label","Array with zero-based indices");
    const detail=el(stage,"p","","stv-trace-line"); detail.setAttribute("aria-live","polite");
    const log=el(stage,"ol","","stv-trace");
    el(stage,"p","Abstract numeric array · zero-based indices. The display follows actual reads, comparisons and writes; it does not claim a particular language memory layout.","stv-caption");
    el(controls,"p",s.algorithm.includes("search")?`Search target: ${s.target}`:s.algorithm==="index"?`Read index ${s.index}`:"Sort in ascending order");
    duration=trace.length; pace=2;
    render=()=>{
      const count=Math.floor(position), event=trace[count-1], values=event?.values??s.values;
      title.textContent=`${s.algorithm.replace(/-/g," ")} · event ${count} / ${trace.length}`;
      array.replaceChildren();values.forEach((v,i)=>{const cell=el(array,"div","",`stv-cell ${event?.indices.includes(i)?"is-active":""}`);el(cell,"strong",String(v));el(cell,"span",`[${i}]`);});
      detail.textContent=event?`${event.type.toUpperCase()} · ${event.detail}${event.result!==undefined?` · result ${JSON.stringify(event.result)}`:""}`:"Ready. Predict the result before following the trace.";
      log.replaceChildren();trace.slice(Math.max(0,count-5),count).forEach(e=>el(log,"li",`${e.type}: ${e.detail}`));
    };
    completedResponse=()=>({result:trace[trace.length-1].result as Json, events:trace.length});
  } else if (isSystemsModule(lesson.moduleId)) {
    const view = mountSystems(stage, controls, lesson, { step: () => step?.click(), settings: () => { duration = view.steps; settings(); } });
    duration = view.steps; pace = 1;
    // The race's lock changes how many steps there are, so the length is read again on every frame.
    render = () => { duration = view.steps; view.render(Math.min(duration, Math.floor(position))); };
    resetModule = view.reset; lockAttempt = view.lock; completedResponse = view.response; answerSpec = view.answer;
  } else if (lesson.moduleId === "function-plotter") {
    try { const {mountPlot}=await (options.loadPlot ? options.loadPlot() : import("./plot")); const plot=mountPlot(stage,controls,lesson.settings as unknown as PlotSettings,settings); resetModule=plot.reset;freeModule=plot.destroy; }
    catch (error) { el(stage,"p",`Plot could not load: ${(error as Error).message}`); }
  } else {
    const s=lesson.settings;
    el(stage,"div","EXTERNAL EXPLORATION","stv-eyebrow"); el(stage,"h3",String(s.simulation).replace(/-/g," "));
    const link=el(stage,"a","Open PhET activity ↗","stv-button");link.href=`https://phet.colorado.edu/en/simulations/${s.simulation}`;link.target="_blank";link.rel="noopener noreferrer";
    el(stage,"p","Opens the official activity. Study Tutor cannot observe its controls or results. Return here to explain using the source excerpt.","stv-caption");
  }
  if (duration) {
    play=button(toolbar,"Play",()=>{
      if (!predicted) return;
      if (playing) {pause();return;}
      if (completed) {status.textContent="Reset to make a new attempt.";return;}
      lockAttempt();
      if (reduced?.matches) { advance(lesson.moduleId==="projectile"?duration/20:1);emit({version:1,type:"step",position});return; }
      playing=true;play!.textContent="Pause";lastTime=performance.now();emit({version:1,type:"play",position});frame=requestAnimationFrame(tick);
    }); play.disabled=true;
    step=button(toolbar,"Step",()=>{ if (!predicted || completed) return;pause();lockAttempt();advance(lesson.moduleId==="projectile"?duration/20:1);emit({version:1,type:"step",position}); });step.disabled=true;
    if(reduced?.matches) el(side,"p","Reduced motion: Play advances one step. No automatic animation.","stv-caption");
  }
  button(toolbar,"Reset",()=>{pause();position=0;completed=false;predicted=false;prediction.disabled=false;prediction.value="";commit.disabled=false;controls.disabled=true;if(play)play.disabled=true;if(step)step.disabled=true;resetModule();render();status.textContent="Save a fresh prediction to try again.";emit({version:1,type:"reset",position});});
  button(side,"Show hint",()=>{hintsUsed=true;status.textContent=lesson.hint;emit({version:1,type:"hint"});});
  const reflection=el(root,"section","","stv-reflection");el(reflection,"h3","03 · Explain & check");
  const explainLabel=el(reflection,"label","Why did that happen? Use the source and the model.","stv-field");const explanation=el(explainLabel,"textarea");explanation.rows=2;explanation.maxLength=2000;
  const answerLabel=el(reflection,"label",answerSpec?answerSpec.label:lesson.moduleId==="function-plotter"?"Slope at the current point (number, or null when undefined)":lesson.moduleId==="projectile"?"Predicted range for the current launch settings (metres)":lesson.moduleId==="algorithm"?"Result (number, or sorted array as [1,2,3])":"Your source-based conclusion","stv-field");
  let answer:HTMLInputElement|HTMLSelectElement;
  if(answerSpec?.choices){const select=el(answerLabel,"select");el(select,"option","Choose…").value="";for(const c of answerSpec.choices)el(select,"option",c).value=c;answer=select;}
  else{const input=el(answerLabel,"input");input.type="text";input.maxLength=1000;answer=input;}
  const feedback=el(reflection,"p","","stv-status");feedback.setAttribute("role","status");
  button(reflection,"Check practice answer",()=>{
    if(!predicted){feedback.textContent="Save a prediction before checking.";return;}
    if(!explanation.value.trim()){feedback.textContent="Explain your reasoning before checking.";explanation.focus();return;}
    let parsed:Json;
    if(answerSpec){const read=answerSpec.parse(answer.value);if(read===undefined){feedback.textContent=answerSpec.help;answer.focus();return;}parsed=read;}
    else try{parsed=lesson.moduleId==="phet-external"?answer.value:JSON.parse(answer.value);}catch{feedback.textContent="Use a number, null, or a JSON array of numbers.";return;}
    const response:AssessmentResponse={answer:parsed,explanation:explanation.value.trim(),prediction:prediction.value,hintsUsed,settings:JSON.parse(JSON.stringify(lesson.settings))};
    const result=assessLesson(lesson,response);feedback.textContent=result.feedback;emit({version:1,type:"assessment",response,result});
  });
  const sources=el(root,"details","","stv-sources");el(sources,"summary","Source evidence & activity details");
  for(const source of lesson.sourceRefs){el(sources,"strong",source.path);el(sources,"blockquote",source.excerpt);el(sources,"code",`SHA-256 ${source.contentHash}`);}
  el(sources,"p",`${lesson.moduleId} ${lesson.moduleVersion} · schema ${lesson.schemaVersion} · assessment ${lesson.assessmentId}`);
  const visibility=()=>{if(document.hidden)pause();};document.addEventListener("visibilitychange",visibility);
  const motion=()=>{if(reduced?.matches)pause();};reduced?.addEventListener?.("change",motion);
  const observer=typeof IntersectionObserver!=="undefined"?new IntersectionObserver(entries=>{inView=entries[0]?.isIntersecting??true;if(!inView)pause();}):null;observer?.observe(root);
  render();emit({version:1,type:"opened",moduleId:lesson.moduleId,reason:options.reason});
  return {destroy(){pause();destroyed=true;observer?.disconnect();document.removeEventListener("visibilitychange",visibility);reduced?.removeEventListener?.("change",motion);freeModule();root.remove();}};
}
