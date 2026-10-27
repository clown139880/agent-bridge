/** Only ASCII filename-safe characters: also accepted by DSH SessionId. */
export const VIRTUAL_PREFIX = 'bridge-remote-'
export const isVirtualSession = (id: unknown): id is `bridge-remote-${string}` => typeof id === 'string' && id.startsWith(VIRTUAL_PREFIX)
