// The full Todoist page: an Orca custom editor for `.todoist` files. The file holds what the
// person was looking at; the worker holds everything read from Todoist.

import { colorOf, priorityColor, priorityName } from './colors'
import { messagesFor, dayLabel, type Messages } from './messages'
import {
  DUE_BUCKETS,
  SORT_KEYS,
  addDays,
  addMonths,
  bucketOf,
  calendarGrid,
  contextOf,
  dayKeyOf,
  dueDayKey,
  filterTasks,
  formatDay,
  formatTime,
  groupByBucket,
  monthOf,
  projectColumns,
  sortTasks,
  statsOf,
  subtaskCounts,
  tasksByDay,
  type CalendarCell,
  type DueBucket,
  type SortKey,
  type ViewFilters
} from './select'
import {
  DEFAULT_STATE,
  parsePageState,
  serializePageState,
  type PageState,
  type PageView
} from './page-state'
import type { EditorSession } from 'orca/frame'
import type {
  TaskCreateInput,
  TaskUpdateInput,
  TodoistError,
  TodoistErrorCode,
  TodoistProject,
  TodoistSection,
  TodoistSnapshot,
  TodoistTask,
  TodoistView
} from './protocol'

const TODOIST_URL = 'https://app.todoist.com/app/today'
const TOKEN_HELP_URL = 'https://app.todoist.com/app/settings/integrations'
const PAGE_VIEWS: readonly PageView[] = ['list', 'calendar', 'board']
const REFRESH_MS = 60_000

const locale = orca.locale
const m: Messages = messagesFor(locale)

// --- tiny DOM helpers -----------------------------------------------------------------------

type Options = {
  class?: string
  text?: string
  attrs?: Record<string, string>
  style?: Record<string, string>
}
type Child = Node | string | null | undefined | false

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: Options = {},
  children: readonly Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class !== undefined) {
    node.className = options.class
  }
  if (options.text !== undefined) {
    node.textContent = options.text
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value)
  }
  for (const [name, value] of Object.entries(options.style ?? {})) {
    node.style.setProperty(name, value)
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue
    }
    node.append(child)
  }
  return node
}

function button(text: string, onClick: () => void, className = 'tv-btn'): HTMLButtonElement {
  const node = h('button', { class: className, attrs: { type: 'button' }, text })
  node.addEventListener('click', onClick)
  return node
}

function iconButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = h('button', {
    class: 'tv-icon',
    attrs: { type: 'button', 'aria-label': label, title: label }
  })
  node.append(h('span', { attrs: { 'aria-hidden': 'true' }, text: glyph }))
  node.addEventListener('click', onClick)
  return node
}

function dot(color: string): HTMLElement {
  return h('span', {
    class: 'tv-dot',
    attrs: { 'aria-hidden': 'true' },
    style: { background: color }
  })
}

function emptyState(title: string, body: string): HTMLElement {
  return h('div', { class: 'tv-empty' }, [
    h('h2', { class: 'tv-empty-title', text: title }),
    h('p', { class: 'tv-empty-body', text: body })
  ])
}

// --- state ----------------------------------------------------------------------------------

type Ui = {
  root: HTMLDivElement
  search: HTMLInputElement
  tabs: Map<PageView, HTMLButtonElement>
  sort: HTMLSelectElement
  filterToggle: HTMLButtonElement
  refresh: HTMLButtonElement
  banner: HTMLDivElement
  compose: HTMLDivElement
  composeInput: HTMLInputElement
  composeProject: HTMLSelectElement
  composeDate: HTMLInputElement
  composePriority: HTMLSelectElement
  composeButton: HTMLButtonElement
  composeError: HTMLSpanElement
  rail: HTMLElement
  main: HTMLElement
  detail: HTMLElement
  foot: HTMLElement
  setup: HTMLDivElement
  toast: HTMLDivElement
}

type PageData = {
  snapshot: TodoistSnapshot
  tz: string
  todayKey: string
  filters: ViewFilters
  tasks: TodoistTask[]
  projects: ReadonlyMap<string, TodoistProject>
  sections: ReadonlyMap<string, TodoistSection>
  counts: Map<string, number>
}

let ui: Ui | null = null
let doc: EditorSession<PageState> | null = null
let state: PageState = DEFAULT_STATE
let current: TodoistView | null = null
let requestError: string | null = null
let requesting = false
let connecting = false
let tokenError: string | null = null
let typedToken = ''
let selectedTaskId: string | null = null
let railOpen = false
let detailOpen = false
let weekStartsOn: 0 | 1 = 1
let searchTimer: number | null = null
let composing = false
let composeError: string | null = null
let composeProjectId: string | null = null
let composeProjectKey = ''
let creatingProject = false
let editingTaskId: string | null = null
let deleteArmed = false
let projectDraft = ''
const closing = new Set<string>()
let toastTimer: number | null = null

// --- persistence ----------------------------------------------------------------------------

function readOnly(): boolean {
  return doc !== null && doc.readOnly
}

/** Whether the connection screen stands in for the page: no view yet, or no token saved. */
function setupOpen(): boolean {
  return current === null || current.token.source === 'none'
}

function persist(): void {
  if (doc !== null && !doc.readOnly) {
    doc.change(state)
  }
}

function apply(patch: Partial<PageState>): void {
  state = { ...state, ...patch }
  persist()
  render()
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function toggleProject(id: string): void {
  apply({ projectIds: toggle(state.projectIds, id) })
}

function toggleLabel(name: string): void {
  apply({ labelNames: toggle(state.labelNames, name) })
}

function togglePriority(priority: number): void {
  apply({ priorities: toggle(state.priorities, priority) })
}

function toggleBucket(bucket: DueBucket): void {
  apply({ buckets: toggle(state.buckets, bucket) })
}

function toggleCollapsed(bucket: DueBucket): void {
  apply({ collapsed: toggle(state.collapsed, bucket) })
}

function isSortKey(value: string): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value)
}

function hasActiveFilters(value: PageState): boolean {
  return (
    value.query.trim() !== '' ||
    value.projectIds.length > 0 ||
    value.labelNames.length > 0 ||
    value.priorities.length > 0 ||
    value.buckets.length > 0 ||
    value.hideSubtasks
  )
}

function filtersOf(value: PageState): ViewFilters {
  return {
    query: value.query,
    projectIds: value.projectIds,
    labelNames: value.labelNames,
    priorities: value.priorities,
    buckets: value.buckets,
    hideSubtasks: value.hideSubtasks
  }
}

// --- data helpers ---------------------------------------------------------------------------

function snapshotOf(): TodoistSnapshot | null {
  if (current === null) {
    return null
  }
  const status = current.state
  return status.status === 'ready' || status.status === 'error' ? status.snapshot : null
}

function dataOf(): PageData | null {
  const snapshot = snapshotOf()
  if (snapshot === null) {
    return null
  }
  const tz = snapshot.user?.timezone ?? 'UTC'
  const todayKey = dayKeyOf(new Date(), tz)
  const context = contextOf(snapshot)
  const filters = filtersOf(state)
  return {
    snapshot,
    tz,
    todayKey,
    filters,
    tasks: filterTasks(snapshot, filters, todayKey, tz),
    projects: context.projects,
    sections: context.sections,
    counts: subtaskCounts(snapshot.tasks)
  }
}

