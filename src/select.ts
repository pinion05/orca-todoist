// Pure selectors both surfaces share: which tasks a filter keeps, how they sort, which day they
// land on, and the calendar grid. No host calls here, so `orca plugin test` runs them in Node.

import type {
  TodoistDue,
  TodoistLabel,
  TodoistProject,
  TodoistSection,
  TodoistSnapshot,
  TodoistTask
} from './protocol'

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none'

/** The order the list groups and the filter chips use. */
export const DUE_BUCKETS: readonly DueBucket[] = [
  'overdue',
  'today',
  'tomorrow',
  'week',
  'later',
  'none'
]

export type SortKey = 'due' | 'priority' | 'project' | 'added' | 'alpha' | 'manual'

export const SORT_KEYS: readonly SortKey[] = [
  'due',
  'priority',
  'project',
  'added',
  'alpha',
  'manual'
]

export type ViewFilters = {
  /** Free text. `@label`, `#project` and `p1`..`p4` narrow it further. */
  query: string
  /** Empty means every project. */
  projectIds: readonly string[]
  /** Empty means every label. */
  labelNames: readonly string[]
  /** Todoist priorities 1..4; empty means every priority. */
  priorities: readonly number[]
  /** Empty means every date bucket. */
  buckets: readonly DueBucket[]
  hideSubtasks: boolean
}

export const EMPTY_FILTERS: ViewFilters = {
  query: '',
  projectIds: [],
  labelNames: [],
  priorities: [],
  buckets: [],
  hideSubtasks: false
}

export type TaskContext = {
  projects: ReadonlyMap<string, TodoistProject>
  sections: ReadonlyMap<string, TodoistSection>
  labels: readonly TodoistLabel[]
}

export type MatchedTask = {
  task: TodoistTask
  bucket: DueBucket
  dayKey: string | null
  project: TodoistProject | null
  section: TodoistSection | null
  /** How many tasks name this one as their parent. */
  subtasks: number
}

// --- days -----------------------------------------------------------------------------------

const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** The calendar day of `date` in `timeZone`, as YYYY-MM-DD. */
export function dayKeyOf(date: Date, timeZone: string): string {
  let format = dayFormats.get(timeZone)
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      })
    } catch {
      format = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      })
    }
    dayFormats.set(timeZone, format)
  }
  const parts = format.formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** The day a task is due on: Todoist's `date` when it has one, else its datetime in `timeZone`. */
export function dueDayKey(due: TodoistDue | null, timeZone: string): string | null {
  if (due === null) {
    return null
  }
  if (due.date !== null && /^\d{4}-\d{2}-\d{2}$/.test(due.date)) {
    return due.date
  }
  if (due.datetime !== null) {
    const at = Date.parse(due.datetime)
    if (Number.isFinite(at)) {
      return dayKeyOf(new Date(at), timeZone)
    }
  }
  return null
}

/** `key` moved by `days`. Calendar arithmetic in UTC, so daylight saving never shifts a day. */
export function addDays(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const at = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1) + days * 86_400_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

export function addMonths(monthKey: string, months: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const at = new Date(Date.UTC(year, (month ?? 1) - 1 + months, 1))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthOf(dayKey: string): string {
  return dayKey.slice(0, 7)
}

/** 0 Sunday … 6 Saturday. */
export function weekdayOf(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1)).getUTCDay()
}

/** The first day of the week that holds `dayKey`; `weekStartsOn` is 0 (Sunday) or 1 (Monday). */
export function startOfWeek(dayKey: string, weekStartsOn: 0 | 1): string {
  return addDays(dayKey, -((weekdayOf(dayKey) - weekStartsOn + 7) % 7))
}

export function bucketOfDay(dayKey: string | null, todayKey: string): DueBucket {
  if (dayKey === null) {
    return 'none'
  }
  if (dayKey < todayKey) {
    return 'overdue'
  }
  if (dayKey === todayKey) {
    return 'today'
  }
  if (dayKey === addDays(todayKey, 1)) {
    return 'tomorrow'
  }
  if (dayKey <= addDays(todayKey, 7)) {
    return 'week'
  }
  return 'later'
}

export function bucketOf(task: TodoistTask, todayKey: string, timeZone: string): DueBucket {
  return bucketOfDay(dueDayKey(task.due, timeZone), todayKey)
}

/** Where a day sits relative to today, for labels such as "Today" or "3 days overdue". */
export type DayRelation = {
  kind: 'today' | 'tomorrow' | 'yesterday' | 'overdue' | 'upcoming'
  /** How far from today, in whole days; 0 for today, positive ahead, negative behind. */
  days: number
}

