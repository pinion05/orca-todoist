// The right-sidebar panel: a compact, read-only view of what the worker read from Todoist. A
// panel has no network, so everything here comes from `todoist.get` and the worker's posts.
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  RelativeTime,
  Row,
  shell,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  atom,
  env,
  plugin,
  read,
  set,
  type PanelContext
} from 'orca'
import { priorityName } from './colors'
import { dayLabel, messagesFor, type Messages } from './messages'
import {
  EMPTY_FILTERS,
  contextOf,
  dayKeyOf,
  dueDayKey,
  filterTasks,
  formatDay,
  formatTime,
  groupByBucket,
  sortTasks,
  statsOf,
  subtaskCounts
} from './select'
import type {
  TokenStatus,
  TodoistError,
  TodoistProject,
  TodoistSnapshot,
  TodoistTask,
  TodoistView
} from './protocol'

/** The worker's last answer; null until it gives one. */
const view = atom<TodoistView | null>(null)
/** What went wrong asking the worker or opening a link, in the host's words. */
const failure = atom<{ title: string | null; message: string; retry: boolean } | null>(null)
/** The token as it is typed. Never persisted. */
const draft = atom('')
/** A request is running, so the controls wait for it. */
const busy = atom(false)
/** Which slice of the list the tabs show. */
const filter = atom<'all' | 'today' | 'overdue' | 'week'>('today')

/** The most task rows the panel draws; the count below says how many matched in all. */
const MAX_ROWS = 12

/** Where the token is pasted into Todoist. */
const TOKEN_HELP_URL = 'https://app.todoist.com/app/settings/integrations'

const words = (): Messages => messagesFor(env.locale)

type Refusal = { title: string | null; retry: boolean }
type Failure = { title: string | null; message: string; retry: boolean }

/** Asks the worker and draws its answer. A refusal is shown and the last answer stays. */
async function ask(refusal: Refusal, request: () => Promise<TodoistView>): Promise<boolean> {
  set(busy, true)
  try {
    set(view, await request())
    set(failure, null)
    return true
  } catch (error) {
    set(failure, { ...refusal, message: describe(error) })
    return false
  } finally {
    set(busy, false)
  }
}

const loadFailure = (): Refusal => ({ title: words().errorTitle, retry: true })

const load = (): Promise<boolean> => ask(loadFailure(), () => plugin.request('todoist.get'))
const refresh = (): Promise<boolean> =>
  ask(loadFailure(), () => plugin.request('todoist.refresh'))
const forget = (): Promise<boolean> => ask({ title: null, retry: false }, () =>
  plugin.request('token.forget')
)

async function saveToken(): Promise<void> {
  const value = read(draft).trim()
  if (value === '' || read(busy)) {
    return
  }
  const saved = await ask({ title: words().saveToken, retry: false }, () =>
    plugin.request('token.set', { value })
  )
  if (saved) {
    set(draft, '')
  }
}

async function openTask(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (error) {
    set(failure, { title: null, message: describe(error), retry: false })
  }
}

