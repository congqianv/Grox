/* ─────────────────────────────────────────────────────────────────────────
   Central store. Owns session state, applies bridge events, exposes actions.
   The UI never touches the bridge directly.
   ───────────────────────────────────────────────────────────────────────── */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import { MODELS } from "../bridge/types";
import type {
  AgentMode,
  AccountInfo,
  AuthState,
  BillingInfo,
  BridgeEvent,
  Effort,
  PermissionOption,
  PermissionMode,
  QuestionResponse,
  ModelInfo,
  ModelState,
  PromptAttachment,
  ProviderStatus,
  Session,
  SessionBlock,
  SessionMeta,
  ToolCall,
  DiffHunk,
  PreviewFile,
  ProjectPreview,
  ProviderConfig,
  ProviderProfileSummary,
  SaveProviderProfile,
  GrokRuntimeInfo,
  WorkspaceEntry,
  RewindMode,
  RewindPoint,
  RewindResult,
} from "../bridge/types";
import { DEMO_CWD } from "../demo/data";

export type View = "home" | "session";
export type InspectorTab = "files" | "tasks" | "preview" | "usage";

export interface ProjectMeta {
  id: string;
  path: string;
  name: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  lastOpenedAt: number;
}

/** Result of checking GitHub Releases for a newer desktop build. */
export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  downloadUrl?: string | null;
  assetName?: string | null;
  publishedAt?: string | null;
  body?: string | null;
  checkedAt: number;
}

/** Live progress while downloading / installing an in-app update. */
export interface AppUpdateProgress {
  stage: "downloading" | "extracting" | "installing" | "restarting" | "error" | string;
  percent: number;
  downloaded: number;
  total?: number | null;
  message: string;
}

export type AppUpdateInstallPhase =
  | "idle"
  | "downloading"
  | "extracting"
  | "installing"
  | "restarting"
  | "error";

interface SessionFlags {
  pinned?: boolean;
  archived?: boolean;
}

export interface SessionComposerState {
  text: string;
  attachments: PromptAttachment[];
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
}

/** Follow-up prompts waiting for the active turn to finish (CLI-style queue). */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: PromptAttachment[];
  createdAt: number;
  state: "queued" | "interjected" | "sending";
  version?: number;
  source?: "local" | "cli";
}

/** Ephemeral operator-facing receipt for queue / interject / gate actions. */
export interface QueueNotice {
  id: string;
  message: string;
  state: import("../bridge/types").QueueReceiptState;
  entryId?: string;
  at: number;
}

interface DesktopState {
  ready: boolean;
  startupError: string | null;
  auth: AuthState;
  bridgeKind: "mock" | "acp";
  workspace: string;
  view: View;
  projects: ProjectMeta[];
  activeProjectId: string | null;

  sessionIndex: SessionMeta[];
  sessions: Record<string, Session>;
  activeId: string | null;
  account: AccountInfo | null;
  billing: BillingInfo | null;
  provider: ProviderStatus;
  providerProfiles: ProviderProfileSummary[];
  activeProviderProfileId?: string;
  providerSwitching: boolean;
  runtime: GrokRuntimeInfo | null;
  runtimeBusy: boolean;
  accountLoading: boolean;
  accountSetupOpen: boolean;

  workspaceFiles: WorkspaceEntry[];
  workspaceDiffs: DiffHunk[];
  workspaceDiffReady: boolean;
  projectPreview: ProjectPreview;
  previewOpen: boolean;
  previewFile: PreviewFile | null;
  previewLoading: boolean;
  previewError: string | null;

  model: string;
  models: ModelInfo[];
  modelsUpdatedAt: number;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
  sessionComposers: Record<string, SessionComposerState>;
  promptQueues: Record<string, QueuedPrompt[]>;
  /** Last queue/interject/gate receipt shown above the composer. */
  queueNotice: QueueNotice | null;

  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  paletteOpen: boolean;
  settingsOpen: boolean;
  historySyncing: boolean;
  historyCount: number;
  historyError: string | null;
  historySyncedAt: number;

  appVersion: string;
  appUpdate: AppUpdateInfo | null;
  appUpdateChecking: boolean;
  appUpdateError: string | null;
  appUpdateDismissedVersion: string | null;
  appUpdateInstalling: boolean;
  appUpdateInstallPhase: AppUpdateInstallPhase;
  appUpdateProgress: AppUpdateProgress | null;

  init(): Promise<void>;
  checkAppUpdate(opts?: { force?: boolean }): Promise<AppUpdateInfo | null>;
  dismissAppUpdate(): void;
  openAppUpdateDownload(): Promise<void>;
  /** macOS: download + replace .app + relaunch. Other platforms open the download page. */
  installAppUpdate(): Promise<void>;
  goHome(): void;
  openSession(id: string): Promise<void>;
  newSession(): Promise<void>;
  newProject(): Promise<void>;
  /**
   * Import one or more folders as projects (e.g. drag onto the sidebar list).
   * Validates each path as a directory, adds it to the project list, and
   * switches the active workspace to the last successful import.
   */
  importProjects(paths: string[]): Promise<{
    imported: string[];
    failed: { path: string; error: string }[];
  }>;
  openProject(id: string): Promise<void>;
  renameProject(id: string, name: string): void;
  pinProject(id: string): void;
  archiveProject(id: string): void;
  removeProject(id: string): void;
  openProjectInExplorer(id?: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): void;
  pinSession(id: string): void;
  archiveSession(id: string): void;
  setWorkspace(cwd: string): Promise<void>;
  authenticate(): Promise<void>;
  logout(): Promise<void>;
  refreshAccount(): Promise<void>;
  refreshModels(): Promise<void>;
  configureProvider(config: ProviderConfig): Promise<void>;
  refreshProviderProfiles(): Promise<void>;
  saveProviderProfile(config: SaveProviderProfile): Promise<ProviderProfileSummary>;
  refreshProviderModels(id: string): Promise<ProviderProfileSummary>;
  activateProviderProfile(id: string): Promise<void>;
  deleteProviderProfile(id: string): Promise<void>;
  refreshRuntime(): Promise<void>;
  useBundledRuntime(): Promise<void>;
  installOfficialRuntime(): Promise<void>;
  setAccountSetupOpen(open: boolean): void;
  refreshWorkspaceFiles(): Promise<void>;
  refreshWorkspaceDiffs(): Promise<void>;
  refreshProjectPreview(start?: boolean): Promise<void>;
  setProjectPreviewUrl(url: string): void;
  openPreview(path: string): Promise<void>;
  closePreview(): void;

  sendPrompt(text: string, attachments?: PromptAttachment[], sessionId?: string): void;
  /**
   * Same-turn interjection (Ctrl+Enter while busy).
   * Tries `x.ai/interject`; on older CLIs pins the message at the queue head.
   */
  interjectPrompt(text: string, attachments?: PromptAttachment[], sessionId?: string): Promise<void>;
  removeQueuedPrompt(sessionId: string, queueId: string): void;
  /** Reorder a pending follow-up before it drains (fromIndex → toIndex). */
  reorderQueuedPrompt(sessionId: string, fromIndex: number, toIndex: number): void;
  clearPromptQueue(sessionId?: string): void;
  /** Promote a queued entry to front and mark it for interjection drain order. */
  interjectQueuedPrompt(sessionId: string, queueId: string): void;
  /** Inline-edit a queued message (local + x.ai/queue/edit). */
  editQueuedPrompt(sessionId: string, queueId: string, text: string): void;
  dismissQueueNotice(): void;
  stop(): void;
  compact(): void;
  listRewindPoints(): Promise<RewindPoint[]>;
  previewRewind(targetPromptIndex: number, mode: RewindMode): Promise<RewindResult>;
  executeRewind(point: RewindPoint, mode: RewindMode): Promise<RewindResult>;
  /**
   * Rewind to a user prompt (conversation only), put its text in the composer
   * so the operator can edit and resend. Always removes that turn (and later
   * ones) from the local transcript so resend does not leave a duplicate bubble.
   * When no official checkpoint exists (e.g. mid-turn stop), truncates UI only.
   */
  editUserPrompt(promptIndex: number): Promise<void>;
  resolvePermission(blockId: string, option: PermissionOption): void;
  resolveQuestion(blockId: string, response: QuestionResponse): void;

  setModel(model: string): void;
  setEffort(effort: Effort): void;
  setMode(mode: AgentMode): void;
  setPermissionMode(mode: PermissionMode): void;
  setDraft(text: string): void;
  setComposerAttachments(attachments: PromptAttachment[]): void;
  setInspectorTab(tab: InspectorTab): void;
  toggleInspector(): void;
  setPaletteOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  refreshHistory(): Promise<void>;
}

