// The Todoist client against a fake network: one stub `fetch` per test, restored after each.
// Nothing here talks to api.todoist.com, and no test waits on a real timeout.

import { afterEach, assert, test } from 'orca/testing'
import type { TodoistSnapshot } from './protocol'
import { NOW, TOKEN } from './fixtures'
import {
  RequestError,
  closeTask,
  clearDueOnTask,
  createProject,
  createTask,
  deleteTask,
  fetchSnapshot,
  isDue,
  moveTask,
  refreshMinutesOf,
  reopenTask,
  updateTask
} from './todoist'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

type Reply = {
  status?: number
  /** Structured JSON body; ignored when `text` is given. */
  body?: unknown
  text?: string
  headers?: Record<string, string>
}

type Endpoint = 'tasks' | 'projects' | 'sections' | 'labels' | 'user'

/** The endpoint a request URL names, or null for anything unexpected. */
function endpointOf(url: string): Endpoint | null {
  for (const name of ['tasks', 'projects', 'sections', 'labels', 'user'] as const) {
    if (new URL(url).pathname === `/api/v1/${name}`) {
      return name
    }
  }
  return null
}

/** Installs a stub fetch, records every URL and init, and returns the recording. */
function stubFetch(
  answer: (url: string, endpoint: Endpoint | null) => Reply
): { urls: string[]; inits: (RequestInit | undefined)[] } {
  const record: { urls: string[]; inits: (RequestInit | undefined)[] } = { urls: [], inits: [] }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    record.urls.push(url)
    record.inits.push(init)
    const reply = answer(url, endpointOf(url))
    const status = reply.status ?? 200
    const text = reply.text ?? JSON.stringify(reply.body ?? null)
    const body = status === 204 || status === 205 || status === 304 ? null : text
    return new Response(body, { status, headers: reply.headers })
  }) as typeof fetch
  return record
}

const defaultUser = {
  full_name: 'Pinion',
  email: 'pinion@example.com',
  tz_info: { timezone: 'Asia/Seoul' }
}

const emptyCollection = { results: [] as unknown[], next_cursor: null }

/** A stub that answers every collection empty and the user with the sample account. */
function stubEmpty(): { urls: string[]; inits: (RequestInit | undefined)[] } {
  return stubFetch((_url, endpoint) => ({
    body: endpoint === 'user' ? defaultUser : emptyCollection
  }))
}

function codeOf(error: unknown): string | null {
  return error instanceof RequestError ? error.code : null
}

// --- normalization ---------------------------------------------------------------------------

