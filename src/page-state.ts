// The `.todoist` document: what the full page remembers between openings. Parsing is total, so a
// hand-edited or truncated file still opens; every field falls back on its own.

import { DUE_BUCKETS, SORT_KEYS, type DueBucket, type SortKey } from './select'

export type PageView = 'list' | 'calendar' | 'board'

export type PageState = {
  version: 1
  view: PageView
  query: string
  projectIds: string[]
  labelNames: string[]
  /** Todoist priorities 1..4. */
  priorities: number[]
  buckets: DueBucket[]
  hideSubtasks: boolean
  sort: SortKey
  /** YYYY-MM. */
  month: string | null
  /** YYYY-MM-DD. */
  selectedDay: string | null
  /** Bucket ids the list keeps collapsed. */
  collapsed: string[]
}

export const DEFAULT_STATE: PageState = {
  version: 1,
  view: 'list',
  query: '',
  projectIds: [],
  labelNames: [],
  priorities: [],
  buckets: [],
  hideSubtasks: false,
  sort: 'due',
  month: null,
  selectedDay: null,
  collapsed: []
}

const VIEWS: readonly PageView[] = ['list', 'calendar', 'board']
const MAX_QUERY = 2000
const MAX_ENTRIES = 500
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

function isView(value: unknown): value is PageView {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value)
}

function isSort(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value)
}

function isBucket(value: unknown): value is DueBucket {
  return typeof value === 'string' && (DUE_BUCKETS as readonly string[]).includes(value)
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_QUERY) : ''
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const text = item.trim()
    if (text === '' || seen.has(text)) {
      continue
    }
    seen.add(text)
    out.push(text)
    if (out.length >= MAX_ENTRIES) {
      break
    }
  }
  return out
}

function cleanPriorities(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<number>()
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 4) {
      continue
    }
    if (seen.has(item)) {
      continue
    }
    seen.add(item)
    out.push(item)
    if (out.length >= MAX_ENTRIES) {
      break
    }
  }
  return out
}

function cleanBuckets(value: unknown): DueBucket[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<DueBucket>()
  const out: DueBucket[] = []
  for (const item of value) {
    if (!isBucket(item) || seen.has(item)) {
      continue
    }
    seen.add(item)
    out.push(item)
    if (out.length >= MAX_ENTRIES) {
      break
    }
  }
  return out
}

function cleanMonth(value: unknown): string | null {
  return typeof value === 'string' && MONTH.test(value) ? value : null
}

function cleanDay(value: unknown): string | null {
  return typeof value === 'string' && DAY.test(value) ? value : null
}

export function parsePageState(text: string): PageState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return DEFAULT_STATE
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return DEFAULT_STATE
  }
  const record = raw as Record<string, unknown>
  if (record.version !== 1) {
    return DEFAULT_STATE
  }
  return {
    version: 1,
    view: isView(record.view) ? record.view : DEFAULT_STATE.view,
    query: cleanText(record.query),
    projectIds: cleanStrings(record.projectIds),
    labelNames: cleanStrings(record.labelNames),
    priorities: cleanPriorities(record.priorities),
    buckets: cleanBuckets(record.buckets),
    hideSubtasks: record.hideSubtasks === true,
    sort: isSort(record.sort) ? record.sort : DEFAULT_STATE.sort,
    month: cleanMonth(record.month),
    selectedDay: cleanDay(record.selectedDay),
    collapsed: cleanStrings(record.collapsed)
  }
}

export function serializePageState(state: PageState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}