async function openTokenHelp(): Promise<void> {
  try {
    await shell.openExternal(TOKEN_HELP_URL)
  } catch (error) {
    set(failure, { title: null, message: describe(error), retry: false })
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('todoist.changed', ({ view: next }) => set(view, next)))
  void load()
  const timer = setInterval(() => {
    // A hidden panel does not spend a request; it reads again when it is looked at.
    if (read(ctx.visible)) {
      void load()
    }
  }, 60_000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export default function Panel() {
  const m = words()
  const current = read(view)
  const problem = read(failure)
  const token = current?.token ?? null
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="sm" align="center">
          <Heading>{m.title}</Heading>
          <Badge tone="neutral">{m.readOnly}</Badge>
        </Row>
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
      {current === null ? (
        problem === null ? (
          <Spinner label={m.loading} />
        ) : (
          <Problem failure={problem} m={m} />
        )
      ) : token !== null && token.source === 'none' ? (
        <Setup current={current} m={m} problem={problem} />
      ) : (
        <Stack gap="sm">
          {problem === null ? null : <Problem failure={problem} m={m} />}
          <Content current={current} m={m} />
        </Stack>
      )}
    </Stack>
  )
}

/** The token form, with any refusal drawn under it. */
function Setup({
  current,
  m,
  problem
}: {
  current: TodoistView
  m: Messages
  problem: Failure | null
}) {
  const waiting = read(busy)
  const state = current.state
  return (
    <Card>
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
          <Link onPress={() => void openTokenHelp()}>{m.tokenHelp}</Link>
        </Row>
        {state.status === 'error' ? <ReadProblem error={state.error} m={m} /> : null}
        {problem === null ? null : <Problem failure={problem} m={m} />}
      </Stack>
    </Card>
  )
}

/** The snapshot states: loading, a first-read failure, and a snapshot with its footer. */
function Content({ current, m }: { current: TodoistView; m: Messages }) {
  const state = current.state
  if (state.status === 'idle' || state.status === 'loading') {
    return <Spinner label={m.loading} />
  }
  if (state.status === 'ready') {
    return (
      <Stack gap="sm">
        <SnapshotBody snapshot={state.snapshot} token={current.token} m={m} />
      </Stack>
    )
  }
  if (state.snapshot === null) {
    return <ReadProblem error={state.error} m={m} />
  }
  return (
    <Stack gap="sm">
      <ReadProblem error={state.error} m={m} stale />
      <SnapshotBody snapshot={state.snapshot} token={current.token} m={m} />
    </Stack>
  )
}

/** A failed read: what Todoist said, and a way to ask again. */
function ReadProblem({
  error,
  m,
  stale = false
}: {
  error: TodoistError
  m: Messages
  stale?: boolean
}) {
  return (
    <Callout tone={stale ? 'warning' : 'danger'} title={stale ? m.staleTitle : m.errorTitle}>
      <Stack gap="xs">
        <Text size="xs">{m.errors[error.code](error)}</Text>
        <Button variant="outline" size="xs" icon="refresh" onPress={() => void refresh()}>
          {m.retry}
        </Button>
      </Stack>
    </Callout>
  )
}

/** A failure the panel itself saw: a refused request, or a link the host would not open. */
function Problem({ failure: problem, m }: { failure: Failure; m: Messages }) {
  return (
    <Callout tone="danger" title={problem.title ?? undefined}>
      <Stack gap="xs">
        <Text size="xs">{problem.message}</Text>
        {problem.retry ? (
          <Button variant="outline" size="xs" icon="refresh" onPress={() => void load()}>
            {m.retry}
          </Button>
        ) : null}
      </Stack>
    </Callout>
  )
}

function setFilter(value: string): void {
  if (value === 'all' || value === 'today' || value === 'overdue' || value === 'week') {
    set(filter, value)
  }
}

function SnapshotBody({
  snapshot,
  token,
  m
}: {
  snapshot: TodoistSnapshot
  token: TokenStatus
  m: Messages
}) {
  const timeZone = snapshot.user?.timezone ?? 'UTC'
  const todayKey = dayKeyOf(new Date(), timeZone)
  const stats = statsOf(snapshot.tasks, todayKey, timeZone)
  const active = read(filter)
  const context = contextOf(snapshot)
  const buckets =
    active === 'all'
      ? EMPTY_FILTERS.buckets
      : active === 'week'
        ? (['today', 'tomorrow', 'week'] as const)
        : [active]
  const matched = filterTasks(snapshot, { ...EMPTY_FILTERS, buckets }, todayKey, timeZone)
  const sorted = sortTasks(matched, 'due', timeZone, context.projects)
  const shown = sorted.slice(0, MAX_ROWS)
  const groups = active === 'all' ? groupByBucket(shown, todayKey, timeZone, 'due', context.projects) : []
  const counts = subtaskCounts(snapshot.tasks)
  return (
    <Stack gap="sm">
      <Row gap="xs" wrap>
        {stats.overdue > 0 ? (
          <Badge tone="danger">{`${m.stats.overdue} ${stats.overdue}`}</Badge>
        ) : null}
        {stats.today > 0 ? (
          <Badge tone="accent">{`${m.stats.today} ${stats.today}`}</Badge>
        ) : null}
        {stats.week > 0 ? (
          <Badge tone="neutral">{`${m.stats.week} ${stats.week}`}</Badge>
        ) : null}
      </Row>
      <Tabs label={m.filters} value={active} onChange={setFilter}>
        <Tab value="all" label={m.stats.total} />
        <Tab value="today" label={`${m.stats.today} (${stats.today})`} />
        <Tab value="overdue" label={`${m.stats.overdue} (${stats.overdue})`} />
        <Tab value="week" label={m.stats.week} />
      </Tabs>
      {snapshot.tasks.length === 0 ? (
        <EmptyState icon="check" title={m.noTasks} description={m.noTasksBody} />
      ) : sorted.length === 0 ? (
        <EmptyState icon="search" title={m.noMatch} description={m.noMatchBody} />
      ) : active === 'all' ? (
        <Stack gap="sm">
          {groups.map((group) => (
            <Stack gap="xs" key={group.bucket}>
              <Text size="xs" muted>
                {m.buckets[group.bucket]}
              </Text>
              <List>
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    m={m}
                    todayKey={todayKey}
                    timeZone={timeZone}
                    projects={context.projects}
                    subtasks={counts.get(task.id) ?? 0}
                  />
                ))}
              </List>
            </Stack>
          ))}
        </Stack>
      ) : (
        <List>
          {shown.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              m={m}
              todayKey={todayKey}
              timeZone={timeZone}
              projects={context.projects}
              subtasks={counts.get(task.id) ?? 0}
            />
          ))}
        </List>
      )}
      {sorted.length > MAX_ROWS ? (
        <Text size="xs" muted>
          {m.showing(sorted.length)}
        </Text>
      ) : null}
      <Footer token={token} snapshot={snapshot} m={m} />
    </Stack>
  )
}

