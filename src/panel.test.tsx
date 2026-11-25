// `orca plugin test` runs this in Node with the same runtime and checks Orca uses. The worker is
// stood in for: each `plugin.request` name is answered with a small view built here, so no token
// and no network are involved.
import {
  assert,
  hostError,
  mockHost,
  mount,
  test,
  type MockHost,
  type MockHostOptions,
  type TestPanel
} from 'orca/testing'
import { addDays, dayKeyOf } from './select'
import type {
  TodoistDue,
  TodoistProject,
  TodoistSnapshot,
  TodoistTask,
  TodoistView,
  TokenProtection,
  TodoistError
} from './protocol'
import * as panel from './panel'

/** Mounts the panel over a worker that answers as told, and unmounts it however the test ends. */
async function withPanel(
  options: MockHostOptions & { locale?: string },
  run: (view: TestPanel, host: MockHost) => Promise<void>
): Promise<void> {
  const { locale, ...hostOptions } = options
  const host = mockHost(hostOptions)
  const view = await mount(panel, { host, locale })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await view.settled()
    await run(view, host)
  } finally {
    await view.unmount()
  }
}

const nothingWentWrong = (view: TestPanel): void => {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

const PROJECT: TodoistProject = {
  id: 'proj-1',
  name: 'Work',
  color: 'blue',
  isFavorite: false,
  isInboxProject: false,
  order: 0,
  parentId: null
}

const todayKey = (): string => dayKeyOf(new Date(), 'UTC')

function dueOn(dayKey: string): TodoistDue {
  return {
    date: dayKey,
    datetime: null,
    timezone: 'UTC',
    string: null,
    isRecurring: false,
    lang: null
  }
}

function task(overrides: Partial<TodoistTask> & { id: string; content: string }): TodoistTask {
  const { id, content, ...rest } = overrides
  return {
    id,
    content,
    description: '',
    projectId: PROJECT.id,
    sectionId: null,
    parentId: null,
    labels: [],
    priority: 1,
    due: null,
    deadline: null,
    addedAt: null,
    url: `https://app.todoist.com/app/task/${id}`,
    order: 0,
    dayOrder: 0,
    duration: null,
    ...rest
  }
}

function snapshotOf(tasks: TodoistTask[]): TodoistSnapshot {
  return {
    fetchedAt: 1_700_000_000_000,
    tasks,
    projects: [PROJECT],
    sections: [],
    labels: [],
    user: { name: 'Test', email: null, timezone: 'UTC' }
  }
}

function readyView(tasks: TodoistTask[]): TodoistView {
  return {
    token: { source: 'secret', masked: '••••1234', protection: 'os-keyring' },
    state: { status: 'ready', snapshot: snapshotOf(tasks) }
  }
}

function noTokenView(protection: TokenProtection = 'os-keyring'): TodoistView {
  return {
    token: { source: 'none', masked: null, protection },
    state: { status: 'idle' }
  }
}

const READ_ERROR: TodoistError = {
  code: 'unreachable',
  httpStatus: null,
  detail: null,
  retryAfterMs: null
}

function staleView(tasks: TodoistTask[]): TodoistView {
  return {
    token: { source: 'secret', masked: '••••1234', protection: 'os-keyring' },
    state: { status: 'error', error: READ_ERROR, snapshot: snapshotOf(tasks) }
  }
}

/** Two days overdue, one due today, and one later this week, relative to the real today. */
function sampleTasks(): TodoistTask[] {
  const today = todayKey()
  return [
    task({
      id: 't1',
      content: 'Write report',
      due: dueOn(today),
      priority: 4,
      labels: ['work'],
      order: 0
    }),
    task({
      id: 't2',
      content: 'File taxes',
      due: dueOn(addDays(today, -2)),
      priority: 2,
      order: 1
    }),
    task({
      id: 't3',
      content: 'Plan sprint',
      due: dueOn(addDays(today, 3)),
      order: 2
    })
  ]
}

test('asks for a token when there is none, and saves what is typed', async () => {
  let saved: string | null = null
  await withPanel(
    {
      requests: {
        'todoist.get': () => noTokenView(),
        'token.set': ({ value }) => {
          saved = value
          return readyView(sampleTasks())
        }
      }
    },
    async (view, host) => {
      assert.ok(view.find({ text: 'Connect your Todoist account' }))
      assert.equal(view.find({ text: 'Connect' })?.disabled, true) // nothing to save yet
      await view.type({ label: 'API token' }, '  tok-123  ')
      assert.equal(view.find({ text: 'Connect' })?.disabled, false)
      await view.press({ text: 'Connect' })
      assert.equal(saved, 'tok-123') // trimmed by the panel before the worker sees it
      assert.ok(view.find({ label: 'Write report' }))
      assert.equal(view.find({ label: 'API token' }), null) // the form is gone
      // The token is the worker's to keep: the panel never stores it itself.
      assert.deepEqual(host.callsOf('secrets.set'), [])
      assert.deepEqual(host.data().secrets, {})
      nothingWentWrong(view)
    }
  )
})

test('shows the stats and today’s tasks, and the overdue tab shows the overdue task', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView(sampleTasks()) } }, async (view) => {
    assert.ok(view.find({ text: 'Overdue 1' }))
    assert.ok(view.find({ text: 'Today 1' }))
    assert.ok(view.find({ text: 'This week 2' }))
    assert.ok(view.find({ label: 'Write report' }))
    assert.equal(view.find({ label: 'File taxes' }), null) // overdue is not in the today tab
    await view.select({ type: 'Tabs' }, 'overdue')
    assert.ok(view.find({ label: 'File taxes' }))
    assert.equal(view.find({ label: 'Write report' }), null)
    nothingWentWrong(view)
  })
})

