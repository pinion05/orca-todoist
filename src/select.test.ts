// The selectors both surfaces share, checked against the fixed sample snapshot. These are pure
// functions, so everything here runs in Node without a host.

import { assert, test } from 'orca/testing'
import type { TodoistTask } from './protocol'
import { NOW, sampleSnapshot } from './fixtures'
import {
  EMPTY_FILTERS,
  addDays,
  addMonths,
  bucketOf,
  bucketOfDay,
  calendarGrid,
  dayKeyOf,
  dayRelation,
  dueDayKey,
  filterTasks,
  formatDay,
  formatTime,
  groupByBucket,
  projectColumns,
  sortTasks,
  statsOf,
  tasksByDay,
  weekdayOf
} from './select'
import type { ViewFilters } from './select'

const snapshot = sampleSnapshot()
const timeZone = snapshot.user?.timezone ?? 'UTC'
const todayKey = dayKeyOf(new Date(NOW), timeZone)
const projects = new Map(snapshot.projects.map((project) => [project.id, project]))

function ids(tasks: readonly TodoistTask[]): string[] {
  return tasks.map((task) => task.id)
}

function taskById(id: string): TodoistTask {
  const task = snapshot.tasks.find((item) => item.id === id)
  assert.ok(task !== undefined, `fixture task ${id} is missing`)
  return task
}

function filters(overrides: Partial<ViewFilters>): ViewFilters {
  return { ...EMPTY_FILTERS, ...overrides }
}

// --- days ------------------------------------------------------------------------------------

test('dayKeyOf follows the account time zone across a UTC date boundary', () => {
  assert.equal(todayKey, '2026-05-29')
  assert.equal(dayKeyOf(new Date('2026-05-28T14:59:59Z'), 'Asia/Seoul'), '2026-05-28')
  assert.equal(dayKeyOf(new Date('2026-05-28T15:00:00Z'), 'Asia/Seoul'), '2026-05-29')
  assert.equal(dayKeyOf(new Date('2026-05-28T20:26:40Z'), 'Asia/Seoul'), '2026-05-29')
})

test('dayKeyOf falls back to UTC for an invalid zone', () => {
  const at = new Date(NOW)
  assert.equal(dayKeyOf(at, 'Not/AZone'), dayKeyOf(at, 'UTC'))
  assert.equal(dayKeyOf(at, 'Not/AZone'), '2026-05-28')
})

test('addDays crosses a month end, a year end and a leap day', () => {
  assert.equal(addDays('2026-05-31', 1), '2026-06-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(addDays('2028-02-29', 1), '2028-03-01')
  assert.equal(addDays('2026-05-29', 7), '2026-06-05')
})

test('addMonths crosses a year', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01')
  assert.equal(addMonths('2026-01', -1), '2025-12')
  assert.equal(addMonths('2026-08', 6), '2027-02')
})

test('bucketOfDay names every bucket, with the +7 boundary in week', () => {
  assert.equal(bucketOfDay(null, todayKey), 'none')
  assert.equal(bucketOfDay('2026-05-28', todayKey), 'overdue')
  assert.equal(bucketOfDay('2026-05-29', todayKey), 'today')
  assert.equal(bucketOfDay('2026-05-30', todayKey), 'tomorrow')
  assert.equal(bucketOfDay('2026-05-31', todayKey), 'week')
  assert.equal(bucketOfDay('2026-06-05', todayKey), 'week')
  assert.equal(bucketOfDay('2026-06-06', todayKey), 'later')
  assert.equal(bucketOf(taskById('t-overdue'), todayKey, timeZone), 'overdue')
})

test('calendarGrid for March 2026 starts on Monday and marks the month and today', () => {
  const grid = calendarGrid('2026-03', 1, '2026-03-15')
  assert.equal(grid.length, 6)
  assert.ok(grid.every((week) => week.length === 7))
  assert.equal(grid[0]?.[0]?.key, '2026-02-23')
  assert.equal(weekdayOf(grid[0]?.[0]?.key ?? ''), 1)
  assert.equal(grid[0]?.[0]?.inMonth, false)
  assert.equal(grid[5]?.[6]?.key, '2026-04-05')
  const cells = grid.flat()
  assert.equal(cells.filter((cell) => cell.inMonth).length, 31)
  assert.ok(cells.some((cell) => cell.key === '2026-03-01' && cell.inMonth))
  assert.ok(cells.some((cell) => cell.key === '2026-03-15' && cell.today))
  assert.equal(cells.filter((cell) => cell.today).length, 1)
})

