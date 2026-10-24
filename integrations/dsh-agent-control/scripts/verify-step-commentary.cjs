const {test}=require('node:test');
const assert=require('node:assert/strict');
const {plan,readRows,runtime,validate}=require('./recover-step-commentary.cjs');
const zlib=require('node:zlib');
const header={type:'session',version:3,id:'fixture',createdAt:1,isSeeded:false};
function fixture(){
  const msg=(id,content)=>({id,role:'assistant',source:{kind:'model',provider:'agent-bridge',model:'remote'},content});
  return [
    ['agent-bridge/binding',{origin:'http://fixture.invalid',sessionId:'remote'}],
    ['user/message',{id:'local-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'local-only prompt'}]}],
    ['turn/start',{turn:1}],['step/start',{turn:1,step:1}],
    ['assistant/message',{turn:1,step:1,message:msg('bridge:plan',[{type:'text',text:'before tool'}]),stream:[]}],
    ['assistant/message',{turn:1,step:1,message:msg('bridge:tool',[{type:'tool-call',id:'bridge:call',name:'agent-bridge:command',arguments:'{}'}]),stream:[]}],
    ['tool/call',{turn:1,step:1,callId:'bridge:call',name:'agent-bridge:command',arguments:'{}'}],
    ['tool/result',{turn:1,step:1,message:{id:'bridge:result',role:'user',source:{kind:'tool',callId:'bridge:call'},content:[{type:'tool-result',toolCallId:'bridge:call',content:[{type:'text',text:'result'}]}]}}],
    ['assistant/message',{turn:1,step:1,message:msg('native-final',[{type:'text',text:'final answer'}]),stream:[]}],
    ['step/end',{turn:1,step:1}],['turn/end',{turn:1,reason:{kind:'completed'}}],
    ['session/title',{source:'user',title:'unchanged title',messageSeqs:[1,4,8]}],
  ].map(([type,data],seq)=>({type,data,seq,time:1,...(['user/message','assistant/message','tool/result'].includes(type)?{surfaceOp:'append'}:{})}));
}
test('lossless split, original message order/IDs, provenance and title mapping, idempotence',()=>{
  const events=fixture();events[7].sourceEventSeqs=[6];const original=structuredClone(events);
  const p=plan(header,events);assert.equal(p.status,'candidate');assert.equal(p.inserted,4);
  assert.deepEqual(events,original);assert.deepEqual(p.events[p.seqMap[7]].sourceEventSeqs,[p.seqMap[6]]);
  assert.deepEqual(p.events.at(-1).data.messageSeqs,[p.seqMap[1],p.seqMap[4],p.seqMap[8]]);
  assert.equal(plan(header,p.events).status,'unchanged');
});
test('actual boundaries distinguish repeated coordinates and refuse repeated turns',()=>{
  const events=fixture();const extra=fixture().slice(2,11);events.push(...extra.map(e=>({...e,seq:events.length+extra.indexOf(e)})));
  assert.throws(()=>plan(header,events),/repeated-turn-number/);
});
test('safe no-op when no hidden text or no binding',()=>{assert.equal(plan(header,fixture().filter(e=>e.type!=='agent-bridge/binding')).status,'unbound');const p=plan(header,fixture());assert.equal(plan(header,p.events).status,'unchanged');});
test('later native steps shift only by inserted boundaries; original step gaps survive',()=>{
  const e=fixture();e.splice(10,0,{type:'step/start',data:{turn:1,step:5},time:1},{type:'step/end',data:{turn:1,step:5},time:1});e.forEach((r,i)=>r.seq=i);e.at(-1).data.messageSeqs=[1,4,8];
  const p=plan(header,e);assert.equal(p.events[p.seqMap[10]].data.step,7);assert.equal(p.events[p.seqMap[11]].data.step,7);assert.equal(plan(header,p.events).status,'unchanged');
});
for(const [name,mutate,reason] of [
  ['native retry',e=>{e[6]={...e[6],type:'assistant/attempt',data:{turn:1,step:1,stream:[]}}},/native-retry/],
  ['missing tool result',e=>{e[7]={...e[7],type:'agent-bridge/event',data:{eventId:'x',turnId:'t'}}},/unfinished-tool/],
  ['native collision',e=>{e[4].data.message.id='native-plan'},/collision-without-bridge/],
  ['unknown seq reference',e=>{e[0].data.futureSeq=4},/unknown-reference/],
  ['compaction',e=>{e[11].type='compaction/summary'},/compaction/],
  ['unknown event',e=>{e[11].type='future/custom'},/unsupported-event/],
  ['dangling title reference',e=>{e[11].data.messageSeqs=[999]},/title-reference/],
  ['open tail',e=>{e.splice(10);},/open-tail/],
])test('refuses '+name,()=>{const e=fixture();mutate(e);assert.throws(()=>plan(header,e),reason);});
test('fork lineage and unsupported generations are refused',()=>{assert.throws(()=>plan({...header,isSeeded:true},fixture()),/fork-lineage/);assert.throws(()=>plan({...header,version:2},fixture()),/unsupported-format/);});
test('zstd concatenated frames round trip and chunk rows rejected',()=>{
  const rows=[header,...fixture()];const bytes=Buffer.concat(rows.map(r=>zlib.zstdCompressSync(Buffer.from(JSON.stringify(r)+'\n'))));assert.deepEqual(readRows(bytes,true),rows);assert.throws(()=>readRows(Buffer.from(JSON.stringify(header)+'\n[]'),false),/chunk/);
});
test('actual installed Session and Chat preserve messages, tools, local user, title and provenance', {skip:!process.env.DSH_TEST_ASAR},async()=>{
  const rt=await runtime(process.env.DSH_TEST_ASAR),events=fixture();events[7].sourceEventSeqs=[6];assert.equal(validate(header,events,plan(header,events),rt),1);
});
