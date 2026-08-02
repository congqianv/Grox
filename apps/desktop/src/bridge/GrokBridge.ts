/* ─────────────────────────────────────────────────────────────────────────
   GrokBridge — the seam between the shell and the agent runtime.

   Two implementations:
   • MockBridge — scripted, offline, drives every UI state for design/demo.
   • AcpBridge  — binds to `grok agent stdio` (JSON-RPC / ACP) via Tauri.

   The store only ever talks to this interface. Swapping bridges is a
   one-line change in bridge/index.ts.
   ───────────────────────────────────────────────────────────────────────── */

import type {
  AccountInfo,
  AuthState,
  BillingInfo,
  BridgeEvent,
  AgentMode,
  ConfigDocument,
  PermissionOption,
  PermissionMode,
  PromptOptions,
  QuestionResponse,
  ModelState,
  SessionMeta,
  ProviderConfig,
  ProviderProfileSummary,
  ProviderProfilesState,
  ProviderStatus,
  SaveProviderProfile,
  RewindMode,
  RewindPoint,
  RewindResult,
  InterjectResult,
  QueueOperationReceipt,
} from "./types";

export interface GrokBridge {
  readonly kind: "mock" | "acp";

  /** Subscribe to agent events. Returns an unsubscribe fn. */
  subscribe(cb: (e: BridgeEvent) => void): () => void;

  /** Session catalogue (recent first). */
  listSessions(cwd?: string): Promise<SessionMeta[]>;

  /** Active workspace used by new sessions and the catalogue. */
  getWorkspace(): Promise<string>;
  setWorkspace(cwd: string): Promise<void>;

  /** Authentication state and interactive browser login. */
  getAuthState(): Promise<AuthState>;
  authenticate(): Promise<void>;
  logout(): Promise<void>;
  getAccountInfo(): Promise<AccountInfo>;
  getBillingInfo(): Promise<BillingInfo>;
  getProviderStatus(): Promise<ProviderStatus>;
  configureProvider(config: ProviderConfig): Promise<void>;
  listProviderProfiles(): Promise<ProviderProfilesState>;
  saveProviderProfile(config: SaveProviderProfile): Promise<ProviderProfileSummary>;
  refreshProviderModels(id: string): Promise<ProviderProfileSummary>;
  activateProviderProfile(id: string): Promise<void>;
  deleteProviderProfile(id: string): Promise<void>;

  /** Local Grok configuration documents kept in two-way sync by the shell. */
  readConfigDocuments(cwd: string): Promise<ConfigDocument[]>;
  writeConfigDocument(document: ConfigDocument): Promise<ConfigDocument>;

  /** Typed access to Grok Build x.ai extensions used by visual settings. */
  callExtension<T>(method: string, params?: unknown): Promise<T>;

  /** Models currently offered by the connected agent. */
  getModelState(): Promise<ModelState>;

  /** Change permission policy for existing and future sessions. */
  setPermissionMode(mode: PermissionMode): void;

  /** Change the real Grok Build harness mode for an existing session. */
  setSessionMode(sessionId: string, mode: AgentMode): Promise<void>;

  /** ACP: session/new — emits session_ready. */
  newSession(cwd: string): Promise<void>;

  /**
   * ACP: session/load — binds the session in the agent process.
   * - `background: true` keeps current UI (disk history) until load finishes.
   * - `silent: true` (with background) only binds agent context: drops stream
   *   replay for UI. Required for first-send on huge sessions without freeze.
   */
  loadSession(id: string, options?: { background?: boolean; silent?: boolean }): Promise<void>;

  /**
   * Seed the ACP session catalogue so the next loadSession can skip a full
   * session-list round-trip. Optional on mock bridges.
   */
  rememberSessionMeta?(meta: SessionMeta): void;

  /** True once ACP session/load (or new) has bound this id in the agent process. */
  isSessionBound?(id: string): boolean;

  /**
   * Visit memory + priority queue:
   * - Active mission first; then other visited unbound missions (oldest first).
   * - Switch to C abandons not-yet-started secondary loads (e.g. A).
   * - In-flight ACP load cannot be cancelled mid-flight.
   */
  enqueueBackgroundLoad?(id: string): void;

  /** So the load queue can prefer the live active mission. */
  setActiveSessionGetter?(getter: () => string | null): void;

  /** ACP: session/prompt — streams events until the turn settles. */
  prompt(sessionId: string, text: string, opts: PromptOptions): Promise<void>;

  /**
   * Same-turn interjection via `x.ai/interject`.
   * Older CLIs may not support it — returns `queued_head` so the shell can
   * pin the message at the front of the local follow-up queue instead.
   */
  interject(sessionId: string, text: string, opts: PromptOptions): Promise<InterjectResult>;

  /**
   * Enqueue a follow-up while a turn is active.
   * Tries concurrent `session/prompt` with `_meta.promptId` (CLI queue).
   * Falls back to local-only ownership when the CLI rejects concurrency.
   */
  enqueuePrompt(
    sessionId: string,
    text: string,
    opts: PromptOptions,
    options?: { promptId?: string; sendNow?: boolean },
  ): Promise<QueueOperationReceipt>;

  /** Best-effort CLI queue mutations (`x.ai/queue/*`); always apply locally too. */
  editQueuedPrompt(sessionId: string, id: string, text: string): Promise<QueueOperationReceipt>;
  removeQueuedPrompt(sessionId: string, id: string, version?: number): Promise<QueueOperationReceipt>;
  reorderQueuedPrompt(sessionId: string, orderedIds: string[]): Promise<QueueOperationReceipt>;
  clearQueuedPrompts(sessionId: string): Promise<QueueOperationReceipt>;
  interjectQueuedPrompt(
    sessionId: string,
    id: string,
    options?: { text?: string; version?: number },
  ): Promise<QueueOperationReceipt>;

  /** ACP: session/cancel — abort the in-flight turn. */
  cancel(sessionId: string): void;

  /** Compact the active conversation context. */
  compact(sessionId: string): Promise<void>;

  /** Official Grok Build rewind checkpoints and execution. */
  listRewindPoints(sessionId: string): Promise<RewindPoint[]>;
  rewind(sessionId: string, targetPromptIndex: number, mode: RewindMode, force: boolean): Promise<RewindResult>;

  /**
   * Resolve a pending permission / plan card.
   * Plan decisions are idempotent: a second click for the same requestId
   * returns without re-answering the ACP server request.
   */
  respondPermission(
    sessionId: string,
    blockId: string,
    option: PermissionOption,
    feedback?: string,
  ): { duplicate: boolean; message?: string };

  /** Resolve a structured x.ai/ask_user_question interaction. */
  respondQuestion(sessionId: string, blockId: string, response: QuestionResponse): void;

  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;

  /** Ctrl+Alt+Esc emergency stop for Windows Computer Use harness. */
  emergencyStopComputer?(sessionId: string): Promise<void>;
}
