// The plugin's worker. Frames have no network, so the panel and the page ask here and this module
// is the only thing that reads Todoist. It keeps the last good answer in the plugin's storage, so
// reopening a page draws at once and a failed read still has something to show.

import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type {
  ProjectCreateInput,
  TaskCreateInput,
  TaskUpdateInput,
  TokenProtection,
  TokenSource,
  TokenStatus,
  TodoistError,
  TodoistMutation,
  TodoistSnapshot,
  TodoistState,
  TodoistView
} from './protocol'
import {
  RequestError,
  clearDueOnTask,
  closeTask,
  createProject,
  createTask,
  deleteTask,
  fetchSnapshot,
  isDue,
  moveTask,
  refreshMinutesOf,
  reopenTask,
  updateTask
} from './todoist'

/** Where the page and the panel save the token, in the plugin's encrypted secrets. */
const SECRET = 'todoistToken'

/** Read when neither the secret nor the `apiToken` setting has one. */
const ENV_NAMES = ['TODOIST_API_TOKEN']

/** The last good snapshot, with the token it was read with, under the plugin's own storage. */
const CACHE_KEY = 'snapshot'

type Cache = {
  identity: string
  snapshot: TodoistSnapshot
}

type Config = {
  token: TokenStatus
  value: string | null
  refreshMinutes: number
}

let stop: (() => void) | null = null

/** Aborts the read in flight; Orca awaits it before the worker stops. */
export function deactivate(): void {
  stop?.()
  stop = null
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** FNV-1a over the token; only names a cache entry, never the token itself. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** How a token is named in storage: its shape, not the token itself. */
function identityOf(source: TokenSource, value: string | null): string {
  if (value === null) {
    return 'none:'
  }
  return `${source}:${fingerprint(value)}`
}

function describe(error: unknown): string {
  const { message, code } = error as { message?: string; code?: string }
  return message || code || String(error)
}

/** The last four characters; a Todoist token is long enough that this never shows the whole. */
export function mask(token: string): string {
  return token.length <= 4 ? '••••' : `••••${token.slice(-4)}`
}

/** A failed read, as the view reports it. */
export function toFailure(error: unknown): TodoistError {
  if (error instanceof RequestError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      detail: error.detail,
      retryAfterMs: error.retryAfterMs
    }
  }
  return { code: 'unreachable', httpStatus: null, detail: describe(error), retryAfterMs: null }
}

