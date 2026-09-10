import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store, AgentControlStore, PendingRow, ActionRow } from "@agent-bridge/database";
import { parseWorkerId, workerId as buildWorkerId, type AgentType, type ActionKind, type ControlToBridgeMessage } from "@agent-bridge/protocol";
import { BridgeRegistry } from "../bridge-registry.js";
import { AgentControlSse, SseCursorError } from "./sse.js";
import { ActionServiceError, SessionActionService } from "./session-actions.js";
import { ApiProblem, integerParam as integer, jsonBody, stringField as string } from "./validation.js";

/** Map a worker-id prefix to an agent type, or undefined for an unknown prefix. */
function agentTypeForWorkerPrefix(prefix: string): AgentType | undefined {
  if (prefix === "codex") return "codex-cli";
  if (prefix === "claude") return "claude-code";
  return undefined;
}
function capabilityForAgent(agentType: AgentType): string {
  return agentType === "claude-code" ? "claude-code" : "codex-cli";
}

interface Principal { id: string; read: boolean; write: boolean; }
interface ApiOptions { workerToken?: string; readToken?: string; writeToken?: string;
  sseKeepaliveMs: number; ssePollMs: number; sseMaxBackpressure: number; actionTimeoutMs: number; }

function equalSecret(left: string, right: string): boolean {
  const a=Buffer.from(left),b=Buffer.from(right); return a.length===b.length && timingSafeEqual(a,b);
}
function actionJson(action: ActionRow): Record<string,unknown> {
  return {actionId:action.actionId,kind:action.kind,status:action.status,sessionId:action.sessionId,
    turnId:action.turnId,resolvedAction:action.resolvedAction,error:action.error?{error:{...action.error,requestId:action.actionId}}:null,
    createdAt:action.createdAt,updatedAt:action.updatedAt};
}
function pendingJson(row: PendingRow): Record<string,unknown> {
  const common={sessionId:row.sessionId,runId:row.runId,turnId:row.turnId,
    workerId:buildWorkerId((row.agentType??"codex-cli") as AgentType,row.machineId),
    status:row.status,requestedAt:row.requestedAt,resolvedAt:row.resolvedAt};
  if(row.kind==="approval")return {approvalId:row.id,...common,kind:row.request.kind,summary:row.request.summary,
    choices:row.request.choices,decision:row.decision?.choice??null};
  return {requestId:row.id,...common,questions:row.request.questions,answers:row.decision?.answers??null};
}
function queryScope(name:string,url:URL):string{const entries=[...url.searchParams.entries()].filter(([key])=>key!=="cursor"&&key!=="limit").sort();return `${name}:${createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0,16)}`;}
function pageCursor(scope:string,time:number,id:string):string{return Buffer.from(JSON.stringify({scope,time,id})).toString("base64url");}
function readPageCursor(value:string,scope:string):[number,string]{try{const row=JSON.parse(Buffer.from(value,"base64url").toString()) as any;if(row.scope!==scope||!Number.isFinite(row.time)||typeof row.id!=="string")throw new Error();return[row.time,row.id];}catch{throw new ApiProblem(400,"invalid_cursor","invalid cursor");}}

export class AgentControlApi {
  private readonly sse:AgentControlSse;
  private readonly actions:SessionActionService;
  constructor(private readonly legacy: Store, private readonly store: AgentControlStore,
    private readonly bridges: BridgeRegistry, private readonly options: ApiOptions) {
    this.sse=new AgentControlSse(store,{keepaliveMs:options.sseKeepaliveMs,pollMs:options.ssePollMs,
      maxBackpressure:options.sseMaxBackpressure});
    this.actions=new SessionActionService(store,bridges,options.actionTimeoutMs);
  }

