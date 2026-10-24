// Deliberately DRY-RUN ONLY. No write/apply operation is implemented.
// Run using installed Electron, ELECTRON_RUN_AS_NODE=1, with app.asar and sessions root.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { loadChatProjection } = require('./chat-projection.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fields = {
  'turn/start':['turn'], 'turn/end':['turn','reason'], 'step/start':['turn','step'], 'step/end':['turn','step'],
  'assistant/message':['turn','step','message','stream','interrupted'], 'assistant/attempt':['turn','step','stream'],
  'tool/call':['turn','step','callId','name','arguments'], 'tool/result':['turn','step','message'],
  'user/message':['id','role','source','content'], 'system/message':['turn','step','message'],
  'session/title':['messageSeqs','source','title'], 'session/end-seed':[],
  'request/header':['header','reason'], 'request/context':['model','provider'],
  'model/selection':['model','provider'], 'approval/policy':['policy'], 'permission/preset':['preset'], 'sandbox/mode':['mode'],
  'agent/inbox/spliced':['inserted','outcome','removedCount','start','target'],
  'agent-bridge/event':['eventId','localMessageId','turnId','parentItemId','step'],
};
class Unsupported extends Error { constructor(code) { super(code); this.code=code; } }
const refuse = code => { throw new Unsupported(code); };
const bridge = e => e.data.message?.id?.startsWith('bridge:') && e.data.message?.source?.provider === 'agent-bridge';
const textOf = e => (e.data.message?.content || []).filter(b=>b.type==='text' && b.text).map(b=>b.text);

// Conservative whole-log refusal: opaque future records may refer to shifted seqs.
function checkReferences(events) {
  for (const e of events) {
    if(e.surfaceOp && e.surfaceOp !== 'append') refuse('surface-replacement-or-compaction');
    if(e.type.startsWith('compaction/')) refuse('compaction');
    if(e.type !== 'agent-bridge/binding' && !fields[e.type]) refuse('unsupported-event:'+e.type);
    if(fields[e.type] && Object.keys(e.data).some(k=>!fields[e.type].includes(k))) refuse('unsupported-fields:'+e.type);
    function visit(value, location) {
      if(!value || typeof value !== 'object') return;
      for(const [k,v] of Object.entries(value)) {
        const p=location+'.'+k;
        if(/seq|offset|provenance/i.test(k) && p !== '.seq' && p !== '.sourceEventSeqs' && !(e.type==='session/title' && p==='.data.messageSeqs')) refuse('unknown-reference:'+e.type+':'+p);
        visit(v,p);
      }
    }
    visit(e,'');
  }
}

function inspect(events) {
  const steps=[], turns=new Set(), coordinates=new Set(); let turn=null, step=null;
  for(const e of events) {
    if(e.type==='turn/start') { if(turn!==null || step) refuse('overlapping-turn'); if(turns.has(e.data.turn))refuse('repeated-turn-number'); turns.add(e.data.turn);turn=e.data.turn; }
    else if(e.type==='turn/end') {if(turn!==e.data.turn || step)refuse('unbalanced-turn');turn=null;}
    else if(e.type==='step/start') {if(step || turn!==e.data.turn)refuse('unbalanced-step');const key=turn+':'+e.data.step;if(coordinates.has(key))refuse('repeated-step-number');coordinates.add(key);step={start:e.seq,end:null,events:[],messages:[]};}
    else if(e.type==='step/end') {if(!step || turn!==e.data.turn || events[step.start].data.step!==e.data.step)refuse('unbalanced-step');step.end=e.seq;steps.push(step);step=null;}
    else if(step) {step.events.push(e);if(e.type==='assistant/message')step.messages.push(e);}
    else if(['assistant/message','tool/call','tool/result'].includes(e.type))refuse('message-outside-step');
  }
  if(turn!==null || step)refuse('open-tail');
  return steps;
}

