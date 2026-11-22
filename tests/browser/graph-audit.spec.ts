import {test, expect} from "@playwright/test";

test("tree layout shows prerequisite levels, preserves topology and restores each layout's positions",async({page})=>{
  await page.goto("/?module=graph&theme=dark");
  const layout=page.getByRole("combobox",{name:"Graph layout",exact:true});
  await expect(layout).toHaveValue("tree");
  const snapshot=()=>page.evaluate(()=>{const g=(window as any).graph;return{nodes:g.nodes.map((n:any)=>[n.id,n.x,n.y,n.degree]),edges:g.course.edges};});
  const initial=await snapshot();
  expect(await page.evaluate(()=>{const g=(window as any).graph,m=new Map(g.nodes.map((n:any)=>[n.id,n]));return g.course.edges.filter((e:any)=>e.type==="requires"&&e.status!=="rejected").every((e:any)=>(m.get(e.from) as any).y>(m.get(e.to) as any).y);})).toBe(true);
  await layout.selectOption("connected");
  await expect(page.getByRole("combobox",{name:"Graph layout",exact:true})).toHaveValue("connected");
  const connected=await snapshot();expect(connected.edges).toEqual(initial.edges);
  await page.getByRole("combobox",{name:"Graph layout",exact:true}).selectOption("tree");
  await expect.poll(snapshot).toEqual(initial);
  await page.getByRole("combobox",{name:"Graph layout",exact:true}).selectOption("connected");
  await expect.poll(snapshot).toEqual(connected);
  await page.getByRole("combobox",{name:"Graph layout",exact:true}).selectOption("tree");
  await page.screenshot({path:"tests/out/graph-prerequisite-tree-dark.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

for (const theme of ["light","dark"]) {
  test(`directed edges retain visible arrowheads below the old zoom cutoff (${theme})`,async({page})=>{
    await page.goto(`/?module=graph&theme=${theme}`);
    await expect(page.locator("canvas")).toBeVisible();
    const traced=await page.evaluate(()=>{
      const g=(window as any).graph,c=g.canvas,ctx=c.ctx;
      const original={nodes:c.nodes,edges:c.edges,groups:c.groups,cam:{...c.cam}};
      const types=["requires","supports","applies_to","derived_from","synoptic","contrasts_with","requires"];
      const nodes:any[]=[],edges:any[]=[];
      types.forEach((type,i)=>{
        nodes.push({id:`a${i}`,label:"",group:"",x:-300,y:(i-3)*85,degree:1,color:"#69c7dc",hollow:false,weak:false},{id:`b${i}`,label:"",group:"",x:300,y:(i-3)*85,degree:100,color:"#c0ce6a",hollow:false,weak:false});
        edges.push({from:i===3?`b${i}`:`a${i}`,to:i===3?`a${i}`:`b${i}`,type,status:i===6?"rejected":i===0?"inferred":"reviewed"});
      });
      const methods=["beginPath","moveTo","lineTo","quadraticCurveTo","stroke"] as const;
      const old=Object.fromEntries(methods.map(m=>[m,ctx[m]]));
      let points:number[][]=[],curved=false;
      const heads:{points:number[][];alpha:number}[]=[],dashes:number[][]=[];
      ctx.beginPath=function(){points=[];curved=false;return old.beginPath.call(this);};
      ctx.moveTo=function(x:number,y:number){points.push([x,y]);return old.moveTo.call(this,x,y);};
      ctx.lineTo=function(x:number,y:number){points.push([x,y]);return old.lineTo.call(this,x,y);};
      ctx.quadraticCurveTo=function(...args:number[]){curved=true;return old.quadraticCurveTo.apply(this,args);};
      ctx.stroke=function(){if(curved)dashes.push(this.getLineDash());else if(points.length===3)heads.push({points:points.map(p=>[...p]),alpha:this.globalAlpha});return old.stroke.call(this);};
      try{c.setData(nodes,edges,[]);c.cam={x:0,y:0,k:0.35};c.draw();}
      finally{for(const m of methods)ctx[m]=old[m];c.setData(original.nodes,original.edges,original.groups);c.cam=original.cam;c.redraw();}
      return{heads,dashes};
    });
    expect(traced.heads).toHaveLength(4); // symmetric and rejected edges have no marker
    expect(traced.dashes).toEqual([[4,4],[7,4],[2,4],[1,3],[10,4,3,4],[9,3,2,3]]);
    for(let i=0;i<4;i++){
      const h=traced.heads[i],tip=h.points[1];
      expect(h.alpha).toBeGreaterThanOrEqual(0.4);
      for(const wing of [h.points[0],h.points[2]])expect(i===3?tip[0]<wing[0]:tip[0]>wing[0]).toBe(true);
    }
    await page.screenshot({path:`tests/out/graph-arrows-${theme}.png`,fullPage:true});
  });

  test(`graph values, evidence limits, prerequisite details and filters agree (${theme})`,async({page})=>{
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`/?module=graph&evidence&theme=${theme}`);
    await expect(page.locator("canvas")).toBeVisible();
    const snapshot=()=>page.evaluate(()=>{const g=(window as any).graph;return{nodes:g.nodes.map((n:any)=>[n.id,n.x,n.y,n.degree]),edges:g.course.edges,saved:g.view.plugin.data.graphLayout};});
    const before=await snapshot();
    await page.getByRole("combobox",{name:"Find a concept"}).fill("Derivatives");
    await page.getByRole("listbox",{name:"Matching concepts"}).getByRole("option").first().click();
    await expect(page.locator(".st-graph-capability")).toContainText("2 of 3 unaided answers were correct");
    await expect(page.locator("section").filter({has:page.getByRole("heading",{name:"Rests on",exact:true})})).toContainText("Transformations");
    await expect(page.locator("section").filter({has:page.getByRole("heading",{name:"Builds on it",exact:true})})).toContainText("Boundary cases");
    await page.getByText("Inspect estimates and evidence counts",{exact:true}).click();
    await expect(page.locator(".st-graph-statistics")).toContainText("60%, provisional, from 3 unaided answers");
    await expect(page.locator(".st-graph-statistics")).toContainText("33 points above your results · Brier 0.33");
    const mode=page.getByRole("combobox",{name:"Colour concepts by"});
    const node=(id:string)=>page.evaluate(id=>{const g=(window as any).graph,n=g.nodes.find((n:any)=>n.id===id);return{color:n.color,hollow:n.hollow};},id);
    const css=(name:string)=>page.evaluate(name=>getComputedStyle((window as any).graph.view.contentEl).getPropertyValue(name).trim(),name);
    await mode.selectOption("estimate");
    expect(await node("t0/c5")).toEqual({color:await css("--st-seq-5"),hollow:false});
    for(const id of ["t0/c6","t0/c7","t0/c8","t0/c9","t0/c10","t0/c11"])expect((await node(id)).hollow).toBe(true); // too few, helped, self-rated, disputed, exposed, ungraded
    await mode.selectOption("calibration");
    expect(await node("t0/c5")).toEqual({color:await css("--st-div-pos-2"),hollow:false});
    await mode.selectOption("level");
    expect(await node("t0/c0")).toEqual({color:await css("--st-seq-1"),hollow:false}); // level zero is a value
    expect((await node("t0/c12")).hollow).toBe(true); // unknown is a hollow dot
    await mode.selectOption("recency");
    expect(await node("t0/c5")).toEqual({color:await css("--st-seq-6"),hollow:false});
    expect((await node("t0/c0")).hollow).toBe(true);
    await mode.selectOption("topic");
    await page.getByRole("combobox",{name:"Show topics"}).selectOption("t0");
    expect(await page.evaluate(()=>(window as any).graph.canvas.visible.size)).toBe(14);
    await page.getByRole("combobox",{name:"Show topics"}).selectOption("");
    const requires=page.getByRole("group",{name:"Relations shown"}).getByRole("button",{name:"Requires",exact:true});
    await requires.click();
    expect(await page.evaluate(()=>(window as any).graph.canvas.edges.some((e:any)=>e.type==="requires"))).toBe(false);
    await requires.click();
    await page.evaluate(()=>{const g=(window as any).graph;g.view.startStudy=async(opts:any)=>{(window as any).studyRequest=opts;};});
    await page.getByRole("button",{name:"Study this",exact:true}).click();
    expect(await page.evaluate(()=>(window as any).studyRequest)).toEqual({dir:"t0",mode:"auto",focus:6});
    expect(await snapshot()).toEqual(before);
    await page.screenshot({path:`tests/out/graph-evidence-${theme}.png`,fullPage:true});
    // A rejected cross-topic relation remains in the course ledger but must not pull its
    // target into neighbourhood focus or the renderer's direct-neighbour highlight.
    await page.evaluate(()=>{const g=(window as any).graph;g.course.edges.push({from:"t0/c5",to:"t3/c13",type:"synoptic",status:"rejected",source:"fixture"});g.apply();});
    await page.locator(".st-graph-island button").nth(0).click();
    expect(await page.evaluate(()=>(window as any).graph.canvas.visible.has("t3/c13"))).toBe(false);
    expect(errors).toEqual([]);
  });
}