function dueText(task: TodoistTask, tz: string, todayKey: string): string | null {
  const time = formatTime(task.due?.datetime ?? null, locale, tz)
  const key = dueDayKey(task.due, tz)
  if (key !== null) {
    const base = dayLabel(m, key, todayKey, locale, (day, language) => formatDay(day, language))
    return time === null ? base : `${base}, ${time}`
  }
  const words = task.due?.string ?? null
  if (words !== null && words !== '') {
    return words
  }
  return time
}

function dueChip(task: TodoistTask, data: PageData): HTMLElement | null {
  const text = dueText(task, data.tz, data.todayKey)
  if (text === null) {
    return null
  }
  return h('span', {
    class: 'tv-due',
    attrs: { 'data-bucket': bucketOf(task, data.todayKey, data.tz) },
    text
  })
}

function labelChips(task: TodoistTask, limit = 2): HTMLElement[] {
  return task.labels
    .slice(0, limit)
    .map((label) => h('span', { class: 'tv-label', text: `@${label}` }))
}

function projectMeta(project: TodoistProject | undefined): HTMLElement {
  return h('span', { class: 'tv-project' }, [
    dot(colorOf(project?.color ?? null)),
    h('span', { class: 'tv-project-name', text: project?.name ?? '' })
  ])
}

function dayOfTimestamp(value: string | null, tz: string): string | null {
  if (value === null) {
    return null
  }
  const at = Date.parse(value)
  return Number.isFinite(at) ? dayKeyOf(new Date(at), tz) : null
}

function relativeTime(at: number, now: number, language: string): string {
  const seconds = Math.round((at - now) / 1000)
  const size = Math.abs(seconds)
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (size < 60) {
    return format.format(seconds, 'second')
  }
  if (size < 3600) {
    return format.format(Math.round(seconds / 60), 'minute')
  }
  if (size < 86_400) {
    return format.format(Math.round(seconds / 3600), 'hour')
  }
  return format.format(Math.round(seconds / 86_400), 'day')
}

function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric'
  }).format(new Date(Date.UTC(year, (number ?? 1) - 1, 1, 12)))
}

function weekdayNames(): string[] {
  // 2024-01-07 was a Sunday; walk from the chosen first day of the week.
  const format = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' })
  const names: string[] = []
  for (let index = 0; index < 7; index += 1) {
    const key = addDays('2024-01-07', (weekStartsOn + index) % 7)
    names.push(format.format(new Date(`${key}T12:00:00Z`)))
  }
  return names
}

// --- host actions ---------------------------------------------------------------------------

function openExternal(url: string): void {
  const shell = orca.shell
  if (shell === undefined) {
    return
  }
  try {
    void shell.openExternal(url).catch(() => undefined)
  } catch {
    // The shell can be absent in browser clients, or refuse without a gesture.
  }
}

function messageOf(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown }
  const detail = typeof candidate.message === 'string' ? candidate.message : null
  const code =
    typeof candidate.code === 'string' && candidate.code in m.errors
      ? (candidate.code as TodoistErrorCode)
      : 'unreachable'
  const todoistError: TodoistError = {
    code,
    httpStatus: null,
    detail,
    retryAfterMs: null
  }
  return m.errors[code](todoistError)
}

async function load(force = false): Promise<void> {
  if (requesting) {
    return
  }
  requesting = true
  renderHeader()
  try {
    current = force
      ? await orca.plugin.request('todoist.refresh')
      : await orca.plugin.request('todoist.get')
    requestError = null
  } catch (error) {
    requestError = messageOf(error)
  } finally {
    requesting = false
    render()
  }
}

async function connect(): Promise<void> {
  const value = typedToken.trim()
  if (value === '' || requesting) {
    return
  }
  requesting = true
  connecting = true
  tokenError = null
  render()
  try {
    current = await orca.plugin.request('token.set', { value })
    typedToken = ''
  } catch (error) {
    tokenError = messageOf(error)
  } finally {
    requesting = false
    connecting = false
    render()
  }
}

async function forgetToken(): Promise<void> {
  if (requesting) {
    return
  }
  requesting = true
  renderHeader()
  try {
    current = await orca.plugin.request('token.forget')
    selectedTaskId = null
    detailOpen = false
    typedToken = ''
    tokenError = null
  } catch (error) {
    tokenError = messageOf(error)
  } finally {
    requesting = false
    render()
  }
}

// --- writes ---------------------------------------------------------------------------------

function errorText(error: TodoistError): string {
  const words = m.errors[error.code](error)
  return error.detail === null || error.detail === '' ? words : `${words} ${error.detail}`
}

/** Shows a short status below the page, with an optional action such as Undo. */
function showToast(message: string, action?: { label: string; run: () => void }): void {
  if (ui === null) {
    return
  }
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer)
  }
  const box = ui.toast
  box.replaceChildren(h('span', { class: 'tv-toast-text', text: message }))
  if (action !== undefined) {
    box.append(
      button(
        action.label,
        () => {
          box.hidden = true
          action.run()
        },
        'tv-link'
      )
    )
  }
  box.hidden = false
  toastTimer = window.setTimeout(() => {
    box.hidden = true
    toastTimer = null
  }, 8000)
}

/** Keeps the composer's project picker in step with the account without losing a choice. */
function renderComposer(): void {
  if (ui === null) {
    return
  }
  ui.compose.hidden = setupOpen()
  if (ui.compose.hidden) {
    return
  }
  const projects = [...(snapshotOf()?.projects ?? [])].sort((left, right) => left.order - right.order)
  const key = projects.map((project) => `${project.id}:${project.name}:${project.order}`).join('|')
  if (key !== composeProjectKey) {
    composeProjectKey = key
    const picker = ui.composeProject
    picker.replaceChildren()
    for (const project of projects) {
      picker.append(h('option', { attrs: { value: project.id }, text: project.name }))
    }
    const inbox = projects.find((project) => project.isInboxProject) ?? projects[0]
    if (!projects.some((project) => project.id === composeProjectId)) {
      composeProjectId = inbox?.id ?? null
    }
    picker.value = composeProjectId ?? ''
  }
  ui.composeButton.disabled = composing || ui.composeInput.value.trim() === ''
  ui.composeError.textContent = composeError ?? ''
  ui.composeError.hidden = composeError === null
}

async function createFromComposer(): Promise<void> {
  if (ui === null) {
    return
  }
  const content = ui.composeInput.value.trim()
  if (content === '' || composing) {
    return
  }
  composing = true
  composeError = null
  renderComposer()
  const input: TaskCreateInput = {
    content,
    projectId: ui.composeProject.value === '' ? null : ui.composeProject.value,
    dueDate: ui.composeDate.value === '' ? null : ui.composeDate.value,
    priority: Number(ui.composePriority.value) || 1
  }
  try {
    const result = await orca.plugin.request('task.create', input)
    if (result.ok) {
      current = result.view
      ui.composeInput.value = ''
      ui.composeDate.value = ''
      showToast(m.savedToast)
      render()
      ui.composeInput.focus()
      return
    }
    composeError = errorText(result.error)
  } catch (error) {
    composeError = messageOf(error)
  } finally {
    composing = false
    renderComposer()
  }
}

