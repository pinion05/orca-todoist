// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host. Todoist
// is stood in for by a fetch of the test's own, so nothing leaves the machine.

import type { JsonValue } from 'orca'
import { assert, mockHost, mountWorker, test, type MockHost, type TestWorker } from 'orca/testing'
import type { TodoistSnapshot, TodoistView } from './protocol'
import * as main from './worker'
import { mask } from './worker'

const NOW = 1_780_000_000_000
const TOKEN = 'tok-test-1234'

type Answer = Response | Promise<Response>
type Call = { url: string; headers: Headers }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const page = (results: unknown[], next: string | null = null): unknown => ({
  results,
  next_cursor: next
})

const task = (id: string, overrides: Record<string, unknown> = {}): unknown => ({
  id,
  content: `Task ${id}`,
  description: '',
  project_id: 'p1',
  section_id: null,
  parent_id: null,
  labels: [],
  priority: 1,
  due: null,
  deadline: null,
  added_at: '2026-01-02T03:04:05Z',
  url: `https://app.todoist.com/app/task/${id}`,
  child_order: 1,
  day_order: 1,
  duration: null,
  ...overrides
})

/** The five endpoints, one page each. */
const answerFor = (url: string): unknown => {
  if (url.includes('/api/v1/tasks')) {
    return page([task('t1', { due: { date: '2026-05-28', datetime: null, string: 'today' } })])
  }
  if (url.includes('/api/v1/projects')) {
    return page([
      { id: 'p1', name: 'Inbox', color: 'charcoal', is_favorite: false, is_inbox_project: true, child_order: 0, parent_id: null }
    ])
  }
  if (url.includes('/api/v1/sections')) {
    return page([])
  }
  if (url.includes('/api/v1/labels')) {
    return page([{ id: 'l1', name: 'next', color: 'blue', child_order: 0 }])
  }
  if (url.includes('/api/v1/user')) {
    return { full_name: 'Pinion', email: 'pinion@example.com', tz_info: { timezone: 'Asia/Seoul' } }
  }
  return { error: 'not found' }
}

/** The worker's environment, which the typings leave out. */
const environment = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

const snapshotOf = (view: TodoistView): TodoistSnapshot | null =>
  view.state.status === 'ready'
    ? view.state.snapshot
    : view.state.status === 'error'
      ? view.state.snapshot
      : null

async function withWorker(
  options: { host?: MockHost; answer?: (url: string) => Answer },
  run: (worker: TestWorker, calls: Call[]) => Promise<void>
): Promise<void> {
  const env = environment()
  const saved = env.TODOIST_API_TOKEN
  delete env.TODOIST_API_TOKEN
  const answer = options.answer ?? ((url: string): Answer => json(answerFor(url)))
  const real = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return answer(String(input))
  }) as typeof fetch
  let worker: TestWorker | null = null
  try {
    worker = await mountWorker(main, { host: options.host })
    await run(worker, calls)
  } finally {
    await worker?.deactivate()
    globalThis.fetch = real
    if (saved === undefined) {
      delete env.TODOIST_API_TOKEN
    } else {
      env.TODOIST_API_TOKEN = saved
    }
  }
}

const hostWith = (token: string): MockHost => mockHost({ secrets: { todoistToken: token } })

test('asks for a token when there is none, and reads nothing', async () => {
  await withWorker({}, async (worker, calls) => {
    const view = await worker.request('todoist.get')
    assert.deepEqual(view.token, { source: 'none', masked: null, protection: 'os-keyring' })
    assert.deepEqual(view.state, { status: 'idle' })
    assert.equal(calls.length, 0)
    assert.deepEqual(worker.refusals, [])
  })
})

test('reads Todoist with the saved token and keeps it masked', async () => {
  await withWorker({ host: hostWith(TOKEN) }, async (worker, calls) => {
    const view = await worker.request('todoist.get')
    assert.equal(view.token.source, 'secret')
    assert.equal(view.token.masked, mask(TOKEN))
    assert.equal(view.state.status, 'ready')
    const snapshot = snapshotOf(view)
    assert.equal(snapshot?.tasks.length, 1)
    assert.equal(snapshot?.tasks[0]?.content, 'Task t1')
    assert.equal(snapshot?.user?.timezone, 'Asia/Seoul')
    assert.ok(calls.some((call) => call.url.includes('/api/v1/tasks?limit=200')))
    assert.ok(calls.some((call) => call.url.includes('/api/v1/projects')))
    assert.ok(calls.every((call) => call.headers.get('authorization') === `Bearer ${TOKEN}`))
    assert.equal(worker.refusals.length, 0)
  })
})

test('uses the plaintext setting when no secret is saved', async () => {
  const host = mockHost({ settings: { apiToken: 'tok-setting-9876' } })
  await withWorker({ host }, async (worker) => {
    const view = await worker.request('todoist.get')
    assert.equal(view.token.source, 'setting')
    assert.equal(view.token.masked, '••••9876')
  })
})