function plan(header, events) {
  if(!events.some(e=>e.type==='agent-bridge/binding')) return {status:'unbound'};
  if(header.version!==3)refuse('unsupported-format');
  if(header.isSeeded || header.parentSession)refuse('fork-lineage');
  for(let i=0;i<events.length;i++)if(events[i].seq!==i)refuse('noncontiguous-seq');
  const steps=inspect(events);
  const targets=steps.filter(s=>s.messages.length>1 && s.messages.slice(0,-1).some(e=>textOf(e).length));
  if(!targets.length)return {status:'unchanged'};
  checkReferences(events);
  for(const s of targets) {
    if(!s.messages.slice(0,-1).every(bridge))refuse('collision-without-bridge-evidence');
    if(s.events.some(e=>e.type==='assistant/attempt' || /retry/.test(e.type)))refuse('native-retry');
    const pending=new Map(), used=new Set();
    for(const e of s.events) {
      if(e.data.turn!==undefined && e.data.turn!==events[s.start].data.turn)refuse('mismatched-turn');
      if(typeof e.data.step==='number' && e.data.step!==events[s.start].data.step)refuse('mismatched-step');
      if(e.type==='assistant/message') {
        if(pending.size)refuse('unfinished-tool-before-message');
        for(const b of e.data.message.content)if(b.type==='tool-call') {if(!bridge(e) || !b.id.startsWith('bridge:') || used.has(b.id))refuse('ambiguous-tool-identity');used.add(b.id);pending.set(b.id,false);}
      }
      if(e.type==='tool/call'){if(!pending.has(e.data.callId) || pending.get(e.data.callId))refuse('unmatched-tool-call');pending.set(e.data.callId,true);}
      if(e.type==='tool/result'){const id=e.data.message.source?.callId;if(!pending.get(id))refuse('unmatched-tool-result');const blocks=e.data.message.content;if(blocks.length!==1 || blocks[0].type!=='tool-result' || blocks[0].toolCallId!==id)refuse('unsupported-tool-result');pending.delete(id);}
    }
    if(pending.size)refuse('unfinished-tool');
  }
  const splits=new Set(targets.flatMap(s=>s.messages.slice(1).map(e=>e.seq)));
  const output=[], seqMap=[], originalSteps=new Map();let step=0,turn=null,delta=0;
  for(const original of events) {
    if(original.type==='turn/start'){turn=original.data.turn;step=0;delta=0;}
    if(splits.has(original.seq)) {
      output.push({type:'step/end',seq:output.length,time:original.time,data:{turn,step}});
      output.push({type:'step/start',seq:output.length,time:original.time,data:{turn,step:++step}});
      delta++;
    }
    const e=structuredClone(original);
    if(e.type==='step/start')step=e.data.step+delta;
    // Bridge ack.step is a human progress string, never a coordinate.
    if(typeof e.data.step==='number' && e.data.turn===turn) {originalSteps.set(original.seq,e.data.step);e.data.step=step;}
    seqMap.push(output.length);e.seq=output.length;output.push(e);
  }
  const remap = n => {if(!Number.isSafeInteger(n) || seqMap[n]===undefined)refuse('dangling-seq-reference');return seqMap[n];};
  for(const e of output) {
    if(e.sourceEventSeqs)e.sourceEventSeqs=e.sourceEventSeqs.map(remap);
    if(e.type==='session/title' && e.data.messageSeqs)e.data.messageSeqs=e.data.messageSeqs.map(n=>{if(!['user/message','assistant/message','system/message','tool/result'].includes(events[n]?.type))refuse('title-reference-not-message');return remap(n);});
  }
  // Every original event must be exactly recoverable, including opaque content,
  // IDs, times, order, title and provenance. Only seq and step may differ.
  const inverse=new Map(seqMap.map((n,i)=>[n,i]));
  for(const original of events) {
    const e=structuredClone(output[seqMap[original.seq]]);e.seq=original.seq;
    if(originalSteps.has(original.seq))e.data.step=originalSteps.get(original.seq);
    if(e.sourceEventSeqs)e.sourceEventSeqs=e.sourceEventSeqs.map(n=>inverse.get(n));
    if(e.type==='session/title' && e.data.messageSeqs)e.data.messageSeqs=e.data.messageSeqs.map(n=>inverse.get(n));
    assert.deepEqual(e,original);
  }
  return {status:'candidate',events:output,seqMap,targets,inserted:output.length-events.length};
}

