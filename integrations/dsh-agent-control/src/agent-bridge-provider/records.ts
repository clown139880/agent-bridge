import * as sessionApi from '@deepseek-ai/dsh-session'
import type { JsonObject } from '../types.js'

// V4 gives opaque plugin state its own append API and namespace. Keep reading
// the old names too: older runtimes and retained V3 logs still contain them.
const appendRecord = (sessionApi as unknown as {
  appendPluginRecord?: (session: unknown, type: string, data: JsonObject) => unknown
}).appendPluginRecord
export const requiresSystemHead = Number(sessionApi.SESSION_FORMAT_VERSION) >= 4
export const BINDING_EVENT = 'agent-bridge/binding'
export const ACK_EVENT = 'agent-bridge/event'
export const isBridgeRecord = (type: string, expected?: string): boolean =>
  expected ? type === expected || type === 'plugin:' + expected
    : isBridgeRecord(type, BINDING_EVENT) || isBridgeRecord(type, ACK_EVENT)
export const bridgeRecordType = (type: string): string => appendRecord && !type.startsWith('plugin:') ? 'plugin:' + type : type
export function appendBridgeRecord(session: { append(type: string, data: JsonObject): unknown }, type: string, data: JsonObject): void {
  if (appendRecord) appendRecord(session, bridgeRecordType(type), data)
  else session.append(type, data)
}
