import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";

class HeadlessGateway {
  readonly enabled=false;async start(){return "";}stop(){}async sendRoot(){return "";}
  async sendThread(){return "";}async sendReaction(){return "";}async removeReaction(){}async sendNotice(){return "";}
}

type Internals={http:HttpServer;bridges:Map<string,{machineId:string;name:string;capabilities:string[];features?:string[];bridgeVersion?:string;socket:WebSocket}>;
  controlStore:AgentControlStore;handleBridgeMessage(machineId:string,message:BridgeToControlMessage):Promise<void>};

async function fixture() {
  const path=join(tmpdir(),`agent-control-api-${randomUUID()}.sqlite`),store=new Store(path);
  store.upsertMachine({id:"dev",name:"Workstation",platform:"linux",hostname:"dev.local",capabilities:["codex-cli","codex-app-server"]});
  const sent:ControlToBridgeMessage[]=[];const socket={readyState:WebSocket.OPEN,OPEN:WebSocket.OPEN,
    send(value:string){sent.push(JSON.parse(value) as ControlToBridgeMessage);},close(){}} as unknown as WebSocket;
  const control=new ControlPlane(store,new HeadlessGateway(),{host:"127.0.0.1",port:0,workerApiEnabled:true,
    workerApiToken:"worker",controlApiReadToken:"read",controlApiWriteToken:"write",
    sse:{keepaliveMs:50,pollMs:5,maxBackpressure:3}});
  const internals=control as unknown as Internals;internals.bridges.set("dev",{machineId:"dev",name:"Workstation",
    capabilities:["codex-cli","codex-app-server"],features:["session-actions","session-events"],bridgeVersion:"0.4.2",socket});
  await control.start();const address=internals.http.address();assert.ok(address&&typeof address==="object");
  const base=`http://127.0.0.1:${address.port}/api/v1`,headers={authorization:"Bearer write","content-type":"application/json"};
  await internals.handleBridgeMessage("dev",{type:"state.snapshot",generation:"one",complete:true,approvals:[],userInputs:[],sessions:[{
    sessionId:"thread-1",nativeSessionId:"thread-1",agentType:"codex-cli",projectPath:"/work/repo",projectName:"repo",
    title:"Control me",activityStatus:"idle",lastTurnStatus:"completed",createdAt:1000,updatedAt:2000,
    source:"app-server",historyCompleteness:"full"},{sessionId:"thread-older",nativeSessionId:"thread-older",agentType:"codex-cli",
    projectPath:"/work/old",projectName:"old",activityStatus:"idle",createdAt:500,updatedAt:1500,
    source:"app-server",historyCompleteness:"loaded-only"}]});
  return {path,store,control,internals,sent,base,headers,async close(){await control.stop();store.db.close();rmSync(path,{force:true});}};
}