test('normalizes a full snapshot and skips unusable task rows', async () => {
  const tasks = [
    {
      id: 't1',
      content: 'Write the plan',
      description: 'Two pages',
      project_id: 'p1',
      section_id: 's1',
      parent_id: 'p0',
      labels: ['next', 'deep'],
      priority: 9,
      due: {
        date: '2026-05-30',
        datetime: '2026-05-30T10:00:00+09:00',
        timezone: 'Asia/Seoul',
        string: 'tomorrow 10:00',
        is_recurring: true,
        lang: 'en'
      },
      deadline: { date: '2026-05-29', lang: 'en' },
      added_at: '2026-05-20T00:00:00Z',
      child_order: 7,
      day_order: 3,
      duration: { amount: 45, unit: 'minute' },
      url: 'https://app.todoist.com/app/task/t1'
    },
    // No description, no due, no deadline, no duration and no url: the defaults must fill in.
    { id: 't2', content: 'No due', project_id: 'p1' },
    // Both rows below are unusable and must be skipped without failing the read.
    { id: 't3', content: '   ' },
    { content: 'No id' }
  ]
  stubFetch((_url, endpoint) => {
    switch (endpoint) {
      case 'tasks':
        return { body: { results: tasks, next_cursor: null } }
      case 'projects':
        return {
          body: {
            results: [
              {
                id: 'p1',
                name: 'Work',
                color: 'berry_red',
                is_favorite: true,
                is_inbox_project: false,
                child_order: 2,
                parent_id: 'p0'
              }
            ],
            next_cursor: null
          }
        }
      case 'sections':
        return {
          body: { results: [{ id: 's1', project_id: 'p1', name: 'Backlog', child_order: 1 }], next_cursor: null }
        }
      case 'labels':
        return {
          body: { results: [{ id: 'l1', name: 'next', color: 'blue', child_order: 0 }], next_cursor: null }
        }
      case 'user':
        return { body: defaultUser }
      default:
        return { status: 404 }
    }
  })

  const snapshot: TodoistSnapshot = await fetchSnapshot({ token: TOKEN, now: 111 })
  assert.equal(snapshot.fetchedAt, 111)
  assert.equal(snapshot.tasks.length, 2)

  const [full, plain] = snapshot.tasks
  assert.equal(full.id, 't1')
  assert.equal(full.content, 'Write the plan')
  assert.equal(full.description, 'Two pages')
  assert.equal(full.projectId, 'p1')
  assert.equal(full.sectionId, 's1')
  assert.equal(full.parentId, 'p0')
  assert.deepEqual(full.labels, ['next', 'deep'])
  assert.equal(full.priority, 4)
  assert.deepEqual(full.due, {
    date: '2026-05-30',
    datetime: '2026-05-30T10:00:00+09:00',
    timezone: 'Asia/Seoul',
    string: 'tomorrow 10:00',
    isRecurring: true,
    lang: 'en'
  })
  assert.deepEqual(full.deadline, { date: '2026-05-29', lang: 'en' })
  assert.equal(full.addedAt, '2026-05-20T00:00:00Z')
  assert.equal(full.url, 'https://app.todoist.com/app/task/t1')
  assert.equal(full.order, 7)
  assert.equal(full.dayOrder, 3)
  assert.deepEqual(full.duration, { amount: 45, unit: 'minute' })

  assert.equal(plain.description, '')
  assert.deepEqual(plain.labels, [])
  assert.equal(plain.priority, 1)
  assert.equal(plain.due, null)
  assert.equal(plain.deadline, null)
  assert.equal(plain.addedAt, null)
  assert.equal(plain.url, 'https://app.todoist.com/app/task/t2')
  assert.equal(plain.order, 0)
  assert.equal(plain.dayOrder, 0)
  assert.equal(plain.duration, null)

  assert.deepEqual(snapshot.projects, [
    {
      id: 'p1',
      name: 'Work',
      color: 'berry_red',
      isFavorite: true,
      isInboxProject: false,
      order: 2,
      parentId: 'p0'
    }
  ])
  assert.deepEqual(snapshot.sections, [
    { id: 's1', projectId: 'p1', name: 'Backlog', order: 1 }
  ])
  assert.deepEqual(snapshot.labels, [{ id: 'l1', name: 'next', color: 'blue', order: 0 }])
  assert.deepEqual(snapshot.user, {
    name: 'Pinion',
    email: 'pinion@example.com',
    timezone: 'Asia/Seoul'
  })
})

test('sends the bearer token, the JSON accept header and the page limit', async () => {
  const record = stubEmpty()
  await fetchSnapshot({ token: TOKEN })
  const tasksUrl = record.urls.find((url) => url.includes('/api/v1/tasks'))
  assert.ok(tasksUrl !== undefined)
  assert.match(tasksUrl ?? '', /limit=200/)
  const headers = record.inits[0]?.headers as Record<string, string> | undefined
  assert.equal(headers?.Authorization, `Bearer ${TOKEN}`)
  assert.equal(headers?.Accept, 'application/json')
  assert.ok(record.urls.every((url) => url.startsWith('https://api.todoist.com/api/v1/')))
})

test('falls back to UTC when the account has no time zone', async () => {
  stubFetch((_url, endpoint) => ({
    body:
      endpoint === 'user'
        ? { full_name: '', email: null }
        : emptyCollection
  }))
  const snapshot = await fetchSnapshot({ token: TOKEN })
  assert.deepEqual(snapshot.user, { name: '', email: null, timezone: 'UTC' })
})

