import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { markerFromSummary } from './marker.js'
import { CHECKPOINT_OPENINGS } from './checkpoint-frame.js'

export function checkpointMatches(summary, content) {
  if (!Array.isArray(summary) || !summary.length || !Array.isArray(content)) return false
  if (isDeepStrictEqual(summary, content)) return true
  // dsh-compaction-basic frames the exact summary blocks, without rewriting
  // their text or accepting an arbitrary prefix/suffix supplied by a model.
  return content.length === summary.length + 2
    && CHECKPOINT_OPENINGS.some(text=>isDeepStrictEqual(content[0], {type:'text',text}))
    && isDeepStrictEqual(content.at(-1), { type: 'text', text: '</compacted-summary>' })
    && isDeepStrictEqual(content.slice(1, -1), summary)
}
const identityDigest = fields => 'lcm-native-' + createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 40)
// A native checkpoint's identity must be a function of the durable record it
// names. Including the indexing session id made it lineage-specific: a fork
// inherits the record but re-derives the hash under its own id, so the
// inherited prepared tree could not be verified there.
export const nativeIdentity = event => identityDigest([event.data?.compactionId, event.seq, event.data?.summary])
// Identity written by releases that hashed the indexing session id. It is still
// the stored id of nodes indexed before nativeIdentity, and still the id a fork
// parent recorded in trees it produced; used only to recognize that form.
export const legacyNativeIdentity = (sessionId, event) => identityDigest([sessionId, event.data?.compactionId, event.seq, event.data?.summary])
export const summaryIdentity = (event, identities) => markerFromSummary(event.data?.summary)?.id ?? identities?.get(event.seq) ?? nativeIdentity(event)
export function legacyIdentities(store, sessionId, records) {
  const unmarked = new Map(records.filter(record => markerFromSummary(record.summary.data?.summary) === null).map(record => [record.summary.seq, record.summary]))
  const identities = new Map()
  if (!unmarked.size) return identities
  for (const id of store.listNodeIds(sessionId)) {
    const node = store.getNode(sessionId, id), event = unmarked.get(node.summarySeq)
    if (!event || node.compactionId !== event.data?.compactionId || !isDeepStrictEqual(node.summary, event.data?.summary)) continue
    if (identities.has(event.seq)) throw Error('Legacy compaction has more than one verified summary node')
    identities.set(event.seq, node.nodeId)
  }
  return identities
}
