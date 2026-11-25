// What the panel and the page say, in Orca's UI language. English and Korean today; another
// locale falls back to English, the way Orca does for its own strings.

import { dayRelation, type DayRelation, type DueBucket, type SortKey } from './select'
import type { TokenSource, TodoistError, TodoistErrorCode } from './protocol'

export type Messages = {
  title: string
  tagline: string
  loading: string
  setupTitle: string
  setupBody: string
  setupBodyNoStore: string
  tokenLabel: string
  tokenPlaceholder: string
  saveToken: string
  tokenHelp: string
  forgetToken: string
  openTodoist: string
  refresh: string
  updated: string
  retry: string
  errorTitle: string
  staleTitle: string
  readOnlyFile: string
  addTask: string
  addTaskPlaceholder: string
  createTask: string
  newProject: string
  projectName: string
  createProject: string
  save: string
  cancel: string
  edit: string
  delete: string
  confirmDelete: string
  complete: string
  undo: string
  completedToast: (content: string) => string
  savedToast: string
  titleRequired: string
  close: string
  search: string
  searchPlaceholder: string
  filters: string
  dateBuckets: string
  clearFilters: string
  activeFilters: string
  noTasks: string
  noTasksBody: string
  noMatch: string
  noMatchBody: string
  noProjectTasks: string
  views: Record<'list' | 'calendar' | 'board', string>
  buckets: Record<DueBucket, string>
  sort: Record<SortKey, string>
  sortLabel: string
  projects: string
  labels: string
  priorities: string
  allProjects: string
  hideSubtasks: string
  weekStartsOn: string
  today: string
  calendarToday: string
  previousMonth: string
  nextMonth: string
  moreTasks: (count: number) => string
  stats: { overdue: string; today: string; week: string; total: string }
  overdueBy: (days: number) => string
  inDays: (days: number) => string
  subtaskCount: (count: number) => string
  showing: (count: number) => string
  panelTitle: string
  panelOpenPage: string
  panelOpenHint: string
  detailTitle: string
  detailDescription: string
  detailNoDescription: string
  detailProject: string
  detailSection: string
  detailDue: string
  detailDeadline: string
  detailPriority: string
  detailLabels: string
  detailAdded: string
  detailDuration: string
  detailSubtasks: string
  detailParent: string
  detailNone: string
  durationMinutes: (minutes: number) => string
  durationDays: (days: number) => string
  sources: Record<TokenSource, string>
  errors: Record<TodoistErrorCode, (error: TodoistError) => string>
}