// --- paging ----------------------------------------------------------------------------------

test('follows next_cursor until null with the same limit', async () => {
  const record = stubFetch((url, endpoint) => {
    if (endpoint === 'tasks') {
      if (url.includes('cursor=page2')) {
        return { body: { results: [{ id: 't2', content: 'Second', project_id: 'p1' }], next_cursor: null } }
      }
      return { body: { results: [{ id: 't1', content: 'First', project_id: 'p1' }], next_cursor: 'page2' } }
    }
    return { body: endpoint === 'user' ? defaultUser : emptyCollection }
  })
  const snapshot = await fetchSnapshot({ token: TOKEN })
  assert.deepEqual(
    snapshot.tasks.map((task) => task.id),
    ['t1', 't2']
  )
  const taskUrls = record.urls.filter((url) => url.includes('/api/v1/tasks'))
  assert.equal(taskUrls.length, 2)
  assert.match(taskUrls[0] ?? '', /limit=200/)
  assert.match(taskUrls[1] ?? '', /limit=200/)
  assert.match(taskUrls[1] ?? '', /cursor=page2/)
})

test('accepts a bare array as one full page', async () => {
  stubFetch((_url, endpoint) => {
    switch (endpoint) {
      case 'tasks':
        return { body: [{ id: 't1', content: 'Bare', project_id: 'p1' }] }
      case 'projects':
        return { body: [{ id: 'p1', name: 'Work' }] }
      case 'sections':
        return { body: [{ id: 's1', project_id: 'p1', name: 'Backlog' }] }
      case 'labels':
        return { body: [{ id: 'l1', name: 'next' }] }
      case 'user':
        return { body: defaultUser }
      default:
        return { status: 404 }
    }
  })
  const snapshot = await fetchSnapshot({ token: TOKEN })
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.projects.length, 1)
  assert.equal(snapshot.sections.length, 1)
  assert.equal(snapshot.labels.length, 1)
  assert.equal(snapshot.tasks[0]?.content, 'Bare')
})

test('stops with bad_response after 100 pages', async () => {
  stubFetch((_url, endpoint) =>
    endpoint === 'tasks'
      ? { body: { results: [], next_cursor: 'more' } }
      : { body: endpoint === 'user' ? defaultUser : emptyCollection }
  )
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.equal(codeOf(error), 'bad_response')
    return true
  })
})

// --- failures --------------------------------------------------------------------------------

test('maps 401 to bad_token', async () => {
  stubFetch(() => ({ status: 401, body: { error: 'Unauthorized' } }))
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, 'bad_token')
    assert.equal(error.httpStatus, 401)
    assert.equal(error.detail, 'Unauthorized')
    return true
  })
})

test('maps 429 and reads Retry-After in seconds', async () => {
  stubFetch(() => ({
    status: 429,
    body: { error: 'Too many requests' },
    headers: { 'Retry-After': '7' }
  }))
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, 'rate_limited')
    assert.equal(error.httpStatus, 429)
    assert.equal(error.retryAfterMs, 7000)
    return true
  })
})

test('ignores a Retry-After that is not a number', async () => {
  stubFetch(() => ({ status: 429, body: {}, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }))
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.equal(codeOf(error), 'rate_limited')
    assert.ok(error instanceof RequestError)
    assert.equal(error.retryAfterMs, null)
    return true
  })
})

test('maps other HTTP failures to http with the status', async () => {
  stubFetch(() => ({ status: 500, body: { message: 'Something broke' } }))
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, 'http')
    assert.equal(error.httpStatus, 500)
    assert.equal(error.detail, 'Something broke')
    return true
  })
})

test('maps a rejected fetch to unreachable', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.equal(codeOf(error), 'unreachable')
    assert.ok(error instanceof RequestError)
    assert.equal(error.httpStatus, null)
    return true
  })
})