export default function activate(orca: OrcaWorkerApi): void {
  const live = {
    token: { source: 'none', masked: null, protection: 'os-keyring' } as TokenStatus,
    identity: 'none:',
    snapshot: null as TodoistSnapshot | null,
    failure: null as TodoistError | null,
    refreshMinutes: 5,
    lastAttemptAt: 0,
    running: null as Promise<void> | null,
    request: null as AbortController | null,
    stopped: false
  }

  const view = (): TodoistView => {
    let state: TodoistState
    if (live.token.source === 'none') {
      state = { status: 'idle' }
    } else if (live.failure !== null) {
      state = { status: 'error', error: live.failure, snapshot: live.snapshot }
    } else if (live.snapshot !== null) {
      state = { status: 'ready', snapshot: live.snapshot }
    } else {
      state = { status: 'idle' }
    }
    return { token: { ...live.token }, state }
  }

  let posted = ''

  /** Tells every open surface what changed, and only that. */
  const publish = (): void => {
    const current = view()
    const json = JSON.stringify(current)
    if (json === posted) {
      return
    }
    posted = json
    try {
      orca.panels.post('todoist.changed', { view: current })
    } catch (error) {
      orca.log(`panel post: ${describe(error)}`)
    }
  }

  /** Reports a state it is about to leave, so a surface never waits on a silent read. */
  const announceLoading = (): void => {
    if (live.snapshot === null && live.failure === null) {
      const pending: TodoistView = {
        token: { ...live.token },
        state: { status: 'loading' }
      }
      const json = JSON.stringify(pending)
      if (json !== posted) {
        posted = json
        try {
          orca.panels.post('todoist.changed', { view: pending })
        } catch (error) {
          orca.log(`panel post: ${describe(error)}`)
        }
      }
    }
  }

  /** Reads the token and the settings; secrets first, then the setting, then the environment. */
  const readConfig = async (): Promise<Config> => {
    const [secret, fallback, protection, minutes] = await Promise.all([
      orca.secrets.get(SECRET),
      orca.settings.get('apiToken'),
      orca.host.call('secrets.protection'),
      orca.settings.get('refreshMinutes')
    ])
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env
    const saved = nonEmpty(secret)
    const setting = nonEmpty(typeof fallback === 'string' ? fallback : null)
    const fromEnv = ENV_NAMES.map((name) => nonEmpty(env?.[name])).find(
      (value) => value !== null
    )
    const value = saved ?? setting ?? fromEnv ?? null
    const source: TokenSource =
      saved !== null ? 'secret' : setting !== null ? 'setting' : fromEnv ? 'env' : 'none'
    return {
      token: {
        source,
        masked: value === null ? null : mask(value),
        protection: protection.status as TokenProtection
      },
      value,
      refreshMinutes: refreshMinutesOf(minutes)
    }
  }

  const loadCache = async (identity: string): Promise<void> => {
    try {
      const raw = await orca.storage.get(CACHE_KEY)
      const cache = raw as Cache | null
      if (
        cache !== null &&
        typeof cache === 'object' &&
        cache.identity === identity &&
        cache.snapshot !== null &&
        Array.isArray(cache.snapshot.tasks)
      ) {
        live.snapshot = cache.snapshot
        live.lastAttemptAt = cache.snapshot.fetchedAt
      }
    } catch (error) {
      orca.log(`cache: ${describe(error)}`)
    }
  }

  const saveCache = async (identity: string, snapshot: TodoistSnapshot): Promise<void> => {
    try {
      await orca.storage.set(CACHE_KEY, { identity, snapshot } as unknown as JsonValue)
    } catch (error) {
      orca.log(`cache write: ${describe(error)}`)
    }
  }

  /** One read of Todoist; joins a read already in flight rather than starting a second. */
  const read = async (token: string, identity: string): Promise<void> => {
    if (live.running !== null) {
      await live.running
      return
    }
    const controller = new AbortController()
    live.request = controller
    announceLoading()
    const task = (async () => {
      try {
        const snapshot = await fetchSnapshot({ token, signal: controller.signal })
        if (live.stopped || controller.signal.aborted) {
          return
        }
        live.snapshot = snapshot
        live.failure = null
        live.lastAttemptAt = snapshot.fetchedAt
        await saveCache(identity, snapshot)
      } catch (error) {
        if (!controller.signal.aborted) {
          live.failure = toFailure(error)
          live.lastAttemptAt = Date.now()
          orca.log(`todoist: ${describe(error)}`)
        }
      } finally {
        live.request = null
        publish()
      }
    })()
    live.running = task
    try {
      await task
    } finally {
      live.running = null
    }
  }

  /** One configuration pass at a time: a startup read and a panel request must not race. */
  let preparing: Promise<unknown> = Promise.resolve()

  const prepare = (force: boolean, signal?: AbortSignal): Promise<void> => {
    const run = preparing.then(() => doPrepare(force, signal))
    preparing = run.catch(() => undefined)
    return run
  }

  /** Reads the configuration, drops another account's cache, and reads Todoist when due. */
  const doPrepare = async (force: boolean, signal?: AbortSignal): Promise<void> => {
    const config = await readConfig()
    const identity = identityOf(config.token.source, config.value)
    live.token = config.token
    live.refreshMinutes = config.refreshMinutes
    if (identity !== live.identity) {
      live.identity = identity
      live.snapshot = null
      live.failure = null
      live.lastAttemptAt = 0
      if (config.value !== null) {
        await loadCache(identity)
      }
    }
    if (config.value !== null && (force || isDue(live.lastAttemptAt, config.refreshMinutes, Date.now()))) {
      await read(config.value, identity)
    }
    if (signal?.aborted) {
      throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
    }
    publish()
  }

  /** One write at a time, so two quick edits cannot interleave their refreshes. */
  let mutating: Promise<unknown> = Promise.resolve()

  /** Runs a write, then reads the account again. The write's result is the surface's answer. */
  const mutate = (
    run: (token: string, signal: AbortSignal | undefined) => Promise<void>,
    signal?: AbortSignal
  ): Promise<TodoistMutation> => {
    const task = mutating.then(async (): Promise<TodoistMutation> => {
      // A surface can write before its first read finished; load the snapshot first so a
      // project change can be told from a no-op, and so a failure still leaves data to draw.
      await prepare(false)
      const config = await readConfig()
      live.token = config.token
      live.refreshMinutes = config.refreshMinutes
      if (config.value === null) {
        return {
          ok: false,
          error: {
            code: 'bad_token',
            httpStatus: null,
            detail: 'Connect Todoist first.',
            retryAfterMs: null
          },
          view: view()
        }
      }
      const identity = identityOf(config.token.source, config.value)
      try {
        await run(config.value, signal)
      } catch (error) {
        return { ok: false, error: toFailure(error), view: view() }
      }
      // The write stands even when the read after it fails; the next surface read retries.
      try {
        const snapshot = await fetchSnapshot({ token: config.value, signal })
        live.snapshot = snapshot
        live.failure = null
        live.lastAttemptAt = snapshot.fetchedAt
        live.identity = identity
        await saveCache(identity, snapshot)
      } catch (error) {
        orca.log(`refresh after write: ${describe(error)}`)
        live.lastAttemptAt = 0
      }
      publish()
      return { ok: true, view: view() }
    })
    mutating = task.catch(() => undefined)
    return task
  }

  const taskOfSnapshot = (id: string) => live.snapshot?.tasks.find((task) => task.id === id)

  orca.panels.handle('todoist.get', async (_input, context) => {
    await prepare(false, context.signal)
    return view()
  })

  orca.panels.handle('todoist.refresh', async (_input, context) => {
    await prepare(true, context.signal)
    return view()
  })

  orca.panels.handle('token.set', async (input, context) => {
    const value = typeof input?.value === 'string' ? input.value.trim() : ''
    if (value === '') {
      throw Object.assign(new Error('The token is empty.'), { code: 'invalid_params' })
    }
    // Check it before saving: a typo must not replace a token that works.
    const snapshot = await fetchSnapshot({ token: value, signal: context.signal })
    const protection = await orca.host.call('secrets.protection')
    let source: TokenSource = 'secret'
    if (protection.status === 'os-keyring') {
      await orca.secrets.set(SECRET, value)
    } else {
      // No OS key store: the declared setting is the only place left, and the panel says so.
      await orca.settings.set('apiToken', value)
      source = 'setting'
    }
    live.token = { source, masked: mask(value), protection: protection.status }
    live.identity = identityOf(source, value)
    live.snapshot = snapshot
    live.failure = null
    live.lastAttemptAt = snapshot.fetchedAt
    await saveCache(live.identity, snapshot)
    publish()
    return view()
  })

  orca.panels.handle('token.forget', async () => {
    await orca.secrets.delete(SECRET)
    await orca.settings.set('apiToken', '')
    await orca.storage.delete(CACHE_KEY)
    live.snapshot = null
    live.failure = null
    live.lastAttemptAt = 0
    live.identity = 'none:'
    live.token = { ...live.token, source: 'none', masked: null }
    publish()
    return view()
  })

  orca.panels.handle('task.create', (input, context) =>
    mutate(
      (token, signal) => createTask({ token, signal, input: input as TaskCreateInput }),
      context.signal
    )
  )

  orca.panels.handle('task.update', (input, context) =>
    mutate(async (token, signal) => {
      await updateTask({ token, signal, input: input as TaskUpdateInput })
      const current = taskOfSnapshot(input.id)
      if (
        current !== undefined &&
        current.due !== null &&
        (input.dueDate === null || input.dueDate === '')
      ) {
        await clearDueOnTask({ token, signal, id: input.id })
      }
      const moved =
        current !== undefined &&
        (current.projectId !== input.projectId ||
          (current.sectionId ?? null) !== (input.sectionId ?? null))
      if (moved && input.projectId !== '') {
        await moveTask({
          token,
          signal,
          id: input.id,
          projectId: input.projectId,
          sectionId: input.sectionId
        })
      }
    }, context.signal)
  )

  orca.panels.handle('task.close', (input, context) =>
    mutate((token, signal) => closeTask({ token, signal, id: input.id }), context.signal)
  )

  orca.panels.handle('task.reopen', (input, context) =>
    mutate((token, signal) => reopenTask({ token, signal, id: input.id }), context.signal)
  )

  orca.panels.handle('task.delete', (input, context) =>
    mutate((token, signal) => deleteTask({ token, signal, id: input.id }), context.signal)
  )

  orca.panels.handle('project.create', (input, context) =>
    mutate(
      (token, signal) => createProject({ token, signal, input: input as ProjectCreateInput }),
      context.signal
    )
  )

  stop = () => {
    live.stopped = true
    live.request?.abort()
  }

  // A cached answer is drawn before the first network round trip; the read follows it.
  void prepare(false).catch((error) => {
    orca.log(`start: ${describe(error)}`)
  })
}