async function completeTask(id: string): Promise<void> {
  if (closing.has(id)) {
    return
  }
  const task = snapshotOf()?.tasks.find((candidate) => candidate.id === id) ?? null
  closing.add(id)
  try {
    const result = await orca.plugin.request('task.close', { id })
    if (!result.ok) {
      showToast(errorText(result.error))
      return
    }
    current = result.view
    if (selectedTaskId === id) {
      selectedTaskId = null
      detailOpen = false
      editingTaskId = null
    }
    showToast(task === null ? m.savedToast : m.completedToast(task.content), {
      label: m.undo,
      run: () => void reopenTask(id)
    })
  } catch (error) {
    showToast(messageOf(error))
  } finally {
    closing.delete(id)
    render()
  }
}

async function reopenTask(id: string): Promise<void> {
  try {
    const result = await orca.plugin.request('task.reopen', { id })
    if (result.ok) {
      current = result.view
      showToast(m.savedToast)
      render()
    } else {
      showToast(errorText(result.error))
    }
  } catch (error) {
    showToast(messageOf(error))
  }
}

async function createProject(name: string): Promise<void> {
  const value = name.trim()
  if (value === '' || creatingProject) {
    return
  }
  creatingProject = true
  try {
    const result = await orca.plugin.request('project.create', { name: value })
    if (result.ok) {
      current = result.view
      projectDraft = ''
      creatingProject = false
      showToast(m.savedToast)
    } else {
      showToast(errorText(result.error))
      creatingProject = true
      projectDraft = value
    }
    render()
  } catch (error) {
    creatingProject = false
    showToast(messageOf(error))
    render()
  }
}

// --- shell ----------------------------------------------------------------------------------

function build(): Ui {
  const search = h('input', {
    class: 'tv-search-input',
    attrs: {
      type: 'search',
      placeholder: m.searchPlaceholder,
      'aria-label': m.search,
      autocomplete: 'off',
      spellcheck: 'false'
    }
  })
  search.value = state.query
  search.addEventListener('input', (event) => {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement)) {
      return
    }
    state = { ...state, query: target.value }
    if (searchTimer !== null) {
      window.clearTimeout(searchTimer)
    }
    searchTimer = window.setTimeout(() => {
      searchTimer = null
      persist()
      renderRail()
      renderMain()
      renderFooter()
    }, 200)
  })

  const tabs = new Map<PageView, HTMLButtonElement>()
  const tabList = h('div', { class: 'tv-tabs', attrs: { role: 'tablist' } })
  for (const view of PAGE_VIEWS) {
    const tab = h('button', {
      class: 'tv-tab',
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
      text: m.views[view]
    })
    tab.addEventListener('click', () => apply({ view }))
    tabs.set(view, tab)
    tabList.append(tab)
  }

  const sort = h('select', {
    class: 'tv-sort-select',
    attrs: { 'aria-label': m.sortLabel, title: m.sortLabel }
  })
  for (const key of SORT_KEYS) {
    sort.append(h('option', { attrs: { value: key }, text: m.sort[key] }))
  }
  sort.value = state.sort
  sort.addEventListener('change', () => {
    const next = sort.value
    if (isSortKey(next)) {
      apply({ sort: next })
    }
  })

  const filterToggle = h('button', {
    class: 'tv-btn tv-filter-toggle',
    attrs: { type: 'button', 'aria-expanded': 'false' },
    text: m.filters
  })
  filterToggle.addEventListener('click', () => {
    railOpen = !railOpen
    renderHeader()
  })

  const refresh = iconButton('↻', m.refresh, () => {
    void load(true)
  })

  const brand = h('div', { class: 'tv-brand' }, [
    h('h1', { class: 'tv-title', text: m.title }),
    h('span', { class: 'tv-tagline', text: m.tagline })
  ])

  const bar = h('header', { class: 'tv-bar' }, [
    brand,
    h('div', { class: 'tv-search' }, [
      h('span', { class: 'tv-sr', text: m.search }),
      search
    ]),
    tabList,
    h('label', { class: 'tv-sort' }, [
      h('span', { class: 'tv-sr', text: m.sortLabel }),
      sort
    ]),
    filterToggle,
    refresh
  ])

  const banner = h('div', { class: 'tv-banner', attrs: { 'aria-live': 'polite' } })
  banner.hidden = true

  const rail = h('aside', { class: 'tv-rail', attrs: { 'aria-label': m.filters } })
  const main = h('main', { class: 'tv-main' })
  const detail = h('aside', { class: 'tv-detail', attrs: { 'aria-label': m.detailTitle } })
  detail.hidden = true

  const composeInput = h('input', {
    class: 'tv-compose-input',
    attrs: {
      type: 'text',
      placeholder: m.addTaskPlaceholder,
      'aria-label': m.addTask,
      autocomplete: 'off'
    }
  })
  composeInput.addEventListener('input', () => {
    if (ui !== null) {
      ui.composeButton.disabled = composing || ui.composeInput.value.trim() === ''
      if (composeError !== null) {
        composeError = null
        ui.composeError.hidden = true
      }
    }
  })
  composeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void createFromComposer()
    }
  })

  const composeProject = h('select', {
    class: 'tv-compose-project',
    attrs: { 'aria-label': m.projects }
  })
  composeProject.addEventListener('change', () => {
    composeProjectId = composeProject.value === '' ? null : composeProject.value
  })

  const composeDate = h('input', {
    class: 'tv-compose-date',
    attrs: { type: 'date', 'aria-label': m.detailDue }
  })

  const composePriority = h('select', {
    class: 'tv-compose-priority',
    attrs: { 'aria-label': m.detailPriority }
  })
  for (const priority of [4, 3, 2, 1]) {
    composePriority.append(
      h('option', { attrs: { value: String(priority) }, text: priorityName(priority) })
    )
  }
  composePriority.value = '1'

  const composeButton = button(
    m.createTask,
    () => void createFromComposer(),
    'tv-btn tv-btn-primary'
  )
  composeButton.disabled = true
  const composeErrorNode = h('span', {
    class: 'tv-compose-error',
    attrs: { role: 'alert' }
  })
  composeErrorNode.hidden = true

  const compose = h('div', { class: 'tv-compose' }, [
    composeInput,
    composeProject,
    composeDate,
    composePriority,
    composeButton,
    composeErrorNode
  ])

  const toast = h('div', { class: 'tv-toast', attrs: { role: 'status', 'aria-live': 'polite' } })
  toast.hidden = true

  const body = h('div', { class: 'tv-body' }, [rail, main, detail])
  const foot = h('footer', { class: 'tv-foot' })
  const setup = h('div', { class: 'tv-setup' })

  const root = h('div', { class: 'tv', attrs: { 'data-view': state.view } }, [
    bar,
    banner,
    compose,
    body,
    foot,
    setup,
    toast
  ])

  return {
    root,
    search,
    tabs,
    sort,
    filterToggle,
    refresh,
    banner,
    compose,
    composeInput,
    composeProject,
    composeDate,
    composePriority,
    composeButton,
    composeError: composeErrorNode,
    rail,
    main,
    detail,
    foot,
    setup,
    toast
  }
}

// --- render ---------------------------------------------------------------------------------

