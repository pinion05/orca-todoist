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
import { addDays, addMonths, dayKeyOf, monthOf } from './select'
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

const INBOX: TodoistProject = {
  id: 'inbox',
  name: 'Inbox',
  color: 'charcoal',
  isFavorite: false,
  isInboxProject: true,
  order: 0,
  parentId: null
}

const PROJECT: TodoistProject = {
  id: 'proj-1',
  name: 'Work',
  color: 'blue',
  isFavorite: false,
  isInboxProject: false,
  order: 1,
  parentId: null
}

const PERSONAL: TodoistProject = {
  id: 'proj-2',
  name: 'Personal',
  color: 'green',
  isFavorite: false,
  isInboxProject: false,
  order: 2,
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
    projects: [INBOX, PROJECT, PERSONAL],
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

/** Two days overdue, two due today, one tomorrow, and one later this week. */
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
    }),
    task({
      id: 't4',
      content: 'Read notes',
      projectId: PERSONAL.id,
      due: dueOn(addDays(today, 1)),
      order: 3
    }),
    task({
      id: 't5',
      content: 'Personal task',
      projectId: PERSONAL.id,
      due: dueOn(today),
      order: 4
    })
  ]
}

/** The first Collapsible is the Filters card; opening it shows the Selects. */
async function openFilters(view: TestPanel): Promise<void> {
  const filters = view.findAll({ type: 'Collapsible' })[0]
  assert.ok(filters)
  await view.toggle(filters!)
}

/** Opens the task named `content` in the editor: its row is the ListItem the title sits in. */
async function openTask(view: TestPanel, content: string): Promise<void> {
  const row = view.find({ type: 'ListItem', text: new RegExp(`^${content}`) })
  assert.ok(row)
  await view.press(row!)
}

/** The drawn tree as plain data, for checks on how something is built rather than on its words. */
type TreeNode = { type?: string; key?: string; props?: Record<string, unknown>; children?: (TreeNode | string)[] }

function nodesOf(node: unknown, type: string): TreeNode[] {
  const found: TreeNode[] = []
  const visit = (item: unknown): void => {
    if (typeof item !== 'object' || item === null) {
      return
    }
    const tree = item as TreeNode
    if (tree.type === type) {
      found.push(tree)
    }
    for (const child of tree.children ?? []) {
      visit(child)
    }
  }
  visit(node)
  return found
}

/** Everything a node says, its descendants included. */
function wordsOf(node: TreeNode): string {
  return (node.children ?? [])
    .map((child) => (typeof child === 'string' ? child : wordsOf(child)))
    .join('')
}

/** Elements and strings: what Orca counts against the 5000 nodes it takes in one tree. */
function sizeOf(node: unknown): number {
  if (typeof node === 'string') {
    return 1
  }
  if (typeof node !== 'object' || node === null) {
    return 0
  }
  const children = (node as TreeNode).children ?? []
  return 1 + children.reduce((sum, child) => sum + sizeOf(child), 0)
}

/** `count` tasks with a full line of details under each title, spread over sixty days. */
function manyTasks(count: number): TodoistTask[] {
  const today = todayKey()
  return Array.from({ length: count }, (_, index) =>
    task({
      id: `many-${index}`,
      content: `Task ${index + 1} of many, with a title long enough to wrap in a narrow sidebar`,
      due: dueOn(addDays(today, (index % 60) - 20)),
      priority: 2 + (index % 3),
      labels: ['one', 'two'],
      parentId: index % 5 === 0 ? null : `many-${index - (index % 5)}`,
      order: index
    })
  )
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
      assert.equal(view.find({ text: 'Connect' })?.disabled, true)
      await view.type({ label: 'API token' }, '  tok-123  ')
      assert.equal(view.find({ text: 'Connect' })?.disabled, false)
      await view.press({ text: 'Connect' })
      assert.equal(saved, 'tok-123')
      assert.ok(view.find({ text: 'Write report' }))
      assert.equal(view.find({ label: 'API token' }), null)
      assert.deepEqual(host.callsOf('secrets.set'), [])
      nothingWentWrong(view)
    }
  )
})

test('shows the stats, the list and its groups', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView(sampleTasks()) } }, async (view) => {
    assert.ok(view.find({ text: 'Overdue 1' }))
    assert.ok(view.find({ text: 'Today 2' }))
    assert.ok(view.find({ text: 'Write report' }))
    assert.ok(view.find({ text: 'File taxes' }))
    assert.ok(view.find({ text: 'Personal task' }))
    nothingWentWrong(view)
  })
})

