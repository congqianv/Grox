import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDesktop, type ProjectMeta } from "../../state/store";
import { usePreferences } from "../../state/preferences";
import { useI18n } from "../../lib/i18n";
import { fmtRelTime, fmtTokens } from "../../lib/format";
import { Wordmark } from "../fx/Wordmark";
import { Icon } from "../fx/Icon";
import type { Session, SessionMeta } from "../../bridge/types";
import { BlackHole } from "../fx/BlackHole";

const EMPTY_SESSIONS: SessionMeta[] = [];

export function Sidebar() {
  const { t, language } = useI18n();
  const width = usePreferences((state) => state.sidebarWidth);
  const sessionIndex = useDesktop((state) => state.sessionIndex);
  const sessions = useDesktop((state) => state.sessions);
  const activeId = useDesktop((state) => state.activeId);
  const activeProjectId = useDesktop((state) => state.activeProjectId);
  const projects = useDesktop((state) => state.projects);
  const view = useDesktop((state) => state.view);
  const openSession = useDesktop((state) => state.openSession);
  const goHome = useDesktop((state) => state.goHome);
  const newProject = useDesktop((state) => state.newProject);
  const account = useDesktop((state) => state.account);
  const billing = useDesktop((state) => state.billing);
  const setSettingsOpen = useDesktop((state) => state.setSettingsOpen);
  const setAccountSetupOpen = useDesktop((state) => state.setAccountSetupOpen);
  const logout = useDesktop((state) => state.logout);
  const refreshHistory = useDesktop((state) => state.refreshHistory);
  const historySyncing = useDesktop((state) => state.historySyncing);
  const historyCount = useDesktop((state) => state.historyCount);
  const historyError = useDesktop((state) => state.historyError);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );

  useEffect(() => {
    if (!activeProjectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.add(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  useEffect(() => {
    if (!accountOpen) return;
    const close = (event: PointerEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [accountOpen]);

  // Stable order: pin first, then insertion time (createdAt). Never re-rank by
  // lastOpenedAt — switching projects used to reshuffle the whole list.
  const orderedProjects = useMemo(
    () =>
      [...projects].sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned)
          || a.createdAt - b.createdAt
          || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [projects],
  );
  const orderedSessions = useMemo(
    () => [...sessionIndex].sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt,
    ),
    [sessionIndex],
  );
  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const session of orderedSessions) {
      const key = projectKey(session.cwd);
      const list = map.get(key);
      if (list) list.push(session);
      else map.set(key, [session]);
    }
    return map;
  }, [orderedSessions]);

  const activeProjects = orderedProjects.filter((project) => !project.archived);
  const archivedProjects = orderedProjects.filter((project) => project.archived);
  const foldableIds = activeProjects.map((project) => project.id);
  const allExpanded = foldableIds.length > 0 && foldableIds.every((id) => expandedProjectIds.has(id));

  const expandAll = () => setExpandedProjectIds(new Set(foldableIds));
  const collapseAll = () => setExpandedProjectIds(new Set());

  return (
    <aside className="relative flex shrink-0 flex-col border-r border-line bg-panel" style={{ width }}>
      <div className="flex h-12 items-center border-b border-line px-3.5">
        <button onClick={goHome} className="transition-opacity hover:opacity-70" title="Home">
          <Wordmark size={14} markSpin={view === "home" ? "slow" : false} />
        </button>
      </div>

      <div className="p-2.5">
        <button
          onClick={() => void newProject()}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-line2 bg-raise px-2.5 text-[12.5px] font-medium text-fg2 transition-colors hover:bg-high hover:text-fg"
        >
          <Icon name="plus" size={13} className="text-acc" />
          {t("newProject")}
          <span className="ml-auto text-[11px] font-normal text-faint">⌘N</span>
        </button>
        <button
          onClick={() => void refreshHistory()}
          disabled={historySyncing}
          title={historyError ?? (language === "zh-CN" ? "重新扫描 ~/.grok/sessions" : "Rescan ~/.grok/sessions")}
          className="mt-1 flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[12px] text-dim transition-colors hover:bg-high hover:text-fg2 disabled:cursor-wait disabled:opacity-60"
        >
          <Icon name="refresh" size={11} className={historySyncing ? "animate-orbit" : ""} />
          {historySyncing
            ? (language === "zh-CN" ? "正在导入 CLI 历史" : "Importing history")
            : (language === "zh-CN" ? "导入 CLI 历史" : "Import CLI history")}
          {historyCount > 0 && <span className="ml-auto text-faint">{historyCount}</span>}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionTitle
          label={t("projects")}
          count={projects.length}
          action={
            foldableIds.length > 0 ? (
              <button
                type="button"
                onClick={allExpanded ? collapseAll : expandAll}
                title={allExpanded ? t("collapseAll") : t("expandAll")}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-faint transition-colors hover:bg-high hover:text-fg2"
              >
                <Icon name={allExpanded ? "collapseAll" : "expandAll"} size={11} />
                <span className="hidden min-[220px]:inline">{allExpanded ? t("collapseAll") : t("expandAll")}</span>
              </button>
            ) : null
          }
        />
        <div className="space-y-1.5">
          {activeProjects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              active={project.id === activeProjectId}
              expanded={expandedProjectIds.has(project.id)}
              sessions={sessionsByProject.get(projectKey(project.path)) ?? EMPTY_SESSIONS}
              activeId={activeId}
              loadedSessions={sessions}
              onOpenSession={(id) => void openSession(id)}
              onToggle={() => setExpandedProjectIds((current) => {
                const next = new Set(current);
                if (next.has(project.id)) next.delete(project.id);
                else next.add(project.id);
                return next;
              })}
            />
          ))}
        </div>
        {archivedProjects.length > 0 && (
          <ArchiveGroup label={t("archived")}>
            {archivedProjects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                active={project.id === activeProjectId}
                expanded={expandedProjectIds.has(project.id)}
                sessions={sessionsByProject.get(projectKey(project.path)) ?? EMPTY_SESSIONS}
                activeId={activeId}
                loadedSessions={sessions}
                onOpenSession={(id) => void openSession(id)}
                onToggle={() => setExpandedProjectIds((current) => {
                  const next = new Set(current);
                  if (next.has(project.id)) next.delete(project.id);
                  else next.add(project.id);
                  return next;
                })}
              />
            ))}
          </ArchiveGroup>
        )}
      </div>

      <div ref={accountRef} className="relative flex h-12 shrink-0 items-center gap-2 border-t border-line px-2.5">
        <button
          onClick={() => setAccountOpen((open) => !open)}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-high text-[12px] font-medium leading-none text-fg2 transition-colors hover:bg-hover"
          title={t("account")}
        >
          {account?.profileImageUrl ? (
            <img src={account.profileImageUrl} alt="" className="h-full w-full object-cover" />
          ) : account?.email ? (
            account.email.slice(0, 1).toUpperCase()
          ) : (
            <Icon name="user" size={14} />
          )}
        </button>
        <button
          onClick={() => setAccountOpen((open) => !open)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-[12.5px] leading-tight text-fg2">{account?.email ?? t("account")}</p>
          <p className="mt-0.5 truncate text-[11px] leading-tight text-faint">
            {billing?.subscriptionTier ?? account?.subscriptionTier ?? (account?.authenticated ? "Grok" : t("login"))}
          </p>
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-high hover:text-fg"
          title={t("settings")}
        >
          <Icon name="gear" size={14} />
        </button>

        {accountOpen && (
          <div className="absolute bottom-12 left-2 z-50 w-[240px] rounded-lg border border-line2 bg-raise p-1.5 shadow-[var(--shadow-float)]">
            <div className="border-b border-line px-2.5 py-2">
              <p className="truncate text-[13px] font-medium text-fg">{account?.email ?? t("signInRequired")}</p>
              <p className="mt-0.5 text-[11.5px] text-mute">
                {billing?.subscriptionTier ?? account?.subscriptionTier ?? "—"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-1.5 border-b border-line p-1.5">
              <Limit label={t("fiveHour")} value={t("unavailable")} />
              <Limit
                label={t("weekly")}
                value={billing?.creditUsagePercent !== undefined ? `${Math.round(billing.creditUsagePercent)}%` : t("unavailable")}
              />
            </div>
            <div className="p-0.5">
              <MenuButton icon="gear" label={t("settings")} onClick={() => { setSettingsOpen(true); setAccountOpen(false); }} />
              {account?.authenticated ? (
                <MenuButton icon="external" label={t("upgrade")} onClick={() => void invoke("open_external", { url: "https://grok.com/supergrok?referrer=grok-build" })} />
              ) : (
                <MenuButton icon="user" label={t("login")} onClick={() => { setAccountSetupOpen(true); setAccountOpen(false); }} />
              )}
              {account?.authenticated && (
                <MenuButton icon="x" label={t("logout")} tone="text-red" onClick={() => void logout()} />
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

const projectKey = (path: string) =>
  path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

function ProjectGroup({
  project,
  active,
  expanded,
  sessions,
  activeId,
  loadedSessions,
  onOpenSession,
  onToggle,
}: {
  project: ProjectMeta;
  active: boolean;
  expanded: boolean;
  sessions: SessionMeta[];
  activeId: string | null;
  loadedSessions: Record<string, Session>;
  onOpenSession(id: string): void;
  onToggle(): void;
}) {
  const { t } = useI18n();
  const visible = sessions.filter((session) => !session.archived);
  const archived = sessions.filter((session) => session.archived);
  return (
    <div
      className={`rounded-lg transition-colors ${
        expanded
          ? "border border-line2/80 bg-raise/40 pb-1.5 pt-0.5"
          : "border border-transparent"
      }`}
    >
      <ProjectRow
        project={project}
        active={active}
        expanded={expanded}
        count={visible.length}
        onToggle={onToggle}
      />
      {expanded && (
        <div className="relative ml-3.5 mt-1 space-y-0.5 border-l border-line3/50 pl-3">
          <p className="mb-0.5 px-1 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">
            {t("sessions")}
          </p>
          {visible.length === 0 && archived.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-faint">{t("noMission")}</p>
          ) : (
            <>
              {visible.map((meta) => (
                <MissionRow
                  key={meta.id}
                  meta={meta}
                  running={loadedSessions[meta.id]?.status === "running"}
                  awaiting={["awaiting_permission", "awaiting_input"].includes(loadedSessions[meta.id]?.status ?? "")}
                  active={meta.id === activeId}
                  tokens={(loadedSessions[meta.id]?.usage.inputTokens ?? 0) + (loadedSessions[meta.id]?.usage.outputTokens ?? 0)}
                  onOpen={() => onOpenSession(meta.id)}
                />
              ))}
              {archived.length > 0 && (
                <ArchiveGroup label={t("archived")}>
                  {archived.map((meta) => (
                    <MissionRow
                      key={meta.id}
                      meta={meta}
                      running={false}
                      awaiting={false}
                      active={meta.id === activeId}
                      tokens={(loadedSessions[meta.id]?.usage.inputTokens ?? 0) + (loadedSessions[meta.id]?.usage.outputTokens ?? 0)}
                      onOpen={() => onOpenSession(meta.id)}
                    />
                  ))}
                </ArchiveGroup>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({
  label,
  count,
  action,
}: {
  label: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-1 flex h-7 items-center justify-between gap-1 px-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mute">{label}</span>
      <div className="flex items-center gap-1">
        {action}
        <span className="tnum text-[11px] text-faint">{count}</span>
      </div>
    </div>
  );
}

function ArchiveGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group/archive mt-1">
      <summary className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-faint transition-colors hover:bg-high hover:text-mute">
        <Icon name="chevronRight" size={9} className="transition-transform group-open/archive:rotate-90" />
        {label}
      </summary>
      {children}
    </details>
  );
}

function ProjectRow({ project, active, expanded, count, onToggle }: { project: ProjectMeta; active: boolean; expanded: boolean; count: number; onToggle(): void }) {
  const { t } = useI18n();
  const openProject = useDesktop((state) => state.openProject);
  const renameProject = useDesktop((state) => state.renameProject);
  const pinProject = useDesktop((state) => state.pinProject);
  const archiveProject = useDesktop((state) => state.archiveProject);
  const removeProject = useDesktop((state) => state.removeProject);
  const openExplorer = useDesktop((state) => state.openProjectInExplorer);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const commit = () => {
    setEditing(false);
    renameProject(project.id, draft);
  };

  return (
    <div
      className={`group relative flex h-9 items-center gap-1 rounded-md px-1.5 ${
        active
          ? "bg-high text-fg"
          : "text-fg2 hover:bg-high/45"
      }`}
      title={project.path}
    >
      <button
        onClick={onToggle}
        className="flex h-7 w-6 shrink-0 items-center justify-center text-faint hover:text-fg"
        title={expanded ? t("collapse") : t("expand")}
      >
        <Icon name="chevronRight" size={11} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      <button onClick={() => void openProject(project.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] ${
            active ? "bg-acc text-base" : "bg-high text-mute ring-1 ring-line2"
          }`}
        >
          <Icon name={project.pinned ? "pin" : expanded ? "folderOpen" : "folder"} size={12} />
        </span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === "Enter" && commit()}
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 rounded border border-line2 bg-raise px-1.5 text-[12.5px] outline-none"
          />
        ) : (
          <span className="truncate text-[13px] font-semibold leading-none tracking-tight">{project.name}</span>
        )}
      </button>
      {count > 0 && (
        <span className="tnum shrink-0 rounded-full bg-void/60 px-1.5 py-0.5 text-[10px] font-medium text-dim ring-1 ring-line2">
          {count}
        </span>
      )}
      {/* Always reserve width — toggling display causes hover layout jitter. */}
      <button
        onClick={() => setMenu((open) => !open)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim opacity-0 transition-opacity hover:bg-raise hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Icon name="more" size={12} />
      </button>
      {menu && (
        <ContextMenu close={() => setMenu(false)}>
          <MenuButton icon="pin" label={project.pinned ? t("unpin") : t("pin")} onClick={() => pinProject(project.id)} />
          <MenuButton icon="external" label={t("openExplorer")} onClick={() => void openExplorer(project.id)} />
          <MenuButton icon="edit" label={t("rename")} onClick={() => setEditing(true)} />
          <MenuButton icon="archive" label={project.archived ? t("unarchive") : t("archive")} onClick={() => archiveProject(project.id)} />
          <MenuButton icon="x" label={t("remove")} tone="text-red" onClick={() => removeProject(project.id)} />
        </ContextMenu>
      )}
    </div>
  );
}

function MissionRow({ meta, running, awaiting, active, tokens, onOpen }: { meta: SessionMeta; running: boolean; awaiting: boolean; active: boolean; tokens: number; onOpen(): void }) {
  const { t } = useI18n();
  const renameSession = useDesktop((state) => state.renameSession);
  const deleteSession = useDesktop((state) => state.deleteSession);
  const pinSession = useDesktop((state) => state.pinSession);
  const archiveSession = useDesktop((state) => state.archiveSession);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState(meta.title);
  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== meta.title) renameSession(meta.id, title);
  };

  return (
    <div
      className={`group relative cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
        active
          ? "bg-base text-fg ring-1 ring-line2"
          : "bg-transparent text-mute hover:bg-high/70"
      }`}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${awaiting ? "opacity-90" : running ? "" : "opacity-50"}`}>
          {running || awaiting ? (
            <BlackHole size={11} spin={running ? true : "slow"} />
          ) : (
            <Icon name="chat" size={11} className={active ? "text-acc" : "text-faint"} />
          )}
        </span>
        {editing ? (
          <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => event.key === "Enter" && commit()} onClick={(event) => event.stopPropagation()} className="min-w-0 flex-1 rounded border border-line2 bg-raise px-1.5 text-[12.5px] text-fg outline-none" />
        ) : (
          <span className={`min-w-0 flex-1 truncate text-[12px] font-normal leading-snug ${active ? "font-medium text-fg" : "text-mute"}`}>{meta.title}</span>
        )}
        {/* Fixed slot — never toggle display or text reflow/jitter on hover. */}
        <button
          onClick={(event) => { event.stopPropagation(); setMenu((open) => !open); }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim opacity-0 transition-opacity hover:bg-raise hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Icon name="more" size={12} />
        </button>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 pl-6">
        <span className="min-w-0 truncate text-[10px] text-faint">{fmtRelTime(meta.updatedAt)}</span>
        {tokens > 0 && <span className="tnum shrink-0 text-[10px] text-faint">{fmtTokens(tokens)}</span>}
      </div>
      {menu && (
        <ContextMenu close={() => setMenu(false)}>
          <MenuButton icon="pin" label={meta.pinned ? t("unpin") : t("pin")} onClick={() => pinSession(meta.id)} />
          <MenuButton icon="edit" label={t("rename")} onClick={() => setEditing(true)} />
          <MenuButton icon="archive" label={meta.archived ? t("unarchive") : t("archive")} onClick={() => archiveSession(meta.id)} />
          <MenuButton icon="trash" label={t("delete")} tone="text-red" onClick={() => void deleteSession(meta.id)} />
        </ContextMenu>
      )}
    </div>
  );
}

function ContextMenu({ children, close }: { children: React.ReactNode; close(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [close]);
  return (
    <div ref={ref} className="absolute right-1 top-7 z-40 w-[min(200px,calc(100vw-24px))] overflow-hidden rounded-md border border-line2 bg-raise p-1 shadow-[var(--shadow-float)]" onClick={(event) => { event.stopPropagation(); close(); }}>
      {children}
    </div>
  );
}

function MenuButton({ icon, label, onClick, tone = "text-fg2" }: { icon: React.ComponentProps<typeof Icon>["name"]; label: string; onClick(): void; tone?: string }) {
  return (
    <button onClick={onClick} className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] leading-none transition-colors hover:bg-high ${tone}`}>
      <Icon name={icon} size={12} className="shrink-0 text-dim" />
      {label}
    </button>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-high px-2.5 py-2">
      <p className="text-[11px] leading-none text-faint">{label}</p>
      <p className="mt-1.5 truncate text-[12px] leading-none text-fg2">{value}</p>
    </div>
  );
}
