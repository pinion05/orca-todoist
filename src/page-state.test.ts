// The `.todoist` parser: malformed files fall back, valid fields survive, and serialization is
// stable enough that a saved file opens exactly as it was left.

import { assert, test } from 'orca/testing'
import { DEFAULT_STATE, parsePageState, serializePageState, type PageState } from './page-state'

test('empty and malformed text falls back to the default state', () => {
  for (const text of ['', 'null', '[]', '{', '{"version":9}']) {
    assert.equal(parsePageState(text), DEFAULT_STATE, text)
  }
})

test('a full valid state round-trips through serialize and parse', () => {
  const state: PageState = {
    version: 1,
    view: 'calendar',
    query: 'report @work #inbox p1',
    projectIds: ['p1', 'p2'],
    labelNames: ['work', 'home'],
    priorities: [3, 4],
    buckets: ['overdue', 'today'],
    hideSubtasks: true,
    sort: 'priority',
    month: '2026-11',
    selectedDay: '2026-11-25',
    collapsed: ['overdue', 'later']
  }
  const text = serializePageState(state)
  assert.deepEqual(parsePageState(text), state)
})

test('unknown enums fall back and duplicate ids dedupe', () => {
  const state = parsePageState(
    JSON.stringify({
      version: 1,
      view: 'timeline',
      sort: 'random',
      buckets: ['today', 'someday', 'today'],
      projectIds: ['a', 'a', 'b'],
      labelNames: ['x', 'x']
    })
  )
  assert.equal(state.view, 'list')
  assert.equal(state.sort, 'due')
  assert.deepEqual(state.buckets, ['today'])
  assert.deepEqual(state.projectIds, ['a', 'b'])
  assert.deepEqual(state.labelNames, ['x'])
})

test('priorities keep only integers 1..4', () => {
  const state = parsePageState(
    JSON.stringify({ version: 1, priorities: [0, 5, 2.5, '3', 1, 2, 4, 4] })
  )
  assert.deepEqual(state.priorities, [1, 2, 4])
})

test('month and selectedDay reject bad shapes and accept valid ones', () => {
  const rejected = parsePageState(
    JSON.stringify({ version: 1, month: '2026-13', selectedDay: '2026-1-2' })
  )
  assert.equal(rejected.month, null)
  assert.equal(rejected.selectedDay, null)

  const accepted = parsePageState(
    JSON.stringify({ version: 1, month: '2026-01', selectedDay: '2026-01-31' })
  )
  assert.equal(accepted.month, '2026-01')
  assert.equal(accepted.selectedDay, '2026-01-31')
})

test('query is trimmed and capped, arrays are capped at 500', () => {
  const long = `${'x'.repeat(2200)}`
  const many = Array.from({ length: 620 }, (_value, index) => `id-${index}`)
  const state = parsePageState(
    JSON.stringify({
      version: 1,
      query: `  ${long}  `,
      projectIds: many,
      labelNames: many,
      collapsed: many
    })
  )
  assert.equal(state.query.length, 2000)
  assert.equal(state.projectIds.length, 500)
  assert.equal(state.labelNames.length, 500)
  assert.equal(state.collapsed.length, 500)
})

test('hideSubtasks accepts only a boolean and collapsed drops non-strings', () => {
  const truthy = parsePageState(
    JSON.stringify({ version: 1, hideSubtasks: 'yes', collapsed: ['overdue', 7, null, 'later'] })
  )
  assert.equal(truthy.hideSubtasks, false)
  assert.deepEqual(truthy.collapsed, ['overdue', 'later'])

  const real = parsePageState(JSON.stringify({ version: 1, hideSubtasks: true }))
  assert.equal(real.hideSubtasks, true)
})

test('serializePageState is pretty JSON with a trailing newline', () => {
  const text = serializePageState(DEFAULT_STATE)
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(JSON.parse(text), DEFAULT_STATE)
})