test('uses TODOIST_API_TOKEN last', async () => {
  await withWorker({}, async (worker) => {
    const env = environment()
    env.TODOIST_API_TOKEN = 'tok-env-5555'
    try {
      const view = await worker.request('todoist.get')
      assert.equal(view.token.source, 'env')
      assert.equal(view.token.masked, '••••5555')
    } finally {
      delete env.TODOIST_API_TOKEN
    }
  })
})

test('does not read again while the cached answer is fresh, and refreshes on demand', async () => {
  await withWorker({ host: hostWith(TOKEN) }, async (worker, calls) => {
    const first = await worker.request('todoist.get')
    const afterFirst = calls.length
    assert.ok(afterFirst >= 5)
    const second = await worker.request('todoist.get')
    assert.equal(calls.length, afterFirst)
    assert.equal(snapshotOf(second)?.fetchedAt, snapshotOf(first)?.fetchedAt)
    await worker.request('todoist.refresh')
    assert.ok(calls.length > afterFirst)
  })
})

test('draws the cached answer after a restart without reading again', async () => {
  const host = mockHost({ secrets: { todoistToken: TOKEN } })
  await withWorker({ host }, async (worker, calls) => {
    await worker.request('todoist.get')
    const afterFirst = calls.length
    await worker.deactivate()
    const second = await mountWorker(main, { host })
    try {
      const view = await second.request('todoist.get')
      assert.equal(view.state.status, 'ready')
      assert.equal(calls.length, afterFirst)
    } finally {
      await second.deactivate()
    }
  })
})

test('reports a refused token as bad_token and keeps the last good snapshot', async () => {
  let fail = false
  await withWorker(
    {
      host: hostWith(TOKEN),
      answer: (url) =>
        fail ? json({ error: 'unauthorized' }, 401) : json(answerFor(url))
    },
    async (worker) => {
      await worker.request('todoist.get')
      fail = true
      const view = await worker.request('todoist.refresh')
      assert.equal(view.state.status, 'error')
      if (view.state.status === 'error') {
        assert.equal(view.state.error.code, 'bad_token')
        assert.equal(view.state.error.httpStatus, 401)
        assert.ok(view.state.snapshot !== null)
      }
    }
  )
})

test('saves a checked token in the encrypted secret, then reads with it', async () => {
  await withWorker({}, async (worker, calls) => {
    const view = await worker.request('token.set', { value: ` ${TOKEN} ` })
    assert.equal(view.token.source, 'secret')
    assert.equal(view.token.masked, '••••1234')
    assert.equal(view.state.status, 'ready')
    assert.equal(worker.host.data().secrets.todoistToken, TOKEN)
    assert.ok(calls.every((call) => call.headers.get('authorization') === `Bearer ${TOKEN}`))
  })
})

test('falls back to the setting when the machine has no OS key store', async () => {
  const host = mockHost({ results: { 'secrets.protection': { status: 'unavailable' } } })
  await withWorker({ host }, async (worker) => {
    const view = await worker.request('token.set', { value: TOKEN })
    assert.equal(view.token.protection, 'unavailable')
    assert.equal(view.token.source, 'setting')
    assert.equal(worker.host.data().settings.apiToken, TOKEN)
    assert.equal(worker.host.data().secrets.todoistToken, undefined)
  })
})

test('does not save a token Todoist refuses', async () => {
  const host = mockHost({ secrets: { todoistToken: 'tok-good-0000' } })
  await withWorker(
    {
      host,
      answer: (url) =>
        url.includes('/api/v1/tasks')
          ? json({ error: 'unauthorized' }, 401)
          : url.includes('/api/v1/user')
            ? json({ error: 'unauthorized' }, 401)
            : json(answerFor(url))
    },
    async (worker) => {
      await worker.request('token.set', { value: 'tok-bad-1111' }).then(
        () => {
          throw new Error('a refused token must reject')
        },
        (error: unknown) => {
          assert.ok(String((error as Error).message ?? '').length > 0)
        }
      )
      assert.equal(host.data().secrets.todoistToken, 'tok-good-0000')
    }
  )
})

test('forgets the saved token and its cache', async () => {
  const host = hostWith(TOKEN)
  await withWorker({ host }, async (worker) => {
    await worker.request('todoist.get')
    assert.ok(host.data().storage.snapshot)
    const view = await worker.request('token.forget')
    assert.equal(view.token.source, 'none')
    assert.deepEqual(view.state, { status: 'idle' })
    assert.equal(host.data().secrets.todoistToken, undefined)
    assert.equal(host.data().settings.apiToken, '')
    assert.equal(host.data().storage.snapshot, undefined)
  })
})

test('posts every change to the open surfaces, once', async () => {
  await withWorker({ host: hostWith(TOKEN) }, async (worker) => {
    await worker.request('todoist.get')
    const events = worker.posts.filter((post) => post.event === 'todoist.changed')
    assert.ok(events.length >= 1)
    const views = events.map((post) => (post.payload as { view: TodoistView }).view)
    assert.equal(views.at(-1)?.state.status, 'ready')
  })
})

test('masks short and long tokens without revealing them', () => {
  assert.equal(mask('abcd'), '••••')
  assert.equal(mask('abcdefgh'), '••••efgh')
})
