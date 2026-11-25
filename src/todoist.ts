// The smallest Todoist API v1 client the worker needs: read the five collections the viewer
// draws, follow cursors, and turn HTTP trouble into one error type. No host calls here, so the
// normalizer and the error mapping run in plain Node under `orca plugin test`.

import type {
  TodoistDeadline,
  TodoistDue,
  TodoistDuration,
  TodoistErrorCode,
  TodoistLabel,
  TodoistProject,
  TodoistSection,
  TodoistSnapshot,
  TodoistTask,
  TodoistUser,
  TaskCreateInput,
  TaskUpdateInput,
  ProjectCreateInput
} from './protocol'

const BASE_URL = 'https://api.todoist.com'
const API = '/api/v1'
const PAGE_LIMIT = 200
const MAX_PAGES = 100
const TIMEOUT_MS = 20_000
const DETAIL_LIMIT = 300

export class RequestError extends Error {
  readonly code: TodoistErrorCode
  readonly httpStatus: number | null
  readonly detail: string | null
  readonly retryAfterMs: number | null

  constructor(
    code: TodoistErrorCode,
    options: {
      httpStatus?: number | null
      detail?: string | null
      retryAfterMs?: number | null
    } = {}
  ) {
    super(messageOf(code))
    this.name = 'RequestError'
    this.code = code
    this.httpStatus = options.httpStatus ?? null
    this.detail = options.detail ?? null
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}

/** A fixed sentence per code: the token must never reach a message or a log through it. */
function messageOf(code: TodoistErrorCode): string {
  switch (code) {
    case 'bad_token':
      return 'Todoist rejected the token.'
    case 'forbidden':
      return 'Todoist refused access to this account.'
    case 'rate_limited':
      return 'Todoist asked to slow down.'
    case 'timeout':
      return 'Todoist did not answer in time.'
    case 'bad_response':
      return 'Todoist answered with something unexpected.'
    case 'http':
      return 'Todoist answered with an error.'
    case 'unreachable':
    default:
      return 'Could not reach Todoist.'
  }
}

/** Clamp a setting to 1..60, default 5. */
export function refreshMinutesOf(value: unknown): number {
  let minutes: number
  if (typeof value === 'number') {
    minutes = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    minutes = Number(value)
  } else {
    return 5
  }
  if (!Number.isFinite(minutes)) {
    return 5
  }
  return Math.min(60, Math.max(1, Math.round(minutes)))
}

/** True when there is no last attempt, or it is older than `minutes`. */
export function isDue(lastAttemptAt: number, minutes: number, now: number): boolean {
  if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) {
    return true
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return true
  }
  return now - lastAttemptAt >= minutes * 60_000
}

// --- HTTP ------------------------------------------------------------------------------------

function abortError(): Error {
  return new DOMException('The request was aborted.', 'AbortError')
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Keeps a token out of anything a surface or a log may show. */
function redact(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('[redacted]')
}

function cut(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text
}

function clean(text: string, token: string): string {
  return cut(redact(text.trim(), token))
}

/** Seconds in `Retry-After`, as milliseconds; only a plain number counts. */
function retryAfterOf(response: Response): number | null {
  let header: string | null
  try {
    header = response.headers.get('Retry-After')
  } catch {
    return null
  }
  if (header === null) {
    return null
  }
  const value = header.trim()
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    return null
  }
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
}

/** What an error response says, preferring Todoist's `error`/`message` over the status text. */
async function failureDetail(response: Response, token: string): Promise<string | null> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  if (body.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(body)
      if (isRecord(parsed)) {
        for (const key of ['error', 'message']) {
          const value = parsed[key]
          if (typeof value === 'string' && value.trim() !== '') {
            return clean(value, token)
          }
        }
      }
    } catch {
      // Not JSON: the status text is all there is to say.
    }
  }
  const statusText = typeof response.statusText === 'string' ? response.statusText : ''
  return statusText.trim() === '' ? null : clean(statusText, token)
}

/**
 * One GET, decoded as JSON. A caller abort surfaces as an `AbortError`; our own 20 s deadline
 * and every HTTP failure surface as a `RequestError`.
 */
