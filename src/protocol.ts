// The worker <-> panel/page contract, declared once. Both surfaces read these types, and
// `orca plugin test` checks the handlers against them.

/** Where the Todoist API token comes from, most trusted first. */
export type TokenSource = 'secret' | 'setting' | 'env' | 'none'

/** How Orca protects secrets on this machine (`secrets.protection`). */
export type TokenProtection = 'os-keyring' | 'unavailable'

export type TokenStatus = {
  source: TokenSource
  /** The token's last four characters; null without a token. */
  masked: string | null
  protection: TokenProtection
}

/** A task's due date, as Todoist reports it. */
export type TodoistDue = {
  /** YYYY-MM-DD in the account's time zone; null when Todoist gave only a datetime. */
  date: string | null
  /** RFC 3339, for a task with a time. */
  datetime: string | null
  timezone: string | null
  /** Todoist's own words, such as "every Monday" or "tomorrow". */
  string: string | null
  isRecurring: boolean
  lang: string | null
}

export type TodoistDeadline = {
  /** YYYY-MM-DD. */
  date: string
  lang: string | null
}

export type TodoistDuration = {
  amount: number
  unit: 'minute' | 'day'
}

/** One active task, with the fields the viewer draws. */
export type TodoistTask = {
  id: string
  content: string
  description: string
  projectId: string
  sectionId: string | null
  parentId: string | null
  labels: string[]
  /** Todoist's scale: 1 normal, 4 urgent. */
  priority: number
  due: TodoistDue | null
  deadline: TodoistDeadline | null
  /** RFC 3339. */
  addedAt: string | null
  url: string
  /** Position among siblings. */
  order: number
  dayOrder: number
  duration: TodoistDuration | null
}

export type TodoistProject = {
  id: string
  name: string
  /** Todoist's colour name, such as `berry_red` or `charcoal`. */
  color: string
  isFavorite: boolean
  isInboxProject: boolean
  order: number
  parentId: string | null
}

export type TodoistSection = {
  id: string
  projectId: string
  name: string
  order: number
}

export type TodoistLabel = {
  id: string
  name: string
  color: string
  order: number
}

export type TodoistUser = {
  name: string
  email: string | null
  /** IANA name, such as `Asia/Seoul`. */
  timezone: string
}

/** Everything one read returns, normalized for the viewer. */
export type TodoistSnapshot = {
  /** Epoch ms. */
  fetchedAt: number
  tasks: TodoistTask[]
  projects: TodoistProject[]
  sections: TodoistSection[]
  labels: TodoistLabel[]
  user: TodoistUser | null
}

export type TodoistErrorCode =
  | 'bad_token'
  | 'forbidden'
  | 'rate_limited'
  | 'http'
  | 'unreachable'
  | 'timeout'
  | 'bad_response'

export type TodoistError = {
  code: TodoistErrorCode
  httpStatus: number | null
  /** What Todoist said, when it said something readable. */
  detail: string | null
  /** For `rate_limited`: how long until trying again, when Todoist said. */
  retryAfterMs: number | null
}

export type TodoistState =
  /** No token, so there is nothing to ask for. */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; snapshot: TodoistSnapshot }
  /** `snapshot` is the last good one, kept so a panel can draw it as out of date. */
  | { status: 'error'; error: TodoistError; snapshot: TodoistSnapshot | null }

/** Everything a surface draws with, as the worker last computed it. */
export type TodoistView = {
  token: TokenStatus
  state: TodoistState
}

/** What a surface sends to create a task. An omitted or null due date leaves it undated. */
export type TaskCreateInput = {
  content: string
  description?: string
  /** Null or omitted puts it in the Inbox. */
  projectId?: string | null
  sectionId?: string | null
  /** YYYY-MM-DD. */
  dueDate?: string | null
  /** HH:mm, for a task with a time. */
  dueTime?: string | null
  /** Todoist's scale: 1 normal, 4 urgent. */
  priority?: number
  labels?: string[]
  /** YYYY-MM-DD. */
  deadline?: string | null
}

/** The whole editable state of a task; the worker sends only what changed where it can. */
export type TaskUpdateInput = {
  id: string
  content: string
  description: string
  projectId: string
  sectionId: string | null
  dueDate: string | null
  dueTime: string | null
  priority: number
  labels: string[]
  deadline: string | null
}

export type ProjectCreateInput = {
  name: string
  /** Todoist's colour name, such as `berry_red`; the worker picks one when omitted. */
  color?: string
}

/** A write's answer: the view after it, or the reason it was refused and the view to keep. */
export type TodoistMutation =
  | { ok: true; view: TodoistView }
  | { ok: false; error: TodoistError; view: TodoistView }

declare module 'orca' {
  interface PluginRequests {
    /** The current view; reads Todoist first when the cache is due. */
    'todoist.get': { output: TodoistView }
    /** The current view after reading Todoist now, whatever the refresh interval says. */
    'todoist.refresh': { output: TodoistView }
    /** Checks the token, saves it encrypted (or in the setting without an OS key store), then reads. */
    'token.set': { input: { value: string }; output: TodoistView }
    /** Deletes the saved token. One from a setting or the environment stays in use. */
    'token.forget': { output: TodoistView }
    /** Creates a task, then reads the account again. */
    'task.create': { input: TaskCreateInput; output: TodoistMutation }
    /** Updates a task and, when its project or section changed, moves it too. */
    'task.update': { input: TaskUpdateInput; output: TodoistMutation }
    /** Completes a task (and its subtasks, as Todoist does). */
    'task.close': { input: { id: string }; output: TodoistMutation }
    /** Reopens a completed task by id. */
    'task.reopen': { input: { id: string }; output: TodoistMutation }
    /** Deletes a task and its subtasks. */
    'task.delete': { input: { id: string }; output: TodoistMutation }
    /** Creates a project. */
    'project.create': { input: ProjectCreateInput; output: TodoistMutation }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel and page after the worker reads Todoist. */
    'todoist.changed': { view: TodoistView }
  }
}
