// The one surface: a full Todoist view in Orca's right sidebar. It draws list, calendar and
// board views, filters, the task editor and the quick add. Frames have no network, so every
// read and write goes through the worker (src/worker.ts).

import {
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  RelativeTime,
  Row,
  Select,
  Separator,
  settings,
  shell,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  atom,
  env,
  plugin,
  read,
  set,
  update,
  type PanelContext
} from 'orca'
import { priorityName } from './colors'
import { dayLabel, messagesFor, type Messages } from './messages'
import {
  DUE_BUCKETS,
  EMPTY_FILTERS,
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
  type DueBucket,
  type SortKey,
  type ViewFilters
} from './select'
import type {
  TodoistError,
  TodoistErrorCode,
  TodoistProject,
  TodoistSection,
  TodoistSnapshot,
  TodoistTask,
  TodoistView,
  TaskUpdateInput
} from './protocol'

type PanelView = 'list' | 'calendar' | 'board'

/** What a persisted view may hold, checked on the way out of storage. */
function viewOf(value: string): PanelView {
  return value === 'calendar' || value === 'board' ? value : 'list'
}

const words = (): Messages => messagesFor(env.locale)

/** The worker's last answer; null until it gives one. */
const view = atom<TodoistView | null>(null)
/** What went wrong asking the worker, in the host's words. */
const failure = atom<{ title: string | null; message: string; retry: boolean } | null>(null)
/** A short success line, with an Undo for a completion. */
const notice = atom<{ text: string; undo: string | null } | null>(null)
/** The token as it is typed. Never persisted. */
const draft = atom('')
/** A request is running, so its controls wait. */
const busy = atom(false)
/** Tasks whose completion or reopen is in flight. */
const closing = atom<ReadonlySet<string>>(new Set())
/** The task whose editor is open; null shows the views. */
const selected = atom<string | null>(null)
/** The editor's draft, as text fields. */
const form = atom<TaskDraft | null>(null)
/** The editor's own error, such as a malformed date. */
const formError = atom<string | null>(null)
/** A delete has been asked once; the next press deletes. */
const deleteArmed = atom(false)
/** The quick-add text and optional due date. */
const creating = atom('')
const createDate = atom('')
/** A new project's name. */
const newProject = atom('')
/** A project creation is running. */
const projectBusy = atom(false)

/** Filters, view and month survive a panel close. */
const panelView = atom('todoist.view', 'list', { persist: 'plugin' })
function sortOf(value: string): SortKey {
  return (SORT_KEYS as readonly string[]).includes(value) ? (value as SortKey) : 'due'
}
const query = atom('todoist.query', '', { persist: 'plugin' })
const project = atom('todoist.project', 'all', { persist: 'plugin' })
const label = atom('todoist.label', 'all', { persist: 'plugin' })
const priority = atom('todoist.priority', 'all', { persist: 'plugin' })
const bucket = atom('todoist.bucket', 'all', { persist: 'plugin' })
const hideSubtasks = atom('todoist.hideSubtasks', false, { persist: 'plugin' })
const sort = atom('todoist.sort', 'due', { persist: 'plugin' })
const month = atom('todoist.month', '', { persist: 'plugin' })
const day = atom('todoist.day', '', { persist: 'plugin' })
/** The first day of the calendar week, read from Orca's settings. */
const weekStarts = atom<0 | 1>(1)

type TaskDraft = {
  content: string
  description: string
  projectId: string
  sectionId: string
  dueDate: string
  dueTime: string
  priority: number
  labels: string
  deadline: string
}

function describe(error: unknown): string {
  const { message, code } = error as { message?: string; code?: string }
  return message || code || String(error)
}

function errorText(error: TodoistError, m: Messages): string {
  const text = m.errors[error.code](error)
  return error.detail === null || error.detail === '' ? text : `${text} ${error.detail}`
}

function snapshotOf(current: TodoistView | null): TodoistSnapshot | null {
  const state = current?.state
  return state?.status === 'ready' ? state.snapshot : state?.status === 'error' ? state.snapshot : null
}

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

function draftOf(task: TodoistTask, tz: string): TaskDraft {
  return {
    content: task.content,
    description: task.description,
    projectId: task.projectId,
    sectionId: task.sectionId ?? '',
    dueDate: dueDayKey(task.due, tz) ?? '',
    dueTime: timeValue(task, tz),
    priority: task.priority,
    labels: task.labels.join(', '),
    deadline: task.deadline?.date ?? ''
  }
}

function patchForm(patch: Partial<TaskDraft>): void {
  update(form, (current) => (current === null ? null : { ...current, ...patch }))
}

