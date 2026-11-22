import type { CodeLanguage, CodeRunReport, CodeRunner, CodeTraceStep } from "./codetask";
import type { CodeWalkthrough } from "./codewalkthrough";
import { ART } from "./visuals/art";

export interface CodeWorkspaceOptions {
  source: string; language: CodeLanguage; runner?: CodeRunner;
  plan(source: string, language: CodeLanguage, stdin: string, onSpawn: (kill: () => void) => void): Promise<CodeWalkthrough>;
  onHelp?(): Promise<void>;
}
/** No generated HTML or executable renderer: all model output is inserted as text. */
export function mountCodeWorkspace(host: HTMLElement, options: CodeWorkspaceOptions): { dispose(): void } {
  const doc = host.ownerDocument;
  host.classList.add("st-code-workspace");
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text = "", cls = ""): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); node.textContent = text; node.className = cls; parent.append(node); return node;
  };
  // Fixed approved library IDs only: no model-supplied image URLs or asset-generation call.
  const asset = (parent: HTMLElement, id: string) => {
    const image = el("img", parent, "", "st-code-asset");
    image.src = ART[id]; image.alt = ""; image.setAttribute("aria-hidden", "true"); image.dataset.assetId = id;
  };
  const tools = el("div", host, "", "st-code-tools");
  const language = el("select", tools); language.setAttribute("aria-label", "Program language");
  for (const [value, name] of [["python", "Python"], ["cpp", "C++"], ["c", "C"]]) { const option = el("option", language, name); option.value = value; }
  language.value = options.language;
  const planButton = el("button", tools, "Build walkthrough");
  const runButton = el("button", tools, "Run program");
  const stop = el("button", tools, "Stop"); stop.hidden = true;
  const runState = el("span", tools, "", "st-code-run-state"); runState.hidden = true;
  runState.title = "Execution completed. This does not verify correctness.";
  el("p", host, "Build once for a narrated trace and flow diagram. Run to see actual output; Python also records real line-by-line state. Stepping, replay and diagrams use no model tokens.", "st-code-intro");
  const editor = el("details", host); editor.open = true; el("summary", editor, "Program source and input");
  const source = el("textarea", editor, options.source, "st-code-source"); source.value = options.source; source.spellcheck = false; source.setAttribute("aria-label", "Program source");
  const inputLabel = el("label", editor, "Console input (stdin)");
  const stdin = el("textarea", inputLabel, "", "st-code-stdin"); stdin.rows = 2;
  const status = el("div", host, "", "st-code-status"); status.setAttribute("role", "status");
  const consoleBox = el("details", host); consoleBox.open = true; el("summary", consoleBox, "Actual console output");
  const consoleText = el("pre", consoleBox, "Not run yet.");
  const teaching = el("div", host);
  let plan: CodeWalkthrough | null = null, actual: CodeTraceStep[] = [], selected = 0, useActual = false;
  let abort: AbortController | undefined, kill: (() => void) | undefined, revision = 0, busy = false, disposed = false, stopped = false;
  const setBusy = (value: boolean) => { busy = value; planButton.disabled = runButton.disabled = value; source.disabled = stdin.disabled = language.disabled = value; stop.hidden = !value; };
  const steps = () => useActual ? actual : plan?.steps ?? [];
  const render = () => {
    teaching.replaceChildren();
    if (plan) {
      el("h3", teaching, plan.title); el("p", teaching, plan.overview);
      const compile = el("details", teaching); el("summary", compile, "Program structure and compilation");
      const list = el("ol", compile); for (const phase of plan.compilation) el("li", list, phase);
      if (plan.limitations) el("p", teaching, plan.limitations, "st-code-limitations");
    }
    if (!steps().length) return;
    const controls = el("div", teaching, "", "st-code-tools");
    const back = el("button", controls, "Previous"); back.disabled = selected === 0;
    const next = el("button", controls, "Next"); next.disabled = selected >= steps().length - 1;
    const reset = el("button", controls, "Restart");
    back.dataset.step = "back"; next.dataset.step = "next"; reset.dataset.step = "reset";
    const move = (index: number, focus: string) => { selected = index; render(); const target=teaching.querySelector<HTMLButtonElement>(`[data-step=${focus}]:not(:disabled)`); (target ?? teaching.querySelector<HTMLButtonElement>("[data-step]:not(:disabled)"))?.focus(); };
    back.onclick = () => move(Math.max(0, selected - 1), "back");
    next.onclick = () => move(Math.min(steps().length - 1, selected + 1), "next");
    reset.onclick = () => move(0, "reset");
    if (actual.length && plan) {
      const toggle = el("button", controls, useActual ? "Show narrated trace" : "Show observed Python trace");
      toggle.onclick = () => { useActual = !useActual; selected = 0; render(); };
    }
    const step = steps()[selected];
    const position = el("span", controls, "", "st-code-position");
    asset(position, "kenney.physics.flag-blue");
    el("span", position, `${selected + 1} / ${steps().length} · ${useActual ? "Observed execution" : "Model-planned illustration"}`);
    const layout = el("div", teaching, "", "st-code-layout");
    const code = el("ol", layout, "", "st-code-lines");
    for (const [i, line] of source.value.split(/\r?\n/).entries()) {
      const row = el("li", code, "", i + 1 === step.line ? "is-current" : "");
      el("code", row, line || " ");
      if (i + 1 === step.line) row.setAttribute("aria-current", "step");
    }
    const detail = el("section", layout);
    if (useActual) {
      const observed = actual[selected];
      el("h4", detail, `${observed.event === "line" ? "Before" : observed.event} line ${step.line} · ${observed.function}`);
      const explanation = plan?.steps.find(s => s.line === step.line)?.explanation;
      if (explanation) el("p", detail, explanation);
    } else el("p", detail, plan!.steps[selected].explanation);
    const table = el("table", detail); const head = el("tr", el("thead", table)); el("th", head, "Variable"); el("th", head, "Value");
    const body = el("tbody", table); for (const variable of step.variables) { const row = el("tr", body); el("th", row, variable.name); el("td", row, variable.value); }
    el("h4", detail, useActual ? "Observed output so far" : "Illustrated output so far"); el("pre", detail, step.output || "(no output yet)");
    const trace = el("details", teaching); el("summary", trace, "Trace table");
    const traceTable = el("table", trace), traceHead = el("tr", el("thead", traceTable));
    for (const name of ["Step", "Line", "State", "Output"]) el("th", traceHead, name);
    const traceBody = el("tbody", traceTable);
    steps().slice(0, selected + 1).forEach((s, i) => { const row = el("tr", traceBody); el("td", row, String(i + 1)); el("td", row, String(s.line)); el("td", row, s.variables.map(v => `${v.name} = ${v.value}`).join("; ")); el("td", row, s.output); });
    if (plan) {
      const flow = el("details", teaching); flow.open = true; el("summary", flow, "Control-flow diagram · select a block to jump");
      const diagram = el("div", flow, "", "st-code-flow");
      const ns = "http://www.w3.org/2000/svg", svg = doc.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `0 0 440 ${plan.blocks.length * 70 + 10}`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Program blocks with directed control-flow arrows");
      const positions = new Map(plan.blocks.map((b, i) => [b.id, i * 70 + 5]));
      for (const block of plan.blocks) {
        const y = positions.get(block.id)!;
        for (const target of block.next) {
          const end = positions.get(target)!;
          const path = doc.createElementNS(ns, "path");
          path.setAttribute("d", end > y ? `M 210 ${y + 42} C 410 ${y + 42},410 ${end-6},210 ${end-6}` : `M 20 ${y + 20} C 0 ${y + 20},0 ${end + 20},14 ${end + 20}`);
          path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5"); svg.append(path);
          const arrow = doc.createElementNS(ns, "path"); arrow.setAttribute("d", end > y ? `M 216 ${end-10} L 210 ${end-4} L 204 ${end-10} Z` : `M 10 ${end+16} L 16 ${end+20} L 10 ${end+24} Z`); arrow.setAttribute("fill", "currentColor"); svg.append(arrow);
        }
        const group = doc.createElementNS(ns, "g"); group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("aria-label", `${block.label}, line ${block.line}`);
        const box = doc.createElementNS(ns, "rect"); box.setAttribute("x", "20"); box.setAttribute("y", String(y)); box.setAttribute("width", "300"); box.setAttribute("height", "42"); box.setAttribute("rx", "6"); box.setAttribute("class", block.line === step.line ? "is-current" : "");
        const label = doc.createElementNS(ns, "text"); label.setAttribute("x", "30"); label.setAttribute("y", String(y+26)); label.textContent = `${block.line}: ${block.label.slice(0, 40)}`;
        const jump = () => { const index = steps().findIndex(s => s.line === block.line); if (index >= 0) { selected = index; render(); } };
        group.onclick = jump; group.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } }; group.append(box, label); svg.append(group);
      }
      diagram.append(svg);
    }
  };
  const changed = () => { revision++; plan = null; actual = []; selected = 0; runState.hidden = true; consoleText.textContent = "Source or input changed. Run again for current output."; render(); };
  source.oninput = stdin.oninput = language.onchange = changed;
  stop.onclick = () => { stopped = true; abort?.abort(); kill?.(); };
  planButton.onclick = async () => {
    if (busy) return; stopped = false; setBusy(true); const stamp = revision; status.textContent = "Planning the walkthrough once…";
    try { await options.onHelp?.(); if (disposed || stopped) throw new Error("Stopped."); const got = await options.plan(source.value, language.value as CodeLanguage, stdin.value, fn => { kill = fn; if (disposed || stopped) fn(); }); if (disposed || stopped || stamp !== revision) return; plan = got; selected = 0; useActual = false; editor.open = false; status.textContent = "Walkthrough ready. Stepping and replay use no tokens. Model-planned state is illustrative; Run program checks execution separately."; render(); }
    catch (e) { if (!disposed) status.textContent = (e as Error).message; }
    finally { kill = undefined; setBusy(false); }
  };
  runButton.onclick = async () => {
    if (busy) return; if (!options.runner) { status.textContent = "No code runner is installed."; return; }
    stopped = false; setBusy(true); runState.hidden = true; abort = new AbortController(); status.textContent = "Running your program…";
    try {
      await options.onHelp?.();
      if (disposed || stopped) throw new Error("Stopped.");
      const report: CodeRunReport = await options.runner.run({language: language.value as CodeLanguage, inspect: true, tests:[{name:"Console run (not marked)",stdin:stdin.value,expected:""}]}, source.value, abort.signal);
      if (disposed) return;
      const result = report.tests[0]; actual = result?.trace ?? []; useActual = actual.length > 0; selected = 0;
      if (report.status === "ran" && result && ["pass", "fail"].includes(result.status)) {
        runState.replaceChildren(); asset(runState, "kenney.ui.checkmark-blue"); el("span", runState, "Executed"); runState.hidden = false;
      }
      if (report.status === "ran") editor.open = false;
      consoleText.textContent = [report.message, result?.stdout, result && ["error","timeout"].includes(result.status) ? result.detail : ""].filter(x => x !== undefined && x !== "").join("\n") || "(no output)";
      status.textContent = `${report.backend || report.status}. ${report.limits}${actual.length ? ` Observed Python trace: ${actual.length} events, capped at 120. Line events show state before execution.` : language.value !== "python" && report.status === "ran" ? " C/C++ output is real; its narrated line trace is model-planned, not a debugger recording." : ""}`;
      if (plan && result?.stdout !== undefined && !["error","timeout"].includes(result.status) && plan.steps[plan.steps.length - 1].output.trim() !== result.stdout.trim()) status.textContent += " Actual output differs from the model's illustrated output; trust the actual run.";
      render();
    } catch (e) { if (!disposed) status.textContent = (e as Error).message; }
    finally { abort = undefined; setBusy(false); }
  };
  return { dispose() { disposed = true; revision++; abort?.abort(); kill?.(); } };
}
