import type { ActionKind, ActionResultMessage, ControlToBridgeMessage } from "@agent-bridge/protocol";
import type { ActionRow, AgentControlStore } from "@agent-bridge/database";
import { BridgeRegistry } from "../bridge-registry.js";

export class ActionServiceError extends Error {
  constructor(readonly status:number,readonly code:string,message:string,readonly retryable=false,
    readonly details?:Record<string,unknown>){super(message);}
}

export class SessionActionService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
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
    this.arm(action, this.timeoutMs);
  }

  renew(actionId:string,leaseMs:number):void{
    const action=this.store.action(actionId);
    if(!action||action.status!=="accepted")return;
    const maximum=action.createdAt+120_000;
    const delay=Math.min(Math.max(1_000,Math.min(leaseMs,30_000)),maximum-Date.now());
    if(delay<=0)return;
    this.arm(action,delay);
  }

  complete(message:ActionResultMessage):void{
    const timer=this.timers.get(message.actionId);if(timer)clearTimeout(timer);
    this.timers.delete(message.actionId);
    this.store.completeAction(message);
  }

  private arm(action:ActionRow,delay:number):void{
    const previous=this.timers.get(action.actionId);if(previous)clearTimeout(previous);
    const timer=setTimeout(()=>{this.timers.delete(action.actionId);const current=this.store.action(action.actionId);if(current?.status==="accepted")
      this.store.completeAction({type:"action.result",actionId:action.actionId,kind:action.kind,status:"failed",
        sessionId:action.sessionId??undefined,error:{code:"bridge_timeout",message:"bridge did not acknowledge the action in time",retryable:true},timestamp:Date.now()});},delay);
    timer.unref();this.timers.set(action.actionId,timer);
  }
}
