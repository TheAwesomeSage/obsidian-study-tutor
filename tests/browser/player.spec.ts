import {test,expect} from "@playwright/test";
test("projectile prediction, launch, pause, exact landing, explanation and reset",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto("/?module=projectile");
 await expect(page.getByRole("button",{name:"Play",exact:true})).toBeDisabled();
 await page.getByLabel("Your prediction").fill("About 10.2 metres because vx is constant.");await page.getByRole("button",{name:"Save prediction"}).click();
 await page.getByRole("button",{name:"Play",exact:true}).click();await page.getByRole("button",{name:"Pause",exact:true}).click();
 await page.getByRole("button",{name:"Play",exact:true}).click();await expect(page.locator(".stv-telemetry")).toContainText("1.442 s");
 await expect(page.locator(".stv-result")).toContainText("Target reached");
 await page.getByLabel("Why did that happen?",{exact:false}).fill("No horizontal acceleration; gravity changes vertical velocity.");
 await page.getByLabel("Predicted range for").fill("10.19367992");await page.getByRole("button",{name:"Check practice answer"}).click();
 await expect(page.locator(".stv-reflection .stv-status")).toContainText("Matches the model");
 await page.screenshot({path:"tests/out/projectile-light.png",fullPage:true});
 await page.getByRole("button",{name:"Reset",exact:true}).click();await expect(page.getByLabel("Your prediction")).toBeEnabled();await expect(page.locator(".stv-telemetry")).toContainText("0.000 s");
 const events=await page.evaluate(()=> (window as unknown as {events:{type:string,result?:{independentMastery:boolean}}[]}).events);expect(events.find(e=>e.type==="assessment")?.result?.independentMastery).toBe(false);expect(errors).toEqual([]);
});
test("plot loads JSXGraph, point slider and tangent use model values",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto("/?module=plot");await expect(page.locator(".stv-board svg")).toBeVisible();
 await page.getByLabel("Your prediction").fill("The slope increases.");await page.getByRole("button",{name:"Save prediction"}).click();
 const point=page.getByRole("slider",{name:"Point x",exact:true});await point.fill("2");await point.dispatchEvent("input");await expect(page.locator(".stv-readout")).toContainText("slope = 4.000");
 await page.screenshot({path:"tests/out/plot-light.png",fullPage:true});expect(errors).toEqual([]);
});
test("algorithm follows actual trace, reduced motion steps and replay is deterministic",async({page})=>{
 await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/?module=algorithm&theme=dark");
 await page.getByLabel("Your prediction").fill("7 and 3 swap; [2,3,5,7,9].");await page.getByRole("button",{name:"Save prediction"}).click();
 for(let i=0;i<6;i++)await page.getByRole("button",{name:"Step",exact:true}).click();
 await expect(page.locator(".stv-trace-line")).toContainText("SWAP");await expect(page.locator(".stv-cell strong")).toHaveText(["3","7","9","2","5"]);
 await page.screenshot({path:"tests/out/algorithm-dark.png",fullPage:true});
 await page.getByRole("button",{name:"Reset",exact:true}).click();await expect(page.locator(".stv-cell strong")).toHaveText(["7","3","9","2","5"]);
});
for(const theme of ["light","dark"])test(`graph real canvas, details and keyboard (${theme})`,async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto(`/?module=graph&theme=${theme}`);await expect(page.locator("canvas")).toBeVisible();
 await page.getByRole("combobox",{name:"Find a concept"}).fill("Derivatives");await page.getByRole("option").first().click();await expect(page.locator(".st-graph-title")).toHaveText("Derivatives");await expect(page.locator(".st-graph-panel")).toContainText("Current capability");
 await page.locator("canvas").focus();await page.keyboard.press("ArrowRight");await page.screenshot({path:`tests/out/graph-${theme}.png`,fullPage:true});expect(errors).toEqual([]);
});
test("dense graph and narrow player have no horizontal overflow",async({page})=>{
 await page.goto("/?module=graph&dense&theme=dark");await expect(page.locator(".st-graph-panel")).toContainText("1920 concepts");await page.screenshot({path:"tests/out/graph-dense-dark.png",fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.goto("/?module=projectile&theme=dark");await expect(page.locator(".stv-player")).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:"tests/out/player-narrow-dark.png",fullPage:true});
 await page.goto("/?module=graph&theme=light&select");await expect(page.locator(".st-graph-title")).toHaveText("Derivatives");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:"tests/out/graph-narrow-light.png",fullPage:true});
});
