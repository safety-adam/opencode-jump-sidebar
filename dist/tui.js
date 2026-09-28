import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Spinner frames used by the TUI for a busy/working session.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Archive convention used by the /archive command.
const ARCHIVE_PREFIX = "[Archived] ";
function basename(p) {
  if (!p) return "";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

// Projects come from different sources with different path fields.
function projectDir(p) {
  return p?.worktree ?? p?.canonical ?? p?.directory ?? "";
}

// Matches OpenCode's own default title for an untitled session.
function defaultTitle(session) {
  const created = session?.time?.created;
  if (!created) return "Untitled session";
  const kind = session?.parentID ? "Child" : "New";
  return `${kind} session - ${new Date(created).toISOString()}`;
}
function displayTitle(session) {
  return session?.title || defaultTitle(session);
}
function isArchived(session) {
  if (typeof session?.title === "string" && session.title.startsWith(ARCHIVE_PREFIX)) return true;
  return session?.time?.archived != null;
}
function unwrap(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.data?.data)) return result.data.data;
  return undefined;
}
function groupSessions(sessions, projects, showArchived) {
  const byId = new Map(projects.map(p => [p.id, p]));
  const groups = new Map();
  // Seed a group for every project, even if it has no sessions.
  for (const p of projects) {
    const dir = projectDir(p);
    if (!dir || dir === "/") continue; // skip the filesystem-root pseudo-project
    const label = p.name || basename(dir) || dir;
    groups.set(p.id, {
      key: p.id,
      label,
      dir,
      rows: []
    });
  }
  for (const s of sessions) {
    if (s.parentID) continue; // root sessions only
    if (!showArchived && isArchived(s)) continue;
    const dir = s.location?.directory ?? s.directory;
    const project = byId.get(s.projectID);
    const label = project?.name || basename(projectDir(project)) || basename(dir) || `Project ${String(s.projectID ?? "unknown").slice(0, 8)}`;
    const key = s.projectID || dir || "unknown";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: label || "Unknown",
        dir: projectDir(project) || dir,
        rows: []
      };
      groups.set(key, group);
    }
    group.rows.push(s);
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.rows.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  }
  // Projects are sorted alphabetically; sessions within each keep their own order.
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
function SessionRow(props) {
  const context = props.context;
  const status = createMemo(() => context.data.session.status?.(props.session.id));
  const busy = () => status() === "running" || props.working()[props.session.id] === true;
  const retry = () => status() === "retry";

  // Blocked states come from the session data: permission -> "!", question form -> "?".
  // Returns "none" when the store is authoritative and empty (so stale event kinds are ignored).
  const kind = createMemo(() => {
    const id = props.session.id;
    let known = false;
    try {
      const perms = context.data.session.permission?.list?.(id);
      if (Array.isArray(perms)) {
        known = true;
        if (perms.length > 0) return "!";
      }
    } catch {}
    try {
      const forms = context.data.session.form?.list?.(id, context.location);
      if (Array.isArray(forms)) {
        known = true;
        if (forms.length > 0) {
          return forms.some(f => f?.metadata?.kind === "question") ? "?" : "!";
        }
      }
    } catch {}
    return known ? "none" : undefined;
  });
  const activeKind = () => {
    const dataKind = kind();
    if (dataKind === "none") return undefined;
    return dataKind ?? props.eventKind;
  };
  const icon = () => {
    if (activeKind() === "!") return "!";
    if (activeKind() === "?") return "?";
    if (busy()) return SPINNER[props.frame() % SPINNER.length];
    if (retry()) return "!";
    if (props.unread) return "•";
    return " ";
  };
  // Colours match the TUI: attention (! / ?) = hue.accent[200], working = hue.orange[200].
  const iconColor = () => {
    if (activeKind() === "?" || activeKind() === "!") return context.theme.hue?.accent?.[200] ?? context.theme.text.feedback?.info?.base;
    if (busy()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base;
    if (retry()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base;
    if (props.unread) return context.theme.hue?.purple?.[200] ?? context.theme.text.feedback?.info?.base;
    return context.theme.text.muted;
  };
  const active = () => props.current === true;
  const rowBg = () => active() ? context.theme.background?.action?.primary?.selected ?? context.theme.background?.action?.primary?.focused ?? context.theme.background?.element : undefined;
  const titleColor = () => active() ? context.theme.text?.action?.primary?.selected ?? context.theme.text?.action?.primary?.focused ?? context.theme.text.base : context.theme.text.muted;
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("text"),
      _el$4 = _$createElement("text"),
      _el$5 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$insertNode(_el$, _el$4);
    _$insertNode(_el$, _el$5);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "gap", 1);
    _$setProp(_el$2, "flexShrink", 0);
    _$insert(_el$2, icon);
    _$setProp(_el$3, "wrapMode", "none");
    _$setProp(_el$3, "truncate", true);
    _$setProp(_el$3, "flexGrow", 1);
    _$setProp(_el$3, "minWidth", 0);
    _$setProp(_el$3, "onMouseUp", () => {
      if (props.localUnread) props.onToggleUnread?.();
      context.ui.router.navigate({
        type: "session",
        sessionID: props.session.id
      });
    });
    _$insert(_el$3, () => displayTitle(props.session));
    _$setProp(_el$4, "flexShrink", 0);
    _$setProp(_el$4, "onMouseUp", e => {
      e?.stopPropagation?.();
      props.onToggleUnread?.();
    });
    _$insert(_el$4, () => props.localUnread ? "•" : "·");
    _$setProp(_el$5, "flexShrink", 0);
    _$setProp(_el$5, "onMouseUp", e => {
      e?.stopPropagation?.();
      props.onToggleArchive?.();
    });
    _$insert(_el$5, () => isArchived(props.session) ? "⇡" : "⇣");
    _$effect(_p$ => {
      var _v$ = rowBg(),
        _v$2 = iconColor(),
        _v$3 = titleColor(),
        _v$4 = active() ? 1 : 0,
        _v$5 = props.localUnread ? context.theme.hue?.purple?.[200] ?? context.theme.text.base : context.theme.text.muted,
        _v$6 = context.theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$3, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$3, "attributes", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$4, "fg", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$5, "fg", _v$6, _p$.n));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined
    });
    return _el$;
  })();
}
function SessionsByProject(props) {
  const context = props.context;
  const groups = createMemo(() => groupSessions(props.sessions(), props.projects(), props.showArchived()));
  const [frame, setFrame] = createSignal(0);
  const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER.length), 90);
  onCleanup(() => clearInterval(timer));
  const tabs = createMemo(() => {
    const list = context.ui.tabs?.list?.() ?? [];
    return new Map(list.map(t => [t.sessionID, t]));
  });
  return (() => {
    var _el$6 = _$createElement("box"),
      _el$7 = _$createElement("box"),
      _el$8 = _$createElement("text"),
      _el$0 = _$createElement("box"),
      _el$1 = _$createElement("text"),
      _el$11 = _$createElement("text");
    _$insertNode(_el$6, _el$7);
    _$setProp(_el$6, "flexDirection", "column");
    _$setProp(_el$6, "paddingTop", 1);
    _$setProp(_el$6, "gap", 1);
    _$insertNode(_el$7, _el$8);
    _$insertNode(_el$7, _el$0);
    _$setProp(_el$7, "flexDirection", "row");
    _$insertNode(_el$8, _$createTextNode(`Jump to session`));
    _$setProp(_el$8, "attributes", 1);
    _$setProp(_el$8, "flexGrow", 1);
    _$setProp(_el$8, "minWidth", 0);
    _$setProp(_el$8, "wrapMode", "none");
    _$setProp(_el$8, "truncate", true);
    _$insertNode(_el$0, _el$1);
    _$insertNode(_el$0, _el$11);
    _$setProp(_el$0, "flexDirection", "row");
    _$setProp(_el$0, "gap", 1);
    _$setProp(_el$0, "flexShrink", 0);
    _$insertNode(_el$1, _$createTextNode(`≡`));
    _$setProp(_el$1, "onMouseUp", () => props.toggleArchived());
    _$insertNode(_el$11, _$createTextNode(`+`));
    _$setProp(_el$11, "onMouseUp", () => props.newProject());
    _$insert(_el$6, _$createComponent(For, {
      get each() {
        return groups();
      },
      children: group => {
        const isCollapsed = () => props.collapsed()[group.key] === true;
        return (() => {
          var _el$13 = _$createElement("box"),
            _el$14 = _$createElement("box"),
            _el$15 = _$createElement("box"),
            _el$16 = _$createElement("text"),
            _el$17 = _$createElement("text"),
            _el$18 = _$createElement("text");
          _$insertNode(_el$13, _el$14);
          _$setProp(_el$13, "flexDirection", "column");
          _$insertNode(_el$14, _el$15);
          _$insertNode(_el$14, _el$18);
          _$setProp(_el$14, "flexDirection", "row");
          _$setProp(_el$14, "gap", 1);
          _$insertNode(_el$15, _el$16);
          _$insertNode(_el$15, _el$17);
          _$setProp(_el$15, "flexDirection", "row");
          _$setProp(_el$15, "gap", 1);
          _$setProp(_el$15, "flexGrow", 1);
          _$setProp(_el$15, "minWidth", 0);
          _$setProp(_el$15, "onMouseUp", () => props.toggle(group.key));
          _$setProp(_el$16, "flexShrink", 0);
          _$insert(_el$16, () => isCollapsed() ? "▶" : "▼");
          _$setProp(_el$17, "wrapMode", "none");
          _$setProp(_el$17, "truncate", true);
          _$setProp(_el$17, "flexGrow", 1);
          _$setProp(_el$17, "minWidth", 0);
          _$insert(_el$17, () => `${group.label} (${group.rows.length})`);
          _$insertNode(_el$18, _$createTextNode(`+`));
          _$setProp(_el$18, "flexShrink", 0);
          _$setProp(_el$18, "onMouseUp", e => {
            e?.stopPropagation?.();
            props.createSession(group.dir);
          });
          _$insert(_el$13, _$createComponent(Show, {
            get when() {
              return !isCollapsed();
            },
            get children() {
              return _$createComponent(For, {
                get each() {
                  return group.rows;
                },
                children: session => _$createComponent(SessionRow, {
                  context: context,
                  session: session,
                  frame: frame,
                  get working() {
                    return props.working;
                  },
                  get eventKind() {
                    return props.kinds()[session.id];
                  },
                  get unread() {
                    return Boolean(tabs().get(session.id)?.unread) || props.unreadLocal()[session.id] === true;
                  },
                  get current() {
                    return session.id === props.sessionID;
                  },
                  onToggleArchive: () => props.toggleArchive(session.id),
                  get localUnread() {
                    return props.unreadLocal()[session.id] === true;
                  },
                  onToggleUnread: () => props.toggleUnread(session.id)
                })
              });
            }
          }), null);
          _$effect(_p$ => {
            var _v$0 = context.theme.text.muted,
              _v$1 = context.theme.text.base,
              _v$10 = context.theme.text.base;
            _v$0 !== _p$.e && (_p$.e = _$setProp(_el$16, "fg", _v$0, _p$.e));
            _v$1 !== _p$.t && (_p$.t = _$setProp(_el$17, "fg", _v$1, _p$.t));
            _v$10 !== _p$.a && (_p$.a = _$setProp(_el$18, "fg", _v$10, _p$.a));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined
          });
          return _el$13;
        })();
      }
    }), null);
    _$effect(_p$ => {
      var _v$7 = context.theme.text.base,
        _v$8 = props.showArchived() ? context.theme.hue?.orange?.[200] ?? context.theme.text.base : context.theme.text.muted,
        _v$9 = context.theme.text.muted;
      _v$7 !== _p$.e && (_p$.e = _$setProp(_el$8, "fg", _v$7, _p$.e));
      _v$8 !== _p$.t && (_p$.t = _$setProp(_el$1, "fg", _v$8, _p$.t));
      _v$9 !== _p$.a && (_p$.a = _$setProp(_el$11, "fg", _v$9, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$6;
  })();
}

// Shows the same panel on the home / new-session screen, as a right overlay.
function HomeSidebar(props) {
  const context = props.context;
  const route = createMemo(() => context.ui.router.current());
  const readWidth = () => context.renderer?.width ?? context.renderer?.size?.width ?? globalThis?.process?.stdout?.columns ?? 0;
  const [width, setWidth] = createSignal(readWidth() || 0);
  const timer = setInterval(() => {
    const next = readWidth();
    if (next && next !== width()) setWidth(next);
  }, 500);
  onCleanup(() => clearInterval(timer));
  return _$createComponent(Show, {
    get when() {
      return _$memo(() => route()?.type === "home")() && width() >= 120;
    },
    get children() {
      var _el$20 = _$createElement("box");
      _$setProp(_el$20, "position", "absolute");
      _$setProp(_el$20, "top", 1);
      _$setProp(_el$20, "right", 0);
      _$setProp(_el$20, "bottom", 0);
      _$setProp(_el$20, "width", 44);
      _$setProp(_el$20, "paddingLeft", 1);
      _$setProp(_el$20, "paddingRight", 1);
      _$insert(_el$20, () => props.children);
      _$effect(_$p => _$setProp(_el$20, "backgroundColor", context.theme.background?.raised?.base ?? context.theme.background?.element, _$p));
      return _el$20;
    }
  });
}
export default Plugin.define({
  id: "jump-sidebar",
  setup(context) {
    const [sessions, setSessions] = createSignal([]);
    const [projects, setProjects] = createSignal([]);
    const [working, setWorking] = createSignal({});
    const [kinds, setKinds] = createSignal({});
    const setWork = (id, on) => setWorking(prev => prev[id] === on ? prev : {
      ...prev,
      [id]: on
    });
    const setKind = (id, kind) => setKinds(prev => {
      if (kind === undefined) {
        if (!(id in prev)) return prev;
        const next = {
          ...prev
        };
        delete next[id];
        return next;
      }
      return prev[id] === kind ? prev : {
        ...prev,
        [id]: kind
      };
    });
    // Optimistically move a session to the top when it becomes active.
    const bump = id => setSessions(prev => prev.some(s => s.id === id) ? prev.map(s => s.id === id ? {
      ...s,
      time: {
        ...(s.time ?? {}),
        updated: Date.now()
      }
    } : s) : prev);
    let refetchTimer;
    const load = async () => {
      try {
        // Bust the client's cached project list so deletions are picked up.
        try {
          context.data.project.invalidate?.();
        } catch {}
        const freshProjects = unwrap(await context.client.project.list()) ?? [];
        const storeProjects = context.data.project.list?.() ?? [];
        const storeById = new Map(storeProjects.map(p => [p.id, p]));
        // The fresh fetch is authoritative; the store only fills missing fields.
        // (Never add store-only projects — that resurrects deleted ones.)
        const projects = freshProjects.length ? freshProjects.map(p => {
          const s = storeById.get(p.id);
          if (!s) return p;
          return {
            ...s,
            ...p,
            name: p.name ?? s.name,
            worktree: p.worktree ?? p.canonical ?? s.worktree ?? s.canonical
          };
        }) : storeProjects;
        if (projects.length) setProjects(projects);
        const requests = [context.client.session.list({
          limit: 1000,
          archived: true
        }).then(unwrap).catch(() => []), ...projects.map(project => context.client.session.list({
          directory: projectDir(project),
          limit: 1000,
          archived: true
        }).then(unwrap).catch(() => []))];
        const lists = await Promise.all(requests);
        const seen = new Set();
        const all = [];
        for (const list of lists) {
          for (const s of list ?? []) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            all.push(s);
          }
        }
        // Only fall back to the cached store if the client returned nothing.
        if (!all.length) for (const s of context.data.session.list?.() ?? []) all.push(s);
        if (all.length) setSessions(all);

        // Reconcile blocked states so stale "!"/"?" clear (e.g. after sleep).
        for (const s of all) {
          if (s.parentID) continue;
          const t = s.time ?? {};
          // An idle session can't be blocked: drop any stale event kind.
          if ((t.idle ?? 0) > 0 && (t.idle ?? 0) >= (t.updated ?? 0)) setKind(s.id, undefined);
          try {
            const perms = context.data.session.permission?.list?.(s.id);
            const forms = context.data.session.form?.list?.(s.id, context.location);
            if (Array.isArray(perms) && perms.length || Array.isArray(forms) && forms.length) {
              context.data.session.permission?.sync?.(s.id);
              context.data.session.form?.sync?.(s.id, context.location);
            }
          } catch {}
        }
      } catch {
        const sd = context.data.session.list?.() ?? [];
        const pd = context.data.project.list?.() ?? [];
        if (sd.length) setSessions(sd);
        if (pd.length) setProjects(pd);
      }
    };
    const schedule = () => {
      clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => void load(), 250);
    };
    const on = (type, fn) => {
      try {
        return context.data.on(type, fn);
      } catch {
        return undefined;
      }
    };
    void load();
    // Safety net: keep titles/order fresh even if an event is missed.
    const poll = setInterval(() => void load(), 3000);
    const offs = [on("session.created", schedule), on("session.updated", schedule), on("session.deleted", schedule), on("session.moved", schedule),
    // Working state from execution events.
    on("session.execution.started", e => {
      setWork(e.data.sessionID, true);
      bump(e.data.sessionID);
      schedule();
    }), on("session.execution.succeeded", e => {
      setWork(e.data.sessionID, false);
      schedule();
    }), on("session.execution.interrupted", e => setWork(e.data.sessionID, false)), on("session.execution.failed", e => setWork(e.data.sessionID, false)), on("session.idle", e => setWork(e.data.sessionID, false)),
    // Blocked states (fallback when the data store isn't populated): permission -> "!", question -> "?".
    on("permission.asked", e => setKind(e.data.sessionID, "!")), on("permission.replied", e => setKind(e.data.sessionID, undefined)), on("form.created", e => setKind(e.data.form?.sessionID ?? e.data.sessionID, "?")), on("form.replied", e => setKind(e.data.sessionID, undefined)), on("form.cancelled", e => setKind(e.data.sessionID, undefined)), on("session.error", e => setKind(e.data.sessionID, "!"))].filter(Boolean);

    // Broad listener: any session/message/part activity refreshes order + activity.
    let stopListen;
    try {
      stopListen = context.data.listen?.(event => {
        const details = event?.details ?? event;
        const type = details?.type;
        if (typeof type !== "string") return;
        if (!type.startsWith("session") && !type.startsWith("message") && !type.startsWith("part")) return;
        const sid = details?.properties?.sessionID;
        if (typeof sid === "string") bump(sid);
        schedule();
      });
    } catch {
      stopListen = undefined;
    }
    const [collapsed, setCollapsed] = createSignal({});
    const toggle = key => setCollapsed(prev => ({
      ...prev,
      [key]: !prev[key]
    }));

    // Create a new session in a project (directory) and open it.
    // The create endpoint takes a `location` ref, not a bare `directory`.
    const createSession = async dir => {
      try {
        const params = dir ? {
          location: {
            directory: dir
          }
        } : {};
        const res = await context.client.session.create(params);
        const created = res?.data ?? res;
        const id = created?.id ?? created?.data?.id;
        if (!id) {
          context.ui.toast.show({
            message: "Could not create session",
            variant: "error"
          });
          return;
        }
        setSessions(prev => prev.some(s => s.id === id) ? prev : [created, ...prev]);
        context.ui.router.navigate({
          type: "session",
          sessionID: id
        });
        schedule();
        // The title is generated shortly after the first prompt — refetch to pick it up.
        setTimeout(() => void load(), 2000);
      } catch (err) {
        context.ui.toast.show({
          message: `New session failed: ${err?.message ?? err}`,
          variant: "error"
        });
      }
    };

    // UI-driven project creation: prompt for a name, then create the folder and a
    // starter session (the same result as /new-project).
    const root = typeof context.options?.root === "string" && context.options.root ? context.options.root : "~/OpenCode projects";
    const expand = p => p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
    const newProject = async () => {
      let input = "";
      try {
        input = (await context.ui.dialog.prompt({
          title: "New project",
          placeholder: "Project name"
        })) ?? "";
      } catch {
        return;
      }
      const name = String(input).trim();
      if (!name) return;
      const rootDir = expand(root);
      const dir = isAbsolute(name) || name.startsWith("~") ? expand(name) : join(rootDir, name);
      try {
        mkdirSync(dir, {
          recursive: true
        });
      } catch (err) {
        context.ui.toast.show({
          message: `Could not create folder: ${err?.message ?? err}`,
          variant: "error"
        });
        return;
      }

      // Reuse an existing session for this directory; never seed a second one.
      const existing = sessions().find(s => !s.parentID && (s.location?.directory ?? s.directory) === dir);
      if (existing) {
        context.ui.router.navigate({
          type: "session",
          sessionID: existing.id
        });
        return;
      }
      try {
        const res = await context.client.session.create({
          location: {
            directory: dir
          }
        });
        const created = res?.data ?? res;
        const id = created?.id ?? created?.data?.id;
        if (id) context.ui.router.navigate({
          type: "session",
          sessionID: id
        });
        schedule();
        setTimeout(() => void load(), 2000);
      } catch (err) {
        context.ui.toast.show({
          message: `New project failed: ${err?.message ?? err}`,
          variant: "error"
        });
      }
    };

    // Archive/unarchive a session using the same title convention as /archive.
    const toggleArchive = async sessionID => {
      const session = sessions().find(s => s.id === sessionID) ?? context.data.session.get?.(sessionID);
      const title = session?.title ?? "";
      const archived = title.startsWith(ARCHIVE_PREFIX);
      const next = archived ? title.slice(ARCHIVE_PREFIX.length) : ARCHIVE_PREFIX + title;
      try {
        await context.client.session.update({
          sessionID,
          title: next
        });
        schedule();
      } catch (err) {
        context.ui.toast.show({
          message: `Archive failed: ${err?.message ?? err}`,
          variant: "error"
        });
      }
    };

    // Show/hide archived, persisted across restarts when storage is available.
    let showArchived;
    let toggleArchived;
    try {
      const [settings, update] = context.storage.store("sessions-by-project", {
        initial: {
          showArchived: false
        }
      });
      const read = () => typeof settings === "function" ? settings() : settings;
      showArchived = () => read()?.showArchived === true;
      toggleArchived = () => update(draft => {
        draft.showArchived = !draft.showArchived;
      });
    } catch {
      const [sig, setSig] = createSignal(false);
      showArchived = sig;
      toggleArchived = () => setSig(v => !v);
    }

    // Manual "unread" flags kept by the plugin (OpenCode has no unread setter).
    let unreadLocal;
    let toggleUnread;
    try {
      const [store, update] = context.storage.store("jump-sidebar.unread", {
        initial: {}
      });
      const read = () => (typeof store === "function" ? store() : store) ?? {};
      unreadLocal = read;
      toggleUnread = id => update(draft => {
        if (draft[id]) delete draft[id];else draft[id] = true;
      });
    } catch {
      const [sig, set] = createSignal({});
      unreadLocal = sig;
      toggleUnread = id => set(prev => {
        const next = {
          ...prev
        };
        if (next[id]) delete next[id];else next[id] = true;
        return next;
      });
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
            commands: [{
              id: "session.archive.toggle",
              title: "Archive / unarchive session",
              group: "Session",
              bind: "<leader>z",
              palette: true,
              run: async () => {
                const route = context.ui.router.current();
                const sessionID = route?.type === "session" ? route.sessionID : undefined;
                if (!sessionID) {
                  context.ui.toast.show({
                    message: "Open a session first",
                    variant: "warning"
                  });
                  return;
                }
                await toggleArchive(sessionID);
              }
            }, {
              id: "project.new",
              title: "New project",
              group: "Project",
              bind: "<leader>p",
              palette: true,
              run: async () => {
                await newProject();
              }
            }],
            bindings: ["session.archive.toggle", "project.new"]
          }));
        } catch {
          // keymap unavailable — the palette command simply won't register
        }
        return null;
      }
    });
    const sessionsPanel = sessionID => _$createComponent(SessionsByProject, {
      context: context,
      sessionID: sessionID,
      sessions: sessions,
      projects: projects,
      working: working,
      kinds: kinds,
      collapsed: collapsed,
      toggle: toggle,
      showArchived: showArchived,
      toggleArchived: toggleArchived,
      createSession: createSession,
      newProject: newProject,
      toggleArchive: toggleArchive,
      unreadLocal: unreadLocal,
      toggleUnread: toggleUnread
    });
    context.ui.slot({
      append: "sidebar.content",
      render: input => sessionsPanel(input?.sessionID)
    });
    context.ui.slot({
      append: "app",
      render: () => _$createComponent(HomeSidebar, {
        context: context,
        get children() {
          return sessionsPanel(undefined);
        }
      })
    });
    return () => {
      clearTimeout(refetchTimer);
      clearInterval(poll);
      offs.forEach(off => off());
      stopListen?.();
    };
  }
});
