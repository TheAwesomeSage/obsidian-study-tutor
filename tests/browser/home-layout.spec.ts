import {test,expect} from "@playwright/test";

for(const theme of ["light","dark"])test(`Home example controls stay inside Topics without overlapping recent sessions (${theme})`,async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(`/?module=home&theme=${theme}`);
  for(const width of [1360,1024,760,390]){
    await page.setViewportSize({width,height:1000});
    await page.locator(".st-topics").scrollIntoViewIfNeeded();
    const bounds=await page.evaluate(()=>{
      const topics=document.querySelector(".st-topics")!.getBoundingClientRect(),recent=document.querySelector(".st-recent")!.getBoundingClientRect();
      return [...document.querySelectorAll(".st-topics .st-panel-tools button,.st-topics .st-panel-tools input")].map(e=>{const b=e.getBoundingClientRect();return{inside:b.left>=topics.left-1&&b.right<=topics.right+1,overlap:b.left<recent.right&&b.right>recent.left&&b.top<recent.bottom&&b.bottom>recent.top};});
    });
    expect(bounds.length).toBeGreaterThanOrEqual(4);
    expect(bounds.every(b=>b.inside&&!b.overlap)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(width===1360||width===390)await page.screenshot({path:`tests/out/home-${width}-${theme}.png`,fullPage:true});
  }
  expect(errors).toEqual([]);
});
