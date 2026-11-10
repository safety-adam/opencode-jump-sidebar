import { memo as _$memo } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execSync } from "node:child_process";
import { isArchivedTitle, toArchivedTitle, toUnarchivedTitle } from "./archive.js";

// Spinner frames used by the TUI for a busy/working session.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Slower, quieter frames for background work (subagents or running shells).
const BACKGROUND = ["◌", "◎"];
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

// Watches the route and reports each session visit so the plugin can keep a
// browser style history stack. It renders nothing.
function SessionHistoryTracker(props) {
  createEffect(on(() => {
    const route = props.context.ui.router.current();
    return route?.type === "session" ? route.sessionID : undefined;
  }, sessionID => {
    if (sessionID) props.onVisit(sessionID);
  }));
  return null;
}
function isArchived(session) {
  if (isArchivedTitle(session?.title)) return true;
  return session?.time?.archived != null;
}
function unwrap(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.data?.data)) return result.data.data;
  return undefined;
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

function sidebarDir() {
  return process.env.OPENCODE_SIDEBAR_DIR || join(homedir(), ".local", "share", "opencode", "sidebar");
}

// Temporary tracing for the todo panel. Remove once the panel is confirmed.
function trace(message) {
  try {
    const base = sidebarDir();
    mkdirSync(base, {
      recursive: true
    });
    appendFileSync(join(base, "todos-debug.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
function readDecorations() {
  try {
    const base = process.env.OPENCODE_SIDEBAR_DIR || join(homedir(), ".local", "share", "opencode", "sidebar");
    const dir = join(base, "decorations");
    const merged = {};
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
        const sessions = parsed?.sessions;
        if (sessions && typeof sessions === "object") {
          for (const [sid, dec] of Object.entries(sessions)) {
            merged[sid] = {
              ...(merged[sid] ?? {}),
              ...dec
            };
          }
        }
      } catch {
        // Skip a malformed file, keep the rest.
      }
    }
    return merged;
  } catch {
    return {};
  }
}

// Todos come from the latest todowrite tool part in the session messages. The
// tool input holds the whole list, so the last call wins and an empty list
// clears the panel.
// Returns null when the transcript holds no todowrite call at all, so an empty
// array always means the agent cleared the list.
function todosFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part?.type !== "tool" || part?.name !== "todowrite") continue;
      const todos = part.state?.input?.todos ?? part.state?.metadata?.todos;
      if (Array.isArray(todos)) return todos;
    }
  }
  return null;
}
function readTodos(context, sessionID) {
  if (!sessionID) return null;
  try {
    return todosFromMessages(context.data.session.message.list?.(sessionID) ?? []);
  } catch {
    return null;
  }
}
const TODO_ICON = {
  pending: "[ ]",
  in_progress: "[•]",
  completed: "[✓]",
  cancelled: "[-]"
};
function TodoPanel(props) {
  const context = props.context;
  const [todos, setTodos] = createSignal([]);
  let ticket = 0;
  let fetchedAt = 0;

  // The sidebar tells us the open session. On the home screen it does not, so
  // fall back to the route.
  const session = () => {
    if (props.sessionID) return props.sessionID;
    const route = context.ui.router.current?.();
    return route?.type === "session" ? route.sessionID : undefined;
  };
  let shown;
  const load = sessionID => {
    const current = ++ticket;
    if (sessionID !== shown) {
      shown = sessionID;
      setTodos([]);
    }
    if (!sessionID) return;
    // The client store empties and refills while a session streams, so only a
    // real todowrite call may change what is on screen.
    const cached = readTodos(context, sessionID);
    if (cached) {
      if (cached.length) trace(`panel ${sessionID} store=${cached.length}`);
      setTodos(cached);
      return;
    }
    if (Date.now() - fetchedAt < 30_000) return;
    fetchedAt = Date.now();
    try {
      void context.client.message.list({
        sessionID,
        limit: 200,
        order: "desc"
      }).then(res => {
        if (current !== ticket) return;
        const page = unwrap(res) ?? res?.data ?? [];
        const found = todosFromMessages([...page].reverse());
        trace(`panel ${sessionID} api page=${page.length} found=${found?.length ?? "none"}`);
        if (found) setTodos(found);
      }).catch(err => {
        trace(`panel ${sessionID} api error ${err?.message ?? err}`);
      });
    } catch (err) {
      trace(`panel ${sessionID} api threw ${err?.message ?? err}`);
    }
  };
  createEffect(on(() => [session(), props.revision()], ([sessionID]) => load(sessionID)));
  const writeClipboard = text => {
    if (process.platform === "darwin") {
      execSync("pbcopy", {
        input: text
      });
      return;
    }
    // Other platforms go through the terminal's OSC 52 support.
    context.renderer?.copyToClipboardOSC52?.(text);
  };

  // Clicking an item drafts the prompt for it into the composer without sending.
  // The TUI gives plugins no way to write the composer, so the text goes through
  // the clipboard and the built-in paste command, then the clipboard is restored.
  const draft = content => {
    const text = `Start "${content}" and mark it in progress.`;
    let previous;
    try {
      if (process.platform === "darwin") previous = execSync("pbpaste", {
        encoding: "utf8"
      });
      writeClipboard(text);
      context.keymap?.dispatch("prompt.paste");
      trace(`draft ${content.slice(0, 40)}`);
    } catch (err) {
      trace(`draft error ${err?.message ?? err}`);
      context.ui?.toast?.show({
        message: "Could not draft the todo prompt",
        variant: "error"
      });
      return;
    }
    if (previous === undefined) return;
    setTimeout(() => {
      try {
        execSync("pbcopy", {
          input: previous
        });
      } catch {}
    }, 400);
  };
  const done = () => todos().filter(t => t.status === "completed").length;
  const color = status => {
    if (status === "in_progress") return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base;
    if (status === "cancelled" || status === "completed") return context.theme.text.faint;
    return context.theme.text.muted;
  };
  return _$createComponent(Show, {
    get when() {
      return todos().length > 0;
    },
    get children() {
      var _el$ = _$createElement("box"),
        _el$2 = _$createElement("box"),
        _el$3 = _$createElement("text"),
        _el$5 = _$createElement("text");
      _$insertNode(_el$, _el$2);
      _$setProp(_el$, "flexDirection", "column");
      _$setProp(_el$, "gap", 0);
      _$setProp(_el$, "paddingRight", 1);
      _$insertNode(_el$2, _el$3);
      _$insertNode(_el$2, _el$5);
      _$setProp(_el$2, "flexDirection", "row");
      _$setProp(_el$2, "gap", 1);
      _$insertNode(_el$3, _$createTextNode(`Todos`));
      _$setProp(_el$3, "attributes", 1);
      _$insert(_el$5, () => `${done()}/${todos().length}`);
      _$insert(_el$, _$createComponent(For, {
        get each() {
          return todos();
        },
        children: todo => (() => {
          var _el$6 = _$createElement("box"),
            _el$7 = _$createElement("text"),
            _el$8 = _$createElement("text");
          _$insertNode(_el$6, _el$7);
          _$insertNode(_el$6, _el$8);
          _$setProp(_el$6, "flexDirection", "row");
          _$setProp(_el$6, "gap", 1);
          _$setProp(_el$7, "flexShrink", 0);
          _$insert(_el$7, () => TODO_ICON[todo.status] ?? "[ ]");
          _$setProp(_el$8, "wrapMode", "word");
          _$setProp(_el$8, "flexGrow", 1);
          _$setProp(_el$8, "minWidth", 0);
          _$setProp(_el$8, "onMouseUp", () => {
            if (todo.status === "completed" || todo.status === "cancelled") return;
            draft(todo.content);
          });
          _$insert(_el$8, () => todo.content);
          _$effect(_p$ => {
            var _v$3 = color(todo.status),
              _v$4 = color(todo.status),
              _v$5 = todo.status === "cancelled" ? 128 : 0;
            _v$3 !== _p$.e && (_p$.e = _$setProp(_el$7, "fg", _v$3, _p$.e));
            _v$4 !== _p$.t && (_p$.t = _$setProp(_el$8, "fg", _v$4, _p$.t));
            _v$5 !== _p$.a && (_p$.a = _$setProp(_el$8, "attributes", _v$5, _p$.a));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined
          });
          return _el$6;
        })()
      }), null);
      _$effect(_p$ => {
        var _v$ = context.theme.text.base,
          _v$2 = context.theme.text.faint;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$;
    }
  });
}
function groupSessions(sessions, projects, showArchived, order) {
  const byId = new Map(projects.map(p => [p.id, p]));
  const archivedProjects = new Set(projects.filter(p => isArchivedTitle(p.name)).map(p => p.id));
  const groups = new Map();
  // Seed a group for every project, even if it has no sessions.
  for (const p of projects) {
    const dir = projectDir(p);
    if (!dir || dir === "/") continue; // skip the filesystem-root pseudo-project
    if (!showArchived && archivedProjects.has(p.id)) continue;
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
    if (!showArchived && s.projectID && archivedProjects.has(s.projectID)) continue;
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
    const ranked = order[g.dir || g.key] ?? [];
    const rank = new Map(ranked.map((id, index) => [id, index]));
    g.rows.sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      // Sessions that are not in the manual order yet are new, so keep them on top.
      if (ra !== undefined) return 1;
      if (rb !== undefined) return -1;
      return (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
    });
  }
  // Projects are sorted alphabetically; sessions within each keep their manual order.
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
function SessionRow(props) {
  const context = props.context;
  const dotColor = () => props.decoration?.dot?.color ?? context.theme.hue?.red?.[200] ?? context.theme.text.feedback?.error?.base ?? "red";
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

  // Subagents (descendant sessions) or running shells mean background work.
  const hasBackground = createMemo(() => {
    const map = props.childMap?.();
    if (map) {
      const stack = [...(map.get(props.session.id) ?? [])];
      while (stack.length > 0) {
        const child = stack.pop();
        if (context.data.session.status?.(child.id) === "running") return true;
        const kids = map.get(child.id);
        if (kids) stack.push(...kids);
      }
    }
    try {
      const shells = context.data.shell?.listBySession?.(props.session.id) ?? [];
      if (Array.isArray(shells) && shells.some(sh => sh?.status === "running")) {
        return true;
      }
    } catch {}
    return false;
  });
  const icon = () => {
    if (activeKind() === "!") return "!";
    if (activeKind() === "?") return "?";
    if (busy()) return SPINNER[props.frame() % SPINNER.length];
    if (hasBackground()) return BACKGROUND[Math.floor(props.frame() / 5) % BACKGROUND.length];
    if (retry()) return "!";
    if (props.unread) return "●";
    return " ";
  };
  // Colours match the TUI: attention (! / ?) = hue.accent[200], working = hue.orange[200].
  const iconColor = () => {
    if (activeKind() === "?" || activeKind() === "!") return context.theme.hue?.accent?.[200] ?? context.theme.text.feedback?.info?.base;
    if (busy()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base;
    if (hasBackground()) {
      if (active()) return activeColor();
      if (props.unread) return context.theme.hue?.purple?.[200] ?? context.theme.text.feedback?.info?.base;
      if (retry()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base;
      return context.theme.text.muted;
    }
    if (retry()) return context.theme.hue?.orange?.[200] ?? context.theme.text.feedback?.warning?.base;
    if (props.unread) return context.theme.hue?.purple?.[200] ?? context.theme.text.feedback?.info?.base;
    return context.theme.text.muted;
  };
  const active = () => props.current === true;
  const rowBg = () => active() ? context.theme.background?.action?.primary?.selected ?? context.theme.background?.action?.primary?.focused ?? context.theme.background?.element : undefined;
  const activeColor = () => context.theme.text?.action?.primary?.selected ?? context.theme.text?.action?.primary?.focused ?? context.theme.text.base;
  const titleColor = () => {
    if (active()) return activeColor();
    if (props.unread) {
      return context.theme.hue?.purple?.[200] ?? context.theme.text.feedback?.info?.base;
    }
    return context.theme.text.muted;
  };
  return (() => {
    var _el$9 = _$createElement("box"),
      _el$0 = _$createElement("text"),
      _el$12 = _$createElement("text");
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$12);
    _$setProp(_el$9, "flexDirection", "row");
    _$setProp(_el$9, "gap", 1);
    _$setProp(_el$9, "paddingRight", 1);
    _$setProp(_el$9, "onMouseDown", e => props.onDragStart?.(e));
    _$setProp(_el$9, "onMouseDrag", e => props.onDrag?.(e));
    _$setProp(_el$9, "onMouseDragEnd", e => props.onDragEnd?.(e));
    _$setProp(_el$9, "onMouseUp", e => {
      if (e?.button === 2) {
        e.preventDefault?.();
        e.stopPropagation?.();
        props.onOpenMenu?.({
          session: props.session,
          x: e.x ?? 0,
          y: e.y ?? 0,
          archived: isArchived(props.session),
          unread: props.localUnread === true
        });
        return;
      }
      if (e?.button !== 0) return;
      props.onOpen?.();
    });
    _$setProp(_el$0, "flexShrink", 0);
    _$insert(_el$0, icon);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return props.decoration?.dot;
      },
      get children() {
        var _el$1 = _$createElement("text");
        _$insertNode(_el$1, _$createTextNode(`●`));
        _$setProp(_el$1, "flexShrink", 0);
        _$effect(_$p => _$setProp(_el$1, "fg", dotColor(), _$p));
        return _el$1;
      }
    }), _el$12);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return props.decoration?.label;
      },
      get children() {
        var _el$11 = _$createElement("text");
        _$setProp(_el$11, "flexShrink", 0);
        _$insert(_el$11, () => props.decoration?.label);
        _$effect(_$p => _$setProp(_el$11, "fg", context.theme.text.muted, _$p));
        return _el$11;
      }
    }), _el$12);
    _$setProp(_el$12, "wrapMode", "none");
    _$setProp(_el$12, "truncate", true);
    _$setProp(_el$12, "flexGrow", 1);
    _$setProp(_el$12, "minWidth", 0);
    _$insert(_el$12, () => displayTitle(props.session));
    _$effect(_p$ => {
      var _v$6 = props.drop ? context.theme.background?.action?.primary?.hovered ?? context.theme.background?.element : rowBg(),
        _v$7 = iconColor(),
        _v$8 = titleColor(),
        _v$9 = active() ? 1 : 0;
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$9, "backgroundColor", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$0, "fg", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$12, "fg", _v$8, _p$.a));
      _v$9 !== _p$.o && (_p$.o = _$setProp(_el$12, "attributes", _v$9, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$9;
  })();
}
// Right-click menu for a session row. The renderer reports the secondary button
// as 2 and the click position in screen cells.
function SessionContextMenu(props) {
  const context = props.context;
  const [selected, setSelected] = createSignal(0);
  const width = 20;
  const items = () => [{
    label: props.state.archived ? "Unarchive" : "Archive",
    run: () => props.onArchive(props.state.session.id)
  }, {
    label: props.state.unread ? "Mark read" : "Mark unread",
    run: () => props.onUnread(props.state.session.id)
  }, {
    label: "Move to...",
    run: () => props.onMove(props.state.session.id)
  }];
  const dims = () => ({
    width: context.renderer?.width ?? 80,
    height: context.renderer?.height ?? 24
  });
  const left = () => Math.max(0, Math.min(props.state.x, dims().width - width));
  const top = () => Math.max(0, Math.min(props.state.y + 1, dims().height - 1 - items().length));
  const runSelected = () => {
    const item = items()[selected()];
    props.onClose();
    item?.run();
  };
  try {
    const pop = context.keymap?.mode?.push?.("menu");
    if (pop) onCleanup(pop);
  } catch {}
  try {
    context.keymap?.layer?.(() => ({
      mode: "menu",
      commands: [{
        bind: "escape,ctrl+c",
        title: "Close session menu",
        run: () => props.onClose()
      }, {
        bind: "up",
        title: "Previous menu item",
        run: () => setSelected(index => (index - 1 + items().length) % items().length)
      }, {
        bind: "down",
        title: "Next menu item",
        run: () => setSelected(index => (index + 1) % items().length)
      }, {
        bind: "return",
        title: "Run menu item",
        run: runSelected
      }]
    }));
  } catch {}
  const background = context.theme.background?.raised?.high ?? context.theme.background?.element;
  const hovered = context.theme.background?.action?.primary?.hovered ?? background;
  return (() => {
    var _el$13 = _$createElement("box"),
      _el$14 = _$createElement("box");
    _$insertNode(_el$13, _el$14);
    _$setProp(_el$13, "position", "absolute");
    _$setProp(_el$13, "left", 0);
    _$setProp(_el$13, "top", 0);
    _$setProp(_el$13, "width", "100%");
    _$setProp(_el$13, "height", "100%");
    _$setProp(_el$13, "zIndex", 2600);
    _$setProp(_el$13, "onMouseDown", e => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      props.onClose();
    });
    _$setProp(_el$14, "position", "absolute");
    _$setProp(_el$14, "width", 20);
    _$setProp(_el$14, "flexDirection", "column");
    _$setProp(_el$14, "backgroundColor", background);
    _$setProp(_el$14, "onMouseDown", e => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
    });
    _$insert(_el$14, _$createComponent(For, {
      get each() {
        return items();
      },
      children: (item, index) => (() => {
        var _el$15 = _$createElement("box"),
          _el$16 = _$createElement("text");
        _$insertNode(_el$15, _el$16);
        _$setProp(_el$15, "height", 1);
        _$setProp(_el$15, "paddingLeft", 1);
        _$setProp(_el$15, "paddingRight", 1);
        _$setProp(_el$15, "onMouseOver", () => setSelected(index()));
        _$setProp(_el$15, "onMouseUp", e => {
          e?.preventDefault?.();
          e?.stopPropagation?.();
          if (e?.button !== 0) return;
          props.onClose();
          item.run();
        });
        _$setProp(_el$16, "wrapMode", "none");
        _$setProp(_el$16, "truncate", true);
        _$insert(_el$16, () => item.label);
        _$effect(_p$ => {
          var _v$11 = index() === selected() ? hovered : background,
            _v$12 = context.theme.text.base;
          _v$11 !== _p$.e && (_p$.e = _$setProp(_el$15, "backgroundColor", _v$11, _p$.e));
          _v$12 !== _p$.t && (_p$.t = _$setProp(_el$16, "fg", _v$12, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$15;
      })()
    }));
    _$effect(_p$ => {
      var _v$0 = left(),
        _v$1 = top(),
        _v$10 = items().length;
      _v$0 !== _p$.e && (_p$.e = _$setProp(_el$14, "left", _v$0, _p$.e));
      _v$1 !== _p$.t && (_p$.t = _$setProp(_el$14, "top", _v$1, _p$.t));
      _v$10 !== _p$.a && (_p$.a = _$setProp(_el$14, "height", _v$10, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$13;
  })();
}
function ProjectContextMenu(props) {
  const context = props.context;
  const width = 20;
  const label = () => isArchivedTitle(props.state.project?.name) ? "Unarchive project" : "Archive project";
  const dims = () => ({
    width: context.renderer?.width ?? 80,
    height: context.renderer?.height ?? 24
  });
  const left = () => Math.max(0, Math.min(props.state.x, dims().width - width));
  const top = () => Math.max(0, Math.min(props.state.y + 1, dims().height - 2));
  const run = () => {
    props.onClose();
    props.onToggle();
  };
  try {
    const pop = context.keymap?.mode?.push?.("menu");
    if (pop) onCleanup(pop);
  } catch {}
  try {
    context.keymap?.layer?.(() => ({
      mode: "menu",
      commands: [{
        bind: "escape,ctrl+c",
        title: "Close project menu",
        run: () => props.onClose()
      }, {
        bind: "return",
        title: "Run project menu item",
        run
      }]
    }));
  } catch {}
  const background = context.theme.background?.raised?.high ?? context.theme.background?.element;
  const hovered = context.theme.background?.action?.primary?.hovered ?? background;
  return (() => {
    var _el$17 = _$createElement("box"),
      _el$18 = _$createElement("box"),
      _el$19 = _$createElement("text");
    _$insertNode(_el$17, _el$18);
    _$setProp(_el$17, "position", "absolute");
    _$setProp(_el$17, "left", 0);
    _$setProp(_el$17, "top", 0);
    _$setProp(_el$17, "width", "100%");
    _$setProp(_el$17, "height", "100%");
    _$setProp(_el$17, "zIndex", 2600);
    _$setProp(_el$17, "onMouseDown", e => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      props.onClose();
    });
    _$insertNode(_el$18, _el$19);
    _$setProp(_el$18, "position", "absolute");
    _$setProp(_el$18, "width", 20);
    _$setProp(_el$18, "height", 1);
    _$setProp(_el$18, "paddingLeft", 1);
    _$setProp(_el$18, "paddingRight", 1);
    _$setProp(_el$18, "backgroundColor", hovered);
    _$setProp(_el$18, "onMouseDown", e => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
    });
    _$setProp(_el$18, "onMouseUp", e => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (e?.button !== 0) return;
      run();
    });
    _$setProp(_el$19, "wrapMode", "none");
    _$setProp(_el$19, "truncate", true);
    _$insert(_el$19, label);
    _$effect(_p$ => {
      var _v$13 = left(),
        _v$14 = top(),
        _v$15 = context.theme.text.base;
      _v$13 !== _p$.e && (_p$.e = _$setProp(_el$18, "left", _v$13, _p$.e));
      _v$14 !== _p$.t && (_p$.t = _$setProp(_el$18, "top", _v$14, _p$.t));
      _v$15 !== _p$.a && (_p$.a = _$setProp(_el$19, "fg", _v$15, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$17;
  })();
}
function SessionsByProject(props) {
  const context = props.context;
  const groups = createMemo(() => groupSessions(props.sessions(), props.projects(), props.showArchived(), props.order()));
  const [frame, setFrame] = createSignal(0);
  const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER.length), 90);
  onCleanup(() => clearInterval(timer));
  const tabs = createMemo(() => {
    const list = context.ui.tabs?.list?.() ?? [];
    return new Map(list.map(t => [t.sessionID, t]));
  });
  const childMap = createMemo(() => {
    const map = new Map();
    for (const s of props.sessions()) {
      if (!s.parentID) continue;
      const arr = map.get(s.parentID) ?? [];
      arr.push(s);
      map.set(s.parentID, arr);
    }
    return map;
  });
  const [dropTarget, setDropTarget] = createSignal();
  let drag;
  let suppressOpenUntil = 0;

  // One entry per rendered line, so a drag can map the pointer row to a group
  // and an insertion index. Relative line numbers are enough because the source
  // row's screen position anchors the map.
  const layout = () => {
    const entries = [];
    let line = 0;
    for (const group of groups()) {
      entries.push({
        type: "group",
        group,
        index: 0,
        line
      });
      let end = line;
      if (props.collapsed()[group.key] !== true) {
        group.rows.forEach((row, index) => {
          end += 1;
          entries.push({
            type: "row",
            group,
            row,
            index,
            line: end
          });
        });
      }
      line = end + 2;
    }
    return entries;
  };
  const beginDrag = (session, group, event) => {
    if (event?.button !== 0) return;
    const entry = layout().find(item => item.type === "row" && item.row.id === session.id);
    if (!entry) return;
    drag = {
      sessionID: session.id,
      sourceKey: group.key,
      sourceIndex: entry.index,
      contentTop: event.y - entry.line,
      target: undefined
    };
  };
  const updateDrag = event => {
    if (!drag) return;
    const entries = layout();
    if (!entries.length) return;
    const line = event.y - drag.contentTop;
    let target;
    if (line <= entries[0].line) {
      target = {
        group: entries[0].group,
        index: 0,
        groupTarget: true
      };
    } else {
      const next = entries.find(item => item.line >= line);
      if (!next) {
        const last = entries[entries.length - 1];
        target = {
          group: last.group,
          index: last.type === "row" ? last.group.rows.length : 0,
          groupTarget: false
        };
      } else if (next.type === "group") {
        target = {
          group: next.group,
          index: 0,
          groupTarget: true
        };
      } else {
        target = {
          group: next.group,
          index: next.index,
          groupTarget: false
        };
      }
    }
    drag.target = target;
    setDropTarget({
      groupKey: target.group.key,
      index: target.index,
      group: target.groupTarget
    });
  };
  const endDrag = () => {
    const current = drag;
    drag = undefined;
    setDropTarget(undefined);
    if (!current || !current.target) return;
    suppressOpenUntil = Date.now() + 300;
    const source = groups().find(group => group.key === current.sourceKey);
    const target = current.target.group;
    if (!source) return;
    if (source.key === target.key && current.target.index === current.sourceIndex) return;
    if (props.collapsed()[target.key] === true) props.toggle(target.key);
    const fullOrder = group => {
      const key = group.dir || group.key;
      const known = [...(props.order()[key] ?? [])];
      const seen = new Set(known);
      const missing = group.rows.map(row => row.id).filter(id => !seen.has(id));
      return [...missing, ...known];
    };
    const sessionID = current.sessionID;
    const sourceOrder = fullOrder(source).filter(id => id !== sessionID);
    let targetOrder = source.key === target.key ? sourceOrder : fullOrder(target).filter(id => id !== sessionID);
    const anchor = current.target.index < target.rows.length ? target.rows[current.target.index].id : undefined;
    if (anchor === sessionID) return;
    if (anchor) {
      const at = targetOrder.indexOf(anchor);
      targetOrder.splice(at === -1 ? targetOrder.length : at, 0, sessionID);
    } else {
      const last = target.rows[target.rows.length - 1]?.id;
      const at = last ? targetOrder.indexOf(last) + 1 : 0;
      targetOrder.splice(at < 0 || at > targetOrder.length ? targetOrder.length : at, 0, sessionID);
    }
    props.onDrop({
      sessionID,
      sourceKey: source.dir || source.key,
      targetKey: target.dir || target.key,
      sourceDir: source.dir,
      targetDir: target.dir,
      sourceOrder,
      targetOrder
    });
  };
  const openSession = session => {
    if (drag?.target) return;
    if (Date.now() < suppressOpenUntil) {
      suppressOpenUntil = 0;
      return;
    }
    if (props.unreadLocal()[session.id]) props.toggleUnread(session.id);
    context.ui.router.navigate({
      type: "session",
      sessionID: session.id
    });
  };
  return (() => {
    var _el$20 = _$createElement("box"),
      _el$21 = _$createElement("box"),
      _el$22 = _$createElement("text"),
      _el$24 = _$createElement("box"),
      _el$25 = _$createElement("text"),
      _el$27 = _$createElement("text");
    _$insertNode(_el$20, _el$21);
    _$setProp(_el$20, "flexDirection", "column");
    _$setProp(_el$20, "paddingTop", 1);
    _$setProp(_el$20, "gap", 1);
    _$setProp(_el$20, "onMouseDrag", event => updateDrag(event));
    _$setProp(_el$20, "onMouseDragEnd", endDrag);
    _$setProp(_el$20, "onMouseUp", () => endDrag());
    _$insert(_el$20, _$createComponent(TodoPanel, {
      context: context,
      get sessionID() {
        return props.sessionID;
      },
      get revision() {
        return props.revision;
      }
    }), _el$21);
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$24);
    _$setProp(_el$21, "flexDirection", "row");
    _$setProp(_el$21, "paddingRight", 1);
    _$insertNode(_el$22, _$createTextNode(`Jump to session`));
    _$setProp(_el$22, "attributes", 1);
    _$setProp(_el$22, "flexGrow", 1);
    _$setProp(_el$22, "minWidth", 0);
    _$setProp(_el$22, "wrapMode", "none");
    _$setProp(_el$22, "truncate", true);
    _$insertNode(_el$24, _el$25);
    _$insertNode(_el$24, _el$27);
    _$setProp(_el$24, "flexDirection", "row");
    _$setProp(_el$24, "gap", 1);
    _$setProp(_el$24, "flexShrink", 0);
    _$insertNode(_el$25, _$createTextNode(`≡`));
    _$setProp(_el$25, "onMouseUp", () => props.toggleArchived());
    _$insertNode(_el$27, _$createTextNode(`+`));
    _$setProp(_el$27, "onMouseUp", () => props.newProject());
    _$insert(_el$20, _$createComponent(For, {
      get each() {
        return groups();
      },
      children: group => {
        const isCollapsed = () => props.collapsed()[group.key] === true;
        return (() => {
          var _el$29 = _$createElement("box"),
            _el$30 = _$createElement("box"),
            _el$31 = _$createElement("box"),
            _el$32 = _$createElement("text"),
            _el$33 = _$createElement("text"),
            _el$34 = _$createElement("text");
          _$insertNode(_el$29, _el$30);
          _$setProp(_el$29, "flexDirection", "column");
          _$insertNode(_el$30, _el$31);
          _$insertNode(_el$30, _el$34);
          _$setProp(_el$30, "flexDirection", "row");
          _$setProp(_el$30, "gap", 1);
          _$setProp(_el$30, "paddingRight", 1);
          _$setProp(_el$30, "onMouseUp", e => {
            if (e?.button !== 2) return;
            e.preventDefault?.();
            e.stopPropagation?.();
            const project = props.projects().find(p => p.id === group.key);
            if (project) props.openProjectMenu(project, e.x ?? 0, e.y ?? 0);
          });
          _$insertNode(_el$31, _el$32);
          _$insertNode(_el$31, _el$33);
          _$setProp(_el$31, "flexDirection", "row");
          _$setProp(_el$31, "gap", 1);
          _$setProp(_el$31, "flexGrow", 1);
          _$setProp(_el$31, "minWidth", 0);
          _$setProp(_el$31, "onMouseUp", e => {
            if (e?.button !== 0) return;
            props.toggle(group.key);
          });
          _$setProp(_el$32, "flexShrink", 0);
          _$insert(_el$32, () => isCollapsed() ? "▶" : "▼");
          _$setProp(_el$33, "wrapMode", "none");
          _$setProp(_el$33, "truncate", true);
          _$setProp(_el$33, "flexGrow", 1);
          _$setProp(_el$33, "minWidth", 0);
          _$insert(_el$33, () => `${group.label} (${group.rows.length})`);
          _$insertNode(_el$34, _$createTextNode(`+`));
          _$setProp(_el$34, "flexShrink", 0);
          _$setProp(_el$34, "onMouseUp", e => {
            if (e?.button !== 0) return;
            e.stopPropagation?.();
            props.createSession(group.dir);
          });
          _$insert(_el$29, _$createComponent(Show, {
            get when() {
              return !isCollapsed();
            },
            get children() {
              return _$createComponent(For, {
                get each() {
                  return group.rows;
                },
                children: (session, index) => _$createComponent(SessionRow, {
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
                  get decoration() {
                    return props.decorations()[session.id];
                  },
                  get onOpenMenu() {
                    return props.openMenu;
                  },
                  onOpen: () => openSession(session),
                  onDragStart: event => beginDrag(session, group, event),
                  onDrag: event => updateDrag(event),
                  onDragEnd: endDrag,
                  get drop() {
                    return _$memo(() => !!(dropTarget()?.groupKey === group.key && !dropTarget()?.group))() && dropTarget()?.index === index();
                  },
                  get localUnread() {
                    return props.unreadLocal()[session.id] === true;
                  },
                  childMap: childMap
                })
              });
            }
          }), null);
          _$effect(_p$ => {
            var _v$19 = dropTarget()?.groupKey === group.key && dropTarget()?.group ? context.theme.background?.action?.primary?.hovered ?? context.theme.background?.element : undefined,
              _v$20 = context.theme.text.muted,
              _v$21 = context.theme.text.base,
              _v$22 = context.theme.text.base;
            _v$19 !== _p$.e && (_p$.e = _$setProp(_el$30, "backgroundColor", _v$19, _p$.e));
            _v$20 !== _p$.t && (_p$.t = _$setProp(_el$32, "fg", _v$20, _p$.t));
            _v$21 !== _p$.a && (_p$.a = _$setProp(_el$33, "fg", _v$21, _p$.a));
            _v$22 !== _p$.o && (_p$.o = _$setProp(_el$34, "fg", _v$22, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$29;
        })();
      }
    }), null);
    _$effect(_p$ => {
      var _v$16 = context.theme.text.base,
        _v$17 = props.showArchived() ? context.theme.hue?.orange?.[200] ?? context.theme.text.base : context.theme.text.muted,
        _v$18 = context.theme.text.muted;
      _v$16 !== _p$.e && (_p$.e = _$setProp(_el$22, "fg", _v$16, _p$.e));
      _v$17 !== _p$.t && (_p$.t = _$setProp(_el$25, "fg", _v$17, _p$.t));
      _v$18 !== _p$.a && (_p$.a = _$setProp(_el$27, "fg", _v$18, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$20;
  })();
}

// Shows the same panel on the home / new-session screen, as a right overlay.
// Compact MCP connection indicator for the prompt footer, so it stays visible
// after the sidebar's built-in MCP section is replaced.
function McpStatus(props) {
  const context = props.context;
  const servers = createMemo(() => context.data?.location?.mcp?.server?.list?.(context.location) ?? []);
  const failed = () => servers().filter(s => s?.status?.status === "failed");
  const connected = () => servers().filter(s => s?.status?.status === "connected");
  return _$createComponent(Show, {
    get when() {
      return servers().length > 0;
    },
    get children() {
      var _el$36 = _$createElement("text");
      _$setProp(_el$36, "onMouseUp", () => context.keymap?.dispatch?.("mcp.list"));
      _$insert(_el$36, (() => {
        var _c$ = _$memo(() => failed().length > 0);
        return () => _c$() ? `MCP ${failed().length} failed` : `MCP ${connected().length}`;
      })());
      _$effect(_$p => _$setProp(_el$36, "fg", failed().length > 0 ? context.theme.text.feedback?.error?.base ?? context.theme.text.base : connected().length > 0 ? context.theme.text.feedback?.success?.base ?? context.theme.text.muted : context.theme.text.muted, _$p));
      return _el$36;
    }
  });
}
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
      var _el$37 = _$createElement("box"),
        _el$38 = _$createElement("scrollbox");
      _$insertNode(_el$37, _el$38);
      _$setProp(_el$37, "position", "absolute");
      _$setProp(_el$37, "top", 1);
      _$setProp(_el$37, "right", 0);
      _$setProp(_el$37, "bottom", 0);
      _$setProp(_el$37, "width", 44);
      _$setProp(_el$37, "paddingLeft", 1);
      _$setProp(_el$37, "paddingRight", 1);
      _$setProp(_el$38, "flexGrow", 1);
      _$setProp(_el$38, "minHeight", 0);
      _$setProp(_el$38, "width", "100%");
      _$setProp(_el$38, "verticalScrollbarOptions", {
        visible: true
      });
      _$insert(_el$38, () => props.children);
      _$effect(_$p => _$setProp(_el$37, "backgroundColor", context.theme.background?.raised?.base ?? context.theme.background?.element, _$p));
      return _el$37;
    }
  });
}
export default Plugin.define({
  id: "jump-sidebar",
  setup(context) {
    trace("setup");
    trace(`keys ctx=${Object.keys(context).join(",")}`);
    trace(`keys ui=${Object.keys(context.ui ?? {}).join(",")}`);
    trace(`keys data=${Object.keys(context.data ?? {}).join(",")}`);
    trace(`keys app=${Object.keys(context.app ?? {}).join(",")}`);
    trace(`keys renderer=${Object.keys(context.renderer ?? {}).join(",")}`);
    const cb = context.renderer?.clipboard;
    trace(`clipboard proto=${Object.getOwnPropertyNames(Object.getPrototypeOf(cb ?? {})).join(",")}`);
    const rp = context.renderer;
    trace(`renderer proto=${Object.getOwnPropertyNames(Object.getPrototypeOf(rp ?? {})).filter(k => /clip|copy|paste/i.test(k)).join(",")}`);
    try {
      trace(`prompt commands=${(context.keymap?.commands?.() ?? []).map(c => c.id).filter(id => id.startsWith("prompt")).join(",")}`);
    } catch (err) {
      trace(`keymap error ${err?.message ?? err}`);
    }
    const [sessions, setSessions] = createSignal([]);
    const [projects, setProjects] = createSignal([]);
    // Bumped on every refresh so the todo panel recomputes from the message store.
    const [revision, setRevision] = createSignal(0);
    const [working, setWorking] = createSignal({});
    const [kinds, setKinds] = createSignal({});
    const [decorations, setDecorations] = createSignal({});
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
      setDecorations(readDecorations());
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

        // Do not pass `archived` here. OpenCode treats it strictly as a filter
        // (true = only archived, false = only live), so either value hides half
        // the sessions. Omitting it returns every session, archived included.
        const requests = [context.client.session.list({
          limit: 1000
        }).then(unwrap).catch(() => []), ...projects.map(project => context.client.session.list({
          directory: projectDir(project),
          limit: 1000
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
      setRevision(n => n + 1);
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
      const archived = isArchivedTitle(title);
      const next = archived ? toUnarchivedTitle(title) : toArchivedTitle(title);
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

    // Sessions that belong to a project, using the same key rules as the sidebar
    // grouping, and that still need archiving.
    const projectChildren = project => {
      const dir = projectDir(project);
      return sessions().filter(s => !isArchived(s) && (s.projectID === project.id || !s.projectID && (s.location?.directory ?? s.directory) === dir));
    };

    // Archive/unarchive a project by prefixing its name. Archiving a project also
    // archives every session in it that is not already archived.
    const toggleProjectArchive = async project => {
      const label = project?.name || basename(projectDir(project)) || projectDir(project);
      const archived = isArchivedTitle(project?.name);
      try {
        if (!archived) {
          const children = projectChildren(project);
          const ok = await context.ui.dialog.confirm({
            title: "Archive project",
            message: children.length > 0 ? `Archive "${label}" and ${children.length} session${children.length === 1 ? "" : "s"}?` : `Archive "${label}"?`,
            label: {
              confirm: "Archive",
              cancel: "Cancel"
            }
          });
          if (!ok) return;
          const next = toArchivedTitle(label);
          await context.client.project.update({
            projectID: project.id,
            name: next
          });
          setProjects(prev => prev.map(p => p.id === project.id ? {
            ...p,
            name: next
          } : p));
          const results = await Promise.allSettled(children.map(s => context.client.session.update({
            sessionID: s.id,
            title: toArchivedTitle(s.title || defaultTitle(s))
          })));
          const failed = results.filter(r => r.status === "rejected").length;
          if (failed) {
            context.ui.toast.show({
              message: `${failed} session${failed === 1 ? "" : "s"} could not be archived`,
              variant: "warning"
            });
          }
          schedule();
          return;
        }
        const next = toUnarchivedTitle(project?.name ?? label);
        await context.client.project.update({
          projectID: project.id,
          name: next
        });
        setProjects(prev => prev.map(p => p.id === project.id ? {
          ...p,
          name: next
        } : p));
        schedule();
      } catch (err) {
        context.ui.toast.show({
          message: `Project archive failed: ${err?.message ?? err}`,
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

    // Manual session order, keyed by project directory. Sessions missing from a
    // list (new ones) sort above it until the next drag records them.
    let order;
    let updateOrder;
    try {
      const [store, update] = context.storage.store("jump-sidebar.order", {
        initial: {}
      });
      order = () => (typeof store === "function" ? store() : store) ?? {};
      updateOrder = fn => update(fn);
    } catch {
      const [sig, set] = createSignal({});
      order = sig;
      updateOrder = fn => set(prev => {
        const next = {
          ...prev
        };
        fn(next);
        return next;
      });
    }
    const handleSessionDrop = async request => {
      const beforeSource = [...(order()[request.sourceKey] ?? [])];
      const beforeTarget = [...(order()[request.targetKey] ?? [])];
      updateOrder(draft => {
        draft[request.sourceKey] = request.sourceOrder;
        draft[request.targetKey] = request.targetOrder;
      });
      if (!request.targetDir || request.sourceDir === request.targetDir) return;
      try {
        await context.client.session.move({
          sessionID: request.sessionID,
          directory: request.targetDir
        });
        schedule();
      } catch (err) {
        updateOrder(draft => {
          draft[request.sourceKey] = beforeSource;
          draft[request.targetKey] = beforeTarget;
        });
        context.ui.toast.show({
          message: `Move failed: ${err?.message ?? err}`,
          variant: "error"
        });
      }
    };

    // Right-click Move to... picks a destination project and moves the session
    // there, the same operation as dragging it onto that project.
    const moveToProject = async sessionID => {
      const session = sessions().find(s => s.id === sessionID) ?? context.data.session.get?.(sessionID);
      const sourceDir = session?.location?.directory ?? session?.directory;
      const options = projects().filter(project => {
        const dir = projectDir(project);
        return Boolean(dir) && dir !== sourceDir && !isArchivedTitle(project.name);
      }).map(project => ({
        title: project.name || basename(projectDir(project)),
        value: project.id,
        description: projectDir(project)
      }));
      if (!options.length) {
        context.ui.toast.show({
          message: "No other projects",
          variant: "warning"
        });
        return;
      }
      const projectID = await context.ui.dialog.select({
        title: "Move session to",
        placeholder: "Project",
        options
      });
      if (!projectID) return;
      const project = projects().find(p => p.id === projectID);
      const targetDir = projectDir(project);
      if (!project || !targetDir || targetDir === sourceDir) return;
      const sourceKey = sourceDir ?? "";
      const targetKey = targetDir;
      const beforeSource = [...(order()[sourceKey] ?? [])];
      const beforeTarget = [...(order()[targetKey] ?? [])];
      updateOrder(draft => {
        if (sourceKey) {
          draft[sourceKey] = (draft[sourceKey] ?? []).filter(id => id !== sessionID);
        }
        draft[targetKey] = [sessionID, ...(draft[targetKey] ?? []).filter(id => id !== sessionID)];
      });
      try {
        await context.client.session.move({
          sessionID,
          directory: targetDir
        });
        schedule();
      } catch (err) {
        updateOrder(draft => {
          if (sourceKey) draft[sourceKey] = beforeSource;
          draft[targetKey] = beforeTarget;
        });
        context.ui.toast.show({
          message: `Move failed: ${err?.message ?? err}`,
          variant: "error"
        });
      }
    };

    // Right-click menu shared by every session row. The row reports the click
    // and the state; the actions live here.
    const [sessionMenu, setSessionMenu] = createSignal();
    const openSessionMenu = state => setSessionMenu(state);
    const closeSessionMenu = () => setSessionMenu(undefined);
    const [projectMenu, setProjectMenu] = createSignal();
    const openProjectMenu = (project, x, y) => setProjectMenu({
      project,
      x,
      y
    });
    const closeProjectMenu = () => setProjectMenu(undefined);

    // Session navigation history for the history keybinds. OpenCode declares
    // session.tab.history.back and session.tab.history.forward but ships no command
    // behind either one, so the plugin supplies them. The stack is in memory and
    // browser style, with a cursor that new visits truncate.
    const HISTORY_LIMIT = 100;
    let historyEntries = [];
    let historyIndex = -1;
    const historyRoot = sessionID => {
      try {
        return context.data.session?.root?.(sessionID) ?? sessionID;
      } catch {
        return sessionID;
      }
    };
    const historyRecord = sessionID => {
      if (historyEntries[historyIndex] === sessionID) return;
      const entries = [...historyEntries.slice(0, historyIndex + 1), sessionID].slice(-HISTORY_LIMIT);
      historyEntries = entries;
      historyIndex = entries.length - 1;
    };
    const historyMove = direction => {
      const route = context.ui.router.current();
      const active = route?.type === "session" ? historyRoot(route.sessionID) : undefined;
      let open;
      try {
        if (context.ui.tabs?.enabled?.()) {
          open = new Set((context.ui.tabs.list?.() ?? []).map(tab => tab.sessionID));
        }
      } catch {}
      const candidates = direction === -1 ? historyEntries.slice(0, historyIndex).map((id, index) => ({
        id,
        index
      })).reverse() : historyEntries.slice(historyIndex + 1).map((id, index) => ({
        id,
        index: historyIndex + 1 + index
      }));
      const target = candidates.find(entry => entry.id !== active && (!open || open.has(entry.id)));
      if (!target) return undefined;
      historyIndex = target.index;
      return target.id;
    };
    const historyGo = direction => {
      const sessionID = historyMove(direction);
      if (!sessionID) return;
      try {
        if (context.ui.tabs?.focus?.(sessionID)) return;
      } catch {}
      context.ui.router.navigate({
        type: "session",
        sessionID
      });
    };

    // Archive/unarchive the current session using the same title convention as /archive.
    // Keymap layers must be registered from a rendered slot (as the built-ins do).
    // The keymap provider can mount after a hot reload, so retry briefly instead of
    // giving up and leaving the palette without our commands.
    let keymapRegistered = false;
    let keymapTimer;
    const registerKeymap = (attempt = 0) => {
      if (keymapRegistered) return;
      try {
        if (!context.keymap?.layer) throw new Error("keymap unavailable");
        context.keymap.layer(() => ({
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
          }, {
            id: "project.archive.toggle",
            title: "Archive / unarchive project",
            group: "Project",
            palette: true,
            run: async () => {
              const route = context.ui.router.current();
              const sessionID = route?.type === "session" ? route.sessionID : undefined;
              const session = sessions().find(s => s.id === sessionID) ?? context.data.session.get?.(sessionID);
              const project = projects().find(p => p.id === session?.projectID);
              if (!project) {
                context.ui.toast.show({
                  message: "Open a session in a project first",
                  variant: "warning"
                });
                return;
              }
              await toggleProjectArchive(project);
            }
          }, {
            id: "session.tabs.closeOthers",
            title: "Close other tabs",
            group: "Session",
            palette: true,
            run: async () => {
              const tabs = context.ui.tabs?.list?.() ?? [];
              for (const tab of tabs) {
                if (tab.active) continue;
                try {
                  context.ui.tabs.close(tab.sessionID);
                } catch {}
              }
            }
          }, {
            id: "session.tab.history.back",
            title: "Back in session history",
            group: "Session",
            palette: false,
            bind: "super+[",
            run: () => historyGo(-1)
          }, {
            id: "session.tab.history.forward",
            title: "Forward in session history",
            group: "Session",
            palette: false,
            bind: "super+]",
            run: () => historyGo(1)
          }],
          bindings: ["session.archive.toggle", "project.new"]
        }));
        keymapRegistered = true;
      } catch {
        if (attempt < 20) keymapTimer = setTimeout(() => registerKeymap(attempt + 1), 250);
      }
    };
    context.ui.slot({
      append: "app",
      render: () => {
        registerKeymap();
        return null;
      }
    });
    const sessionsPanel = sessionID => _$createComponent(SessionsByProject, {
      context: context,
      sessionID: sessionID,
      sessions: sessions,
      revision: revision,
      projects: projects,
      working: working,
      kinds: kinds,
      collapsed: collapsed,
      toggle: toggle,
      showArchived: showArchived,
      toggleArchived: toggleArchived,
      createSession: createSession,
      newProject: newProject,
      openMenu: openSessionMenu,
      openProjectMenu: openProjectMenu,
      unreadLocal: unreadLocal,
      toggleUnread: toggleUnread,
      order: order,
      onDrop: handleSessionDrop,
      decorations: decorations
    });
    context.ui.slot({
      replace: "sidebar.content",
      render: input => sessionsPanel(input?.sessionID)
    });

    // The built-in sidebar footer repeats the working directory. Keep it in the
    // prompt footer at the bottom left and out of the sidebar.
    context.ui.slot({
      replace: "sidebar.footer",
      render: () => null
    });

    // MCP status in the prompt footer, since the sidebar no longer shows it.
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => _$createComponent(McpStatus, {
        context: context
      })
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
    context.ui.slot({
      append: "app",
      render: () => _$createComponent(SessionHistoryTracker, {
        context: context,
        onVisit: sessionID => historyRecord(historyRoot(sessionID))
      })
    });
    context.ui.slot({
      append: "app",
      render: () => _$createComponent(Show, {
        get when() {
          return sessionMenu();
        },
        keyed: true,
        children: state => _$createComponent(SessionContextMenu, {
          context: context,
          state: state,
          onClose: closeSessionMenu,
          onArchive: sessionID => {
            closeSessionMenu();
            void toggleArchive(sessionID);
          },
          onUnread: sessionID => {
            closeSessionMenu();
            toggleUnread(sessionID);
          },
          onMove: sessionID => {
            closeSessionMenu();
            void moveToProject(sessionID);
          }
        })
      })
    });
    context.ui.slot({
      append: "app",
      render: () => _$createComponent(Show, {
        get when() {
          return projectMenu();
        },
        keyed: true,
        children: state => _$createComponent(ProjectContextMenu, {
          context: context,
          state: state,
          onClose: closeProjectMenu,
          onToggle: () => {
            void toggleProjectArchive(state.project);
          }
        })
      })
    });
    return () => {
      if (keymapTimer) clearTimeout(keymapTimer);
      clearTimeout(refetchTimer);
      clearInterval(poll);
      offs.forEach(off => off());
      stopListen?.();
    };
  }
});