test('maps a non-JSON body to bad_response', async () => {
  stubFetch(() => ({ status: 200, text: '<html>not json</html>' }))
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.equal(codeOf(error), 'bad_response')
    return true
  })
})

test('maps a non-object JSON body to bad_response', async () => {
  stubFetch(() => ({ status: 200, text: '42' }))
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.equal(codeOf(error), 'bad_response')
    return true
  })
})

test('a caller abort surfaces as an AbortError, not a RequestError', async () => {
  globalThis.fetch = (async () => {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }) as typeof fetch
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    fetchSnapshot({ token: TOKEN, signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      assert.notEqual(codeOf(error), 'timeout')
      return true
    }
  )
})

test('the token never appears in detail or the message', async () => {
  stubFetch(() => ({
    status: 401,
    body: { error: `Invalid token ${TOKEN} supplied` }
  }))
  await assert.rejects(fetchSnapshot({ token: TOKEN }), (error: unknown) => {
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, 'bad_token')
    assert.ok(error.detail !== null)
    assert.ok(!(error.detail ?? '').includes(TOKEN))
    assert.ok(!error.message.includes(TOKEN))
    assert.ok((error.detail ?? '').includes('[redacted]'))
    return true
  })
})

// --- settings --------------------------------------------------------------------------------

test('refreshMinutesOf clamps to 1..60 and defaults to 5', () => {
  assert.equal(refreshMinutesOf(0), 1)
  assert.equal(refreshMinutesOf(120), 60)
  assert.equal(refreshMinutesOf('12'), 12)
  assert.equal(refreshMinutesOf(undefined), 5)
  assert.equal(refreshMinutesOf(null), 5)
  assert.equal(refreshMinutesOf('nonsense'), 5)
  assert.equal(refreshMinutesOf(5.4), 5)
  assert.equal(refreshMinutesOf(-3), 1)
})

test('isDue is true with no attempt, false when fresh, and flips at the boundary', () => {
  assert.equal(isDue(0, 5, NOW), true)
  assert.equal(isDue(NOW - 60_000, 5, NOW), false)
  assert.equal(isDue(NOW - 5 * 60_000 - 1, 5, NOW), true)
  assert.equal(isDue(NOW - 5 * 60_000, 5, NOW), true)
})

// --- writes ----------------------------------------------------------------------------------

test('creates a task with the fields a surface sends', async () => {
  const record = stubFetch(() => ({ body: { id: 't9' } }))
  await createTask({
    token: TOKEN,
    input: {
      content: '  Write the release notes  ',
      description: 'Cover 0.2.0',
      projectId: 'p1',
      sectionId: 's1',
      dueDate: '2026-06-01',
      priority: 9,
      labels: ['next', ' next ', 'writing'],
      deadline: '2026-06-03'
    }
  })
  assert.equal(record.urls[0], 'https://api.todoist.com/api/v1/tasks')
  assert.equal(record.inits[0]?.method, 'POST')
  assert.equal(
    new Headers(record.inits[0]?.headers).get('authorization'),
    `Bearer ${TOKEN}`
  )
  assert.deepEqual(JSON.parse(String(record.inits[0]?.body)), {
    content: 'Write the release notes',
    priority: 4,
    description: 'Cover 0.2.0',
    project_id: 'p1',
    section_id: 's1',
    labels: ['next', 'writing'],
    due_date: '2026-06-01',
    deadline_date: '2026-06-03'
  })
})

test('creates a timed task, and leaves a date-less one undated', async () => {
  const timed = stubFetch(() => ({ body: {} }))
  await createTask({
    token: TOKEN,
    input: { content: 'Standup', dueDate: '2026-06-01', dueTime: '09:30' }
  })
  assert.equal(
    JSON.parse(String(timed.inits[0]?.body)).due_datetime,
    '2026-06-01T09:30:00'
  )

  const undated = stubFetch(() => ({ body: {} }))
  await createTask({ token: TOKEN, input: { content: 'Someday' } })
  assert.equal(JSON.parse(String(undated.inits[0]?.body)).due_date, undefined)
  assert.equal(JSON.parse(String(undated.inits[0]?.body)).due_datetime, undefined)
})

