/* ─────────────────────────────────────────────────────────────────────────
   Central store. Owns session state, applies bridge events, exposes actions.
   The UI never touches the bridge directly.
   ───────────────────────────────────────────────────────────────────────── */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import { DEFAULT_PERMISSION_MODE, MODELS, readStoredPermissionMode } from "../bridge/types";
import { COMPUTER_USE_OPT_IN_REFUSE_MESSAGE } from "../lib/computerUse";
import { isSafeMarkdownOpenUrl } from "../lib/openUrlSafety";
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
import { mergeOfflineWithLive } from "../lib/offlineMerge";
import {
  filterBusyTurnQueueEntries,
  filterConsumedQueueEntries,
  filterQueueGhostsByLiveTexts,
  mergeCliQueueWithLocal,
  normalizeQueueText,
  queueHasSameText,
  stripCliOwnedEntries,
} from "../lib/promptQueue";
import { reconcileIncomingStatus, statusAfterGateResolve } from "../lib/sessionGate";
import {
  cancelSaveSessionCache,
  loadSessionCache,
  scheduleSaveSessionCache,
} from "../lib/sessionCache";

/** Missions whose offline disk history scan finished this process lifetime. */
const offlineHistoryComplete = new Set<string>();
/** Missions with an in-flight offline scan (avoid re-invoke restart storms). */
const offlineHistoryScanning = new Set<string>();
/**
 * Sessions deleted this process lifetime — late disk-history events must not
 * resurrect them into `sessions` (R3 tombstone).
 */
const offlineHistoryDeleted = new Set<string>();
/**
 * Sessions with an in-flight sendPrompt IIFE (silent bind + prompt).
 * Prevents openSession from coercing running→idle mid-bind (double-prompt race).
 *
 * IMPORTANT: UI `status: idle` (就绪) can arrive via `prompt_complete` / finishTurn
 * *before* the JSON-RPC `session/prompt` promise settles. While that gap exists the
 * set still holds the id — treating it as "busy" forever queues new sends and
 * blocks drainPromptQueue (operator sees 就绪 + 队列卡住). Ready must win.
 */
const promptInFlightSessions = new Set<string>();
/** Per-session flight generation — stale finally must not clear a newer send. */
const promptFlightGen = new Map<string, number>();
/**
 * Queue entry ids already submitted via concurrent `session/prompt` (busy-path
 * enqueue). Drain must not start a second sendPrompt for these — that produced
 * "Grok 正在处理" + the same row still 已入队.
 */
const submittedEnqueueIds = new Set<string>();
/**
 * Ids whose concurrent session/prompt wire write already succeeded. CLI may
 * still echo them in x.ai/queue/changed — re-showing those as 已入队 is a ghost
 * (operator sees an old follow-up while Grok is already processing it / while
 * a newer interject is live). Cleared when the session returns to idle.
 */
const consumedConcurrentIdsBySession = new Map<string, Set<string>>();
/**
 * Normalized texts of concurrent writes (CLI often re-echoes with a *new* id).
 */
const consumedConcurrentTextsBySession = new Map<string, Set<string>>();
/**
 * After operator Stop, do not auto-drain the follow-up queue (surprising:
 * "I stopped but it kept going"). Stays set until the operator explicitly
 * continues (new primary send / clear queue / agent reconnect), not just the
 * next idle tick — otherwise sendPrompt `finally` / late idle races re-fire.
 */
const suppressNextIdleDrain = new Set<string>();

/** True when this send IIFE was superseded by Stop / a newer primary. */
function isPromptFlightCancelled(sessionId: string, flightGen: number): boolean {
  return promptFlightGen.get(sessionId) !== flightGen;
}

function markConsumedConcurrent(sessionId: string, entryId: string, text?: string): void {
  let ids = consumedConcurrentIdsBySession.get(sessionId);
  if (!ids) {
    ids = new Set();
    consumedConcurrentIdsBySession.set(sessionId, ids);
  }
  ids.add(entryId);
  const norm = normalizeQueueText(text);
  if (!norm) return;
  let texts = consumedConcurrentTextsBySession.get(sessionId);
  if (!texts) {
    texts = new Set();
    consumedConcurrentTextsBySession.set(sessionId, texts);
  }
  texts.add(norm);
}

function clearConsumedConcurrent(sessionId: string): void {
  consumedConcurrentIdsBySession.delete(sessionId);
  consumedConcurrentTextsBySession.delete(sessionId);
}

function consumedSets(sessionId: string): {
  ids: Set<string> | undefined;
  texts: Set<string> | undefined;
} {
  return {
    ids: consumedConcurrentIdsBySession.get(sessionId),
    texts: consumedConcurrentTextsBySession.get(sessionId),
  };
}

function beginPromptFlight(sessionId: string): number {
  const gen = (promptFlightGen.get(sessionId) ?? 0) + 1;
  promptFlightGen.set(sessionId, gen);
  promptInFlightSessions.add(sessionId);
  return gen;
}

/** Only the flight that still owns `gen` may clear the in-flight bit. */
function endPromptFlight(sessionId: string, gen: number): void {
  if (promptFlightGen.get(sessionId) !== gen) return;
  promptInFlightSessions.delete(sessionId);
}

/**
 * Drop any in-flight lock (e.g. status→idle while RPC still open).
 * Bumps generation so a late `finally` cannot delete a newer send's lock.
 */
function releasePromptFlight(sessionId: string): void {
  const gen = (promptFlightGen.get(sessionId) ?? 0) + 1;
  promptFlightGen.set(sessionId, gen);
  promptInFlightSessions.delete(sessionId);
}

/** Monotonic token so superseded openSession awaits do not steal focus. */
let openSessionGeneration = 0;
/** Target of the latest openSession — applyChrome only if still this id. */
let openSessionTargetId: string | null = null;
/** Offline scan finished while turn was live — merge on idle. */
const pendingOfflineMerge = new Map<string, Session>();
/** Overlapping list_workspace_files walks thrash large repos — one in-flight. */
let workspaceFilesInFlight = false;
/** git/diffs is heavy — one in-flight + min interval. */
let workspaceDiffsInFlight = false;
let lastWorkspaceDiffAt = 0;
/** openPreview race: late read must not clobber a newer path. */
let previewOpenGeneration = 0;

/** Invalidate in-flight openSession applyChrome (Home / new mission / workspace). */
function bumpOpenSessionGeneration(clearTarget = true): void {
  openSessionGeneration += 1;
  if (clearTarget) openSessionTargetId = null;
}
/** Poll timer for offline scan progress (atomics in Rust — no event flood). */
let offlineScanPollTimer: number | null = null;

function stopOfflineScanPoll(): void {
  if (offlineScanPollTimer != null) {
    window.clearInterval(offlineScanPollTimer);
    offlineScanPollTimer = null;
  }
}

/**
 * Poll Rust atomics for scan progress. Independent of Tauri events so a busy
 * webview cannot freeze the percent bar.
 */
function startOfflineScanPoll(sessionId: string): void {
  stopOfflineScanPoll();
  let lastBytes = -1;
  let stuckTicks = 0;
  /** Do not arm the stuck-watchdog until the worker has actually read ≥1 byte. */
  let scanStarted = false;
  offlineScanPollTimer = window.setInterval(() => {
    void (async () => {
      try {
        const p = await invoke<{
          id?: string;
          done?: boolean;
          phase?: string;
          percent?: number;
          bytesRead?: number;
          totalBytes?: number;
          lines?: number;
          blocks?: number;
        }>("get_offline_scan_progress");

        const state = useDesktop.getState();
        const active = state.activeId;
        const loading = state.fullHistoryLoadingId;
        // Strict id match: never treat another session's atomics as ours.
        if (p.id && p.id !== "" && p.id !== sessionId) {
          return;
        }
        // Only paint for the session we care about.
        if (active !== sessionId && loading !== sessionId) {
          return;
        }

        const bytes = Number(p.bytesRead) || 0;
        const total = Number(p.totalBytes) || 0;
        const done = Boolean(p.done);
        const phase = p.phase || "idle";

        if (!done) {
          if (bytes > 0) scanStarted = true;
          useDesktop.setState({
            diskHistoryProgress: {
              id: sessionId,
              percent: Math.min(99, Math.max(0, Number(p.percent) || 0)),
              bytesRead: bytes,
              totalBytes: total,
              lines: Number(p.lines) || 0,
              blocks: Number(p.blocks) || 0,
            },
            fullHistoryLoadingId: sessionId,
            historyLoadMode: "disk",
          });
          // Preparing (find dir / open file / cache check): bytes stay 0 — never
          // treat that as a dead worker (was firing "扫描中断" in ~2–5s).
          if (!scanStarted) {
            stuckTicks = 0;
            lastBytes = bytes;
            return;
          }
          if (bytes === lastBytes) {
            stuckTicks += 1;
            // ~15s with no byte movement after scan actually started.
            if (stuckTicks >= 60) {
              offlineHistoryScanning.delete(sessionId);
              // Soft-cancel only: do NOT mark complete — next open may retry.
              stopOfflineScanPoll();
              void invoke("cancel_offline_session_history").catch(() => {});
              if (
                useDesktop.getState().fullHistoryLoadingId === sessionId &&
                useDesktop.getState().historyLoadMode === "disk"
              ) {
                useDesktop.setState({
                  fullHistoryLoadingId: null,
                  historyLoadMode: null,
                  diskHistoryProgress: null,
                });
              }
            }
          } else {
            stuckTicks = 0;
            lastBytes = bytes;
          }
          return;
        }

        // Terminal: session body arrives via disk-history-progress event.
        offlineHistoryScanning.delete(sessionId);
        // Only stop the global poll when it still belongs to this session.
        if (
          useDesktop.getState().fullHistoryLoadingId === sessionId ||
          useDesktop.getState().diskHistoryProgress?.id === sessionId
        ) {
          stopOfflineScanPoll();
        }
        // Strict id match only — empty active id after cancel is not "ours".
        const progressOwned = Boolean(p.id) && p.id === sessionId;
        if (
          progressOwned &&
          (phase === "complete" || phase === "no-updates" || phase === "missing")
        ) {
          offlineHistoryComplete.add(sessionId);
        }
        // cancelled/error: drop banner only — allow retry on next open.
        if (
          progressOwned &&
          (phase === "error" ||
            phase === "cancelled" ||
            phase === "missing" ||
            phase === "complete" ||
            phase === "no-updates")
        ) {
          // complete keeps banner until session event; clear if still loading after a beat.
          if (phase !== "complete" && useDesktop.getState().fullHistoryLoadingId === sessionId) {
            useDesktop.setState({
              fullHistoryLoadingId: null,
              historyLoadMode: null,
              diskHistoryProgress: null,
            });
          }
        }
      } catch {
        /* ignore poll errors while agent/shell restarts */
      }
    })();
  }, 250);
}