// --- filtering -------------------------------------------------------------------------------

test('filterTasks keeps a project, a label, a priority and a bucket', () => {
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ projectIds: ['p-work'] }), todayKey, timeZone)),
    ['t-overdue', 't-subtask', 't-today-timed']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ labelNames: ['errand'] }), todayKey, timeZone)),
    ['t-subtask', 't-today-allday', 't-week']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ priorities: [4] }), todayKey, timeZone)),
    ['t-overdue']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ buckets: ['today'] }), todayKey, timeZone)),
    ['t-today-timed', 't-today-allday']
  )
})

test('hideSubtasks drops every task with a parent', () => {
  const kept = filterTasks(snapshot, filters({ hideSubtasks: true }), todayKey, timeZone)
  assert.equal(kept.length, snapshot.tasks.length - 1)
  assert.ok(!ids(kept).includes('t-subtask'))
})

test('query text searches content and description', () => {
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: 'passport' }), todayKey, timeZone)),
    ['t-week']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: 'flights' }), todayKey, timeZone)),
    ['t-later']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: 'missing' }), todayKey, timeZone)),
    []
  )
})

test('query @label and #project narrow the list', () => {
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: '@errand' }), todayKey, timeZone)),
    ['t-subtask', 't-today-allday', 't-week']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: '#work' }), todayKey, timeZone)),
    ['t-overdue', 't-subtask', 't-today-timed']
  )
  assert.deepEqual(
    ids(
      filterTasks(
        snapshot,
        filters({ query: '@next', projectIds: ['p-inbox'] }),
        todayKey,
        timeZone
      )
    ),
    ['t-none']
  )
})

test('query p1..p4 maps p1 to Todoist priority 4', () => {
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: 'p1' }), todayKey, timeZone)),
    ['t-overdue']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: 'p2' }), todayKey, timeZone)),
    ['t-today-timed', 't-later']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: 'p3' }), todayKey, timeZone)),
    ['t-subtask', 't-tomorrow']
  )
  assert.deepEqual(
    ids(filterTasks(snapshot, filters({ query: 'p4' }), todayKey, timeZone)),
    ['t-today-allday', 't-week', 't-none']
  )
})

// --- sorting ---------------------------------------------------------------------------------

test('sortTasks by due puts tasks without a date last', () => {
  const sorted = sortTasks(snapshot.tasks, 'due', timeZone, projects)
  assert.equal(sorted[0]?.id, 't-overdue')
  assert.deepEqual(sorted.slice(-2).map((task) => task.id).sort(), ['t-none', 't-subtask'])
  assert.ok(sorted.slice(-2).every((task) => task.due === null))
  const days = sorted
    .slice(0, -2)
    .map((task) => dueDayKey(task.due, timeZone) ?? '')
  assert.deepEqual(days, [...days].sort())
})

test('sortTasks by priority puts the highest first', () => {
  const sorted = sortTasks(snapshot.tasks, 'priority', timeZone, projects)
  assert.equal(sorted[0]?.id, 't-overdue')
  assert.equal(sorted[0]?.priority, 4)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]?.priority ?? 0
    const current = sorted[index]?.priority ?? 0
    assert.ok(previous >= current, 'priorities never rise again')
  }
})

test('sortTasks by alpha and by manual order', () => {
  const alpha = sortTasks(snapshot.tasks, 'alpha', timeZone, projects)
  assert.equal(alpha[0]?.content, 'Book the dentist')
  assert.equal(alpha[alpha.length - 1]?.content, 'Water the plants')
  const manual = sortTasks(snapshot.tasks, 'manual', timeZone, projects)
  assert.deepEqual(ids(manual), [
    't-overdue',
    't-subtask',
    't-today-timed',
    't-today-allday',
    't-tomorrow',
    't-week',
    't-later',
    't-none'
  ])
})

// --- views -----------------------------------------------------------------------------------

