import assert from "node:assert/strict";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BridgeClient } from "../apps/bridge/src/client.js";
import type { ActionResultMessage, CreateSessionActionMessage } from "../packages/protocol/src/index.js";

const testActionDedupe = process.platform === "win32" ? test.skip : test;

testActionDedupe("duplicate action replay waits for the in-flight RPC and then replays its durable result",async()=>{
  const cachePath=join(tmpdir(),`bridge-action-cache-${randomUUID()}.json`);
  const client=new BridgeClient({url:"ws://127.0.0.1:1/bridge",machineId:"dev",machineName:"dev",
    hostname:"dev.local",platform:"linux",command:"codex",appServerUrl:"ws://127.0.0.1:1",
    manageAppServer:false,desktopScanIntervalMs:3000,desktopReplayExisting:false,allowedRoots:["/work"],
    reconnectMs:1000,version:"0.4.2",updateEnabled:false,updateSourceRef:"main",updateInstallRoot:"/tmp/unused",
    updateCurrentLink:"/tmp/unused/current",updateStatePath:"/tmp/unused/state.json",actionCachePath:cachePath,
    actionCacheTtlMs:86_400_000,updatePackageManager:"pnpm",updateRestartExecutable:"true",updateRestartArgs:[]});
  type StubAdapter={createSessionAction(actionId:string,path:string,input?:string):Promise<{sessionId:string}>;
    isReady():boolean;hasActiveSessions():boolean};
  const internals=client as unknown as {
    adapters:Map<string,StubAdapter>;
    updater:{admitStart():boolean;admissionState():string;activityChanged():Promise<void>};
    send(message:ActionResultMessage):void;
    handleAction(message:CreateSessionActionMessage):Promise<void>;
  };
  const sent:ActionResultMessage[]=[];let finish!:(value:{sessionId:string})=>void;
  const stub:StubAdapter={createSessionAction:()=>new Promise(resolve=>{finish=resolve;}),
    isReady:()=>true,hasActiveSessions:()=>false};
  internals.adapters=new Map([["codex-cli",stub]]);
  internals.updater={admitStart:()=>true,admissionState:()=>"ready",activityChanged:async()=>{}};
  internals.send=(message)=>sent.push(message);
  const message:CreateSessionActionMessage={type:"action.create_session",actionId:"action-1",projectPath:"/work/repo"};
  try{
    const first=internals.handleAction(message);
    await new Promise<void>(resolve=>setImmediate(resolve));
    await internals.handleAction(message);
    assert.equal(sent.length,0,"an in-flight crash marker must not be emitted as a failure");
    finish({sessionId:"thread-1"});await first;
    assert.equal(sent.length,1);assert.equal(sent[0]?.status,"succeeded");
    await internals.handleAction(message);
    assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);
    assert.equal(statSync(cachePath).mode&0o777,0o600);
  }finally{rmSync(cachePath,{force:true});}
});
