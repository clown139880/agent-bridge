import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { SessionActionService } from "../apps/control-plane/src/api/session-actions.js";

test("runtime progress renews an accepted action lease and completion clears it",()=>{
  const path=join(tmpdir(),`action-lease-${randomUUID()}.sqlite`),database=new Store(path);
  try{
    const store=new AgentControlStore(database.db,{sessionEventsMs:1000,streamEventsMs:1000,actionsMs:120_000,attachmentsMs:1000});
    const action=store.createAction({principal:"test",key:"one",method:"POST",path:"/sessions",body:{},kind:"create_session",machineId:"dev"}).action;
    const service=new SessionActionService(store,{send:()=>true} as never,30_000);
    const internals=service as unknown as {timers:Map<string,NodeJS.Timeout>};
    service.dispatch(action,{type:"action.create_session",actionId:action.actionId,projectPath:"/work"});
    const first=internals.timers.get(action.actionId);assert.ok(first);
    service.renew(action.actionId,30_000);const renewed=internals.timers.get(action.actionId);assert.ok(renewed);assert.notEqual(renewed,first);
    service.complete({type:"action.result",actionId:action.actionId,kind:"create_session",status:"succeeded",sessionId:"thread",timestamp:Date.now()});
    assert.equal(internals.timers.has(action.actionId),false);assert.equal(store.action(action.actionId)?.status,"succeeded");
  }finally{database.db.close();rmSync(path,{force:true});}
});