  async handle(request: IncomingMessage,response: ServerResponse): Promise<boolean> {
    const url=new URL(request.url??"/","http://localhost");
    if(!url.pathname.startsWith("/api/v1/"))return false;
    const requestId=randomUUID();
    try {
      const principal=this.authenticate(request);
      if(request.method!=="GET"&&!principal.write)throw new ApiProblem(403,"forbidden","write scope is required");
      if(request.method==="GET"&&!principal.read)throw new ApiProblem(403,"forbidden","read scope is required");
      if(request.method==="GET"&&url.pathname==="/api/v1/workers"){this.workers(response);return true;}
      const workerModels=url.pathname.match(/^\/api\/v1\/workers\/([^/]+)\/models$/);
      if(request.method==="GET"&&workerModels){const workerId=decodeURIComponent(workerModels[1]!);const machineId=parseWorkerId(workerId)?.machineId??workerId;
        try{this.ok(response,await this.bridges.requestModels(machineId));}catch(error){throw new ApiProblem(503,'model_catalog_unavailable',error instanceof Error?error.message:String(error));}return true;}
      if(request.method==="GET"&&url.pathname==="/api/v1/snapshot"){this.snapshot(url,response);return true;}
      if(request.method==="GET"&&url.pathname==="/api/v1/sessions"){this.sessions(url,response);return true;}
      if(request.method==="POST"&&url.pathname==="/api/v1/sessions"){await this.createSession(request,response,principal);return true;}
      if(request.method==="GET"&&url.pathname==="/api/v1/runs"){this.runs(url,response);return true;}
      if(request.method==="GET"&&url.pathname==="/api/v1/approvals"){this.pendingList("approval",url,response);return true;}
      if(request.method==="GET"&&url.pathname==="/api/v1/user-input"){this.pendingList("user_input",url,response);return true;}
      if(request.method==="GET"&&url.pathname==="/api/v1/stream"){this.sse.open(request,response,url);return true;}
      const action=url.pathname.match(/^\/api\/v1\/actions\/([^/]+)$/);
      if(request.method==="GET"&&action){const row=this.store.action(decodeURIComponent(action[1]!));
        if(!row)throw new ApiProblem(404,"action_not_found","action not found");this.ok(response,actionJson(row));return true;}
      const session=url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)(?:\/(runs|events|turns|interrupt))?$/);
      if(session){await this.sessionRoute(request,response,url,principal,decodeURIComponent(session[1]!),session[2]);return true;}
      const approval=url.pathname.match(/^\/api\/v1\/approvals\/([^/]+)(?:\/(decision))?$/);
      if(approval){await this.pendingRoute("approval",request,response,principal,decodeURIComponent(approval[1]!),approval[2]);return true;}
      const input=url.pathname.match(/^\/api\/v1\/user-input\/([^/]+)(?:\/(response))?$/);
      if(input){await this.pendingRoute("user_input",request,response,principal,decodeURIComponent(input[1]!),input[2]);return true;}
      throw new ApiProblem(404,"not_found","endpoint not found");
    } catch(error){this.problem(response,error,requestId);return true;}
  }

  private authenticate(request:IncomingMessage):Principal {
    const header=request.headers.authorization;
    if(!header?.startsWith("Bearer "))throw new ApiProblem(401,"unauthorized","valid bearer token required");
    const token=header.slice(7);
    if(this.options.writeToken&&equalSecret(token,this.options.writeToken))return{id:"control:write",read:true,write:true};
    if(this.options.readToken&&equalSecret(token,this.options.readToken))return{id:"control:read",read:true,write:false};
    if(this.options.workerToken&&equalSecret(token,this.options.workerToken))return{id:"worker:legacy",read:true,write:true};
    throw new ApiProblem(401,"unauthorized","valid bearer token required");
  }

  private workerJson(machine:ReturnType<Store["listMachines"]>[number],agentType:AgentType,label:string):Record<string,unknown>{
    const bridge=this.bridges.get(machine.id);const workspaces=this.legacy.listProjectPaths(machine.id);
    const recent=workspaces.map(path=>{const row=this.store.db.prepare("SELECT MAX(updated_at) AS t,COUNT(*) AS n FROM sessions WHERE machine_id=? AND project_path=?").get(machine.id,path) as {t:number;n:number};return{path,name:path.replace(/[\\/]$/,"").split(/[\\/]/).at(-1)||path,lastUsedAt:Number(row.t),sessionCount:Number(row.n)};});
    const active=Number((this.store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE machine_id=? AND activity_status IN ('active','waiting_for_approval','waiting_for_input')").get(machine.id) as {n:number}).n);
    return{id:buildWorkerId(agentType,machine.id),machineId:machine.id,agentType,name:`${label} @ ${machine.name}`,status:bridge?"online":"offline",
      platform:machine.platform,hostname:machine.hostname,capabilities:[...new Set([...machine.capabilities,...(bridge?.features??[])])],
      workspaces,recentWorkspaces:recent,lastSeenAt:machine.lastSeenAt,bridgeVersion:bridge?.bridgeVersion??null,activeSessionCount:active};
  }
  private machineWorkers(machine:ReturnType<Store["listMachines"]>[number]):Record<string,unknown>[]{
    // Codex is always listed for backward compatibility; Claude appears when the bridge advertises it.
    const rows=[this.workerJson(machine,"codex-cli","Codex")];
    if(machine.capabilities.includes(capabilityForAgent("claude-code")))rows.push(this.workerJson(machine,"claude-code","Claude"));
    return rows;
  }
  private workers(response:ServerResponse):void{this.ok(response,{workers:this.legacy.listMachines().flatMap(m=>this.machineWorkers(m)),streamCursor:this.store.streamCursor()});}
  private snapshot(url:URL,response:ServerResponse):void{
    const limit=integer(url.searchParams.get("sessionLimit"),"sessionLimit",100,1,200);
    this.store.db.exec("BEGIN");try{const sessions=this.store.listSessions({sort:"updatedAt",order:"desc",limit});
      const approvals=this.store.listPending("approval",{statuses:["pending"],limit:200});
      const inputs=this.store.listPending("user_input",{statuses:["pending"],limit:200});
      const body={workers:this.legacy.listMachines().flatMap(m=>this.machineWorkers(m)),sessions:sessions.data,
        approvals:approvals.data.map(pendingJson),userInput:inputs.data.map(pendingJson),streamCursor:this.store.streamCursor(),
        truncated:{sessions:sessions.hasMore}};this.store.db.exec("COMMIT");this.ok(response,body);
    }catch(error){this.store.db.exec("ROLLBACK");throw error;}}
  private sessions(url:URL,response:ServerResponse):void{
    const workerId=url.searchParams.get("workerId")??undefined,machineId=url.searchParams.get("machineId")??undefined;
    const parsedWorker=workerId?parseWorkerId(workerId):undefined;
    if(workerId&&(!parsedWorker||!agentTypeForWorkerPrefix(parsedWorker.prefix)||Boolean(machineId&&parsedWorker.machineId!==machineId)))throw new ApiProblem(400,"invalid_worker_id","workerId and machineId must agree");
    const sort=url.searchParams.get("sort")??"updatedAt";if(!["updatedAt","createdAt"].includes(sort))throw new ApiProblem(400,"invalid_parameter","invalid sort");
    const order=url.searchParams.get("order")??"desc";if(!["asc","desc"].includes(order))throw new ApiProblem(400,"invalid_parameter","invalid order");
    const active=url.searchParams.get("active");if(active!==null&&!['true','false'].includes(active))throw new ApiProblem(400,"invalid_parameter","active must be boolean");
    const statuses=url.searchParams.getAll("status"),validStatuses=new Set(["creating","active","waiting_for_approval","waiting_for_input","idle","offline","error","unknown"]);
    if(statuses.some(value=>!validStatuses.has(value)))throw new ApiProblem(400,"invalid_parameter","invalid session status");
    const updatedAfter=url.searchParams.get("updatedAfter");if(updatedAfter!==null&&!Number.isFinite(Number(updatedAfter)))throw new ApiProblem(400,"invalid_parameter","updatedAfter must be epoch milliseconds");
    const segment=url.searchParams.get("segment")??"all";if(!["recent","history","all"].includes(segment))throw new ApiProblem(400,"invalid_parameter","invalid segment");
    const dayStart=url.searchParams.get("dayStart");if(dayStart!==null&&!Number.isFinite(Number(dayStart)))throw new ApiProblem(400,"invalid_parameter","dayStart must be epoch milliseconds");
    if(segment!=="all"&&dayStart===null)throw new ApiProblem(400,"invalid_parameter","dayStart is required for segmented session lists");
    try{const page=this.store.listSessions({statuses,agents:url.searchParams.getAll("agent"),workerId,machineId,
      workspace:url.searchParams.get("workspace")??undefined,taskId:url.searchParams.get("taskId")??undefined,
      conversationId:url.searchParams.get("conversationId")??undefined,active:active===null?undefined:active==="true",
      updatedAfter:updatedAfter!==null?Number(updatedAfter):undefined,
      dayStart:dayStart!==null?Number(dayStart):undefined,segment:segment as "recent"|"history"|"all",
      q:url.searchParams.get("q")??undefined,sort:sort as "updatedAt"|"createdAt",order:order as "asc"|"desc",
      limit:integer(url.searchParams.get("limit"),"limit",50,1,200),cursor:url.searchParams.get("cursor")??undefined});
      this.ok(response,{...page,streamCursor:this.store.streamCursor()});}catch(error){this.cursorError(error);}
  }

  private requireKey(request:IncomingMessage):string {
    const value=request.headers["idempotency-key"];
    if(typeof value!=="string"||value.length<1||value.length>128||!/^[\x20-\x7e]+$/.test(value))
      throw new ApiProblem(400,"idempotency_key_required","a printable 1..128 character Idempotency-Key is required");
    return value;
  }

  private createAction(principal:Principal,key:string,path:string,body:unknown,kind:ActionKind,machineId:string,
    sessionId?:string,method:"POST"|"DELETE"="POST"):{action:ActionRow;existing:boolean}{
    return this.actions.create({principal:principal.id,key,path,body,kind,machineId,sessionId,method});
  }
  private existingAction(principal:Principal,key:string,path:string,body:unknown,method:"POST"|"DELETE"="POST"):ActionRow|undefined{
    return this.actions.existing(principal.id,key,method,path,body);
  }

  private dispatch(action:ActionRow,message:ControlToBridgeMessage):void {
    this.actions.dispatch(action,message);
  }
  private requireActionBridge(machineId:string):void{
    this.actions.requireBridge(machineId);
  }

  private async createSession(request:IncomingMessage,response:ServerResponse,principal:Principal):Promise<void>{
    const key=this.requireKey(request),body=await jsonBody(request),workerId=string(body.workerId,"workerId",true)!;
    const prior=this.existingAction(principal,key,"/api/v1/sessions",body);if(prior){this.ok(response,actionJson(prior),202);return;}
    const parsed=parseWorkerId(workerId);const agentType=parsed?agentTypeForWorkerPrefix(parsed.prefix):undefined;
    if(!parsed||!agentType)throw new ApiProblem(400,"invalid_worker_id","workerId must be <codex|claude>@machine");
    const machineId=parsed.machineId,workspace=string(body.workspace,"workspace",true)!,input=string(body.input,"input"),
      model=string(body.model,"model");
    this.requireActionBridge(machineId);
    const created=this.createAction(principal,key,"/api/v1/sessions",body,"create_session",machineId);
    if(!created.existing)this.dispatch(created.action,{type:"action.create_session",actionId:created.action.actionId,agentType,projectPath:workspace,input,model});
    this.ok(response,actionJson(this.store.action(created.action.actionId)!),202);
  }

  private async sessionRoute(request:IncomingMessage,response:ServerResponse,url:URL,principal:Principal,
    sessionId:string,action?:string):Promise<void>{
    if(request.method==="DELETE"&&!action){
      const key=this.requireKey(request),body=await jsonBody(request),path=`/api/v1/sessions/${sessionId}`;
      const prior=this.existingAction(principal,key,path,body,"DELETE");if(prior){this.ok(response,actionJson(prior),202);return;}
      const session=this.store.session(sessionId);if(!session)throw new ApiProblem(404,"session_not_found","session not found");
      if(["creating","active","waiting_for_approval","waiting_for_input"].includes(String(session.status)))
        throw new ApiProblem(409,"session_active","interrupt or resolve the active session before deleting it");
      const machineId=String(session.machineId);this.requireActionBridge(machineId);
      const created=this.createAction(principal,key,path,body,"delete_session",machineId,sessionId,"DELETE");
      if(!created.existing)this.dispatch(created.action,{type:"action.delete_session",actionId:created.action.actionId,sessionId});
      this.ok(response,actionJson(this.store.action(created.action.actionId)!),202);return;
    }
    const session=this.store.session(sessionId);if(!session)throw new ApiProblem(404,"session_not_found","session not found");
    if(request.method==="GET"&&!action){const bridge=this.bridges.get(String(session.machineId));session.capabilities=[...new Set([...(bridge?.capabilities??[]),...(bridge?.features??[])])];this.ok(response,session);return;}
    if(request.method==="GET"&&action==="runs"){this.sessionRuns(sessionId,url,response);return;}
    if(request.method==="GET"&&action==="events"){
      try{const tail=url.searchParams.get("tail")==="true";const page=tail
        ?this.store.sessionEventsTail(sessionId,url.searchParams.get("before")??undefined,
          integer(url.searchParams.get("limit"),"limit",100,1,500),url.searchParams.getAll("type"))
        :this.store.sessionEvents(sessionId,url.searchParams.get("after")??undefined,
          integer(url.searchParams.get("limit"),"limit",100,1,500),url.searchParams.getAll("type"));
        this.ok(response,{...page,streamCursor:this.store.streamCursor()});}catch(error){this.cursorError(error);}return;
    }
    if(request.method==="POST"&&action==="turns"){await this.submitTurn(request,response,principal,session);return;}
    if(request.method==="POST"&&action==="interrupt"){await this.interrupt(request,response,principal,session);return;}
    throw new ApiProblem(404,"not_found","endpoint not found");
  }

  private async submitTurn(request:IncomingMessage,response:ServerResponse,principal:Principal,
    session:Record<string,unknown>):Promise<void>{
    const key=this.requireKey(request),body=await jsonBody(request),input=string(body.input,"input",true)!;
    const path=`/api/v1/sessions/${session.sessionId}/turns`,prior=this.existingAction(principal,key,path,body);
    if(prior){this.ok(response,actionJson(prior),202);return;}
    const delivery=body.delivery??"auto";if(!["auto","steer","start_turn"].includes(String(delivery)))throw new ApiProblem(400,"invalid_parameter","invalid delivery");
    const expected=string(body.expectedTurnId,"expectedTurnId"),model=string(body.model,"model"),reasoningEffort=string(body.reasoningEffort,"reasoningEffort"),
      active=typeof session.activeTurnId==="string"?session.activeTurnId:undefined;
    if(Number(session.pendingApprovalCount)>0)throw new ApiProblem(409,"approval_pending","resolve pending approval first");
    if(Number(session.pendingUserInputCount)>0)throw new ApiProblem(409,"user_input_pending","resolve pending user input first");
    if(expected&&expected!==active)throw new ApiProblem(409,"turn_changed","active turn changed",false,{activeTurnId:active??null});
    if(delivery==="steer"&&!active)throw new ApiProblem(409,"no_active_turn","session has no active turn");
    if(delivery==="start_turn"&&active)throw new ApiProblem(409,"turn_already_active","session already has an active turn",false,{activeTurnId:active});
    if((model||reasoningEffort)&&active)throw new ApiProblem(409,"model_not_applicable","model and reasoning effort cannot be changed while steering an active turn");
    const machineId=String(session.machineId);this.requireActionBridge(machineId);
    const created=this.createAction(principal,key,path,body,"submit_turn",machineId,String(session.sessionId));
    if(!created.existing)this.dispatch(created.action,{type:"action.submit_turn",actionId:created.action.actionId,
      sessionId:String(session.sessionId),input,delivery:delivery as "auto"|"steer"|"start_turn",expectedTurnId:expected,model,reasoningEffort});
    this.ok(response,actionJson(this.store.action(created.action.actionId)!),202);
  }

  private async interrupt(request:IncomingMessage,response:ServerResponse,principal:Principal,
    session:Record<string,unknown>):Promise<void>{
    const key=this.requireKey(request),body=await jsonBody(request),expected=string(body.expectedTurnId,"expectedTurnId");
    const path=`/api/v1/sessions/${session.sessionId}/interrupt`,prior=this.existingAction(principal,key,path,body);
    if(prior){this.ok(response,actionJson(prior),202);return;}
    const active=typeof session.activeTurnId==="string"?session.activeTurnId:undefined;
    if(!active)throw new ApiProblem(409,"no_active_turn","session has no active turn");
    if(expected&&expected!==active)throw new ApiProblem(409,"turn_changed","active turn changed",false,{activeTurnId:active});
    const machineId=String(session.machineId);this.requireActionBridge(machineId);
    const created=this.createAction(principal,key,path,body,"interrupt_turn",machineId,String(session.sessionId));
    if(!created.existing)this.dispatch(created.action,{type:"action.interrupt_turn",actionId:created.action.actionId,
      sessionId:String(session.sessionId),expectedTurnId:expected});
    this.ok(response,actionJson(this.store.action(created.action.actionId)!),202);
  }

  private sessionRuns(sessionId:string,url:URL,response:ServerResponse):void{
    const limit=integer(url.searchParams.get("limit"),"limit",50,1,200),scope=`session-runs:${sessionId}`;let before:undefined|[number,string];
    const cursor=url.searchParams.get("cursor");if(cursor)before=readPageCursor(cursor,scope);
    const rows=this.store.db.prepare(`SELECT * FROM worker_runs WHERE session_id=? ${before?"AND (created_at<? OR (created_at=? AND id<?))":""} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...(before?[sessionId,before[0],before[0],before[1],limit+1]:[sessionId,limit+1])) as Record<string,unknown>[];
    const hasMore=rows.length>limit;if(hasMore)rows.pop();const data=rows.map(row=>this.runJson(row));const last=rows.at(-1);
    this.ok(response,{data,hasMore,nextCursor:hasMore&&last?pageCursor(scope,Number(last.created_at),String(last.id)):null,streamCursor:this.store.streamCursor()});
  }

  private runs(url:URL,response:ServerResponse):void{
    const limit=integer(url.searchParams.get("limit"),"limit",50,1,200),where:string[]=[],params:any[]=[];
    const fields:[[string,string],...Array<[string,string]>]=[["sessionId","session_id"],["taskId","task_id"],["conversationId","conversation_id"],["machineId","machine_id"]];
    for(const [query,column] of fields){const value=url.searchParams.get(query);if(value){where.push(`${column}=?`);params.push(value);}}
    const workerId=url.searchParams.get("workerId");if(workerId){const parsed=parseWorkerId(workerId);if(!parsed)throw new ApiProblem(400,"invalid_worker_id","invalid workerId");where.push("machine_id=?");params.push(parsed.machineId);}
    const statuses=url.searchParams.getAll("status"),valid=new Set(["starting","update_waiting","update_required","update_failed","working","waiting","blocked","completed","failed","stopped","unknown"]);
    if(statuses.some(value=>!valid.has(value)))throw new ApiProblem(400,"invalid_parameter","invalid run status");
    if(statuses.length){where.push(`status IN (${statuses.map(()=>"?").join(",")})`);params.push(...statuses);}
    const after=url.searchParams.get("createdAfter");if(after){const value=Number(after);
      if(!Number.isFinite(value))throw new ApiProblem(400,"invalid_parameter","createdAfter must be epoch milliseconds");
      where.push("created_at>?");params.push(value);}
    const scope=queryScope("runs",url);let before:undefined|[number,string];const cursor=url.searchParams.get("cursor");if(cursor){before=readPageCursor(cursor,scope);where.push("(created_at<? OR (created_at=? AND id<?))");params.push(before[0],before[0],before[1]);}
    const rows=this.store.db.prepare(`SELECT * FROM worker_runs ${where.length?`WHERE ${where.join(" AND ")}`:""} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params,limit+1) as Record<string,unknown>[];
    const hasMore=rows.length>limit;if(hasMore)rows.pop();const data=rows.map(row=>this.runJson(row));const last=rows.at(-1);
    this.ok(response,{data,hasMore,nextCursor:hasMore&&last?pageCursor(scope,Number(last.created_at),String(last.id)):null,streamCursor:this.store.streamCursor()});
  }

  private runJson(row:Record<string,unknown>):Record<string,unknown>{return{runId:String(row.id),taskId:row.task_id?String(row.task_id):null,
    conversationId:row.conversation_id?String(row.conversation_id):null,workerId:buildWorkerId(String(row.agent_type) as AgentType,String(row.machine_id)),machineId:String(row.machine_id),
    agent:String(row.agent_type),workspace:String(row.project_path),sessionId:row.session_id?String(row.session_id):null,status:String(row.status),
    error:row.error?String(row.error):null,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)};}

  private pendingList(kind:"approval"|"user_input",url:URL,response:ServerResponse):void{
    const statuses=url.searchParams.getAll("status").length?url.searchParams.getAll("status"):["pending"],valid=new Set(["pending","accepted","denied","resolved_elsewhere","expired"]);
    if(statuses.some(value=>!valid.has(value)))throw new ApiProblem(400,"invalid_parameter","invalid pending status");
    const workerId=url.searchParams.get("workerId"),machineId=url.searchParams.get("machineId");
    const parsedWorker=workerId?parseWorkerId(workerId):undefined;
    if(workerId&&(!parsedWorker||Boolean(machineId&&parsedWorker.machineId!==machineId)))
      throw new ApiProblem(400,"invalid_worker_id","workerId and machineId must agree");
    try{const page=this.store.listPending(kind,{statuses,
      sessionId:url.searchParams.get("sessionId")??undefined,runId:url.searchParams.get("runId")??undefined,
      machineId:machineId??parsedWorker?.machineId,
      limit:integer(url.searchParams.get("limit"),"limit",50,1,200),cursor:url.searchParams.get("cursor")??undefined});
      this.ok(response,{data:page.data.map(pendingJson),nextCursor:page.nextCursor,hasMore:page.hasMore,streamCursor:this.store.streamCursor()});
    }catch(error){this.cursorError(error);}}

  private async pendingRoute(kind:"approval"|"user_input",request:IncomingMessage,response:ServerResponse,
    principal:Principal,id:string,action?:string):Promise<void>{
    const pending=this.store.pending(id);if(!pending||pending.kind!==kind)throw new ApiProblem(404,kind==="approval"?"approval_not_found":"user_input_not_found","pending request not found");
    if(request.method==="GET"&&!action){this.ok(response,pendingJson(pending));return;}
    if(request.method!=="POST"||(kind==="approval"&&action!=="decision")||(kind==="user_input"&&action!=="response"))
      throw new ApiProblem(404,"not_found","endpoint not found");
    const key=this.requireKey(request),body=await jsonBody(request);
    const path=kind==="approval"?`/api/v1/approvals/${id}/decision`:`/api/v1/user-input/${id}/response`;
    const existing=this.existingAction(principal,key,path,body);if(existing){this.ok(response,actionJson(existing),202);return;}
    if(pending.status!=="pending")throw new ApiProblem(409,kind==="approval"?"approval_already_resolved":"user_input_already_resolved","request was already resolved",false,{status:pending.status,resolvedAt:pending.resolvedAt});
    this.requireActionBridge(pending.machineId);
    if(kind==="approval"){
      const choice=string(body.choice,"choice",true)!;const choices=pending.request.choices;
      if(!Array.isArray(choices)||!choices.includes(choice))throw new ApiProblem(400,"invalid_choice","choice is not offered",false,{choices});
      const created=this.createAction(principal,key,path,body,"resolve_approval",pending.machineId,pending.sessionId);
      if(!this.store.reservePending(id,created.action.actionId)){
        if(!created.existing)this.store.completeAction({type:"action.result",actionId:created.action.actionId,kind:"resolve_approval",status:"failed",sessionId:pending.sessionId,error:{code:"approval_already_resolved",message:"approval resolution is already in progress",retryable:false},timestamp:Date.now()});
        throw new ApiProblem(409,"approval_already_resolved","approval resolution is already in progress");
      }
      if(!created.existing)this.dispatch(created.action,{type:"action.resolve_approval",actionId:created.action.actionId,
        sessionId:pending.sessionId,approvalId:id,choice:choice as "allow"|"deny"|"allow-session"});
      this.ok(response,actionJson(this.store.action(created.action.actionId)!),202);return;
    }
    const questions=Array.isArray(pending.request.questions)?pending.request.questions as Array<Record<string,unknown>>:[];
    if(questions.some(question=>question.isSecret===true))throw new ApiProblem(409,"secret_input_unsupported","secret input must be answered locally");
    const answers=body.answers;if(!answers||typeof answers!=="object"||Array.isArray(answers))throw new ApiProblem(400,"invalid_parameter","answers object is required");
    const answerRecord=answers as Record<string,{answers?:unknown}>;
    if(Object.keys(answerRecord).length!==questions.length||questions.some(question=>{
      const value=answerRecord[String(question.id)];return !value||!Array.isArray(value.answers)||value.answers.length<1||value.answers.some(item=>typeof item!=="string"||!item.trim());
    }))throw new ApiProblem(400,"invalid_parameter","each question requires non-empty answers");
    for(const question of questions){const options=Array.isArray(question.options)?question.options as Array<Record<string,unknown>>:[];
      if(options.length&&question.isOther!==true){const labels=new Set(options.map(option=>String(option.label)));
        if((answerRecord[String(question.id)]!.answers as string[]).some(answer=>!labels.has(answer)))
          throw new ApiProblem(400,"invalid_parameter",`answer for ${String(question.id)} must use an offered label`);}}
    const created=this.createAction(principal,key,path,body,"resolve_user_input",pending.machineId,pending.sessionId);
    if(!this.store.reservePending(id,created.action.actionId)){
      if(!created.existing)this.store.completeAction({type:"action.result",actionId:created.action.actionId,kind:"resolve_user_input",status:"failed",sessionId:pending.sessionId,error:{code:"user_input_already_resolved",message:"user input resolution is already in progress",retryable:false},timestamp:Date.now()});
      throw new ApiProblem(409,"user_input_already_resolved","user input resolution is already in progress");
    }
    if(!created.existing)this.dispatch(created.action,{type:"action.resolve_user_input",actionId:created.action.actionId,
      sessionId:pending.sessionId,requestId:id,answers:answerRecord as Record<string,{answers:string[]}>});
    this.ok(response,actionJson(this.store.action(created.action.actionId)!),202);
  }

  private cursorError(error:unknown):never {
    if(error instanceof Error&&error.message==="invalid_cursor")throw new ApiProblem(400,"invalid_cursor","invalid cursor");
    if(error instanceof Error&&error.message==="cursor_expired")throw new ApiProblem(410,"cursor_expired","cursor is outside the replay window");
    throw error;
  }
  private ok(response:ServerResponse,body:unknown,status=200):void{response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});response.end(JSON.stringify(body));}
  private problem(response:ServerResponse,error:unknown,requestId:string):void{
    const problem=error instanceof ApiProblem?error:error instanceof ActionServiceError
      ?new ApiProblem(error.status,error.code,error.message,error.retryable,error.details):error instanceof SseCursorError
      ?new ApiProblem(error.code==="cursor_expired"?410:400,error.code,error.message):new ApiProblem(500,"internal_error","internal error",true);
    if(!response.headersSent)this.ok(response,{error:{code:problem.code,message:problem.message,requestId,details:problem.details,retryable:problem.retryable}},problem.status);
    else response.end();
  }
}