function TaskRow({
  task,
  m,
  todayKey,
  timeZone,
  projects,
  subtasks
}: {
  task: TodoistTask
  m: Messages
  todayKey: string
  timeZone: string
  projects: ReadonlyMap<string, TodoistProject>
  subtasks: number
}) {
  const project = projects.get(task.projectId)?.name ?? null
  const dayKey = dueDayKey(task.due, timeZone)
  const day =
    dayKey === null
      ? task.due?.string ?? null
      : dayLabel(m, dayKey, todayKey, env.locale, (key, locale) => formatDay(key, locale))
  const time = dayKey === null ? null : formatTime(task.due?.datetime ?? null, env.locale, timeZone)
  const due = day === null ? null : time === null ? day : `${day} ${time}`
  const description = [project, due].filter((part): part is string => part !== null).join(' · ')
  return (
    <ListItem
      title={task.content}
      description={description}
      icon="check"
      onPress={() => void openTask(task.url)}
    >
      <Row gap="xs" align="center" wrap>
        <Badge tone={priorityTone(task.priority)}>{priorityName(task.priority)}</Badge>
        {task.labels.slice(0, 2).map((label) => (
          <Badge key={label} tone="neutral">
            {label}
          </Badge>
        ))}
        {subtasks > 0 ? <Badge tone="danger">{m.subtaskCount(subtasks)}</Badge> : null}
      </Row>
    </ListItem>
  )
}

function priorityTone(priority: number): 'danger' | 'warning' | 'neutral' {
  return priority >= 4 ? 'danger' : priority === 3 ? 'warning' : 'neutral'
}

function Footer({
  token,
  snapshot,
  m
}: {
  token: TokenStatus
  snapshot: TodoistSnapshot
  m: Messages
}) {
  const source = token.source
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text size="xs" muted>
          {m.updated} <RelativeTime at={snapshot.fetchedAt} format="short" />
        </Text>
        <Row gap="xs" align="center">
          {source === 'none' ? null : (
            <Text size="xs" muted>
              {m.sources[source]}
            </Text>
          )}
          {source === 'secret' || source === 'setting' ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={read(busy)}
              onPress={() => void forget()}
            >
              {m.forgetToken}
            </Button>
          ) : null}
        </Row>
      </Row>
      <Text size="xs" muted>
        {m.panelOpenPage}
        {' · '}
        {m.panelOpenHint}
      </Text>
    </Stack>
  )
}

/** What a refusal says, in the host's words; its code when it says nothing. */
function describe(error: unknown): string {
  const { message, code } = error as { message?: string; code?: string }
  return message || code || String(error)
}
