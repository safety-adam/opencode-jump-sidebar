import { Plugin } from "@opencode/plugin/tui"
import { Portal } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { execSync } from "node:child_process"
import { isArchivedTitle, toArchivedTitle, toUnarchivedTitle } from "./archive.ts"

// Spinner frames used by the TUI for a busy/working session.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
// Slower, quieter frames for background work (subagents or running shells).
const BACKGROUND = ["◌", "◎"]

function basename(p: string | undefined): string {
  if (!p) return ""
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || p
}

// Projects come from different sources with different path fields.
function projectDir(p: any): string {
  return p?.worktree ?? p?.canonical ?? p?.directory ?? ""
}

// Matches OpenCode's own default title for an untitled session.
function defaultTitle(session: any): string {
  const created = session?.time?.created
  if (!created) return "Untitled session"
  const kind = session?.parentID ? "Child" : "New"
  return `${kind} session - ${new Date(created).toISOString()}`
}

function displayTitle(session: any): string {
  return session?.title || defaultTitle(session)
}

// Watches the route and reports each session visit so the plugin can keep a
// browser style history stack. It renders nothing.
function SessionHistoryTracker(props: { context: any; onVisit: (sessionID: string) => void }) {
  createEffect(
    on(
      () => {
        const route = props.context.ui.router.current()
        return route?.type === "session" ? route.sessionID : undefined
      },
      (sessionID) => {
        if (sessionID) props.onVisit(sessionID)
      },
    ),
  )
  return null
}

function isArchived(session: any): boolean {
  if (isArchivedTitle(session?.title)) return true
  return session?.time?.archived != null
}

function unwrap(result: any): any[] | undefined {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.data)) return result.data
  if (Array.isArray(result?.data?.data)) return result.data.data
  return undefined
}

// Session decorations. Other TUI plugins annotate session rows by dropping one
// JSON file each into a shared directory. The sidebar merges them all and draws
// a dot before the title and a label after it. No import between plugins, only
// this contract.
//
//   directory  ~/.local/share/opencode/sidebar/decorations/
//              override the parent with OPENCODE_SIDEBAR_DIR
//   file       <plugin-id>.json, one per contributing plugin
//   shape      { "sessions": { "<sessionID>": {
//                  "dot":   { "color": "red", "title": "Recording" },
//                  "label": "REC"
//              } } }
type Decoration = {
  dot?: { color?: string; title?: string }
  label?: string
}

function sidebarDir(): string {
  return (
    process.env.OPENCODE_SIDEBAR_DIR ||
    join(homedir(), ".local", "share", "opencode", "sidebar")
  )
}

// Temporary tracing for the todo panel. Remove once the panel is confirmed.
function trace(message: string) {
  try {
    const base = sidebarDir()
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, "todos-debug.log"), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

function readDecorations(): Record<string, Decoration> {
  try {
    const base =
      process.env.OPENCODE_SIDEBAR_DIR ||
      join(homedir(), ".local", "share", "opencode", "sidebar")
    const dir = join(base, "decorations")
    const merged: Record<string, Decoration> = {}
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"))
        const sessions = parsed?.sessions
        if (sessions && typeof sessions === "object") {
          for (const [sid, dec] of Object.entries(sessions)) {
            merged[sid] = { ...(merged[sid] ?? {}), ...(dec as Decoration) }
          }
        }
      } catch {
        // Skip a malformed file, keep the rest.
      }
    }
    return merged
  } catch {
    return {}
  }
}

// Todos come from the latest todowrite tool part in the session messages. The
// tool input holds the whole list, so the last call wins and an empty list
// clears the panel.
// Returns null when the transcript holds no todowrite call at all, so an empty
// array always means the agent cleared the list.
function todosFromMessages(messages: any[]): any[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j]
      if (part?.type !== "tool" || part?.name !== "todowrite") continue
      const todos = part.state?.input?.todos ?? part.state?.metadata?.todos
      if (Array.isArray(todos)) return todos
    }
  }
  return null
}

function readTodos(context: any, sessionID?: string): any[] | null {
  if (!sessionID) return null
  try {
    return todosFromMessages(context.data.session.message.list?.(sessionID) ?? [])
  } catch {
    return null
  }
}

const TODO_ICON: Record<string, string> = {
  pending: "[ ]",
  in_progress: "[•]",
  completed: "[✓]",
  cancelled: "[-]",
}