function render(): void {
  if (ui === null) {
    return
  }
  const active = document.activeElement
  const wasToken = active instanceof HTMLInputElement && active.classList.contains('tv-token-input')
  const caret = wasToken ? active.selectionStart : null
  renderHeader()
  renderBanner()
  renderComposer()
  renderRail()
  renderMain()
  renderDetail()
  renderFooter()
  renderSetup()
  if (wasToken) {
    const next = ui.root.querySelector<HTMLInputElement>('.tv-token-input')
    if (next !== null) {
      next.focus()
      if (caret !== null) {
        next.setSelectionRange(caret, caret)
      }
    }
  }
}

function renderHeader(): void {
  if (ui === null) {
    return
  }
  ui.root.dataset.view = state.view
  ui.root.classList.toggle('tv-rail-open', railOpen)
  if (ui.search.value !== state.query) {
    ui.search.value = state.query
  }
  for (const [view, tab] of ui.tabs) {
    const active = view === state.view
    tab.setAttribute('aria-selected', String(active))
    tab.classList.toggle('is-active', active)
  }
  if (ui.sort.value !== state.sort) {
    ui.sort.value = state.sort
  }
  ui.filterToggle.setAttribute('aria-expanded', String(railOpen))
  ui.filterToggle.classList.toggle('is-active', hasActiveFilters(state))
  ui.refresh.disabled = requesting
}

function renderBanner(): void {
  if (ui === null) {
    return
  }
  const box = ui.banner
  box.replaceChildren()
  const snapshot = snapshotOf()
  const status = current?.state
  if (status === undefined || status.status !== 'error' || snapshot === null) {
    box.hidden = true
    return
  }
  box.hidden = false
  const inner = h('div', { class: 'tv-banner-inner' }, [
    h('div', { class: 'tv-banner-text' }, [
      h('strong', { text: m.staleTitle }),
      h('span', { text: m.errors[status.error.code](status.error) })
    ]),
    h('div', { class: 'tv-banner-actions' }, [
      button(m.retry, () => void load(true), 'tv-btn tv-btn-primary')
    ])
  ])
  box.append(inner)
  if (status.error.code === 'bad_token') {
    box.append(connectCard(true))
  }
}

function renderSetup(): void {
  if (ui === null) {
    return
  }
  const box = ui.setup
  box.replaceChildren()
  let open = false
  if (current === null) {
    open = true
    if (requestError !== null) {
      box.append(errorCard(requestError, false))
    } else {
      box.append(
        h('div', { class: 'tv-setup-card' }, [
          h('p', { class: 'tv-muted', text: m.loading })
        ])
      )
    }
  } else if (current.token.source === 'none') {
    open = true
    box.append(connectCard(false))
  }
  ui.root.classList.toggle('tv-setup-open', open)
}

function renderRail(): void {
  if (ui === null) {
    return
  }
  const rail = ui.rail
  rail.replaceChildren()
  if (setupOpen()) {
    return
  }
  const data = dataOf()
  if (data === null) {
    return
  }

  const stats = statsOf(data.snapshot.tasks, data.todayKey, data.tz)
  const tiles: { label: string; value: number; tone: string }[] = [
    { label: m.stats.overdue, value: stats.overdue, tone: 'danger' },
    { label: m.stats.today, value: stats.today, tone: 'accent' },
    { label: m.stats.week, value: stats.week, tone: 'plain' },
    { label: m.stats.total, value: stats.total, tone: 'plain' }
  ]
  const statGrid = h('div', { class: 'tv-stats' })
  for (const tile of tiles) {
    statGrid.append(
      h('div', { class: 'tv-tile', attrs: { 'data-tone': tile.tone } }, [
        h('span', { class: 'tv-tile-value', text: String(tile.value) }),
        h('span', { class: 'tv-tile-label', text: tile.label })
      ])
    )
  }
  rail.append(statGrid)
  rail.append(projectsSection(data))
  const labels = labelsSection(data)
  if (labels !== null) {
    rail.append(labels)
  }
  rail.append(prioritySection(data))
  rail.append(bucketsSection(data))

  const checkbox = h('input', { attrs: { type: 'checkbox' } })
  checkbox.checked = state.hideSubtasks
  checkbox.addEventListener('change', () => apply({ hideSubtasks: checkbox.checked }))
  rail.append(
    h('label', { class: 'tv-check' }, [checkbox, h('span', { text: m.hideSubtasks })])
  )

  if (hasActiveFilters(state)) {
    rail.append(
      button(
        m.clearFilters,
        () => {
          if (searchTimer !== null) {
            window.clearTimeout(searchTimer)
            searchTimer = null
          }
          apply({
            query: '',
            projectIds: [],
            labelNames: [],
            priorities: [],
            buckets: [],
            hideSubtasks: false
          })
        },
        'tv-btn tv-clear'
      )
    )
  }
}

function section(title: string, children: readonly Child[]): HTMLElement {
  return h('section', { class: 'tv-rail-section' }, [
    h('h3', { class: 'tv-rail-title', text: title }),
    ...children
  ])
}

function projectsSection(data: PageData): HTMLElement {
  const counts = new Map<string, number>()
  for (const task of data.snapshot.tasks) {
    counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1)
  }
  const list = h('div', { class: 'tv-project-list' })

  const all = h('button', {
    class: 'tv-pill-row',
    attrs: { type: 'button', 'aria-pressed': String(state.projectIds.length === 0) }
  })
  all.append(h('span', { class: 'tv-project-name', text: m.allProjects }))
  all.addEventListener('click', () => apply({ projectIds: [] }))
  list.append(all)

  const ordered = [...data.snapshot.projects].sort((left, right) => left.order - right.order)
  for (const project of ordered) {
    const row = h('button', {
      class: 'tv-pill-row',
      attrs: {
        type: 'button',
        'aria-pressed': String(state.projectIds.includes(project.id))
      }
    })
    row.append(
      dot(colorOf(project.color)),
      h('span', { class: 'tv-project-name', text: project.name }),
      h('span', { class: 'tv-count', text: String(counts.get(project.id) ?? 0) })
    )
    row.addEventListener('click', () => toggleProject(project.id))
    list.append(row)
  }
  if (creatingProject) {
    const input = h('input', {
      class: 'tv-input tv-project-input',
      attrs: { type: 'text', placeholder: m.projectName, 'aria-label': m.projectName }
    })
    input.value = projectDraft
    const create = button(m.createProject, () => void createProject(input.value), 'tv-btn tv-btn-primary')
    create.disabled = projectDraft.trim() === ''
    input.addEventListener('input', () => {
      projectDraft = input.value
      create.disabled = input.value.trim() === ''
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void createProject(input.value)
      }
      if (event.key === 'Escape') {
        creatingProject = false
        projectDraft = ''
        renderRail()
      }
    })
    list.append(h('div', { class: 'tv-new-project' }, [input, create]))
    queueMicrotask(() => input.focus())
  } else {
    list.append(
      button(
        m.newProject,
        () => {
          creatingProject = true
          projectDraft = ''
          renderRail()
        },
        'tv-btn tv-add-project'
      )
    )
  }
  return section(m.projects, [list])
}