const loadFailure = (): { title: string | null; message: string; retry: boolean } => ({
  title: words().errorTitle,
  message: '',
  retry: true
})

const load = (): Promise<void> => ask(loadFailure(), () => plugin.request('todoist.get'))
const refresh = (): Promise<void> => ask(loadFailure(), () => plugin.request('todoist.refresh'))

async function ask(
  refusal: { title: string | null; message: string; retry: boolean },
  request: () => Promise<TodoistView>
): Promise<void> {
  set(busy, true)
  try {
    set(view, await request())
    set(failure, null)
  } catch (error) {
    set(failure, { ...refusal, message: describe(error) })
  } finally {
    set(busy, false)
  }
}

async function saveToken(): Promise<void> {
  const value = read(draft).trim()
  if (value === '' || read(busy)) {
    return
  }
  set(busy, true)
  try {
    set(view, await plugin.request('token.set', { value }))
    set(failure, null)
    set(draft, '')
  } catch (error) {
    set(failure, { title: words().saveToken, message: describe(error), retry: false })
  } finally {
    set(busy, false)
  }
}

async function forget(): Promise<void> {
  set(busy, true)
  try {
    set(view, await plugin.request('token.forget'))
    set(failure, null)
    set(selected, null)
    set(form, null)
  } catch (error) {
    set(failure, { title: null, message: describe(error), retry: false })
  } finally {
    set(busy, false)
  }
}

function showNotice(text: string, undo: string | null = null): void {
  set(notice, { text, undo })
}

async function addTask(): Promise<void> {
  const content = read(creating).trim()
  if (content === '' || read(busy)) {
    return
  }
  const snapshot = snapshotOf(read(view))
  const inbox = snapshot?.projects.find((item) => item.isInboxProject) ?? null
  const target = read(project) === 'all' ? inbox?.id ?? null : read(project)
  set(busy, true)
  try {
    const dueDate = read(createDate).trim()
    const result = await plugin.request('task.create', {
      content,
      projectId: target,
      dueDate: dueDate === '' ? null : dueDate
    })
    set(view, result.view)
    if (!result.ok) {
      set(failure, { title: words().writeFailed, message: errorText(result.error, words()), retry: false })
      return
    }
    set(failure, null)
    set(creating, '')
    set(createDate, '')
    showNotice(words().savedToast)
  } catch (error) {
    set(failure, { title: words().writeFailed, message: describe(error), retry: false })
  } finally {
    set(busy, false)
  }
}

async function completeTask(task: TodoistTask): Promise<void> {
  if (read(closing).has(task.id) || read(busy)) {
    return
  }
  set(closing, new Set(read(closing)).add(task.id))
  try {
    const result = await plugin.request('task.close', { id: task.id })
    set(view, result.view)
    if (!result.ok) {
      set(failure, { title: words().writeFailed, message: errorText(result.error, words()), retry: false })
      return
    }
    set(failure, null)
    if (read(selected) === task.id) {
      set(selected, null)
      set(form, null)
    }
    showNotice(words().completedToast(task.content), task.id)
  } catch (error) {
    set(failure, { title: words().writeFailed, message: describe(error), retry: false })
  } finally {
    const next = new Set(read(closing))
    next.delete(task.id)
    set(closing, next)
  }
}

async function reopenTask(id: string): Promise<void> {
  set(busy, true)
  try {
    const result = await plugin.request('task.reopen', { id })
    set(view, result.view)
    if (!result.ok) {
      set(failure, { title: words().writeFailed, message: errorText(result.error, words()), retry: false })
      return
    }
    set(notice, null)
    showNotice(words().savedToast)
  } catch (error) {
    set(failure, { title: words().writeFailed, message: describe(error), retry: false })
  } finally {
    set(busy, false)
  }
}

function selectTask(task: TodoistTask, tz: string): void {
  set(selected, task.id)
  set(form, draftOf(task, tz))
  set(formError, null)
  set(deleteArmed, false)
  set(notice, null)
}

function openTask(url: string): void {
  void shell.openExternal(url).catch((error: unknown) => {
    set(failure, { title: null, message: describe(error), retry: false })
  })
}

