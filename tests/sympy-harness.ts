// Runs the real SymPy worker in a browser against a labelled set of checks and prints the
// outcome into the page. Built by `npm run preview`; open tests/out/sympy.html through a local
// web server (a file:// page cannot start the worker). It downloads Pyodide and SymPy from the
// CDN the first time, exactly as the plugin does.

import { SympyWorker, checkReport, cleanClaims, plainMaths } from "../src/sympy";
import { CASES, CHAINS, PLAIN, UNSAFE } from "./sympy-cases";

async function main() {
  const log = document.getElementById("log")!;
  const say = (s: string) => (log.textContent += s + "\n");
  let failures = 0;

  for (const u of UNSAFE) if (cleanClaims([{ type: "equal", a: u, b: "1" }]).length) (failures++, say(`FAIL unsafe string accepted: ${u}`));
  say(`safety filter: ${UNSAFE.length} unsafe strings, all rejected: ${failures === 0}`);
  for (const [input, want] of PLAIN) {
    const got = plainMaths(input);
    if (got !== want) (failures++, say(`FAIL plainMaths(${input}) = ${got}, wanted ${want}`));
  }
  say(`plain-maths conversion: ${PLAIN.length} cases checked`);

  const cleaned = cleanClaims(CASES.map(([, c]) => c), 100);
  if (cleaned.length !== CASES.length) (failures++, say(`FAIL ${CASES.length - cleaned.length} labelled claims were rejected by the safety filter`));
  const sympy = new SympyWorker();
  const t0 = performance.now();
  const first = await sympy.check([{ type: "equal", a: "1", b: "1" }]);
  say(`load: ${((performance.now() - t0) / 1000).toFixed(1)}s, status ${sympy.status()}, first result ${JSON.stringify(first)}`);
  if (!first.length) {
    say("RESULT: SymPy did not load");
    document.title = "SYMPY FAILED";
    return;
  }
  const t1 = performance.now();
  const results = await sympy.check(cleaned);
  say(`checks: ${cleaned.length} in ${((performance.now() - t1) / 1000).toFixed(1)}s`);
  CASES.forEach(([name, , want], i) => {
    const r = results[i];
    const ok = r && r.ok === want;
    if (!ok) failures++;
    say(`${ok ? "ok  " : "FAIL"} ${name}: ${r ? `${r.ok} (${r.detail})` : "no result"}${ok ? "" : `  wanted ${want}`}`);
  });
  for (const [name, batch, want] of CHAINS) {
    const got = await sympy.check(batch);
    const shown = got.map((r) => (r.ok ? r.value ?? r.detail : `${r.ok} (${r.detail})`));
    const ok = got.length === want.length && want.every((w, i) => (w === null ? got[i].ok === null : typeof w === "boolean" ? got[i].ok === w : got[i].ok === true && got[i].value === w));
    if (!ok) failures++;
    say(`${ok ? "ok  " : "FAIL"} chain, ${name}: ${shown.join(" | ")}`);
  }
  say("report (agree): " + checkReport(cleaned.slice(0, 2).map((c, i) => ({ ...c, expect: i === 0 })), results.slice(0, 2)).line);
  say("report (disagree): " + checkReport([cleaned[17]], [results[17]]).line);

  // A check that cannot finish must not hang the plugin: the worker is replaced and later checks still work.
  const t2 = performance.now();
  (sympy as any).loaded = true;
  const slow = sympy.check([{ type: "equal", a: "factorial(factorial(factorial(9)))", b: "1" }]);
  window.setTimeout(() => (sympy as any).stop(), 4000);
  const hung = await slow;
  const after = await sympy.check([{ type: "equal", a: "2+2", b: "4" }]);
  say(`hung check abandoned after ${((performance.now() - t2) / 1000).toFixed(1)}s -> ${JSON.stringify(hung)}; next check ${JSON.stringify(after)}`);
  if (hung.length || after[0]?.ok !== true) failures++;

  say(`RESULT: ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  document.title = failures === 0 ? "SYMPY PASSED" : "SYMPY FAILED";
}

void main();