const en: Messages = {
  title: 'Todoist',
  tagline: 'Your tasks, in Orca.',
  loading: 'Reading Todoist…',
  setupTitle: 'Connect your Todoist account',
  setupBody:
    'Paste a personal API token. It is checked, then saved encrypted on this device, and the plugin only reads tasks.',
  setupBodyNoStore:
    'Paste a personal API token. This device has no OS key store, so the token is saved as plain text in the plugin settings. The plugin only reads tasks.',
  tokenLabel: 'API token',
  tokenPlaceholder: 'Paste your Todoist API token',
  saveToken: 'Connect',
  tokenHelp: 'Todoist → Settings → Integrations → API token',
  forgetToken: 'Disconnect',
  openTodoist: 'Open Todoist',
  refresh: 'Refresh',
  updated: 'Updated',
  retry: 'Try again',
  errorTitle: 'Could not read Todoist',
  staleTitle: 'Showing the last read',
  readOnlyFile: 'This file is read-only, so view changes are not saved.',
  addTask: 'Add a task',
  addTaskPlaceholder: 'What needs doing?',
  createTask: 'Add',
  newProject: 'New project',
  projectName: 'Project name',
  createProject: 'Create',
  save: 'Save',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  confirmDelete: 'Delete for real?',
  complete: 'Complete',
  undo: 'Undo',
  completedToast: (content) => `Completed: ${content}`,
  savedToast: 'Saved',
  titleRequired: 'A task needs a title.',
  close: 'Close',
  search: 'Search',
  searchPlaceholder: 'Search tasks · @label · #project · p1',
  filters: 'Filters',
  dateBuckets: 'Due dates',
  clearFilters: 'Clear',
  activeFilters: 'Active filters',
  noTasks: 'No active tasks',
  noTasksBody: 'Everything in Todoist is done. Add a task there and it shows up here.',
  noMatch: 'Nothing matches',
  noMatchBody: 'Loosen a filter or clear the search to see more tasks.',
  noProjectTasks: 'No tasks in this project.',
  views: { list: 'List', calendar: 'Calendar', board: 'Board' },
  buckets: {
    overdue: 'Overdue',
    today: 'Today',
    tomorrow: 'Tomorrow',
    week: 'Next 7 days',
    later: 'Later',
    none: 'No date'
  },
  sort: {
    due: 'Due date',
    priority: 'Priority',
    project: 'Project',
    added: 'Recently added',
    alpha: 'Alphabetical',
    manual: 'Manual order'
  },
  sortLabel: 'Sort',
  projects: 'Projects',
  labels: 'Labels',
  priorities: 'Priority',
  allProjects: 'All projects',
  hideSubtasks: 'Hide subtasks',
  weekStartsOn: 'Week starts on',
  today: 'Today',
  calendarToday: 'Today',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  moreTasks: (count) => `+${count} more`,
  stats: { overdue: 'Overdue', today: 'Today', week: 'This week', total: 'Active' },
  overdueBy: (days) => (days === 1 ? '1 day overdue' : `${days} days overdue`),
  inDays: (days) => (days === 1 ? 'in 1 day' : `in ${days} days`),
  subtaskCount: (count) => (count === 1 ? '1 subtask' : `${count} subtasks`),
  showing: (count) => (count === 1 ? '1 task' : `${count} tasks`),
  panelTitle: 'Todoist',
  panelOpenPage: 'Open the full page',
  panelOpenHint: 'Tab bar + → New Todoist view',
  detailTitle: 'Task',
  detailDescription: 'Description',
  detailNoDescription: 'No description.',
  detailProject: 'Project',
  detailSection: 'Section',
  detailDue: 'Due',
  detailDeadline: 'Deadline',
  detailPriority: 'Priority',
  detailLabels: 'Labels',
  detailAdded: 'Added',
  detailDuration: 'Duration',
  detailSubtasks: 'Subtasks',
  detailParent: 'Parent task',
  detailNone: 'None',
  durationMinutes: (minutes) => (minutes === 1 ? '1 minute' : `${minutes} minutes`),
  durationDays: (days) => (days === 1 ? '1 day' : `${days} days`),
  sources: { secret: 'Saved encrypted', setting: 'Plugin setting', env: 'Environment', none: '' },
  errors: {
    bad_token: () => 'Todoist did not accept this token. Copy it again from Todoist → Settings → Integrations.',
    forbidden: () => 'This account is not allowed to read those tasks.',
    rate_limited: (error) =>
      error.retryAfterMs === null
        ? 'Todoist is rate limiting this account. Try again in a minute.'
        : `Todoist is rate limiting this account. Try again in ${Math.ceil(error.retryAfterMs / 1000)}s.`,
    http: (error) =>
      `Todoist answered with HTTP ${error.httpStatus ?? 'an error'}.`,
    unreachable: () => 'Could not reach api.todoist.com. Check the network, then try again.',
    timeout: () => 'Todoist did not answer in time.',
    bad_response: () => 'Todoist answered in a shape this plugin does not know.'
  }
}

