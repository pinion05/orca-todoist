// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
// Every scenario answers `todoist.get` with a view built here, so no token and no network are
// needed: the worker beside the panel has nothing to read.
import { defineCheck } from 'orca/testing'
import { addDays, dayKeyOf } from './select'
import type {
  TokenProtection,
  TodoistDue,
  TodoistProject,
  TodoistSnapshot,
  TodoistTask,
  TodoistView,
  TodoistError
} from './protocol'

// The worker takes a token from the environment when it finds none saved. Take that way away, so
// a check never asks Todoist with the token of whoever runs it.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
delete env?.TODOIST_API_TOKEN

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
    fetchedAt: Date.now(),
    tasks,
    projects: [PROJECT],
    sections: [],
    labels: [],
    user: { name: 'Test', email: null, timezone: 'UTC' }
  }
}

function sampleTasks(): TodoistTask[] {
  const today = todayKey()
  return [
    task({
      id: 't1',
      content: 'Write report',
      due: dueOn(today),
      priority: 4,
      labels: ['work', 'writing'],
      order: 0
    }),
    task({
      id: 't2',
      content: 'File taxes',
      due: dueOn(addDays(today, -2)),
      priority: 2,
      labels: ['admin'],
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
      parentId: 't3',
      due: dueOn(addDays(today, 1)),
      order: 3
    })
  ]
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

function staleView(): TodoistView {
  return {
    token: { source: 'secret', masked: '••••1234', protection: 'os-keyring' },
    state: { status: 'error', error: READ_ERROR, snapshot: snapshotOf(sampleTasks()) }
  }
}

function failedView(): TodoistView {
  return {
    token: { source: 'secret', masked: '••••1234', protection: 'os-keyring' },
    state: { status: 'error', error: READ_ERROR, snapshot: null }
  }
}

export default defineCheck({
  noToken: { requests: { 'todoist.get': () => noTokenView() } },
  noKeyStore: { requests: { 'todoist.get': () => noTokenView('unavailable') } },
  loading: {
    requests: {
      'todoist.get': () => ({
        token: { source: 'secret', masked: '••••1234', protection: 'os-keyring' },
        state: { status: 'loading' }
      })
    }
  },
  ready: { requests: { 'todoist.get': () => readyView(sampleTasks()) } },
  empty: { requests: { 'todoist.get': () => readyView([]) } },
  stale: { requests: { 'todoist.get': () => staleView() } },
  error: { requests: { 'todoist.get': () => failedView() } },
  // `locale` is not a check option; this keeps the same English request under a separate name.
  readyKo: { requests: { 'todoist.get': () => readyView(sampleTasks()) } },
  readyDark: { requests: { 'todoist.get': () => readyView(sampleTasks()) }, theme: 'dark' }
})
