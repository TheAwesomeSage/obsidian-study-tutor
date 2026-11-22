import { test, expect } from "@playwright/test";
import type { ConfidencePicker } from "../../src/confidence";

declare global {
  interface Window { confidenceHarness: {value: number | null; picker: ConfidencePicker} }
}

for (const theme of ["light", "dark"]) test(`chat confidence drags through five stops and supports keyboard and clear (${theme})`, async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`/?module=confidence&theme=${theme}`);
  const slider = page.getByRole("slider", {name: "Confidence", exact: true});
  const clear = page.getByRole("button", {name: "Clear confidence"});
  await expect(slider).toHaveAttribute("aria-valuetext", /Not set/);
  expect(await page.evaluate(() => window.confidenceHarness.value)).toBeNull();
  // Clicking the untouched middle position must explicitly select it even if the native
  // input's starting value is already 2 and the browser produces no input/change event.
  await slider.click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  expect(await page.evaluate(() => window.confidenceHarness.value)).toBe(0.5);
  await clear.click();
  await expect(slider).toHaveAttribute("aria-valuetext", /Not set/);

  const box = (await slider.boundingBox())!;
  const labels = ["None", "Low", "Medium", "High", "Very high"];
  const y = box.y + box.height / 2, start = box.x + 7, travel = box.width - 14;
  await page.mouse.move(start, y);
  await page.mouse.down();
  for (let i = 0; i < labels.length; i++) {
    await page.mouse.move(start + travel * i / 4, y, {steps: 8});
    await expect(slider).toHaveAttribute("aria-valuetext", labels[i]);
    await expect(page.getByRole("radio", {name: `Confidence: ${labels[i]}`, exact: true})).toBeChecked();
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
  await page.getByRole("radio", {name: "Confidence: Low", exact: true}).click();
  await expect(slider).toHaveValue("1");
  await page.screenshot({path: `tests/out/confidence-${theme}.png`, fullPage: true});
  await page.setViewportSize({width:390,height:844});
  await expect(slider).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: `tests/out/confidence-narrow-${theme}.png`, fullPage: true});
  await page.evaluate(() => {const h=window.confidenceHarness;h.picker.set(h.value,true);});
  await expect(slider).toBeDisabled();
  await expect(page.getByRole("radio", {name: "Confidence: Low", exact: true})).toBeDisabled();
  expect(errors).toEqual([]);
});