async function saveTask(task: TodoistTask, m: Messages): Promise<void> {
  const current = read(form)
  if (current === null) {
    return
  }
  const content = current.content.trim()
  const date = current.dueDate.trim()
  const time = current.dueTime.trim()
  if (content === '') {
    set(formError, m.titleRequired)
    return
  }
  if (date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    set(formError, m.invalidDate)
    return
  }
  if (time !== '' && !/^\d{2}:\d{2}$/.test(time)) {
    set(formError, m.invalidTime)
    return
  }
  if (time !== '' && date === '') {
    set(formError, m.invalidDate)
    return
  }
  const input: TaskUpdateInput = {
    id: task.id,
    content,
    description: current.description,
    projectId: current.projectId,
    sectionId: current.sectionId === '' ? null : current.sectionId,
    dueDate: date === '' ? null : date,
    dueTime: time === '' ? null : time,
    priority: current.priority,
    labels: current.labels
      .split(',')
      .map((labelText) => labelText.trim())
      .filter((labelText) => labelText !== ''),
    deadline: current.deadline === '' ? null : current.deadline
  }
  set(busy, true)
  set(formError, null)
  try {
    const result = await plugin.request('task.update', input)
    set(view, result.view)
    if (!result.ok) {
      set(formError, errorText(result.error, m))
      return
    }
    patchForm({ content, dueDate: date, dueTime: time })
    showNotice(m.savedToast)
  } catch (error) {
    set(formError, describe(error))
  } finally {
    set(busy, false)
  }
}

async function deleteTask(task: TodoistTask, m: Messages): Promise<void> {
  if (!read(deleteArmed)) {
    set(deleteArmed, true)
    return
  }
  set(busy, true)
  set(formError, null)
  try {
    const result = await plugin.request('task.delete', { id: task.id })
    set(view, result.view)
    if (!result.ok) {
      set(formError, errorText(result.error, m))
      set(deleteArmed, false)
      return
    }
    set(selected, null)
    set(form, null)
    set(deleteArmed, false)
    showNotice(m.savedToast)
  } catch (error) {
    set(formError, describe(error))
    set(deleteArmed, false)
  } finally {
    set(busy, false)
  }
}

async function createProject(): Promise<void> {
  const name = read(newProject).trim()
  if (name === '' || read(projectBusy)) {
    return
  }
  set(projectBusy, true)
  try {
    const result = await plugin.request('project.create', { name })
    set(view, result.view)
    if (!result.ok) {
      set(failure, { title: words().writeFailed, message: errorText(result.error, words()), retry: false })
      return
    }
    set(newProject, '')
    showNotice(words().savedToast)
  } catch (error) {
    set(failure, { title: words().writeFailed, message: describe(error), retry: false })
  } finally {
    set(projectBusy, false)
  }
}

// --- setup and shared parts -----------------------------------------------------------------

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('todoist.changed', ({ view: next }) => set(view, next)))
  ctx.subscriptions.push(
    settings.onDidChange((change) => {
      if (change.key === 'weekStartsOn') {
        void settings.get('weekStartsOn').then((value) => set(weekStarts, value === 'sunday' ? 0 : 1))
      }
    })
  )
  void settings
    .get('weekStartsOn')
    .then((value) => set(weekStarts, value === 'sunday' ? 0 : 1))
    .catch(() => undefined)
  void load()
  const timer = setInterval(() => {
    if (read(ctx.visible)) {
      void load()
    }
  }, 60_000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export default function Panel() {
  const m = words()
  const current = read(view)
  const token = current?.token ?? null
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>{m.title}</Heading>
        {token !== null && token.source !== 'none' ? (
          <IconButton
            icon="refresh"
            label={m.refresh}
            tooltip={m.refresh}
            disabled={read(busy)}
            onPress={() => void refresh()}
          />
        ) : null}
      </Row>
      {read(failure) === null ? null : <Problem failure={read(failure)!} m={m} />}
      {read(notice) === null ? null : <Notice m={m} />}
      {current === null ? (
        <Spinner label={m.loading} />
      ) : token !== null && token.source === 'none' ? (
        <Setup current={current} m={m} />
      ) : (
        <Body current={current} m={m} />
      )}
    </Stack>
  )
}

function Problem({
  failure,
  m
}: {
  failure: { title: string | null; message: string; retry: boolean }
  m: Messages
}) {
  return (
    <Callout tone="danger" title={failure.title ?? undefined}>
      <Stack gap="xs">
        <Text size="xs">{failure.message}</Text>
        {failure.retry ? (
          <Button variant="outline" size="xs" icon="refresh" onPress={() => void load()}>
            {m.retry}
          </Button>
        ) : null}
      </Stack>
    </Callout>
  )
}

