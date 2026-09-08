import type { ActionKind, ControlToBridgeMessage } from "@agent-bridge/protocol";
import type { ActionRow, AgentControlStore } from "@agent-bridge/database";
import { BridgeRegistry } from "../bridge-registry.js";

export class ActionServiceError extends Error {
  constructor(readonly status:number,readonly code:string,message:string,readonly retryable=false,
    readonly details?:Record<string,unknown>){super(message);}
}

export class SessionActionService {
  constructor(private readonly store:AgentControlStore,private readonly bridges:BridgeRegistry,
    private readonly timeoutMs:number){}

  requireBridge(machineId:string):void{
    const bridge=this.bridges.get(machineId);
    if(!bridge)throw new ActionServiceError(409,"worker_offline","worker is offline",true,{machineId});
    if(!bridge.features?.includes("session-actions"))throw new ActionServiceError(409,"capability_unavailable",
      "worker does not support reliable session actions");
  }

  existing(principal:string,key:string,method:"POST"|"DELETE",path:string,body:unknown):ActionRow|undefined{
    try{return this.store.findIdempotent(principal,key,method,path,body);}
    catch(error){if(error instanceof Error&&error.message==="idempotency_key_reused")
      throw new ActionServiceError(400,"idempotency_key_reused","key was already used for a different request");throw error;}
  }

  create(input:{principal:string;key:string;method:"POST"|"DELETE";path:string;body:unknown;kind:ActionKind;machineId:string;sessionId?:string}):
    {action:ActionRow;existing:boolean}{
    try{return this.store.createAction({principal:input.principal,key:input.key,method:input.method,path:input.path,
      body:input.body,kind:input.kind,machineId:input.machineId,sessionId:input.sessionId});}
    catch(error){if(error instanceof Error&&error.message==="idempotency_key_reused")
      throw new ActionServiceError(400,"idempotency_key_reused","key was already used for a different request");throw error;}
  }

  dispatch(action:ActionRow,message:ControlToBridgeMessage):void{
    if(!this.bridges.send(action.machineId,message)){
      this.store.completeAction({type:"action.result",actionId:action.actionId,kind:action.kind,status:"failed",
        sessionId:action.sessionId??undefined,error:{code:"worker_offline",message:"worker is offline",retryable:true},timestamp:Date.now()});
      throw new ActionServiceError(409,"worker_offline","worker is offline",true,{machineId:action.machineId});
    }
    const timer=setTimeout(()=>{const current=this.store.action(action.actionId);if(current?.status==="accepted")
      this.store.completeAction({type:"action.result",actionId:action.actionId,kind:action.kind,status:"failed",
        sessionId:action.sessionId??undefined,error:{code:"bridge_timeout",message:"bridge did not acknowledge the action in time",retryable:true},timestamp:Date.now()});},this.timeoutMs);
    timer.unref();
  }
}