function TodoPanel(props: {
  context: any
  sessionID?: string
  revision: () => void
}) {
  const context = props.context
  const [todos, setTodos] = createSignal<any[]>([])
  let ticket = 0
  let fetchedAt = 0

  // The sidebar tells us the open session. On the home screen it does not, so
  // fall back to the route.
  const session = () => {
    if (props.sessionID) return props.sessionID
    const route = context.ui.router.current?.()
    return route?.type === "session" ? route.sessionID : undefined
  }

  let shown: string | undefined
  const load = (sessionID?: string) => {
    const current = ++ticket
    if (sessionID !== shown) {
      shown = sessionID
      setTodos([])
    }
    if (!sessionID) return
    // The client store empties and refills while a session streams, so only a
    // real todowrite call may change what is on screen.
    const cached = readTodos(context, sessionID)
    if (cached) {
      if (cached.length) trace(`panel ${sessionID} store=${cached.length}`)
      setTodos(cached)
      return
    }
    if (Date.now() - fetchedAt < 30_000) return
    fetchedAt = Date.now()
    try {
      void context.client.message
        .list({ sessionID, limit: 200, order: "desc" })
        .then((res: any) => {
          if (current !== ticket) return
          const page = unwrap(res) ?? res?.data ?? []
          const found = todosFromMessages([...page].reverse())
          trace(`panel ${sessionID} api page=${page.length} found=${found?.length ?? "none"}`)
          if (found) setTodos(found)
        })
        .catch((err: any) => {
          trace(`panel ${sessionID} api error ${err?.message ?? err}`)
        })
    } catch (err: any) {
      trace(`panel ${sessionID} api threw ${err?.message ?? err}`)
    }
  }

  createEffect(on(() => [session(), props.revision()] as const, ([sessionID]) => load(sessionID)))

  const writeClipboard = (text: string) => {
    if (process.platform === "darwin") {
      execSync("pbcopy", { input: text })
      return
    }
    // Other platforms go through the terminal's OSC 52 support.
    context.renderer?.copyToClipboardOSC52?.(text)
  }

  // Clicking an item drafts the prompt for it into the composer without sending.
  // The TUI gives plugins no way to write the composer, so the text goes through
  // the clipboard and the built-in paste command, then the clipboard is restored.
  const draft = (content: string) => {
    const text = `Start "${content}" and mark it in progress.`
    let previous: string | undefined
    try {
      if (process.platform === "darwin") previous = execSync("pbpaste", { encoding: "utf8" })
      writeClipboard(text)
      context.keymap?.dispatch("prompt.paste")
      trace(`draft ${content.slice(0, 40)}`)
    } catch (err: any) {
      trace(`draft error ${err?.message ?? err}`)
      context.ui?.toast?.show({ message: "Could not draft the todo prompt", variant: "error" })
      return
    }
    if (previous === undefined) return
    setTimeout(() => {
      try {
        execSync("pbcopy", { input: previous })
      } catch {}
    }, 400)
  }

  const done = () => todos().filter((t) => t.status === "completed").length
  const color = (status: string) => {
    if (status === "in_progress")
      return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base
    if (status === "cancelled" || status === "completed") return context.theme.text.faint
    return context.theme.text.muted
  }

  return (
    <Show when={todos().length > 0}>
      <box flexDirection="column" gap={0} paddingRight={1}>
        <box flexDirection="row" gap={1}>
          <text selectable={false} fg={context.theme.text.base} attributes={1}>
            Todos
          </text>
          <text selectable={false} fg={context.theme.text.faint}>{`${done()}/${todos().length}`}</text>
        </box>
        <For each={todos()}>
          {(todo) => (
            <box flexDirection="row" gap={1}>
              <text selectable={false} fg={color(todo.status)} flexShrink={0}>
                {TODO_ICON[todo.status] ?? "[ ]"}
              </text>
              <text selectable={false}
                fg={color(todo.status)}
                attributes={todo.status === "cancelled" ? 128 : 0}
                wrapMode="word"
                flexGrow={1}
                minWidth={0}
                onMouseUp={() => {
                  if (todo.status === "completed" || todo.status === "cancelled") return
                  draft(todo.content)
                }}
              >
                {todo.content}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

function groupSessions(
  sessions: any[],
  projects: any[],
  showArchived: boolean,
  order: Record<string, string[]>,
): { key: string; label: string; dir?: string; rows: any[] }[] {
  const byId = new Map<string, any>(projects.map((p) => [p.id, p]))
  const archivedProjects = new Set(
    projects.filter((p) => isArchivedTitle(p.name)).map((p) => p.id),
  )

  const groups = new Map<string, { key: string; label: string; dir?: string; rows: any[] }>()
  // Seed a group for every project, even if it has no sessions.
  for (const p of projects) {
    const dir = projectDir(p)
    if (!dir || dir === "/") continue // skip the filesystem-root pseudo-project
    if (!showArchived && archivedProjects.has(p.id)) continue
    const label = p.name || basename(dir) || dir
    groups.set(p.id, { key: p.id, label, dir, rows: [] })
  }
  for (const s of sessions) {
    if (s.parentID) continue // root sessions only
    if (!showArchived && isArchived(s)) continue
    if (!showArchived && s.projectID && archivedProjects.has(s.projectID)) continue
    const dir = s.location?.directory ?? s.directory
    const project = byId.get(s.projectID)
    const label =
      project?.name ||
      basename(projectDir(project)) ||
      basename(dir) ||
      `Project ${String(s.projectID ?? "unknown").slice(0, 8)}`
    const key = s.projectID || dir || "unknown"
    let group = groups.get(key)
    if (!group) {
      group = { key, label: label || "Unknown", dir: projectDir(project) || dir, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(s)
  }

  const out = [...groups.values()]
  for (const g of out) {
    const ranked = order[g.dir || g.key] ?? []
    const rank = new Map(ranked.map((id, index) => [id, index]))
    g.rows.sort((a, b) => {
      const ra = rank.get(a.id)
      const rb = rank.get(b.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      // Sessions that are not in the manual order yet are new, so keep them on top.
      if (ra !== undefined) return 1
      if (rb !== undefined) return -1
      return (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
    })
  }
  // Projects are sorted alphabetically; sessions within each keep their manual order.
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

function SessionRow(props: {
  context: any
  session: any
  frame: () => number
  working: () => Record<string, boolean>
  eventKind?: string
  unread?: boolean
  current?: boolean
  decoration?: Decoration
  localUnread?: boolean
  onOpen?: () => void
  onOpenMenu?: (state: {
    session: any
    x: number
    y: number
    archived: boolean
    unread: boolean
  }) => void
  onDragStart?: (event: any) => void
  drop?: boolean
  dragging?: boolean
  childMap?: () => Map<string, any[]>
}) {
  const context = props.context
  const dotColor = () =>
    props.decoration?.dot?.color ??
    context.theme.hue?.red?.[200] ??
    context.theme.text.feedback?.error?.base ??
    "red"
  const status = createMemo(() => context.data.session.status?.(props.session.id))
  const busy = () => status() === "running" || props.working()[props.session.id] === true
  const retry = () => status() === "retry"

  // Blocked states come from the session data: permission -> "!", question form -> "?".
  // Returns "none" when the store is authoritative and empty (so stale event kinds are ignored).
  const kind = createMemo(() => {
    const id = props.session.id
    let known = false
    try {
      const perms = context.data.session.permission?.list?.(id)
      if (Array.isArray(perms)) {
        known = true
        if (perms.length > 0) return "!"
      }
    } catch {}
    try {
      const forms = context.data.session.form?.list?.(id, context.location)
      if (Array.isArray(forms)) {
        known = true
        if (forms.length > 0) {
          return forms.some((f: any) => f?.metadata?.kind === "question") ? "?" : "!"
        }
      }
    } catch {}
    return known ? "none" : undefined
  })

  const activeKind = () => {
    const dataKind = kind()
    if (dataKind === "none") return undefined
    return dataKind ?? props.eventKind
  }

  // Subagents (descendant sessions) or running shells mean background work.
  const hasBackground = createMemo(() => {
    const map = props.childMap?.()
    if (map) {
      const stack = [...(map.get(props.session.id) ?? [])]
      while (stack.length > 0) {
        const child = stack.pop()
        if (context.data.session.status?.(child.id) === "running") return true
        const kids = map.get(child.id)
        if (kids) stack.push(...kids)
      }
    }
    try {
      const shells = context.data.shell?.listBySession?.(props.session.id) ?? []
      if (Array.isArray(shells) && shells.some((sh: any) => sh?.status === "running")) {
        return true
      }
    } catch {}
    return false
  })

  const icon = () => {
    if (activeKind() === "!") return "!"
    if (activeKind() === "?") return "?"
    if (busy()) return SPINNER[props.frame() % SPINNER.length]
    if (hasBackground()) return BACKGROUND[Math.floor(props.frame() / 5) % BACKGROUND.length]
    if (retry()) return "!"
    if (props.unread) return "●"
    return " "
  }
  // Colours match the TUI: attention (! / ?) = hue.accent[200], working = hue.orange[200].
  const iconColor = () => {
    if (activeKind() === "?" || activeKind() === "!")
      return context.theme.hue?.accent?.[200] ?? context.theme.text.feedback?.info?.base
    if (busy()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base
    if (hasBackground()) {
      if (active()) return activeColor()
      if (props.unread) return context.theme.hue?.purple?.[200] ?? context.theme.text.feedback?.info?.base
      if (retry()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base
      return context.theme.text.muted
    }
    if (retry()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base
    if (props.unread) return context.theme.hue?.purple?.[200] ?? context.theme.text.feedback?.info?.base
    return context.theme.text.muted
  }
  const active = () => props.current === true
  const rowBg = () =>
    active()
      ? context.theme.background?.action?.primary?.selected ??
        context.theme.background?.action?.primary?.focused ??
        context.theme.background?.element
      : undefined
  const activeColor = () =>
    context.theme.text?.action?.primary?.selected ??
    context.theme.text?.action?.primary?.focused ??
    context.theme.text.base

  const titleColor = () => {
    if (active()) return activeColor()
    if (props.unread) {
      return context.theme.hue?.purple?.[200] ?? context.theme.text.feedback?.info?.base
    }
    return context.theme.text.muted
  }

  return (
    <box
      flexDirection="row"
      gap={1}
      paddingRight={1}
      backgroundColor={
        props.dragging
          ? context.theme.background?.action?.primary?.selected ??
            context.theme.background?.element
          : props.drop
            ? context.theme.background?.action?.primary?.hovered ??
              context.theme.background?.element
            : rowBg()
      }
      onMouseDown={(e: any) => props.onDragStart?.(e)}
      onMouseUp={(e: any) => {
        if (e?.button === 2) {
          e.preventDefault?.()
          e.stopPropagation?.()
          props.onOpenMenu?.({
            session: props.session,
            x: e.x ?? 0,
            y: e.y ?? 0,
            archived: isArchived(props.session),
            unread: props.localUnread === true,
          })
          return
        }
        if (e?.button !== 0) return
        props.onOpen?.()
      }}
    >
      <text selectable={false} fg={iconColor()} flexShrink={0}>
        {icon()}
      </text>
      <Show when={props.decoration?.dot}>
        <text selectable={false} fg={dotColor()} flexShrink={0}>
          {"●"}
        </text>
      </Show>
      <Show when={props.decoration?.label}>
        <text selectable={false} fg={context.theme.text.muted} flexShrink={0}>
          {props.decoration?.label}
        </text>
      </Show>
      <text selectable={false}
        fg={titleColor()}
        attributes={active() ? 1 : 0}
        wrapMode="none"
        truncate
        flexGrow={1}
        minWidth={0}
      >
        {displayTitle(props.session)}
      </text>
    </box>
  )
}

type SessionMenuState = {
  session: any
  x: number
  y: number
  archived: boolean
  unread: boolean
}

type SessionMoveRequest = {
  sessionID: string
  sourceKey: string
  targetKey: string
  sourceDir?: string
  targetDir?: string
  sourceOrder: string[]
  targetOrder: string[]
}

// Right-click menu for a session row. The renderer reports the secondary button
// as 2 and the click position in screen cells.
function SessionContextMenu(props: {
  context: any
  state: SessionMenuState
  onClose: () => void
  onArchive: (sessionID: string) => void
  onUnread: (sessionID: string) => void
  onMove: (sessionID: string) => void
}) {
  const context = props.context
  const [selected, setSelected] = createSignal(0)
  const width = 20
  const items = () => [
    {
      label: props.state.archived ? "Unarchive" : "Archive",
      run: () => props.onArchive(props.state.session.id),
    },
    {
      label: props.state.unread ? "Mark read" : "Mark unread",
      run: () => props.onUnread(props.state.session.id),
    },
    {
      label: "Move to...",
      run: () => props.onMove(props.state.session.id),
    },
  ]
  const dims = () => ({
    width: context.renderer?.width ?? 80,
    height: context.renderer?.height ?? 24,
  })
  const left = () => Math.max(0, Math.min(props.state.x, dims().width - width))
  const top = () =>
    Math.max(0, Math.min(props.state.y + 1, dims().height - 1 - items().length))
  const runSelected = () => {
    const item = items()[selected()]
    props.onClose()
    item?.run()
  }

  try {
    const pop = context.keymap?.mode?.push?.("menu")
    if (pop) onCleanup(pop)
  } catch {}
  try {
    context.keymap?.layer?.(() => ({
      mode: "menu",
      commands: [
        { bind: "escape,ctrl+c", title: "Close session menu", run: () => props.onClose() },
        {
          bind: "up",
          title: "Previous menu item",
          run: () => setSelected((index) => (index - 1 + items().length) % items().length),
        },
        {
          bind: "down",
          title: "Next menu item",
          run: () => setSelected((index) => (index + 1) % items().length),
        },
        { bind: "return", title: "Run menu item", run: runSelected },
      ],
    }))
  } catch {}

  const background = context.theme.background?.raised?.high ?? context.theme.background?.element
  const hovered = context.theme.background?.action?.primary?.hovered ?? background

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={2600}
      onMouseDown={(e: any) => {
        e?.preventDefault?.()
        e?.stopPropagation?.()
        props.onClose()
      }}
    >
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={width}
        height={items().length}
        flexDirection="column"
        backgroundColor={background}
        onMouseDown={(e: any) => {
          e?.preventDefault?.()
          e?.stopPropagation?.()
        }}
      >
        <For each={items()}>
          {(item, index) => (
            <box
              height={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={index() === selected() ? hovered : background}
              onMouseOver={() => setSelected(index())}
              onMouseUp={(e: any) => {
                e?.preventDefault?.()
                e?.stopPropagation?.()
                if (e?.button !== 0) return
                props.onClose()
                item.run()
              }}
            >
              <text selectable={false} fg={context.theme.text.base} wrapMode="none" truncate>
                {item.label}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

type ProjectMenuState = { project: any; x: number; y: number }

function ProjectContextMenu(props: {
  context: any
  state: ProjectMenuState
  onClose: () => void
  onToggle: () => void
}) {
  const context = props.context
  const width = 20
  const label = () =>
    isArchivedTitle(props.state.project?.name) ? "Unarchive project" : "Archive project"
  const dims = () => ({
    width: context.renderer?.width ?? 80,
    height: context.renderer?.height ?? 24,
  })
  const left = () => Math.max(0, Math.min(props.state.x, dims().width - width))
  const top = () => Math.max(0, Math.min(props.state.y + 1, dims().height - 2))
  const run = () => {
    props.onClose()
    props.onToggle()
  }

  try {
    const pop = context.keymap?.mode?.push?.("menu")
    if (pop) onCleanup(pop)
  } catch {}
  try {
    context.keymap?.layer?.(() => ({
      mode: "menu",
      commands: [
        { bind: "escape,ctrl+c", title: "Close project menu", run: () => props.onClose() },
        { bind: "return", title: "Run project menu item", run },
      ],
    }))
  } catch {}

  const background = context.theme.background?.raised?.high ?? context.theme.background?.element
  const hovered = context.theme.background?.action?.primary?.hovered ?? background

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={2600}
      onMouseDown={(e: any) => {
        e?.preventDefault?.()
        e?.stopPropagation?.()
        props.onClose()
      }}
    >
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={width}
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={hovered}
        onMouseDown={(e: any) => {
          e?.preventDefault?.()
          e?.stopPropagation?.()
        }}
        onMouseUp={(e: any) => {
          e?.preventDefault?.()
          e?.stopPropagation?.()
          if (e?.button !== 0) return
          run()
        }}
      >
        <text selectable={false} fg={context.theme.text.base} wrapMode="none" truncate>
          {label()}
        </text>
      </box>
    </box>
  )
}

function SessionsByProject(props: {
  context: any
  sessionID?: string
  sessions: () => any[]
  revision: () => void
  projects: () => any[]
  working: () => Record<string, boolean>
  kinds: () => Record<string, string>
  collapsed: () => Record<string, boolean>
  toggle: (key: string) => void
  showArchived: () => boolean
  toggleArchived: () => void
  createSession: (dir?: string) => void
  newProject: () => void
  openMenu: (state: SessionMenuState) => void
  openProjectMenu: (project: any, x: number, y: number) => void
  unreadLocal: () => Record<string, boolean>
  toggleUnread: (id: string) => void
  order: () => Record<string, string[]>
  onDrop: (request: SessionMoveRequest) => void
  decorations: () => Record<string, Decoration>
}) {
  const context = props.context
  const groups = createMemo(() =>
    groupSessions(props.sessions(), props.projects(), props.showArchived(), props.order()),
  )

  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 90)
  onCleanup(() => clearInterval(timer))

  const tabs = createMemo(() => {
    const list = context.ui.tabs?.list?.() ?? []
    return new Map<string, any>(list.map((t: any) => [t.sessionID, t]))
  })

  const childMap = createMemo(() => {
    const map = new Map<string, any[]>()
    for (const s of props.sessions()) {
      if (!s.parentID) continue
      const arr = map.get(s.parentID) ?? []
      arr.push(s)
      map.set(s.parentID, arr)
    }
    return map
  })

  const [dropTarget, setDropTarget] = createSignal<{
    groupKey: string
    index: number
    group: boolean
  }>()
  const [preview, setPreview] = createSignal<{
    sessionID: string
    sourceKey: string
    targetKey: string
    targetIndex: number
  }>()
  const [dragActive, setDragActive] = createSignal(false)
  let drag:
    | {
        sessionID: string
        sourceKey: string
        sourceIndex: number
        contentTop: number
        target?: { group: any; index: number; groupTarget: boolean }
      }
    | undefined
  let suppressOpenUntil = 0

  // One entry per rendered line, so a drag can map the pointer row to a group
  // and an insertion index. Relative line numbers are enough because the source
  // row's screen position anchors the map.
  const layout = () => {
    const entries: Array<{
      type: "group" | "row"
      group: any
      row?: any
      index: number
      line: number
    }> = []
    let line = 0
    for (const group of groups()) {
      entries.push({ type: "group", group, index: 0, line })
      let end = line
      if (props.collapsed()[group.key] !== true) {
        group.rows.forEach((row: any, index: number) => {
          end += 1
          entries.push({ type: "row", group, row, index, line: end })
        })
      }
      line = end + 2
    }
    return entries
  }

  // Rows to render for a group. While dragging, the affected groups show the
  // dragged session at the pointer position so the list updates live.
  const rowsFor = (group: any) => {
    const p = preview()
    if (!p) return group.rows
    if (group.key !== p.sourceKey && group.key !== p.targetKey) return group.rows
    const source = groups().find((item) => item.key === p.sourceKey)
    const session = source?.rows.find((row: any) => row.id === p.sessionID)
    if (!session) return group.rows
    if (group.key === p.sourceKey && group.key === p.targetKey) {
      const from = group.rows.findIndex((row: any) => row.id === p.sessionID)
      const rows = group.rows.filter((row: any) => row.id !== p.sessionID)
      let insert = p.targetIndex
      if (from !== -1 && from < p.targetIndex) insert -= 1
      insert = Math.max(0, Math.min(insert, rows.length))
      rows.splice(insert, 0, session)
      return rows
    }
    if (group.key === p.sourceKey) {
      return group.rows.filter((row: any) => row.id !== p.sessionID)
    }
    const rows = [...group.rows]
    const insert = Math.max(0, Math.min(p.targetIndex, rows.length))
    rows.splice(insert, 0, session)
    return rows
  }

  const beginDrag = (session: any, group: any, event: any) => {
    if (event?.button !== 0) return
    const entry = layout().find((item) => item.type === "row" && item.row.id === session.id)
    if (!entry) return
    drag = {
      sessionID: session.id,
      sourceKey: group.key,
      sourceIndex: entry.index,
      contentTop: event.y - entry.line,
      target: undefined,
    }
  }

  const updateDrag = (event: any) => {
    if (!drag) return
    const entries = layout()
    if (!entries.length) return
    const line = event.y - drag.contentTop
    let target: { group: any; index: number; groupTarget: boolean }
    if (line <= entries[0].line) {
      target = { group: entries[0].group, index: 0, groupTarget: true }
    } else {
      const next = entries.find((item) => item.line >= line)
      if (!next) {
        const last = entries[entries.length - 1]
        target = {
          group: last.group,
          index: last.type === "row" ? last.group.rows.length : 0,
          groupTarget: false,
        }
      } else if (next.type === "group") {
        target = { group: next.group, index: 0, groupTarget: true }
      } else {
        target = { group: next.group, index: next.index, groupTarget: false }
      }
    }
    drag.target = target
    setDropTarget({
      groupKey: target.group.key,
      index: target.index,
      group: target.groupTarget,
    })
    setPreview({
      sessionID: drag.sessionID,
      sourceKey: drag.sourceKey,
      targetKey: target.group.key,
      targetIndex: target.index,
    })
    setDragActive(true)
  }

  const endDrag = () => {
    const current = drag
    drag = undefined
    setDropTarget(undefined)
    setPreview(undefined)
    setDragActive(false)
    if (!current || !current.target) return
    suppressOpenUntil = Date.now() + 300
    const source = groups().find((group) => group.key === current.sourceKey)
    const target = current.target.group
    if (!source) return
    if (source.key === target.key && current.target.index === current.sourceIndex) return
    if (props.collapsed()[target.key] === true) props.toggle(target.key)

    const fullOrder = (group: any) => {
      const key = group.dir || group.key
      const known = [...(props.order()[key] ?? [])]
      const seen = new Set(known)
      const missing = group.rows
        .map((row: any) => row.id)
        .filter((id: string) => !seen.has(id))
      return [...missing, ...known]
    }

    const sessionID = current.sessionID
    const sourceOrder = fullOrder(source).filter((id: string) => id !== sessionID)
    let targetOrder =
      source.key === target.key
        ? sourceOrder
        : fullOrder(target).filter((id: string) => id !== sessionID)
    const anchor =
      current.target.index < target.rows.length
        ? target.rows[current.target.index].id
        : undefined
    if (anchor === sessionID) return
    if (anchor) {
      const at = targetOrder.indexOf(anchor)
      targetOrder.splice(at === -1 ? targetOrder.length : at, 0, sessionID)
    } else {
      const last = target.rows[target.rows.length - 1]?.id
      const at = last ? targetOrder.indexOf(last) + 1 : 0
      targetOrder.splice(
        at < 0 || at > targetOrder.length ? targetOrder.length : at,
        0,
        sessionID,
      )
    }
    props.onDrop({
      sessionID,
      sourceKey: source.dir || source.key,
      targetKey: target.dir || target.key,
      sourceDir: source.dir,
      targetDir: target.dir,
      sourceOrder,
      targetOrder,
    })
  }

  const openSession = (session: any) => {
    if (drag?.target) return
    if (Date.now() < suppressOpenUntil) {
      suppressOpenUntil = 0
      return
    }
    if (props.unreadLocal()[session.id]) props.toggleUnread(session.id)
    context.ui.router.navigate({ type: "session", sessionID: session.id })
  }

  return (
    <box
      flexDirection="column"
      paddingTop={1}
      gap={1}
      onMouseDrag={(event: any) => updateDrag(event)}
      onMouseUp={() => endDrag()}
    >
      <TodoPanel
        context={context}
        sessionID={props.sessionID}
        revision={props.revision}
      />
      <box flexDirection="row" paddingRight={1}>
        <text selectable={false}
          fg={context.theme.text.base}
          attributes={1}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          Jump to session
        </text>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text selectable={false}
            fg={
              props.showArchived()
                ? context.theme.hue?.orange?.[200] ?? context.theme.text.base
                : context.theme.text.muted
            }
            onMouseUp={() => props.toggleArchived()}
          >
            ≡
          </text>
          <text selectable={false}
            fg={context.theme.text.muted}
            onMouseUp={() => props.newProject()}
          >
            +
          </text>
        </box>
      </box>
      <For each={groups()}>
        {(group) => {
          const isCollapsed = () => props.collapsed()[group.key] === true
          return (
            <box flexDirection="column">
              <box
                flexDirection="row"
                gap={1}
                paddingRight={1}
                backgroundColor={
                  dropTarget()?.groupKey === group.key && dropTarget()?.group
                    ? context.theme.background?.action?.primary?.hovered ??
                      context.theme.background?.element
                    : undefined
                }
                onMouseUp={(e: any) => {
                  if (e?.button !== 2) return
                  e.preventDefault?.()
                  e.stopPropagation?.()
                  const project = props.projects().find((p) => p.id === group.key)
                  if (project) props.openProjectMenu(project, e.x ?? 0, e.y ?? 0)
                }}
              >
                <box
                  flexDirection="row"
                  gap={1}
                  flexGrow={1}
                  minWidth={0}
                  onMouseUp={(e: any) => {
                    if (e?.button !== 0) return
                    if (Date.now() < suppressOpenUntil) return
                    props.toggle(group.key)
                  }}
                >
                  <text selectable={false} fg={context.theme.text.muted} flexShrink={0}>
                    {isCollapsed() ? "▶" : "▼"}
                  </text>
                  <text selectable={false}
                    fg={context.theme.text.base}
                    wrapMode="none"
                    truncate
                    flexGrow={1}
                    minWidth={0}
                  >
                    {`${group.label} (${rowsFor(group).length})`}
                  </text>
                </box>
                <text selectable={false}
                  fg={context.theme.text.base}
                  flexShrink={0}
                  onMouseUp={(e: any) => {
                    if (e?.button !== 0) return
                    if (Date.now() < suppressOpenUntil) return
                    e.stopPropagation?.()
                    props.createSession(group.dir)
                  }}
                >
                  +
                </text>
              </box>
              <Show when={!isCollapsed()}>
                <For each={rowsFor(group)}>
                  {(session: any, index) => (
                    <SessionRow
                      context={context}
                      session={session}
                      frame={frame}
                      working={props.working}
                      eventKind={props.kinds()[session.id]}
                      unread={
                        Boolean(tabs().get(session.id)?.unread) ||
                        props.unreadLocal()[session.id] === true
                      }
                      current={session.id === props.sessionID}
                      decoration={props.decorations()[session.id]}
                      onOpenMenu={props.openMenu}
                      onOpen={() => openSession(session)}
                      onDragStart={(event: any) => beginDrag(session, group, event)}
                      dragging={preview()?.sessionID === session.id}
                      drop={
                        dropTarget()?.groupKey === group.key &&
                        !dropTarget()?.group &&
                        dropTarget()?.index === index()
                      }
                      localUnread={props.unreadLocal()[session.id] === true}
                      childMap={childMap}
                    />
                  )}
                </For>
              </Show>
            </box>
          )
        }}
      </For>
      <Show when={dragActive()}>
        <Portal
          ref={(container: any) => {
            if (!container) return
            container.position = "absolute"
            container.left = 0
            container.top = 0
            container.zIndex = 2600
          }}
        >
          <box
            position="absolute"
            left={0}
            top={0}
            width="100%"
            height="100%"
            zIndex={2600}
            onMouseDrag={(event: any) => updateDrag(event)}
            onMouseDragEnd={() => endDrag()}
            onMouseUp={() => endDrag()}
          />
        </Portal>
      </Show>
    </box>
  )
}

// Shows the same panel on the home / new-session screen, as a right overlay.
// Compact MCP connection indicator for the prompt footer, so it stays visible
// after the sidebar's built-in MCP section is replaced.
function McpStatus(props: { context: any }) {
  const context = props.context
  const servers = createMemo(
    () => context.data?.location?.mcp?.server?.list?.(context.location) ?? [],
  )
  const failed = () => servers().filter((s: any) => s?.status?.status === "failed")
  const connected = () => servers().filter((s: any) => s?.status?.status === "connected")

  return (
    <Show when={servers().length > 0}>
      <text selectable={false}
        fg={
          failed().length > 0
            ? context.theme.text.feedback?.error?.base ?? context.theme.text.base
            : connected().length > 0
              ? context.theme.text.feedback?.success?.base ?? context.theme.text.muted
              : context.theme.text.muted
        }
        onMouseUp={() => context.keymap?.dispatch?.("mcp.list")}
      >
        {failed().length > 0
          ? `MCP ${failed().length} failed`
          : `MCP ${connected().length}`}
      </text>
    </Show>
  )
}

function HomeSidebar(props: { context: any; children?: any }) {
  const context = props.context
  const route = createMemo(() => context.ui.router.current())
  const readWidth = () =>
    context.renderer?.width ?? context.renderer?.size?.width ?? (globalThis as any)?.process?.stdout?.columns ?? 0
  const [width, setWidth] = createSignal<number>(readWidth() || 0)
  const timer = setInterval(() => {
    const next = readWidth()
    if (next && next !== width()) setWidth(next)
  }, 500)
  onCleanup(() => clearInterval(timer))

  return (
    <Show when={route()?.type === "home" && width() >= 120}>
      <box
        position="absolute"
        top={1}
        right={0}
        bottom={0}
        width={44}
        backgroundColor={
          context.theme.background?.raised?.base ?? context.theme.background?.element
        }
        paddingLeft={1}
        paddingRight={1}
      >
        <scrollbox
          flexGrow={1}
          minHeight={0}
          width="100%"
          verticalScrollbarOptions={{ visible: true }}
        >
          {props.children}
        </scrollbox>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "jump-sidebar",
  setup(context: any) {
    trace("setup")
    trace(`keys ctx=${Object.keys(context).join(",")}`)
    trace(`keys ui=${Object.keys(context.ui ?? {}).join(",")}`)
    trace(`keys data=${Object.keys(context.data ?? {}).join(",")}`)
    trace(`keys app=${Object.keys(context.app ?? {}).join(",")}`)
    trace(`keys renderer=${Object.keys(context.renderer ?? {}).join(",")}`)
    const cb = context.renderer?.clipboard
    trace(`clipboard proto=${Object.getOwnPropertyNames(Object.getPrototypeOf(cb ?? {})).join(",")}`)
    const rp = context.renderer
    trace(`renderer proto=${Object.getOwnPropertyNames(Object.getPrototypeOf(rp ?? {})).filter((k) => /clip|copy|paste/i.test(k)).join(",")}`)
    try {
      trace(`prompt commands=${(context.keymap?.commands?.() ?? []).map((c: any) => c.id).filter((id: string) => id.startsWith("prompt")).join(",")}`)
    } catch (err: any) {
      trace(`keymap error ${err?.message ?? err}`)
    }
    const [sessions, setSessions] = createSignal<any[]>([])
    const [projects, setProjects] = createSignal<any[]>([])
    // Bumped on every refresh so the todo panel recomputes from the message store.
    const [revision, setRevision] = createSignal(0)
    const [working, setWorking] = createSignal<Record<string, boolean>>({})
    const [kinds, setKinds] = createSignal<Record<string, string>>({})
    const [decorations, setDecorations] = createSignal<Record<string, Decoration>>({})
    const setWork = (id: string, on: boolean) =>
      setWorking((prev) => (prev[id] === on ? prev : { ...prev, [id]: on }))
    const setKind = (id: string, kind?: string) =>
      setKinds((prev) => {
        if (kind === undefined) {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        }
        return prev[id] === kind ? prev : { ...prev, [id]: kind }
      })
    // Optimistically move a session to the top when it becomes active.
    const bump = (id: string) =>
      setSessions((prev) =>
        prev.some((s) => s.id === id)
          ? prev.map((s) =>
              s.id === id ? { ...s, time: { ...(s.time ?? {}), updated: Date.now() } } : s,
            )
          : prev,
      )

    let refetchTimer: any
    const load = async () => {
      setDecorations(readDecorations())
      try {
        // Bust the client's cached project list so deletions are picked up.
        try {
          context.data.project.invalidate?.()
        } catch {}

        const freshProjects = unwrap(await context.client.project.list()) ?? []
        const storeProjects = context.data.project.list?.() ?? []
        const storeById = new Map<string, any>(storeProjects.map((p: any) => [p.id, p]))
        // The fresh fetch is authoritative; the store only fills missing fields.
        // (Never add store-only projects — that resurrects deleted ones.)
        const projects = freshProjects.length
          ? freshProjects.map((p: any) => {
              const s = storeById.get(p.id)
              if (!s) return p
              return {
                ...s,
                ...p,
                name: p.name ?? s.name,
                worktree: p.worktree ?? p.canonical ?? s.worktree ?? s.canonical,
              }
            })
          : storeProjects
        if (projects.length) setProjects(projects)

        // Do not pass `archived` here. OpenCode treats it strictly as a filter
        // (true = only archived, false = only live), so either value hides half
        // the sessions. Omitting it returns every session, archived included.
        const requests: Promise<any>[] = [
          context.client.session
            .list({ limit: 1000 })
            .then(unwrap)
            .catch(() => [] as any[]),
          ...projects.map((project: any) =>
            context.client.session
              .list({ directory: projectDir(project), limit: 1000 })
              .then(unwrap)
              .catch(() => [] as any[]),
          ),
        ]
        const lists = await Promise.all(requests)

        const seen = new Set<string>()
        const all: any[] = []
        for (const list of lists) {
          for (const s of list ?? []) {
            if (seen.has(s.id)) continue
            seen.add(s.id)
            all.push(s)
          }
        }
        // Only fall back to the cached store if the client returned nothing.
        if (!all.length) for (const s of context.data.session.list?.() ?? []) all.push(s)
        if (all.length) setSessions(all)

        // Reconcile blocked states so stale "!"/"?" clear (e.g. after sleep).
        for (const s of all) {
          if (s.parentID) continue
          const t = s.time ?? {}
          // An idle session can't be blocked: drop any stale event kind.
          if ((t.idle ?? 0) > 0 && (t.idle ?? 0) >= (t.updated ?? 0)) setKind(s.id, undefined)
          try {
            const perms = context.data.session.permission?.list?.(s.id)
            const forms = context.data.session.form?.list?.(s.id, context.location)
            if ((Array.isArray(perms) && perms.length) || (Array.isArray(forms) && forms.length)) {
              context.data.session.permission?.sync?.(s.id)
              context.data.session.form?.sync?.(s.id, context.location)
            }
          } catch {}
        }
      } catch {
        const sd = context.data.session.list?.() ?? []
        const pd = context.data.project.list?.() ?? []
        if (sd.length) setSessions(sd)
        if (pd.length) setProjects(pd)
      }
      setRevision((n) => n + 1)
    }
    const schedule = () => {
      clearTimeout(refetchTimer)
      refetchTimer = setTimeout(() => void load(), 250)
    }

    const on = (type: string, fn: (e: any) => void) => {
      try {
        return context.data.on(type, fn)
      } catch {
        return undefined
      }
    }

    void load()
    // Safety net: keep titles/order fresh even if an event is missed.
    const poll = setInterval(() => void load(), 3000)

    const offs = [
      on("session.created", schedule),
      on("session.updated", schedule),
      on("session.deleted", schedule),
      on("session.moved", schedule),
      // Working state from execution events.
      on("session.execution.started", (e: any) => {
        setWork(e.data.sessionID, true)
        bump(e.data.sessionID)
        schedule()
      }),
      on("session.execution.succeeded", (e: any) => {
        setWork(e.data.sessionID, false)
        schedule()
      }),
      on("session.execution.interrupted", (e: any) => setWork(e.data.sessionID, false)),
      on("session.execution.failed", (e: any) => setWork(e.data.sessionID, false)),
      on("session.idle", (e: any) => setWork(e.data.sessionID, false)),
      // Blocked states (fallback when the data store isn't populated): permission -> "!", question -> "?".
      on("permission.asked", (e: any) => setKind(e.data.sessionID, "!")),
      on("permission.replied", (e: any) => setKind(e.data.sessionID, undefined)),
      on("form.created", (e: any) => setKind(e.data.form?.sessionID ?? e.data.sessionID, "?")),
      on("form.replied", (e: any) => setKind(e.data.sessionID, undefined)),
      on("form.cancelled", (e: any) => setKind(e.data.sessionID, undefined)),
      on("session.error", (e: any) => setKind(e.data.sessionID, "!")),
    ].filter(Boolean)

    // Broad listener: any session/message/part activity refreshes order + activity.
    let stopListen: any
    try {
      stopListen = context.data.listen?.((event: any) => {
        const details = event?.details ?? event
        const type = details?.type
        if (typeof type !== "string") return
        if (!type.startsWith("session") && !type.startsWith("message") && !type.startsWith("part"))
          return
        const sid = details?.properties?.sessionID
        if (typeof sid === "string") bump(sid)
        schedule()
      })
    } catch {
      stopListen = undefined
    }

    const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
    const toggle = (key: string) =>
      setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

    // Create a new session in a project (directory) and open it.
    // The create endpoint takes a `location` ref, not a bare `directory`.
    const createSession = async (dir?: string) => {
      try {
        const params: any = dir ? { location: { directory: dir } } : {}
        const res: any = await context.client.session.create(params)
        const created = res?.data ?? res
        const id = created?.id ?? created?.data?.id
        if (!id) {
          context.ui.toast.show({ message: "Could not create session", variant: "error" })
          return
        }
        setSessions((prev) => (prev.some((s) => s.id === id) ? prev : [created, ...prev]))
        context.ui.router.navigate({ type: "session", sessionID: id })
        schedule()
        // The title is generated shortly after the first prompt — refetch to pick it up.
        setTimeout(() => void load(), 2000)
      } catch (err: any) {
        context.ui.toast.show({
          message: `New session failed: ${err?.message ?? err}`,
          variant: "error",
        })
      }
    }

    // UI-driven project creation: prompt for a name, then create the folder and a
    // starter session (the same result as /new-project).
    const root = typeof context.options?.root === "string" && context.options.root
      ? context.options.root
      : "~/OpenCode projects"
    const expand = (p: string) =>
      p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p

    const newProject = async () => {
      let input = ""
      try {
        input = (await context.ui.dialog.prompt({
          title: "New project",
          placeholder: "Project name",
        })) ?? ""
      } catch {
        return
      }
      const name = String(input).trim()
      if (!name) return

      const rootDir = expand(root)
      const dir = isAbsolute(name) || name.startsWith("~")
        ? expand(name)
        : join(rootDir, name)

      try {
        mkdirSync(dir, { recursive: true })
      } catch (err: any) {
        context.ui.toast.show({
          message: `Could not create folder: ${err?.message ?? err}`,
          variant: "error",
        })
        return
      }

      // Reuse an existing session for this directory; never seed a second one.
      const existing = sessions().find(
        (s) => !s.parentID && (s.location?.directory ?? s.directory) === dir,
      )
      if (existing) {
        context.ui.router.navigate({ type: "session", sessionID: existing.id })
        return
      }

      try {
        const res: any = await context.client.session.create({ location: { directory: dir } })
        const created = res?.data ?? res
        const id = created?.id ?? created?.data?.id
        if (id) context.ui.router.navigate({ type: "session", sessionID: id })
        schedule()
        setTimeout(() => void load(), 2000)
      } catch (err: any) {
        context.ui.toast.show({
          message: `New project failed: ${err?.message ?? err}`,
          variant: "error",
        })
      }
    }

    // Archive/unarchive a session using the same title convention as /archive.
    const toggleArchive = async (sessionID: string) => {
      const session = sessions().find((s) => s.id === sessionID) ?? context.data.session.get?.(sessionID)
      const title = session?.title ?? ""
      const archived = isArchivedTitle(title)
      const next = archived ? toUnarchivedTitle(title) : toArchivedTitle(title)
      try {
        await context.client.session.update({ sessionID, title: next })
        schedule()
      } catch (err: any) {
        context.ui.toast.show({ message: `Archive failed: ${err?.message ?? err}`, variant: "error" })
      }
    }

    // Sessions that belong to a project, using the same key rules as the sidebar
    // grouping, and that still need archiving.
    const projectChildren = (project: any) => {
      const dir = projectDir(project)
      return sessions().filter(
        (s) =>
          !isArchived(s) &&
          (s.projectID === project.id ||
            (!s.projectID && (s.location?.directory ?? s.directory) === dir)),
      )
    }

    // Archive/unarchive a project by prefixing its name. Archiving a project also
    // archives every session in it that is not already archived.
    const toggleProjectArchive = async (project: any) => {
      const label = project?.name || basename(projectDir(project)) || projectDir(project)
      const archived = isArchivedTitle(project?.name)
      try {
        if (!archived) {
          const children = projectChildren(project)
          const ok = await context.ui.dialog.confirm({
            title: "Archive project",
            message:
              children.length > 0
                ? `Archive "${label}" and ${children.length} session${children.length === 1 ? "" : "s"}?`
                : `Archive "${label}"?`,
            label: { confirm: "Archive", cancel: "Cancel" },
          })
          if (!ok) return
          const next = toArchivedTitle(label)
          await context.client.project.update({ projectID: project.id, name: next })
          setProjects((prev) =>
            prev.map((p) => (p.id === project.id ? { ...p, name: next } : p)),
          )
          const results = await Promise.allSettled(
            children.map((s) =>
              context.client.session.update({
                sessionID: s.id,
                title: toArchivedTitle(s.title || defaultTitle(s)),
              }),
            ),
          )
          const failed = results.filter((r) => r.status === "rejected").length
          if (failed) {
            context.ui.toast.show({
              message: `${failed} session${failed === 1 ? "" : "s"} could not be archived`,
              variant: "warning",
            })
          }
          schedule()
          return
        }
        const next = toUnarchivedTitle(project?.name ?? label)
        await context.client.project.update({ projectID: project.id, name: next })
        setProjects((prev) =>
          prev.map((p) => (p.id === project.id ? { ...p, name: next } : p)),
        )
        schedule()
      } catch (err: any) {
        context.ui.toast.show({
          message: `Project archive failed: ${err?.message ?? err}`,
          variant: "error",
        })
      }
    }

    // Show/hide archived, persisted across restarts when storage is available.
    let showArchived: () => boolean
    let toggleArchived: () => void
    try {
      const [settings, update] = context.storage.store("sessions-by-project", {
        initial: { showArchived: false },
      })
      const read = () => (typeof settings === "function" ? settings() : settings)
      showArchived = () => read()?.showArchived === true
      toggleArchived = () => update((draft: any) => { draft.showArchived = !draft.showArchived })
    } catch {
      const [sig, setSig] = createSignal(false)
      showArchived = sig
      toggleArchived = () => setSig((v) => !v)
    }

    // Manual "unread" flags kept by the plugin (OpenCode has no unread setter).
    let unreadLocal: () => Record<string, boolean>
    let toggleUnread: (id: string) => void
    try {
      const [store, update] = context.storage.store("jump-sidebar.unread", { initial: {} })
      const read = () => (typeof store === "function" ? store() : store) ?? {}
      unreadLocal = read
      toggleUnread = (id) =>
        update((draft: any) => {
          if (draft[id]) delete draft[id]
          else draft[id] = true
        })
    } catch {
      const [sig, set] = createSignal<Record<string, boolean>>({})
      unreadLocal = sig
      toggleUnread = (id) =>
        set((prev) => {
          const next = { ...prev }
          if (next[id]) delete next[id]
          else next[id] = true
          return next
        })
    }

    // Manual session order, keyed by project directory. Sessions missing from a
    // list (new ones) sort above it until the next drag records them.
    let order: () => Record<string, string[]>
    let updateOrder: (fn: (draft: Record<string, string[]>) => void) => void
    try {
      const [store, update] = context.storage.store("jump-sidebar.order", { initial: {} })
      order = () => (typeof store === "function" ? store() : store) ?? {}
      updateOrder = (fn) => update(fn)
    } catch {
      const [sig, set] = createSignal<Record<string, string[]>>({})
      order = sig
      updateOrder = (fn) =>
        set((prev) => {
          const next: Record<string, string[]> = { ...prev }
          fn(next)
          return next
        })
    }

    const handleSessionDrop = async (request: SessionMoveRequest) => {
      const beforeSource = [...(order()[request.sourceKey] ?? [])]
      const beforeTarget = [...(order()[request.targetKey] ?? [])]
      updateOrder((draft) => {
        draft[request.sourceKey] = request.sourceOrder
        draft[request.targetKey] = request.targetOrder
      })
      if (!request.targetDir || request.sourceDir === request.targetDir) return
      try {
        await context.client.session.move({
          sessionID: request.sessionID,
          directory: request.targetDir,
        })
        schedule()
      } catch (err: any) {
        updateOrder((draft) => {
          draft[request.sourceKey] = beforeSource
          draft[request.targetKey] = beforeTarget
        })
        context.ui.toast.show({
          message: `Move failed: ${err?.message ?? err}`,
          variant: "error",
        })
      }
    }

    // Right-click Move to... picks a destination project and moves the session
    // there, the same operation as dragging it onto that project.
    const moveToProject = async (sessionID: string) => {
      const session =
        sessions().find((s) => s.id === sessionID) ??
        context.data.session.get?.(sessionID)
      const sourceDir = session?.location?.directory ?? session?.directory
      const options = projects()
        .filter((project) => {
          const dir = projectDir(project)
          return Boolean(dir) && dir !== sourceDir && !isArchivedTitle(project.name)
        })
        .map((project) => ({
          title: project.name || basename(projectDir(project)),
          value: project.id,
          description: projectDir(project),
        }))
      if (!options.length) {
        context.ui.toast.show({ message: "No other projects", variant: "warning" })
        return
      }
      const projectID = await context.ui.dialog.select({
        title: "Move session to",
        placeholder: "Project",
        options,
      })
      if (!projectID) return
      const project = projects().find((p) => p.id === projectID)
      const targetDir = projectDir(project)
      if (!project || !targetDir || targetDir === sourceDir) return

      const sourceKey = sourceDir ?? ""
      const targetKey = targetDir
      const beforeSource = [...(order()[sourceKey] ?? [])]
      const beforeTarget = [...(order()[targetKey] ?? [])]
      updateOrder((draft) => {
        if (sourceKey) {
          draft[sourceKey] = (draft[sourceKey] ?? []).filter((id) => id !== sessionID)
        }
        draft[targetKey] = [
          sessionID,
          ...(draft[targetKey] ?? []).filter((id) => id !== sessionID),
        ]
      })
      try {
        await context.client.session.move({ sessionID, directory: targetDir })
        schedule()
      } catch (err: any) {
        updateOrder((draft) => {
          if (sourceKey) draft[sourceKey] = beforeSource
          draft[targetKey] = beforeTarget
        })
        context.ui.toast.show({
          message: `Move failed: ${err?.message ?? err}`,
          variant: "error",
        })
      }
    }

    // Right-click menu shared by every session row. The row reports the click
    // and the state; the actions live here.
    const [sessionMenu, setSessionMenu] = createSignal<SessionMenuState>()
    const openSessionMenu = (state: SessionMenuState) => setSessionMenu(state)
    const closeSessionMenu = () => setSessionMenu(undefined)

    const [projectMenu, setProjectMenu] = createSignal<ProjectMenuState>()
    const openProjectMenu = (project: any, x: number, y: number) =>
      setProjectMenu({ project, x, y })
    const closeProjectMenu = () => setProjectMenu(undefined)

    // Session navigation history for the history keybinds. OpenCode declares
    // session.tab.history.back and session.tab.history.forward but ships no command
    // behind either one, so the plugin supplies them. The stack is in memory and
    // browser style, with a cursor that new visits truncate.
    const HISTORY_LIMIT = 100
    let historyEntries: string[] = []
    let historyIndex = -1

    const historyRoot = (sessionID: string) => {
      try {
        return context.data.session?.root?.(sessionID) ?? sessionID
      } catch {
        return sessionID
      }
    }

    const historyRecord = (sessionID: string) => {
      if (historyEntries[historyIndex] === sessionID) return
      const entries = [...historyEntries.slice(0, historyIndex + 1), sessionID].slice(-HISTORY_LIMIT)
      historyEntries = entries
      historyIndex = entries.length - 1
    }

    const historyMove = (direction: 1 | -1): string | undefined => {
      const route = context.ui.router.current()
      const active = route?.type === "session" ? historyRoot(route.sessionID) : undefined
      let open: Set<string> | undefined
      try {
        if (context.ui.tabs?.enabled?.()) {
          open = new Set((context.ui.tabs.list?.() ?? []).map((tab: any) => tab.sessionID))
        }
      } catch {}
      const candidates =
        direction === -1
          ? historyEntries.slice(0, historyIndex).map((id, index) => ({ id, index })).reverse()
          : historyEntries
              .slice(historyIndex + 1)
              .map((id, index) => ({ id, index: historyIndex + 1 + index }))
      const target = candidates.find((entry) => entry.id !== active && (!open || open.has(entry.id)))
      if (!target) return undefined
      historyIndex = target.index
      return target.id
    }

    const historyGo = (direction: 1 | -1) => {
      const sessionID = historyMove(direction)
      if (!sessionID) return
      try {
        if (context.ui.tabs?.focus?.(sessionID)) return
      } catch {}
      context.ui.router.navigate({ type: "session", sessionID })
    }

    // Archive/unarchive the current session using the same title convention as /archive.
    // Keymap layers must be registered from a rendered slot (as the built-ins do).
    // The keymap provider can mount after a hot reload, so retry briefly instead of
    // giving up and leaving the palette without our commands.
    let keymapRegistered = false
    let keymapTimer: ReturnType<typeof setTimeout> | undefined
    const registerKeymap = (attempt = 0) => {
      if (keymapRegistered) return
      try {
        if (!context.keymap?.layer) throw new Error("keymap unavailable")
        context.keymap.layer(() => ({
            mode: "global",
            priority: 10,
            commands: [
              {
                id: "session.archive.toggle",
                title: "Archive / unarchive session",
                group: "Session",
                bind: "<leader>z",
                palette: true,
                run: async () => {
                  const route = context.ui.router.current()
                  const sessionID = route?.type === "session" ? route.sessionID : undefined
                  if (!sessionID) {
                    context.ui.toast.show({ message: "Open a session first", variant: "warning" })
                    return
                  }
                  await toggleArchive(sessionID)
                },
              },
              {
                id: "project.new",
                title: "New project",
                group: "Project",
                bind: "<leader>p",
                palette: true,
                run: async () => {
                  await newProject()
                },
              },
              {
                id: "project.archive.toggle",
                title: "Archive / unarchive project",
                group: "Project",
                palette: true,
                run: async () => {
                  const route = context.ui.router.current()
                  const sessionID = route?.type === "session" ? route.sessionID : undefined
                  const session =
                    sessions().find((s) => s.id === sessionID) ??
                    context.data.session.get?.(sessionID)
                  const project = projects().find((p) => p.id === session?.projectID)
                  if (!project) {
                    context.ui.toast.show({
                      message: "Open a session in a project first",
                      variant: "warning",
                    })
                    return
                  }
                  await toggleProjectArchive(project)
                },
              },
              {
                id: "session.tabs.closeOthers",
                title: "Close other tabs",
                group: "Session",
                palette: true,
                run: async () => {
                  const tabs = context.ui.tabs?.list?.() ?? []
                  for (const tab of tabs) {
                    if (tab.active) continue
                    try {
                      context.ui.tabs.close(tab.sessionID)
                    } catch {}
                  }
                },
              },
              {
                id: "session.tab.history.back",
                title: "Back in session history",
                group: "Session",
                palette: false,
                bind: "super+[",
                run: () => historyGo(-1),
              },
              {
                id: "session.tab.history.forward",
                title: "Forward in session history",
                group: "Session",
                palette: false,
                bind: "super+]",
                run: () => historyGo(1),
              },
            ],
            bindings: ["session.archive.toggle", "project.new"],
        }))
        keymapRegistered = true
      } catch {
        if (attempt < 20) keymapTimer = setTimeout(() => registerKeymap(attempt + 1), 250)
      }
    }

    context.ui.slot({
      append: "app",
      render: () => {
        registerKeymap()
        return null
      },
    })

    const sessionsPanel = (sessionID?: string) => (
      <SessionsByProject
        context={context}
        sessionID={sessionID}
        sessions={sessions}
        revision={revision}
        projects={projects}
        working={working}
        kinds={kinds}
        collapsed={collapsed}
        toggle={toggle}
        showArchived={showArchived}
        toggleArchived={toggleArchived}
        createSession={createSession}
        newProject={newProject}
        openMenu={openSessionMenu}
        openProjectMenu={openProjectMenu}
        unreadLocal={unreadLocal}
        toggleUnread={toggleUnread}
        order={order}
        onDrop={handleSessionDrop}
        decorations={decorations}
      />
    )

    context.ui.slot({
      replace: "sidebar.content",
      render: (input: any) => sessionsPanel(input?.sessionID),
    })

    // The built-in sidebar footer repeats the working directory. Keep it in the
    // prompt footer at the bottom left and out of the sidebar.
    context.ui.slot({
      replace: "sidebar.footer",
      render: () => null,
    })

    // MCP status in the prompt footer, since the sidebar no longer shows it.
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => <McpStatus context={context} />,
    })

    context.ui.slot({
      append: "app",
      render: () => <HomeSidebar context={context}>{sessionsPanel(undefined)}</HomeSidebar>,
    })

    context.ui.slot({
      append: "app",
      render: () => (
        <SessionHistoryTracker
          context={context}
          onVisit={(sessionID) => historyRecord(historyRoot(sessionID))}
        />
      ),
    })

    context.ui.slot({
      append: "app",
      render: () => (
        <Show when={sessionMenu()} keyed>
          {(state) => (
            <SessionContextMenu
              context={context}
              state={state}
              onClose={closeSessionMenu}
              onArchive={(sessionID) => {
                closeSessionMenu()
                void toggleArchive(sessionID)
              }}
              onUnread={(sessionID) => {
                closeSessionMenu()
                toggleUnread(sessionID)
              }}
              onMove={(sessionID) => {
                closeSessionMenu()
                void moveToProject(sessionID)
              }}
            />
          )}
        </Show>
      ),
    })

    context.ui.slot({
      append: "app",
      render: () => (
        <Show when={projectMenu()} keyed>
          {(state) => (
            <ProjectContextMenu
              context={context}
              state={state}
              onClose={closeProjectMenu}
              onToggle={() => {
                void toggleProjectArchive(state.project)
              }}
            />
          )}
        </Show>
      ),
    })

    return () => {
      if (keymapTimer) clearTimeout(keymapTimer)
      clearTimeout(refetchTimer)
      clearInterval(poll)
      offs.forEach((off) => off())
      stopListen?.()
    }
  },
})
