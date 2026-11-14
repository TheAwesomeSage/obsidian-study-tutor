import fs from "node:fs";
const file="src/visualcontract.ts";
let s=fs.readFileSync(file,"utf8");
s=s.replace(/^\/\/ The boundary[\s\S]*?export type PresentationKind = .*?;\r?\n/, `// Backend adapter over the authoritative v1 visual contract.\nimport type { PresentationKind, JsonObject, SourceRef, PresentationRequest, VisualLesson, ValidationError, GenerationResult, ModuleDescriptor } from "./visuals/contracts";\nexport type { PresentationKind, JsonObject, SourceRef, PresentationRequest, VisualLesson, ValidationError, GenerationResult, ModuleDescriptor } from "./visuals/contracts";\nexport type { Json as JsonValue } from "./visuals/contracts";\n`);
s=s.replace(/export type JsonValue =[\s\S]*?\/\*\*\s*\r?\n \* Backend record/,"/**\n * Backend record");
s=s.replace(/export interface ValidationError[\s\S]*?\/\*\* "path: message"/, '/** "path: message"');
s=s.replace(/export interface ModuleDescriptor[\s\S]*?\/\*\* An approved asset/,"/** An approved asset");
fs.writeFileSync(file,s);