test("Agent Control REST exposes snapshot, pagination, actions, idempotency and pending CAS",async()=>{
  const f=await fixture();try{
    const snapshot=await fetch(`${f.base}/snapshot`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(snapshot.sessions[0].sessionId,"thread-1");assert.match(snapshot.streamCursor,/^g:\d+$/);
    const first=await fetch(`${f.base}/sessions?limit=1`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(first.data.length,1);assert.equal(first.hasMore,true);assert.ok(first.nextCursor);
    const second=await fetch(`${f.base}/sessions?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(second.data[0].sessionId,"thread-older");
    const workers=await fetch(`${f.base}/workers`,{headers:{authorization:"Bearer read"}}).then(r=>r.json()) as any;
    assert.equal(workers.workers[0].bridgeVersion,"0.4.2");assert.ok(Array.isArray(workers.workers[0].recentWorkspaces));
    const forbidden=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",headers:{authorization:"Bearer read","content-type":"application/json","idempotency-key":"read-cannot-write"},body:'{"input":"x"}'});
    assert.equal(forbidden.status,403);

    const turn=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",headers:{...f.headers,"idempotency-key":"turn-one"},body:JSON.stringify({input:"continue",delivery:"auto"})});
    assert.equal(turn.status,202);const receipt=await turn.json() as any;assert.equal(receipt.status,"accepted");
    assert.equal((f.sent.at(-1) as any).type,"action.submit_turn");
    const repeat=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",headers:{...f.headers,"idempotency-key":"turn-one"},body:JSON.stringify({input:"continue",delivery:"auto"})}).then(r=>r.json()) as any;
    assert.equal(repeat.actionId,receipt.actionId);assert.equal(f.sent.filter(item=>item.type==="action.submit_turn").length,1);
    await f.internals.handleBridgeMessage("dev",{type:"action.result",actionId:receipt.actionId,kind:"submit_turn",status:"succeeded",
      sessionId:"thread-1",turnId:"turn-1",resolvedAction:"start_turn",timestamp:Date.now()});
    assert.equal((await fetch(`${f.base}/actions/${receipt.actionId}`,{headers:f.headers}).then(r=>r.json()) as any).resolvedAction,"start_turn");

    await f.internals.handleBridgeMessage("dev",{type:"session.event",eventId:"turn-start",eventType:"turn.started",
      sessionId:"thread-1",turnId:"turn-1",timestamp:Date.now(),payload:{status:"in_progress"}});
    const repeatAfterStateChange=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",
      headers:{...f.headers,"idempotency-key":"turn-one"},body:JSON.stringify({input:"continue",delivery:"auto"})});
    assert.equal(repeatAfterStateChange.status,202);
    assert.equal((await repeatAfterStateChange.json() as any).actionId,receipt.actionId);
    const stale=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",headers:{...f.headers,"idempotency-key":"stale"},
      body:JSON.stringify({input:"race",expectedTurnId:"old"})});assert.equal(stale.status,409);
    assert.equal((await stale.json() as any).error.code,"turn_changed");

    await f.internals.handleBridgeMessage("dev",{type:"user_input_request",sessionId:"thread-1",requestId:"secret-1",
      turnId:"turn-1",requestedAt:Date.now(),questions:[{id:"token",header:"Token",question:"Enter token",
        isOther:true,isSecret:true,options:null}]});
    const secret=await fetch(`${f.base}/user-input/secret-1/response`,{method:"POST",headers:{...f.headers,"idempotency-key":"secret-answer"},
      body:JSON.stringify({answers:{token:{answers:["never-persist"]}}})});
    assert.equal(secret.status,409);assert.equal((await secret.json() as any).error.code,"secret_input_unsupported");
    await f.internals.handleBridgeMessage("dev",{type:"user_input_resolved",sessionId:"thread-1",requestId:"secret-1",resolvedAt:Date.now()});

    await f.internals.handleBridgeMessage("dev",{type:"approval_request",sessionId:"thread-1",approvalId:"approval-1",
      turnId:"turn-1",kind:"command",summary:"run tests",choices:["allow","deny"],requestedAt:Date.now()});
    const decision=await fetch(`${f.base}/approvals/approval-1/decision`,{method:"POST",headers:{...f.headers,"idempotency-key":"approve-one"},body:'{"choice":"allow"}'});
    assert.equal(decision.status,202);const action=await decision.json() as any;
    const racing=await fetch(`${f.base}/approvals/approval-1/decision`,{method:"POST",headers:{...f.headers,"idempotency-key":"approve-two"},body:'{"choice":"deny"}'});
    assert.equal(racing.status,409);assert.equal((await racing.json() as any).error.code,"approval_already_resolved");
    await f.internals.handleBridgeMessage("dev",{type:"action.result",actionId:action.actionId,kind:"resolve_approval",status:"succeeded",sessionId:"thread-1",timestamp:Date.now()});
    await f.internals.handleBridgeMessage("dev",{type:"approval_resolved",sessionId:"thread-1",approvalId:"approval-1",choice:"allow",resolvedAt:Date.now()});
    const approvalReplay=await fetch(`${f.base}/approvals/approval-1/decision`,{method:"POST",
      headers:{...f.headers,"idempotency-key":"approve-one"},body:'{"choice":"allow"}'});
    assert.equal(approvalReplay.status,202);
    assert.equal((await approvalReplay.json() as any).actionId,action.actionId);
    const lost=await fetch(`${f.base}/approvals/approval-1/decision`,{method:"POST",headers:{...f.headers,"idempotency-key":"approve-three"},body:'{"choice":"deny"}'});
    assert.equal(lost.status,409);assert.equal((await lost.json() as any).error.code,"approval_already_resolved");

    f.internals.bridges.get("dev")!.features=[];
    const unsupported=await fetch(`${f.base}/sessions/thread-1/interrupt`,{method:"POST",
      headers:{...f.headers,"idempotency-key":"old-bridge"},body:JSON.stringify({expectedTurnId:"turn-1"})});
    assert.equal(unsupported.status,409);
    assert.equal((await unsupported.json() as any).error.code,"capability_unavailable");

    const noContentType=await fetch(`${f.base}/sessions/thread-1/interrupt`,{method:"POST",
      headers:{authorization:"Bearer write","idempotency-key":"missing-content-type"},body:"{}"});
    assert.equal(noContentType.status,415);
    assert.equal((await noContentType.json() as any).error.code,"unsupported_media_type");
  }finally{await f.close();}
});

test("snapshot cursor followed by SSE does not miss a committed session event",async()=>{
  const f=await fixture();try{
    const snapshot=await fetch(`${f.base}/snapshot`,{headers:f.headers}).then(r=>r.json()) as any;
    const abort=new AbortController();const streamPromise=fetch(`${f.base}/stream?cursor=${encodeURIComponent(snapshot.streamCursor)}`,
      {headers:{authorization:"Bearer read"},signal:abort.signal});
    const stream=await streamPromise;assert.equal(stream.status,200);const reader=stream.body!.getReader();
    await f.internals.handleBridgeMessage("dev",{type:"session.event",eventId:"message-after-snapshot",eventType:"message.completed",
      sessionId:"thread-1",turnId:"turn-x",itemId:"item-x",timestamp:Date.now(),payload:{role:"assistant",text:"hello"}});
    let text="";const deadline=Date.now()+2000;while(!text.includes("message-after-snapshot")&&Date.now()<deadline){const part=await reader.read();if(part.done)break;text+=Buffer.from(part.value).toString();}
    assert.match(text,/message-after-snapshot/);assert.match(text,/event: bridge\.event/);abort.abort();
  }finally{await f.close();}
});

test("SSE watermark remains monotonic and expired cursors fail before streaming",async()=>{
  const f=await fixture();try{
    const oldest=Number((f.store.db.prepare("SELECT MIN(sequence) AS n FROM stream_events").get() as {n:number}).n);
    const highBefore=f.internals.controlStore.streamCursor();
    f.store.db.prepare("UPDATE stream_events SET created_at=0").run();
    f.internals.controlStore.cleanup();
    assert.equal(f.internals.controlStore.streamCursor(),highBefore);
    await f.internals.handleBridgeMessage("dev",{type:"session.event",eventId:"after-retention",eventType:"progress",
      sessionId:"thread-1",timestamp:Date.now(),payload:{message:"new"}});
    const expired=await fetch(`${f.base}/stream?cursor=${encodeURIComponent(`g:${oldest}`)}`,
      {headers:{authorization:"Bearer read"}});
    assert.equal(expired.status,410);
    assert.equal((await expired.json() as any).error.code,"cursor_expired");
  }finally{await f.close();}
});
