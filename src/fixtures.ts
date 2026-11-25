// A fixed snapshot for tests: one account in Asia/Seoul, three projects, every due bucket, and
// tasks with times, labels, a deadline and a subtask. `NOW` is 2026-05-29 05:26 in Seoul, so the
// fixture's days do not drift with the real clock.

import type {
  TodoistDeadline,
  TodoistDue,
  TodoistLabel,
  TodoistProject,
  TodoistSection,
  TodoistSnapshot,
  TodoistTask
} from './protocol'

/** 2026-05-28T20:26:40Z, or 2026-05-29 05:26 in Asia/Seoul. */
export const NOW = 1_780_000_000_000

/** A long token-shaped string, so a leak would be obvious in a test. */
export const TOKEN = 'tok_test_0123456789abcdef0123456789abcdef'

function due(
  date: string,
  datetime: string | null = null,
  isRecurring = false
): TodoistDue {
  return {
    date,
    datetime,
    timezone: datetime === null ? null : 'Asia/Seoul',
    string: datetime === null ? date : `${date} ${datetime.slice(11, 16)}`,
    isRecurring,
    lang: 'en'
  }
}

const projects: TodoistProject[] = [
  {
    id: 'p-inbox',
    name: 'Inbox',
    color: 'charcoal',
    isFavorite: false,
    isInboxProject: true,
    order: 0,
    parentId: null
  },
  {
    id: 'p-work',
    name: 'Work',
    color: 'berry_red',
    isFavorite: true,
    isInboxProject: false,
    order: 1,
    parentId: null
  },
  {
    id: 'p-personal',
    name: 'Personal',
    color: 'green',
    isFavorite: false,
    isInboxProject: false,
    order: 2,
    parentId: null
  }
]

const sections: TodoistSection[] = [
  { id: 's-backlog', projectId: 'p-work', name: 'Backlog', order: 0 }
]

const labels: TodoistLabel[] = [
  { id: 'l-next', name: 'next', color: 'blue', order: 0 },
  { id: 'l-errand', name: 'errand', color: 'orange', order: 1 }
]

function task(
  fields: Partial<TodoistTask> & Pick<TodoistTask, 'id' | 'content' | 'projectId' | 'order'>
): TodoistTask {
  return {
    description: '',
    sectionId: null,
    parentId: null,
    labels: [],
    priority: 1,
    due: null,
    deadline: null,
    addedAt: '2026-05-25T00:00:00Z',
    url: `https://app.todoist.com/app/task/${fields.id}`,
    dayOrder: fields.order,
    duration: null,
    ...fields
  }
}

const deadline: TodoistDeadline = { date: '2026-05-26', lang: 'en' }

const tasks: TodoistTask[] = [
  task({
    id: 't-overdue',
    content: 'File the quarterly report',
    projectId: 'p-work',
    sectionId: 's-backlog',
    labels: ['next'],
    priority: 4,
    due: due('2026-05-27', '2026-05-27T09:00:00+09:00'),
    deadline,
    addedAt: '2026-05-20T01:00:00Z',
    order: 0
  }),
  task({
    id: 't-subtask',
    content: 'Collect the receipts',
    projectId: 'p-work',
    sectionId: 's-backlog',
    parentId: 't-overdue',
    labels: ['errand'],
    priority: 2,
    addedAt: '2026-05-21T02:00:00Z',
    order: 1,
    dayOrder: 0,
    duration: { amount: 30, unit: 'minute' }
  }),
  task({
    id: 't-today-timed',
    content: 'Standup with the team',
    projectId: 'p-work',
    labels: ['next'],
    priority: 3,
    due: due('2026-05-29', '2026-05-29T14:00:00+09:00', true),
    addedAt: '2026-05-28T02:00:00Z',
    order: 2,
    duration: { amount: 15, unit: 'minute' }
  }),
  task({
    id: 't-today-allday',
    content: 'Water the plants',
    projectId: 'p-personal',
    labels: ['errand'],
    priority: 1,
    due: due('2026-05-29'),
    addedAt: '2026-05-26T23:30:00Z',
    order: 3
  }),
  task({
    id: 't-tomorrow',
    content: 'Book the dentist',
    projectId: 'p-personal',
    priority: 2,
    due: due('2026-05-30'),
    addedAt: '2026-05-24T05:00:00Z',
    order: 4
  }),
  task({
    id: 't-week',
    content: 'Renew the passport',
    projectId: 'p-personal',
    labels: ['errand'],
    priority: 1,
    due: due('2026-06-02'),
    addedAt: '2026-05-22T08:00:00Z',
    order: 5
  }),
  task({
    id: 't-later',
    content: 'Plan the summer trip',
    description: 'Compare flights and hotels before the prices rise.',
    projectId: 'p-inbox',
    priority: 3,
    due: due('2026-06-18'),
    addedAt: '2026-05-19T12:00:00Z',
    order: 6
  }),
  task({
    id: 't-none',
    content: 'Read the API docs',
    projectId: 'p-inbox',
    labels: ['next'],
    priority: 1,
    addedAt: '2026-05-18T15:00:00Z',
    order: 7
  })
]

/** The sample snapshot, stamped `now` (defaults to the fixed `NOW`). */
export function sampleSnapshot(now: number = NOW): TodoistSnapshot {
  return {
    fetchedAt: now,
    tasks: tasks.map((item) => ({
      ...item,
      labels: [...item.labels],
      due: item.due === null ? null : { ...item.due },
      deadline: item.deadline === null ? null : { ...item.deadline },
      duration: item.duration === null ? null : { ...item.duration }
    })),
    projects: projects.map((item) => ({ ...item })),
    sections: sections.map((item) => ({ ...item })),
    labels: labels.map((item) => ({ ...item })),
    user: { name: 'Pinion', email: 'pinion@example.com', timezone: 'Asia/Seoul' }
  }
}