function labelsSection(data: PageData): HTMLElement | null {
  const counts = new Map<string, number>()
  for (const task of data.snapshot.tasks) {
    for (const label of task.labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  const ordered: string[] = []
  const known = [...data.snapshot.labels].sort((left, right) => left.order - right.order)
  for (const label of known) {
    if (counts.has(label.name) && !ordered.includes(label.name)) {
      ordered.push(label.name)
    }
  }
  for (const name of counts.keys()) {
    if (!ordered.includes(name)) {
      ordered.push(name)
    }
  }
  if (ordered.length === 0) {
    return null
  }
  const chips = h('div', { class: 'tv-chips' })
  for (const name of ordered) {
    const chip = h('button', {
      class: 'tv-chip',
      attrs: { type: 'button', 'aria-pressed': String(state.labelNames.includes(name)) }
    })
    chip.append(
      h('span', { class: 'tv-chip-text', text: `@${name}` }),
      h('span', { class: 'tv-count', text: String(counts.get(name) ?? 0) })
    )
    chip.addEventListener('click', () => toggleLabel(name))
    chips.append(chip)
  }
  return section(m.labels, [chips])
}

function prioritySection(data: PageData): HTMLElement {
  const counts = new Map<number, number>()
  for (const task of data.snapshot.tasks) {
    counts.set(task.priority, (counts.get(task.priority) ?? 0) + 1)
  }
  const chips = h('div', { class: 'tv-chips' })
  for (const priority of [4, 3, 2, 1]) {
    const chip = h('button', {
      class: 'tv-chip',
      attrs: { type: 'button', 'aria-pressed': String(state.priorities.includes(priority)) }
    })
    chip.append(
      dot(priorityColor(priority)),
      h('span', { class: 'tv-chip-text', text: priorityName(priority) }),
      h('span', { class: 'tv-count', text: String(counts.get(priority) ?? 0) })
    )
    chip.addEventListener('click', () => togglePriority(priority))
    chips.append(chip)
  }
  return section(m.priorities, [chips])
}

function bucketsSection(data: PageData): HTMLElement {
  const counts = new Map<DueBucket, number>()
  for (const task of data.snapshot.tasks) {
    const bucket = bucketOf(task, data.todayKey, data.tz)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const chips = h('div', { class: 'tv-chips' })
  for (const bucket of DUE_BUCKETS) {
    const chip = h('button', {
      class: 'tv-chip',
      attrs: { type: 'button', 'aria-pressed': String(state.buckets.includes(bucket)) }
    })
    chip.append(
      h('span', { class: 'tv-chip-text', text: m.buckets[bucket] }),
      h('span', { class: 'tv-count', text: String(counts.get(bucket) ?? 0) })
    )
    chip.addEventListener('click', () => toggleBucket(bucket))
    chips.append(chip)
  }
  return section(m.dateBuckets, [chips])
}

function renderMain(): void {
  if (ui === null) {
    return
  }
  const main = ui.main
  main.replaceChildren()
  if (setupOpen()) {
    return
  }

  const snapshot = snapshotOf()
  if (snapshot === null) {
    const status = current?.state
    if (status !== undefined && status.status === 'error') {
      main.append(
        errorCard(
          m.errors[status.error.code](status.error),
          current !== null && current.token.source !== 'none'
        )
      )
      if (status.error.code === 'bad_token') {
        main.append(connectCard(false))
      }
    } else if (requestError !== null) {
      main.append(
        errorCard(requestError, current !== null && current.token.source !== 'none')
      )
    } else {
      main.append(
        h('div', { class: 'tv-center' }, [h('p', { class: 'tv-muted', text: m.loading })])
      )
    }
    return
  }

  const data = dataOf()
  if (data === null) {
    return
  }
  if (state.view === 'calendar') {
    main.append(calendarView(data))
    return
  }

  if (snapshot.tasks.length === 0) {
    main.append(emptyState(m.noTasks, m.noTasksBody))
    return
  }
  if (data.tasks.length === 0) {
    main.append(emptyState(m.noMatch, m.noMatchBody))
    return
  }
  if (state.view === 'board') {
    main.append(boardView(data))
    return
  }
  main.append(listView(data))
}

function listView(data: PageData): HTMLElement {
  const wrap = h('div', { class: 'tv-list' })
  if (state.sort !== 'due' || state.buckets.length > 0) {
    for (const task of sortTasks(data.tasks, state.sort, data.tz, data.projects)) {
      wrap.append(taskRow(task, data))
    }
    return wrap
  }

  for (const group of groupByBucket(
    data.tasks,
    data.todayKey,
    data.tz,
    state.sort,
    data.projects
  )) {
    const collapsed = state.collapsed.includes(group.bucket)
    const head = h('button', {
      class: 'tv-group',
      attrs: { type: 'button', 'aria-expanded': String(!collapsed) }
    })
    head.append(
      h('span', {
        class: 'tv-chevron',
        attrs: { 'aria-hidden': 'true' },
        text: collapsed ? '▸' : '▾'
      }),
      h('span', { class: 'tv-group-name', text: m.buckets[group.bucket] }),
      h('span', { class: 'tv-count', text: String(group.tasks.length) })
    )
    head.addEventListener('click', () => toggleCollapsed(group.bucket))
    wrap.append(head)
    if (!collapsed) {
      for (const task of group.tasks) {
        wrap.append(taskRow(task, data))
      }
    }
  }
  return wrap
}

function taskRow(task: TodoistTask, data: PageData): HTMLElement {
  const project = data.projects.get(task.projectId)
  const subtasks = data.counts.get(task.id) ?? 0
  const selected = selectedTaskId === task.id && detailOpen
  const row = h('div', { class: 'tv-row', attrs: { 'data-selected': String(selected) } })

  const check = h('button', {
    class: 'tv-done',
    attrs: { type: 'button', 'aria-label': m.complete, title: m.complete }
  })
  check.append(h('span', { class: 'tv-done-dot', attrs: { 'aria-hidden': 'true' } }))
  check.disabled = closing.has(task.id)
  check.addEventListener('click', (event) => {
    event.stopPropagation()
    void completeTask(task.id)
  })

  const main = h('button', { class: 'tv-row-main', attrs: { type: 'button' } })
  main.setAttribute('aria-current', selected ? 'true' : 'false')
  main.append(
    h('span', {
      class: 'tv-stripe',
      attrs: { 'aria-hidden': 'true' },
      style: { background: priorityColor(task.priority) }
    })
  )
  const meta = h('div', { class: 'tv-row-meta' }, [projectMeta(project)])
  const due = dueChip(task, data)
  if (due !== null) {
    meta.append(due)
  }
  for (const chip of labelChips(task)) {
    meta.append(chip)
  }
  if (subtasks > 0) {
    meta.append(h('span', { class: 'tv-subtasks', text: m.subtaskCount(subtasks) }))
  }
  main.append(
    h('div', { class: 'tv-row-body' }, [
      h('div', { class: 'tv-row-title', text: task.content }),
      meta
    ])
  )
  main.addEventListener('click', () => selectTask(task.id))
  row.append(check, main)
  return row
}

function calendarView(data: PageData): HTMLElement {
  const month = state.month ?? monthOf(data.todayKey)
  const wrap = h('div', { class: 'tv-cal' })

  wrap.append(
    h('div', { class: 'tv-cal-bar' }, [
      iconButton('‹', m.previousMonth, () => apply({ month: addMonths(month, -1) })),
      h('h2', { class: 'tv-cal-title', text: monthLabel(month) }),
      iconButton('›', m.nextMonth, () => apply({ month: addMonths(month, 1) })),
      button(
        m.calendarToday,
        () => {
          if (ui !== null) {
            ui.composeDate.value = data.todayKey
          }
          apply({ month: monthOf(data.todayKey), selectedDay: data.todayKey })
        },
        'tv-btn'
      )
    ])
  )

  const byDay = tasksByDay(data.tasks, data.tz)
  const week = h('div', { class: 'tv-cal-week' })
  for (const name of weekdayNames()) {
    week.append(h('div', { class: 'tv-cal-weekday', text: name }))
  }
  wrap.append(week)

  const grid = h('div', { class: 'tv-cal-grid' })
  for (const row of calendarGrid(month, weekStartsOn, data.todayKey)) {
    for (const cell of row) {
      grid.append(calendarCell(cell, byDay, data))
    }
  }
  wrap.append(grid)

  if (state.selectedDay !== null) {
    wrap.append(dayPanel(state.selectedDay, byDay, data))
  }
  return wrap
}

function calendarCell(
  cell: CalendarCell,
  byDay: Map<string, TodoistTask[]>,
  data: PageData
): HTMLElement {
  const tasks = byDay.get(cell.key) ?? []
  const node = h('div', {
    class: 'tv-cell',
    attrs: {
      role: 'button',
      tabindex: '0',
      'data-outside': String(!cell.inMonth),
      'data-today': String(cell.today),
      'aria-pressed': String(state.selectedDay === cell.key),
      'aria-label': formatDay(cell.key, locale, { weekday: true })
    }
  })
  const head = h('div', { class: 'tv-cell-head' }, [
    h('span', { class: 'tv-cell-day', text: String(cell.day) })
  ])
  if (tasks.length > 0) {
    head.append(h('span', { class: 'tv-count', text: String(tasks.length) }))
  }
  node.append(head)
  for (const task of tasks.slice(0, 3)) {
    node.append(calChip(task, data))
  }
  if (tasks.length > 3) {
    node.append(h('span', { class: 'tv-more', text: m.moreTasks(tasks.length - 3) }))
  }

  const activate = (): void => {
    if (ui !== null) {
      ui.composeDate.value = cell.key
    }
    apply({ selectedDay: cell.key })
  }
  node.addEventListener('click', activate)
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate()
    }
  })
  return node
}

