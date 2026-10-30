import test from 'node:test'
import assert from 'node:assert/strict'
import { reindexSession, doctorSession } from '../dsh/core.js'
import { SuperLcmStore } from '../dsh/store.js'
import { encodeMarker } from '../dsh/marker.js'
import { legacyNativeIdentity, nativeIdentity } from '../dsh/legacy-checkpoints.js'

// A fork inherits the events of its parent, so a checkpoint summary written by
// the parent arrives unchanged in the child. Its identity must be derivable
// from that record alone; a lineage-specific identity could not be verified by
// the fork that inherits it.

const PARENT = 'session-fork-parent'
const CHILD = 'session-fork-child'
const text = value => ({ type: 'text', text: value })

function conversation() {
  return Array.from({ length: 6 }, (_, seq) => ({
    type: 'user/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { role: 'user', id: 'message-' + seq, content: [text('message ' + seq)] },
  }))
}

// An engine-produced native DSH compaction: no SuperLcm marker anywhere, so its
// node identity is the derived fallback rather than a marker id.
function nativeCompaction(baseSeq, compactionId, summary) {
  const shadowedSeqs = [0, 1, 2, 3, 4, 5]
  return [
    { type: 'compaction/start', seq: baseSeq, time: 1_700_000_001_000, data: { compactionId, turn: 1 } },
    {
      type: 'compaction/summary',
      seq: baseSeq + 1,
      time: 1_700_000_001_001,
      data: { compactionId, summary, shadowedRange: { start: 0, end: 5 }, shadowedSeqs },
    },
    {
      type: 'user/message',
      seq: baseSeq + 2,
      time: 1_700_000_001_002,
      data: { role: 'user', id: 'checkpoint-' + compactionId, content: summary, source: { kind: 'compact-checkpoint', compactionId } },
      sourceEventSeqs: [...shadowedSeqs, baseSeq, baseSeq + 1],
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 5 },
    },
    { type: 'compaction/end', seq: baseSeq + 3, time: 1_700_000_001_003, data: { compactionId, turn: 1 } },
  ]
}

// The compaction a fork performs on top of inherited history. Its root leaf
// names the inherited native checkpoint exactly as the producing session did.
function forkCompaction(baseSeq, childIds) {
  const summary = [text('condensed fork summary ' + encodeMarker({ id: 'lcm-fork-root', children: childIds }))]
  return [
    { type: 'compaction/start', seq: baseSeq, time: 1_700_000_002_000, data: { compactionId: 'compaction-fork', turn: 2 } },
    {
      type: 'compaction/summary',
      seq: baseSeq + 1,
      time: 1_700_000_002_001,
      data: {
        compactionId: 'compaction-fork',
        summary,
        summaryTreeKind: 'leaf',
        shadowedRange: { start: 8, end: 8 },
        shadowedSeqs: [8],
        preparedTree: [],
      },
    },
    {
      type: 'user/message',
      seq: baseSeq + 2,
      time: 1_700_000_002_002,
      data: { role: 'user', id: 'checkpoint-fork', content: summary, source: { kind: 'compact-checkpoint', compactionId: 'compaction-fork' } },
      sourceEventSeqs: [8, baseSeq, baseSeq + 1],
      surfaceOp: { op: 'replace', startSeq: 8, endSeq: 8 },
    },
    { type: 'compaction/end', seq: baseSeq + 3, time: 1_700_000_002_003, data: { compactionId: 'compaction-fork', turn: 2 } },
  ]
}

const sessionOf = (id, events, header) => ({
  id,
  header: { id, isSeeded: true, ...header },
  snapshotEvents: () => events,
})

const inheritedEvents = () => conversation().concat(nativeCompaction(6, 'compaction-native', [text('condensed native summary')]))

function fixture(childIds) {
  const inherited = inheritedEvents()
  const parent = sessionOf(PARENT, inherited, {})
  const child = sessionOf(CHILD, inherited.concat(forkCompaction(10, childIds)), { parentSession: PARENT })
  return { parent, child }
}

test('a child re-derives the same identity for an inherited native checkpoint', () => {
  const summaryEvent = inheritedEvents().find(event => event.type === 'compaction/summary')
  const { parent, child } = fixture([legacyNativeIdentity(PARENT, summaryEvent)])
  const parentStore = new SuperLcmStore(':memory:')
  const childStore = new SuperLcmStore(':memory:')
  assert.deepEqual(reindexSession(parentStore, parent, { rebuild: true }).errors, [])
  assert.deepEqual(reindexSession(childStore, child, { rebuild: true }).errors, [])
  const parentNode = parentStore.getCompactionNode(PARENT, 'compaction-native')
  const childNode = childStore.getCompactionNode(CHILD, 'compaction-native')
  assert.equal(parentNode.nodeId, nativeIdentity(summaryEvent))
  assert.equal(childNode.nodeId, nativeIdentity(summaryEvent), 'identity must not depend on which session indexes the record')
  parentStore.close()
  childStore.close()
})

test('a fork verifies an inherited prepared tree that names the parent identity', () => {
  const summary = [text('condensed native summary')]
  const parentIdentity = legacyNativeIdentity(PARENT, {
    seq: 7,
    data: { compactionId: 'compaction-native', summary },
  })
  const { child } = fixture([parentIdentity])
  const store = new SuperLcmStore(':memory:')
  const result = reindexSession(store, child, { rebuild: true })
  assert.deepEqual(result.errors, [])
  assert.equal(result.indexed, 2, 'both the inherited native node and the fork node are indexed')
  const inherited = store.getCompactionNode(CHILD, 'compaction-native')
  const fork = store.getNode(CHILD, 'lcm-fork-root')
  assert.deepEqual(fork.childIds, [inherited.nodeId], 'the stored tree names the node this session owns')
  assert.deepEqual(store.childrenOf(CHILD, 'lcm-fork-root'), [inherited.nodeId])
  assert.equal(doctorSession(store, child).ok, true)
  store.close()
})

test('a fork still rejects a child id it cannot tie to a physical checkpoint', () => {
  const { child } = fixture(['lcm-native-0000000000000000000000000000000000000000'])
  const store = new SuperLcmStore(':memory:')
  const result = reindexSession(store, child, { rebuild: true })
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].error, /untrusted children/)
  assert.equal(store.getNode(CHILD, 'lcm-fork-root'), null, 'a rejected tree is never stored')
  store.close()
})

test('a fork rejects a parent identity that names a different record', () => {
  const other = legacyNativeIdentity(PARENT, {
    seq: 7,
    data: { compactionId: 'compaction-native', summary: [text('a summary this session never committed')] },
  })
  const { child } = fixture([other])
  const store = new SuperLcmStore(':memory:')
  const result = reindexSession(store, child, { rebuild: true })
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].error, /untrusted children/)
  store.close()
})
