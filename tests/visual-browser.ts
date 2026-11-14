import "./browser-shim";
import { mountPlayer } from "../src/visuals/player";
import { FIXTURES } from "../src/visuals/fixtures";
import { GraphScreen } from "../src/graphscreen";
import { parseState } from "../src/formats";
import { topicInfo } from "../src/overview";
import type { Course } from "../src/course";
import type { TutorView } from "../src/view";
import type { PlayerEvent } from "../src/visuals/contracts";

const params=new URLSearchParams(location.search),kind=params.get("module")??"projectile";
const host=document.querySelector<HTMLElement>("#app")!;
document.body.classList.add(params.get("theme")==="dark"?"theme-dark":"theme-light");
const events:PlayerEvent[]=[];(window as unknown as {events:PlayerEvent[]}).events=events;
if(kind!=="graph") {
  void mountPlayer(host,FIXTURES[kind]??FIXTURES.projectile,{reason:"Engineering preview · synthetic fixture. Observe the model, then explain your reasoning.",onEvent:e=>events.push(e)});
} else {
  host.className="study-tutor graph-preview";
  const dense=params.has("dense"),size=dense?160:14,groups=dense?12:4;
  const titles=["Calculus","Motion & forces","Algorithms","Linear algebra","Probability","Discrete maths","Statistics","Geometry","Systems","Signals","Proof","Applications"];
  const names=["Foundations","Functions","Transformations","Rates of change","Limits","Derivatives","Tangent lines","Integration","Applications","Transfer","Models","Boundary cases","Connections","Independent practice"];
  const course:Course={concepts:new Map(),edges:[]},overview=[];
  for(let t=0;t<groups;t++){
    const state=parseState("");state.target=4;
    for(let i=0;i<size;i++){
      const id=`t${t}/c${i}`,name=i<names.length?names[i]:`Concept ${i+1}`;
      course.concepts.set(id,{id,n:i+1,name,topic:`t${t}`,topicTitle:titles[t],sources:["Synthetic graph fixture"]});
      state.names[i+1]=name;state.levels[i+1]=i%5;state.concepts[i+1]=id;
      if(i)course.edges.push({from:id,to:`t${t}/c${Math.floor((i-1)/2)}`,type:"requires",status:i%3?"reviewed":"inferred",source:"fixture"});
      if(t&&i%3===0)course.edges.push({from:id,to:`t${t-1}/c${(i+5)%size}`,type:i%2?"supports":"synoptic",status:"reviewed",source:"fixture"});
      if(i>3&&i%5===0)course.edges.push({from:id,to:`t${t}/c${i-3}`,type:"contrasts_with",status:"inferred",source:"fixture"});
    }
    overview.push(topicInfo(`t${t}`,titles[t],state,{},"2026-11-14"));
  }
  const view={contentEl:host,topics:titles.slice(0,groups).map((title,i)=>({title,dir:`t${i}`})),overview,today:"2026-11-14",graphFocus:params.has("select")?"t0/c5":null,dir:"t0",plugin:{data:{graphLayout:{}},save:async()=>{},opts:{targetLevel:4},store:{loadCourse:async()=>course},engine:{advise:async()=>({action:"guided-practice",focus:6,reason:"Try a short application, then explain how its prerequisites support the method."})}},md:(e:HTMLElement,t:string)=>{e.textContent=t;},go:()=>{},selectTopic:async()=>{},startStudy:async()=>{}};
  const screen=new GraphScreen(view as unknown as TutorView);void screen.mount(host);
  (window as unknown as {graph:GraphScreen}).graph=screen;
}
