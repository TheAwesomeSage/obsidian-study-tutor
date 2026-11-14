import JXG from "jsxgraph";
import { evaluate, formula, plotSegments, type PlotSettings } from "./models";
import { el, slider } from "./dom";

export function mountPlot(host: HTMLElement, controls: HTMLElement, s: PlotSettings, onChange: () => void): { destroy(): void; reset(): void } {
  const initial = structuredClone(s);
  const label = el(host, "p", formula(s), "stv-equation");
  const box = el(host, "div", "", "stv-board"); box.setAttribute("aria-label", "Function plot. Use the labelled point slider for keyboard control.");
  const readout = el(host, "p", "", "stv-readout"); readout.setAttribute("aria-live", "polite");
  const board = JXG.JSXGraph.initBoard(box, { boundingbox: s.viewport, axis: true, showCopyright: false, showNavigation: false, pan: { enabled: false }, zoom: { wheel: false, needShift: true }, keepaspectratio: false, renderer: "svg" });
  const curves: JXG.Curve[] = [];
  const point = board.create("point", [s.pointX, evaluate(s, s.pointX).y ?? 0], { name: "P", size: 5, color: "#e28234", showInfobox: false });
  const tangent = board.create("line", [() => {
    const v = evaluate(s, s.pointX); return (v.slope ?? 0) * s.pointX - (v.y ?? 0);
  }, () => -(evaluate(s, s.pointX).slope ?? 0), 1], { strokeColor: "#e28234", dash: 2, strokeWidth: 2 });
  const refresh = () => {
    const v = evaluate(s, s.pointX);
    point.setPosition(JXG.COORDS_BY_USER, [s.pointX, v.y ?? 0]);
    point.setAttribute({ visible: v.y !== null }); tangent.setAttribute({ visible: v.y !== null && v.slope !== null });
    readout.textContent = `x = ${s.pointX.toFixed(2)} · f(x) = ${v.y === null ? "undefined" : v.y.toFixed(3)} · slope = ${v.slope === null ? "undefined" : v.slope.toFixed(3)}`;
    label.textContent = formula(s); board.update();
  };
  const rebuild = () => {
    curves.splice(0).forEach(c => board.removeObject(c));
    for (const [a, b] of plotSegments(s)) curves.push(board.create("functiongraph", [(x: number) => evaluate(s, x).y ?? NaN, a, b], { strokeColor: "#397bbd", strokeWidth: 3 }));
    refresh();
  };
  const x = slider(controls, "Point x", s.domain[0], s.domain[1], 0.01, s.pointX, n => { s.pointX = n; refresh(); onChange(); });
  point.on("drag", () => { s.pointX = Math.max(s.domain[0], Math.min(s.domain[1], point.X())); x.set(Number(s.pointX.toFixed(2))); refresh(); onChange(); });
  const scale = slider(controls, "Vertical scale", -10, 10, 0.1, s.scale, n => { s.scale = n; rebuild(); onChange(); });
  const shift = slider(controls, "Vertical shift", -10, 10, 0.1, s.shiftY, n => { s.shiftY = n; rebuild(); onChange(); });
  el(host, "p", "Blue: function · amber: tangent. A gap means the function is undefined; an undefined slope has no tangent line.", "stv-caption");
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { if (box.clientWidth > 0) { board.resizeContainer(box.clientWidth, box.clientHeight); board.setBoundingBox(s.viewport, false); } }) : null;
  observer?.observe(box); rebuild();
  return { destroy() { observer?.disconnect(); JXG.JSXGraph.freeBoard(board); }, reset() { Object.assign(s, structuredClone(initial)); x.set(s.pointX); scale.set(s.scale); shift.set(s.shiftY); rebuild(); } };
}