const uid = () => crypto.randomUUID();
const SESSION_COMPOSERS_KEY = "grox.sessionComposers.v1";
let catalogPersistTimer: number | undefined;
let pendingCatalog: SessionMeta[] | undefined;
let composerPersistTimer: number | undefined;
let pendingComposerStates: Record<string, SessionComposerState> | undefined;
let historySyncPromise: Promise<void> | undefined;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeComposer(
  partial: Partial<SessionComposerState> | undefined,
  fallback: Pick<SessionComposerState, "model" | "effort" | "mode" | "permissionMode">,
): SessionComposerState {
  const model = typeof partial?.model === "string" && partial.model.trim()
    ? partial.model
    : fallback.model;
  const effort = partial?.effort && ["low", "medium", "high", "xhigh"].includes(partial.effort)
    ? partial.effort
    : fallback.effort;
  const mode = partial?.mode && ["agent", "plan", "ask"].includes(partial.mode)
    ? partial.mode
    : fallback.mode;
  const permissionMode = partial?.permissionMode && ["default", "auto", "bypass"].includes(partial.permissionMode)
    ? partial.permissionMode
    : fallback.permissionMode;
  return {
    text: typeof partial?.text === "string" ? partial.text : "",
    attachments: Array.isArray(partial?.attachments) ? partial.attachments : [],
    model,
    effort,
    mode,
    permissionMode,
  };
}

function loadSessionComposers(): Record<string, SessionComposerState> {
  const stored = loadJson<Record<string, Partial<SessionComposerState>>>(
    SESSION_COMPOSERS_KEY,
    {},
  );
  const fallback = {
    model: localStorage.getItem("grok.model") ?? "grok-build",
    effort: (localStorage.getItem("grok.effort") as Effort) ?? "high",
    mode: "agent" as AgentMode,
    permissionMode: (
      localStorage.getItem("grok.permissionMode") === "auto"
        ? "auto"
        : localStorage.getItem("grok.permissionMode") === "bypass"
          ? "bypass"
          : "default"
    ) as PermissionMode,
  };
  return Object.fromEntries(
    Object.entries(stored).map(([id, state]) => [
      id,
      normalizeComposer({ ...state, attachments: [] }, fallback),
    ]),
  );
}

function persistSessionComposers(states: Record<string, SessionComposerState>) {
  pendingComposerStates = states;
  if (composerPersistTimer !== undefined) return;
  composerPersistTimer = window.setTimeout(() => {
    const serializable = Object.fromEntries(
      Object.entries(pendingComposerStates ?? {}).map(([id, { attachments: _attachments, ...state }]) => [id, state]),
    );
    localStorage.setItem(SESSION_COMPOSERS_KEY, JSON.stringify(serializable));
    pendingComposerStates = undefined;
    composerPersistTimer = undefined;
  }, 300);
}

const projectId = (path: string) => path.replace(/[\\/]+$/, "").toLocaleLowerCase();
const projectName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
const samePath = (left: string, right: string) => projectId(left) === projectId(right);

const HIDDEN_PROJECTS_KEY = "grox.hiddenProjects";

/** In-memory cache; seeded from disk (~/.grok) then localStorage on init. */
let hiddenProjectIdsCache: Set<string> | null = null;
let hiddenProjectsHydrated = false;

function loadHiddenProjectIds(): Set<string> {
  if (hiddenProjectIdsCache) return hiddenProjectIdsCache;
  hiddenProjectIdsCache = new Set(loadJson<string[]>(HIDDEN_PROJECTS_KEY, []));
  return hiddenProjectIdsCache;
}

function persistHiddenProjectIds(ids: Set<string>) {
  hiddenProjectIdsCache = ids;
  localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...ids]));
  // Best-effort disk write so reinstall / new WebView data does not resurrect projects.
  if (bridge.kind === "acp") {
    void invoke("write_hidden_projects", { ids: [...ids] }).catch(() => {
      /* offline / older binary */
    });
  }
}

/** Merge disk-hidden ids into the in-memory set. Returns the merged set. */
async function hydrateHiddenProjectsFromDisk(): Promise<Set<string>> {
  const local = loadHiddenProjectIds();
  if (hiddenProjectsHydrated || bridge.kind !== "acp") return local;
  hiddenProjectsHydrated = true;
  try {
    const fromDisk = await invoke<string[]>("read_hidden_projects");
    if (!Array.isArray(fromDisk) || fromDisk.length === 0) return local;
    for (const id of fromDisk) {
      if (typeof id === "string" && id.trim()) local.add(id);
    }
    // Keep localStorage in sync; disk is source of truth across reinstalls.
    localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...local]));
    hiddenProjectIdsCache = local;
  } catch {
    /* command unavailable on older builds */
  }
  return local;
}

function filterHiddenProjects(projects: ProjectMeta[], hidden: Set<string>): ProjectMeta[] {
  if (hidden.size === 0) return projects;
  const next = projects.filter((project) => !hidden.has(project.id));
  if (next.length !== projects.length) {
    localStorage.setItem("grox.projects", JSON.stringify(next));
  }
  return next;
}

function hideProjectId(id: string) {
  const hidden = loadHiddenProjectIds();
  hidden.add(id);
  persistHiddenProjectIds(hidden);
}

/** Explicit open / pick workspace un-hides a previously removed project. */
function unhideProjectId(id: string) {
  const hidden = loadHiddenProjectIds();
  if (!hidden.has(id)) return;
  hidden.delete(id);
  persistHiddenProjectIds(hidden);
}

function ensureProject(projects: ProjectMeta[], path: string, opts?: { force?: boolean }): ProjectMeta[] {
  const id = projectId(path);
  // User deliberately opened this workspace — allow it back into the list.
  if (opts?.force) unhideProjectId(id);
  else if (loadHiddenProjectIds().has(id)) {
    // History import / passive discovery must not resurrect removed projects.
    return projects;
  }
  const now = Date.now();
  const current = projects.find((project) => project.id === id);
  // Do not bump lastOpenedAt on every ensure — that re-sorts the sidebar and makes it jump.
  if (current) {
    if (current.path === path) return projects;
    const next = projects.map((project) =>
      project.id === id ? { ...project, path } : project,
    );
    localStorage.setItem("grox.projects", JSON.stringify(next));
    return next;
  }
  // Prepend so newly imported projects sit at the front of the list
  // (sidebar also sorts by createdAt descending; pin still wins).
  const next = [
    {
      id,
      path,
      name: projectName(path),
      pinned: false,
      archived: false,
      createdAt: now,
      lastOpenedAt: now,
    },
    ...projects,
  ];
  localStorage.setItem("grox.projects", JSON.stringify(next));
  return next;
}

function decorateSessions(metas: SessionMeta[]) {
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  return metas.map((meta) => ({ ...meta, ...flags[meta.id] }));
}

function persistSessionCatalog(metas: SessionMeta[]) {
  if (catalogPersistTimer !== undefined) window.clearTimeout(catalogPersistTimer);
  catalogPersistTimer = undefined;
  pendingCatalog = undefined;
  const clean = metas.map(({ pinned: _pinned, archived: _archived, ...meta }) => meta);
  localStorage.setItem("grox.sessionCatalog", JSON.stringify(clean));
}

function mergeProjectSessions(
  existing: SessionMeta[],
  cwd: string,
  incoming: SessionMeta[],
): SessionMeta[] {
  const incomingIds = new Set(incoming.map((meta) => meta.id));
  const merged = [
    ...decorateSessions(incoming),
    ...existing.filter((meta) => !samePath(meta.cwd, cwd) && !incomingIds.has(meta.id)),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  persistSessionCatalog(merged);
  return merged;
}

function mergeAllSessions(existing: SessionMeta[], incoming: SessionMeta[]): SessionMeta[] {
  const incomingIds = new Set(incoming.map((meta) => meta.id));
  const merged = [
    ...decorateSessions(incoming),
    ...existing.filter((meta) => !incomingIds.has(meta.id)),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  persistSessionCatalog(merged);
  return merged;
}

function mergeDiscoveredProjects(projects: ProjectMeta[], sessions: SessionMeta[]): ProjectMeta[] {
  const next = [...projects];
  const known = new Set(next.map((project) => project.id));
  const hidden = loadHiddenProjectIds();
  for (const session of sessions) {
    const id = projectId(session.cwd);
    if (!session.cwd.trim() || known.has(id) || hidden.has(id)) continue;
    known.add(id);
    next.push({
      id,
      path: session.cwd,
      name: projectName(session.cwd),
      pinned: false,
      archived: false,
      createdAt: session.createdAt,
      lastOpenedAt: session.updatedAt,
    });
  }
  if (next.length !== projects.length) localStorage.setItem("grox.projects", JSON.stringify(next));
  return next;
}

function patchLines(path: string, patch: string, additions = 0, deletions = 0): DiffHunk {
  const lines = patch
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.startsWith("diff --git") && !line.startsWith("index ") && !line.startsWith("@@") && !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map((line) => ({
      kind: line.startsWith("+") ? "add" as const : line.startsWith("-") ? "del" as const : "ctx" as const,
      text: /^[ +\-]/.test(line) ? line.slice(1) : line,
    }));
  return {
    path,
    lines,
    added: additions || lines.filter((line) => line.kind === "add").length,
    removed: deletions || lines.filter((line) => line.kind === "del").length,
  };
}

function mapGitDiffs(value: unknown): DiffHunk[] {
  const envelope = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const resultValue = envelope.result ?? value;
  const result = resultValue && typeof resultValue === "object" ? resultValue as Record<string, unknown> : {};
  const files = Array.isArray(result.files) ? result.files : [];
  return files.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const file = entry as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "unknown";
    const patch = typeof file.patch === "string" ? file.patch : "";
    if (!patch && typeof file.oldText !== "string" && typeof file.newText !== "string") return [];
    if (patch) return [patchLines(path, patch, Number(file.additions) || 0, Number(file.deletions) || 0)];
    const oldText = typeof file.oldText === "string" ? file.oldText : "";
    const newText = typeof file.newText === "string" ? file.newText : "";
    const synthetic = `${oldText.split("\n").map((line) => `-${line}`).join("\n")}\n${newText.split("\n").map((line) => `+${line}`).join("\n")}`;
    return [patchLines(path, synthetic, Number(file.additions) || 0, Number(file.deletions) || 0)];
  });
}