function Notice({ m }: { m: Messages }) {
  const current = read(notice)
  if (current === null) {
    return null
  }
  return (
    <Callout tone="success" title={current.text}>
      <Row gap="xs" align="center">
        {current.undo === null ? null : (
          <Button variant="outline" size="xs" onPress={() => void reopenTask(current.undo!)}>
            {m.undo}
          </Button>
        )}
        <IconButton icon="close" label={m.close} size="xs" onPress={() => set(notice, null)} />
      </Row>
    </Callout>
  )
}

function Setup({ current, m }: { current: TodoistView; m: Messages }) {
  const waiting = read(busy)
  return (
    <Stack gap="sm">
      <Stack gap="xs">
        <Text weight="semibold">{m.setupTitle}</Text>
        <Text size="sm" muted>
          {current.token.protection === 'unavailable' ? m.setupBodyNoStore : m.setupBody}
        </Text>
      </Stack>
      <Input
        label={m.tokenLabel}
        type="password"
        placeholder={m.tokenPlaceholder}
        value={read(draft)}
        disabled={waiting}
        onChange={(value) => set(draft, value)}
        onSubmit={() => void saveToken()}
      />
      <Row gap="sm" align="center">
        <Button
          icon="check"
          disabled={read(draft).trim() === '' || waiting}
          onPress={() => void saveToken()}
        >
          {m.saveToken}
        </Button>
        <Link onPress={() => openTask('https://app.todoist.com/app/settings/integrations')}>
          {m.tokenHelp}
        </Link>
      </Row>
    </Stack>
  )
}

function Body({ current, m }: { current: TodoistView; m: Messages }) {
  const selectedId = read(selected)
  const snapshot = snapshotOf(current)
  if (snapshot === null) {
    return current.state.status === 'error' ? (
      <Callout tone="danger" title={m.errorTitle}>
        <Stack gap="xs">
          <Text size="xs">{m.errors[current.state.error.code](current.state.error)}</Text>
          <Button variant="outline" size="xs" icon="refresh" onPress={() => void load()}>
            {m.retry}
          </Button>
        </Stack>
      </Callout>
    ) : (
      <Spinner label={m.loading} />
    )
  }
  const timeZone = snapshot.user?.timezone ?? 'UTC'
  const todayKey = dayKeyOf(new Date(), timeZone)
  const task = selectedId === null ? null : snapshot.tasks.find((item) => item.id === selectedId) ?? null
  if (task !== null) {
    return <TaskEditor task={task} snapshot={snapshot} timeZone={timeZone} m={m} />
  }
  return (
    <Stack gap="sm">
      {current.state.status === 'error' ? (
        <Callout tone="warning" title={m.staleTitle}>
          <Text size="xs">{m.errors[current.state.error.code](current.state.error)}</Text>
        </Callout>
      ) : null}
      <Row gap="xs" align="center">
        <Box grow>
          <Input
            label={m.addTask}
            labelHidden
            placeholder={m.addTaskPlaceholder}
            value={read(creating)}
            disabled={read(busy)}
            onChange={(value) => set(creating, value)}
            onSubmit={() => void addTask()}
          />
        </Box>
        <Box width={104}>
          <Input
            label={m.detailDue}
            labelHidden
            placeholder="YYYY-MM-DD"
            maxLength={10}
            value={read(createDate)}
            disabled={read(busy)}
            onChange={(value) => set(createDate, value)}
            onSubmit={() => void addTask()}
          />
        </Box>
        <IconButton
          icon="add"
          label={m.createTask}
          tooltip={m.createTask}
          disabled={read(busy) || read(creating).trim() === ''}
          onPress={() => void addTask()}
        />
      </Row>
      <Stats snapshot={snapshot} todayKey={todayKey} timeZone={timeZone} m={m} />
      <Input
        label={m.search}
        labelHidden
        type="search"
        placeholder={m.searchPlaceholder}
        value={read(query)}
        onChange={(value) => set(query, value)}
      />
      <Tabs label={m.title} value={viewOf(read(panelView))} onChange={(value) => set(panelView, viewOf(value))}>
        <Tab value="list" label={m.views.list} />
        <Tab value="calendar" label={m.views.calendar} />
        <Tab value="board" label={m.views.board} />
      </Tabs>
      <Filters snapshot={snapshot} m={m} />
      <ViewBody snapshot={snapshot} todayKey={todayKey} timeZone={timeZone} m={m} />
      <Footer current={current} snapshot={snapshot} m={m} />
    </Stack>
  )
}