async function requestJson(
  path: string,
  token: string,
  signal: AbortSignal | undefined,
  request: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; form?: boolean } = {}
): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  }
  if (request.body !== undefined) {
    headers['Content-Type'] =
      request.form === true ? 'application/x-www-form-urlencoded' : 'application/json'
  }
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: request.method ?? 'GET',
      headers,
      body:
        request.body === undefined
          ? undefined
          : request.form === true
            ? new URLSearchParams(request.body as Record<string, string>).toString()
            : JSON.stringify(request.body),
      signal: combined
    })
  } catch (error) {
    if (signal?.aborted === true) {
      throw abortError()
    }
    if (timeout.aborted) {
      throw new RequestError('timeout')
    }
    throw new RequestError('unreachable')
  }

  if (!response.ok) {
    const detail = await failureDetail(response, token)
    if (response.status === 401) {
      throw new RequestError('bad_token', { httpStatus: 401, detail })
    }
    if (response.status === 403) {
      throw new RequestError('forbidden', { httpStatus: 403, detail })
    }
    if (response.status === 429) {
      throw new RequestError('rate_limited', {
        httpStatus: 429,
        detail,
        retryAfterMs: retryAfterOf(response)
      })
    }
    throw new RequestError('http', { httpStatus: response.status, detail })
  }

  if (response.status === 204) {
    return null
  }
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (signal?.aborted === true) {
      throw abortError()
    }
    if (timeout.aborted) {
      throw new RequestError('timeout')
    }
    throw new RequestError('bad_response', {
      httpStatus: response.status,
      detail: clean(describe(error), token)
    })
  }
  if (text.trim() === '') {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (signal?.aborted === true) {
      throw abortError()
    }
    if (timeout.aborted) {
      throw new RequestError('timeout')
    }
    throw new RequestError('bad_response', {
      httpStatus: response.status,
      detail: clean(describe(error), token)
    })
  }
}

/** One paginated collection: `{ results, next_cursor }`, or a bare array with no next page. */
async function collection(
  path: string,
  token: string,
  signal: AbortSignal | undefined
): Promise<unknown[]> {
  const items: unknown[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    const raw = await requestJson(`${API}${path}?limit=${PAGE_LIMIT}${suffix}`, token, signal)
    if (Array.isArray(raw)) {
      items.push(...raw)
      return items
    }
    if (!isRecord(raw)) {
      throw new RequestError('bad_response')
    }
    const results = raw.results
    if (!Array.isArray(results)) {
      throw new RequestError('bad_response')
    }
    items.push(...results)
    const next = raw.next_cursor
    if (next === null || next === undefined || next === '') {
      return items
    }
    if (typeof next !== 'string') {
      throw new RequestError('bad_response')
    }
    cursor = next
  }
  throw new RequestError('bad_response')
}

// --- normalization ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanOf(value: unknown): boolean {
  return value === true
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function priorityOf(value: unknown): number {
  return Math.min(4, Math.max(1, Math.round(numberOf(value, 1))))
}

function dueOf(value: unknown): TodoistDue | null {
  const raw = recordOf(value)
  if (raw === null) {
    return null
  }
  return {
    date: nonEmptyString(raw.date),
    datetime: nonEmptyString(raw.datetime),
    timezone: nonEmptyString(raw.timezone),
    string: nonEmptyString(raw.string),
    isRecurring: booleanOf(raw.is_recurring),
    lang: nonEmptyString(raw.lang)
  }
}

function deadlineOf(value: unknown): TodoistDeadline | null {
  const raw = recordOf(value)
  if (raw === null) {
    return null
  }
  const date = nonEmptyString(raw.date)
  if (date === null) {
    return null
  }
  return { date, lang: nonEmptyString(raw.lang) }
}

function durationOf(value: unknown): TodoistDuration | null {
  const raw = recordOf(value)
  if (raw === null) {
    return null
  }
  const amount = raw.amount
  const unit = raw.unit
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return null
  }
  if (unit !== 'minute' && unit !== 'day') {
    return null
  }
  return { amount, unit }
}