function setSessionFlag(id: string, patch: SessionFlags) {
  const flags = loadJson<Record<string, SessionFlags>>("grox.sessionFlags", {});
  flags[id] = { ...flags[id], ...patch };
  localStorage.setItem("grox.sessionFlags", JSON.stringify(flags));
}

function resolveModelState(state: ModelState) {
  const models = state.models.length > 0 ? state.models : MODELS;
  const saved = localStorage.getItem("grok.model");
  const model =
    (saved && models.some((item) => item.id === saved) ? saved : undefined) ??
    (models.some((item) => item.id === state.currentId) ? state.currentId : models[0].id);
  localStorage.setItem("grok.model", model);
  return { models, model, modelsUpdatedAt: Date.now() };
}

function providerModelState(state: ModelState, profile?: ProviderProfileSummary): ModelState {
  if (!profile || profile.residentModels.length === 0) return state;
  return {
    currentId: profile.residentModels.includes(state.currentId) ? state.currentId : profile.residentModels[0],
    models: profile.residentModels.map((id) => state.models.find((item) => item.id === id) ?? {
      id,
      label: id,
      tagline: profile.name,
    }),
  };
}

/* StrictMode mounts effects twice in dev — subscribe once, ever. */
let bridgeSubscribed = false;
let workspaceWatchTimer: number | undefined;
let workspaceWatchTick = 0;

function scheduleSessionCatalog(metas: SessionMeta[]) {
  pendingCatalog = metas;
  if (catalogPersistTimer !== undefined) return;
  catalogPersistTimer = window.setTimeout(() => {
    if (pendingCatalog) persistSessionCatalog(pendingCatalog);
    pendingCatalog = undefined;
    catalogPersistTimer = undefined;
  }, 750);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (workspaceWatchTimer !== undefined) window.clearInterval(workspaceWatchTimer);
    if (catalogPersistTimer !== undefined) window.clearTimeout(catalogPersistTimer);
    if (composerPersistTimer !== undefined) window.clearTimeout(composerPersistTimer);
  });
}

function patchBlock(
  blocks: SessionBlock[],
  blockId: string,
  patch: Partial<SessionBlock>,
): SessionBlock[] {
  return blocks.map((b) => (b.id === blockId ? ({ ...b, ...patch } as SessionBlock) : b));
}

function patchTool(
  blocks: SessionBlock[],
  blockId: string,
  call: Partial<ToolCall>,
): SessionBlock[] {
  return blocks.map((b) =>
    b.id === blockId && b.type === "tool"
      ? { ...b, call: { ...b.call, ...call } as ToolCall }
      : b,
  );
}

