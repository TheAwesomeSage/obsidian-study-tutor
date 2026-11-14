import { test } from "node:test";
import assert from "node:assert/strict";
import { assessLesson, listModuleDescriptors, validateLesson } from "../src/visuals/registry";
import { evaluate, formula, projectile, rangeBounds, traceAlgorithm, numericVariant, plotSegments, type PlotSettings, type ProjectileSettings, type AlgorithmSettings } from "../src/visuals/models";
import { FIXTURES } from "../src/visuals/fixtures";
import { ASSETS } from "../src/visuals/assets";
import { readFileSync } from "node:fs";
const copy = (id: string) => structuredClone(FIXTURES[id]);
const near = (a: number, b: number, tolerance=1e-8) => assert.ok(Math.abs(a-b)<tolerance, `${a} != ${b}`);
test("all engineering fixtures validate, descriptors are isolated copies",()=>{
  Object.values(FIXTURES).forEach(l=>assert.deepEqual(validateLesson(l),{valid:true,lesson:l}));
  const d=listModuleDescriptors();d[0].id="tampered";assert.equal(listModuleDescriptors()[0].id,"function-plotter");
});
test("untrusted lesson/config fields, versions, assets, domains and numeric bounds are rejected",()=>{
  for(const raw of [null,[],"oops",{...copy("plot"),schemaVersion:2},{...copy("plot"),moduleId:"eval"},{...copy("plot"),moduleVersion:"9"},{...copy("plot"),assessmentId:"invented"},{...copy("plot"),assetIds:["https://evil.example/x"]},{...copy("plot"),sourceRefs:[]},{...copy("plot"),code:"alert(1)"}])assert.equal(validateLesson(raw).valid,false);
  for(const patch of [{coefficients:[NaN]},{coefficients:[Infinity]},{coefficients:Array(100).fill(1)},{domain:[3,1]},{viewport:[1,2,1,-2]},{pointX:500},{family:"javascript"},{script:"return 1"},{scale:"2"},{family:"log",domain:[-4,-1]}])assert.equal(validateLesson({...copy("plot"),settings:{...copy("plot").settings,...patch}}).valid,false,JSON.stringify(patch));
});
test("validation returns a defensive clone; model objects cannot mutate stored data",()=>{
  const input=copy("plot"),v=validateLesson(input);assert.ok(v.valid);v.lesson.settings.scale=9;assert.equal(input.settings.scale,1);
});
test("polynomial values, transforms and derivatives use ascending coefficients",()=>{
  const s={...copy("plot").settings,coefficients:[2,-3,4],scale:2,shiftX:1,shiftY:5} as unknown as PlotSettings;
  assert.deepEqual(evaluate(s,3),{y:29,slope:26});assert.match(formula(s),/4·\(x − 1\)\^2/);
});
test("elementary derivatives agree with independent finite differences away from singularities",()=>{
  for(const family of ["sin","cos","exp","log","sqrt","reciprocal","abs"] as const){
    const s={...copy("plot").settings,family,scale:1.7,shiftX:0.3,shiftY:-2} as unknown as PlotSettings;
    const x=1.3,h=1e-5;near(evaluate(s,x).slope!, (evaluate(s,x+h).y!-evaluate(s,x-h).y!)/(2*h),1e-7);
  }
});
test("discontinuities and undefined slopes are explicit; reciprocal curves never bridge the pole",()=>{
  const s=copy("plot").settings as unknown as PlotSettings;
  assert.deepEqual(evaluate({...s,family:"reciprocal"},0),{y:null,slope:null});
  assert.deepEqual(evaluate({...s,family:"abs"},0),{y:0,slope:null});
  assert.deepEqual(evaluate({...s,family:"sqrt"},0),{y:0,slope:null});
  assert.deepEqual(evaluate({...s,family:"log"},-1),{y:null,slope:null});
  assert.deepEqual(evaluate(s,5),{y:null,slope:null});
  const pieces=plotSegments({...s,family:"reciprocal"});assert.equal(pieces.length,2);assert.ok(pieces[0][1]<0&&pieces[1][0]>0);
});
test("projectile matches independent reference to eight decimal places",()=>{
  const p=projectile({speed:10,angle:45,gravity:9.81});near(p.range,10.19367992);near(p.flight,1.44160404);near(p.height,2.54841998);
  near(p.vx,Math.sqrt(50));near(p.ay,-9.81);assert.equal(p.ax,0);
});
test("landing is clamped exactly, and model does not depend on frame history",()=>{
  const s=copy("projectile").settings as unknown as ProjectileSettings;
  for(const hz of [15,30,60,144]){const end=projectile(s,1000);for(let t=0;t<end.flight;t+=1/hz)projectile(s,t);assert.equal(end.y,0);near(end.x,end.range);near(end.t,end.flight);}
  assert.deepEqual(projectile(s,.712),projectile(s,.712));assert.equal(projectile(s,-1).t,0);
});
test("reachability accounts for restricted angles, speed bounds and target width",()=>{
  const l=copy("projectile");l.settings={...l.settings,speedRange:[10,10],angleRange:[5,10],angle:8,target:10,tolerance:.1};assert.equal(validateLesson(l).valid,false);
  const s=l.settings as unknown as ProjectileSettings;near(rangeBounds(s)[1],100*Math.sin(20*Math.PI/180)/9.81);
  l.settings.target=rangeBounds(s)[1]+.1;assert.equal(validateLesson(l).valid,true);
  l.settings.speed=11;assert.equal(validateLesson(l).valid,false);
});
test("actual sorting trace has comparisons, both writes, swaps and a correct final state",()=>{
  const s=copy("algorithm").settings as unknown as AlgorithmSettings;
  const trace=traceAlgorithm(s);assert.deepEqual(trace[trace.length-1].result,[2,3,5,7,9]);
  const first=trace.findIndex(e=>e.type==="swap");assert.deepEqual(trace.slice(first-2,first+1).map(e=>e.type),["write","write","swap"]);
  assert.deepEqual(trace[first].values,[3,7,9,2,5]);assert.deepEqual(s.values,[7,3,9,2,5]);assert.deepEqual(traceAlgorithm(s),trace);
  for(let seed=0;seed<30;seed++) {const values=numericVariant(seed),t=traceAlgorithm({...s,values});assert.deepEqual(t[t.length-1].result,[...values].sort((a,b)=>a-b));}
});
test("index and search traces have correct hit/miss/duplicate semantics",()=>{
  const s={algorithm:"index",values:[1,3,3,8],index:2,target:3} as AlgorithmSettings;
  const result=(settings:AlgorithmSettings)=>{const t=traceAlgorithm(settings);return t[t.length-1].result;};
  assert.equal(result(s),3);assert.equal(result({...s,algorithm:"linear-search"}),1);assert.equal(result({...s,algorithm:"binary-search"}),1);
  assert.equal(result({...s,algorithm:"binary-search",target:7}),-1);assert.equal(result({...s,algorithm:"linear-search",target:7}),-1);
  const l=copy("algorithm");l.settings={...l.settings,algorithm:"binary-search"};assert.equal(validateLesson(l).valid,false);
  l.settings={...l.settings,values:[1,2],index:2};assert.equal(validateLesson(l).valid,false);
});
test("variants are deterministic, integer and bounded",()=>{
  assert.deepEqual(numericVariant(17),numericVariant(17));assert.notDeepEqual(numericVariant(17),numericVariant(18));assert.ok(numericVariant(42,16).every(n=>Number.isInteger(n)&&n>=0&&n<100));assert.throws(()=>numericVariant(1,10000));
});
test("module-owned assessment never awards independent mastery, including correct hits",()=>{
  const l=copy("projectile");const r=assessLesson(l,{answer:10.19367992,explanation:"No horizontal force."});assert.equal(r.status,"correct");assert.equal(r.independentMastery,false);
  assert.equal(assessLesson(l,{answer:"10.19367992"}).status,"incorrect");
  assert.equal(assessLesson(copy("plot"),{answer:2}).status,"correct");
  assert.equal(assessLesson(copy("algorithm"),{answer:[2,3,5,7,9]}).status,"correct");
  assert.equal(assessLesson(copy("external"),{answer:"I won"}).status,"ungraded");
});
test("asset catalog matches actual PNG dimensions and carries CC0 provenance",()=>{
  for(const a of ASSETS){const b=readFileSync(a.path);assert.equal(b.readUInt32BE(16),a.width);assert.equal(b.readUInt32BE(20),a.height);assert.equal(a.license,"CC0-1.0");assert.match(a.source,/^https:\/\/kenney.nl\/assets\//);}
});