function Stats({
  snapshot,
  todayKey,
  timeZone,
  m
}: {
  snapshot: TodoistSnapshot
  todayKey: string
  timeZone: string
  m: Messages
}) {
  const stats = statsOf(snapshot.tasks, todayKey, timeZone)
  return (
    <Row gap="xs" wrap>
      {stats.overdue > 0 ? <Badge tone="danger">{`${m.stats.overdue} ${stats.overdue}`}</Badge> : null}
      {stats.today > 0 ? <Badge tone="accent">{`${m.stats.today} ${stats.today}`}</Badge> : null}
      {stats.week > 0 ? <Badge tone="neutral">{`${m.stats.week} ${stats.week}`}</Badge> : null}
    </Row>
  )
}

function Filters({ snapshot, m }: { snapshot: TodoistSnapshot; m: Messages }) {
  const projects = [...snapshot.projects].sort((left, right) => left.order - right.order)
  const labels = [...new Set(snapshot.tasks.flatMap((task) => task.labels))].sort((left, right) =>
    left.localeCompare(right)
  )
  const active =
    read(query) !== '' ||
    read(project) !== 'all' ||
    read(label) !== 'all' ||
    read(priority) !== 'all' ||
    read(bucket) !== 'all' ||
    read(hideSubtasks)
  const clear = (): void => {
    set(query, '')
    set(project, 'all')
    set(label, 'all')
    set(priority, 'all')
    set(bucket, 'all')
    set(hideSubtasks, false)
  }
  return (
    <Collapsible title={m.filters} description={active ? m.activeFilters : undefined} defaultOpen={false}>
      <Stack gap="xs">
        <Select
          label={m.projects}
          value={read(project)}
          options={[
            { value: 'all', label: m.allProjects },
            ...projects.map((item) => ({ value: item.id, label: item.name }))
          ]}
          onChange={(value) => set(project, value)}
        />
        <Select
          label={m.labels}
          value={read(label)}
          options={[
            { value: 'all', label: m.allLabels },
            ...labels.map((item) => ({ value: item, label: `@${item}` }))
          ]}
          onChange={(value) => set(label, value)}
        />
        <Select
          label={m.priorities}
          value={read(priority)}
          options={[
            { value: 'all', label: m.allPriorities },
            ...[4, 3, 2, 1].map((value) => ({ value: String(value), label: priorityName(value) }))
          ]}
          onChange={(value) => set(priority, value)}
        />
        <Select
          label={m.dateBuckets}
          value={read(bucket)}
          options={[
            { value: 'all', label: m.allDates },
            ...DUE_BUCKETS.map((value) => ({ value, label: m.buckets[value] }))
          ]}
          onChange={(value) => set(bucket, value)}
        />
        <Select
          label={m.sortLabel}
          value={sortOf(read(sort))}
          options={SORT_KEYS.map((value) => ({ value, label: m.sort[value] }))}
          onChange={(value) => set(sort, sortOf(value))}
        />
        <Checkbox
          label={m.hideSubtasks}
          checked={read(hideSubtasks)}
          onChange={(checked) => set(hideSubtasks, checked)}
        />
        {active ? (
          <Button variant="outline" size="xs" onPress={clear}>
            {m.clearFilters}
          </Button>
        ) : null}
        <Separator />
        <Text size="xs" weight="semibold">
          {m.newProject}
        </Text>
        <Row gap="xs" align="center">
          <Box grow>
            <Input
              label={m.projectName}
              labelHidden
              placeholder={m.projectName}
              value={read(newProject)}
              disabled={read(projectBusy)}
              onChange={(value) => set(newProject, value)}
              onSubmit={() => void createProject()}
            />
          </Box>
          <Button
            size="xs"
            icon="add"
            disabled={read(projectBusy) || read(newProject).trim() === ''}
            onPress={() => void createProject()}
          >
            {m.createProject}
          </Button>
        </Row>
      </Stack>
    </Collapsible>
  )
}

function filtersOf(): ViewFilters {
  return {
    ...EMPTY_FILTERS,
    query: read(query),
    projectIds: read(project) === 'all' ? [] : [read(project)],
    labelNames: read(label) === 'all' ? [] : [read(label)],
    priorities: read(priority) === 'all' ? [] : [Number(read(priority))],
    buckets: read(bucket) === 'all' ? [] : [read(bucket) as DueBucket],
    hideSubtasks: read(hideSubtasks)
  }
}

type ViewData = {
  snapshot: TodoistSnapshot
  todayKey: string
  timeZone: string
  filters: ViewFilters
  tasks: TodoistTask[]
  projects: ReadonlyMap<string, TodoistProject>
  sections: ReadonlyMap<string, TodoistSection>
  counts: Map<string, number>
}