test('filters by project and by search', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView(sampleTasks()) } }, async (view) => {
    await openFilters(view)
    await view.select({ label: 'Projects' }, PERSONAL.id)
    assert.ok(view.find({ text: 'Personal task' }))
    assert.equal(view.find({ text: 'Write report' }), null)
    await view.select({ label: 'Projects' }, 'all')
    assert.ok(view.find({ text: 'Write report' }))
    await view.type({ label: 'Search' }, 'report')
    assert.ok(view.find({ text: 'Write report' }))
    assert.equal(view.find({ text: 'Personal task' }), null)
    nothingWentWrong(view)
  })
})

test('switches to the calendar and board views', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView(sampleTasks()) } }, async (view) => {
    await view.select({ type: 'Tabs' }, 'calendar')
    assert.ok(view.find({ text: 'Today' }))
    assert.ok(view.find({ text: '‹' }))
    await view.select({ type: 'Tabs' }, 'board')
    assert.ok(view.find({ type: 'Collapsible' }))
    nothingWentWrong(view)
  })
})

test('completes a task and undoes it', async () => {
  const tasks = sampleTasks()
  let closed: string | null = null
  await withPanel(
    {
      requests: {
        'todoist.get': () => readyView(tasks),
        'task.close': ({ id }) => {
          closed = id
          return { ok: true, view: readyView(tasks.filter((item) => item.id !== id)) }
        },
        'task.reopen': () => ({ ok: true, view: readyView(tasks) })
      }
    },
    async (view) => {
      await view.press({ label: 'Complete' })
      assert.equal(closed, 't2')
      assert.equal(view.find({ text: 'File taxes' }), null)
      const notice = view.findAll({ type: 'Callout' })[0]
      assert.equal(notice?.props.title, 'Completed: File taxes')
      await view.press({ text: 'Undo' })
      assert.ok(view.find({ text: 'File taxes' }))
      nothingWentWrong(view)
    }
  )
})

test('adds a task to the Inbox', async () => {
  let created: unknown = null
  await withPanel(
    {
      requests: {
        'todoist.get': () => readyView(sampleTasks()),
        'task.create': (input) => {
          created = input
          return {
            ok: true,
            view: readyView([
              ...sampleTasks(),
              task({ id: 't-new', content: 'New task', due: dueOn(todayKey()) })
            ])
          }
        }
      }
    },
    async (view) => {
      await view.type({ label: 'Add a task' }, 'New task')
      await view.press({ label: 'Add' })
      assert.deepEqual(created, { content: 'New task', projectId: 'inbox', dueDate: null })
      assert.ok(view.find({ text: 'New task' }))
      nothingWentWrong(view)
    }
  )
})

test('opens and edits a task, and saves it', async () => {
  let updated: unknown = null
  await withPanel(
    {
      requests: {
        'todoist.get': () => readyView(sampleTasks()),
        'task.update': (input) => {
          updated = input
          const next = sampleTasks().map((item) =>
            item.id === input.id ? { ...item, content: input.content, priority: input.priority } : item
          )
          return { ok: true, view: readyView(next) }
        }
      }
    },
    async (view) => {
      await openTask(view, 'Write report')
      assert.ok(view.find({ label: 'Task' }))
      await view.type({ label: 'Task' }, 'Renamed report', { replace: true })
      await view.select({ label: 'Priority' }, '2')
      await view.press({ text: 'Save' })
      assert.equal((updated as { content?: string }).content, 'Renamed report')
      assert.equal((updated as { priority?: number }).priority, 2)
      assert.ok(view.find({ text: /Saved/ }))
      await view.press({ text: 'Back' })
      assert.ok(view.find({ text: 'Renamed report' }))
      nothingWentWrong(view)
    }
  )
})

test('opens a task in Todoist', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView(sampleTasks()) } }, async (view, host) => {
    await openTask(view, 'Write report')
    await view.press({ text: 'Open Todoist' })
    assert.deepEqual(host.callsOf('shell.openExternal'), [
      { url: 'https://app.todoist.com/app/task/t1' }
    ])
    nothingWentWrong(view)
  })
})

test('deletes a task after a second press', async () => {
  let deleted: string | null = null
  await withPanel(
    {
      requests: {
        'todoist.get': () => readyView(sampleTasks()),
        'task.delete': ({ id }) => {
          deleted = id
          return {
            ok: true,
            view: readyView(sampleTasks().filter((item) => item.id !== id))
          }
        }
      }
    },
    async (view) => {
      await openTask(view, 'Write report')
      await view.press({ text: 'Delete' })
      assert.ok(view.find({ text: 'Delete for real?' }))
      await view.press({ text: 'Delete for real?' })
      assert.equal(deleted, 't1')
      assert.ok(view.find({ text: 'File taxes' }))
      assert.equal(view.find({ label: 'Task' }), null)
      nothingWentWrong(view)
    }
  )
})

