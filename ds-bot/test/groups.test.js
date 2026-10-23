import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPass, mentionsIn, openingSpeakers, referenceNote, stripOwnName } from '../src/host/groups.js'
import { attachReference } from '../src/host/turns.js'

const members = [{ name: 'M' }, { name: 'Mx' }, { name: 'K' }, { name: 'Writer' }]
const names = ({ all, found }) => ({ all, found: found.map(member => member.name) })

test('a joined Slark Agent joins ordinary turns and an explicit mention takes priority', () => {
  const bots = [{ id: 'admin', name: 'Admin' }, { id: 'writer', name: 'Writer' }]
  const agent = { id: 'slark-agent:member-1', name: 'Agent', kind: 'slark_agent' }
  const room = { admin: 'admin', mode: 'everyone' }
  const choose = opener => openingSpeakers(room, opener, [...bots, agent]).map(member => member.name)
  assert.deepEqual(choose({ text: 'hello' }), ['Admin', 'Writer', 'Agent'])
  assert.deepEqual(choose({ text: '@Agent please' }), ['Agent'])
  assert.deepEqual(choose({ text: '@all please' }), ['Admin', 'Writer', 'Agent'])
  assert.deepEqual(choose({ botId: 'writer', member: true, text: '@Agent please' }), ['Agent'])
  assert.deepEqual(choose({ botId: agent.id, member: true, text: '@Writer please' }), ['Writer'])
  assert.deepEqual(openingSpeakers({ ...room, mode: 'admin' }, { text: 'hello' }, [...bots, agent]).map(member => member.name), ['Admin'])
})

test('mentionsIn finds members in order, longest name first', () => {
  assert.deepEqual(names(mentionsIn('@Mx and @M, then @writer', members)), { all: false, found: ['Mx', 'M', 'Writer'] })
  assert.deepEqual(names(mentionsIn('@K你好 @K again', members)), { all: false, found: ['K'] })
  assert.deepEqual(names(mentionsIn('@Kate is not K', members)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn('mail a@K.com', members)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn('@all please, @所有人', members)), { all: true, found: [] })
  assert.deepEqual(names(mentionsIn('@everyone and @M', members)), { all: true, found: ['M'] })
  assert.deepEqual(names(mentionsIn('no mentions', members)), { all: false, found: [] })
})

test('isPass takes empty replies and [PASS] forms', () => {
  for (const text of ['', '[PASS]', ' 【pass】 then more', '(pass)', 'pass.', 'Pass！', '  PASS  ']) assert.equal(isPass(text), true, text)
  for (const text of ['passing the ball', 'I pass on this one', 'ok']) assert.equal(isPass(text), false, text)
})

test('stripOwnName drops an echoed "Name:" prefix', () => {
  assert.equal(stripOwnName('Writer', 'Writer: hello'), 'hello')
  assert.equal(stripOwnName('Writer', '**Writer**：你好'), '你好')
  assert.equal(stripOwnName('A.b', 'A.b: x'), 'x')
  assert.equal(stripOwnName('A.b', 'Axb: x'), 'Axb: x')
  assert.equal(stripOwnName('Writer', 'Coder: hi'), 'Coder: hi')
})

test('a referenced conversation rides with the user\'s queued message, not a Bot\'s post', () => {
  const queued = [{ text: 'first' }, { text: 'look @Chat with K', images: [] }, { text: 'post', botId: 'k' }]
  attachReference(queued, { kind: 'session-reference', references: [{ label: 'Chat with K' }, { label: '' }] }, '## Referenced sessions\n…')
  attachReference(queued, { kind: 'session-reference', references: [{ label: 'K notes' }] }, '## Referenced sessions\n2')
  attachReference(queued, { kind: 'session-reference' }, '')
  assert.equal(queued[0].references, undefined)
  assert.deepEqual(queued[1].references, [{ labels: ['Chat with K'], text: '## Referenced sessions\n…' }, { labels: ['K notes'], text: '## Referenced sessions\n2' }])
  assert.equal(queued[2].references, undefined)
  attachReference(undefined, {}, 'x')
})

test('a reference label is not a call, even when it starts with a member\'s name', () => {
  const references = [{ labels: ['K notes', 'K'] }]
  assert.deepEqual(names(mentionsIn('see @K notes, then @Writer', members, references)), { all: false, found: ['Writer'] })
  assert.deepEqual(names(mentionsIn('@K notes', members)), { all: false, found: ['K'] })
  assert.equal(referenceNote([]), '')
  assert.equal(referenceNote([{ text: 'A' }, { text: 'B' }]), 'Conversations the user referenced in this round:\n\nA\n\nB')
})

test('a reference takes out only its own "@label", so a typed call with the same text stays', () => {
  const writer = [{ labels: ['Writer'] }]
  assert.deepEqual(names(mentionsIn('Read @Writer, then @Writer please answer.', members, writer)), { all: false, found: ['Writer'] })
  assert.deepEqual(names(mentionsIn('see @Writer', members, writer)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn('see @Writer and @Writer', members, [...writer, ...writer])), { all: false, found: [] })
  // "@Kate" is not the reference "K", so the "@K" after it is the one taken out.
  assert.deepEqual(names(mentionsIn('@Kate, @K', [...members, { name: 'Kate' }], [{ labels: ['K'] }])), { all: false, found: ['Kate'] })
  assert.deepEqual(names(mentionsIn('@K notes and @K', members, [{ labels: ['K notes'] }])), { all: false, found: ['K'] })
})