function calChip(task: TodoistTask, data: PageData): HTMLButtonElement {
  const chip = h('button', {
    class: 'tv-cal-chip',
    attrs: { type: 'button', title: task.content }
  })
  chip.append(
    h('span', {
      class: 'tv-stripe',
      attrs: { 'aria-hidden': 'true' },
      style: { background: priorityColor(task.priority) }
    }),
    h('span', { class: 'tv-cal-chip-text', text: task.content })
  )
  chip.addEventListener('click', (event) => {
    event.stopPropagation()
    selectTask(task.id)
  })
  return chip
}

function dayPanel(
  dayKey: string,
  byDay: Map<string, TodoistTask[]>,
  data: PageData
): HTMLElement {
  const panel = h('section', { class: 'tv-day' })
  panel.append(
    h('h3', {
      class: 'tv-day-title',
      text: dayLabel(m, dayKey, data.todayKey, locale, (key, language) =>
        formatDay(key, language, { weekday: true })
      )
    })
  )
  const tasks = byDay.get(dayKey) ?? []
  if (tasks.length === 0) {
    panel.append(h('p', { class: 'tv-muted', text: m.noTasks }))
    return panel
  }
  for (const task of tasks) {
    panel.append(taskRow(task, data))
  }
  return panel
}

function boardView(data: PageData): HTMLElement {
  const board = h('div', { class: 'tv-board' })
  for (const column of projectColumns(
    data.tasks,
    data.snapshot.projects,
    state.sort,
    data.tz
  )) {
    const list = h('div', { class: 'tv-column-list' })
    for (const task of column.tasks) {
      list.append(card(task, data))
    }
    board.append(
      h('section', { class: 'tv-column' }, [
        h('header', { class: 'tv-column-head' }, [
          dot(colorOf(column.project.color)),
          h('span', { class: 'tv-column-name', text: column.project.name }),
          h('span', { class: 'tv-count', text: String(column.tasks.length) })
        ]),
        list
      ])
    )
  }
  return board
}

function card(task: TodoistTask, data: PageData): HTMLButtonElement {
  const node = h('button', {
    class: 'tv-card',
    attrs: { type: 'button', 'aria-selected': String(selectedTaskId === task.id && detailOpen) }
  })
  node.append(
    h('span', {
      class: 'tv-stripe',
      attrs: { 'aria-hidden': 'true' },
      style: { background: priorityColor(task.priority) }
    })
  )
  const body = h('div', { class: 'tv-card-body' }, [
    h('div', { class: 'tv-card-title', text: task.content })
  ])
  const meta = h('div', { class: 'tv-card-meta' })
  const due = dueChip(task, data)
  if (due !== null) {
    meta.append(due)
  }
  for (const chip of labelChips(task)) {
    meta.append(chip)
  }
  if (meta.childElementCount > 0) {
    body.append(meta)
  }
  node.append(body)
  node.addEventListener('click', () => selectTask(task.id))
  return node
}

function selectTask(id: string): void {
  if (id !== selectedTaskId) {
    editingTaskId = null
    deleteArmed = false
  }
  selectedTaskId = id
  detailOpen = true
  render()
}