test('groupByBucket keeps bucket order and drops empty groups', () => {
  const groups = groupByBucket(snapshot.tasks, todayKey, timeZone, 'due', projects)
  assert.deepEqual(
    groups.map((group) => group.bucket),
    ['overdue', 'today', 'tomorrow', 'week', 'later', 'none']
  )
  assert.ok(groups.every((group) => group.tasks.length > 0))
  assert.equal(groups.find((group) => group.bucket === 'today')?.dayKey, todayKey)
  assert.equal(groups.find((group) => group.bucket === 'tomorrow')?.dayKey, addDays(todayKey, 1))
  assert.equal(groups.find((group) => group.bucket === 'later')?.dayKey, null)

  const onlyToday = groupByBucket([taskById('t-today-timed')], todayKey, timeZone, 'due', projects)
  assert.deepEqual(
    onlyToday.map((group) => group.bucket),
    ['today']
  )
})

test('statsOf counts overdue, today, this week and undated tasks', () => {
  assert.deepEqual(statsOf(snapshot.tasks, todayKey, timeZone), {
    total: 8,
    overdue: 1,
    today: 2,
    week: 4,
    none: 2
  })
})

test('tasksByDay sorts a day by time, then by priority, and skips undated tasks', () => {
  const timed = taskById('t-today-timed')
  const baseDue = timed.due
  assert.ok(baseDue !== null)
  const at = (id: string, hour: string, priority: number): TodoistTask => ({
    ...timed,
    id,
    priority,
    due: { ...baseDue, date: '2026-05-29', datetime: `2026-05-29T${hour}:00+09:00` }
  })
  const allDay = taskById('t-today-allday')
  const days = tasksByDay(
    [at('x-late', '18:00', 1), at('x-early', '08:00', 1), at('x-urgent', '08:00', 4), allDay],
    timeZone
  )
  assert.deepEqual(ids(days.get('2026-05-29') ?? []), [
    't-today-allday',
    'x-urgent',
    'x-early',
    'x-late'
  ])
  assert.equal(tasksByDay([taskById('t-none')], timeZone).size, 0)
})

test('projectColumns keeps project order, skips empty projects and sorts inside each', () => {
  const inbox = snapshot.projects.find((project) => project.id === 'p-inbox')
  assert.ok(inbox !== undefined)
  const empty = { ...inbox, id: 'p-empty', name: 'Empty', order: 3 }
  const columns = projectColumns(
    snapshot.tasks,
    [...snapshot.projects, empty],
    'manual',
    timeZone
  )
  assert.deepEqual(
    columns.map((column) => column.project.name),
    ['Inbox', 'Work', 'Personal']
  )
  assert.deepEqual(ids(columns[0]?.tasks ?? []), ['t-later', 't-none'])
  assert.equal(columns[1]?.tasks.length, 3)
  assert.equal(columns[2]?.tasks.length, 3)
})

test('dayRelation names today, tomorrow, yesterday, overdue and upcoming', () => {
  assert.deepEqual(dayRelation(todayKey, todayKey), { kind: 'today', days: 0 })
  assert.deepEqual(dayRelation(addDays(todayKey, 1), todayKey), { kind: 'tomorrow', days: 1 })
  assert.deepEqual(dayRelation(addDays(todayKey, -1), todayKey), { kind: 'yesterday', days: -1 })
  assert.deepEqual(dayRelation(addDays(todayKey, -3), todayKey), { kind: 'overdue', days: -3 })
  assert.deepEqual(dayRelation(addDays(todayKey, 5), todayKey), { kind: 'upcoming', days: 5 })
})

test('formatDay and formatTime produce a localized string', () => {
  const day = formatDay('2026-05-29', 'en-US', { weekday: true, year: true })
  assert.ok(day.length > 0)
  assert.match(day, /2026/)
  assert.match(day, /May/)
  assert.ok(formatDay('2026-05-29', 'ko-KR').length > 0)

  const time = formatTime('2026-05-29T14:00:00+09:00', 'en-US', 'Asia/Seoul')
  assert.ok(time !== null)
  assert.ok((time ?? '').length > 0)
  assert.match(time ?? '', /2:00/)
  assert.equal(formatTime(null, 'en-US', 'Asia/Seoul'), null)
  assert.equal(formatTime('not a date', 'en-US', 'Asia/Seoul'), null)
})