function dataOf(snapshot: TodoistSnapshot, todayKey: string, timeZone: string): ViewData {
  const filters = filtersOf()
  const context = contextOf(snapshot)
  return {
    snapshot,
    todayKey,
    timeZone,
    filters,
    tasks: filterTasks(snapshot, filters, todayKey, timeZone),
    projects: context.projects,
    sections: context.sections,
    counts: subtaskCounts(snapshot.tasks)
  }
}

function ViewBody({
  snapshot,
  todayKey,
  timeZone,
  m
}: {
  snapshot: TodoistSnapshot
  todayKey: string
  timeZone: string
  m: Messages
}) {
  const data = dataOf(snapshot, todayKey, timeZone)
  if (snapshot.tasks.length === 0) {
    return <EmptyState icon="check" title={m.noTasks} description={m.noTasksBody} />
  }
  if (data.tasks.length === 0) {
    return <EmptyState icon="search" title={m.noMatch} description={m.noMatchBody} />
  }
  const active = viewOf(read(panelView))
  if (active === 'calendar') {
    return <CalendarView data={data} m={m} />
  }
  if (active === 'board') {
    return <BoardView data={data} m={m} />
  }
  return <ListView data={data} m={m} />
}

function ListView({ data, m }: { data: ViewData; m: Messages }) {
  const sorted = sortTasks(data.tasks, sortOf(read(sort)), data.timeZone, data.projects)
  if (sorted.length === 0) {
    return <EmptyState icon="search" title={m.noMatch} description={m.noMatchBody} />
  }
  const grouped = sortOf(read(sort)) === 'due' && read(bucket) === 'all'
  if (!grouped) {
    return (
      <Stack gap="xs">
        {sorted.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            data={data}
            m={m}
            disabled={read(closing).has(task.id) || read(busy)}
            onSelect={() => selectTask(task, data.timeZone)}
            onComplete={() => void completeTask(task)}
          />
        ))}
      </Stack>
    )
  }
  return (
    <Stack gap="xs">
      {groupByBucket(sorted, data.todayKey, data.timeZone, sortOf(read(sort)), data.projects).map((group) => (
        <Collapsible
          key={group.bucket}
          title={m.buckets[group.bucket]}
          description={String(group.tasks.length)}
          defaultOpen
        >
          <Stack gap="xs">
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                data={data}
                m={m}
                disabled={read(closing).has(task.id) || read(busy)}
                onSelect={() => selectTask(task, data.timeZone)}
                onComplete={() => void completeTask(task)}
              />
            ))}
          </Stack>
        </Collapsible>
      ))}
    </Stack>
  )
}

function TaskRow({
  task,
  data,
  m,
  disabled,
  onSelect,
  onComplete
}: {
  task: TodoistTask
  data: ViewData
  m: Messages
  disabled: boolean
  onSelect: () => void
  onComplete: () => void
}) {
  const project = data.projects.get(task.projectId)
  const dayKey = dueDayKey(task.due, data.timeZone)
  const due =
    dayKey === null
      ? task.due?.string ?? null
      : dayLabel(m, dayKey, data.todayKey, env.locale, (key, locale) => formatDay(key, locale))
  const time = dayKey === null ? null : formatTime(task.due?.datetime ?? null, env.locale, data.timeZone)
  const meta = [project?.name ?? null, due, time, ...task.labels.map((item) => `@${item}`)]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ')
  const subtasks = data.counts.get(task.id) ?? 0
  return (
    <Row gap="xs" align="center">
      <IconButton
        icon="check"
        label={m.complete}
        tooltip={m.complete}
        size="xs"
        disabled={disabled}
        onPress={onComplete}
      />
      <Box grow>
        <Stack gap="none" align="stretch">
          <Button variant="ghost" size="sm" onPress={onSelect}>
            {task.content}
          </Button>
          <Text size="xs" muted truncate>
            {meta}
          </Text>
        </Stack>
      </Box>
      <Badge tone={priorityTone(task.priority)}>{priorityName(task.priority)}</Badge>
      {subtasks > 0 ? <Badge tone="neutral">{String(subtasks)}</Badge> : null}
    </Row>
  )
}

function priorityTone(value: number): 'danger' | 'warning' | 'accent' | 'neutral' {
  return value >= 4 ? 'danger' : value === 3 ? 'warning' : value === 2 ? 'accent' : 'neutral'
}