function renderDetail(): void {
  if (ui === null) {
    return
  }
  const box = ui.detail
  if (!detailOpen) {
    editingTaskId = null
    deleteArmed = false
    box.dataset.editing = ''
  }
  // A form being typed into is not rebuilt by a background read; it would lose the draft.
  if (editingTaskId !== null && selectedTaskId === editingTaskId && box.dataset.editing === '1') {
    return
  }
  box.replaceChildren()
  const snapshot = snapshotOf()
  const task =
    snapshot !== null && selectedTaskId !== null
      ? snapshot.tasks.find((candidate) => candidate.id === selectedTaskId) ?? null
      : null
  const open = detailOpen && task !== null
  box.hidden = !open
  ui.root.classList.toggle('tv-detail-open', open)
  if (!open || task === null || snapshot === null) {
    editingTaskId = null
    deleteArmed = false
    box.dataset.editing = ''
    return
  }

  const data = dataOf()
  const sections = data?.sections ?? new Map<string, TodoistSection>()
  const counts = data?.counts ?? new Map<string, number>()
  const tz = snapshot.user?.timezone ?? 'UTC'
  const todayKey = dayKeyOf(new Date(), tz)

  if (editingTaskId === task.id) {
    box.dataset.editing = '1'
    box.append(editForm(task, data, snapshot, tz))
    return
  }
  box.dataset.editing = ''

  box.append(
    h('div', { class: 'tv-detail-head' }, [
      h('h2', { class: 'tv-detail-heading', text: m.detailTitle }),
      iconButton('×', m.close, () => {
        detailOpen = false
        editingTaskId = null
        render()
      })
    ]),
    h('h3', { class: 'tv-detail-task', text: task.content }),
    h('div', { class: 'tv-detail-description' }, [
      h('h4', { class: 'tv-detail-label', text: m.detailDescription }),
      h('p', {
        class: task.description.trim() === '' ? 'tv-muted' : '',
        text: task.description.trim() === '' ? m.detailNoDescription : task.description
      })
    ])
  )

  const project = data?.projects.get(task.projectId)
  const section = task.sectionId !== null ? sections.get(task.sectionId) : undefined
  const added = dayOfTimestamp(task.addedAt, tz)
  const parent =
    task.parentId !== null
      ? snapshot.tasks.find((candidate) => candidate.id === task.parentId) ?? null
      : null
  const subtasks = counts.get(task.id) ?? 0

  const rows = h('dl', { class: 'tv-detail-list' })
  rows.append(detailRow(m.detailProject, project?.name ?? m.detailNone))
  rows.append(detailRow(m.detailSection, section?.name ?? m.detailNone))
  rows.append(detailRow(m.detailDue, dueDetail(task, tz, todayKey)))
  rows.append(
    detailRow(
      m.detailDeadline,
      task.deadline !== null
        ? formatDay(task.deadline.date, locale, { weekday: true })
        : m.detailNone
    )
  )
  const priority = h('span', { class: 'tv-detail-inline' })
  priority.append(dot(priorityColor(task.priority)))
  priority.append(h('span', { text: priorityName(task.priority) }))
  rows.append(detailRow(m.detailPriority, priority))
  rows.append(
    detailRow(
      m.detailLabels,
      task.labels.length === 0 ? m.detailNone : task.labels.map((label) => `@${label}`).join(', ')
    )
  )
  rows.append(
    detailRow(m.detailAdded, added === null ? m.detailNone : formatDay(added, locale))
  )
  rows.append(
    detailRow(
      m.detailDuration,
      task.duration === null
        ? m.detailNone
        : task.duration.unit === 'day'
          ? m.durationDays(task.duration.amount)
          : m.durationMinutes(task.duration.amount)
    )
  )
  rows.append(
    detailRow(m.detailSubtasks, subtasks === 0 ? m.detailNone : m.subtaskCount(subtasks))
  )
  if (parent !== null) {
    rows.append(detailRow(m.detailParent, parent.content))
  }
  box.append(rows)

  box.append(
    h('div', { class: 'tv-detail-actions' }, [
      button(m.complete, () => void completeTask(task.id), 'tv-btn'),
      button(
        m.edit,
        () => {
          editingTaskId = task.id
          deleteArmed = false
          box.dataset.editing = '0'
          renderDetail()
        },
        'tv-btn tv-btn-primary'
      ),
      button(m.openTodoist, () => openExternal(task.url), 'tv-btn'),
      button(
        m.close,
        () => {
          detailOpen = false
          editingTaskId = null
          render()
        },
        'tv-btn'
      )
    ])
  )
}

function formField(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'tv-field' }, [
    h('span', { class: 'tv-field-label', text: label }),
    control
  ])
}

function editForm(task: TodoistTask, data: PageData | null, snapshot: TodoistSnapshot, tz: string): HTMLElement {
  const box = ui?.detail
  const root = h('div', { class: 'tv-edit' })

  const content = h('input', { class: 'tv-input tv-edit-content', attrs: { type: 'text' } })
  content.value = task.content
  const description = h('textarea', {
    class: 'tv-input tv-edit-description',
    attrs: { rows: '4' }
  })
  description.value = task.description

  const project = h('select', { class: 'tv-input tv-edit-project' })
  for (const item of [...snapshot.projects].sort((left, right) => left.order - right.order)) {
    project.append(h('option', { attrs: { value: item.id }, text: item.name }))
  }
  project.value = task.projectId

  const section = h('select', { class: 'tv-input tv-edit-section' })
  const fillSections = (projectId: string, selected: string | null): void => {
    section.replaceChildren(h('option', { attrs: { value: '' }, text: m.detailNone }))
    const items = [...(data?.sections.values() ?? [])]
      .filter((item) => item.projectId === projectId)
      .sort((left, right) => left.order - right.order)
    for (const item of items) {
      section.append(h('option', { attrs: { value: item.id }, text: item.name }))
    }
    section.value =
      selected !== null && items.some((item) => item.id === selected) ? selected : ''
  }
  fillSections(task.projectId, task.sectionId)
  project.addEventListener('change', () => fillSections(project.value, null))

  const dueDate = h('input', { class: 'tv-input tv-edit-date', attrs: { type: 'date' } })
  dueDate.value = dueDayKey(task.due, tz) ?? ''
  const dueTime = h('input', { class: 'tv-input tv-edit-time', attrs: { type: 'time' } })
  dueTime.value = timeValue(task, tz)

  const priority = h('select', { class: 'tv-input tv-edit-priority' })
  for (const value of [4, 3, 2, 1]) {
    priority.append(h('option', { attrs: { value: String(value) }, text: priorityName(value) }))
  }
  priority.value = String(task.priority)

  const labels = h('input', { class: 'tv-input tv-edit-labels', attrs: { type: 'text' } })
  labels.value = task.labels.join(', ')
  labels.placeholder = '@label, @another'

  const deadline = h('input', { class: 'tv-input tv-edit-deadline', attrs: { type: 'date' } })
  deadline.value = task.deadline?.date ?? ''

  const error = h('p', { class: 'tv-field-error', attrs: { role: 'alert' } })
  error.hidden = true

  const save = button(m.save, () => void saveEdit(), 'tv-btn tv-btn-primary')
  const cancel = button(
    m.cancel,
    () => {
      editingTaskId = null
      deleteArmed = false
      if (box !== undefined) {
        box.dataset.editing = ''
      }
      renderDetail()
    },
    'tv-btn'
  )
  const remove = button(
    m.delete,
    () => {
      if (!deleteArmed) {
        deleteArmed = true
        remove.textContent = m.confirmDelete
        return
      }
      void removeTask()
    },
    'tv-btn tv-btn-danger'
  )

  const fail = (message: string): void => {
    error.textContent = message
    error.hidden = false
  }

  const saveEdit = async (): Promise<void> => {
    const title = content.value.trim()
    if (title === '') {
      fail(m.titleRequired)
      return
    }
    const input: TaskUpdateInput = {
      id: task.id,
      content: title,
      description: description.value,
      projectId: project.value,
      sectionId: section.value === '' ? null : section.value,
      dueDate: dueDate.value === '' ? null : dueDate.value,
      dueTime: dueTime.value === '' ? null : dueTime.value,
      priority: Number(priority.value) || 1,
      labels: labels.value
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label !== ''),
      deadline: deadline.value === '' ? null : deadline.value
    }
    save.disabled = true
    try {
      const result = await orca.plugin.request('task.update', input)
      if (!result.ok) {
        fail(errorText(result.error))
        save.disabled = false
        return
      }
      current = result.view
      editingTaskId = null
      deleteArmed = false
      if (box !== undefined) {
        box.dataset.editing = ''
      }
      showToast(m.savedToast)
      render()
    } catch (caught) {
      fail(messageOf(caught))
      save.disabled = false
    }
  }

  const removeTask = async (): Promise<void> => {
    remove.disabled = true
    try {
      const result = await orca.plugin.request('task.delete', { id: task.id })
      if (!result.ok) {
        fail(errorText(result.error))
        remove.disabled = false
        deleteArmed = false
        remove.textContent = m.delete
        return
      }
      current = result.view
      selectedTaskId = null
      detailOpen = false
      editingTaskId = null
      deleteArmed = false
      showToast(m.savedToast)
      render()
    } catch (caught) {
      fail(messageOf(caught))
      remove.disabled = false
    }
  }

  root.append(
    formField(m.detailTitle, content),
    formField(m.detailDescription, description),
    h('div', { class: 'tv-edit-row' }, [
      formField(m.detailProject, project),
      formField(m.detailSection, section)
    ]),
    formField(m.detailDue, h('div', { class: 'tv-edit-due' }, [dueDate, dueTime])),
    h('div', { class: 'tv-edit-row' }, [
      formField(m.detailDeadline, deadline),
      formField(m.detailPriority, priority)
    ]),
    formField(m.detailLabels, labels),
    error,
    h('div', { class: 'tv-edit-actions' }, [save, cancel, remove])
  )
  return root
}

