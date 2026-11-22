/** Five stated probabilities, starting at 50% for each new answer. */
export const DEFAULT_CONFIDENCE = 0.5;
export const CONFIDENCE_LEVELS: [string, number][] = [
  ["None", 0], ["Low", 0.25], ["Medium", 0.5], ["High", 0.75], ["Very high", 1],
];

export const confidenceLabel = (c: number): string => CONFIDENCE_LEVELS.find(([, v]) => Math.abs(v - c) < 1e-9)?.[0] ?? `${Math.round(c * 100)}%`;

let pickerId = 0;

/** A compact native range with five visual stops and spoken value labels. */
export class ConfidencePicker {
  readonly el: HTMLDivElement;
  readonly slider: HTMLInputElement;
  private status: HTMLSpanElement;

  constructor(parent: HTMLElement, private onChange: (value: number | null) => void) {
    const doc = parent.ownerDocument;
    this.el = doc.createElement("div");
    this.el.className = "st-conf";
    this.el.setAttribute("role", "group");
    parent.append(this.el);
    const label = this.el.appendChild(doc.createElement("label"));
    const id = `st-confidence-${++pickerId}`;
    label.id = `${id}-label`;
    label.htmlFor = id;
    this.el.setAttribute("aria-labelledby", label.id);
    label.className = "st-conf-label";
    label.textContent = "Confidence";
    this.status = this.el.appendChild(doc.createElement("span"));
    this.status.className = "st-conf-value st-sr-only";
    this.status.setAttribute("aria-live", "polite");

    const track=this.el.appendChild(doc.createElement("div"));
    track.className="st-conf-track";
    this.slider = track.appendChild(doc.createElement("input"));
    this.slider.type = "range";
    this.slider.id = id;
    this.slider.className = "st-conf-slider";
    this.slider.min = "0";
    this.slider.max = "4";
    this.slider.step = "1";
    const fromSlider = () => this.choose(CONFIDENCE_LEVELS[Number(this.slider.value)][1]);
    this.slider.oninput = fromSlider;
    this.slider.onchange = fromSlider;
    // A click on the middle stop also restores Medium after an explicit keyboard clear.
    this.slider.onpointerup = fromSlider;
    this.slider.onkeydown = (e) => {
      const i = Number(this.slider.value);
      const next = e.key === "Home" ? 0 : e.key === "End" ? 4
        : ["ArrowRight", "ArrowUp", "PageUp"].includes(e.key) ? Math.min(4, i + 1)
        : ["ArrowLeft", "ArrowDown", "PageDown"].includes(e.key) ? Math.max(0, i - 1) : null;
      if (next !== null) {
        e.preventDefault();
        this.choose(CONFIDENCE_LEVELS[next][1]);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.choose(null);
      }
    };

    this.set(DEFAULT_CONFIDENCE);
  }

  set(value: number | null, disabled = false): void {
    const chosen = CONFIDENCE_LEVELS.findIndex(([, v]) => value !== null && Math.abs(v - value) < 1e-9);
    this.el.classList.toggle("is-set", value !== null);
    this.slider.disabled = disabled;
    this.slider.value = String(chosen < 0 ? 2 : chosen);
    this.slider.setAttribute("aria-valuetext", value === null ? "Not set. Move the slider to choose confidence." : confidenceLabel(value));
    this.el.style.setProperty("--st-conf-fill",`${chosen<0?0:chosen*25}%`);
    this.status.textContent = value === null ? "Not set" : confidenceLabel(value);
  }

  private choose(value: number | null): void {
    if (this.slider.disabled) return;
    this.set(value);
    this.onChange(value);
  }
}