function CalendarView({ data, m }: { data: ViewData; m: Messages }) {
  const first = monthOf(data.todayKey)
  const persisted = read(month)
  const active = /^\d{4}-(0[1-9]|1[0-2])$/.test(persisted) ? persisted : first
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(read(day)) ? read(day) : data.todayKey
  const byDay = tasksByDay(sortTasks(data.tasks, sortOf(read(sort)), data.timeZone, data.projects), data.timeZone)
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Button
            size="xs"
            variant="ghost"
            tooltip={m.previousMonth}
            onPress={() => set(month, addMonths(active, -1))}
          >
            ‹
          </Button>
          <Text weight="semibold">{monthLabel(active, env.locale)}</Text>
          <Button
            size="xs"
            variant="ghost"
            tooltip={m.nextMonth}
            onPress={() => set(month, addMonths(active, 1))}
          >
            ›
          </Button>
        </Row>
        <Button
          size="xs"
          variant="outline"
          onPress={() => {
            set(month, first)
            set(day, data.todayKey)
          }}
        >
          {m.calendarToday}
        </Button>
      </Row>
      <Weekdays />
      <Stack gap="xs">
        {calendarGrid(active, weekStartsOf(), data.todayKey).map((week, index) => (
          <Row gap="xs" key={`${active}-${index}`}>
            {week.map((cell) => (
              <Box grow key={cell.key}>
                <Stack gap="none" align="center">
                  <Button
                    variant={cell.today ? 'outline' : 'ghost'}
                    size="xs"
                    onPress={() => set(day, cell.key)}
                  >
                    {String(cell.day)}
                  </Button>
                  <Text size="xs" muted={!cell.inMonth}>
                    {(byDay.get(cell.key) ?? []).length > 0
                      ? String((byDay.get(cell.key) ?? []).length)
                      : ' '}
                  </Text>
                </Stack>
              </Box>
            ))}
          </Row>
        ))}
      </Stack>
      <Separator />
      <Text size="xs" weight="semibold">
        {dayLabel(m, selectedDay, data.todayKey, env.locale, (key, locale) =>
          formatDay(key, locale, { weekday: true })
        )}
      </Text>
      {(byDay.get(selectedDay) ?? []).length === 0 ? (
        <Text size="xs" muted>
          {m.noTasks}
        </Text>
      ) : (
        <Stack gap="xs">
          {(byDay.get(selectedDay) ?? []).map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              data={data}
              m={m}
              disabled={read(closing).has(task.id) || read(busy)}
              onSelect={() => selectTask(task, data.timeZone)}
              onComplete={() => void completeTask(task)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function Weekdays() {
  const names = weekdayNames(env.locale, weekStartsOf())
  return (
    <Row gap="xs">
      {names.map((name) => (
        <Box grow key={name}>
          <Text size="xs" muted>
            {name}
          </Text>
        </Box>
      ))}
    </Row>
  )
}

function weekStartsOf(): 0 | 1 {
  return read(weekStarts)
}

function weekdayNames(locale: string, startsOn: 0 | 1): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
  const names: string[] = []
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(Date.UTC(2024, 0, 7 + ((offset + startsOn) % 7), 12))
    names.push(format.format(date))
  }
  return names
}

function monthLabel(monthKey: string, locale: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, (month ?? 1) - 1, 1, 12))
  )
}

function BoardView({ data, m }: { data: ViewData; m: Messages }) {
  const columns = projectColumns(data.tasks, data.snapshot.projects, sortOf(read(sort)), data.timeZone)
  if (columns.length === 0) {
    return <EmptyState icon="search" title={m.noMatch} description={m.noMatchBody} />
  }
  return (
    <Stack gap="xs">
      {columns.map((column) => (
        <Collapsible
          key={column.project.id}
          title={column.project.name}
          description={String(column.tasks.length)}
          defaultOpen
        >
          <Stack gap="xs">
            {column.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                data={data}
                m={m}
                disabled={read(closing).has(task.id) || read(busy)}
                onSelect={() => selectTask(task, data.timeZone)}
                onComplete={() => void completeTask(task)}
              />
            ))}
          </Stack>
        </Collapsible>
      ))}
    </Stack>
  )
}

function Footer({
  current,
  snapshot,
  m
}: {
  current: TodoistView
  snapshot: TodoistSnapshot
  m: Messages
}) {
  const source = current.token.source
  return (
    <Stack gap="xs">
      <Separator />
      <Row justify="between" align="center" gap="xs" wrap>
        <Text size="xs" muted>
          {m.updated} <RelativeTime at={snapshot.fetchedAt} format="short" />
        </Text>
        <Link onPress={() => openTask('https://app.todoist.com/app/today')}>{m.openTodoist}</Link>
      </Row>
      <Row justify="between" align="center" gap="xs" wrap>
        <Text size="xs" muted>
          {m.sources[source]}
        </Text>
        {source === 'secret' || source === 'setting' ? (
          <Button variant="ghost" size="xs" disabled={read(busy)} onPress={() => void forget()}>
            {m.forgetToken}
          </Button>
        ) : null}
      </Row>
    </Stack>
  )
}