test('refreshes through todoist.refresh, not todoist.get', async () => {
  let gets = 0
  let refreshes = 0
  await withPanel(
    {
      requests: {
        'todoist.get': () => {
          gets += 1
          return readyView(sampleTasks())
        },
        'todoist.refresh': () => {
          refreshes += 1
          return readyView(sampleTasks())
        }
      }
    },
    async (view) => {
      assert.equal(gets, 1) // the setup load
      await view.press({ label: 'Refresh' })
      assert.equal(refreshes, 1)
      assert.equal(gets, 1)
      nothingWentWrong(view)
    }
  )
})

test('says what went wrong when the first read fails, and offers a retry', async () => {
  await withPanel(
    {
      requests: {
        'todoist.get': () => {
          throw hostError('unavailable', 'the worker is not running')
        }
      }
    },
    async (view) => {
      assert.equal(view.find({ type: 'Callout' })?.props.title, 'Could not read Todoist')
      assert.ok(view.find({ text: 'the worker is not running' }))
      assert.ok(view.find({ text: 'Try again' }))
      nothingWentWrong(view)
    }
  )
})

test('keeps the last read on screen when a later read fails', async () => {
  await withPanel({ requests: { 'todoist.get': () => staleView(sampleTasks()) } }, async (view) => {
    assert.equal(view.find({ type: 'Callout' })?.props.title, 'Showing the last read')
    assert.ok(view.find({ label: 'Write report' }))
    nothingWentWrong(view)
  })
})

test('shows the empty state with no tasks, and no-match when a filter hides them all', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView([]) } }, async (view) => {
    assert.ok(view.find({ label: 'No active tasks' }))
    assert.equal(view.find({ label: 'Nothing matches' }), null)
    nothingWentWrong(view)
  })
  await withPanel(
    {
      requests: {
        'todoist.get': () =>
          readyView([
            task({ id: 't-old', content: 'Old task', due: dueOn(addDays(todayKey(), -1)) })
          ])
      }
    },
    async (view) => {
      assert.ok(view.find({ label: 'Nothing matches' })) // today's tab is empty
      nothingWentWrong(view)
    }
  )
})

test('opens a task in Todoist when its row is pressed', async () => {
  const tasks = sampleTasks()
  const target = tasks[0]
  await withPanel({ requests: { 'todoist.get': () => readyView(tasks) } }, async (view, host) => {
    await view.press({ label: 'Write report' })
    assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: target.url }])
    nothingWentWrong(view)
  })
})

test('follows the worker as it posts a new view', async () => {
  let gets = 0
  await withPanel(
    {
      requests: {
        'todoist.get': () => {
          gets += 1
          return noTokenView()
        }
      }
    },
    async (view) => {
      assert.ok(view.find({ text: 'Connect your Todoist account' }))
      await view.post('todoist.changed', { view: readyView(sampleTasks()) })
      assert.ok(view.find({ label: 'Write report' }))
      assert.equal(gets, 1) // the post carried the answer; nothing was asked again
      nothingWentWrong(view)
    }
  )
})

test('explains a device without an OS key store', async () => {
  await withPanel(
    { requests: { 'todoist.get': () => noTokenView('unavailable') } },
    async (view) => {
      assert.ok(view.find({ text: /no OS key store/ }))
      assert.equal(
        view.find({
          text: 'Paste a personal API token. It is checked, then saved encrypted on this device, and the plugin only reads tasks.'
        }),
        null
      )
      nothingWentWrong(view)
    }
  )
})

test('speaks Korean in a Korean Orca', async () => {
  await withPanel(
    { locale: 'ko', requests: { 'todoist.get': () => noTokenView() } },
    async (view) => {
      assert.ok(view.find({ text: 'Todoist 계정 연결' }))
      assert.ok(view.find({ label: 'API 토큰' }))
      nothingWentWrong(view)
    }
  )
})