export const useDesktop = create<DesktopState>((set, get) => {
  const applyEvent = (e: BridgeEvent) => {
    const { sessions, sessionIndex } = get();

    const withSession = (sessionId: string, fn: (s: Session) => Session, touchCatalogue = true) => {
      const state = get();
      const s = state.sessions[sessionId];
      if (!s) return;
      const next = { ...fn(s), updatedAt: Date.now() };
      if (!touchCatalogue) {
        set({ sessions: { ...state.sessions, [sessionId]: next } });
        return;
      }
      const nextIndex = state.sessionIndex.map((m) =>
        m.id === sessionId ? { ...m, updatedAt: next.updatedAt } : m,
      );
      scheduleSessionCatalog(nextIndex);
      set({
        sessions: { ...state.sessions, [sessionId]: next },
        sessionIndex: nextIndex,
      });
    };

    switch (e.type) {
      case "auth_state":
        set({ auth: e.state });
        if (!e.state.required && !e.state.inProgress && get().historySyncedAt === 0 && !get().historySyncing) {
          window.setTimeout(() => void get().refreshHistory(), 250);
        }
        break;
      case "model_state":
        {
          const currentState = get();
          const profile = currentState.providerProfiles.find((item) => item.id === currentState.activeProviderProfileId);
          const resolved = resolveModelState(providerModelState(e.state, profile));
          const { activeId, sessionComposers } = get();
          const active = activeId ? sessionComposers[activeId] : undefined;
          const model = active && resolved.models.some((item) => item.id === active.model)
            ? active.model
            : resolved.model;
          const nextComposers = activeId && active
            ? { ...sessionComposers, [activeId]: { ...active, model } }
            : sessionComposers;
          if (nextComposers !== sessionComposers) persistSessionComposers(nextComposers);
          set({ ...resolved, model, sessionComposers: nextComposers });
        }
        break;
      case "mode_state": {
        const state = get();
        const current = state.sessionComposers[e.sessionId];
        if (!current) {
          if (state.activeId === e.sessionId) set({ mode: e.mode });
          break;
        }
        const sessionComposers = {
          ...state.sessionComposers,
          [e.sessionId]: { ...current, mode: e.mode },
        };
        persistSessionComposers(sessionComposers);
        set({
          sessionComposers,
          ...(state.activeId === e.sessionId ? { mode: e.mode } : {}),
        });
        break;
      }
      case "session_meta": {
        const current = sessions[e.sessionId];
        const nextIndex = sessionIndex.map((meta) =>
          meta.id === e.sessionId ? { ...meta, ...e.patch } : meta,
        );
        persistSessionCatalog(nextIndex);
        set({
          sessions: current
            ? { ...sessions, [e.sessionId]: { ...current, ...e.patch } }
            : sessions,
          sessionIndex: nextIndex,
        });
        break;
      }
      case "session_ready": {
        const { blocks: _b, usage: _u, status: _st, ...meta } = e.session;
        const nextIndex = [
          decorateSessions([meta])[0],
          ...sessionIndex.filter((m) => m.id !== e.session.id),
        ];
        // Active session implies the project is in use — restore if previously removed.
        const projects = ensureProject(get().projects, e.session.cwd, { force: true });
        persistSessionCatalog(nextIndex);
        const state = get();
        const fallbackModel = state.models.some((item) => item.id === e.session.model)
          ? e.session.model
          : (state.model || state.models[0]?.id || MODELS[0]?.id || "grok-build");
        const composer = normalizeComposer(state.sessionComposers[e.session.id], {
          model: fallbackModel,
          effort: state.effort || "high",
          mode: state.mode || "agent",
          permissionMode: state.permissionMode || "default",
        });
        const sessionComposers = { ...state.sessionComposers, [e.session.id]: composer };
        persistSessionComposers(sessionComposers);
        bridge.setPermissionMode(composer.permissionMode);
        set({
          sessions: { ...sessions, [e.session.id]: e.session },
          sessionIndex: nextIndex,
          projects,
          workspace: e.session.cwd,
          activeProjectId: projectId(e.session.cwd),
          activeId: e.session.id,
          view: "session",
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          permissionMode: composer.permissionMode,
          sessionComposers,
        });
        break;
      }
      case "block_add":
        withSession(e.sessionId, (s) => ({ ...s, blocks: [...s.blocks, e.block] }));
        break;
      case "block_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: patchBlock(s.blocks, e.blockId, e.patch),
        }), false);
        break;
      case "tool_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: patchTool(s.blocks, e.blockId, e.call),
        }), false);
        break;
      case "plan_patch":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "plan" ? { ...b, steps: e.steps } : b,
          ),
        }), false);
        break;
      case "assistant_append":
      case "thinking_append":
        withSession(e.sessionId, (s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && (b.type === "assistant" || b.type === "thinking")
              ? { ...b, text: b.text + e.delta }
              : b,
          ),
        }), false);
        break;
      case "permission_request":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "awaiting_permission",
          blocks: [
            ...s.blocks,
            { type: "permission", id: e.blockId, req: e.req, ts: Date.now() },
          ],
        }));
        break;
      case "permission_resolved":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "running",
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "permission"
              ? { ...b, resolved: e.option }
              : b,
          ),
        }));
        break;
      case "question_request":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "awaiting_input",
          blocks: [
            ...s.blocks,
            { type: "question", id: e.blockId, req: e.req, ts: Date.now() },
          ],
        }));
        break;
      case "question_resolved":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "running",
          blocks: s.blocks.map((b) =>
            b.id === e.blockId && b.type === "question"
              ? { ...b, response: e.response }
              : b,
          ),
        }));
        break;
      case "status":
        withSession(e.sessionId, (s) => ({ ...s, status: e.status }));
        if (e.status === "idle") {
          // Drain CLI-style follow-up queue once the active turn settles.
          window.setTimeout(() => drainPromptQueue(e.sessionId), 0);
        }
        break;
      case "usage":
        withSession(e.sessionId, (s) => ({ ...s, usage: e.usage }), false);
        break;
      case "error":
        withSession(e.sessionId, (s) => ({
          ...s,
          status: "idle",
          blocks: [
            ...s.blocks,
            { type: "system", id: uid(), text: e.message, ts: Date.now(), kind: "error" },
          ],
        }));
        window.setTimeout(() => drainPromptQueue(e.sessionId), 0);
        break;
      case "prompt_queue": {
        // CLI is authoritative: merge text/state/version, keep local attachment payloads by id.
        const previous = get().promptQueues[e.sessionId] ?? [];
        const nextQueue: QueuedPrompt[] = e.entries.map((entry) => {
          const prior = previous.find((item) => item.id === entry.id);
          return {
            id: entry.id,
            text: entry.text || prior?.text || "",
            attachments: prior?.attachments ?? entry.attachments ?? [],
            createdAt: entry.createdAt || prior?.createdAt || Date.now(),
            state: entry.state,
            version: entry.version ?? prior?.version ?? 0,
            source: "cli" as const,
          };
        });
        set({
          promptQueues: {
            ...get().promptQueues,
            [e.sessionId]: nextQueue,
          },
        });
        break;
      }
    }
  };

  /** Pop and send the next *local* queued follow-up when the session is idle.
   * CLI-owned entries are executed by the agent via concurrent session/prompt. */
  const drainPromptQueue = (sessionId: string) => {
    const state = get();
    const session = state.sessions[sessionId];
    const queue = state.promptQueues[sessionId] ?? [];
    if (!session || session.status !== "idle" || queue.length === 0) return;

    // Prefer interjected, then first local-owned entry.
    const localIndex = queue.findIndex(
      (item) => item.source !== "cli" && item.state !== "sending",
    );
    if (localIndex < 0) {
      // Only CLI entries remain — clear sending ones the server already took.
      const remaining = queue.filter((item) => item.state !== "sending");
      if (remaining.length !== queue.length) {
        set({
          promptQueues: { ...state.promptQueues, [sessionId]: remaining },
        });
      }
      return;
    }

    const next = queue[localIndex];
    const rest = queue.filter((_, index) => index !== localIndex);
    set({
      promptQueues: {
        ...state.promptQueues,
        [sessionId]: rest,
      },
      queueNotice: {
        id: uid(),
        entryId: next.id,
        message: next.state === "interjected" ? "正在发送插话优先消息…" : "正在发送队首消息…",
        state: "queued",
        at: Date.now(),
      },
    });
    get().sendPrompt(next.text, next.attachments, sessionId);
  };

  return {
    ready: false,
    startupError: null,
    auth: { required: false, inProgress: false },
    bridgeKind: bridge.kind,
    workspace: DEMO_CWD,
    view: "home",
    projects: loadJson<ProjectMeta[]>("grox.projects", []),
    activeProjectId: null,
    sessionIndex: [],
    sessions: {},
    activeId: null,
    account: null,
    billing: null,
    provider: { kind: "oauth", hasApiKey: false },
    providerProfiles: [],
    activeProviderProfileId: undefined,
    providerSwitching: false,
    runtime: null,
    runtimeBusy: false,
    accountLoading: false,
    accountSetupOpen:
      localStorage.getItem("grox.accountSetupComplete") !== "1" && bridge.kind !== "mock",
    workspaceFiles: [],
    workspaceDiffs: [],
    workspaceDiffReady: false,
    projectPreview: { status: "idle" },
    previewOpen: false,
    previewFile: null,
    previewLoading: false,
    previewError: null,

    model: localStorage.getItem("grok.model") ?? "grok-build",
    models: MODELS,
    modelsUpdatedAt: 0,
    effort: (localStorage.getItem("grok.effort") as Effort) ?? "high",
    mode: "agent",
    permissionMode:
      localStorage.getItem("grok.permissionMode") === "auto"
        ? "auto"
        : localStorage.getItem("grok.permissionMode") === "bypass"
          ? "bypass"
          : "default",
    sessionComposers: loadSessionComposers(),
    promptQueues: {},
    queueNotice: null,

    inspectorOpen: true,
    inspectorTab: "files",
    paletteOpen: false,
    settingsOpen: false,
    historySyncing: false,
    historyCount: 0,
    historyError: null,
    historySyncedAt: 0,

    appVersion: "0.2.0",
    appUpdate: null,
    appUpdateChecking: false,
    appUpdateError: null,
    appUpdateDismissedVersion: localStorage.getItem("grox.appUpdateDismissed"),
    appUpdateInstalling: false,
    appUpdateInstallPhase: "idle",
    appUpdateProgress: null,

    async init() {
      if (bridgeSubscribed) return;
      bridgeSubscribed = true;
      bridge.subscribe(applyEvent);
      try {
        const runtime = bridge.kind === "acp"
          ? await invoke<GrokRuntimeInfo>("grok_runtime_info")
          : null;
        set({
          runtime,
          accountSetupOpen: get().accountSetupOpen || Boolean(runtime?.selectionRequired),
        });
        const workspace = await bridge.getWorkspace();
        const hidden = await hydrateHiddenProjectsFromDisk();
        // Drop sidebar entries the user previously removed (disk + localStorage).
        const pruned = filterHiddenProjects(get().projects, hidden);
        // Startup workspace is intentional — force so a previously-removed folder can return if still default.
        const projects = ensureProject(pruned, workspace, { force: true });
        const [auth, modelState, provider] = await Promise.all([
          bridge.getAuthState(),
          bridge.getModelState(),
          bridge.getProviderStatus(),
        ]);
        const sessionIndex = decorateSessions(loadJson<SessionMeta[]>("grox.sessionCatalog", []));
        set({
          workspace,
          projects,
          activeProjectId: projectId(workspace),
          sessionIndex,
          auth,
          ...resolveModelState(modelState),
          provider,
          ready: true,
          startupError: null,
        });
        window.setTimeout(() => {
          if (get().auth.inProgress) return;
          void get().refreshWorkspaceFiles();
          void get().refreshProjectPreview(false);
          if (get().view === "session") void get().refreshWorkspaceDiffs();
        }, 750);
        if (!auth.required) void get().refreshAccount();
        void get().refreshProviderProfiles();
        // Background update check against GitHub Releases (non-blocking).
        if (bridge.kind === "acp") {
          window.setTimeout(() => {
            void get().checkAppUpdate();
          }, 2_500);
        }
        window.setTimeout(() => {
          if (!get().auth.inProgress && get().historySyncedAt === 0) void get().refreshHistory();
        }, 500);
        if (workspaceWatchTimer === undefined) {
          workspaceWatchTimer = window.setInterval(() => {
            if (document.visibilityState !== "visible" || get().auth.inProgress || get().view !== "session") return;
            workspaceWatchTick += 1;
            void get().refreshWorkspaceDiffs();
            if (workspaceWatchTick % 3 === 0) void get().refreshWorkspaceFiles();
            if (get().projectPreview.status === "starting") void get().refreshProjectPreview();
          }, 2_000);
        }
      } catch (error) {
        set({
          ready: true,
          startupError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // Dev deep links: ?open=<sessionId> opens a mission,
      // ?prompt=<text> launches a fresh one. Runs once (guard above).
      const params = new URLSearchParams(window.location.search);
      const open = params.get("open");
      const prompt = params.get("prompt");
      if (open) void get().openSession(open);
      else if (prompt) {
        await get().newSession();
        get().sendPrompt(prompt);
      }
    },

    goHome: () => set({ view: "home", activeId: null }),

    async checkAppUpdate(opts) {
      if (bridge.kind !== "acp") return null;
      // Throttle automatic checks to once per 6 hours unless forced.
      const prev = get().appUpdate;
      if (!opts?.force && prev && Date.now() - prev.checkedAt * 1000 < 6 * 60 * 60 * 1000) {
        return prev;
      }
      set({ appUpdateChecking: true, appUpdateError: null });
      try {
        const info = await invoke<AppUpdateInfo>("check_app_update");
        set({
          appUpdate: info,
          appVersion: info.currentVersion || get().appVersion,
          appUpdateChecking: false,
          appUpdateError: null,
        });
        return info;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ appUpdateChecking: false, appUpdateError: message });
        return null;
      }
    },

    dismissAppUpdate() {
      const latest = get().appUpdate?.latestVersion;
      if (latest) {
        localStorage.setItem("grox.appUpdateDismissed", latest);
        set({ appUpdateDismissedVersion: latest });
      } else {
        set({ appUpdate: null });
      }
    },

    async openAppUpdateDownload() {
      const info = get().appUpdate;
      const url = info?.downloadUrl || info?.releaseUrl || "https://github.com/congqianv/Grox/releases";
      await invoke("open_external", { url });
    },

    async installAppUpdate() {
      if (bridge.kind !== "acp") {
        await get().openAppUpdateDownload();
        return;
      }
      const info = get().appUpdate;
      if (!info?.updateAvailable) {
        set({ appUpdateError: "当前没有可用更新" });
        return;
      }
      const downloadUrl = info.downloadUrl;
      if (!downloadUrl) {
        // No platform asset — fall back to the release page.
        await get().openAppUpdateDownload();
        return;
      }
      if (get().appUpdateInstalling) return;

      set({
        appUpdateInstalling: true,
        appUpdateInstallPhase: "downloading",
        appUpdateProgress: {
          stage: "downloading",
          percent: 0,
          downloaded: 0,
          total: null,
          message: "正在准备更新…",
        },
        appUpdateError: null,
      });

      let unlisten: (() => void) | undefined;
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<AppUpdateProgress>("app-update-progress", (event) => {
          const progress = event.payload;
          const stage = (progress.stage || "downloading") as AppUpdateInstallPhase;
          set({
            appUpdateProgress: progress,
            appUpdateInstallPhase:
              stage === "error" ? "error" : (["downloading", "extracting", "installing", "restarting"].includes(stage) ? stage : "downloading"),
            appUpdateError: stage === "error" ? progress.message : null,
          });
        });

        const result = await invoke<{
          installed: boolean;
          restarted: boolean;
          message: string;
          openUrl?: string | null;
        }>("install_app_update", {
          downloadUrl,
          assetName: info.assetName ?? null,
        });

        if (result.openUrl && !result.installed) {
          await invoke("open_external", { url: result.openUrl });
          set({
            appUpdateInstalling: false,
            appUpdateInstallPhase: "idle",
            appUpdateProgress: null,
          });
          return;
        }

        if (result.restarted) {
          set({
            appUpdateInstallPhase: "restarting",
            appUpdateProgress: {
              stage: "restarting",
              percent: 100,
              downloaded: 0,
              total: null,
              message: result.message || "更新完成，正在重启…",
            },
          });
          // Process will exit shortly; keep the installing flag true.
          return;
        }

        set({
          appUpdateInstalling: false,
          appUpdateInstallPhase: "idle",
          appUpdateProgress: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          appUpdateInstalling: false,
          appUpdateInstallPhase: "error",
          appUpdateError: message,
          appUpdateProgress: {
            stage: "error",
            percent: 0,
            downloaded: 0,
            total: null,
            message,
          },
        });
      } finally {
        unlisten?.();
      }
    },

    async openSession(id) {
      try {
        // Fast path: already loaded and in the same workspace — switch UI only.
        const current = get();
        if (current.activeId === id && current.sessions[id] && current.view === "session") {
          return;
        }

        const meta = current.sessionIndex.find((entry) => entry.id === id);
        // Cross-project switch: update workspace without the heavy setWorkspace
        // home-reset / full file tree refresh that makes session switching feel laggy.
        if (meta && !samePath(meta.cwd, current.workspace)) {
          await bridge.setWorkspace(meta.cwd);
          const workspace = await bridge.getWorkspace();
          // Opening a session in this folder is intentional — restore if hidden.
          const projects = ensureProject(get().projects, workspace, { force: true });
          set({
            workspace,
            projects,
            activeProjectId: projectId(workspace),
            workspaceDiffs: [],
            workspaceDiffReady: false,
            projectPreview: { status: "idle" },
            previewOpen: false,
            previewFile: null,
          });
          // Defer inspector file work so the transcript paints first.
          window.setTimeout(() => {
            void get().refreshWorkspaceFiles();
            void get().refreshWorkspaceDiffs();
          }, 0);
        }

        const state = get();
        const has = state.sessions[id];
        const composer = normalizeComposer(state.sessionComposers[id], {
          model: state.model || state.models[0]?.id || MODELS[0]?.id || "grok-build",
          effort: state.effort || "high",
          mode: state.mode || "agent",
          permissionMode: state.permissionMode || "default",
        });
        const sessionComposers = { ...state.sessionComposers, [id]: composer };
        persistSessionComposers(sessionComposers);
        bridge.setPermissionMode(composer.permissionMode);
        // Paint session chrome immediately; load transcript after.
        set({
          activeId: id,
          view: "session",
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          permissionMode: composer.permissionMode,
          sessionComposers,
          startupError: null,
        });
        if (!has) await bridge.loadSession(id);
      } catch (error) {
        set({
          startupError: error instanceof Error ? error.message : String(error),
          view: "home",
          activeId: null,
        });
      }
    },

    async newSession() {
      try {
        await bridge.newSession(get().workspace);
        set({ startupError: null });
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async newProject() {
      try {
        const cwd = await invoke<string | null>("pick_workspace");
        if (!cwd) return;
        await get().setWorkspace(cwd);
        await get().newSession();
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      }
    },

    async importProjects(paths) {
      const imported: string[] = [];
      const failed: { path: string; error: string }[] = [];
      // Deduplicate while preserving order.
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const raw of paths) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const key = projectId(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(trimmed);
      }

      for (const path of unique) {
        try {
          let workspace = path;
          if (bridge.kind === "acp") {
            // Canonicalize + ensure it is an existing directory.
            workspace = await invoke<string>("validate_workspace", { cwd: path });
          } else if (!workspace.includes("/") && !workspace.includes("\\")) {
            // Mock / browser: require a path-looking string.
            throw new Error("Not a folder path");
          }
          // Add (or re-show) in the sidebar without switching yet.
          const projects = ensureProject(get().projects, workspace, { force: true });
          set({ projects, startupError: null });
          imported.push(workspace);
        } catch (error) {
          failed.push({
            path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Activate the last successful import so the user lands in that project.
      if (imported.length > 0) {
        try {
          await get().setWorkspace(imported[imported.length - 1]);
        } catch (error) {
          // Projects are already listed; surface switch failure without rolling back imports.
          set({
            startupError: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (failed.length > 0) {
        set({
          startupError:
            failed.length === 1
              ? failed[0].error
              : failed.map((f) => f.error).join(" · "),
        });
      }

      return { imported, failed };
    },

    async openProject(id) {
      const project = get().projects.find((entry) => entry.id === id);
      if (project) await get().setWorkspace(project.path);
    },

    renameProject(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const projects = get().projects.map((project) =>
        project.id === id ? { ...project, name: trimmed } : project,
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects });
    },

    pinProject(id) {
      const projects = get().projects.map((project) =>
        project.id === id ? { ...project, pinned: !project.pinned } : project,
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects });
    },

    archiveProject(id) {
      const projects = get().projects.map((project) =>
        project.id === id ? { ...project, archived: !project.archived } : project,
      );
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects });
    },

    removeProject(id) {
      // Remember the removal so CLI history import / reinstall does not resurrect it.
      // Sessions under ~/.grok/sessions are left intact — only the sidebar entry is hidden.
      hideProjectId(id);
      const projects = get().projects.filter((project) => project.id !== id);
      localStorage.setItem("grox.projects", JSON.stringify(projects));
      set({ projects, ...(get().activeProjectId === id ? { activeProjectId: null } : {}) });
    },

    async openProjectInExplorer(id) {
      const project = id
        ? get().projects.find((entry) => entry.id === id)
        : get().projects.find((entry) => entry.id === get().activeProjectId);
      await invoke("open_in_explorer", { cwd: project?.path ?? get().workspace, path: null });
    },

    async setWorkspace(cwd) {
      await bridge.setWorkspace(cwd);
      const workspace = await bridge.getWorkspace();
      const fetchedSessions = await bridge.listSessions(workspace);
      const sessionIndex = mergeProjectSessions(get().sessionIndex, workspace, fetchedSessions);
      // User picked / opened this folder — un-hide if they previously removed it.
      const projects = ensureProject(get().projects, workspace, { force: true });
      set({
        workspace,
        projects,
        activeProjectId: projectId(workspace),
        sessionIndex: decorateSessions(sessionIndex),
        startupError: null,
        activeId: null,
        view: "home",
        workspaceDiffs: [],
        workspaceDiffReady: false,
        projectPreview: { status: "idle" },
        previewOpen: false,
        previewFile: null,
      });
      void get().refreshWorkspaceFiles();
      void get().refreshWorkspaceDiffs();
      void get().refreshProjectPreview(false);
    },

    async authenticate() {
      try {
        await bridge.authenticate();
        set({ auth: await bridge.getAuthState(), startupError: null });
        void get().refreshAccount();
        void get().refreshHistory();
      } catch (error) {
        set({
          auth: await bridge.getAuthState(),
          startupError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async logout() {
      await bridge.logout();
    },

    async refreshAccount() {
      set({ accountLoading: true });
      const provider = await bridge.getProviderStatus().catch(() => get().provider);
      try {
        const account = await bridge.getAccountInfo();
        let billing: BillingInfo | null = null;
        if (account.authenticated) {
          try {
            billing = await bridge.getBillingInfo();
          } catch {
            // Billing is only available for OAuth accounts.
          }
        }
        set({ account, billing, provider, accountLoading: false });
      } catch {
        set({ account: null, billing: null, provider, accountLoading: false });
      }
    },

    async refreshModels() {
      const state = await bridge.getModelState();
      const profile = get().providerProfiles.find((item) => item.id === get().activeProviderProfileId);
      const resolved = resolveModelState(providerModelState(state, profile));
      const { activeId, sessionComposers } = get();
      const active = activeId ? sessionComposers[activeId] : undefined;
      const model = active && resolved.models.some((item) => item.id === active.model) ? active.model : resolved.model;
      const next = activeId && active ? { ...sessionComposers, [activeId]: { ...active, model } } : sessionComposers;
      if (next !== sessionComposers) persistSessionComposers(next);
      set({ ...resolved, model, sessionComposers: next });
    },

    async configureProvider(config) {
      const wasComplete = localStorage.getItem("grox.accountSetupComplete") === "1";
      localStorage.setItem("grox.accountSetupComplete", "1");
      set({ accountSetupOpen: false });
      try {
        if (Object.values(get().sessions).some((session) => session.status !== "idle")) {
          throw new Error("请先终止正在执行的任务，再切换模型服务");
        }
        const activeId = get().activeId;
        set({ providerSwitching: true });
        await bridge.configureProvider(config);
        await get().refreshProviderProfiles();
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        if (activeId) await bridge.loadSession(activeId);
        set({ providerSwitching: false, startupError: null });
      } catch (error) {
        if (!wasComplete) localStorage.removeItem("grox.accountSetupComplete");
        set({ accountSetupOpen: !wasComplete, providerSwitching: false });
        throw error;
      }
    },

    async refreshProviderProfiles() {
      const result = await bridge.listProviderProfiles();
      set({ providerProfiles: result.profiles, activeProviderProfileId: result.activeId });
    },

    async saveProviderProfile(config) {
      let profile = await bridge.saveProviderProfile(config);
      try {
        profile = await bridge.refreshProviderModels(profile.id);
      } catch (error) {
        set({ startupError: `供应商已保存，但模型列表获取失败：${error instanceof Error ? error.message : String(error)}` });
      }
      // Always activate after save so the just-configured provider is what the
      // agent uses — no separate "switch + edit config.toml" step required.
      if (Object.values(get().sessions).some((session) => session.status !== "idle")) {
        await get().refreshProviderProfiles();
        set({
          startupError:
            "供应商已保存。请先停止正在执行的任务，再在输入框左侧切换到该供应商以生效。",
        });
        return profile;
      }
      const activeId = get().activeId;
      set({ providerSwitching: true });
      try {
        await bridge.activateProviderProfile(profile.id);
        await get().refreshProviderProfiles();
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        if (activeId) await bridge.loadSession(activeId);
        set({ providerSwitching: false, startupError: null });
      } catch (error) {
        set({
          providerSwitching: false,
          startupError: `供应商已保存，但激活失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return profile;
    },

    async refreshProviderModels(id) {
      const profile = await bridge.refreshProviderModels(id);
      await get().refreshProviderProfiles();
      return profile;
    },

    async activateProviderProfile(id) {
      if (Object.values(get().sessions).some((session) => session.status !== "idle")) {
        throw new Error("请先终止正在执行的任务，再切换模型服务");
      }
      const activeId = get().activeId;
      set({ providerSwitching: true });
      try {
        await bridge.activateProviderProfile(id);
        await get().refreshProviderProfiles();
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        if (activeId) await bridge.loadSession(activeId);
        set({ providerSwitching: false, startupError: null });
      } catch (error) {
        set({ providerSwitching: false });
        throw error;
      }
    },

    async deleteProviderProfile(id) {
      const wasActive = get().activeProviderProfileId === id;
      const activeId = get().activeId;
      // Optimistic remove so the settings list updates even if a later refresh
      // races with agent restart / webview focus loss.
      set({
        providerProfiles: get().providerProfiles.filter((profile) => profile.id !== id),
        activeProviderProfileId: wasActive ? undefined : get().activeProviderProfileId,
      });
      try {
        await bridge.deleteProviderProfile(id);
      } catch (error) {
        await get().refreshProviderProfiles();
        throw error;
      }
      try {
        await get().refreshProviderProfiles();
      } catch {
        // Keep the optimistic removal if re-list fails.
      }
      if (wasActive) {
        try {
          await Promise.all([get().refreshAccount(), get().refreshModels()]);
          if (activeId) await bridge.loadSession(activeId);
        } catch (error) {
          set({
            startupError:
              error instanceof Error
                ? `供应商已删除，但重连失败：${error.message}`
                : `供应商已删除，但重连失败：${String(error)}`,
          });
        }
      }
    },

    async refreshRuntime() {
      if (bridge.kind !== "acp") return;
      set({ runtimeBusy: true });
      try {
        const runtime = await invoke<GrokRuntimeInfo>("grok_runtime_info");
        set({ runtime, runtimeBusy: false });
      } catch (error) {
        set({
          runtimeBusy: false,
          startupError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async useBundledRuntime() {
      set({ runtimeBusy: true });
      try {
        await invoke<GrokRuntimeInfo>("set_grok_runtime_preference", { preference: "bundled" });
        window.location.reload();
      } catch (error) {
        set({ runtimeBusy: false });
        throw error;
      }
    },

    async installOfficialRuntime() {
      set({ runtimeBusy: true });
      try {
        await invoke<GrokRuntimeInfo>("install_official_grok_cli");
        window.location.reload();
      } catch (error) {
        set({ runtimeBusy: false });
        throw error;
      }
    },

    setAccountSetupOpen: (accountSetupOpen) => set({ accountSetupOpen }),

    async refreshWorkspaceFiles() {
      try {
        const workspaceFiles = await invoke<WorkspaceEntry[]>("list_workspace_files", {
          cwd: get().workspace,
        });
        set({ workspaceFiles });
      } catch (error) {
        set({ previewError: error instanceof Error ? error.message : String(error) });
      }
    },

    async refreshWorkspaceDiffs() {
      if (bridge.kind === "mock") return;
      try {
        const response = await bridge.callExtension<unknown>("x.ai/git/diffs", {
          gitRoot: get().workspace,
          from: "HEAD",
          to: "working",
          includePatch: true,
          includeContent: true,
          maxPatchBytes: 2_000_000,
          maxPatchLines: 20_000,
        });
        set({ workspaceDiffs: mapGitDiffs(response), workspaceDiffReady: true });
      } catch {
        // Non-git workspaces and older agents simply have no project-level diff.
      }
    },

    async refreshProjectPreview(start = false) {
      if (bridge.kind === "mock") {
        set({ projectPreview: { status: "none" } });
        return;
      }
      try {
        const projectPreview = await invoke<ProjectPreview>("start_project_preview", {
          cwd: get().workspace,
          start,
        });
        const shouldOpen = start && (projectPreview.status === "starting" || projectPreview.status === "ready");
        set({
          projectPreview,
          ...(shouldOpen ? { inspectorOpen: true, inspectorTab: "preview" as InspectorTab } : {}),
        });
      } catch (error) {
        set({
          projectPreview: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },

    setProjectPreviewUrl(url) {
      set({ projectPreview: { ...get().projectPreview, status: "ready", url } });
    },

    async openPreview(path) {
      set({ previewOpen: true, previewLoading: true, previewError: null });
      try {
        const previewFile = await invoke<PreviewFile>("read_preview_file", {
          cwd: get().workspace,
          path,
        });
        set({ previewFile, previewLoading: false });
      } catch (error) {
        set({
          previewFile: null,
          previewLoading: false,
          previewError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    closePreview: () => set({ previewOpen: false, previewFile: null, previewError: null }),

    async deleteSession(id) {
      await bridge.deleteSession(id);
      const { sessionIndex, sessions, activeId, sessionComposers } = get();
      const rest = { ...sessions };
      delete rest[id];
      const nextComposers = { ...sessionComposers };
      delete nextComposers[id];
      persistSessionComposers(nextComposers);
      const nextIndex = sessionIndex.filter((m) => m.id !== id);
      persistSessionCatalog(nextIndex);
      set({
        sessionIndex: nextIndex,
        sessions: rest,
        sessionComposers: nextComposers,
        ...(activeId === id ? { activeId: null, view: "home" as View } : {}),
      });
    },

    renameSession(id, title) {
      void bridge.renameSession(id, title);
      const { sessionIndex, sessions } = get();
      const nextIndex = sessionIndex.map((m) => (m.id === id ? { ...m, title } : m));
      persistSessionCatalog(nextIndex);
      set({
        sessionIndex: nextIndex,
        sessions: sessions[id]
          ? { ...sessions, [id]: { ...sessions[id], title } }
          : sessions,
      });
    },

    pinSession(id) {
      const current = get().sessionIndex.find((meta) => meta.id === id);
      const pinned = !current?.pinned;
      setSessionFlag(id, { pinned });
      set({
        sessionIndex: get().sessionIndex.map((meta) =>
          meta.id === id ? { ...meta, pinned } : meta,
        ),
      });
    },

    archiveSession(id) {
      const current = get().sessionIndex.find((meta) => meta.id === id);
      const archived = !current?.archived;
      setSessionFlag(id, { archived });
      set({
        sessionIndex: get().sessionIndex.map((meta) =>
          meta.id === id ? { ...meta, archived } : meta,
        ),
        ...(get().activeId === id && archived ? { activeId: null, view: "home" as View } : {}),
      });
    },

    sendPrompt(text, attachments = [], sessionId) {
      const { activeId, sessions, model, effort, mode, permissionMode, sessionComposers, promptQueues } = get();
      const targetId = sessionId ?? activeId;
      const session = targetId ? sessions[targetId] : null;
      if (!session) return;

      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      const composer = sessionComposers[session.id] ?? {
        text: "",
        attachments: [],
        model,
        effort,
        mode,
        permissionMode,
      };

      // Waiting for plan / permission / question — keep typing, block submit.
      if (session.status === "awaiting_permission" || session.status === "awaiting_input") {
        const isPlan = session.blocks.some(
          (block) =>
            block.type === "permission" &&
            !block.resolved &&
            block.id.startsWith("plan-approval-"),
        );
        const message =
          session.status === "awaiting_input"
            ? "请先回答当前问题再发送"
            : isPlan
              ? "请先批准或拒绝当前计划再发送"
              : "请先处理当前权限请求再发送";
        set({
          queueNotice: {
            id: uid(),
            message,
            state: "blocked",
            at: Date.now(),
          },
        });
        return;
      }

      // Busy turn → enqueue follow-up (Grok Build CLI-style queue).
      if (session.status !== "idle") {
        const entry: QueuedPrompt = {
          id: uid(),
          text: trimmed,
          attachments: [...attachments],
          createdAt: Date.now(),
          state: "queued",
          source: "local",
        };
        const nextComposers = {
          ...sessionComposers,
          [session.id]: { ...composer, text: "", attachments: [] },
        };
        persistSessionComposers(nextComposers);
        const depth = (promptQueues[session.id] ?? []).length + 1;
        set({
          promptQueues: {
            ...promptQueues,
            [session.id]: [...(promptQueues[session.id] ?? []), entry],
          },
          sessionComposers: nextComposers,
          queueNotice: {
            id: uid(),
            entryId: entry.id,
            message: `已加入队列（第 ${depth} 条）`,
            state: "queued",
            at: Date.now(),
          },
        });

        // Try CLI queue path (concurrent prompt) — if it succeeds, CLI owns execution.
        void bridge
          .enqueuePrompt(
            session.id,
            trimmed,
            {
              model: composer.model,
              effort: composer.effort,
              mode: composer.mode,
              attachments,
            },
            { promptId: entry.id },
          )
          .then(() => {
            const current = get().promptQueues[session.id] ?? [];
            if (!current.some((item) => item.id === entry.id)) return;
            set({
              promptQueues: {
                ...get().promptQueues,
                [session.id]: current.map((item) =>
                  item.id === entry.id ? { ...item, source: "cli" as const } : item,
                ),
              },
            });
          })
          .catch(() => {
            // CLI rejected — keep local ownership and drain on idle.
          });
        return;
      }

      const titleText = trimmed || attachments.map((attachment) => attachment.name).join(", ");
      const nextIndex = get().sessionIndex.map((m) =>
        m.id === session.id && m.title === "Untitled mission"
          ? { ...m, title: titleText.slice(0, 56) }
          : m,
      );
      persistSessionCatalog(nextIndex);

      const nextComposers = {
        ...sessionComposers,
        [session.id]: { ...composer, text: "", attachments: [] },
      };
      persistSessionComposers(nextComposers);
      set({
        sessions: {
          ...sessions,
          [session.id]: {
            ...session,
            title: session.title === "Untitled mission" ? titleText.slice(0, 56) : session.title,
            status: "running",
            blocks: [
              ...session.blocks,
              {
                type: "user",
                id: uid(),
                text: trimmed,
                attachments: attachments.map(({ id, kind, name, mime, size, data, path }) => ({
                  id,
                  kind,
                  name,
                  mime,
                  size,
                  // Keep image bytes for bubble thumbnails; omit heavy binary payloads.
                  ...(kind === "image" && data ? { data } : {}),
                  ...(kind === "path" && path ? { path } : {}),
                })),
                ts: Date.now(),
              },
            ],
          },
        },
        sessionIndex: nextIndex,
        sessionComposers: nextComposers,
      });

      bridge.setPermissionMode(composer.permissionMode);
      void bridge.prompt(session.id, trimmed, {
        model: composer.model,
        effort: composer.effort,
        mode: composer.mode,
        attachments,
      });
    },

    async interjectPrompt(text, attachments = [], sessionId) {
      const { activeId, sessions, model, effort, mode, permissionMode, sessionComposers, promptQueues } =
        get();
      const targetId = sessionId ?? activeId;
      const session = targetId ? sessions[targetId] : null;
      if (!session) return;

      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      if (session.status === "idle") {
        get().sendPrompt(trimmed, attachments, session.id);
        return;
      }

      if (session.status === "awaiting_permission" || session.status === "awaiting_input") {
        get().sendPrompt(trimmed, attachments, session.id);
        return;
      }

      const composer = sessionComposers[session.id] ?? {
        text: "",
        attachments: [],
        model,
        effort,
        mode,
        permissionMode,
      };

      try {
        const result = await bridge.interject(session.id, trimmed, {
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          attachments,
        });

        const nextComposers = {
          ...sessionComposers,
          [session.id]: { ...composer, text: "", attachments: [] },
        };
        persistSessionComposers(nextComposers);

        if (result.fallback || result.state === "queued_head") {
          const entry: QueuedPrompt = {
            id: result.entryId ?? uid(),
            text: trimmed,
            attachments: [...attachments],
            createdAt: Date.now(),
            state: "interjected",
          };
          set({
            promptQueues: {
              ...promptQueues,
              [session.id]: [entry, ...(promptQueues[session.id] ?? [])],
            },
            sessionComposers: nextComposers,
            queueNotice: {
              id: uid(),
              entryId: entry.id,
              message: result.message,
              state: "interjected",
              at: Date.now(),
            },
          });
          return;
        }

        set({
          sessionComposers: nextComposers,
          queueNotice: {
            id: uid(),
            entryId: result.entryId,
            message: result.message,
            state: "interjected",
            at: Date.now(),
          },
        });
      } catch (error) {
        // Hard failure — still pin to queue head so the operator does not lose text.
        const entry: QueuedPrompt = {
          id: uid(),
          text: trimmed,
          attachments: [...attachments],
          createdAt: Date.now(),
          state: "interjected",
        };
        const nextComposers = {
          ...get().sessionComposers,
          [session.id]: {
            ...(get().sessionComposers[session.id] ?? composer),
            text: "",
            attachments: [],
          },
        };
        persistSessionComposers(nextComposers);
        set({
          promptQueues: {
            ...get().promptQueues,
            [session.id]: [entry, ...(get().promptQueues[session.id] ?? [])],
          },
          sessionComposers: nextComposers,
          queueNotice: {
            id: uid(),
            entryId: entry.id,
            message: `插话失败，已降级为队首：${error instanceof Error ? error.message : String(error)}`,
            state: "interjected",
            at: Date.now(),
          },
        });
      }
    },

    removeQueuedPrompt(sessionId, queueId) {
      const queue = get().promptQueues[sessionId] ?? [];
      const entry = queue.find((item) => item.id === queueId);
      if (!entry) return;
      set({
        promptQueues: {
          ...get().promptQueues,
          [sessionId]: queue.filter((item) => item.id !== queueId),
        },
        queueNotice: {
          id: uid(),
          entryId: queueId,
          message: "队列消息已移除",
          state: "removed",
          at: Date.now(),
        },
      });
      void bridge.removeQueuedPrompt(sessionId, queueId, entry.version ?? 0);
    },

    reorderQueuedPrompt(sessionId, fromIndex, toIndex) {
      const queue = get().promptQueues[sessionId] ?? [];
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= queue.length ||
        toIndex >= queue.length
      ) {
        return;
      }
      const next = [...queue];
      const [item] = next.splice(fromIndex, 1);
      if (!item) return;
      next.splice(toIndex, 0, item);
      set({
        promptQueues: {
          ...get().promptQueues,
          [sessionId]: next,
        },
        queueNotice: {
          id: uid(),
          entryId: item.id,
          message: `已调整到第 ${toIndex + 1} 位`,
          state: "reordered",
          at: Date.now(),
        },
      });
      void bridge.reorderQueuedPrompt(
        sessionId,
        next.map((entry) => entry.id),
      );
    },

    clearPromptQueue(sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      const had = (get().promptQueues[id] ?? []).length > 0;
      set({
        promptQueues: {
          ...get().promptQueues,
          [id]: [],
        },
        ...(had
          ? {
              queueNotice: {
                id: uid(),
                message: "等待队列已清空",
                state: "cleared" as const,
                at: Date.now(),
              },
            }
          : {}),
      });
      if (had) void bridge.clearQueuedPrompts(id);
    },

    interjectQueuedPrompt(sessionId, queueId) {
      const queue = get().promptQueues[sessionId] ?? [];
      const index = queue.findIndex((item) => item.id === queueId);
      if (index < 0) return;
      const entry = queue[index];
      if (!entry || entry.state !== "queued") return;
      const rest = queue.filter((item) => item.id !== queueId);
      const promoted: QueuedPrompt = { ...entry, state: "interjected" };
      set({
        promptQueues: {
          ...get().promptQueues,
          [sessionId]: [promoted, ...rest],
        },
        queueNotice: {
          id: uid(),
          entryId: queueId,
          message: "已置顶；回合结束后将优先发送",
          state: "interjected",
          at: Date.now(),
        },
      });
      void bridge.interjectQueuedPrompt(sessionId, queueId, {
        version: entry.version ?? 0,
      });
    },

    editQueuedPrompt(sessionId, queueId, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const queue = get().promptQueues[sessionId] ?? [];
      const entry = queue.find((item) => item.id === queueId);
      if (!entry || entry.state !== "queued") return;
      set({
        promptQueues: {
          ...get().promptQueues,
          [sessionId]: queue.map((item) =>
            item.id === queueId ? { ...item, text: trimmed } : item,
          ),
        },
        queueNotice: {
          id: uid(),
          entryId: queueId,
          message: "编辑已提交，等待 CLI 确认",
          state: "updated",
          at: Date.now(),
        },
      });
      void bridge.editQueuedPrompt(sessionId, queueId, trimmed);
    },

    dismissQueueNotice() {
      set({ queueNotice: null });
    },

    stop() {
      const { activeId } = get();
      if (activeId) bridge.cancel(activeId);
    },

    compact() {
      const { activeId, sessions } = get();
      if (activeId && sessions[activeId]?.status === "idle") {
        void bridge.compact(activeId);
      }
    },

    async listRewindPoints() {
      const { activeId, sessions } = get();
      if (!activeId || sessions[activeId]?.status !== "idle") return [];
      return bridge.listRewindPoints(activeId);
    },

    async previewRewind(targetPromptIndex, mode) {
      const { activeId, sessions } = get();
      if (!activeId || sessions[activeId]?.status !== "idle") throw new Error("请等待当前请求完成后再回退");
      return bridge.rewind(activeId, targetPromptIndex, mode, false);
    },

    async executeRewind(point, mode) {
      const { activeId, sessions } = get();
      if (!activeId || sessions[activeId]?.status !== "idle") throw new Error("请等待当前请求完成后再回退");
      const result = await bridge.rewind(activeId, point.prompt_index, mode, true);
      if (!result.success) {
        throw new Error(result.error || `回退存在 ${result.conflicts.length} 个文件冲突`);
      }
      await bridge.loadSession(activeId);
      if (mode !== "files_only") get().setDraft(result.prompt_text ?? point.prompt_preview ?? "");
      return result;
    },

    async editUserPrompt(promptIndex) {
      const { activeId, sessions } = get();
      if (!activeId) return;
      const session = sessions[activeId];
      if (!session) return;
      if (session.status !== "idle") {
        throw new Error("请先停止当前任务，再修改并重发");
      }
      const userBlocks = session.blocks.filter((block): block is Extract<typeof block, { type: "user" }> => block.type === "user");
      const user = userBlocks[promptIndex];
      if (!user) return;
      const fallbackText = user.text ?? "";
      // Restore attachments we still have payloads for (paths / image previews).
      const fallbackAttachments: PromptAttachment[] = [];
      for (const item of user.attachments ?? []) {
        if (item.kind === "path" && item.path) {
          fallbackAttachments.push({
            id: item.id,
            kind: "path",
            name: item.name,
            mime: item.mime,
            size: item.size,
            path: item.path,
          });
        } else if (item.kind === "image" && item.data) {
          fallbackAttachments.push({
            id: item.id,
            kind: "image",
            name: item.name,
            mime: item.mime,
            size: item.size,
            data: item.data,
          });
        }
      }

      /** Drop this user turn and everything after it from the visible transcript. */
      const dropLocalTurn = () => {
        const current = get().sessions[activeId];
        if (!current) return;
        let seen = 0;
        let cut = -1;
        for (let i = 0; i < current.blocks.length; i++) {
          if (current.blocks[i].type === "user") {
            if (seen === promptIndex) {
              cut = i;
              break;
            }
            seen += 1;
          }
        }
        if (cut < 0) return;
        set({
          sessions: {
            ...get().sessions,
            [activeId]: {
              ...current,
              blocks: current.blocks.slice(0, cut),
              status: "idle",
            },
          },
        });
      };

      try {
        const points = await bridge.listRewindPoints(activeId);
        const point =
          points.find((item) => item.prompt_index === promptIndex) ??
          // No listed checkpoint (common after mid-turn cancel) — still ask the
          // agent to truncate by prompt index when possible.
          ({
            prompt_index: promptIndex,
            created_at: new Date(user.ts).toISOString(),
            num_file_snapshots: 0,
            has_file_changes: false,
            prompt_preview: fallbackText.slice(0, 120),
          } satisfies RewindPoint);
        await get().executeRewind(point, "conversation_only");
      } catch {
        /* agent rewind unavailable — local drop below still prevents duplicate bubbles */
      }

      // Always ensure the original bubble is gone (rewind may no-op without a snapshot).
      dropLocalTurn();

      get().setDraft(fallbackText);
      if (fallbackAttachments.length > 0) get().setComposerAttachments(fallbackAttachments);
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      }, 50);
    },

    resolvePermission(blockId, option) {
      const { activeId, sessions } = get();
      if (!activeId) return;
      const session = sessions[activeId];
      const block = session?.blocks.find((item) => item.id === blockId && item.type === "permission");
      if (block?.type === "permission" && block.resolved) {
        set({
          queueNotice: {
            id: uid(),
            message: "该请求已处理，未重复提交",
            state: "duplicate",
            at: Date.now(),
          },
        });
        return;
      }
      const result = bridge.respondPermission(activeId, blockId, option);
      if (result.duplicate) {
        set({
          queueNotice: {
            id: uid(),
            message: result.message ?? "该请求已处理，未重复提交",
            state: "duplicate",
            at: Date.now(),
          },
        });
        return;
      }
      if (blockId.startsWith("plan-approval-")) {
        set({
          queueNotice: {
            id: uid(),
            message:
              option === "deny"
                ? "计划已拒绝，原回合将继续规划"
                : "计划已批准，原回合将继续执行（未额外发送消息）",
            state: "queued",
            at: Date.now(),
          },
        });
      }
    },

    resolveQuestion(blockId, response) {
      const { activeId } = get();
      if (activeId) bridge.respondQuestion(activeId, blockId, response);
    },

    setModel: (model) => {
      const { activeId, sessionComposers, effort, mode, permissionMode } = get();
      localStorage.setItem("grok.model", model);
      if (!activeId) return set({ model });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, model } };
      persistSessionComposers(next);
      set({ model, sessionComposers: next });
    },
    setEffort: (effort) => {
      const { activeId, sessionComposers, model, mode, permissionMode } = get();
      localStorage.setItem("grok.effort", effort);
      if (!activeId) return set({ effort });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, effort } };
      persistSessionComposers(next);
      set({ effort, sessionComposers: next });
    },
    setMode: (mode) => {
      const { activeId, sessionComposers, model, effort, permissionMode } = get();
      if (!activeId) return set({ mode });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, mode } };
      persistSessionComposers(next);
      set({ mode, sessionComposers: next });
      void bridge.setSessionMode(activeId, mode).catch((error) => {
        set({ startupError: error instanceof Error ? error.message : String(error) });
      });
    },
    setPermissionMode: (permissionMode) => {
      const { activeId, sessionComposers, model, effort, mode } = get();
      localStorage.setItem("grok.permissionMode", permissionMode);
      bridge.setPermissionMode(permissionMode);
      if (!activeId) return set({ permissionMode });
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, permissionMode } };
      persistSessionComposers(next);
      set({ permissionMode, sessionComposers: next });
    },
    setDraft(text) {
      const { activeId, sessionComposers, model, effort, mode, permissionMode } = get();
      if (!activeId) return;
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      const next = { ...sessionComposers, [activeId]: { ...current, text } };
      persistSessionComposers(next);
      set({ sessionComposers: next });
    },
    setComposerAttachments(attachments) {
      const { activeId, sessionComposers, model, effort, mode, permissionMode } = get();
      if (!activeId) return;
      const current = sessionComposers[activeId] ?? { text: "", attachments: [], model, effort, mode, permissionMode };
      set({ sessionComposers: { ...sessionComposers, [activeId]: { ...current, attachments } } });
    },
    setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true }),
    toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    async refreshHistory() {
      if (historySyncPromise) return historySyncPromise;
      const task = (async () => {
        set({ historySyncing: true, historyError: null });
        try {
          const imported = await bridge.listSessions();
          const sessionIndex = mergeAllSessions(get().sessionIndex, imported);
          const projects = mergeDiscoveredProjects(get().projects, imported);
          set({
            sessionIndex,
            projects,
            historySyncing: false,
            historyCount: imported.length,
            historySyncedAt: Date.now(),
          });
        } catch (error) {
          set({
            historySyncing: false,
            historyError: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      historySyncPromise = task;
      try {
        await task;
      } finally {
        historySyncPromise = undefined;
      }
    },
  };
});
