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
import { CodexAppServerAdapter } from "../apps/bridge/src/app-server.js";
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
    projectIdentity:"git@github.com:Example/Repo.git",
    title:"Control me",activityStatus:"idle",lastTurnStatus:"completed",createdAt:1000,updatedAt:2000,
    source:"app-server",historyCompleteness:"full"},{sessionId:"thread-older",nativeSessionId:"thread-older",agentType:"codex-cli",
    projectPath:"/work/old",projectName:"old",activityStatus:"idle",createdAt:500,updatedAt:1500,
    source:"app-server",historyCompleteness:"loaded-only"}]});
  await internals.handleBridgeMessage("dev",{type:"session.event",eventId:"initial-reply",eventType:"message.completed",
    sessionId:"thread-1",turnId:"initial-turn",itemId:"initial-answer",timestamp:2000,
    payload:{role:"assistant",text:"Initial answer"}});
  return {path,store,control,internals,sent,base,headers,async close(){await control.stop();store.db.close();rmSync(path,{force:true});}};
}

test("orphaned archive replay records a gap and is acknowledged instead of retrying forever", async () => {
  const f = await fixture();
  try {
    await f.internals.handleBridgeMessage("dev", { type: "session.event", eventId: "orphan-event",
      eventType: "message.completed", sessionId: "missing-session", timestamp: Date.now(),
      payload: { role: "assistant", text: "orphaned original" } });
    assert.deepEqual(f.sent.at(-1), { type: "archive.ack", eventId: "orphan-event" });
    const gap = f.store.db.prepare(`SELECT source_instance,first_event_id,last_event_id,dropped_count,reason
      FROM conversation_collection_gaps WHERE gap_id=?`).get("missing-session:dev:orphan-event") as Record<string, unknown>;
    assert.deepEqual({ ...gap }, { source_instance: "dev", first_event_id: "orphan-event", last_event_id: "orphan-event",
      dropped_count: 1, reason: "session-metadata-missing" });
  } finally { await f.close(); }
});