const ko: Messages = {
  title: 'Todoist',
  tagline: 'Todoist의 할 일을 오르카에서.',
  loading: 'Todoist를 읽는 중…',
  setupTitle: 'Todoist 계정 연결',
  setupBody:
    '개인 API 토큰을 붙여넣으세요. 확인한 뒤 이 기기에 암호화해 저장하며, 플러그인은 할 일만 읽습니다.',
  setupBodyNoStore:
    '개인 API 토큰을 붙여넣으세요. 이 기기에는 OS 키 저장소가 없어 플러그인 설정에 평문으로 저장됩니다. 플러그인은 할 일만 읽습니다.',
  tokenLabel: 'API 토큰',
  tokenPlaceholder: 'Todoist API 토큰 붙여넣기',
  saveToken: '연결',
  tokenHelp: 'Todoist → 설정 → 연동 → API 토큰',
  forgetToken: '연결 해제',
  openTodoist: 'Todoist 열기',
  refresh: '새로고침',
  updated: '업데이트',
  retry: '다시 시도',
  errorTitle: 'Todoist를 읽지 못했습니다',
  staleTitle: '마지막으로 읽은 내용',
  readOnlyFile: '이 파일은 읽기 전용이라 보기 설정이 저장되지 않습니다.',
  addTask: '할 일 추가',
  addTaskPlaceholder: '무엇을 해야 하나요?',
  createTask: '추가',
  newProject: '새 프로젝트',
  projectName: '프로젝트 이름',
  createProject: '만들기',
  save: '저장',
  cancel: '취소',
  edit: '편집',
  delete: '삭제',
  confirmDelete: '정말 삭제할까요?',
  complete: '완료',
  undo: '되돌리기',
  completedToast: (content) => `완료: ${content}`,
  savedToast: '저장했습니다',
  titleRequired: '할 일 제목이 필요합니다.',
  close: '닫기',
  search: '검색',
  searchPlaceholder: '할 일 검색 · @라벨 · #프로젝트 · p1',
  filters: '필터',
  dateBuckets: '날짜',
  clearFilters: '지우기',
  activeFilters: '적용된 필터',
  noTasks: '진행 중인 할 일이 없습니다',
  noTasksBody: 'Todoist의 할 일을 모두 마쳤습니다. Todoist에서 추가하면 여기에 나타납니다.',
  noMatch: '조건에 맞는 할 일이 없습니다',
  noMatchBody: '필터를 풀거나 검색어를 지우면 더 많이 보입니다.',
  noProjectTasks: '이 프로젝트에 할 일이 없습니다.',
  views: { list: '목록', calendar: '캘린더', board: '보드' },
  buckets: {
    overdue: '지난 일',
    today: '오늘',
    tomorrow: '내일',
    week: '다음 7일',
    later: '나중에',
    none: '날짜 없음'
  },
  sort: {
    due: '마감일',
    priority: '우선순위',
    project: '프로젝트',
    added: '최근 추가',
    alpha: '이름순',
    manual: '직접 순서'
  },
  sortLabel: '정렬',
  projects: '프로젝트',
  labels: '라벨',
  priorities: '우선순위',
  allProjects: '모든 프로젝트',
  hideSubtasks: '하위 할 일 숨기기',
  weekStartsOn: '한 주 시작',
  today: '오늘',
  calendarToday: '오늘',
  previousMonth: '이전 달',
  nextMonth: '다음 달',
  moreTasks: (count) => `+${count}개 더`,
  stats: { overdue: '지남', today: '오늘', week: '이번 주', total: '진행 중' },
  overdueBy: (days) => (days === 1 ? '1일 지남' : `${days}일 지남`),
  inDays: (days) => (days === 1 ? '1일 뒤' : `${days}일 뒤`),
  subtaskCount: (count) => (count === 1 ? '하위 할 일 1개' : `하위 할 일 ${count}개`),
  showing: (count) => (count === 1 ? '할 일 1개' : `할 일 ${count}개`),
  panelTitle: 'Todoist',
  panelOpenPage: '전체 페이지 열기',
  panelOpenHint: '탭바 + → New Todoist view',
  detailTitle: '할 일',
  detailDescription: '설명',
  detailNoDescription: '설명이 없습니다.',
  detailProject: '프로젝트',
  detailSection: '섹션',
  detailDue: '마감',
  detailDeadline: '데드라인',
  detailPriority: '우선순위',
  detailLabels: '라벨',
  detailAdded: '추가한 날',
  detailDuration: '소요 시간',
  detailSubtasks: '하위 할 일',
  detailParent: '상위 할 일',
  detailNone: '없음',
  durationMinutes: (minutes) => (minutes === 1 ? '1분' : `${minutes}분`),
  durationDays: (days) => (days === 1 ? '1일' : `${days}일`),
  sources: { secret: '암호화 저장됨', setting: '플러그인 설정', env: '환경 변수', none: '' },
  errors: {
    bad_token: () => 'Todoist가 이 토큰을 받아들이지 않았습니다. Todoist → 설정 → 연동에서 다시 복사하세요.',
    forbidden: () => '이 계정은 해당 할 일을 읽을 권한이 없습니다.',
    rate_limited: (error) =>
      error.retryAfterMs === null
        ? 'Todoist가 요청을 제한하고 있습니다. 1분 뒤 다시 시도하세요.'
        : `Todoist가 요청을 제한하고 있습니다. ${Math.ceil(error.retryAfterMs / 1000)}초 뒤 다시 시도하세요.`,
    http: (error) => `Todoist가 HTTP ${error.httpStatus ?? '오류'}로 응답했습니다.`,
    unreachable: () => 'api.todoist.com에 닿지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.',
    timeout: () => 'Todoist가 제때 응답하지 않았습니다.',
    bad_response: () => 'Todoist가 이 플러그인이 모르는 형식으로 응답했습니다.'
  }
}

const byLocale: Readonly<Record<string, Messages>> = { en, ko }

/** The words for an Orca locale such as `ko` or `ko-KR`; English otherwise. */
export function messagesFor(locale: string): Messages {
  return byLocale[locale.toLowerCase().split('-')[0] ?? 'en'] ?? en
}

/** A day as the panel or page names it: "Today", "Tomorrow", "3 days overdue", or a date. */
export function dayLabel(
  m: Messages,
  dayKey: string,
  todayKey: string,
  locale: string,
  formatDay: (key: string, locale: string) => string
): string {
  const relation: DayRelation = dayRelation(dayKey, todayKey)
  switch (relation.kind) {
    case 'today':
      return m.today
    case 'tomorrow':
      return m.buckets.tomorrow
    case 'overdue':
      return m.overdueBy(-relation.days)
    case 'upcoming':
    case 'yesterday':
      return formatDay(dayKey, locale)
  }
}
