import type { IncomingMessage } from "node:http";
import type { AttachmentRef } from "@agent-bridge/protocol";

export class ApiProblem extends Error {
  constructor(readonly status:number,readonly code:string,message:string,readonly retryable=false,
    readonly details?:Record<string,unknown>){super(message);}
}

/** Base64-inflated image uploads need more than the default JSON limit. */
export const MAX_JSON_BODY_BYTES = 24_000_000;
/** Attachment (image) upload limits — the control-plane is the authority. */
export const IMAGE_MIME_ALLOWLIST = ["image/png","image/jpeg","image/webp","image/gif"] as const;
export const MAX_IMAGE_BYTES = 15_000_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** Validate a `POST /attachments` body: `{filename, content(base64), mimeType}`. */
export function uploadRequest(body:Record<string,unknown>):{filename:string;mimeType:string;bytes:Buffer}{
  const filename=stringField(body.filename,"filename",true)!.slice(0,255);
  const mimeType=stringField(body.mimeType,"mimeType",true)!;
  if(!(IMAGE_MIME_ALLOWLIST as readonly string[]).includes(mimeType))
    throw new ApiProblem(400,"unsupported_media_type",`mimeType must be one of ${IMAGE_MIME_ALLOWLIST.join(", ")}`);
  const content=stringField(body.content,"content",true)!;
  let bytes:Buffer;
  try{bytes=Buffer.from(content,"base64");}catch{throw new ApiProblem(400,"invalid_parameter","content must be base64");}
  if(!bytes.length)throw new ApiProblem(400,"invalid_parameter","content decoded to empty bytes");
  if(bytes.length>MAX_IMAGE_BYTES)throw new ApiProblem(413,"body_too_large",`image exceeds ${MAX_IMAGE_BYTES} bytes`);
  return {filename,mimeType,bytes};
}

/** Validate an optional `attachments: AttachmentRef[]` field on an input-carrying body. */
export function attachmentsField(value:unknown):AttachmentRef[]|undefined{
  if(value===undefined||value===null)return undefined;
  if(!Array.isArray(value))throw new ApiProblem(400,"invalid_parameter","attachments must be an array");
  if(value.length>MAX_ATTACHMENTS_PER_MESSAGE)throw new ApiProblem(400,"invalid_parameter",`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
  return value.map((item)=>{
    if(!item||typeof item!=="object")throw new ApiProblem(400,"invalid_parameter","attachment must be an object");
    const row=item as Record<string,unknown>;
    return {
      id:stringField(row.id,"attachment.id",true)!,
      filename:stringField(row.filename,"attachment.filename",true)!,
      mimeType:stringField(row.mimeType,"attachment.mimeType",true)!,
      size:typeof row.size==="number"&&Number.isFinite(row.size)?row.size:0,
    };
  });
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
    if(size>MAX_JSON_BODY_BYTES)throw new ApiProblem(413,"body_too_large","request body too large");chunks.push(part);}
    if(!chunks.length)return {};const value:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();return value as Record<string,unknown>;
  }catch(error){if(error instanceof ApiProblem)throw error;throw new ApiProblem(400,"invalid_json","request body must be a JSON object");}
}