test('creates a project from the filters card', async () => {
  let created: unknown = null
  await withPanel(
    {
      requests: {
        'todoist.get': () => readyView(sampleTasks()),
        'project.create': (input) => {
          created = input
          return {
            ok: true,
            view: readyView(sampleTasks())
          }
        }
      }
    },
    async (view) => {
      await openFilters(view)
      await view.type({ label: 'Project name' }, 'Home')
      await view.press({ text: 'Create' })
      assert.deepEqual(created, { name: 'Home' })
      nothingWentWrong(view)
    }
  )
})

test('shows what went wrong when the first read fails, and offers a retry', async () => {
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
    assert.ok(view.find({ text: 'Write report' }))
    nothingWentWrong(view)
  })
})

test('shows the empty state with no tasks, and no-match when a filter hides them all', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView([]) } }, async (view) => {
    assert.ok(view.find({ label: 'No active tasks' }))
    assert.equal(view.find({ label: 'Nothing matches' }), null)
    nothingWentWrong(view)
  })
  await withPanel({ requests: { 'todoist.get': () => readyView(sampleTasks()) } }, async (view) => {
    await view.type({ label: 'Search' }, 'zzzz')
    assert.ok(view.find({ label: 'Nothing matches' }))
    nothingWentWrong(view)
  })
})

test('reports a refused write', async () => {
  await withPanel(
    {
      requests: {
        'todoist.get': () => readyView(sampleTasks()),
        'task.close': () => ({
          ok: false,
          error: { code: 'forbidden', httpStatus: 403, detail: null, retryAfterMs: null },
          view: readyView(sampleTasks())
        })
      }
    },
    async (view) => {
      await view.press({ label: 'Complete' })
      assert.equal(view.find({ type: 'Callout' })?.props.title, 'Could not update Todoist')
      nothingWentWrong(view)
    }
  )
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
      assert.ok(view.find({ text: 'Write report' }))
      assert.equal(gets, 1)
      nothingWentWrong(view)
    }
  )
})

