import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"

// Spinner frames used by the TUI for a busy/working session.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
// Archive convention used by the /archive command.
const ARCHIVE_PREFIX = "[Archived] "

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

function isArchived(session: any): boolean {
  if (typeof session?.title === "string" && session.title.startsWith(ARCHIVE_PREFIX)) return true
  return session?.time?.archived != null
}

function unwrap(result: any): any[] | undefined {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.data)) return result.data
  if (Array.isArray(result?.data?.data)) return result.data.data
  return undefined
}

function groupSessions(
  sessions: any[],
  projects: any[],
  showArchived: boolean,
): { key: string; label: string; dir?: string; rows: any[] }[] {
  const byId = new Map<string, any>(projects.map((p) => [p.id, p]))

  const groups = new Map<string, { key: string; label: string; dir?: string; rows: any[] }>()
  // Seed a group for every project, even if it has no sessions.
  for (const p of projects) {
    const dir = projectDir(p)
    if (!dir || dir === "/") continue // skip the filesystem-root pseudo-project
    const label = p.name || basename(dir) || dir
    groups.set(p.id, { key: p.id, label, dir, rows: [] })
  }
  for (const s of sessions) {
    if (s.parentID) continue // root sessions only
    if (!showArchived && isArchived(s)) continue
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
    g.rows.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  }
  // Projects are sorted alphabetically; sessions within each keep their own order.
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
  onToggleArchive?: () => void
  localUnread?: boolean
  onToggleUnread?: () => void
}) {
  const context = props.context
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

  const icon = () => {
    if (activeKind() === "!") return "!"
    if (activeKind() === "?") return "?"
    if (busy()) return SPINNER[props.frame() % SPINNER.length]
    if (retry()) return "!"
    if (props.unread) return "•"
    return " "
  }
  // Colours match the TUI: attention (! / ?) = hue.accent[200], working = hue.orange[200].
  const iconColor = () => {
    if (activeKind() === "?" || activeKind() === "!")
      return context.theme.hue?.accent?.[200] ?? context.theme.text.feedback?.info?.base
    if (busy()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base
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
  const titleColor = () =>
    active()
      ? context.theme.text?.action?.primary?.selected ??
        context.theme.text?.action?.primary?.focused ??
        context.theme.text.base
      : context.theme.text.muted

  return (
    <box flexDirection="row" gap={1} backgroundColor={rowBg()}>
      <text fg={iconColor()} flexShrink={0}>
        {icon()}
      </text>
      <text
        fg={titleColor()}
        attributes={active() ? 1 : 0}
        wrapMode="none"
        truncate
        flexGrow={1}
        minWidth={0}
        onMouseUp={() => {
          if (props.localUnread) props.onToggleUnread?.()
          context.ui.router.navigate({ type: "session", sessionID: props.session.id })
        }}
      >
        {displayTitle(props.session)}
      </text>
      <text
        fg={
          props.localUnread
            ? context.theme.hue?.purple?.[200] ?? context.theme.text.base
            : context.theme.text.muted
        }
        flexShrink={0}
        onMouseUp={(e: any) => {
          e?.stopPropagation?.()
          props.onToggleUnread?.()
        }}
      >
        {props.localUnread ? "•" : "·"}
      </text>
      <text
        fg={context.theme.text.muted}
        flexShrink={0}
        onMouseUp={(e: any) => {
          e?.stopPropagation?.()
          props.onToggleArchive?.()
        }}
      >
        {isArchived(props.session) ? "⇡" : "⇣"}
      </text>
    </box>
  )
}

function SessionsByProject(props: {
  context: any
  sessionID?: string
  sessions: () => any[]
  projects: () => any[]
  working: () => Record<string, boolean>
  kinds: () => Record<string, string>
  collapsed: () => Record<string, boolean>
  toggle: (key: string) => void
  showArchived: () => boolean
  toggleArchived: () => void
  createSession: (dir?: string) => void
  toggleArchive: (id: string) => void
  unreadLocal: () => Record<string, boolean>
  toggleUnread: (id: string) => void
}) {
  const context = props.context
  const groups = createMemo(() =>
    groupSessions(props.sessions(), props.projects(), props.showArchived()),
  )

  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 90)
  onCleanup(() => clearInterval(timer))

  const tabs = createMemo(() => {
    const list = context.ui.tabs?.list?.() ?? []
    return new Map<string, any>(list.map((t: any) => [t.sessionID, t]))
  })

  return (
    <box flexDirection="column" paddingTop={1} gap={1}>
      <box flexDirection="row">
        <text
          fg={context.theme.text.base}
          attributes={1}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          Jump to session
        </text>
        <text
          fg={
            props.showArchived()
              ? context.theme.hue?.orange?.[200] ?? context.theme.text.base
              : context.theme.text.muted
          }
          flexShrink={0}
          onMouseUp={() => props.toggleArchived()}
        >
          ≡
        </text>
      </box>
      <For each={groups()}>
        {(group) => {
          const isCollapsed = () => props.collapsed()[group.key] === true
          return (
            <box flexDirection="column">
              <box flexDirection="row" gap={1}>
                <box
                  flexDirection="row"
                  gap={1}
                  flexGrow={1}
                  minWidth={0}
                  onMouseUp={() => props.toggle(group.key)}
                >
                  <text fg={context.theme.text.muted} flexShrink={0}>
                    {isCollapsed() ? "▶" : "▼"}
                  </text>
                  <text
                    fg={context.theme.text.base}
                    wrapMode="none"
                    truncate
                    flexGrow={1}
                    minWidth={0}
                  >
                    {`${group.label} (${group.rows.length})`}
                  </text>
                </box>
                <text
                  fg={context.theme.text.base}
                  flexShrink={0}
                  onMouseUp={(e: any) => {
                    e?.stopPropagation?.()
                    props.createSession(group.dir)
                  }}
                >
                  +
                </text>
              </box>
              <Show when={!isCollapsed()}>
                <For each={group.rows}>
                  {(session: any) => (
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
                      onToggleArchive={() => props.toggleArchive(session.id)}
                      localUnread={props.unreadLocal()[session.id] === true}
                      onToggleUnread={() => props.toggleUnread(session.id)}
                    />
                  )}
                </For>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

export default Plugin.define({
  id: "jump-sidebar",
  setup(context: any) {
    const [sessions, setSessions] = createSignal<any[]>([])
    const [projects, setProjects] = createSignal<any[]>([])
    const [working, setWorking] = createSignal<Record<string, boolean>>({})
    const [kinds, setKinds] = createSignal<Record<string, string>>({})
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

        const requests: Promise<any>[] = [
          context.client.session
            .list({ limit: 1000, archived: true })
            .then(unwrap)
            .catch(() => [] as any[]),
          ...projects.map((project: any) =>
            context.client.session
              .list({ directory: projectDir(project), limit: 1000, archived: true })
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

    // Archive/unarchive a session using the same title convention as /archive.
    const toggleArchive = async (sessionID: string) => {
      const session = sessions().find((s) => s.id === sessionID) ?? context.data.session.get?.(sessionID)
      const title = session?.title ?? ""
      const archived = title.startsWith(ARCHIVE_PREFIX)
      const next = archived ? title.slice(ARCHIVE_PREFIX.length) : ARCHIVE_PREFIX + title
      try {
        await context.client.session.update({ sessionID, title: next })
        schedule()
      } catch (err: any) {
        context.ui.toast.show({ message: `Archive failed: ${err?.message ?? err}`, variant: "error" })
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

    // Archive/unarchive the current session using the same title convention as /archive.
    // Keymap layers must be registered from a rendered slot (as the built-ins do).
    context.ui.slot({
      append: "app",
      render: () => {
        try {
          context.keymap?.layer?.(() => ({
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
            ],
            bindings: ["session.archive.toggle"],
          }))
        } catch {
          // keymap unavailable — the palette command simply won't register
        }
        return null
      },
    })

    context.ui.slot({
      append: "sidebar.content",
      render: (input: any) => (
        <SessionsByProject
          context={context}
          sessionID={input?.sessionID}
          sessions={sessions}
          projects={projects}
          working={working}
          kinds={kinds}
          collapsed={collapsed}
          toggle={toggle}
          showArchived={showArchived}
          toggleArchived={toggleArchived}
          createSession={createSession}
          toggleArchive={toggleArchive}
          unreadLocal={unreadLocal}
          toggleUnread={toggleUnread}
        />
      ),
    })

    return () => {
      clearTimeout(refetchTimer)
      clearInterval(poll)
      offs.forEach((off) => off())
      stopListen?.()
    }
  },
})
