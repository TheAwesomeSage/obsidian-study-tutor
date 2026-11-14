// Isolated vault for normal-entry-point UI verification. Never writes a learner vault.
import fs from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/store";
import { Engine } from "../src/engine";
import { adaptRegistry } from "../src/visualcontract";
import * as registry from "../src/visuals/registry";
import { FIXTURES } from "../src/visuals/fixtures";
const root=path.resolve("../verification-vault");
const disk={read:(p:string)=>fs.readFile(path.join(root,p),"utf8"),write:async(p:string,s:string)=>{await fs.mkdir(path.dirname(path.join(root,p)),{recursive:true});await fs.writeFile(path.join(root,p),s);},exists:async(p:string)=>!!(await fs.stat(path.join(root,p)).catch(()=>null)),mkdir:async(p:string)=>{await fs.mkdir(path.join(root,p),{recursive:true});},list:async(p:string)=>{const entries=await fs.readdir(path.join(root,p),{withFileTypes:true});return{files:entries.filter(e=>e.isFile()).map(e=>`${p}/${e.name}`),folders:entries.filter(e=>e.isDirectory()).map(e=>`${p}/${e.name}`)};}};
async function main(){
 await fs.mkdir(root,{recursive:true});const store=new Store(disk,"Tutor");
 const topicBody="# Numeric array indexing\n\n## Overview\nSynthetic verification course.\n\n## Subskills\n\n### 1. Zero-based numeric array indexing\nprerequisites: none\n- Read an element using its zero-based numeric array index.\n\n### 2. Linear search\nprerequisites: 1\n- Compare each numeric array element with a target.\n\n### 3. Binary search\nprerequisites: 1,2\n- Halve a sorted array.\n\n### 4. Bubble sort\nprerequisites: 1\n- Compare adjacent values and swap when out of order.";
 const dir=await store.saveCompiled({title:"Numeric array indexing",fm:{subject:"computing"},topicBody,questionsBody:"",target:4});
 const engine=new Engine(store,()=>({claudePath:"",chatModel:"sonnet",compileModel:"sonnet",utilityModel:"haiku",effort:"low",targetLevel:4,maxChatWords:600,maxTopicWords:2000,singlePassWords:6000,smartRouting:false,hardEffort:"high",localActivities:true,localModel:"qwen2.5:3b"}));
 engine.visuals=adaptRegistry(registry as unknown as Record<string,unknown>);
 engine.local={model:"qwen2.5:3b",chatJson:async()=>({text:JSON.stringify({fits:true,objective:"Read an element using its zero-based numeric array index",settings:{algorithm:"index",values:[4,7,9],index:1,target:0},assetIds:[],assessmentId:"trace-result",predictionQuestion:"What is the value at index one?",hint:"Count positions starting from zero.",missingOperation:""}),model:"qwen2.5:3b",doneReason:"stop",timing:{wallMs:0,loadMs:0,promptTokens:0,promptMs:0,evalTokens:0,evalMs:0,totalMs:0}})};
 await engine.requestActivity(dir,{kind:"simulation",concept:1});
 const config=path.join(root,".obsidian");await fs.mkdir(path.join(config,"plugins","study-tutor"),{recursive:true});await fs.cp("release/study-tutor",path.join(config,"plugins","study-tutor"),{recursive:true});
 await fs.writeFile(path.join(config,"community-plugins.json"),JSON.stringify(["study-tutor"]));
 await fs.writeFile(path.join(config,"plugins","study-tutor","data.json"),JSON.stringify({settings:{root:"Tutor",localActivities:true,localModel:"qwen2.5:3b",codePlacement:false,useSpacedRepetition:false},activeTopic:dir,settingsVersion:2}));
 await fs.writeFile(path.join(root,"Verification.md"),"# Study Tutor verification\n\nSynthetic engineering fixtures only. Open Study Tutor from the ribbon; in Study request a simulation of numeric array indexing. The seeded activity is scripted, not a real-note model output.\n\nUse Open saved visual lesson to inspect the JSON fixtures in this vault.");
 for(const [id,lesson]of Object.entries(FIXTURES))await fs.writeFile(path.join(root,`${id}.json`),JSON.stringify(lesson,null,2));
 console.log(root);
}
void main();