function taskOf(value: unknown): TodoistTask | null {
  const raw = recordOf(value)
  if (raw === null) {
    return null
  }
  const id = nonEmptyString(raw.id)
  const content = nonEmptyString(raw.content)
  if (id === null || content === null) {
    return null
  }
  return {
    id,
    content,
    description: stringOf(raw.description) ?? '',
    projectId: nonEmptyString(raw.project_id) ?? '',
    sectionId: nonEmptyString(raw.section_id),
    parentId: nonEmptyString(raw.parent_id),
    labels: stringsOf(raw.labels),
    priority: priorityOf(raw.priority),
    due: dueOf(raw.due),
    deadline: deadlineOf(raw.deadline),
    addedAt: nonEmptyString(raw.added_at),
    url: nonEmptyString(raw.url) ?? `https://app.todoist.com/app/task/${id}`,
    order: numberOf(raw.child_order, 0),
    dayOrder: numberOf(raw.day_order, 0),
    duration: durationOf(raw.duration)
  }
}

function projectOf(value: unknown): TodoistProject | null {
  const raw = recordOf(value)
  if (raw === null) {
    return null
  }
  const id = nonEmptyString(raw.id)
  if (id === null) {
    return null
  }
  return {
    id,
    name: stringOf(raw.name) ?? '',
    color: nonEmptyString(raw.color) ?? '',
    isFavorite: booleanOf(raw.is_favorite),
    isInboxProject: booleanOf(raw.is_inbox_project),
    order: numberOf(raw.child_order, 0),
    parentId: nonEmptyString(raw.parent_id)
  }
}

function sectionOf(value: unknown): TodoistSection | null {
  const raw = recordOf(value)
  if (raw === null) {
    return null
  }
  const id = nonEmptyString(raw.id)
  if (id === null) {
    return null
  }
  return {
    id,
    projectId: nonEmptyString(raw.project_id) ?? '',
    name: stringOf(raw.name) ?? '',
    order: numberOf(raw.child_order, 0)
  }
}

function labelOf(value: unknown): TodoistLabel | null {
  const raw = recordOf(value)
  if (raw === null) {
    return null
  }
  const id = nonEmptyString(raw.id)
  if (id === null) {
    return null
  }
  return {
    id,
    name: stringOf(raw.name) ?? '',
    color: nonEmptyString(raw.color) ?? '',
    order: numberOf(raw.child_order, 0)
  }
}

function userOf(value: unknown): TodoistUser {
  const raw = recordOf(value)
  if (raw === null) {
    throw new RequestError('bad_response')
  }
  const timezone = recordOf(raw.tz_info)
  return {
    name: nonEmptyString(raw.full_name) ?? '',
    email: nonEmptyString(raw.email),
    timezone: nonEmptyString(timezone?.timezone) ?? 'UTC'
  }
}

function normalizeAll<T>(raw: unknown[], normalize: (value: unknown) => T | null): T[] {
  const items: T[] = []
  for (const value of raw) {
    const item = normalize(value)
    if (item !== null) {
      items.push(item)
    }
  }
  return items
}

// --- writes ----------------------------------------------------------------------------------

export type WriteOptions = { token: string; signal?: AbortSignal }

function cleanLabels(labels: readonly string[] | undefined): string[] {
  if (labels === undefined) {
    return []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of labels) {
    const label = typeof value === 'string' ? value.trim() : ''
    if (label === '' || seen.has(label)) {
      continue
    }
    seen.add(label)
    out.push(label)
    if (out.length >= 100) {
      break
    }
  }
  return out
}

function clampPriority(value: number | undefined): number {
  return Math.min(4, Math.max(1, Math.round(value ?? 1)))
}

/** A due date as Todoist accepts it. An absent date means "leave it alone" here; clearing is a
 *  separate Sync API command, because the REST update cannot express a null due date. */
function dueBody(
  date: string | null | undefined,
  time: string | null | undefined
): Record<string, unknown> {
  if (date === null || date === undefined || date.trim() === '') {
    return {}
  }
  if (time !== null && time !== undefined && time.trim() !== '') {
    return { due_datetime: `${date.trim()}T${time.trim()}:00` }
  }
  return { due_date: date.trim() }
}

function taskPath(id: string, suffix = ''): string {
  return `${API}/tasks/${encodeURIComponent(id)}${suffix}`
}

