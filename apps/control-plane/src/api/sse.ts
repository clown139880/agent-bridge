import type { IncomingMessage, ServerResponse } from "node:http";
import { streamSignal, type AgentControlStore, type StreamPosition } from "@agent-bridge/database";

export class SseCursorError extends Error {
  constructor(readonly code: "invalid_cursor"|"cursor_expired") { super(code); }
}

const BATCH = 200;

export class AgentControlSse {
  constructor(private readonly store:AgentControlStore,private readonly options:{
    keepaliveMs:number;pollMs:number;maxBackpressure:number;
  }){}

  open(request:IncomingMessage,response:ServerResponse,url:URL):void{
    const header=request.headers["last-event-id"],cursor=typeof header==="string"?header:(url.searchParams.get("cursor")??undefined);
    let position:StreamPosition;try{position=cursor?this.store.parseStreamCursor(cursor):this.store.streamPosition();}
    catch(error){if(error instanceof Error&&(error.message==="invalid_cursor"||error.message==="cursor_expired"))throw new SseCursorError(error.message);throw error;}
    response.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",
      connection:"keep-alive","x-accel-buffering":"no"});response.write("retry: 3000\n\n");
    let closed=false,busy=false,backpressure=0,lastWrite=Date.now();
    const close=()=>{if(closed)return;closed=true;clearInterval(timer);streamSignal.off("change",tick);response.end();};
    // Writes wake every open stream at once; the interval only covers keepalive and a missed wakeup.
    const tick=()=>{if(closed||busy)return;busy=true;try{
      for(;;){
        const batch=this.store.streamAfter(position,BATCH);
        for(const item of batch.items){
          const envelope={cursor:item.cursor,eventId:item.eventId,type:item.type,timestamp:item.createdAt,
            resource:{kind:item.resourceKind,id:item.resourceId},sessionId:item.sessionId,data:item.payload};
          const writable=response.write(`id: ${item.cursor}\nevent: bridge.event\ndata: ${JSON.stringify(envelope)}\n\n`);
          lastWrite=Date.now();
          if(writable)backpressure=0;else if(++backpressure>=this.options.maxBackpressure){close();return;}
        }
        const advanced=batch.position.events!==position.events||batch.position.changes!==position.changes;
        position=batch.position;
        if(!advanced)break;
      }
      if(Date.now()-lastWrite>=this.options.keepaliveMs){response.write(": keepalive\n\n");lastWrite=Date.now();}
    }catch{close();}finally{busy=false;}};
    const timer=setInterval(tick,Math.min(this.options.pollMs,this.options.keepaliveMs));timer.unref();
    streamSignal.on("change",tick);tick();
    request.on("close",()=>{closed=true;clearInterval(timer);streamSignal.off("change",tick);});
  }
}
