// Todoist's colour names as hex, for the dots and chips both surfaces draw. Todoist sends the
// name (`berry_red`), not the value; unknown names fall back to a neutral grey.

export const TODOIST_COLORS: Readonly<Record<string, string>> = {
  berry_red: '#b8256f',
  red: '#db4035',
  orange: '#ff9933',
  yellow: '#fad000',
  olive_green: '#afb83b',
  green: '#299438',
  teal: '#6accbc',
  sky_blue: '#158fad',
  light_blue: '#96c3eb',
  blue: '#4073ff',
  grape: '#884dff',
  violet: '#af38eb',
  lavender: '#eb96eb',
  magenta: '#e05194',
  salmon: '#ff8d85',
  charcoal: '#808080',
  grey: '#b8b8b8',
  taupe: '#ccac93'
}

const FALLBACK = '#b8b8b8'

export function colorOf(name: string | null | undefined): string {
  return (name !== null && name !== undefined && TODOIST_COLORS[name]) || FALLBACK
}

/** Todoist's priority runs 1 (normal) to 4 (urgent); its UI names them the other way round. */
export function priorityColor(priority: number): string {
  return priority >= 4 ? '#db4035' : priority === 3 ? '#ff9933' : priority === 2 ? '#4073ff' : '#b8b8b8'
}

/** The label Todoist shows for a priority: 4 becomes P1. */
export function priorityName(priority: number): string {
  return `P${Math.max(1, Math.min(4, 5 - priority))}`
}