/** The task's local time as an `<input type="time">` value. */
function timeValue(task: TodoistTask, tz: string): string {
  const raw = task.due?.datetime ?? null
  if (raw === null) {
    return ''
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) {
    return ''
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(at))
}

function dueDetail(task: TodoistTask, tz: string, todayKey: string): Node | string {
  if (task.due === null) {
    return m.detailNone
  }
  const text = dueText(task, tz, todayKey) ?? m.detailNone
  if (!task.due.isRecurring) {
    return text
  }
  const wrap = h('span', { class: 'tv-detail-inline' })
  wrap.append(h('span', { text }))
  wrap.append(h('span', { class: 'tv-recurring', attrs: { 'aria-hidden': 'true' }, text: ' ↻' }))
  if (task.due.string !== null) {
    wrap.append(h('span', { class: 'tv-muted', text: ` · ${task.due.string}` }))
  }
  return wrap
}

function detailRow(label: string, value: string | Node): HTMLElement {
  return h('div', { class: 'tv-detail-row' }, [
    h('dt', { class: 'tv-detail-label', text: label }),
    typeof value === 'string'
      ? h('dd', { class: 'tv-detail-value', text: value })
      : h('dd', { class: 'tv-detail-value' }, [value])
  ])
}

function renderFooter(): void {
  if (ui === null) {
    return
  }
  const foot = ui.foot
  foot.replaceChildren()
  if (setupOpen()) {
    foot.hidden = true
    return
  }
  foot.hidden = false
  const data = dataOf()
  const count = data?.tasks.length ?? 0
  const items: Node[] = [
    h('span', {
      class: 'tv-foot-item',
      attrs: { 'aria-live': 'polite' },
      text: m.showing(count)
    })
  ]
  if (readOnly()) {
    items.push(h('span', { class: 'tv-foot-item', text: m.readOnlyFile }))
  }
  if (data !== null) {
    items.push(
      h('span', { class: 'tv-foot-item' }, [
        h('span', { text: `${m.updated} ` }),
        h('span', { text: relativeTime(data.snapshot.fetchedAt, Date.now(), locale) })
      ])
    )
  }
  const source = current !== null ? m.sources[current.token.source] : ''
  if (source !== '') {
    items.push(h('span', { class: 'tv-foot-item', text: source }))
  }
  items.push(button(m.openTodoist, () => openExternal(TODOIST_URL), 'tv-link'))
  foot.append(...items)
}

function errorCard(message: string, offerForget: boolean): HTMLElement {
  const actions = h('div', { class: 'tv-actions' })
  actions.append(button(m.retry, () => void load(true), 'tv-btn tv-btn-primary'))
  if (offerForget) {
    actions.append(button(m.forgetToken, () => void forgetToken(), 'tv-btn'))
  }
  return h('section', { class: 'tv-error-card' }, [
    h('h2', { class: 'tv-error-title', text: m.errorTitle }),
    h('p', { class: 'tv-error-body', text: message }),
    actions
  ])
}

function connectCard(compact: boolean): HTMLElement {
  const card = h('section', { class: compact ? 'tv-connect tv-connect-compact' : 'tv-connect' })
  if (!compact) {
    card.append(h('h2', { class: 'tv-setup-title', text: m.setupTitle }))
    const protection = current?.token.protection ?? 'os-keyring'
    card.append(
      h('p', {
        class: 'tv-setup-body',
        text: protection === 'unavailable' ? m.setupBodyNoStore : m.setupBody
      })
    )
  }

  const input = h('input', {
    class: 'tv-token-input',
    attrs: {
      type: 'password',
      placeholder: m.tokenPlaceholder,
      'aria-label': m.tokenLabel,
      autocomplete: 'off',
      spellcheck: 'false'
    }
  })
  input.value = typedToken
  const save = button(
    connecting ? m.loading : m.saveToken,
    () => void connect(),
    'tv-btn tv-btn-primary'
  )
  save.disabled = connecting || typedToken.trim() === ''
  input.addEventListener('input', () => {
    typedToken = input.value
    save.disabled = connecting || typedToken.trim() === ''
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!connecting && typedToken.trim() !== '') {
        void connect()
      }
    }
  })

  card.append(
    h('div', { class: 'tv-field' }, [
      h('label', { class: 'tv-field-label', text: m.tokenLabel }),
      input
    ])
  )
  if (tokenError !== null) {
    card.append(h('p', { class: 'tv-field-error', attrs: { role: 'alert' }, text: tokenError }))
  }
  card.append(h('div', { class: 'tv-actions' }, [save]))
  if (!compact) {
    card.append(button(m.tokenHelp, () => openExternal(TOKEN_HELP_URL), 'tv-link'))
  }
  return card
}

// --- keyboard -------------------------------------------------------------------------------

function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)
  )
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === '/' && !isEditing(event.target)) {
    if (ui !== null) {
      event.preventDefault()
      ui.search.focus()
    }
    return
  }
  if (event.key === 'Escape') {
    if (detailOpen) {
      detailOpen = false
      render()
      return
    }
    if (tokenError !== null) {
      tokenError = null
      render()
    }
  }
}

// --- start ----------------------------------------------------------------------------------

function applyWeekStart(value: unknown): void {
  weekStartsOn = value === 'monday' ? 1 : 0
}

function start(): void {
  const host = document.getElementById('root')
  ui = build()
  if (host !== null) {
    host.replaceChildren(ui.root)
  }
  render()

  document.addEventListener('keydown', onKeyDown)
  orca.plugin.on('todoist.changed', (payload) => {
    current = payload.view
    render()
  })

  void orca.settings
    .get('weekStartsOn')
    .then((value) => {
      applyWeekStart(value)
      render()
    })
    .catch(() => undefined)
  orca.settings.onDidChange((change) => {
    if (change.key === 'weekStartsOn') {
      void orca.settings
        .get('weekStartsOn')
        .then((value) => {
          applyWeekStart(value)
          render()
        })
        .catch(() => undefined)
    }
  })

  window.setInterval(() => {
    void load()
  }, REFRESH_MS)

  void (async () => {
    const api = orca.document
    if (api !== undefined) {
      try {
        doc = await api.session<PageState>({
          decode: (content) =>
            content.kind === 'text' ? parsePageState(content.text) : DEFAULT_STATE,
          encode: (value) => ({ kind: 'text', text: serializePageState(value) }),
          debounceMs: 400
        })
        state = doc.value
        doc.onReplace((value) => {
          state = value
          render()
        })
      } catch {
        doc = null
      }
    }
    render()
    void load()
  })()
}

start()
