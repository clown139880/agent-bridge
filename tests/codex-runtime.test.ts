import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CodexRuntimeResolver, type CodexRuntime } from "../apps/bridge/src/codex-runtime.js";
import { CodexAppServerAdapter } from "../apps/bridge/src/app-server.js";
import WebSocket from "ws";

function runtime(root:string,name:string,version:string,complete=true):string{
  const directory=join(root,"OpenAI","Codex","bin",name);mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,"codex.exe"),version);
  if(complete){writeFileSync(join(directory,"codex-code-mode-host.exe"),"");writeFileSync(join(directory,"codex-command-runner.exe"),"");}
  return join(directory,"codex.exe");
}

test("runtime resolver selects the highest complete Codex Desktop version and detects damage",async()=>{
  const root=join(tmpdir(),`codex-runtime-${randomUUID()}`);
  try{
    const old=runtime(root,"old","0.153.4"),latest=runtime(root,"latest","0.154.0-alpha.6.2"),ignored=runtime(root,"partial","9.0.0",false);
    const versions=new Map([[old,"0.153.4"],[latest,"0.154.0-alpha.6.2"],[ignored,"9.0.0"]]);
    const resolver=new CodexRuntimeResolver(old,{platform:"win32",localAppData:root,version:async command=>versions.get(command)});
    const selected=await resolver.resolve();
    assert.equal(selected.command,latest);assert.equal(selected.version,"0.154.0-alpha.6.2");assert.equal(resolver.healthy(selected),true);
    rmSync(join(selected.directory,"codex-code-mode-host.exe"));assert.equal(resolver.healthy(selected),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("concurrent new work shares one runtime switch and refuses an unowned server",async()=>{
  const current:CodexRuntime={command:"old",directory:"old",version:"1.0.0",fingerprint:"old"};
  const candidate:CodexRuntime={command:"new",directory:"new",version:"2.0.0",fingerprint:"new"};
  const resolver={resolve:async()=>candidate,healthy:()=>false};
  const emitted:string[]=[];
  const adapter=new CodexAppServerAdapter({command:"old",url:"ws://127.0.0.1:1",allowedRoots:[process.cwd()],
    manageServer:true,reconnectMs:1000,runtimeResolver:resolver},message=>{if(message.type==="action.progress")emitted.push(message.actionId);});
  const internals=adapter as unknown as {readyPromise:Promise<void>;socket:{readyState:number};runtime:CodexRuntime;
    runtimeSwitch?:Promise<void>;ensureRuntimeForNewWork(id:string):Promise<void>;rotateRuntime(candidate:CodexRuntime):Promise<void>};
  internals.readyPromise=Promise.resolve();internals.socket={readyState:WebSocket.OPEN};internals.runtime=current;
  const originalRotate=internals.rotateRuntime.bind(adapter);
  let switches=0;internals.rotateRuntime=async()=>{switches+=1;await new Promise(resolve=>setTimeout(resolve,10));internals.runtime=candidate;};
  await Promise.all([internals.ensureRuntimeForNewWork("one"),internals.ensureRuntimeForNewWork("two")]);
  assert.equal(switches,1);assert.deepEqual(new Set(emitted),new Set(["one","two"]));

  internals.runtime=current;
  await assert.rejects(originalRotate(candidate),/not owned by this Bridge/);
});

test("managed mode refuses to attach to an unowned App Server endpoint",async()=>{
  const selected:CodexRuntime={command:"codex",directory:"runtime",version:"1.0.0",fingerprint:"one"};
  const adapter=new CodexAppServerAdapter({command:"codex",url:"ws://127.0.0.1:4500",allowedRoots:[process.cwd()],
    manageServer:true,reconnectMs:1000,runtimeResolver:{resolve:async()=>selected,healthy:()=>true}},()=>{});
  const internals=adapter as unknown as {runtime:CodexRuntime;serverReady():Promise<boolean>;startInternal():Promise<void>};
  internals.runtime=selected;internals.serverReady=async()=>true;
  await assert.rejects(internals.startInternal(),/already owned by another process/);
  adapter.stop();
});
