export function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = cls; parent.append(node); return node;
}
export function button(parent: HTMLElement, label: string, action: () => void): HTMLButtonElement {
  const b = el(parent, "button", label, "stv-button"); b.type = "button"; b.onclick = action; return b;
}
export function slider(parent: HTMLElement, title: string, min: number, max: number, step: number, value: number, change: (n: number) => void) {
  const label = el(parent, "label", "", "stv-control");
  el(label, "span", title); const output = el(label, "output", String(value));
  const input = el(label, "input"); input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value); input.setAttribute("aria-label", title);
  input.oninput = () => { output.value = input.value; change(Number(input.value)); };
  return { input, output, set(n: number) { input.value = String(n); output.value = String(n); } };
}
export function svgEl<K extends keyof SVGElementTagNameMap>(parent: SVGElement, tag: K, attrs: Record<string, string | number>, text = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.textContent = text; parent.append(node); return node;
}
