import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkWalkthrough, fencedCode, planCodeWalkthrough, wantsCodeWalkthrough, type CodeWalkthrough} from '../src/codewalkthrough';
import {sessionForPrompt} from '../src/prompt-context';
import {sessionFor} from '../src/session';
import {parseState, type Chat} from '../src/formats';
import {Store} from '../src/store';
import {MemFS} from './memfs';
import type {Engine} from '../src/engine';
import {chatAttachment} from '../src/chat-attachment';
import {parseChat,serializeChat} from '../src/formats';

export const CODE_PLAN: CodeWalkthrough = {title:'Read, double and print',overview:'Input moves through a calculation to the console.',compilation:['Python parses the program before executing it.'],blocks:[{id:'read',line:1,label:'Read n',next:['print']},{id:'print',line:2,label:'Print double',next:[]}],steps:[{line:1,explanation:'Read an integer from stdin.',variables:[{name:'n',value:'3'}],output:''},{line:2,explanation:'Print twice n.',variables:[{name:'n',value:'3'}],output:'6\n'}],limitations:'An illustrative trace; use Run program to observe execution.'};
const source='n = int(input())\nprint(n * 2)';
test('code walkthrough validates source references and rejects broken graphs and unbounded plans',()=>{
  assert.equal(checkWalkthrough(CODE_PLAN,source).title,CODE_PLAN.title);
  assert.throws(()=>checkWalkthrough({...CODE_PLAN,steps:[{...CODE_PLAN.steps[0],line:99}]},source),/source lines/);
  assert.throws(()=>checkWalkthrough({...CODE_PLAN,blocks:[{...CODE_PLAN.blocks[0],next:['missing']}]},source),/missing blocks/);
  assert.throws(()=>checkWalkthrough({...CODE_PLAN,steps:Array(121).fill(CODE_PLAN.steps[0])},source),/Invalid walkthrough/);
});
test('code requests use the latest supported fenced program without intercepting code answers',()=>{
  assert.deepEqual(fencedCode('```python\nx=1\n```\n```cpp\nint main() {}\n```'),{source:'int main() {}',language:'cpp'});
  assert.equal(fencedCode('```javascript\nconsole.log(1)\n```'),null);
  assert.equal(fencedCode('```\n#include <iostream>\n```')?.language,'cpp');
  assert.equal(wantsCodeWalkthrough('Show me a simulation for this concept.','Program structure and console I/O'),true);
  assert.equal(wantsCodeWalkthrough('Show me a simulation.','C++ functions'),true);
  assert.equal(wantsCodeWalkthrough('```python\ndef run():\n    return 1\n```','code'),false);
  assert.equal(wantsCodeWalkthrough('Show me a simulation.','Projectile motion'),false);
});
test('an unchanged walkthrough is planned once, survives service recreation, and invalidates for input or source edits',async()=>{
  const store=new Store(new MemFS(),'Tutor');let calls=0;
  const engine={store,settings:()=>({modelProvider:'claude',compileModel:'test'}),call:async()=>{calls++;return {structured:CODE_PLAN,text:'',usage:{input:100,output:30,cacheRead:0,cacheWrite:0,costUsd:0,calls:1}};}} as unknown as Engine;
  assert.equal((await planCodeWalkthrough(engine,source,'python','3')).cached,false);
  assert.equal((await planCodeWalkthrough({...engine} as Engine,source,'python','3')).cached,true);
  assert.equal(calls,1);
  await planCodeWalkthrough(engine,source,'python','4');
  await planCodeWalkthrough(engine,source+'\n','python','3');
  assert.equal(calls,3);
  await assert.rejects(planCodeWalkthrough(engine,'x'.repeat(24001),'python',''),/Nothing has been truncated/);
});
test('prompt savings remove exact copies only, retain unseen excerpts and leave the saved session intact',()=>{
  const chat:Chat={fm:{},summary:'',messages:[{role:'you',text:'x = 1\nprint(x)'},{role:'tutor',text:'It prints 1.'}]};
  const session=sessionFor(chat,parseState(''),'tutor');session.exactExcerpts.push('you: An earlier exact quotation.');
  const compact=sessionForPrompt(session,chat);
  assert.deepEqual(compact.exactExcerpts,['you: An earlier exact quotation.']);
  assert.equal(session.exactExcerpts.length,3);
  assert.ok(JSON.stringify(compact).length<JSON.stringify(session).length);
});
test('attachments survive chat serialization and retries without entering the graded answer or another chat',()=>{
  const chat:Chat={fm:{},summary:'',messages:[{role:'you',text:'Explain the attached program.'}]};
  const material={name:'program.py',text:'def f():\n    print("hello")\n'};
  chatAttachment(chat,material);
  const restored=parseChat(serializeChat(chat));
  assert.deepEqual(chatAttachment(restored),material);
  assert.equal(restored.messages[0].text,'Explain the attached program.');
  assert.equal(chatAttachment({fm:{},summary:'',messages:[]}),undefined);
  restored.fm.attachment='{bad';assert.equal(chatAttachment(restored),undefined);
});
