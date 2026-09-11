import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BridgeClient } from '../bridge-client.js'
import type { JsonObject } from '../types.js'
import { record, str } from './mapping.js'

/** Read durable DSH image objects through their owner; never reinterpret a ref as a path. */
export async function uploadPromptImages(options: GenerateOptions, agent: Agent,
  bridge: Pick<BridgeClient, 'call'>, signal: AbortSignal): Promise<JsonObject[]> {
  const message = [...options.messages].reverse().find(row => row.role === 'user' && row.source?.kind === 'user')
    ?? [...options.messages].reverse().find(row => row.role === 'user')
  const images: JsonObject[] = []
  const uploaded = new Map<string, JsonObject>()
  for (const block of message?.content ?? []) {
    if (block.type === 'text') continue
    if (block.type !== 'image') throw new Error('Bridge currently accepts text and image attachments only')
    const ref = block.attachment
    let attachment = uploaded.get(String(ref.attachmentId))
    if (!attachment) {
      const store = agent.ctx.get('attachments') as unknown as {
        readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; ref: { mediaType: string; name?: string } }>
      } | undefined
      if (!store) throw new Error('DSH image attachment storage is unavailable')
      const stored = await store.readImage(ref, signal)
      signal.throwIfAborted()
      attachment = record(await bridge.call({ operation: 'upload', args: {
        filename: stored.ref.name || 'image.' + stored.ref.mediaType.split('/')[1],
        mimeType: stored.ref.mediaType, content: Buffer.from(stored.data).toString('base64'),
      } }, signal))
      if (!str(attachment['id']) || !str(attachment['mimeType'])) throw new Error('Bridge returned an invalid uploaded image reference')
      uploaded.set(String(ref.attachmentId), attachment)
    }
    images.push(attachment)
  }
  return images
}