function readRows(bytes, compressed) {
  let text='';
  if(compressed) {let rest=bytes;while(rest.length){const frame=zlib.zstdDecompressSync(rest,{info:true});if(!frame.engine.bytesWritten)refuse('invalid-zstd');text+=frame.buffer.toString('utf8');rest=rest.subarray(frame.engine.bytesWritten);}}
  else text=bytes.toString('utf8');
  const rows=text.trim().split('\n').map(JSON.parse);
  if(rows.some(r=>!r || Array.isArray(r) || typeof r!=='object' || typeof r.type!=='string'))refuse('chunk-or-unknown-row');
  if(rows[0].type!=='session')refuse('unknown-header');
  return rows;
}
async function runtime(app) {
  const base=path.join(app,'node_modules/@deepseek-ai');
  const session=await import(pathToFileURL(path.join(base,'dsh-session/lib/index.js')).href);
  const project=loadChatProjection(path.join(base,'dsh-client-ui-chat/lib/client.js'));
  return {session,project,version:JSON.parse(fs.readFileSync(path.join(base,'dsh-session/package.json'))).version};
}
function validate(header,events,result,rt) {
  const {Session,SessionId}=rt.session;
  const before=Session.create(SessionId(header.id),events,header);
  const after=Session.create(SessionId(header.id),result.events,header);
  assert.deepEqual(before.header,after.header);
  assert.deepEqual(before.deriveMessages(),after.deriveMessages());
  assert.equal(plan(header,result.events).status,'unchanged');
  const old=rt.project(events), projected=rt.project(after.snapshotEvents()), bySeq=new Map(projected.map(m=>[m.seq,m]));
  for(const m of old)assert.deepEqual(bySeq.get(result.seqMap[m.seq])?.blocks,m.blocks,'previously visible Chat blocks must survive');
  let recovered=0;
  for(const s of result.targets)for(const e of s.messages) {
    const visible=bySeq.get(result.seqMap[e.seq]);assert.ok(visible,'every split message has a Chat projection');
    const next=s.messages[s.messages.indexOf(e)+1]?.seq ?? s.end;
    const isolated=rt.project([events[s.start],...events.slice(e.seq,next),events[s.end]]).find(m=>m.seq===e.seq);
    assert.deepEqual(visible.blocks,isolated?.blocks,'recovered text and tool cards exactly match their original segment');
    for(const text of textOf(e))assert.ok(visible.blocks.some(b=>b.kind==='text' && b.text===text),'exact original text is visible');
    if(e!==s.messages.at(-1))recovered+=textOf(e).length;
  }
  assert.deepEqual(projected.map(m=>m.seq),[...projected.map(m=>m.seq)].sort((a,b)=>a-b));
  const replay=Session.create(SessionId(header.id),JSON.parse(JSON.stringify(result.events)),header);
  assert.deepEqual(rt.project(replay.snapshotEvents()),projected);
  return recovered;
}
function files(root){return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(root,e.name)):e.isFile()&&/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(e.name)?[path.join(root,e.name)]:[]);}
async function main(app,root) {
  const rt=await runtime(app);const report={dryRun:true,dshVersion:rt.version,scriptSha256:hash(fs.readFileSync(__filename)),files:0,counts:{},candidates:[],skipped:[]};
  for(const file of files(root)) {
    report.files++;const bytes=fs.readFileSync(file),sha256=hash(bytes);let id;
    try {
      const [header,...events]=readRows(bytes,file.endsWith('.zstd'));id=header.id;
      if(header.version!==3)refuse('historical-generation');
      const result=plan(header,events);
      if(result.status==='candidate') {
        const recoveredTextBlocks=validate(header,events,result,rt);
        if(hash(fs.readFileSync(file))!==sha256)refuse('changed-during-read');
        report.candidates.push({id,relative:path.relative(root,file),sha256,bytes:bytes.length,steps:result.targets.length,inserted:result.inserted,recoveredTextBlocks,originalEvents:events.length,localUsers:events.filter(e=>e.type==='user/message'&&!e.data.id?.startsWith('bridge:')).length});
      }
      report.counts[result.status]=(report.counts[result.status]||0)+1;
    }catch(error){const reason=error.code||'validation-failed';report.counts[reason]=(report.counts[reason]||0)+1;report.skipped.push({id,relative:path.relative(root,file),sha256,reason});}
  }
  console.log(JSON.stringify(report,null,2));
}
module.exports={plan,readRows,runtime,validate,Unsupported};
if(require.main===module){const args=process.argv.slice(2);if(args.length!==2 || args.some(a=>a.startsWith('--')))throw new Error('Dry-run only: pass app.asar and sessions directory; --apply is not supported');main(...args).catch(e=>{console.error(e);process.exitCode=1;});}
