import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentControlStore } from "@agent-bridge/database";

export class SseCursorError extends Error {
  constructor(readonly code: "invalid_cursor"|"cursor_expired") { super(code); }
}

export class AgentControlSse {
  constructor(private readonly store:AgentControlStore,private readonly options:{
    keepaliveMs:number;pollMs:number;maxBackpressure:number;
  }){}

  open(request:IncomingMessage,response:ServerResponse,url:URL):void{
    const header=request.headers["last-event-id"],cursor=typeof header==="string"?header:(url.searchParams.get("cursor")??undefined);
    let after:number;try{after=this.store.parseStreamCursor(cursor);this.store.streamAfter(after,1);}
    catch(error){if(error instanceof Error&&(error.message==="invalid_cursor"||error.message==="cursor_expired"))throw new SseCursorError(error.message);throw error;}
    response.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",
      connection:"keep-alive","x-accel-buffering":"no"});response.write("retry: 3000\n\n");
    let closed=false,busy=false,backpressure=0,lastKeepalive=Date.now();
    const tick=()=>{if(closed||busy)return;busy=true;try{
      for(const row of this.store.streamAfter(after,200)){
        const envelope={cursor:`g:${row.sequence}`,eventId:row.eventId,type:row.type,timestamp:row.createdAt,
          resource:{kind:row.resourceKind,id:row.resourceId},sessionId:row.sessionId,data:row.payload};
        const writable=response.write(`id: g:${row.sequence}\nevent: bridge.event\ndata: ${JSON.stringify(envelope)}\n\n`);
        after=row.sequence;if(!writable){backpressure+=1;if(backpressure>=this.options.maxBackpressure){response.end();closed=true;break;}}else backpressure=0;
      }
      if(!closed&&Date.now()-lastKeepalive>=this.options.keepaliveMs){response.write(": keepalive\n\n");lastKeepalive=Date.now();}
    }catch{response.end();closed=true;}finally{busy=false;}};
    const timer=setInterval(tick,this.options.pollMs);timer.unref();tick();
    request.on("close",()=>{closed=true;clearInterval(timer);});
  }
}