test('refreshes from the header', async () => {
  let refreshes = 0
  await withPanel(
    {
      requests: {
        'todoist.get': () => readyView(sampleTasks()),
        'todoist.refresh': () => {
          refreshes += 1
          return readyView(sampleTasks())
        }
      }
    },
    async (view) => {
      await view.press({ label: 'Refresh' })
      assert.equal(refreshes, 1)
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

test('wraps a long title and its details instead of cutting them off', async () => {
  const title =
    'Reschedule the appointment that was cancelled last week because the dentist is away'
  const tasks = [
    task({
      id: 'long',
      content: title,
      due: dueOn(addDays(todayKey(), -2)),
      priority: 4,
      labels: ['health', 'errands']
    }),
    task({ id: 'child', content: 'Call the insurance', parentId: 'long' })
  ]
  await withPanel({ requests: { 'todoist.get': () => readyView(tasks) } }, async (view) => {
    const tree = view.tree()
    const row = nodesOf(tree, 'ListItem').find((node) => wordsOf(node).startsWith(title))
    assert.ok(row)
    const [heading, meta] = nodesOf(row!, 'Text')
    // A Button, or a `truncate`, would keep the title on one line and cut off both its ends.
    assert.equal(heading?.children?.join(''), title)
    assert.equal(heading?.props?.truncate, undefined)
    assert.equal(nodesOf(tree, 'Button').some((node) => wordsOf(node).includes(title)), false)
    const words = wordsOf(meta!)
    assert.match(words, /Work · 2 days overdue · @health · @errands · P1 · 1 subtask/)
    // The overdue date and the priority are coloured, so each is a Text of its own.
    assert.ok(nodesOf(meta!, 'Text').some((node) => node.props?.tone === 'danger'))
    nothingWentWrong(view)
  })
})

test('the calendar lines its days up in seven equal columns and marks the days that have tasks', async () => {
  const today = todayKey()
  const yesterday = addDays(today, -1)
  const tomorrow = addDays(today, 1)
  const tasks = [
    task({ id: 'a', content: 'First today', due: dueOn(today), order: 0 }),
    task({ id: 'b', content: 'Second today', due: dueOn(today), order: 1 }),
    task({ id: 'c', content: 'Yesterday task', due: dueOn(yesterday), order: 2 }),
    task({ id: 'd', content: 'Tomorrow task', due: dueOn(tomorrow), order: 3 })
  ]
  await withPanel({ requests: { 'todoist.get': () => readyView(tasks) } }, async (view) => {
    await view.select({ type: 'Tabs' }, 'calendar')
    await view.settled()
    /** The grid as last drawn, and in it the cell of a day. */
    const frameOf = (): TreeNode | undefined =>
      nodesOf(view.tree(), 'Box').find((node) => node.props?.border === true)
    const cellOf = (key: string): TreeNode | undefined =>
      nodesOf(frameOf()!, 'Box').find((node) => node.key === key)
    /** What a day's count pill says; undefined when the day shows none. */
    const pillOf = (key: string): TreeNode | undefined =>
      nodesOf(cellOf(key)!, 'Box').find((node) => node.props?.radius === 'full')
    // The weekday row and one row a week, each seven cells that start from no width, so they
    // share the row equally however long their content is.
    const rows = nodesOf(frameOf()!, 'Box').filter((node) => node.props?.direction === 'row')
    assert.ok(rows.length >= 5)
    for (const row of rows) {
      assert.equal(row.children?.length, 7)
      for (const cell of row.children ?? []) {
        assert.equal(typeof cell, 'object')
        assert.equal((cell as TreeNode).props?.grow, true)
        assert.equal((cell as TreeNode).props?.width, 0)
      }
    }
    assert.equal(wordsOf(pillOf(today)!), '2')
    assert.equal(wordsOf(pillOf(yesterday)!), '1')
    assert.equal(pillOf(yesterday)?.props?.background, 'danger')
    // The day after tomorrow has no task, so no pill.
    assert.equal(pillOf(addDays(today, 2)), undefined)
    // A day is chosen without leaving the grid: its tasks list under it and its cell is marked.
    // The target stays in the month however the month ends.
    const target = monthOf(tomorrow) === monthOf(today) ? tomorrow : yesterday
    const listed = target === tomorrow ? /^Tomorrow task/ : /^Yesterday task/
    assert.equal(view.find({ type: 'ListItem', text: listed }), null)
    await view.press({ type: 'Button', text: String(Number(target.slice(8))) })
    await view.settled()
    assert.ok(view.find({ type: 'ListItem', text: listed }))
    assert.equal(cellOf(target)?.props?.background, 'muted')
    nothingWentWrong(view)
  })
})

test('moving to another month selects a day in it', async () => {
  // Only today has a task, so the next month opens on its first day whatever today's date is.
  const todays = sampleTasks().filter((item) => item.due?.date === todayKey())
  await withPanel({ requests: { 'todoist.get': () => readyView(todays) } }, async (view) => {
    await view.select({ type: 'Tabs' }, 'calendar')
    assert.ok(view.find({ type: 'ListItem' }))
    await view.press({ text: '›' })
    assert.equal(view.persisted.plugin['todoist.day'], `${addMonths(monthOf(todayKey()), 1)}-01`)
    // Nothing from the old month stays listed under the grid.
    assert.equal(view.find({ type: 'ListItem' }), null)
    await view.press({ text: 'Today' })
    assert.equal(view.persisted.plugin['todoist.day'], todayKey())
    assert.ok(view.find({ type: 'ListItem' }))
    nothingWentWrong(view)
  })
})

test('the quick add gives its date a line of its own rather than squeezing the title', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView(sampleTasks()) } }, async (view) => {
    const wrapping = nodesOf(view.tree(), 'Row').find(
      (node) => node.props?.wrap === true && nodesOf(node, 'Input').length === 2
    )
    assert.ok(wrapping)
    const title = nodesOf(wrapping!, 'Box').find((node) => node.props?.maxWidth === '100%')
    const date = nodesOf(wrapping!, 'Box').find((node) => node.props?.width === 120)
    assert.ok(title)
    assert.ok(date)
    // The title and the date are the row's two items, so the date wraps as a whole.
    assert.deepEqual(wrapping!.children, [title, date])
    // The title claims 260px before it shares a line, and never more than the sidebar holds.
    assert.equal(title!.props?.grow, true)
    assert.equal(title!.props?.width, 260)
    assert.equal(nodesOf(title!, 'IconButton').length, 1)
    assert.equal(date!.props?.shrink, false)
  })
})

test('keeps drawing when there are more tasks than one view may hold', async () => {
  await withPanel({ requests: { 'todoist.get': () => readyView(manyTasks(700)) } }, async (view) => {
    assert.ok(sizeOf(view.tree()) < 5000)
    assert.ok(view.findAll({ type: 'ListItem' }).length > 100)
    assert.ok(view.findAll({ type: 'ListItem' }).length < 700)
    // One note for the whole view says what is missing. The board and the list hold all 700 rows
    // at once and leave some out; a calendar day holds a dozen and shows them all.
    const note = /^Showing \d+ of 700 tasks\. Narrow the filters to see the rest\.$/
    assert.equal(view.findAll({ text: note }).length, 1)
    for (const [tab, notes] of [['calendar', 0], ['board', 1], ['list', 1]] as const) {
      await view.select({ type: 'Tabs' }, tab)
      assert.ok(sizeOf(view.tree()) < 5000, tab)
      assert.equal(view.findAll({ text: note }).length, notes, tab)
      nothingWentWrong(view)
    }
  })
})