function TaskEditor({
  task,
  snapshot,
  timeZone,
  m
}: {
  task: TodoistTask
  snapshot: TodoistSnapshot
  timeZone: string
  m: Messages
}) {
  const current = read(form)
  if (current === null) {
    return null
  }
  const projects = [...snapshot.projects].sort((left, right) => left.order - right.order)
  const sections = [...snapshot.sections]
    .filter((item) => item.projectId === current.projectId)
    .sort((left, right) => left.order - right.order)
  const disabled = read(busy)
  const formErrorText = read(formError)
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Button
          variant="ghost"
          size="xs"
          onPress={() => {
            set(selected, null)
            set(form, null)
            set(formError, null)
            set(deleteArmed, false)
          }}
        >
          {m.back}
        </Button>
        <IconButton
          icon="close"
          label={m.close}
          size="xs"
          onPress={() => {
            set(selected, null)
            set(form, null)
            set(formError, null)
            set(deleteArmed, false)
          }}
        />
      </Row>
      <Input
        label={m.detailTitle}
        value={current.content}
        disabled={disabled}
        onChange={(value) => patchForm({ content: value })}
      />
      <Textarea
        label={m.detailDescription}
        rows={4}
        value={current.description}
        disabled={disabled}
        onChange={(value) => patchForm({ description: value })}
      />
      <Select
        label={m.detailProject}
        value={current.projectId}
        options={projects.map((item) => ({ value: item.id, label: item.name }))}
        disabled={disabled}
        onChange={(value) => {
          patchForm({ projectId: value, sectionId: '' })
        }}
      />
      <Select
        label={m.detailSection}
        value={current.sectionId === '' ? 'none' : current.sectionId}
        options={[
          { value: 'none', label: m.detailNone },
          ...sections.map((item) => ({ value: item.id, label: item.name }))
        ]}
        disabled={disabled}
        onChange={(value) => patchForm({ sectionId: value === 'none' ? '' : value })}
      />
      <Row gap="xs" align="center">
        <Box grow>
          <Input
            label={m.detailDue}
            placeholder="YYYY-MM-DD"
            maxLength={10}
            value={current.dueDate}
            disabled={disabled}
            onChange={(value) => patchForm({ dueDate: value })}
          />
        </Box>
        <Box grow>
          <Input
            label={m.detailTime}
            placeholder="HH:mm"
            maxLength={5}
            value={current.dueTime}
            disabled={disabled}
            onChange={(value) => patchForm({ dueTime: value })}
          />
        </Box>
      </Row>
      <Select
        label={m.detailPriority}
        value={String(current.priority)}
        options={[4, 3, 2, 1].map((value) => ({ value: String(value), label: priorityName(value) }))}
        disabled={disabled}
        onChange={(value) => patchForm({ priority: Number(value) || 1 })}
      />
      <Input
        label={m.detailLabels}
        placeholder="@label, @another"
        value={current.labels}
        disabled={disabled}
        onChange={(value) => patchForm({ labels: value })}
      />
      <Input
        label={m.detailDeadline}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        value={current.deadline}
        disabled={disabled}
        onChange={(value) => patchForm({ deadline: value })}
      />
      {formErrorText === null ? null : (
        <Callout tone="danger">
          <Text size="xs">{formErrorText}</Text>
        </Callout>
      )}
      <Row gap="xs" wrap>
        <Button
          icon="check"
          disabled={disabled}
          onPress={() => void saveTask(task, m)}
        >
          {m.save}
        </Button>
        <Button
          variant="outline"
          disabled={disabled}
          onPress={() => {
            set(selected, null)
            set(form, null)
            set(formError, null)
            set(deleteArmed, false)
          }}
        >
          {m.cancel}
        </Button>
        <Button
          variant="outline"
          tone="danger"
          disabled={disabled}
          onPress={() => void deleteTask(task, m)}
        >
          {read(deleteArmed) ? m.confirmDelete : m.delete}
        </Button>
      </Row>
      <Row gap="xs" wrap>
        <Button
          variant="outline"
          size="xs"
          disabled={disabled}
          onPress={() => void completeTask(task)}
        >
          {m.complete}
        </Button>
        <Link onPress={() => openTask(task.url)}>{m.openTodoist}</Link>
      </Row>
    </Stack>
  )
}