export type HistoryLoadMode = "disk" | "agent" | null;

type DiskHistoryProgress = {
  id: string;
  gen?: number;
  done: boolean;
  phase?: string;
  session?: Session | null;
  error?: string;
  fromCache?: boolean;
  /** 0–100 scan progress from Rust offline worker. */
  percent?: number;
  bytesRead?: number;
  totalBytes?: number;
  lines?: number;
  blocks?: number;
};

/** Live offline-scan progress shown in Timeline banner. */
export type DiskHistoryScanProgress = {
  id: string;
  percent: number;
  bytesRead: number;
  totalBytes: number;
  lines: number;
  blocks: number;
  fromCache?: boolean;
};

function normalizeOfflineSession(raw: unknown, fallback?: Session | null): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Session;
  if (typeof s.id !== "string" || !Array.isArray(s.blocks)) return null;
  const now = Date.now();
  const blocks = s.blocks.map((block, index) => {
    const ts =
      typeof (block as { ts?: number }).ts === "number"
        ? (block as { ts: number }).ts
        : now + index;
    if (block.type === "assistant") {
      return { ...block, streaming: false, ts };
    }
    if (block.type === "thinking") {
      return { ...block, live: false, ts };
    }
    if (block.type === "tool") {
      const rawStatus = String(block.call?.status ?? "done");
      const status =
        rawStatus === "running" ||
        rawStatus === "pending" ||
        rawStatus === "in_progress"
          ? ("done" as const)
          : rawStatus === "cancelled" || rawStatus === "error" || rawStatus === "awaiting_permission"
            ? (rawStatus as "cancelled" | "error" | "awaiting_permission")
            : ("done" as const);
      return {
        ...block,
        ts,
        call: {
          ...block.call,
          status,
          startedAt:
            typeof block.call?.startedAt === "number" ? block.call.startedAt : ts,
          title: block.call?.title || block.call?.rawKind || "tool",
        },
      } as SessionBlock;
    }
    if (block.type === "plan") {
      return {
        ...block,
        ts,
        steps: Array.isArray(block.steps) ? block.steps : [],
      } as SessionBlock;
    }
    return { ...block, ts } as SessionBlock;
  });
  return {
    id: s.id,
    title: s.title || fallback?.title || "Untitled mission",
    cwd: s.cwd || fallback?.cwd || "",
    createdAt: s.createdAt || fallback?.createdAt || now,
    updatedAt: s.updatedAt || fallback?.updatedAt || now,
    model: s.model || fallback?.model || "grok-4.5",
    blocks,
    usage: s.usage ??
      fallback?.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0,
        contextUsed: 0,
        contextMax: 0,
        turns: 0,
      },
    // Disk / deferred offline snapshots must never re-apply busy turn status
    // (would stick send after flush when a scan finished mid-turn).
    status: "idle",
    demo: s.demo ?? fallback?.demo,
    pinned: s.pinned ?? fallback?.pinned,
    archived: s.archived ?? fallback?.archived,
    parentId: s.parentId ?? fallback?.parentId,
  };
}

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
  /**
   * Mission id whose history is still loading in the background
   * (disk preview is already shown). Null when idle.
   */
  fullHistoryLoadingId: string | null;
  /** Why fullHistoryLoadingId is set: offline disk scan vs agent session/load. */
  historyLoadMode: HistoryLoadMode;
  /**
   * Wall-clock ms when silent agent bind started (historyLoadMode === "agent").
   * Used by Timeline for elapsed "binding…" copy. Null when not agent-binding.
   */
  agentBindStartedAt: number | null;
  /** Real-time offline disk scan progress (null when idle). */
  diskHistoryProgress: DiskHistoryScanProgress | null;
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
  /** Bottom terminal panel (aggregates shell tool output). */
  terminalOpen: boolean;
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
  /** Create a mission; focuses it and returns its id (null on failure). */
  newSession(): Promise<string | null>;
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
  /**
   * Force-restart the Grok agent child (clears crash-reconnect cooldown).
   * Use when auto-reconnect is paused after repeated crashes.
   */
  forceReconnectAgent(): Promise<void>;
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
  /**
   * Detect or start project preview. `start` alone only probes; starting a
   * workspace dev script requires `opts.confirmStart === true` after in-app confirm.
   */
  refreshProjectPreview(start?: boolean, opts?: { confirmStart?: boolean }): Promise<void>;
  setProjectPreviewUrl(url: string): void;
  openPreview(path: string): Promise<void>;
  closePreview(): void;
  /** Right-side plan review pane (plan mode / exit_plan_mode approval). */
  planPreviewOpen: boolean;
  setPlanPreviewOpen(open: boolean): void;

  /**
   * Send or queue a prompt. Returns true when the draft was accepted
   * (caller should clear the composer); false when blocked/duplicate.
   */
  sendPrompt(text: string, attachments?: PromptAttachment[], sessionId?: string): boolean;
  /**
   * Same-turn interjection (Ctrl+Enter while busy).
   * Tries `x.ai/interject`; on older CLIs pins the message at the queue head.
   */
  /** Returns false when Computer Use refuse kept the draft (do not clear composer). */
  interjectPrompt(
    text: string,
    attachments?: PromptAttachment[],
    sessionId?: string,
  ): Promise<boolean>;
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
  resolvePermission(blockId: string, option: PermissionOption, feedback?: string): void;
  resolveQuestion(blockId: string, response: QuestionResponse): void;

  setModel(model: string): void;
  setEffort(effort: Effort): void;
  setMode(mode: AgentMode): void;
  setPermissionMode(mode: PermissionMode): void;
  setDraft(text: string): void;
  setComposerAttachments(attachments: PromptAttachment[]): void;
  setInspectorTab(tab: InspectorTab): void;
  toggleInspector(): void;
  toggleTerminal(): void;
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
    permissionMode: readStoredPermissionMode(),
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
  // Scheme C: load queue consults the live active mission.
  bridge.setActiveSessionGetter?.(() => get().activeId);

  const applyEvent = (e: BridgeEvent) => {
    const { sessions, sessionIndex } = get();

    const withSession = (sessionId: string, fn: (s: Session) => Session, touchCatalogue = true) => {
      const state = get();
      const s = state.sessions[sessionId];
      if (!s) return;
      const next = { ...fn(s), updatedAt: Date.now() };
      if (!touchCatalogue) {
        set({ sessions: { ...state.sessions, [sessionId]: next } });
        if (next.blocks.length > 0) scheduleSaveSessionCache(next);
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
      if (next.blocks.length > 0) scheduleSaveSessionCache(next);
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
        // Deleted missions must not reappear via late session/new|load.
        if (offlineHistoryDeleted.has(e.session.id)) break;
        const { blocks: _b, usage: _u, status: _st, ...meta } = e.session;
        const nextIndex = [
          decorateSessions([meta])[0],
          ...sessionIndex.filter((m) => m.id !== e.session.id),
        ];
        persistSessionCatalog(nextIndex);
        const state = get();
        const isActive = state.activeId === e.session.id;
        // Prefer the fuller of: existing UI snapshot vs newly loaded payload.
        // Full ACP load usually has more blocks (tools) than chat_history preview.
        // Always keep the result in memory even if user left (instant return),
        // but never steal focus — see isActive below.
        const existing = sessions[e.session.id];
        const preferExisting =
          existing && existing.blocks.length > e.session.blocks.length;
        const sessionToStore = preferExisting ? existing : e.session;
        const fallbackModel = state.models.some((item) => item.id === sessionToStore.model)
          ? sessionToStore.model
          : (state.model || state.models[0]?.id || MODELS[0]?.id || "grok-build");
        // Product permission mode is global — do not restore a stale per-session mode.
        const globalPermission = state.permissionMode || DEFAULT_PERMISSION_MODE;
        const composer = {
          ...normalizeComposer(state.sessionComposers[e.session.id], {
            model: fallbackModel,
            effort: state.effort || "high",
            mode: state.mode || "agent",
            permissionMode: globalPermission,
          }),
          permissionMode: globalPermission,
        };
        const sessionComposers = { ...state.sessionComposers, [e.session.id]: composer };
        persistSessionComposers(sessionComposers);

        // Agent session/load finished → clear agent banner only (disk mode is separate).
        const clearAgentBanner =
          state.fullHistoryLoadingId === e.session.id && state.historyLoadMode === "agent";

        // Background full-load must NOT steal focus if the user already switched away.
        if (isActive) {
          const projects = ensureProject(get().projects, e.session.cwd, { force: true });
          bridge.setPermissionMode(composer.permissionMode, e.session.id);
          set({
            sessions: { ...sessions, [e.session.id]: sessionToStore },
            sessionIndex: nextIndex,
            projects,
            workspace: e.session.cwd,
            activeProjectId: projectId(e.session.cwd),
            activeId: e.session.id,
            view: "session",
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            permissionMode: globalPermission,
            sessionComposers,
            ...(clearAgentBanner
              ? {
                  fullHistoryLoadingId: null,
                  historyLoadMode: null,
                  agentBindStartedAt: null,
                }
              : {}),
          });
        } else {
          set({
            sessions: { ...sessions, [e.session.id]: sessionToStore },
            sessionIndex: nextIndex,
            sessionComposers,
            ...(clearAgentBanner
              ? {
                  fullHistoryLoadingId: null,
                  historyLoadMode: null,
                  agentBindStartedAt: null,
                }
              : {}),
          });
        }
        if (sessionToStore.blocks.length > 0) {
          scheduleSaveSessionCache(sessionToStore);
        }
        break;
      }
      case "block_add":
        withSession(e.sessionId, (s) => ({ ...s, blocks: [...s.blocks, e.block] }));
        if (e.block.type === "plan" && get().activeId === e.sessionId) {
          set({ planPreviewOpen: true, previewOpen: false });
        }
        // User bubble just painted (or interject) — never keep the same text in 队列.
        if (e.block.type === "user") {
          window.setTimeout(() => pruneQueueGhosts(e.sessionId), 0);
        }
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
        withSession(e.sessionId, (s) => {
          // Structural patch: keep prior block refs so MemoTurnGroup can skip history.
          const index = s.blocks.findIndex((b) => b.id === e.blockId);
          if (index < 0) return s;
          const block = s.blocks[index];
          if (block.type !== "assistant" && block.type !== "thinking") return s;
          const next = s.blocks.slice();
          next[index] = { ...block, text: block.text + e.delta };
          return { ...s, blocks: next };
        }, false);
        break;
      case "permission_request":
        withSession(e.sessionId, (s) => {
          const blocks: SessionBlock[] = [
            ...s.blocks,
            { type: "permission", id: e.blockId, req: e.req, ts: Date.now() },
          ];
          // Do not clobber awaiting_input if a question card is still open.
          return {
            ...s,
            status: statusAfterGateResolve(blocks, s.status),
            blocks,
          };
        });
        if (
          (e.req.purpose === "plan" || e.blockId.startsWith("plan-approval-")) &&
          get().activeId === e.sessionId
        ) {
          set({ planPreviewOpen: true, previewOpen: false });
        }
        break;
      case "permission_resolved":
        withSession(e.sessionId, (s) => {
          const blocks = s.blocks.map((b) =>
            b.id === e.blockId && b.type === "permission"
              ? { ...b, resolved: e.option }
              : b,
          );
          // Multi-tool approvals stack — only leave gate status when none remain.
          return {
            ...s,
            status: statusAfterGateResolve(blocks, s.status),
            blocks,
          };
        });
        break;
      case "permission_restored":
        // Wire write failed after optimistic resolve — re-open the card.
        withSession(e.sessionId, (s) => {
          const blocks = s.blocks.map((b) =>
            b.id === e.blockId && b.type === "permission"
              ? { ...b, resolved: undefined }
              : b,
          );
          return {
            ...s,
            status: statusAfterGateResolve(blocks, "awaiting_permission"),
            blocks,
          };
        });
        break;
      case "question_request":
        withSession(e.sessionId, (s) => {
          const blocks: SessionBlock[] = [
            ...s.blocks,
            { type: "question", id: e.blockId, req: e.req, ts: Date.now() },
          ];
          return {
            ...s,
            status: statusAfterGateResolve(blocks, s.status),
            blocks,
          };
        });
        break;
      case "question_resolved":
        withSession(e.sessionId, (s) => {
          const blocks = s.blocks.map((b) =>
            b.id === e.blockId && b.type === "question"
              ? { ...b, response: e.response }
              : b,
          );
          return {
            ...s,
            status: statusAfterGateResolve(blocks, s.status),
            blocks,
          };
        });
        break;
      case "question_restored":
        withSession(e.sessionId, (s) => {
          const blocks = s.blocks.map((b) =>
            b.id === e.blockId && b.type === "question"
              ? { ...b, response: undefined }
              : b,
          );
          return {
            ...s,
            status: statusAfterGateResolve(blocks, "awaiting_input"),
            blocks,
          };
        });
        break;
      case "status": {
        // Concurrent finishTurn/enqueue may emit `running` over open gates —
        // keep awaiting_* so Permission/Question cards stay active.
        // `idle` still wins (Stop / turn end); side-effects use applied status.
        let appliedStatus = e.status;
        withSession(e.sessionId, (s) => {
          appliedStatus = reconcileIncomingStatus(s.blocks, s.status, e.status);
          return appliedStatus === s.status ? s : { ...s, status: appliedStatus };
        });
        if (appliedStatus === "idle") {
          // Ready is authoritative: release stale sendPrompt lock so 就绪 can
          // send/drain even while the prior session/prompt RPC is still open.
          releasePromptFlight(e.sessionId);
          window.setTimeout(() => {
            // Idle ⇒ CLI concurrent queue should be empty; drop server ghosts.
            stripStaleCliQueue(e.sessionId);
            flushPendingOfflineMerge(e.sessionId);
            // Stop-suppress is checked inside drainPromptQueue (must not only
            // gate this path — sendPrompt finally / error also call drain).
            if (suppressNextIdleDrain.has(e.sessionId)) {
              const n = (get().promptQueues[e.sessionId] ?? []).length;
              if (n > 0) {
                set({
                  queueNotice: {
                    id: uid(),
                    message: `已停止；队列仍保留 ${n} 条（不会自动发送，可清空或继续输入后发送）`,
                    state: "blocked",
                    at: Date.now(),
                  },
                });
              }
              return;
            }
            drainPromptQueue(e.sessionId);
          }, 0);
        } else if (
          appliedStatus === "running" ||
          appliedStatus === "awaiting_permission" ||
          appliedStatus === "awaiting_input"
        ) {
          // Live turn — drop queue rows that duplicate the active user bubble.
          window.setTimeout(() => pruneQueueGhosts(e.sessionId), 0);
        }
        break;
      }
      case "usage":
        withSession(e.sessionId, (s) => ({ ...s, usage: e.usage }), false);
        break;
      case "error": {
        // Defense: queue soft-fails must not force idle over a live turn.
        // (Bridge now prefers emitSoftError for concurrent queue failures.)
        const softQueueFail = e.message.startsWith("队列消息失败");
        withSession(e.sessionId, (s) => {
          const live =
            softQueueFail &&
            (s.status === "running" ||
              s.status === "awaiting_permission" ||
              s.status === "awaiting_input");
          return {
            ...s,
            ...(live ? {} : { status: "idle" as const }),
            blocks: [
              ...s.blocks,
              { type: "system", id: uid(), text: e.message, ts: Date.now(), kind: "error" },
            ],
          };
        });
        if (!softQueueFail) {
          releasePromptFlight(e.sessionId);
          window.setTimeout(() => {
            flushPendingOfflineMerge(e.sessionId);
            // Respect Stop-suppress (same as status→idle).
            drainPromptQueue(e.sessionId);
          }, 0);
        }
        break;
      }
      case "agent_reconnected": {
        // Crash recovery finished. New agent has empty server queue; old permission
        // RPCs and in-flight IIFEs cannot complete cleanly — force-idle everything
        // and re-home queues as local so drain can resume on the live child.
        submittedEnqueueIds.clear();
        consumedConcurrentIdsBySession.clear();
        consumedConcurrentTextsBySession.clear();
        // Reconnect is a clean slate — allow queue drain again.
        suppressNextIdleDrain.clear();
        for (const id of Object.keys(get().sessions)) {
          releasePromptFlight(id);
        }
        const queues = get().promptQueues;
        const nextQueues: typeof queues = {};
        for (const [id, entries] of Object.entries(queues)) {
          nextQueues[id] = entries.map((entry) => ({
            ...entry,
            source: "local" as const,
            state: entry.state === "sending" || entry.state === "interjected"
              ? ("queued" as const)
              : entry.state,
          }));
        }
        const live = get().sessions;
        const next: typeof live = {};
        for (const [id, session] of Object.entries(live)) {
          next[id] =
            session.status === "running" ||
            session.status === "awaiting_permission" ||
            session.status === "awaiting_input"
              ? {
                  ...session,
                  status: "idle",
                  // Stale permission/question cards are no longer actionable.
                  blocks: session.blocks.map((block) =>
                    block.type === "permission" && !block.resolved
                      ? { ...block, resolved: "deny" as const }
                      : block.type === "question" && !block.response
                        ? { ...block, response: { outcome: "cancelled" as const } }
                        : block.type === "assistant" && block.streaming
                          ? { ...block, streaming: false }
                          : block.type === "thinking" && block.live
                            ? { ...block, live: false }
                            : block.type === "tool" &&
                                (block.call.status === "running" ||
                                  block.call.status === "pending" ||
                                  block.call.status === "awaiting_permission")
                              ? {
                                  ...block,
                                  call: {
                                    ...block.call,
                                    status: "cancelled" as const,
                                    endedAt: Date.now(),
                                  },
                                }
                              : block,
                  ),
                }
              : session;
        }
        set({ sessions: next, promptQueues: nextQueues });
        window.setTimeout(() => {
          for (const id of Object.keys(get().sessions)) {
            flushPendingOfflineMerge(id);
            drainPromptQueue(id);
          }
        }, 0);
        break;
      }
      case "prompt_queue": {
        // CLI is authoritative for known ids, but must not wipe local-only rows
        // that have not been acknowledged yet (enqueue race with queue/changed).
        const previous = get().promptQueues[e.sessionId] ?? [];
        const fromCli: QueuedPrompt[] = e.entries.map((entry) => {
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
        let nextQueue = mergeCliQueueWithLocal(fromCli, previous);
        // Drop ghosts (consumed concurrent + live user bubbles). While busy,
        // also hide pure CLI echoes — they are not operator-pending follow-ups.
        nextQueue = filterQueueGhosts(e.sessionId, nextQueue);
        // Idle: never re-admit CLI-owned rows (late queue/changed after strip
        // used to resurrect concurrent ghosts as 已入队).
        if (!sessionIsBusy(e.sessionId)) {
          nextQueue = stripCliOwnedEntries(nextQueue);
        }
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

  /**
   * Active-turn primary user bubble text (not mid-turn 插话).
   * Used for duplicate-send guards when Enter-queueing the same text again.
   */
  const activeUserPromptText = (sessionId: string): string | null => {
    const texts = activeTurnUserTexts(sessionId);
    return texts[0] ?? null;
  };

  /**
   * All user-bubble texts in the live turn (primary + interjections), oldest first.
   * Concurrent enqueue does not always paint a user bubble — combined with
   * consumed concurrent id/text sets this still hides text-matched ghosts.
   */
  const activeTurnUserTexts = (sessionId: string): string[] => {
    const session = get().sessions[sessionId];
    if (!session) return [];
    if (
      session.status !== "running" &&
      session.status !== "awaiting_permission" &&
      session.status !== "awaiting_input"
    ) {
      return [];
    }
    let start = -1;
    for (let i = session.blocks.length - 1; i >= 0; i -= 1) {
      const block = session.blocks[i];
      if (block.type === "user" && !block.interjected) {
        start = i;
        break;
      }
    }
    if (start < 0) return [];
    const texts: string[] = [];
    for (let i = start; i < session.blocks.length; i += 1) {
      const block = session.blocks[i];
      if (block.type === "user") {
        const t = normalizeQueueText(block.text);
        if (t) texts.push(t);
      }
    }
    return texts;
  };

  const sessionIsBusy = (sessionId: string): boolean => {
    const status = get().sessions[sessionId]?.status;
    return (
      status === "running" ||
      status === "awaiting_permission" ||
      status === "awaiting_input"
    );
  };

  /** Drop ghosts: consumed concurrent (id+text), live bubbles; hide CLI while busy. */
  const filterQueueGhosts = <T extends { id: string; text: string; source?: "local" | "cli"; state?: "queued" | "interjected" | "sending" }>(
    sessionId: string,
    queue: T[],
  ): T[] => {
    const { ids, texts } = consumedSets(sessionId);
    if (sessionIsBusy(sessionId)) {
      const busy = filterBusyTurnQueueEntries(queue as Array<T & { state: "queued" | "interjected" | "sending" }>, {
        consumedIds: ids,
        consumedTexts: texts,
      }) as T[];
      return filterQueueGhostsByLiveTexts(busy, activeTurnUserTexts(sessionId));
    }
    const afterConsumed = filterConsumedQueueEntries(queue, ids, texts);
    return filterQueueGhostsByLiveTexts(afterConsumed, activeTurnUserTexts(sessionId));
  };

  /** Remove queue ghosts from state if any match live bubbles / consumed ids. */
  const pruneQueueGhosts = (sessionId: string) => {
    const queue = get().promptQueues[sessionId] ?? [];
    const next = filterQueueGhosts(sessionId, queue);
    if (next.length === queue.length) return;
    for (const item of queue) {
      if (!next.some((row) => row.id === item.id)) {
        submittedEnqueueIds.delete(item.id);
      }
    }
    set({
      promptQueues: {
        ...get().promptQueues,
        [sessionId]: next,
      },
    });
  };

  /** Remove queue rows by id and/or normalized text (CLI may re-id the same prompt). */
  const dropQueueRows = (sessionId: string, match: { id?: string; text?: string }) => {
    const queue = get().promptQueues[sessionId] ?? [];
    if (queue.length === 0) return;
    const norm = normalizeQueueText(match.text);
    const next = queue.filter((item) => {
      if (match.id && item.id === match.id) return false;
      if (norm && normalizeQueueText(item.text) === norm) return false;
      return true;
    });
    if (next.length === queue.length) return;
    for (const item of queue) {
      if (!next.some((row) => row.id === item.id)) {
        submittedEnqueueIds.delete(item.id);
      }
    }
    set({
      promptQueues: {
        ...get().promptQueues,
        [sessionId]: next,
      },
    });
  };

  const patchQueueEntryState = (
    sessionId: string,
    entryId: string,
    state: "queued" | "interjected" | "sending",
  ) => {
    const queue = get().promptQueues[sessionId] ?? [];
    if (!queue.some((item) => item.id === entryId)) return;
    set({
      promptQueues: {
        ...get().promptQueues,
        [sessionId]: queue.map((item) =>
          item.id === entryId ? { ...item, state } : item,
        ),
      },
    });
  };

  /** On idle, drop CLI-owned rows (server queue is empty after settle).
   * Keep consumed concurrent id/text fingerprints so a late queue/changed
   * cannot resurrect the same follow-up as 已入队 after strip. */
  const stripStaleCliQueue = (sessionId: string) => {
    const queue = get().promptQueues[sessionId] ?? [];
    const next = stripCliOwnedEntries(queue);
    if (next.length === queue.length) return;
    for (const item of queue) {
      if (item.source === "cli") submittedEnqueueIds.delete(item.id);
    }
    set({
      promptQueues: {
        ...get().promptQueues,
        [sessionId]: next,
      },
    });
  };

  /** Pop and send the next *local* queued follow-up when the session is idle.
   * CLI-owned entries are executed by the agent via concurrent session/prompt. */
  const drainPromptQueue = (sessionId: string) => {
    const state = get();
    const session = state.sessions[sessionId];
    const queue = state.promptQueues[sessionId] ?? [];
    // Ready (idle) is enough — do not wait on promptInFlightSessions. That set
    // can lag after finishTurn while session/prompt is still awaiting; blocking
    // drain here left 队列 stuck under a 就绪 status bar.
    // Skip deleted missions (tombstone) and missing sessions.
    if (
      !session ||
      offlineHistoryDeleted.has(sessionId) ||
      session.status !== "idle" ||
      queue.length === 0
    ) {
      return;
    }

    // Operator Stop: park queue until they re-send or clear (all drain callers).
    if (suppressNextIdleDrain.has(sessionId)) {
      return;
    }

    // Prefer interjected, then first local-owned entry that is not mid concurrent
    // write. Do NOT delete submitted/sending rows — a failed write restores them
    // to `queued`; dropping here made follow-ups vanish permanently.
    const localIndex = queue.findIndex(
      (item) =>
        item.source !== "cli" &&
        item.state !== "sending" &&
        !submittedEnqueueIds.has(item.id),
    );
    if (localIndex < 0) {
      // Only CLI / in-flight concurrent rows remain — leave them alone.
      return;
    }

    const next = queue[localIndex];
    const rest = queue.filter((_, index) => index !== localIndex);
    set({
      promptQueues: {
        ...get().promptQueues,
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

  /**
   * Interject fallback when `x.ai/interject` is missing or fails:
   * pin local queue head (state=interjected) and best-effort push to the CLI
   * concurrent queue with sendNow so priority is not worse than plain Enter-queue.
   */
  const pinInterjectQueueHead = (
    sessionId: string,
    entry: QueuedPrompt,
    noticeMessage: string,
    composerBase: SessionComposerState,
    promptOpts: { model: string; effort: Effort; mode: AgentMode },
    attachments: PromptAttachment[],
    trimmed: string,
  ) => {
    const nextComposers = {
      ...get().sessionComposers,
      [sessionId]: { ...composerBase, text: "", attachments: [] },
    };
    persistSessionComposers(nextComposers);
    const prior = get().promptQueues[sessionId] ?? [];
    const norm = normalizeQueueText(trimmed);
    // Drop same id and same text so pin does not stack a duplicate follow-up.
    set({
      promptQueues: {
        ...get().promptQueues,
        [sessionId]: [
          entry,
          ...prior.filter(
            (item) =>
              item.id !== entry.id &&
              (!norm || normalizeQueueText(item.text) !== norm),
          ),
        ],
      },
      sessionComposers: nextComposers,
      queueNotice: {
        id: uid(),
        entryId: entry.id,
        message: noticeMessage,
        state: "interjected",
        at: Date.now(),
      },
    });

    // Fire-and-forget: do not block Composer "插话中…" on concurrent session/prompt.
    void (async () => {
      if (bridge.prepareComputerForPrompt) {
        const cu = await bridge.prepareComputerForPrompt(sessionId, trimmed);
        if (cu === "refused") {
          const q = get().promptQueues[sessionId] ?? [];
          const comps = get().sessionComposers;
          const cur = comps[sessionId] ?? composerBase;
          const restored = {
            ...comps,
            [sessionId]: {
              ...cur,
              text: trimmed || cur.text,
              attachments: attachments.length > 0 ? [...attachments] : cur.attachments,
            },
          };
          persistSessionComposers(restored);
          set({
            promptQueues: {
              ...get().promptQueues,
              [sessionId]: q.filter((item) => item.id !== entry.id),
            },
            sessionComposers: restored,
            queueNotice: {
              id: uid(),
              message: COMPUTER_USE_OPT_IN_REFUSE_MESSAGE,
              state: "blocked",
              at: Date.now(),
            },
          });
          return;
        }
      }
      submittedEnqueueIds.add(entry.id);
      patchQueueEntryState(sessionId, entry.id, "sending");
      try {
        await bridge.enqueuePrompt(
          sessionId,
          trimmed,
          {
            model: promptOpts.model,
            effort: promptOpts.effort,
            mode: promptOpts.mode,
            attachments,
          },
          { promptId: entry.id, sendNow: true },
        );
        // Wire write ok — drop by id+text; mark consumed so CLI cannot resurrect.
        submittedEnqueueIds.delete(entry.id);
        markConsumedConcurrent(sessionId, entry.id, trimmed);
        dropQueueRows(sessionId, { id: entry.id, text: trimmed });
      } catch {
        // CLI rejected concurrency — keep local ownership; drain on idle.
        submittedEnqueueIds.delete(entry.id);
        patchQueueEntryState(sessionId, entry.id, "interjected");
      }
    })();
  };

  /** Apply offline transcript deferred because a turn was in flight. */
  function flushPendingOfflineMerge(sessionId: string): void {
    const pending = pendingOfflineMerge.get(sessionId);
    if (!pending) return;
    if (offlineHistoryDeleted.has(sessionId)) {
      pendingOfflineMerge.delete(sessionId);
      return;
    }
    if (promptInFlightSessions.has(sessionId)) return;
    const cur = get().sessions[sessionId];
    if (
      cur &&
      (cur.status === "running" ||
        cur.status === "awaiting_permission" ||
        cur.status === "awaiting_input")
    ) {
      return;
    }
    pendingOfflineMerge.delete(sessionId);
    const merged = mergeOfflineWithLive(pending, cur);
    set({ sessions: { ...get().sessions, [sessionId]: merged } });
    if (merged.blocks.length > 0) scheduleSaveSessionCache(merged);
    offlineHistoryComplete.add(sessionId);
  }

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
    fullHistoryLoadingId: null,
    historyLoadMode: null,
    agentBindStartedAt: null,
    diskHistoryProgress: null,
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
    planPreviewOpen: false,

    model: localStorage.getItem("grok.model") ?? "grok-build",
    models: MODELS,
    modelsUpdatedAt: 0,
    effort: (localStorage.getItem("grok.effort") as Effort) ?? "high",
    mode: "agent",
    permissionMode: readStoredPermissionMode(),
    sessionComposers: loadSessionComposers(),
    promptQueues: {},
    queueNotice: null,

    inspectorOpen: true,
    terminalOpen: false,
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
      // Offline full-history worker (Rust thread) → progressive UI upgrade.
      // Never goes through ACP session/load, so switching stays responsive.
      if (bridge.kind === "acp") {
        // Terminal session only (progress is polled — see startOfflineScanPoll).
        void listen<DiskHistoryProgress>("disk-history-progress", (event) => {
          const payload = event.payload;
          if (!payload?.id || !payload.done) return;

          // Always free the scanning slot for this id (including cancelled abandon).
          offlineHistoryScanning.delete(payload.id);

          // Tombstone: deleted missions must not be resurrected by late scan.
          if (offlineHistoryDeleted.has(payload.id)) {
            if (get().fullHistoryLoadingId === payload.id) {
              set({
                fullHistoryLoadingId: null,
                historyLoadMode: null,
                diskHistoryProgress: null,
              });
            } else if (get().diskHistoryProgress?.id === payload.id) {
              set({ diskHistoryProgress: null });
            }
            return;
          }

          const loadingId = get().fullHistoryLoadingId;
          const progressId = get().diskHistoryProgress?.id ?? null;
          // Never stop the poll for an unrelated session's terminal event.
          if (loadingId === payload.id || progressId === payload.id) {
            stopOfflineScanPoll();
          } else if (loadingId && loadingId !== payload.id && offlineHistoryScanning.has(loadingId)) {
            // Keep progress alive for the session that is still scanning.
            startOfflineScanPoll(loadingId);
          }

          // Only merge body if still in catalog or memory (not deleted mid-scan).
          const stillCatalogued = get().sessionIndex.some((m) => m.id === payload.id);
          const existing = get().sessions[payload.id];
          if (!stillCatalogued && !existing) {
            if (get().fullHistoryLoadingId === payload.id && get().historyLoadMode === "disk") {
              set({
                fullHistoryLoadingId: null,
                historyLoadMode: null,
                diskHistoryProgress: null,
              });
            }
            return;
          }

          const liveBusy =
            existing &&
            (existing.status === "running" ||
              existing.status === "awaiting_permission" ||
              existing.status === "awaiting_input" ||
              promptInFlightSessions.has(payload.id));

          const phaseComplete =
            payload.phase === "complete" ||
            payload.phase === "no-updates" ||
            payload.phase === "missing";

          // cancelled/error are retryable — do not permanent-complete until merge
          // can run. Live turn must not mark complete (else re-open never rescans).
          if (payload.session) {
            const next = normalizeOfflineSession(payload.session, existing);
            if (next && !offlineHistoryDeleted.has(payload.id)) {
              if (liveBusy) {
                pendingOfflineMerge.set(payload.id, next);
              } else {
                pendingOfflineMerge.delete(payload.id);
                window.setTimeout(() => {
                  if (offlineHistoryDeleted.has(payload.id)) return;
                  if (promptInFlightSessions.has(payload.id)) {
                    pendingOfflineMerge.set(payload.id, next);
                    return;
                  }
                  const cur = get().sessions[payload.id];
                  if (
                    cur &&
                    (cur.status === "running" ||
                      cur.status === "awaiting_permission" ||
                      cur.status === "awaiting_input")
                  ) {
                    pendingOfflineMerge.set(payload.id, next);
                    return;
                  }
                  const merged = mergeOfflineWithLive(next, cur);
                  set({
                    sessions: { ...get().sessions, [payload.id]: merged },
                  });
                  if (merged.blocks.length > 0) scheduleSaveSessionCache(merged);
                  if (phaseComplete) offlineHistoryComplete.add(payload.id);
                }, 0);
              }
            } else if (phaseComplete && !liveBusy) {
              offlineHistoryComplete.add(payload.id);
            }
          } else if (phaseComplete && !liveBusy) {
            offlineHistoryComplete.add(payload.id);
          }

          if (get().fullHistoryLoadingId === payload.id && get().historyLoadMode === "disk") {
            set({
              fullHistoryLoadingId: null,
              historyLoadMode: null,
              diskHistoryProgress: null,
            });
          } else if (get().diskHistoryProgress?.id === payload.id) {
            set({ diskHistoryProgress: null });
          }
        }).catch((error) => {
          console.warn("disk-history-progress listen failed", error);
        });
      }
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
        // Product default Auto: if the operator never set a mode, persist + push to bridge.
        if (localStorage.getItem("grok.permissionMode") == null) {
          localStorage.setItem("grok.permissionMode", DEFAULT_PERMISSION_MODE);
          bridge.setPermissionMode(DEFAULT_PERMISSION_MODE);
          set({ permissionMode: DEFAULT_PERMISSION_MODE });
        } else {
          bridge.setPermissionMode(get().permissionMode);
        }
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
            if (get().providerSwitching) return;
            workspaceWatchTick += 1;
            // Diff poll only when inspector is open (otherwise wasted agent IPC).
            if (get().inspectorOpen && workspaceWatchTick % 2 === 0) {
              void get().refreshWorkspaceDiffs();
            }
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
        const id = await get().newSession();
        if (id) get().sendPrompt(prompt, [], id);
      }
    },

    goHome: () => {
      bumpOpenSessionGeneration();
      if (bridge.kind === "acp") {
        void invoke("cancel_offline_session_history").catch(() => {});
      }
      stopOfflineScanPoll();
      offlineHistoryScanning.clear();
      if (get().historyLoadMode === "agent") {
        // Keep agent-bind chrome if first-send is mid-flight; drop disk banner only.
        set({
          view: "home",
          activeId: null,
          planPreviewOpen: false,
          diskHistoryProgress: null,
        });
      } else {
        set({
          view: "home",
          activeId: null,
          planPreviewOpen: false,
          fullHistoryLoadingId: null,
          historyLoadMode: null,
          agentBindStartedAt: null,
          diskHistoryProgress: null,
        });
      }
    },

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
      // R22: reuse shared dual-gate (HTTPS + non-metadata) before open_external.
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !isSafeMarkdownOpenUrl(parsed)) return;
        await invoke("open_external", { url: parsed.toString() });
      } catch {
        // invalid URL — ignore
      }
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
      // STABLE + COMPLETE HISTORY:
      // - Opening NEVER calls ACP session/load (that freezes on 100MB+ updates.jsonl).
      // - Instant paint from memory / chat_history / UI cache.
      // - Background Rust thread streams updates.jsonl (skips thoughts, cancelable).
      // - Agent bind still happens only on first send (model context).
      try {
        const current = get();
        if (current.activeId === id && current.sessions[id] && current.view === "session") {
          // Still upgrade offline history if we never finished — but never restart
          // an in-flight scan (that killed the worker and froze the progress bar).
          if (
            bridge.kind === "acp" &&
            !offlineHistoryComplete.has(id) &&
            !offlineHistoryScanning.has(id) &&
            current.historyLoadMode !== "disk" &&
            current.historyLoadMode !== "agent" &&
            !promptInFlightSessions.has(id)
          ) {
            offlineHistoryScanning.add(id);
            set({ fullHistoryLoadingId: id, historyLoadMode: "disk" });
            startOfflineScanPoll(id);
            void invoke("start_offline_session_history", {
              id,
              title: current.sessions[id]?.title ?? null,
              cwd: current.sessions[id]?.cwd ?? null,
              model: current.sessions[id]?.model ?? null,
            }).catch((error) => {
              console.warn("start_offline_session_history failed", error);
              offlineHistoryScanning.delete(id);
              if (get().fullHistoryLoadingId === id && get().historyLoadMode === "disk") {
                set({ fullHistoryLoadingId: null, historyLoadMode: null, diskHistoryProgress: null });
              }
            });
          } else if (offlineHistoryScanning.has(id) || current.historyLoadMode === "disk") {
            set({ fullHistoryLoadingId: id, historyLoadMode: "disk" });
            startOfflineScanPoll(id);
          }
          return;
        }

        // Switching missions: free previous scanning slot. Do NOT call
        // cancel_offline here — it races with start_offline and can mark the
        // new gen cancelled. start_offline already bumps OFFLINE_HISTORY_GEN.
        const prevId = current.activeId;
        if (bridge.kind === "acp" && prevId && prevId !== id) {
          offlineHistoryScanning.delete(prevId);
          stopOfflineScanPoll();
        }

        openSessionTargetId = id;
        const openGen = ++openSessionGeneration;
        const stillThisOpen = () =>
          openGen === openSessionGeneration && openSessionTargetId === id;

        const meta = current.sessionIndex.find((entry) => entry.id === id);
        if (meta) bridge.rememberSessionMeta?.(meta);

        const state = get();
        const has = state.sessions[id];
        const globalPermission = state.permissionMode || DEFAULT_PERMISSION_MODE;
        const composer = {
          ...normalizeComposer(state.sessionComposers[id], {
            model: state.model || state.models[0]?.id || MODELS[0]?.id || "grok-build",
            effort: state.effort || "high",
            mode: state.mode || "agent",
            permissionMode: globalPermission,
          }),
          permissionMode: globalPermission,
        };
        const sessionComposers = { ...state.sessionComposers, [id]: composer };
        persistSessionComposers(sessionComposers);

        // Explicit open means the mission is back in play for this process.
        offlineHistoryDeleted.delete(id);

        const kickOfflineHistory = (session?: Session | null) => {
          if (!stillThisOpen()) return;
          if (bridge.kind !== "acp") return;
          if (offlineHistoryDeleted.has(id)) return;
          if (offlineHistoryComplete.has(id)) return;
          // Already scanning this id — join poll, do not re-invoke.
          if (offlineHistoryScanning.has(id)) {
            set({ fullHistoryLoadingId: id, historyLoadMode: "disk" });
            startOfflineScanPoll(id);
            return;
          }
          offlineHistoryScanning.add(id);
          set({
            fullHistoryLoadingId: id,
            historyLoadMode: "disk",
            diskHistoryProgress: {
              id,
              percent: 0,
              bytesRead: 0,
              totalBytes: 0,
              lines: 0,
              blocks: 0,
            },
          });
          startOfflineScanPoll(id);
          void invoke("start_offline_session_history", {
            id,
            title: session?.title ?? meta?.title ?? null,
            cwd: session?.cwd ?? meta?.cwd ?? null,
            model: session?.model ?? meta?.model ?? null,
          }).catch((error) => {
            console.warn("start_offline_session_history failed", error);
            offlineHistoryScanning.delete(id);
            stopOfflineScanPoll();
            if (get().fullHistoryLoadingId === id && get().historyLoadMode === "disk") {
              set({ fullHistoryLoadingId: null, historyLoadMode: null, diskHistoryProgress: null });
            }
          });
        };

        const applyChrome = (session?: Session | null, opts?: { loadingDisk?: boolean }) => {
          if (!stillThisOpen() || offlineHistoryDeleted.has(id)) return;
          const crossProject = meta && !samePath(meta.cwd, get().workspace);
          const projects =
            meta && crossProject
              ? ensureProject(get().projects, meta.cwd, { force: true })
              : get().projects;
          let painted = session ?? null;
          // Do not force idle while a send/bind is in flight (double-prompt race).
          if (
            painted &&
            !bridge.isSessionBound?.(painted.id) &&
            painted.status === "running" &&
            !promptInFlightSessions.has(painted.id)
          ) {
            painted = { ...painted, status: "idle" };
          }
          const loadingDisk = Boolean(opts?.loadingDisk) && !offlineHistoryComplete.has(id);
          // Preserve in-flight agent bind chrome for another session.
          const keepAgent =
            get().historyLoadMode === "agent" &&
            get().fullHistoryLoadingId != null &&
            get().fullHistoryLoadingId !== id;
          set({
            activeId: id,
            view: "session",
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            permissionMode: composer.permissionMode,
            sessionComposers,
            startupError: null,
            queueNotice: keepAgent ? get().queueNotice : null,
            fullHistoryLoadingId: loadingDisk
              ? id
              : keepAgent
                ? get().fullHistoryLoadingId
                : null,
            historyLoadMode: loadingDisk
              ? "disk"
              : keepAgent
                ? "agent"
                : null,
            ...(painted ? { sessions: { ...get().sessions, [id]: painted } } : {}),
            ...(meta && crossProject
              ? {
                  workspace: meta.cwd,
                  projects,
                  activeProjectId: projectId(meta.cwd),
                  workspaceDiffs: [],
                  workspaceDiffReady: false,
                  projectPreview: { status: "idle" as const },
                  previewOpen: false,
                  previewFile: null,
                  planPreviewOpen: false,
                }
              : meta
                ? { activeProjectId: projectId(meta.cwd) }
                : {}),
          });
          try {
            bridge.setPermissionMode(composer.permissionMode, id);
          } catch {
            /* ignore */
          }
          if (meta && crossProject) {
            window.setTimeout(() => {
              if (get().activeId !== id) return;
              void bridge.setWorkspace(meta.cwd).catch(() => {});
              void get().refreshWorkspaceFiles();
              void get().refreshWorkspaceDiffs();
            }, 0);
          }
        };

        // 1) Memory hit (may already be full if offline scan or send finished earlier)
        if (has) {
          applyChrome(has, { loadingDisk: !offlineHistoryComplete.has(id) });
          kickOfflineHistory(has);
          return;
        }

        // 2) Durable offline transcript (fingerprint-matched) — skip 100MB+ rescan
        if (bridge.kind === "acp") {
          try {
            const raw = await invoke<string | null>("get_ui_transcript", { id });
            if (!stillThisOpen()) return;
            if (raw) {
              const transcript = normalizeOfflineSession(JSON.parse(raw) as Session);
              if (transcript && transcript.id === id && transcript.blocks.length > 0) {
                offlineHistoryComplete.add(id);
                applyChrome(transcript, { loadingDisk: false });
                scheduleSaveSessionCache(transcript);
                return;
              }
            }
          } catch (error) {
            console.warn("get_ui_transcript failed", error);
          }
        }
        if (!stillThisOpen()) return;

        // 3) Disk chat_history.jsonl — real conversation text, ~instant
        try {
          const raw = await invoke<string | null>("preview_session_from_disk", {
            id,
            title: meta?.title ?? null,
            cwd: meta?.cwd ?? null,
            model: meta?.model ?? null,
          });
          if (!stillThisOpen()) return;
          if (raw) {
            const preview = normalizeOfflineSession(JSON.parse(raw) as Session);
            if (preview && preview.id === id && preview.blocks.length > 0) {
              applyChrome(preview, { loadingDisk: true });
              kickOfflineHistory(preview);
              return;
            }
          }
        } catch (error) {
          console.warn("preview_session_from_disk failed", error);
        }
        if (!stillThisOpen()) return;

        // 4) App UI cache (thin live-stream snapshot)
        const cached = await loadSessionCache(id);
        if (!stillThisOpen()) return;
        if (cached) {
          applyChrome(cached, { loadingDisk: !offlineHistoryComplete.has(id) });
          kickOfflineHistory(cached);
          return;
        }

        // 5) Empty shell — brand-new mission; still try offline (may only have updates)
        const shell = meta
          ? {
              ...meta,
              blocks: [] as SessionBlock[],
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                costUSD: 0,
                contextUsed: 0,
                contextMax: 0,
                turns: 0,
              },
              status: "idle" as const,
            }
          : null;
        applyChrome(shell, { loadingDisk: true });
        kickOfflineHistory(shell);
      } catch (error) {
        set({
          startupError: error instanceof Error ? error.message : String(error),
          view: "home",
          activeId: null,
          fullHistoryLoadingId: null,
          historyLoadMode: null,
          agentBindStartedAt: null,
          diskHistoryProgress: null,
        });
      }
    },

    async newSession() {
      try {
        // Invalidate in-flight openSession so a late applyChrome cannot steal focus.
        bumpOpenSessionGeneration();
        // session_ready fires during this await while activeId is often still null
        // (Home). That path only *stores* the session — it does not focus. Focus
        // here so Home launch + sendPrompt actually target the new id.
        const id = await bridge.newSession(get().workspace);
        const session = get().sessions[id];
        const projects = session
          ? ensureProject(get().projects, session.cwd, { force: true })
          : get().projects;
        const composer = normalizeComposer(get().sessionComposers[id], {
          model: get().model || get().models[0]?.id || MODELS[0]?.id || "grok-build",
          effort: get().effort || "high",
          mode: get().mode || "agent",
          permissionMode: get().permissionMode || DEFAULT_PERMISSION_MODE,
        });
        const sessionComposers = { ...get().sessionComposers, [id]: composer };
        persistSessionComposers(sessionComposers);
        bridge.setPermissionMode(composer.permissionMode, id);
        set({
          startupError: null,
          activeId: id,
          view: "session",
          sessionComposers,
          model: composer.model,
          effort: composer.effort,
          mode: composer.mode,
          permissionMode: composer.permissionMode,
          ...(session
            ? {
                workspace: session.cwd,
                activeProjectId: projectId(session.cwd),
                projects,
              }
            : {}),
        });
        return id;
      } catch (error) {
        set({ startupError: error instanceof Error ? error.message : String(error) });
        return null;
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
      bumpOpenSessionGeneration();
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
        planPreviewOpen: false,
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

    async forceReconnectAgent() {
      if (!bridge.forceReconnectAgent) {
        throw new Error("当前桥接不支持手动重连 Agent");
      }
      try {
        await bridge.forceReconnectAgent();
        set({
          auth: await bridge.getAuthState(),
          startupError: null,
        });
      } catch (error) {
        set({
          auth: await bridge.getAuthState().catch(() => get().auth),
          startupError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
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
        if (activeId) {
          await bridge.loadSession(activeId, { background: true, silent: true });
        }
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
      if (get().providerSwitching || promptInFlightSessions.size > 0) {
        await get().refreshProviderProfiles();
        set({
          startupError:
            "供应商已保存。当前有任务/切换进行中，请稍后再在输入框左侧切换到该供应商。",
        });
        return profile;
      }
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
        if (activeId && get().activeId === activeId && get().sessions[activeId]) {
          await bridge.loadSession(activeId, { background: true, silent: true });
        }
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
      if (get().providerSwitching) {
        throw new Error("正在切换模型服务，请稍候");
      }
      if (Object.values(get().sessions).some((session) => session.status !== "idle")) {
        throw new Error("请先终止正在执行的任务，再切换模型服务");
      }
      if (promptInFlightSessions.size > 0) {
        throw new Error("请等待当前发送完成，再切换模型服务");
      }
      const activeId = get().activeId;
      set({ providerSwitching: true });
      try {
        await bridge.activateProviderProfile(id);
        await get().refreshProviderProfiles();
        await Promise.all([get().refreshAccount(), get().refreshModels()]);
        // Re-bind only if still the same focused mission after the agent restart.
        if (activeId && get().activeId === activeId && get().sessions[activeId]) {
          await bridge.loadSession(activeId, { background: true, silent: true });
        }
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
          if (activeId) {
            await bridge.loadSession(activeId, { background: true, silent: true });
          }
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
        // Opens official install docs in the browser (no remote irm|iex).
        // Throws with instructions when CLI is not yet on PATH.
        await invoke<GrokRuntimeInfo>("install_official_grok_cli");
        await get().refreshRuntime();
        set({ runtimeBusy: false });
      } catch (error) {
        set({ runtimeBusy: false });
        // Still re-detect after user may have installed out-of-band.
        try {
          await get().refreshRuntime();
        } catch {
          /* ignore */
        }
        throw error;
      }
    },

    setAccountSetupOpen: (accountSetupOpen) => set({ accountSetupOpen }),

    async refreshWorkspaceFiles() {
      if (workspaceFilesInFlight) return;
      workspaceFilesInFlight = true;
      try {
        const workspaceFiles = await invoke<WorkspaceEntry[]>("list_workspace_files", {
          cwd: get().workspace,
        });
        set({ workspaceFiles });
      } catch (error) {
        set({ previewError: error instanceof Error ? error.message : String(error) });
      } finally {
        workspaceFilesInFlight = false;
      }
    },

    async refreshWorkspaceDiffs() {
      if (bridge.kind === "mock") return;
      if (workspaceDiffsInFlight) return;
      const now = Date.now();
      // Min 3.5s between full diffs — interval + agent cost on large repos.
      if (now - lastWorkspaceDiffAt < 3_500) return;
      workspaceDiffsInFlight = true;
      lastWorkspaceDiffAt = now;
      try {
        const response = await bridge.callExtension<unknown>("x.ai/git/diffs", {
          gitRoot: get().workspace,
          from: "HEAD",
          to: "working",
          includePatch: true,
          // Patch is enough for UI hunks; full file contents double IPC size.
          includeContent: false,
          maxPatchBytes: 1_000_000,
          maxPatchLines: 12_000,
        });
        set({ workspaceDiffs: mapGitDiffs(response), workspaceDiffReady: true });
      } catch {
        // Non-git workspaces and older agents simply have no project-level diff.
      } finally {
        workspaceDiffsInFlight = false;
      }
    },

    async refreshProjectPreview(start = false, opts?: { confirmStart?: boolean }) {
      if (bridge.kind === "mock") {
        set({ projectPreview: { status: "none" } });
        return;
      }
      try {
        // Never use window.confirm (unreliable in Tauri WebView). The Inspector
        // in-app confirm UI must pass confirmStart:true after the operator accepts.
        const confirmStart = start === true && opts?.confirmStart === true;
        if (start && !confirmStart) {
          // Detect-only probe: do not spawn package.json scripts.
          const projectPreview = await invoke<ProjectPreview>("start_project_preview", {
            cwd: get().workspace,
            start: false,
            confirmStart: false,
          });
          set({ projectPreview });
          return;
        }
        const projectPreview = await invoke<ProjectPreview>("start_project_preview", {
          cwd: get().workspace,
          start,
          confirmStart,
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
      // Project preview iframe only loads loopback — blocks arbitrary https phishing.
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) {
          throw new Error("preview protocol");
        }
        const host = parsed.hostname.toLowerCase();
        const loopback =
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "[::1]" ||
          host === "::1";
        if (!loopback) {
          set({
            projectPreview: {
              ...get().projectPreview,
              status: "error",
              error: "项目预览仅允许 localhost / 127.0.0.1",
              url: undefined,
            },
          });
          return;
        }
        set({ projectPreview: { ...get().projectPreview, status: "ready", url: parsed.toString() } });
      } catch {
        set({
          projectPreview: {
            ...get().projectPreview,
            status: "error",
            error: "无效的预览地址",
            url: undefined,
          },
        });
      }
    },

    async openPreview(path) {
      const gen = ++previewOpenGeneration;
      set({
        previewOpen: true,
        planPreviewOpen: false,
        previewLoading: true,
        previewError: null,
      });
      try {
        const previewFile = await invoke<PreviewFile>("read_preview_file", {
          cwd: get().workspace,
          path,
        });
        if (gen !== previewOpenGeneration) return;
        set({ previewFile, previewLoading: false });
      } catch (error) {
        if (gen !== previewOpenGeneration) return;
        set({
          previewFile: null,
          previewLoading: false,
          previewError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    closePreview: () => {
      previewOpenGeneration += 1;
      set({ previewOpen: false, previewFile: null, previewError: null });
    },

    async deleteSession(id) {
      // Tombstone first so late offline scan / in-flight openSession cannot resurrect.
      offlineHistoryDeleted.add(id);
      pendingOfflineMerge.delete(id);
      releasePromptFlight(id);
      suppressNextIdleDrain.add(id);
      clearConsumedConcurrent(id);
      for (const entry of get().promptQueues[id] ?? []) {
        submittedEnqueueIds.delete(entry.id);
      }
      cancelSaveSessionCache(id);
      // Only abort openSession if it targets this id (do not cancel opening B when deleting A).
      if (openSessionTargetId === id || get().activeId === id) {
        bumpOpenSessionGeneration();
      }
      offlineHistoryScanning.delete(id);
      offlineHistoryComplete.delete(id);
      if (get().fullHistoryLoadingId === id || get().diskHistoryProgress?.id === id) {
        stopOfflineScanPoll();
        // Abandon any in-flight worker; gen bump is enough (start owns finish).
        if (bridge.kind === "acp") {
          void invoke("cancel_offline_session_history").catch(() => {});
        }
      }
      // Drop local queue *before* cancel — cancel→idle must not drain a dying mission.
      const { sessionIndex, sessions, activeId, sessionComposers, promptQueues } = get();
      const rest = { ...sessions };
      delete rest[id];
      const nextComposers = { ...sessionComposers };
      delete nextComposers[id];
      persistSessionComposers(nextComposers);
      const nextIndex = sessionIndex.filter((m) => m.id !== id);
      persistSessionCatalog(nextIndex);
      const nextQueues = { ...promptQueues };
      delete nextQueues[id];
      set({
        sessionIndex: nextIndex,
        sessions: rest,
        sessionComposers: nextComposers,
        promptQueues: nextQueues,
        ...(activeId === id
          ? {
              activeId: null,
              view: "home" as View,
              fullHistoryLoadingId: null,
              historyLoadMode: null,
              diskHistoryProgress: null,
              agentBindStartedAt: null,
              queueNotice: null,
            }
          : get().fullHistoryLoadingId === id
            ? {
                fullHistoryLoadingId: null,
                historyLoadMode: null,
                diskHistoryProgress: null,
              }
            : {}),
      });
      try {
        await bridge.deleteSession(id);
      } finally {
        suppressNextIdleDrain.delete(id);
      }
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
      if (!session) return false;

      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return false;

      const composer = sessionComposers[session.id] ?? {
        text: "",
        attachments: [],
        model,
        effort,
        mode,
        permissionMode,
      };

      // Busy / gate turn — queue follow-ups (never send as a fresh primary turn).
      // awaiting_permission / awaiting_input used to hard-block; operators often
      // type the next instruction while approving tools — park it in the local queue.
      if (session.status !== "idle") {
        const existingQueue = promptQueues[session.id] ?? [];
        // Double-Enter / sticky key: do not stack identical follow-ups.
        if (queueHasSameText(existingQueue, trimmed)) {
          set({
            queueNotice: {
              id: uid(),
              message: "相同消息已在队列中",
              state: "duplicate",
              at: Date.now(),
            },
          });
          return false;
        }
        // Already the live user bubble — ignore (would become a ghost 已入队 row).
        // Both sides normalized (whitespace collapse) so prune and dedup agree.
        const liveText = activeUserPromptText(session.id);
        if (liveText && liveText === normalizeQueueText(trimmed)) {
          set({
            queueNotice: {
              id: uid(),
              message: "该消息已在当前回合执行中",
              state: "duplicate",
              at: Date.now(),
            },
          });
          return false;
        }
        const consumedText = normalizeQueueText(trimmed);
        if (
          consumedText &&
          consumedSets(session.id).texts?.has(consumedText)
        ) {
          set({
            queueNotice: {
              id: uid(),
              message: "该消息已提交到当前回合（并发处理中）",
              state: "duplicate",
              at: Date.now(),
            },
          });
          return false;
        }
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
        const depth = existingQueue.length + 1;
        const gated =
          session.status === "awaiting_permission" || session.status === "awaiting_input";
        const isPlan = session.blocks.some(
          (block) =>
            block.type === "permission" &&
            !block.resolved &&
            block.id.startsWith("plan-approval-"),
        );
        const gateHint = gated
          ? session.status === "awaiting_input"
            ? "（回答问题后将自动发送）"
            : isPlan
              ? "（批准/拒绝计划后将自动发送）"
              : "（处理权限后将自动发送）"
          : "";
        set({
          promptQueues: {
            ...promptQueues,
            [session.id]: [...existingQueue, entry],
          },
          sessionComposers: nextComposers,
          queueNotice: {
            id: uid(),
            entryId: entry.id,
            message: `已加入队列（第 ${depth} 条）${gateHint}`,
            state: "queued",
            at: Date.now(),
          },
        });

        // Permission / question gate: local queue only — concurrent session/prompt
        // mid-permission confuses most CLIs. Drain when the turn returns to idle.
        if (gated) {
          return true;
        }

        // CU ensure on concurrent queue (same refuse/attach policy as promptInner).
        void (async () => {
          if (bridge.prepareComputerForPrompt) {
            const cu = await bridge.prepareComputerForPrompt(session.id, trimmed);
            if (cu === "refused") {
              // Drop the queue entry and restore the draft — queue path already
              // cleared sessionComposers; losing the text on CU refuse is a UX bug.
              const q = get().promptQueues[session.id] ?? [];
              const comps = get().sessionComposers;
              const cur = comps[session.id] ?? composer;
              const restored = {
                ...comps,
                [session.id]: {
                  ...cur,
                  text: trimmed || cur.text,
                  attachments: attachments.length > 0 ? [...attachments] : cur.attachments,
                },
              };
              persistSessionComposers(restored);
              set({
                promptQueues: {
                  ...get().promptQueues,
                  [session.id]: q.filter((item) => item.id !== entry.id),
                },
                sessionComposers: restored,
                queueNotice: {
                  id: uid(),
                  message: COMPUTER_USE_OPT_IN_REFUSE_MESSAGE,
                  state: "blocked",
                  at: Date.now(),
                },
              });
              return;
            }
          }
          // Mark before wire write so idle-drain cannot dual-send this id.
          // UI: "发送中" so the operator does not think it is still waiting.
          submittedEnqueueIds.add(entry.id);
          patchQueueEntryState(session.id, entry.id, "sending");
          try {
            await bridge.enqueuePrompt(
              session.id,
              trimmed,
              {
                model: composer.model,
                effort: composer.effort,
                mode: composer.mode,
                attachments,
              },
              { promptId: entry.id },
            );
            // Write accepted — CLI owns execution. Remember id+text so
            // queue/changed cannot resurrect a ghost (CLI often re-ids).
            submittedEnqueueIds.delete(entry.id);
            markConsumedConcurrent(session.id, entry.id, trimmed);
            dropQueueRows(session.id, { id: entry.id, text: trimmed });
          } catch {
            // CLI rejected write — keep local ownership for idle drain.
            submittedEnqueueIds.delete(entry.id);
            patchQueueEntryState(session.id, entry.id, "queued");
          }
        })();
        return true;
      }

      const titleText = trimmed || attachments.map((attachment) => attachment.name).join(", ");
      const nextIndex = get().sessionIndex.map((m) =>
        m.id === session.id && m.title === "Untitled mission"
          ? { ...m, title: titleText.slice(0, 56) }
          : m,
      );
      persistSessionCatalog(nextIndex);

      // Operator is actively continuing — allow queue drain after this turn ends,
      // and reset concurrent-consumed fingerprints for a fresh primary turn.
      suppressNextIdleDrain.delete(session.id);
      clearConsumedConcurrent(session.id);

      // Claim the in-flight slot before any await/set so double-click cannot dual-paint.
      // If a prior flight was left after status→idle, release it so Ready can send.
      if (promptInFlightSessions.has(session.id)) {
        releasePromptFlight(session.id);
      }
      const flightGen = beginPromptFlight(session.id);
      const userBlockId = uid();

      const nextComposers = {
        ...sessionComposers,
        [session.id]: { ...composer, text: "", attachments: [] },
      };
      persistSessionComposers(nextComposers);
      // Paint the user bubble immediately, but keep status as-is until bind/prompt
      // actually starts streaming — avoids a long fake "0 条事件" during silent bind.
      const needsBind = !bridge.isSessionBound?.(session.id);
      set({
        sessions: {
          ...sessions,
          [session.id]: {
            ...session,
            title: session.title === "Untitled mission" ? titleText.slice(0, 56) : session.title,
            // Bound sessions go running now; unbound show running only after bind (below).
            status: needsBind ? session.status : "running",
            blocks: [
              ...session.blocks,
              {
                type: "user",
                id: userBlockId,
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
      // Live bubble is authoritative — never keep the same text in 队列.
      pruneQueueGhosts(session.id);

      bridge.setPermissionMode(composer.permissionMode, session.id);
      // Bind agent only when the user actually continues the chat (first send).
      // Opening/switching never does session/load — that was the freeze source.
      void (async () => {
        const clearAgentBannerIfOurs = () => {
          const s = get();
          if (s.fullHistoryLoadingId === session.id && s.historyLoadMode === "agent") {
            set({
              fullHistoryLoadingId: null,
              historyLoadMode: null,
              agentBindStartedAt: null,
              queueNotice: null,
            });
          }
        };
        const markRunning = () => {
          const cur = get().sessions[session.id];
          if (!cur || cur.status === "running") return;
          set({
            sessions: {
              ...get().sessions,
              [session.id]: { ...cur, status: "running" },
            },
          });
        };
        try {
          if (needsBind) {
            set({
              fullHistoryLoadingId: session.id,
              historyLoadMode: "agent",
              agentBindStartedAt: Date.now(),
              queueNotice: {
                id: uid(),
                message:
                  "首次发送：正在静默绑定 Agent 上下文（不回放历史到界面，界面应可操作）…",
                state: "blocked",
                at: Date.now(),
              },
            });
            // silent: drop ACP stream replay — UI already has offline history.
            // Without silent, session/load floods the shell and freezes on send.
            await bridge.loadSession(session.id, { background: true, silent: true });
            // Only clear if this session still owns the agent banner (not B's disk scan).
            clearAgentBannerIfOurs();
          }
          // Stop during silent bind: do NOT start session/prompt (zombie turn).
          if (isPromptFlightCancelled(session.id, flightGen)) {
            clearAgentBannerIfOurs();
            return;
          }
          if (offlineHistoryDeleted.has(session.id) || !get().sessions[session.id]) {
            return;
          }
          // Bind done (or already bound) — now show working chrome before wire write.
          markRunning();
          // Always prompt the mission that initiated the send — switching the UI
          // mid-bind must not orphan the already-painted user message.
          await bridge.prompt(session.id, trimmed, {
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
            attachments,
          });
        } catch (error) {
          // Cancelled / superseded mid-bind — do not restore draft over a Stop.
          if (isPromptFlightCancelled(session.id, flightGen)) {
            clearAgentBannerIfOurs();
            return;
          }
          const s = get();
          // Never resurrect a deleted mission from a late prompt failure.
          if (offlineHistoryDeleted.has(session.id) || !s.sessions[session.id]) {
            return;
          }
          const clearAgent =
            s.fullHistoryLoadingId === session.id && s.historyLoadMode === "agent";
          const curSession = get().sessions[session.id];
          let blocks = curSession?.blocks ?? [];
          // Pop the optimistic user bubble we painted so retry does not duplicate it.
          const last = blocks[blocks.length - 1];
          if (last?.type === "user" && last.text === trimmed) {
            blocks = blocks.slice(0, -1);
          }
          // Restore composer draft — bind/prompt failure must not wipe operator text.
          const restoredComposers = {
            ...get().sessionComposers,
            [session.id]: {
              ...(get().sessionComposers[session.id] ?? composer),
              text: trimmed,
              attachments: [...attachments],
              model: composer.model,
              effort: composer.effort,
              mode: composer.mode,
              permissionMode: composer.permissionMode,
            },
          };
          persistSessionComposers(restoredComposers);
          const errText = error instanceof Error ? error.message : String(error);
          const friendly =
            /请求超时|session\/load|超时/.test(errText)
              ? `${errText}（首次绑定大会话可能较久；草稿已恢复，可重试）`
              : errText;
          set({
            ...(clearAgent
              ? {
                  fullHistoryLoadingId: null,
                  historyLoadMode: null,
                  agentBindStartedAt: null,
                }
              : {}),
            queueNotice: {
              id: uid(),
              message: friendly,
              state: "blocked",
              at: Date.now(),
            },
            sessionComposers: restoredComposers,
            sessions: {
              ...get().sessions,
              [session.id]: {
                ...get().sessions[session.id],
                status: "idle",
                blocks,
              },
            },
          });
        } finally {
          const cancelled = isPromptFlightCancelled(session.id, flightGen);
          endPromptFlight(session.id, flightGen);
          flushPendingOfflineMerge(session.id);
          // Cancelled flights must not auto-drain (Stop suppress + zombie finally).
          if (!cancelled) {
            window.setTimeout(() => drainPromptQueue(session.id), 0);
          }
        }
      })();
      return true;
    },

    async interjectPrompt(text, attachments = [], sessionId) {
      const { activeId, sessions, model, effort, mode, permissionMode, sessionComposers } = get();
      const targetId = sessionId ?? activeId;
      const session = targetId ? sessions[targetId] : null;
      if (!session) return false;

      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return false;

      if (session.status === "idle") {
        get().sendPrompt(trimmed, attachments, session.id);
        return true;
      }

      if (session.status === "awaiting_permission" || session.status === "awaiting_input") {
        // Gate: park as local queue (sendPrompt accepts and clears sessionComposers).
        // Propagate the boolean so callers clear the composer draft on accept.
        return get().sendPrompt(trimmed, attachments, session.id);
      }

      // Dedup before wire: same text already queued / live / concurrent-consumed
      // must not double-send via interject + enqueue.
      const norm = normalizeQueueText(trimmed);
      const existingQueue = get().promptQueues[session.id] ?? [];
      if (queueHasSameText(existingQueue, trimmed)) {
        dropQueueRows(session.id, { text: trimmed });
      }
      if (
        norm &&
        activeTurnUserTexts(session.id).some((t) => normalizeQueueText(t) === norm)
      ) {
        set({
          queueNotice: {
            id: uid(),
            message: "该消息已在当前回合执行中",
            state: "duplicate",
            at: Date.now(),
          },
        });
        return false;
      }
      if (norm && consumedSets(session.id).texts?.has(norm)) {
        set({
          queueNotice: {
            id: uid(),
            message: "该消息已提交到当前回合（并发处理中）",
            state: "duplicate",
            at: Date.now(),
          },
        });
        return false;
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

        // Computer Use opt-in refuse: show notice, keep composer text, no queue.
        // Do not persist empty composer (would wipe draft on reload).
        if (result.state === "refused") {
          set({
            queueNotice: {
              id: uid(),
              message: result.message,
              state: "interjected",
              at: Date.now(),
            },
          });
          return false;
        }

        if (result.fallback || result.state === "queued_head") {
          // Older CLI: no mid-turn RPC — pin head + concurrent session/prompt sendNow.
          pinInterjectQueueHead(
            session.id,
            {
              id: result.entryId ?? uid(),
              text: trimmed,
              attachments: [...attachments],
              createdAt: Date.now(),
              state: "interjected",
              source: "local",
            },
            result.message,
            composer,
            {
              model: composer.model,
              effort: composer.effort,
              mode: composer.mode,
            },
            attachments,
            trimmed,
          );
          return true;
        }

        // True mid-turn interject accepted — clear draft; user bubble already emitted by bridge.
        // Drop any queue row with the same text (queued then interjected) and re-prune CLI ghosts.
        const nextComposers = {
          ...sessionComposers,
          [session.id]: { ...composer, text: "", attachments: [] },
        };
        persistSessionComposers(nextComposers);
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
        dropQueueRows(session.id, { text: trimmed });
        window.setTimeout(() => pruneQueueGhosts(session.id), 0);
        return true;
      } catch (error) {
        // Hard failure — pin head + try CLI sendNow so text is never lost mid-turn.
        pinInterjectQueueHead(
          session.id,
          {
            id: uid(),
            text: trimmed,
            attachments: [...attachments],
            createdAt: Date.now(),
            state: "interjected",
            source: "local",
          },
          `插话失败，已降级为队首：${error instanceof Error ? error.message : String(error)}`,
          get().sessionComposers[session.id] ?? composer,
          {
            model: composer.model,
            effort: composer.effort,
            mode: composer.mode,
          },
          attachments,
          trimmed,
        );
        return true;
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
      // Drag makes array order authoritative — demote interject flags so drain
      // does not surprise the operator by skipping a row they placed first.
      const normalized = next.map((entry) =>
        entry.state === "interjected" ? { ...entry, state: "queued" as const } : entry,
      );
      set({
        promptQueues: {
          ...get().promptQueues,
          [sessionId]: normalized,
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
        normalized.map((entry) => entry.id),
      );
    },

    clearPromptQueue(sessionId) {
      const id = sessionId ?? get().activeId;
      if (!id) return;
      const had = (get().promptQueues[id] ?? []).length > 0;
      // Clearing queue also drops any stop-suppress so a later idle is clean.
      suppressNextIdleDrain.delete(id);
      for (const entry of get().promptQueues[id] ?? []) {
        submittedEnqueueIds.delete(entry.id);
      }
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
      if (!activeId) return;
      // Cancel invalidates any concurrent enqueue bookkeeping for this mission.
      for (const entry of get().promptQueues[activeId] ?? []) {
        submittedEnqueueIds.delete(entry.id);
      }
      releasePromptFlight(activeId);
      // Park queue: cancel→idle must not immediately drain the next follow-up.
      suppressNextIdleDrain.add(activeId);
      bridge.cancel(activeId);
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
      await bridge.loadSession(activeId, { background: true, silent: true });
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

    resolvePermission(blockId, option, feedback) {
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
      const result = bridge.respondPermission(activeId, blockId, option, feedback);
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
      const isPlan =
        block?.type === "permission" &&
        (block.req.purpose === "plan" || blockId.startsWith("plan-approval-"));
      // Close the plan pane on approve, or on deny without revision notes.
      if (isPlan && (option !== "deny" || !feedback?.trim())) {
        set({ planPreviewOpen: false });
      }
      if (blockId.startsWith("plan-approval-") || isPlan) {
        set({
          queueNotice: {
            id: uid(),
            message:
              option === "deny"
                ? feedback?.trim()
                  ? "已发送计划修改要求，原回合将继续规划"
                  : "计划已拒绝，原回合将继续规划"
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
      // Product preference is global: update default + every session composer so
      // Settings/Home do not fight stale per-session modes, and background turns
      // do not keep a previous Bypass after the operator switches to Default.
      const { sessionComposers, sessions, model, effort, mode } = get();
      localStorage.setItem("grok.permissionMode", permissionMode);
      bridge.setPermissionMode(permissionMode);
      const next = { ...sessionComposers };
      const ids = new Set([...Object.keys(sessions), ...Object.keys(sessionComposers)]);
      for (const id of ids) {
        const current = next[id] ?? {
          text: "",
          attachments: [],
          model,
          effort,
          mode,
          permissionMode,
        };
        next[id] = { ...current, permissionMode };
        bridge.setPermissionMode(permissionMode, id);
      }
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
    toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
    setPlanPreviewOpen: (planPreviewOpen) =>
      set({ planPreviewOpen, ...(planPreviewOpen ? { previewOpen: false } : {}) }),
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