export function dayRelation(dayKey: string, todayKey: string): DayRelation {
  const days = Math.round(
    (Date.parse(`${dayKey}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000
  )
  if (days === 0) {
    return { kind: 'today', days }
  }
  if (days === 1) {
    return { kind: 'tomorrow', days }
  }
  if (days === -1) {
    return { kind: 'yesterday', days }
  }
  return { kind: days < 0 ? 'overdue' : 'upcoming', days }
}

export type CalendarCell = {
  key: string
  /** 1..31. */
  day: number
  inMonth: boolean
  today: boolean
}

/** Six weeks of days covering `monthKey`; `weekStartsOn` is 0 (Sunday) or 1 (Monday). */
export function calendarGrid(
  monthKey: string,
  weekStartsOn: 0 | 1,
  todayKey: string
): CalendarCell[][] {
  const first = `${monthKey}-01`
  const start = startOfWeek(first, weekStartsOn)
  const weeks: CalendarCell[][] = []
  for (let week = 0; week < 6; week += 1) {
    const cells: CalendarCell[] = []
    for (let day = 0; day < 7; day += 1) {
      const key = addDays(start, week * 7 + day)
      cells.push({
        key,
        day: Number(key.slice(8, 10)),
        inMonth: key.startsWith(monthKey),
        today: key === todayKey
      })
    }
    weeks.push(cells)
  }
  return weeks
}

// --- matching -------------------------------------------------------------------------------

export function contextOf(snapshot: TodoistSnapshot): TaskContext {
  return {
    projects: new Map(snapshot.projects.map((project) => [project.id, project])),
    sections: new Map(snapshot.sections.map((section) => [section.id, section])),
    labels: snapshot.labels
  }
}

export function subtaskCounts(tasks: readonly TodoistTask[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (task.parentId !== null) {
      counts.set(task.parentId, (counts.get(task.parentId) ?? 0) + 1)
    }
  }
  return counts
}

type QueryTerm =
  | { kind: 'text'; value: string }
  | { kind: 'label'; value: string }
  | { kind: 'project'; value: string }
  | { kind: 'priority'; value: number }

/** `@label`, `#project`, `p1`..`p4` (or `p` with any case), and plain words. */
export function queryTerms(query: string): QueryTerm[] {
  const terms: QueryTerm[] = []
  for (const raw of query.toLowerCase().split(/\s+/)) {
    if (raw === '') {
      continue
    }
    if (raw.startsWith('@') && raw.length > 1) {
      terms.push({ kind: 'label', value: raw.slice(1) })
    } else if (raw.startsWith('#') && raw.length > 1) {
      terms.push({ kind: 'project', value: raw.slice(1) })
    } else if (/^p[1-4]$/.test(raw)) {
      terms.push({ kind: 'priority', value: 5 - Number(raw.slice(1)) })
    } else {
      terms.push({ kind: 'text', value: raw })
    }
  }
  return terms
}

function matchesTerm(task: TodoistTask, term: QueryTerm, context: TaskContext): boolean {
  switch (term.kind) {
    case 'label':
      return task.labels.some((label) => label.toLowerCase().includes(term.value))
    case 'project':
      return (context.projects.get(task.projectId)?.name ?? '').toLowerCase().includes(term.value)
    case 'priority':
      return task.priority === term.value
    case 'text': {
      const haystack = [
        task.content,
        task.description,
        ...task.labels.map((label) => `@${label}`)
      ]
        .join('\n')
        .toLowerCase()
      return haystack.includes(term.value)
    }
  }
}

/** The tasks `filters` keeps, in snapshot order. */
export function filterTasks(
  snapshot: TodoistSnapshot,
  filters: ViewFilters,
  todayKey: string,
  timeZone: string
): TodoistTask[] {
  const context = contextOf(snapshot)
  const terms = queryTerms(filters.query)
  const projectIds = new Set(filters.projectIds)
  const labelNames = new Set(filters.labelNames.map((label) => label.toLowerCase()))
  const priorities = new Set(filters.priorities)
  const buckets = new Set(filters.buckets)
  return snapshot.tasks.filter((task) => {
    if (filters.hideSubtasks && task.parentId !== null) {
      return false
    }
    if (projectIds.size > 0 && !projectIds.has(task.projectId)) {
      return false
    }
    if (
      labelNames.size > 0 &&
      !task.labels.some((label) => labelNames.has(label.toLowerCase()))
    ) {
      return false
    }
    if (priorities.size > 0 && !priorities.has(task.priority)) {
      return false
    }
    if (buckets.size > 0 && !buckets.has(bucketOf(task, todayKey, timeZone))) {
      return false
    }
    return terms.every((term) => matchesTerm(task, term, context))
  })
}

// --- sorting --------------------------------------------------------------------------------

const byPriority = (a: TodoistTask, b: TodoistTask): number => b.priority - a.priority
const byOrder = (a: TodoistTask, b: TodoistTask): number => a.order - b.order

export function sortTasks(
  tasks: readonly TodoistTask[],
  sort: SortKey,
  timeZone: string,
  projects: ReadonlyMap<string, TodoistProject>
): TodoistTask[] {
  const due = (task: TodoistTask): string => dueDayKey(task.due, timeZone) ?? '9999-99-99'
  const sorted = [...tasks]
  switch (sort) {
    case 'priority':
      sorted.sort((a, b) => byPriority(a, b) || due(a).localeCompare(due(b)) || byOrder(a, b))
      break
    case 'project':
      sorted.sort((a, b) => {
        const left = projects.get(a.projectId)?.order ?? 0
        const right = projects.get(b.projectId)?.order ?? 0
        return left - right || due(a).localeCompare(due(b)) || byOrder(a, b)
      })
      break
    case 'added':
      sorted.sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? '') || byOrder(a, b))
      break
    case 'alpha':
      sorted.sort((a, b) => a.content.localeCompare(b.content, undefined, { sensitivity: 'base' }))
      break
    case 'manual':
      sorted.sort(byOrder)
      break
    case 'due':
    default:
      sorted.sort(
        (a, b) =>
          due(a).localeCompare(due(b)) || byPriority(a, b) || byOrder(a, b)
      )
  }
  return sorted
}

// --- views ----------------------------------------------------------------------------------

export type BucketGroup = {
  bucket: DueBucket
  tasks: TodoistTask[]
  /** The group's day key, when it has one. */
  dayKey: string | null
}

/** Selected tasks grouped in bucket order, each group sorted by `sort`. */
export function groupByBucket(
  tasks: readonly TodoistTask[],
  todayKey: string,
  timeZone: string,
  sort: SortKey,
  projects: ReadonlyMap<string, TodoistProject>
): BucketGroup[] {
  const groups = new Map<DueBucket, TodoistTask[]>()
  for (const task of sortTasks(tasks, sort, timeZone, projects)) {
    const bucket = bucketOf(task, todayKey, timeZone)
    const list = groups.get(bucket)
    if (list === undefined) {
      groups.set(bucket, [task])
    } else {
      list.push(task)
    }
  }
  return DUE_BUCKETS.filter((bucket) => groups.has(bucket)).map((bucket) => ({
    bucket,
    tasks: groups.get(bucket) ?? [],
    dayKey:
      bucket === 'today'
        ? todayKey
        : bucket === 'tomorrow'
          ? addDays(todayKey, 1)
          : null
  }))
}

/** Selected tasks by the day they are due on, each day sorted by time then priority. */
export function tasksByDay(
  tasks: readonly TodoistTask[],
  timeZone: string
): Map<string, TodoistTask[]> {
  const days = new Map<string, TodoistTask[]>()
  for (const task of tasks) {
    const key = dueDayKey(task.due, timeZone)
    if (key === null) {
      continue
    }
    const list = days.get(key)
    if (list === undefined) {
      days.set(key, [task])
    } else {
      list.push(task)
    }
  }
  for (const list of days.values()) {
    list.sort((a, b) => {
      const left = a.due?.datetime ?? ''
      const right = b.due?.datetime ?? ''
      return left.localeCompare(right) || byPriority(a, b) || byOrder(a, b)
    })
  }
  return days
}

export type TaskStats = {
  total: number
  overdue: number
  today: number
  /** Today through the next seven days. */
  week: number
  none: number
}

export function statsOf(
  tasks: readonly TodoistTask[],
  todayKey: string,
  timeZone: string
): TaskStats {
  const stats: TaskStats = { total: tasks.length, overdue: 0, today: 0, week: 0, none: 0 }
  const end = addDays(todayKey, 7)
  for (const task of tasks) {
    const key = dueDayKey(task.due, timeZone)
    if (key === null) {
      stats.none += 1
    } else if (key < todayKey) {
      stats.overdue += 1
    } else {
      if (key === todayKey) {
        stats.today += 1
      }
      if (key <= end) {
        stats.week += 1
      }
    }
  }
  return stats
}

/** The tasks under each project, in project order, for the board view. */
export type ProjectColumn = {
  project: TodoistProject
  tasks: TodoistTask[]
}

export function projectColumns(
  tasks: readonly TodoistTask[],
  projects: readonly TodoistProject[],
  sort: SortKey,
  timeZone: string
): ProjectColumn[] {
  const byProject = new Map<string, TodoistTask[]>()
  for (const task of tasks) {
    const list = byProject.get(task.projectId)
    if (list === undefined) {
      byProject.set(task.projectId, [task])
    } else {
      list.push(task)
    }
  }
  const map = new Map(projects.map((project) => [project.id, project]))
  return [...projects]
    .sort((a, b) => a.order - b.order)
    .filter((project) => byProject.has(project.id))
    .map((project) => ({
      project,
      tasks: sortTasks(byProject.get(project.id) ?? [], sort, timeZone, map)
    }))
}

/** The date a task is due, formatted in the account's time zone. */
export function formatDay(
  dayKey: string,
  locale: string,
  options: { weekday?: boolean; year?: boolean } = {}
): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: options.weekday === true ? 'short' : undefined,
    year: options.year === true ? 'numeric' : undefined,
    month: 'short',
    day: 'numeric'
  }).format(new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1, 12)))
}

export function formatTime(datetime: string | null, locale: string, timeZone: string): string | null {
  if (datetime === null) {
    return null
  }
  const at = Date.parse(datetime)
  if (!Number.isFinite(at)) {
    return null
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(at))
}