export async function createTask(
  options: WriteOptions & { input: TaskCreateInput }
): Promise<void> {
  const { input } = options
  const body: Record<string, unknown> = {
    content: input.content.trim(),
    priority: clampPriority(input.priority)
  }
  if (input.description !== undefined && input.description.trim() !== '') {
    body.description = input.description.trim()
  }
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== '') {
    body.project_id = input.projectId
  }
  if (input.sectionId !== undefined && input.sectionId !== null && input.sectionId !== '') {
    body.section_id = input.sectionId
  }
  const labels = cleanLabels(input.labels)
  if (labels.length > 0) {
    body.labels = labels
  }
  Object.assign(body, dueBody(input.dueDate, input.dueTime))
  if (input.deadline !== undefined && input.deadline !== null && input.deadline !== '') {
    body.deadline_date = input.deadline
  }
  await requestJson(`${API}/tasks`, options.token, options.signal, { method: 'POST', body })
}

export async function updateTask(
  options: WriteOptions & { input: TaskUpdateInput }
): Promise<void> {
  const { input } = options
  const body: Record<string, unknown> = {
    content: input.content.trim(),
    description: input.description,
    labels: cleanLabels(input.labels),
    priority: clampPriority(input.priority),
    ...dueBody(input.dueDate, input.dueTime),
    deadline_date: input.deadline === null || input.deadline === '' ? null : input.deadline
  }
  await requestJson(taskPath(input.id), options.token, options.signal, { method: 'POST', body })
}

/** Clears a due date; the REST update cannot, so this is the Sync API's `item_update`. */
export async function clearDueOnTask(options: WriteOptions & { id: string }): Promise<void> {
  const uuid = `due-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const commands = JSON.stringify([
    { type: 'item_update', uuid, args: { id: options.id, due: null } }
  ])
  const response = await requestJson(`${API}/sync`, options.token, options.signal, {
    method: 'POST',
    form: true,
    body: { commands, sync_token: '*' }
  })
  const status = recordOf(response)?.sync_status
  const result = recordOf(status)?.[uuid]
  if (result !== 'ok') {
    const detail =
      recordOf(result) !== null
        ? stringOf(recordOf(result)?.error) ?? stringOf(recordOf(result)?.error_code)
        : typeof result === 'string'
          ? result
          : null
    throw new RequestError('http', { detail: detail ?? 'Todoist refused to clear the due date.' })
  }
}

export async function moveTask(
  options: WriteOptions & { id: string; projectId: string; sectionId: string | null }
): Promise<void> {
  await requestJson(taskPath(options.id, '/move'), options.token, options.signal, {
    method: 'POST',
    body: { project_id: options.projectId, section_id: options.sectionId }
  })
}

export async function closeTask(options: WriteOptions & { id: string }): Promise<void> {
  await requestJson(taskPath(options.id, '/close'), options.token, options.signal, {
    method: 'POST'
  })
}

export async function reopenTask(options: WriteOptions & { id: string }): Promise<void> {
  await requestJson(taskPath(options.id, '/reopen'), options.token, options.signal, {
    method: 'POST'
  })
}

export async function deleteTask(options: WriteOptions & { id: string }): Promise<void> {
  await requestJson(taskPath(options.id), options.token, options.signal, { method: 'DELETE' })
}

export async function createProject(
  options: WriteOptions & { input: ProjectCreateInput }
): Promise<void> {
  const name = options.input.name.trim()
  await requestJson(`${API}/projects`, options.token, options.signal, {
    method: 'POST',
    body: { name, color: options.input.color ?? 'charcoal' }
  })
}

// --- snapshot --------------------------------------------------------------------------------

export async function fetchSnapshot(options: {
  token: string
  signal?: AbortSignal
  now?: number
}): Promise<TodoistSnapshot> {
  const { token, signal } = options
  const [tasks, projects, sections, labels, user] = await Promise.all([
    collection('/tasks', token, signal),
    collection('/projects', token, signal),
    collection('/sections', token, signal),
    collection('/labels', token, signal),
    requestJson(`${API}/user`, token, signal)
  ])
  return {
    fetchedAt: options.now ?? Date.now(),
    tasks: normalizeAll(tasks, taskOf),
    projects: normalizeAll(projects, projectOf),
    sections: normalizeAll(sections, sectionOf),
    labels: normalizeAll(labels, labelOf),
    user: userOf(user)
  }
}