test('updates a task, clearing a due date and deadline when asked', async () => {
  const record = stubFetch(() => ({ body: {} }))
  await updateTask({
    token: TOKEN,
    input: {
      id: 't1',
      content: 'Renamed',
      description: '',
      projectId: 'p1',
      sectionId: null,
      dueDate: null,
      dueTime: null,
      priority: 2,
      labels: [],
      deadline: null
    }
  })
  assert.equal(record.urls[0], 'https://api.todoist.com/api/v1/tasks/t1')
  assert.equal(record.inits[0]?.method, 'POST')
  const body = JSON.parse(String(record.inits[0]?.body))
  assert.equal(body.content, 'Renamed')
  assert.equal(body.due_string, undefined)
  assert.equal(body.due_date, undefined)
  assert.equal(body.due_datetime, undefined)
  assert.equal(body.deadline_date, null)
  assert.deepEqual(body.labels, [])
})

test('moves, closes, reopens and deletes a task', async () => {
  const record = stubFetch(() => ({ status: 204, text: '' }))
  await moveTask({ token: TOKEN, id: 't1', projectId: 'p2', sectionId: 's2' })
  await closeTask({ token: TOKEN, id: 't1' })
  await reopenTask({ token: TOKEN, id: 't1' })
  await deleteTask({ token: TOKEN, id: 't1' })
  assert.deepEqual(
    record.urls.map((url) => new URL(url).pathname),
    [
      '/api/v1/tasks/t1/move',
      '/api/v1/tasks/t1/close',
      '/api/v1/tasks/t1/reopen',
      '/api/v1/tasks/t1'
    ]
  )
  assert.deepEqual(
    record.inits.map((init) => init?.method),
    ['POST', 'POST', 'POST', 'DELETE']
  )
  assert.deepEqual(JSON.parse(String(record.inits[0]?.body)), {
    project_id: 'p2',
    section_id: 's2'
  })
})

test('clears a due date through the Sync API', async () => {
  const record = stubFetch(() => ({ body: { sync_status: {} } }))
  await clearDueOnTask({ token: TOKEN, id: 't1' }).catch(() => undefined)
  assert.equal(record.urls[0], 'https://api.todoist.com/api/v1/sync')
  assert.equal(record.inits[0]?.method, 'POST')
  assert.equal(
    new Headers(record.inits[0]?.headers).get('content-type'),
    'application/x-www-form-urlencoded'
  )
  const form = new URLSearchParams(String(record.inits[0]?.body))
  assert.equal(form.get('sync_token'), '*')
  const command = JSON.parse(String(form.get('commands')))[0]
  assert.equal(command.type, 'item_update')
  assert.deepEqual(command.args, { id: 't1', due: null })
})

test('creates a project and maps a refused write to http', async () => {
  const created = stubFetch(() => ({ body: { id: 'p9' } }))
  await createProject({ token: TOKEN, input: { name: '  Home  ' } })
  assert.equal(created.urls[0], 'https://api.todoist.com/api/v1/projects')
  assert.deepEqual(JSON.parse(String(created.inits[0]?.body)), {
    name: 'Home',
    color: 'charcoal'
  })

  stubFetch(() => ({ status: 400, body: { error: 'Invalid due date' } }))
  await updateTask({
    token: TOKEN,
    input: {
      id: 't1',
      content: 'x',
      description: '',
      projectId: 'p1',
      sectionId: null,
      dueDate: 'not-a-date',
      dueTime: null,
      priority: 1,
      labels: [],
      deadline: null
    }
  }).then(
    () => {
      throw new Error('a refused write must reject')
    },
    (error: unknown) => {
      assert.equal(codeOf(error), 'http')
      assert.match(String((error as RequestError).detail), /Invalid due date/)
    }
  )
})
