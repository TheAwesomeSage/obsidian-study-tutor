import { test, expect } from "@playwright/test";
import type { ConfidencePicker } from "../../src/confidence";

declare global {
  interface Window { confidenceHarness: {value: number | null; picker: ConfidencePicker} }
}

for (const theme of ["light", "dark"]) test(`chat confidence drags through five stops and supports keyboard and clear (${theme})`, async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`/?module=confidence&theme=${theme}`);
  // Reproduce Obsidian's ordinary-slider offset, including its active state.
  // The custom slider must remain centred in the app, not just bare Chromium.
  await page.addStyleTag({content:"input[type=range]::-webkit-slider-thumb{position:relative;top:-6px}input[type=range]::-webkit-slider-thumb:active{top:-6px}"});
  const slider = page.getByRole("slider", {name: "Confidence", exact: true});
  await expect(page.getByRole("button", {name: "Clear confidence"})).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  expect((await page.locator(".st-composer").boundingBox())!.height).toBeLessThanOrEqual(95);
  await expect(page.getByRole("textbox",{name:"Your answer or message"})).toHaveAttribute("rows","1");
  await expect(slider).toHaveAttribute("aria-valuetext", /Not set/);
  expect(await page.evaluate(() => window.confidenceHarness.value)).toBeNull();
  // Clicking the untouched middle position must explicitly select it even if the native
  // input's starting value is already 2 and the browser produces no input/change event.
  await slider.click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  expect(await page.evaluate(() => window.confidenceHarness.value)).toBe(0.5);
  await slider.focus();await slider.press("Delete");
  await expect(slider).toHaveAttribute("aria-valuetext", /Not set/);

  const box = (await slider.boundingBox())!;
  const labels = ["None", "Low", "Medium", "High", "Very high"];
  const y = box.y + box.height / 2, start = box.x + 12, travel = box.width - 24;
  await page.mouse.move(start, y);
  await page.mouse.down();
  for (let i = 0; i < labels.length; i++) {
    await page.mouse.move(start + travel * i / 4, y, {steps: 8});
    await expect(slider).toHaveAttribute("aria-valuetext", labels[i]);
    await expect(slider).toHaveValue(String(i));
    expect(await page.evaluate(() => window.confidenceHarness.value)).toBe(i / 4);
  }
  await page.mouse.up();
  await slider.focus();
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", "None");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await page.keyboard.press("Delete");
  expect(await page.evaluate(() => window.confidenceHarness.value)).toBeNull();
  await slider.press("Home");await slider.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await page.screenshot({path: `tests/out/confidence-${theme}.png`, fullPage: true});
  await page.setViewportSize({width:390,height:844});
  await expect(slider).toBeVisible();
  expect((await page.locator(".st-composer").boundingBox())!.height).toBeLessThanOrEqual(175);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: `tests/out/confidence-narrow-${theme}.png`, fullPage: true});
  await page.evaluate(() => {const h=window.confidenceHarness;h.picker.set(h.value,true);});
  await expect(slider).toBeDisabled();
  expect(errors).toEqual([]);
});
