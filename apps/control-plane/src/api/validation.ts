import type { IncomingMessage } from "node:http";

export class ApiProblem extends Error {
  constructor(readonly status:number,readonly code:string,message:string,readonly retryable=false,
    readonly details?:Record<string,unknown>){super(message);}
}

export function stringField(value:unknown,name:string,required=false):string|undefined{
  if(value===undefined&&!required)return undefined;
  if(typeof value!=="string"||!value.trim())throw new ApiProblem(400,"invalid_parameter",`${name} must be a non-empty string`);
  return value;
}

export function integerParam(value:string|null,name:string,fallback:number,min:number,max:number):number{
  if(value==null)return fallback;const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new ApiProblem(400,"invalid_parameter",`${name} must be ${min}..${max}`);
  return parsed;
}

export async function jsonBody(request:IncomingMessage):Promise<Record<string,unknown>>{
  const contentType=request.headers["content-type"]?.split(";",1)[0]?.trim().toLowerCase();
  if(contentType!=="application/json")throw new ApiProblem(415,"unsupported_media_type","Content-Type must be application/json");
  const chunks:Buffer[]=[];let size=0;
  try{for await(const chunk of request){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=part.length;
    if(size>1_000_000)throw new ApiProblem(413,"body_too_large","request body exceeds 1 MiB");chunks.push(part);}
    if(!chunks.length)return {};const value:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();return value as Record<string,unknown>;
  }catch(error){if(error instanceof ApiProblem)throw error;throw new ApiProblem(400,"invalid_json","request body must be a JSON object");}
}