test('offline worker deletion is scoped, durable, and rejects online workers',async()=>{
  const f=await fixture();try{
    const remove=()=>fetch(`${f.base}/workers/codex%40dev`,{method:'DELETE',headers:f.headers,body:'{}'});
    assert.equal((await remove()).status,409);
    assert.equal((await fetch(`${f.base}/workers/codex%40dev`,{method:'DELETE',headers:{...f.headers,authorization:'Bearer read'},body:'{}'})).status,403);
    f.store.upsertMachine({id:'dev',name:'Workstation',platform:'linux',hostname:'dev.local',capabilities:['codex-cli','claude-code']});
    f.store.createSession({id:'claude-retain',machineId:'dev',agentType:'claude-code',projectName:'repo',projectPath:'/work/repo',matrixRoomId:'',matrixThreadId:null,nativeSessionId:'claude-retain',status:'idle',createdAt:1,updatedAt:1});
    f.internals.bridges.delete('dev');
    const receipt=await (await remove()).json() as any;
    assert.equal(receipt.deletedSessions,2);
    assert.ok(f.store.getSession('claude-retain'));
    assert.equal(f.internals.controlStore.session('thread-1'),undefined);
    assert.equal(f.internals.controlStore.isSessionDeleted('thread-1'),true);
    const workers=await fetch(`${f.base}/workers`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.deepEqual(workers.workers.map((w:any)=>w.id),['claude@dev']);
    assert.equal((await (await remove()).json() as any).deletedSessions,0);
    f.internals.controlStore.updateMachineConnection('dev','0.6.38',1,[]);
    assert.equal(f.internals.controlStore.workerRemoved('codex@dev'),false);
    assert.equal(f.internals.controlStore.isSessionDeleted('thread-1'),true);
    const restored=await fetch(`${f.base}/workers`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.deepEqual(restored.workers.map((w:any)=>w.id),['codex@dev','claude@dev']);
  }finally{await f.close();}
});

test("Agent Control REST exposes snapshot, pagination, actions, idempotency and pending CAS",async()=>{
  const f=await fixture();try{
    const snapshot=await fetch(`${f.base}/snapshot`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(snapshot.sessions[0].sessionId,"thread-1");assert.match(snapshot.streamCursor,/^c:\d+:\d+$/);
    const first=await fetch(`${f.base}/sessions?limit=1`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(first.data.length,1);assert.equal(first.hasMore,true);assert.ok(first.nextCursor);
    assert.equal(first.data[0].projectIdentity,"github.com/example/repo");
    const second=await fetch(`${f.base}/sessions?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(second.data[0].sessionId,"thread-older");
    const groups=await fetch(`${f.base}/session-groups?limit=1`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(groups.data.length,1);assert.equal(groups.hasMore,true);assert.ok(groups.nextCursor);
    assert.equal(groups.data[0].kind,"repository");assert.equal(groups.data[0].projectIdentity,"github.com/example/repo");
    assert.deepEqual(groups.data[0].sessions.map((row:any)=>row.sessionId),["thread-1"]);
    assert.deepEqual(groups.data[0].executionLocations[0],{workerId:"codex@dev",agent:"codex-cli",machineId:"dev",workspace:"/work/repo",
      workerName:"Codex @ Workstation",machineName:"Workstation",online:true,available:true});
    const groupNext=await fetch(`${f.base}/session-groups?limit=1&cursor=${encodeURIComponent(groups.nextCursor)}`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.deepEqual(groupNext.data[0].sessions.map((row:any)=>row.sessionId),["thread-older"]);
    const detail=await fetch(`${f.base}/sessions/thread-1`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(detail.workerId,"codex@dev");assert.equal(detail.machineId,"dev");assert.equal(detail.workspace,"/work/repo");
    assert.equal(detail.groupId,groups.data[0].groupId);
    const recent=await fetch(`${f.base}/sessions?segment=recent&dayStart=1750&limit=10`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.deepEqual(recent.data.map((row:any)=>row.sessionId),["thread-1"]);
    const history=await fetch(`${f.base}/sessions?segment=history&dayStart=1750&limit=10`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.deepEqual(history.data.map((row:any)=>row.sessionId),["thread-older"]);
    const workers=await fetch(`${f.base}/workers`,{headers:{authorization:"Bearer read"}}).then(r=>r.json()) as any;
    assert.equal(workers.workers[0].bridgeVersion,"0.4.2");assert.ok(Array.isArray(workers.workers[0].recentWorkspaces));
    const forbidden=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",headers:{authorization:"Bearer read","content-type":"application/json","idempotency-key":"read-cannot-write"},body:'{"input":"x"}'});
    assert.equal(forbidden.status,403);

    const create=await fetch(`${f.base}/sessions`,{method:"POST",headers:{...f.headers,"idempotency-key":"create-model"},
      body:JSON.stringify({workerId:"codex@dev",workspace:"/work/repo",input:"hello",model:"deepseek-chat"})});
    assert.equal(create.status,202);assert.equal((f.sent.at(-1) as any).type,"action.create_session");
    assert.equal((f.sent.at(-1) as any).model,"deepseek-chat");

    const turn=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",headers:{...f.headers,"idempotency-key":"turn-one"},body:JSON.stringify({input:"continue",delivery:"auto",model:"deepseek-v3"})});
    assert.equal(turn.status,202);const receipt=await turn.json() as any;assert.equal(receipt.status,"accepted");
    assert.equal((f.sent.at(-1) as any).type,"action.submit_turn");
    assert.equal((f.sent.at(-1) as any).model,"deepseek-v3");
    const repeat=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",headers:{...f.headers,"idempotency-key":"turn-one"},body:JSON.stringify({input:"continue",delivery:"auto",model:"deepseek-v3"})}).then(r=>r.json()) as any;
    assert.equal(repeat.actionId,receipt.actionId);assert.equal(f.sent.filter(item=>item.type==="action.submit_turn").length,1);
    await f.internals.handleBridgeMessage("dev",{type:"action.result",actionId:receipt.actionId,kind:"submit_turn",status:"succeeded",
      sessionId:"thread-1",turnId:"turn-1",resolvedAction:"start_turn",timestamp:Date.now()});
    assert.equal((await fetch(`${f.base}/actions/${receipt.actionId}`,{headers:f.headers}).then(r=>r.json()) as any).resolvedAction,"start_turn");

    await f.internals.handleBridgeMessage("dev",{type:"session.event",eventId:"turn-start",eventType:"turn.started",
      sessionId:"thread-1",turnId:"turn-1",timestamp:Date.now(),payload:{status:"in_progress"}});
    await f.internals.handleBridgeMessage("dev",{type:"session.event",eventId:"context-42",eventType:"context.updated",
      sessionId:"thread-1",turnId:"turn-1",timestamp:Date.now(),payload:{usedTokens:42,contextWindow:128000}});
    const latestEvents=await fetch(`${f.base}/sessions/thread-1/events?tail=true&limit=1`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(latestEvents.data[0].eventId,"context-42");assert.equal(latestEvents.hasMore,true);assert.match(latestEvents.nextCursor,/^e:\d+$/);
    const earlierEvents=await fetch(`${f.base}/sessions/thread-1/events?tail=true&limit=1&before=${encodeURIComponent(latestEvents.nextCursor)}`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(earlierEvents.data[0].eventId,"turn-start");assert.equal(earlierEvents.hasMore,true);
    const firstReply=await fetch(`${f.base}/sessions/thread-1/events?tail=true&limit=1&before=${encodeURIComponent(earlierEvents.nextCursor)}`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.equal(firstReply.data[0].eventId,"initial-reply");assert.equal(firstReply.hasMore,false);
    assert.notEqual(earlierEvents.data[0].eventId,latestEvents.data[0].eventId);
    const sessionDetail=await fetch(`${f.base}/sessions/thread-1`,{headers:f.headers}).then(r=>r.json()) as any;
    assert.deepEqual(sessionDetail.context,{usedTokens:42,contextWindow:128000});
    assert.equal(sessionDetail.updatedAt,2000);assert.equal(sessionDetail.lastResponseAt,2000);
    const repeatAfterStateChange=await fetch(`${f.base}/sessions/thread-1/turns`,{method:"POST",
      headers:{...f.headers,"idempotency-key":"turn-one"},body:JSON.stringify({input:"continue",delivery:"auto",model:"deepseek-v3"})});
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

test("complete worker inventory clears a vanished live turn and its approval", async () => {
  const f = await fixture();
  try {
    f.internals.controlStore.updateSessionActivity('thread-1','waiting_for_approval','old-turn');
    await f.internals.handleBridgeMessage('dev',{type:'state.snapshot',generation:'restart',complete:false,sessions:[],approvals:[],userInputs:[]});
    assert.equal(f.internals.controlStore.session('thread-1')?.activeTurnId,'old-turn');
    await f.internals.handleBridgeMessage('dev',{type:'state.snapshot',generation:'restart',complete:true,sessions:[],approvals:[],userInputs:[]});
    const session=f.internals.controlStore.session('thread-1');
    assert.equal(session?.activeTurnId,null);
    assert.equal(session?.status,'offline');
    assert.equal(session?.lastTurnStatus,'interrupted');
  } finally { await f.close(); }
});

test("a session snapshot repairs a replay timestamp newer than the real thread activity", async () => {
  const f = await fixture();
  try {
    await f.internals.handleBridgeMessage("dev", { type: "session.event", eventId: "bad-replay-time",
      eventType: "message.completed", sessionId: "thread-1", turnId: "old-turn", itemId: "old-answer",
      timestamp: 9_000, payload: { role: "assistant", text: "Old replayed answer" } });
    await f.internals.handleBridgeMessage("dev", { type: "state.snapshot", generation: "repair", complete: true,
      approvals: [], userInputs: [], sessions: [{ sessionId: "thread-1", nativeSessionId: "thread-1",
        agentType: "codex-cli", projectPath: "/work/repo", projectName: "repo", title: "Control me",
        activityStatus: "idle", lastTurnStatus: "completed", createdAt: 1_000, updatedAt: 2_000,
        source: "app-server", historyCompleteness: "full" }] });

    const repaired = f.internals.controlStore.session("thread-1") as { updatedAt: number; lastResponseAt: number };
    assert.equal(repaired.updatedAt, 2_000);
    assert.equal(repaired.lastResponseAt, 2_000);
  } finally {
    await f.close();
  }
});

test("thread/updated asynchronously refreshes the persisted session title", async () => {
  const f = await fixture();
  try {
    const pending: Promise<void>[] = [];
    const adapter = new CodexAppServerAdapter({ command: "codex", url: "ws://127.0.0.1:4500",
      allowedRoots: [process.cwd()], manageServer: false, reconnectMs: 3_000 }, (message) => {
      pending.push(f.internals.handleBridgeMessage("dev", message));
    });
    const internals = adapter as unknown as {
      handleNotification(method: string, params: Record<string, unknown>): Promise<void>;
      threadsById: Map<string, { id: string; cwd: string; name?: string; updatedAt?: number }>;
    };
    internals.threadsById.set("thread-1", { id: "thread-1", cwd: process.cwd(), name: "Control me" });

    await internals.handleNotification("thread/updated", {
      thread: { id: "thread-1", name: "Asynchronous title", updatedAt: 3 },
    });
    await Promise.all(pending);

    assert.equal(f.internals.controlStore.session("thread-1")?.title, "Asynchronous title");
    assert.equal(f.internals.controlStore.session("thread-1")?.updatedAt, 3_000);
  } finally {
    await f.close();
  }
});

test("deleting an idle session clears retained data and prevents inventory resurrection", async () => {
  const f = await fixture();
  try {
    await f.internals.handleBridgeMessage("dev", { type:"session.event", eventId:"old-event", eventType:"message.completed",
      sessionId:"thread-older", turnId:"old-turn", itemId:"old-message", timestamp:1600,
      payload:{role:"user",text:"remove me"} });
    f.internals.controlStore.updateSessionActivity("thread-1", "active", "turn-live");
    const active = await fetch(`${f.base}/sessions/thread-1`, { method:"DELETE",
      headers:{...f.headers,"idempotency-key":"delete-active"}, body:"{}" });
    assert.equal(active.status, 409);
    assert.equal((await active.json() as any).error.code, "session_active");

    const response = await fetch(`${f.base}/sessions/thread-older`, { method:"DELETE",
      headers:{...f.headers,"idempotency-key":"delete-idle"}, body:"{}" });
    assert.equal(response.status, 202);
    const receipt = await response.json() as any;
    assert.equal(receipt.kind, "delete_session");
    assert.equal(receipt.status, "accepted");
    assert.deepEqual(f.sent.at(-1), { type:"action.delete_session", actionId:receipt.actionId,
      sessionId:"thread-older", agentType:"codex-cli" });
    await f.internals.handleBridgeMessage("dev", { type:"action.result", actionId:receipt.actionId,
      kind:"delete_session", status:"succeeded", sessionId:"thread-older", timestamp:Date.now() });
    assert.equal(f.internals.controlStore.session("thread-older"), undefined);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=?").get("thread-older") as {n:number}).n, 0);
    assert.equal(f.internals.controlStore.isSessionDeleted("thread-older"), true);

    f.internals.controlStore.upsertSession("dev", { sessionId:"thread-older", nativeSessionId:"thread-older",
      agentType:"codex-cli", projectPath:"/work/old", projectName:"old", activityStatus:"idle",
      createdAt:500, updatedAt:1700, source:"app-server", historyCompleteness:"full" });
    assert.equal(f.internals.controlStore.session("thread-older"), undefined);
  } finally { await f.close(); }
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

test("SSE delivers each appended event and one current state per changed resource; stale cursors fail before streaming",async()=>{
  const f=await fixture();try{
    const from=f.internals.controlStore.streamCursor();
    for(const [eventId,eventType] of [["t9-start","turn.started"],["t9-reply","message.completed"],["t9-end","turn.completed"]])
      await f.internals.handleBridgeMessage("dev",{type:"session.event",eventId,eventType,sessionId:"thread-1",turnId:"turn-9",
        timestamp:Date.now(),payload:eventType==="message.completed"?{role:"assistant",text:"done"}:{status:"completed"}});
    const {items}=f.internals.controlStore.streamAfter(f.internals.controlStore.parseStreamCursor(from));
    assert.deepEqual(items.filter(item=>item.type==="session.event.appended").map(item=>(item.payload as any).eventId),
      ["t9-start","t9-reply","t9-end"]);
    const updates=items.filter(item=>item.type==="session.updated");
    assert.equal(updates.length,1);assert.equal((updates[0]!.payload as any).status,"idle");
    assert.ok(items.every((item,index)=>index===0||item.cursor!==items[index-1]!.cursor));
    const expired=await fetch(`${f.base}/stream?cursor=g:1`,{headers:{authorization:"Bearer read"}});
    assert.equal(expired.status,410);assert.equal((await expired.json() as any).error.code,"cursor_expired");
    const ahead=await fetch(`${f.base}/stream?cursor=c:999999:0`,{headers:{authorization:"Bearer read"}});
    assert.equal((await ahead.json() as any).error.code,"invalid_cursor");
  }finally{await f.close();}
});

test("a replayed turn.started does not resurrect a completed turn", async () => {
  const f = await fixture();
  try {
    await f.internals.handleBridgeMessage("dev", { type: "session.event", eventId: "t1-start",
      eventType: "turn.started", sessionId: "thread-1", turnId: "turn-1", timestamp: 3000, payload: { status: "in_progress" } });
    let session = f.internals.controlStore.session("thread-1") as { status: string; activeTurnId: string | null };
    assert.equal(session.status, "active");
    assert.equal(session.activeTurnId, "turn-1");

    await f.internals.handleBridgeMessage("dev", { type: "session.event", eventId: "t1-done",
      eventType: "turn.completed", sessionId: "thread-1", turnId: "turn-1", timestamp: 3100, payload: { status: "completed" } });
    session = f.internals.controlStore.session("thread-1") as { status: string; activeTurnId: string | null };
    assert.equal(session.status, "idle");
    assert.equal(session.activeTurnId, null);

    // Durable archive replay of the same turn.started (missed ack / reconnect) must not reopen the turn.
    await f.internals.handleBridgeMessage("dev", { type: "session.event", eventId: "t1-start",
      eventType: "turn.started", sessionId: "thread-1", turnId: "turn-1", timestamp: 3000, payload: { status: "in_progress" } });
    session = f.internals.controlStore.session("thread-1") as { status: string; activeTurnId: string | null };
    assert.equal(session.status, "idle");
    assert.equal(session.activeTurnId, null);
  } finally { await f.close(); }
});

test("a durable approval.requested event alone never marks a session waiting", async () => {
  const f = await fixture();
  try {
    await f.internals.handleBridgeMessage("dev", { type: "session.event", eventId: "appr-evt",
      eventType: "approval.requested", sessionId: "thread-1", turnId: "turn-1", timestamp: 4000,
      payload: { approvalId: "a-1", kind: "command", summary: "$ ls", choices: ["allow", "deny"] } });
    const session = f.internals.controlStore.session("thread-1") as { status: string; pendingApprovalCount: number };
    // Waiting states are owned by the pending-request lifecycle, so the durable
    // event on its own leaves neither a "waiting" status nor a pending row.
    assert.notEqual(session.status, "waiting_for_approval");
    assert.equal(session.pendingApprovalCount, 0);
  } finally { await f.close(); }
});

test("a phantom waiting session with no pending rows can be deleted", async () => {
  const f = await fixture();
  try {
    f.internals.controlStore.updateSessionActivity("thread-1", "waiting_for_approval", "stale-turn");
    const zombie = f.internals.controlStore.session("thread-1") as { status: string; pendingApprovalCount: number };
    assert.equal(zombie.status, "waiting_for_approval");
    assert.equal(zombie.pendingApprovalCount, 0);
    const response = await fetch(`${f.base}/sessions/thread-1`, { method: "DELETE",
      headers: { ...f.headers, "idempotency-key": "delete-zombie" }, body: "{}" });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as any).kind, "delete_session");
  } finally { await f.close(); }
});
