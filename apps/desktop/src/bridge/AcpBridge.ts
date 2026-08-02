/* Real Grok Build bridge over ACP / newline-delimited JSON-RPC 2.0. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GrokBridge } from "./GrokBridge";
import {
  MODELS,
  readStoredPermissionMode,
  type AccountInfo,
  type AgentMode,
  type AuthState,
  type BillingInfo,
  type BridgeEvent,
  type DiffHunk,
  type PermissionOption,
  type PermissionMode,
  type PlanStep,
  type PromptOptions,
  type QuestionItem,
  type QuestionResponse,
  type ModelState,
  type Session,
  type SessionBlock,
  type SessionMeta,
  type TerminalIO,
  type ToolCall,
  type ToolKind,
  type ToolStatus,
  type Usage,
  type ConfigDocument,
  type ProviderConfig,
  type ProviderProfileSummary,
  type ProviderProfilesState,
  type ProviderStatus,
  type PromptAttachment,
  type SaveProviderProfile,
  type RewindMode,
  type RewindPoint,
  type RewindResult,
  type InterjectResult,
  type QueueOperationReceipt,
  type PromptQueueEntry,
} from "./types";
import { isAllowedOAuthUrl } from "../lib/oauthUrl";
import {
  COMPUTER_USE_OPT_IN_REFUSE_MESSAGE,
  computerLeaseIfAttached,
  computerToolNameFromPermissionTool,
  decideComputerAttachForPrompt,
  hasActiveComputerLease,
  isComputerUseMcpTool,
  isComputerUseOperatorEnabled,
  setComputerUseHostEnvEnabled,
} from "../lib/computerUse";
import { shouldDropSilentInbound } from "../lib/silentAcp";

export const ACP_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  requestPermission: "session/request_permission",
  sessionList: "x.ai/session/list",
  sessionInfo: "x.ai/session/info",
  sessionRename: "x.ai/session/rename",
  sessionDelete: "x.ai/session/delete",
  fsList: "x.ai/fs/list",
  fsRead: "x.ai/fs/read_file",
  gitStatus: "x.ai/git/status",
  gitDiffs: "x.ai/git/diffs",
  sessionFork: "x.ai/session/fork",
  compact: "x.ai/compact_conversation",
  promptHistory: "x.ai/prompt_history",
} as const;

type JsonObject = Record<string, unknown>;
type RpcId = string | number;

interface JsonRpcMessage extends JsonObject {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface DesktopEnvironment {
  defaultWorkspace: string;
  grokCommand: string;
}

interface ExitPayload {
  code?: number | null;
  reason: "exited" | "killed";
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
  timeoutId?: number;
}

interface ContentCursor {
  assistantId?: string;
  thinkingId?: string;
  thinkingStartedAt?: number;
  /** Last assistant bubble this turn — reused on stream retry (single-bubble replace). */
  lastAssistantId?: string;
  /** Last thinking bubble this turn — reused on stream retry. */
  lastThinkingId?: string;
  userId?: string;
  userText?: string;
  userPromptIndex?: number;
  userOpen?: boolean;
  planId?: string;
  toolBlocks: Map<string, string>;
  /** Agent-reported + client-observed retry count for the active turn. */
  retryCount?: number;
  /** Cumulative assistant chars rendered this turn (for retry limiting). */
  visibleAssistantChars?: number;
  /**
   * After retry_state, the next agent_message/thought chunk must replace the
   * existing draft bubble instead of opening a second one.
   */
  expectReplace?: boolean;
  /** Stop applying stream chunks after client aborts further retries. */
  streamSuppressed?: boolean;
}

interface PendingInteraction {
  rpcId: RpcId;
  sessionId: string;
  blockId: string;
  kind: "permission" | "plan" | "question";
  optionIds: Partial<Record<PermissionOption, string>>;
  questions?: QuestionItem[];
}

class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

const uid = () => crypto.randomUUID();

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  contextUsed: 0,
  contextMax: 0,
  turns: 0,
};

const STREAM_FLUSH_MS = 32;
const TOOL_FLUSH_MS = 60;
const MAX_TOOL_TEXT = 128 * 1024;
const MAX_JSON_NODES = 5_000;
const MAX_JSON_ARRAY_ITEMS = 200;
const MAX_TERMINAL_LINES = 2_000;
/** Assistant text length that counts as "visible body" for retry limiting. */
const VISIBLE_ASSISTANT_BODY_CHARS = 80;
/**
 * Once a visible assistant body is already on screen, only clear+replace for
 * this many additional retries. Further retries keep the body and cancel.
 */
const MAX_RETRIES_WITH_VISIBLE_BODY = 1;

function truncateText(value: string, limit = MAX_TOOL_TEXT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [Grox 已截断过长输出，共 ${value.length.toLocaleString()} 字符]`;
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorText(value: unknown): string {
  const object = record(value);
  return (
    string(object?.message) ??
    string(object?.data) ??
    (value instanceof Error ? value.message : String(value))
  );
}

/** True when the agent/CLI does not expose the requested method. */
function isMethodUnavailable(error: unknown): boolean {
  if (error instanceof AcpRpcError) {
    if (error.code === -32601) return true;
    const msg = error.message.toLowerCase();
    return (
      msg.includes("method not found") ||
      msg.includes("not supported") ||
      msg.includes("unknown method") ||
      msg.includes("unsupported")
    );
  }
  const msg = errorText(error).toLowerCase();
  return (
    msg.includes("method not found") ||
    msg.includes("not supported") ||
    msg.includes("unknown method") ||
    msg.includes("-32601")
  );
}

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return truncateText(value);
  let visited = 0;
  try {
    return truncateText(JSON.stringify(value, (_key, child: unknown) => {
      visited += 1;
      if (visited > MAX_JSON_NODES) return "[Grox: object truncated]";
      if (typeof child === "string") return truncateText(child, 16 * 1024);
      if (Array.isArray(child) && child.length > MAX_JSON_ARRAY_ITEMS) {
        return [...child.slice(0, MAX_JSON_ARRAY_ITEMS), `[Grox: ${child.length - MAX_JSON_ARRAY_ITEMS} more items]`];
      }
      return child;
    }, 2));
  } catch {
    return truncateText(String(value));
  }
}

function contentText(value: unknown): string {
  let output = "";
  let truncated = false;
  const append = (part: unknown, depth: number) => {
    if (output.length >= MAX_TOOL_TEXT || depth > 16) {
      truncated = true;
      return;
    }
    if (typeof part === "string") {
      const remaining = MAX_TOOL_TEXT - output.length;
      output += part.slice(0, remaining);
      if (part.length > remaining) truncated = true;
      return;
    }
    if (Array.isArray(part)) {
      for (const child of part) {
        append(child, depth + 1);
        if (truncated) break;
      }
      return;
    }
    const object = record(part);
    if (!object) return;
    if (typeof object.text === "string") append(object.text, depth + 1);
    else if (object.content !== undefined) append(object.content, depth + 1);
  };
  append(value, 0);
  return truncated ? `${output}\n… [Grox 已截断过长内容]` : output;
}

function attachmentUri(attachment: PromptAttachment): string {
  if (attachment.kind === "path" && attachment.path) {
    const path = attachment.path.replace(/\\/g, "/");
    // Absolute paths keep a real file:// URI; relative stay project-relative.
    if (/^[a-zA-Z]:\//.test(path) || path.startsWith("/")) {
      return `file://${encodeURI(path).replace(/#/g, "%23")}`;
    }
    return path;
  }
  const safeName = attachment.name.replace(/[\\/#?]/g, "_") || "attachment";
  return `file://${safeName}`;
}

function promptContent(text: string, attachments: PromptAttachment[]): JsonObject[] {
  // Path chips become @mentions in the text so the agent expands file contents.
  const pathMentions = attachments
    .filter((item) => item.kind === "path" && item.path)
    .map((item) => `@${item.path}`);
  let message = text;
  if (pathMentions.length > 0) {
    const missing = pathMentions.filter((mention) => !message.includes(mention));
    if (missing.length > 0) {
      message = message.trim()
        ? `${message.trim()}\n\n${missing.join(" ")}`
        : missing.join(" ");
    }
  }

  const blocks: JsonObject[] = [{ type: "text", text: message }];
  for (const attachment of attachments) {
    // Path chips are already folded into @mentions in `message` above;
    // the agent expands those via collect_file_references — no extra block.
    if (attachment.kind === "path") continue;
    if (attachment.kind === "image" && attachment.data) {
      blocks.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mime,
        uri: attachmentUri(attachment),
      });
      continue;
    }
    if (attachment.kind === "text" && attachment.text !== undefined) {
      blocks.push({
        type: "resource",
        resource: {
          uri: attachmentUri(attachment),
          mimeType: attachment.mime,
          text: attachment.text,
        },
      });
      continue;
    }
    if (attachment.kind === "binary" && attachment.data) {
      blocks.push({
        type: "resource",
        resource: {
          uri: attachmentUri(attachment),
          mimeType: attachment.mime,
          blob: attachment.data,
        },
      });
    }
  }
  return blocks;
}

function wireMethod(method: string): string {
  return method.startsWith("x.ai/") ? `_${method}` : method;
}

function normalizePromptQueue(value: unknown, previous: PromptQueueEntry[] = []): PromptQueueEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const row = record(entry) ?? {};
      const id =
        string(row.id) ??
        string(row.promptId) ??
        string(row.prompt_id) ??
        `queue-${index}`;
      const prior = previous.find((item) => item.id === id);
      const stateRaw = string(row.state);
      const state: PromptQueueEntry["state"] =
        row.sendNow === true || stateRaw === "interjected"
          ? "interjected"
          : stateRaw === "sending"
            ? "sending"
            : "queued";
      const created =
        string(row.createdAt) ?? string(row.created_at) ?? undefined;
      return {
        id,
        text: string(row.text) ?? string(row.prompt) ?? string(row.content) ?? prior?.text ?? "",
        state,
        position: number(row.position) ?? index,
        createdAt: created ? Date.parse(created) || prior?.createdAt || Date.now() : prior?.createdAt ?? Date.now(),
        version: number(row.version) ?? prior?.version ?? 0,
        source: "cli" as const,
        attachments: prior?.attachments,
      } satisfies PromptQueueEntry;
    })
    .sort((a, b) => a.position - b.position);
}

function normalizeInboundExtension(message: JsonRpcMessage): JsonRpcMessage {
  if (!message.method?.startsWith("_x.ai/")) return message;
  const envelope = record(message.params);
  const nestedMethod = string(envelope?.method);
  if (nestedMethod?.startsWith("x.ai/") && envelope && "params" in envelope) {
    return { ...message, method: nestedMethod, params: envelope.params };
  }
  return { ...message, method: message.method.slice(1) };
}

function byteText(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.every((entry) => Number.isInteger(entry))) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(value as number[]));
  } catch {
    return undefined;
  }
}

function extractTerminal(
  kind: ToolKind,
  title: unknown,
  rawInput: unknown,
  rawOutput: unknown,
  content: unknown,
): TerminalIO | undefined {
  const input = record(rawInput);
  const output = record(rawOutput);
  const outputType = string(output?.type)?.toLowerCase();
  if (kind !== "terminal" && kind !== "execute" && outputType !== "bash" && outputType !== "shell") return undefined;

  const command =
    string(output?.command) ??
    string(input?.command) ??
    string(input?.cmd) ??
    string(title) ??
    "command";
  const text =
    string(output?.output_for_prompt) ??
    string(output?.outputForPrompt) ??
    byteText(output?.output) ??
    contentText(content);
  const exitCode = number(output?.exit_code) ?? number(output?.exitCode);
  let lines = text ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];
  if (lines.length > MAX_TERMINAL_LINES) {
    const omitted = lines.length - MAX_TERMINAL_LINES;
    lines = [
      ...lines.slice(0, 1_400),
      `… [Grox 已省略 ${omitted.toLocaleString()} 行终端输出]`,
      ...lines.slice(-600),
    ];
  }
  return {
    cmd: command,
    lines,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function parseTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function emptySession(meta: SessionMeta): Session {
  return { ...meta, blocks: [], usage: { ...EMPTY_USAGE }, status: "idle" };
}

const TOOL_KINDS = new Set<ToolKind>([
  "read", "edit", "delete", "list_dir", "write", "move", "search", "lsp", "execute",
  "plan", "web_search", "web_fetch", "background_task_action", "wait_tasks_action",
  "kill_task_action", "list", "skill", "memory_search", "memory_get", "task", "enter_plan",
  "exit_plan", "ask_user", "image_gen", "video_gen", "image_to_video", "reference_to_video",
  "computer", "deploy_app", "search_tool", "use_tool", "monitor", "goal_update", "terminal", "web",
  "think", "switch_mode", "other",
]);

function mapToolKind(kindValue: unknown, titleValue: unknown): ToolKind {
  const exact = (string(kindValue) ?? "").toLowerCase();
  if (TOOL_KINDS.has(exact as ToolKind)) return exact as ToolKind;
  if (exact === "fetch") return "web_fetch";
  const source = `${exact} ${string(titleValue) ?? ""}`.toLowerCase();
  if (/\b(read|view|cat)\b/.test(source)) return "read";
  if (/\b(delete|remove|unlink)\b/.test(source)) return "delete";
  if (/\b(move|rename)\b/.test(source)) return "move";
  if (/\b(edit|write|patch|replace)\b/.test(source)) return "edit";
  if (/\b(execute|terminal|shell|bash|command|process)\b/.test(source)) return "execute";
  if (/\b(web|fetch|browser|url)\b/.test(source)) return "web_fetch";
  if (/\b(search|grep|find|glob)\b/.test(source)) return "search";
  if (
    /\bcomputer_(screenshot|mouse|click|drag|scroll|key|type|wait)\b/.test(source) ||
    (/\bcomputer\b/.test(source) &&
      /\b(desktop|window|screen|mouse|keyboard|uiautomation)\b/.test(source))
  ) {
    return "computer";
  }
  if (/\b(task|agent|todo|plan)\b/.test(source)) return "task";
  if (/\b(think|reason)\b/.test(source)) return "think";
  return "other";
}

interface ComputerSessionExtensions {
  mcpServers: unknown[];
  pluginDirs: string[];
  leaseId: string;
}

function mapToolStatus(value: unknown): ToolStatus {
  switch ((string(value) ?? "").toLowerCase()) {
    case "pending":
      return "pending";
    case "in_progress":
    case "running":
      return "running";
    case "awaiting_permission":
    case "awaiting_approval":
      return "awaiting_permission";
    case "completed":
    case "done":
    case "success":
      return "done";
    case "failed":
    case "error":
      return "error";
    case "cancelled":
    case "canceled":
    case "rejected":
      return "cancelled";
    default:
      return "running";
  }
}

function diffHunk(path: string, oldText: string, newText: string): DiffHunk {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const before = oldLines.slice(Math.max(0, prefix - 3), prefix);
  const after = suffix > 0 ? oldLines.slice(oldLines.length - Math.min(3, suffix)) : [];
  return {
    path,
    lines: [
      ...before.map((text) => ({ kind: "ctx" as const, text })),
      ...removed.map((text) => ({ kind: "del" as const, text })),
      ...added.map((text) => ({ kind: "add" as const, text })),
      ...after.map((text) => ({ kind: "ctx" as const, text })),
    ],
    added: added.length,
    removed: removed.length,
  };
}

function extractDiffs(value: unknown): DiffHunk[] | undefined {
  const diffs: DiffHunk[] = [];
  const seen = new Set<string>();
  walkJson(value, (object) => {
    const oldText = string(object.oldText) ?? string(object.old_text);
    const newText = string(object.newText) ?? string(object.new_text);
    if (string(object.type) !== "diff" && oldText === undefined && newText === undefined) return;
    const path = string(object.path) ?? string(object.filePath) ?? string(object.file_path) ?? "unknown";
    const signature = `${path}\0${oldText ?? ""}\0${newText ?? ""}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    diffs.push(diffHunk(path, oldText ?? "", newText ?? ""));
  });
  return diffs.length > 0 ? diffs : undefined;
}

function extractImages(value: unknown): ToolCall["images"] {
  const images: NonNullable<ToolCall["images"]> = [];
  const seen = new Set<string>();
  walkJson(value, (object) => {
    if (string(object.type) !== "image") return;
    const data = string(object.data);
    const mime = string(object.mimeType) ?? string(object.mime_type);
    const signature = data && mime ? `${mime}:${data.slice(0, 96)}:${data.length}` : undefined;
    if (data && mime && signature && !seen.has(signature)) {
      seen.add(signature);
      images.push({ data, mime });
    }
  });
  return images.length > 0 ? images : undefined;
}

function walkJson(
  value: unknown,
  visit: (object: JsonObject) => void,
  depth = 0,
  budget = { remaining: MAX_JSON_NODES },
): void {
  if (depth > 8 || budget.remaining <= 0) return;
  budget.remaining -= 1;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, MAX_JSON_ARRAY_ITEMS)) {
      walkJson(child, visit, depth + 1, budget);
      if (budget.remaining <= 0) break;
    }
    return;
  }
  const object = record(value);
  if (!object) return;
  visit(object);
  for (const child of Object.values(object)) {
    walkJson(child, visit, depth + 1, budget);
    if (budget.remaining <= 0) break;
  }
}

function extractLocations(...values: unknown[]): string[] | undefined {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    const path = string(value)?.replace(/^file:\/\//, "").trim();
    if (!path || path.length > 500 || /[\r\n]/.test(path) || /^(https?|data):/i.test(path)) return;
    paths.add(path);
  };
  for (const value of values) {
    walkJson(value, (object) => {
      for (const [key, child] of Object.entries(object)) {
        if (/^(path|file|file_?path|filepath|old_?path|new_?path|directory|cwd|uri)$/i.test(key)) add(child);
        if (/^(paths|files|locations)$/i.test(key)) {
          for (const item of array(child)) add(item);
        }
      }
    });
  }
  return paths.size > 0 ? [...paths].slice(0, 40) : undefined;
}

function toolOutputText(rawOutput: unknown, content: unknown): string | undefined {
  return jsonText(rawOutput) ?? (contentText(content).trim() || undefined);
}

function mapPlanSteps(value: unknown): PlanStep[] {
  return array(value).map((entry, index) => {
    const object = record(entry) ?? {};
    const rawStatus = string(object.status) ?? "pending";
    const status: PlanStep["status"] =
      rawStatus === "completed" || rawStatus === "done"
        ? "completed"
        : rawStatus === "in_progress" || rawStatus === "running"
          ? "in_progress"
          : "pending";
    return {
      id: string(object.id) ?? `plan-step-${index}`,
      content: string(object.content) ?? string(object.title) ?? `Step ${index + 1}`,
      status,
    };
  });
}

function applyToSession(session: Session, event: BridgeEvent): Session {
  if ("sessionId" in event && event.sessionId !== session.id) return session;
  const patchBlock = (blockId: string, patch: Partial<SessionBlock>) =>
    session.blocks.map((block) =>
      block.id === blockId ? ({ ...block, ...patch } as SessionBlock) : block,
    );

  switch (event.type) {
    case "auth_state":
    case "model_state":
    case "mode_state":
      return session;
    case "session_meta":
      return { ...session, ...event.patch };
    case "block_add":
      return { ...session, blocks: [...session.blocks, event.block] };
    case "block_patch":
      return { ...session, blocks: patchBlock(event.blockId, event.patch) };
    case "assistant_append":
    case "thinking_append":
      return {
        ...session,
        blocks: session.blocks.map((block) =>
          block.id === event.blockId &&
          (block.type === "assistant" || block.type === "thinking")
            ? { ...block, text: block.text + event.delta }
            : block,
        ),
      };
    case "tool_patch":
      return {
        ...session,
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "tool"
            ? { ...block, call: { ...block.call, ...event.call } }
            : block,
        ),
      };
    case "plan_patch":
      return {
        ...session,
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "plan"
            ? { ...block, steps: event.steps }
            : block,
        ),
      };
    case "permission_request":
      return {
        ...session,
        status: "awaiting_permission",
        blocks: [
          ...session.blocks,
          { type: "permission", id: event.blockId, req: event.req, ts: Date.now() },
        ],
      };
    case "permission_resolved":
      return {
        ...session,
        status: "running",
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "permission"
            ? { ...block, resolved: event.option }
            : block,
        ),
      };
    case "question_request":
      return {
        ...session,
        status: "awaiting_input",
        blocks: [
          ...session.blocks,
          { type: "question", id: event.blockId, req: event.req, ts: Date.now() },
        ],
      };
    case "question_resolved":
      return {
        ...session,
        status: "running",
        blocks: session.blocks.map((block) =>
          block.id === event.blockId && block.type === "question"
            ? { ...block, response: event.response }
            : block,
        ),
      };
    case "status":
      return { ...session, status: event.status };
    case "usage":
      return { ...session, usage: event.usage };
    case "error":
      return {
        ...session,
        status: "idle",
        blocks: [
          ...session.blocks,
          { type: "system", id: uid(), text: event.message, ts: Date.now(), kind: "error" },
        ],
      };
    case "prompt_queue":
      return {
        ...session,
        blocks: session.blocks.map((block) =>
          block.type === "system"
            ? { ...block, text: event.entries.map((e) => e.text).join("\n\n") }
            : block,
        ),
      };
    case "session_ready":
      return event.session;
  }
  // Default
  return session;
}

export class AcpBridge implements GrokBridge {
  readonly kind = "acp" as const;

  private listeners = new Set<(event: BridgeEvent) => void>();
  private pending = new Map<RpcId, PendingRequest>();
  private interactions = new Map<string, PendingInteraction>();
  /** Plan decisions keyed by `sessionId:rpcId` — first answer wins. */
  private resolvedPlanDecisions = new Map<string, PermissionOption>();
  /** Same decisions keyed by blockId for UI duplicate clicks after map delete. */
  private resolvedPlanByBlock = new Map<string, PermissionOption>();
  /** Last CLI-authoritative queue snapshot per session (from x.ai/queue/changed). */
  private cliQueues = new Map<string, PromptQueueEntry[]>();
  private cursors = new Map<string, ContentCursor>();
  private catalogue = new Map<string, SessionMeta>();
  private replaying = new Map<string, Session>();
  /**
   * Sessions currently being restored via `session/load`. While set, emit() keeps
   * a private replay buffer AND periodically flushes it to the UI so the shell
   * is not stuck on the full-screen "Restoring session…" spinner for long
   * transcripts (especially under agent --leader).
   */
  private progressiveLoad = new Set<string>();
  private progressiveFlushTimers = new Map<string, number>();
  /**
   * Silent agent-bind: session/load still runs in the CLI, but we discard stream
   * updates (UI already has offline disk history). Prevents first-send freeze.
   */
  private silentReplaying = new Set<string>();
  /** In-flight session/load promises — dedupe open + first-send races. */
  private loadPromises = new Map<string, Promise<void>>();
  /**
   * Exclusive ACP channel queue for heavy ops (session/load + session/prompt).
   * Prevents concurrent silent binds from globally black-holing another session's
   * live stream, and avoids stacking multi-minute rehydrates on one stdio child.
   */
  private channelTail: Promise<unknown> = Promise.resolve();
  /** Serialize restartAgent so double activate cannot spawn two children. */
  private restartTail: Promise<void> = Promise.resolve();
  /** True while we intentionally replace the agent (suppress stale exit noise). */
  private suppressExitHandling = false;
  private reconnectTimer: number | undefined;
  /** Resolve the in-flight reconnect delay when cancelled (provider switch etc.). */
  private reconnectDelayResolve: (() => void) | null = null;
  /** True while crash auto-reconnect owns `ready` (prompt/drain must wait). */
  private crashReconnectInFlight = false;
  /**
   * Bumped on intentional restart so an in-flight runCrashReconnect aborts
   * instead of racing ready or sticking crashReconnectInFlight.
   */
  private reconnectEpoch = 0;
  /** Child died again while crash-reconnect was still finishing success path. */
  private reconnectChildDied = false;
  /** When true, restartAgentInner must not steal `ready` from runCrashReconnect. */
  private restartFromCrashReconnect = false;
  /**
   * Scheme C + visit memory:
   * 1) Always prefer full-load of the active mission if unbound.
   * 2) After active is complete, full-load other *visited* unbound missions
   *    (oldest visit first — e.g. opened A then B → while on B load A).
   * 3) Switching to C: active C wins; abandon not-yet-started secondary (A).
   * 4) In-flight ACP load cannot be cancelled mid-flight.
   */
  private visitedOrder: string[] = [];
  private backgroundLoadRunning = false;
  private backgroundLoadInFlight: string | null = null;
  private activeSessionGetter: (() => string | null) | null = null;
  /** Avoid tight retry loops after a failed full-load until user re-opens. */
  private backgroundLoadFailed = new Set<string>();
  /** Short TTL cache for sessionMeta (system-prompt + permission flags) per cwd. */
  private sessionMetaCache = new Map<string, { expires: number; value: Record<string, unknown> }>();
  private usage = new Map<string, Usage>();
  private sessionOptions = new Map<string, PromptOptions>();
  private knownSessions = new Set<string>();
  private unlisten: UnlistenFn[] = [];
  private streamAppends = new Map<string, Extract<BridgeEvent, { type: "assistant_append" | "thinking_append" }>>();
  private streamFlushTimer: number | undefined;
  private toolPatches = new Map<string, Extract<BridgeEvent, { type: "tool_patch" }>>();
  private toolFlushTimer: number | undefined;
  private diagnostics: string[] = [];
  private requestId = 0;
  private authMethodId: string | undefined;
  private authState: AuthState = { required: false, inProgress: false };
  private modelState: ModelState = { models: MODELS, currentId: MODELS[0].id };
  private permissionMode: PermissionMode = readStoredPermissionMode();
  private workspace = "";
  private computerLeases = new Map<string, string>();
  private activeComputerSessions = new Set<string>();
  private activeComputerToolCalls = new Set<string>();
  private ready: Promise<void>;

  constructor() {
    this.ready = this.connect();
    void this.ready.then(() => {
      if (localStorage.getItem("grox.pendingOAuth") !== "1") return;
      localStorage.removeItem("grox.pendingOAuth");
      void this.authenticate().catch(() => {
        // authenticate() already publishes the actionable error through auth_state.
      });
    });
  }

  subscribe(callback: (event: BridgeEvent) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private setAuthState(patch: Partial<AuthState>) {
    this.authState = { ...this.authState, ...patch };
    this.emit({ type: "auth_state", state: { ...this.authState } });
  }

  private emit(event: BridgeEvent) {
    if ("sessionId" in event) {
      if (this.silentReplaying.has(event.sessionId)) {
        // Silent bind: never touch the UI timeline from load stream.
        return;
      }
      const replay = this.replaying.get(event.sessionId);
      if (replay) {
        // During session/load the agent can stream hundreds of thousands of
        // updates. Applying every thinking/assistant delta freezes the UI
        // (scroll works, clicks/switch/send do not). Keep only structured
        // events for the final snapshot; skip pure stream deltas.
        if (
          event.type === "assistant_append" ||
          event.type === "thinking_append"
        ) {
          return;
        }
        this.replaying.set(event.sessionId, applyToSession(replay, event));
        // Progressive restore only for intentional foreground loads.
        if (this.progressiveLoad.has(event.sessionId)) {
          this.scheduleProgressiveFlush(event.sessionId);
        }
        return;
      }
    }
    for (const callback of this.listeners) callback(event);
  }

  /** Push the current replay snapshot to the UI (throttled). */
  private scheduleProgressiveFlush(sessionId: string) {
    if (this.progressiveFlushTimers.has(sessionId)) return;
    const timer = window.setTimeout(() => {
      this.progressiveFlushTimers.delete(sessionId);
      if (!this.progressiveLoad.has(sessionId)) return;
      const snap = this.replaying.get(sessionId);
      if (!snap) return;
      const session: Session = {
        ...snap,
        status: "idle",
        blocks: snap.blocks.map((block) =>
          block.type === "assistant"
            ? { ...block, streaming: false }
            : block.type === "thinking"
              ? { ...block, live: false }
              : block,
        ),
      };
      for (const callback of this.listeners) {
        callback({ type: "session_ready", session });
      }
    }, 100);
    this.progressiveFlushTimers.set(sessionId, timer);
  }

  private clearProgressiveLoad(sessionId: string) {
    this.progressiveLoad.delete(sessionId);
    const timer = this.progressiveFlushTimers.get(sessionId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.progressiveFlushTimers.delete(sessionId);
    }
  }

  /** Seed catalogue so loadSession skips a full x.ai/session/list round-trip. */
  rememberSessionMeta(meta: SessionMeta): void {
    this.catalogue.set(meta.id, meta);
  }

  isSessionBound(id: string): boolean {
    return this.knownSessions.has(id);
  }

  setActiveSessionGetter(getter: () => string | null): void {
    this.activeSessionGetter = getter;
  }

  private activeSessionId(): string | null {
    return this.activeSessionGetter?.() ?? null;
  }

  private touchVisited(id: string): void {
    this.visitedOrder = this.visitedOrder.filter((x) => x !== id);
    this.visitedOrder.push(id);
    // Cap memory of visits
    if (this.visitedOrder.length > 40) {
      this.visitedOrder = this.visitedOrder.slice(-40);
    }
  }

  /**
   * Pick next full-load target:
   * - Active unbound mission always first (C when user is on C).
   * - Else oldest visited unbound (A after B is complete).
   */
  private nextBackgroundLoadId(): string | null {
    const active = this.activeSessionId();
    if (
      active &&
      !this.knownSessions.has(active) &&
      !this.backgroundLoadFailed.has(active)
    ) {
      return active;
    }
    for (const id of this.visitedOrder) {
      if (active && id === active) continue;
      if (this.knownSessions.has(id)) continue;
      if (this.backgroundLoadFailed.has(id)) continue;
      return id;
    }
    return null;
  }

  /**
   * Record a visit and pump the load queue.
   * Opening a mission marks it visited and prioritizes the active window.
   */
  enqueueBackgroundLoad(id: string): void {
    if (!id) return;
    this.touchVisited(id);
    // User re-opened — allow retry after a previous failure.
    this.backgroundLoadFailed.delete(id);
    void this.pumpBackgroundLoads();
  }

  private async pumpBackgroundLoads(): Promise<void> {
    if (this.backgroundLoadRunning) return;
    this.backgroundLoadRunning = true;
    try {
      for (;;) {
        const id = this.nextBackgroundLoadId();
        if (!id) break;

        // If something else is already mid-flight, wait for it via loadPromises
        // only when it's the same id; otherwise we must finish in-flight first
        // (ACP single channel) then re-evaluate nextBackgroundLoadId.
        if (
          this.backgroundLoadInFlight &&
          this.backgroundLoadInFlight !== id
        ) {
          // Wait for current in-flight to finish by awaiting its promise if any.
          const inflightId = this.backgroundLoadInFlight;
          const pending = this.loadPromises.get(inflightId);
          if (pending) {
            try {
              await pending;
            } catch {
              /* ignore */
            }
          }
          continue;
        }

        if (this.knownSessions.has(id)) continue;

        // Re-check priority right before start (user may have switched to C).
        const preferred = this.nextBackgroundLoadId();
        if (preferred !== id) {
          // Abandoned not-yet-started secondary (e.g. was about to load A, now C).
          continue;
        }

        // Active window always wins over secondary: if we're about to load a
        // non-active id but active is unbound, skip to re-pick active.
        const active = this.activeSessionId();
        if (active && active !== id && !this.knownSessions.has(active)) {
          continue;
        }

        this.backgroundLoadInFlight = id;
        try {
          // Silent bind only — offline disk history already covers viewing.
          // Full ACP UI replay freezes on large sessions and is no longer needed.
          await this.loadSession(id, { background: true, silent: true });
          this.backgroundLoadFailed.delete(id);
        } catch (error) {
          console.warn("background full-load failed", id, error);
          this.backgroundLoadFailed.add(id);
        } finally {
          this.backgroundLoadInFlight = null;
        }
      }
    } finally {
      this.backgroundLoadRunning = false;
      if (this.nextBackgroundLoadId()) {
        void this.pumpBackgroundLoads();
      }
    }
  }

  private queueStreamAppend(event: Extract<BridgeEvent, { type: "assistant_append" | "thinking_append" }>) {
    const key = `${event.type}:${event.sessionId}:${event.blockId}`;
    const pending = this.streamAppends.get(key);
    this.streamAppends.set(key, pending ? { ...pending, delta: pending.delta + event.delta } : event);
    if (this.streamFlushTimer === undefined) {
      this.streamFlushTimer = window.setTimeout(() => this.flushStreamAppends(), STREAM_FLUSH_MS);
    }
  }

  private flushStreamAppends(sessionId?: string) {
    if (this.streamFlushTimer !== undefined) {
      window.clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = undefined;
    }
    for (const [key, event] of this.streamAppends) {
      if (sessionId && event.sessionId !== sessionId) continue;
      this.streamAppends.delete(key);
      this.emit(event);
    }
    if (this.streamAppends.size > 0) {
      this.streamFlushTimer = window.setTimeout(() => this.flushStreamAppends(), STREAM_FLUSH_MS);
    }
  }

  /** Drop buffered stream deltas without emitting (used before retry replace). */
  private discardStreamAppends(sessionId: string) {
    for (const [key, event] of this.streamAppends) {
      if (event.sessionId === sessionId) this.streamAppends.delete(key);
    }
    if (this.streamAppends.size === 0 && this.streamFlushTimer !== undefined) {
      window.clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = undefined;
    }
  }

  private resetTurnRetryState(cursor: ContentCursor) {
    cursor.retryCount = 0;
    cursor.visibleAssistantChars = 0;
    cursor.expectReplace = false;
    cursor.streamSuppressed = false;
    cursor.lastAssistantId = undefined;
    cursor.lastThinkingId = undefined;
  }

  /**
   * Clear the in-flight assistant/thinking draft so a stream retry replaces a
   * single bubble instead of appending a second full answer.
   */
  private clearTurnDraft(sessionId: string) {
    this.discardStreamAppends(sessionId);
    const cursor = this.cursor(sessionId);

    if (!cursor.assistantId && cursor.lastAssistantId) {
      cursor.assistantId = cursor.lastAssistantId;
    }
    if (cursor.assistantId) {
      this.emit({
        type: "block_patch",
        sessionId,
        blockId: cursor.assistantId,
        patch: { type: "assistant", text: "", streaming: true } as Partial<SessionBlock>,
      });
      cursor.lastAssistantId = cursor.assistantId;
    }

    if (!cursor.thinkingId && cursor.lastThinkingId) {
      cursor.thinkingId = cursor.lastThinkingId;
      cursor.thinkingStartedAt = Date.now();
    }
    if (cursor.thinkingId) {
      this.emit({
        type: "block_patch",
        sessionId,
        blockId: cursor.thinkingId,
        patch: { type: "thinking", text: "", live: true } as Partial<SessionBlock>,
      });
      cursor.lastThinkingId = cursor.thinkingId;
    }

    cursor.visibleAssistantChars = 0;
    cursor.expectReplace = true;
  }

  private handleRetryState(sessionId: string, update: JsonObject) {
    const retry = record(update.retryState) ?? update;
    const variant = (string(retry.type) ?? string(retry.kind) ?? "").toLowerCase();
    const attempt = number(retry.attempt);
    const maxRetries = number(retry.max_retries) ?? number(retry.maxRetries);
    const errorText =
      string(retry.error) ?? string(retry.message) ?? string(retry.error_type) ?? "transient failure";
    const exhausted =
      variant === "exhausted" ||
      variant === "failed" ||
      retry.exhausted === true ||
      (maxRetries !== undefined && attempt !== undefined && attempt >= maxRetries);

    const cursor = this.cursor(sessionId);
    cursor.retryCount = (cursor.retryCount ?? 0) + 1;
    const retryLabel =
      attempt !== undefined
        ? maxRetries !== undefined
          ? `${attempt}/${maxRetries}`
          : `×${attempt}`
        : `×${cursor.retryCount}`;

    if (exhausted) {
      cursor.expectReplace = false;
      this.emit({
        type: "block_add",
        sessionId,
        block: {
          type: "system",
          id: uid(),
          text: `RETRY EXHAUSTED · ${errorText}`,
          ts: Date.now(),
          kind: "info",
        },
      });
      return;
    }

    const hadVisibleBody = (cursor.visibleAssistantChars ?? 0) >= VISIBLE_ASSISTANT_BODY_CHARS;
    if (hadVisibleBody && (cursor.retryCount ?? 0) > MAX_RETRIES_WITH_VISIBLE_BODY) {
      // Keep the already-rendered body; stop further retry streams from stacking.
      cursor.streamSuppressed = true;
      cursor.expectReplace = false;
      this.emit({
        type: "block_add",
        sessionId,
        block: {
          type: "system",
          id: uid(),
          text: `RETRY LIMITED · 已有可见正文，停止继续重试（${retryLabel}）· ${errorText}`,
          ts: Date.now(),
          kind: "info",
        },
      });
      this.cancel(sessionId);
      return;
    }

    // Priority fix: clear draft before the retried stream lands, single-bubble replace.
    this.clearTurnDraft(sessionId);
    this.emit({
      type: "block_add",
      sessionId,
      block: {
        type: "system",
        id: uid(),
        text: `RETRY · ${retryLabel} · ${errorText}`,
        ts: Date.now(),
        kind: "info",
      },
    });
  }

  private queueToolPatch(event: Extract<BridgeEvent, { type: "tool_patch" }>) {
    const key = `${event.sessionId}:${event.blockId}`;
    const pending = this.toolPatches.get(key);
    this.toolPatches.set(key, pending ? { ...event, call: { ...pending.call, ...event.call } } : event);
    if (this.toolFlushTimer === undefined) {
      this.toolFlushTimer = window.setTimeout(() => this.flushToolPatches(), TOOL_FLUSH_MS);
    }
  }

  private flushToolPatches(sessionId?: string) {
    if (this.toolFlushTimer !== undefined) {
      window.clearTimeout(this.toolFlushTimer);
      this.toolFlushTimer = undefined;
    }
    for (const [key, event] of this.toolPatches) {
      if (sessionId && event.sessionId !== sessionId) continue;
      this.toolPatches.delete(key);
      this.emit(event);
    }
    if (this.toolPatches.size > 0) {
      this.toolFlushTimer = window.setTimeout(() => this.flushToolPatches(), TOOL_FLUSH_MS);
    }
  }

  private cursor(sessionId: string): ContentCursor {
    let cursor = this.cursors.get(sessionId);
    if (!cursor) {
      cursor = { toolBlocks: new Map() };
      this.cursors.set(sessionId, cursor);
    }
    return cursor;
  }

  /** Inbound ACP lines — drained in rAF slices so a huge session/load cannot freeze clicks. */
  private inboundQueue: string[] = [];
  private inboundDraining = false;

  private enqueueInbound(line: string) {
    // Belt-and-braces: only drop history floods for sessions currently silent-binding.
    if (shouldDropSilentInbound(line, this.silentReplaying)) {
      return;
    }
    // Bound memory if a non-silent flood arrives (broken filter / huge replay).
    const MAX_INBOUND_LINES = 20_000;
    if (this.inboundQueue.length >= MAX_INBOUND_LINES) {
      this.inboundQueue.splice(0, Math.floor(MAX_INBOUND_LINES / 4));
    }
    this.inboundQueue.push(line);
    if (this.inboundDraining) return;
    this.inboundDraining = true;
    const pump = () => {
      const start = performance.now();
      // ~one frame of work; leave headroom for clicks / React.
      while (this.inboundQueue.length > 0 && performance.now() - start < 6) {
        const next = this.inboundQueue.shift();
        if (next !== undefined) this.onLine(next);
      }
      if (this.inboundQueue.length > 0) {
        window.requestAnimationFrame(pump);
      } else {
        this.inboundDraining = false;
      }
    };
    window.requestAnimationFrame(pump);
  }

  /**
   * Per-session silent history filter. Pass `sessionId` when enabling/disabling
   * bind for one mission; omit sessionId with silent=false to clear all.
   */
  private async setSilentStream(silent: boolean, sessionId?: string): Promise<void> {
    try {
      await invoke("acp_set_silent_stream", {
        silent,
        sessionId: sessionId ?? null,
      });
    } catch {
      /* older shells without the command — JS drop still applies */
    }
  }

  /** Serialize heavy ACP ops so silent bind cannot overlap another session's live stream. */
  private runOnChannel<T>(op: () => Promise<T>): Promise<T> {
    const run = this.channelTail.then(op, op);
    this.channelTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Drop bind-state that dies with the agent child. */
  private resetBindStateAfterAgentExit(): void {
    this.knownSessions.clear();
    this.loadPromises.clear();
    this.silentReplaying.clear();
    this.replaying.clear();
    this.progressiveLoad.clear();
    for (const timer of this.progressiveFlushTimers.values()) {
      window.clearTimeout(timer);
    }
    this.progressiveFlushTimers.clear();
    this.inboundQueue = [];
    this.inboundDraining = false;
    this.backgroundLoadInFlight = null;
    this.backgroundLoadRunning = false;
    this.backgroundLoadFailed.clear();
    // Cut the exclusive channel so a hung load cannot block the next agent life.
    this.channelTail = Promise.resolve();
    // Stale Computer leases cannot drive desktop after the stdio child is gone.
    this.computerLeases.clear();
    this.activeComputerSessions.clear();
    this.activeComputerToolCalls.clear();
    void invoke("computer_revoke_http_auth").catch(() => {});
    void this.setSilentStream(false);
  }

  private async connect(): Promise<void> {
    const environment = await invoke<DesktopEnvironment>("desktop_environment");
    this.workspace = localStorage.getItem("grok.workspace") ?? environment.defaultWorkspace;
    // Align FE opt-in with host GROX_COMPUTER_USE (R4A-CU-03).
    await this.refreshComputerUseHostEnv();

    this.unlisten.push(
      await listen<string>("acp-event", ({ payload }) => this.enqueueInbound(payload)),
      await listen<string>("acp-stderr", ({ payload }) => {
        this.diagnostics.push(payload);
        this.diagnostics = this.diagnostics.slice(-20);
      }),
      await listen<ExitPayload>("acp-exit", ({ payload }) => this.onExit(payload)),
      await listen("computer-emergency-shortcut", () => {
        // Stop every session that has (or had) a Computer lease — not only
        // mid-tool-call sessions. Between observe→action activeComputerSessions
        // is empty while the bearer is still live.
        const leaseSessions = new Set<string>([
          ...this.activeComputerSessions,
          ...this.computerLeases.keys(),
        ]);
        if (leaseSessions.size === 0) {
          void invoke("computer_revoke_http_auth").catch(() => {});
          return;
        }
        for (const sessionId of leaseSessions) {
          void this.emergencyStopComputer(sessionId).catch(() => {});
        }
      }),
    );

    await this.initializeAgent();
  }

  private async initializeAgent(): Promise<void> {
    // Diagnostics belong to one concrete child process. Keeping stderr from a
    // process replaced during a Tauri hot reload produces misleading errors.
    this.diagnostics = [];
    try {
      await Promise.race([
        invoke("acp_spawn", { cwd: this.workspace }),
        new Promise<never>((_, reject) => {
          window.setTimeout(
            () => reject(new Error("启动 Grok Agent 超时（30 秒）")),
            30_000,
          );
        }),
      ]);
    } catch (error) {
      const detail = errorText(error);
      throw new Error(
        `无法启动 Grok Agent：${detail}。请确认 Grok Build CLI 已安装，或通过 GROK_DESKTOP_CLI 指定可执行文件。`,
      );
    }
    let response: unknown;
    try {
      response = await this.requestRaw(
        ACP_METHODS.initialize,
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "grox-desktop", title: "Grox Desktop", version: "0.1.0" },
          _meta: {
            clientIdentifier: "grok-desktop",
            clientType: "desktop",
          },
        },
        20_000,
      );
    } catch (error) {
      throw new Error(
        `Grok Agent 初始化失败：${errorText(error)}。CLI 已启动但未在 20 秒内完成握手。`,
      );
    }
    this.captureModelState(response);
    await this.configureAuthentication(response);
  }

  private async restartAgent(): Promise<void> {
    // Queue restarts: concurrent activate/logout must not interleave spawn.
    const run = this.restartTail.then(
      () => this.restartAgentInner(),
      () => this.restartAgentInner(),
    );
    this.restartTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Wake any crash-reconnect backoff waiter and drop the timer. */
  private cancelReconnectDelay(): void {
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.reconnectDelayResolve) {
      const resolve = this.reconnectDelayResolve;
      this.reconnectDelayResolve = null;
      resolve();
    }
  }

  private async restartAgentInner(): Promise<void> {
    const fromCrash = this.restartFromCrashReconnect;
    this.suppressExitHandling = true;
    // Intentional restart (provider switch / logout) aborts crash-reconnect ownership.
    if (!fromCrash) {
      this.reconnectEpoch += 1;
      this.crashReconnectInFlight = false;
      this.reconnectChildDied = false;
    }
    this.cancelReconnectDelay();
    try {
      this.flushStreamAppends();
      this.flushToolPatches();
      const error = new Error("模型服务已切换，请重新发送尚未完成的请求");
      for (const request of this.pending.values()) {
        if (request.timeoutId !== undefined) window.clearTimeout(request.timeoutId);
        request.reject(error);
      }
      this.pending.clear();
      this.interactions.clear();
      this.cursors.clear();
      this.sessionOptions.clear();
      // Match agent-exit cleanup so silent bind / computer leases cannot leak.
      this.resetBindStateAfterAgentExit();
      this.computerLeases.clear();
      this.activeComputerSessions.clear();
      this.activeComputerToolCalls.clear();
      this.channelTail = Promise.resolve();
      this.authMethodId = undefined;
      this.modelState = { models: MODELS, currentId: MODELS[0].id };
      const next = this.initializeAgent();
      // Crash-reconnect owns `ready` for the full attempt budget — do not overwrite
      // with a rejected init mid-retry (R14.1 B1).
      if (!fromCrash) {
        this.ready = next;
      }
      await next;
      // R14.2: never clear childDied on crash spawns — flag is owned by
      // runCrashReconnect (infinite-loop fix when child flaps after handshake).
      if (!fromCrash) {
        this.reconnectChildDied = false;
      }
    } finally {
      this.suppressExitHandling = false;
    }
  }

  private async configureAuthentication(responseValue: unknown) {
    const response = record(responseValue);
    const methods = array(response?.authMethods).map((value) => record(value) ?? {});
    if (methods.length === 0) {
      this.setAuthState({
        required: true,
        inProgress: false,
        error: "Grok Agent 没有可用的认证方式，请检查认证配置或 XAI_API_KEY。",
      });
      return;
    }

    const first = methods[0];
    const firstId = string(first.id);
    const firstInteractive = firstId === "grok.com" || firstId === "oidc";
    const meta = record(response?._meta);
    const defaultId = string(meta?.defaultAuthMethodId);
    this.authMethodId = firstInteractive
      ? firstId
      : defaultId && methods.some((method) => string(method.id) === defaultId)
        ? defaultId
        : firstId;

    if (firstInteractive) {
      this.setAuthState({
        required: true,
        inProgress: false,
        label: string(first.name) ?? "Sign in to Grok",
        error: undefined,
      });
      return;
    }

    try {
      await this.requestRaw("authenticate", { methodId: this.authMethodId });
      this.setAuthState({ required: false, inProgress: false, error: undefined });
    } catch (error) {
      const interactive = methods.find((method) => {
        const id = string(method.id);
        return id === "grok.com" || id === "oidc";
      });
      this.authMethodId = string(interactive?.id);
      this.setAuthState({
        required: Boolean(this.authMethodId),
        inProgress: false,
        label: string(interactive?.name) ?? "Sign in to Grok",
        error: this.authMethodId ? undefined : errorText(error),
      });
    }
  }

  private onExit(payload: ExitPayload) {
    // Exit from a process we are intentionally replacing (restart/spawn).
    if (this.suppressExitHandling) {
      // Child died under suppress — if crash-reconnect just spawned, force another try.
      if (this.crashReconnectInFlight && payload.reason !== "killed") {
        this.reconnectChildDied = true;
      }
      return;
    }
    this.flushStreamAppends();
    this.flushToolPatches();
    // Drop permission/question RPCs immediately so UI cannot sendRaw to a corpse.
    this.interactions.clear();
    // Intentional stop (acp_kill) still must clear bind/lease state.
    if (payload.reason === "killed") {
      for (const request of this.pending.values()) {
        if (request.timeoutId !== undefined) window.clearTimeout(request.timeoutId);
        request.reject(new Error("Grok Agent 已停止"));
      }
      this.pending.clear();
      this.resetBindStateAfterAgentExit();
      this.reconnectEpoch += 1;
      this.crashReconnectInFlight = false;
      this.cancelReconnectDelay();
      // Park ready on a rejected promise so send/drain cannot talk to a dead child.
      const stopped = new Error("Grok Agent 已停止");
      this.ready = Promise.reject(stopped);
      void this.ready.catch(() => undefined);
      return;
    }
    const diagnostic = this.diagnostics
      .filter((line) => {
        const value = line.trim();
        return (
          value.length > 0 &&
          !value.startsWith("Usage:") &&
          !value.startsWith("For more information, try")
        );
      })
      .slice(-6)
      .join(" ");
    const message = `Grok Agent 已退出${payload.code == null ? "" : `（代码 ${payload.code}）`}${
      diagnostic ? `：${diagnostic}` : ""
    }`;
    for (const request of this.pending.values()) {
      if (request.timeoutId !== undefined) window.clearTimeout(request.timeoutId);
      request.reject(new Error(message));
    }
    this.pending.clear();
    const bound = [...this.knownSessions];
    // Must clear before re-emit so first-send will re-bind after agent death.
    this.resetBindStateAfterAgentExit();
    for (const sessionId of bound) {
      this.emit({ type: "error", sessionId, message });
    }
    // Second death while reconnect is already running: force another attempt.
    if (this.crashReconnectInFlight) {
      this.reconnectChildDied = true;
      return;
    }
    // Park `ready` on the reconnect promise so queue drain / prompt cannot race
    // a dead stdio child while the 800ms backoff runs (R12 / R14.1).
    this.crashReconnectInFlight = true;
    this.reconnectChildDied = false;
    const epoch = this.reconnectEpoch;
    this.ready = this.runCrashReconnect(message, epoch).finally(() => {
      if (this.reconnectEpoch === epoch) {
        this.crashReconnectInFlight = false;
      }
    });
    void this.ready.catch(() => undefined);
  }

  /**
   * Auto-reconnect after unexpected agent exit. Owns `this.ready` for the full
   * attempt budget so concurrent prompt/drain await the live child.
   */
  private async runCrashReconnect(lastMessage: string, epoch: number): Promise<void> {
    let lastError = lastMessage;
    // Local budget — independent of restartAgentInner (must not be zeroed mid-loop).
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (this.reconnectEpoch !== epoch) {
        // Intentional restart took over ready — exit quietly.
        return;
      }
      const delayMs = 800 * attempt;
      this.setAuthState({
        ...this.authState,
        inProgress: true,
        error: `Agent 异常退出，正在自动重连（${attempt}/2）…`,
      });
      await new Promise<void>((resolve) => {
        this.reconnectDelayResolve = () => {
          this.reconnectDelayResolve = null;
          resolve();
        };
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = undefined;
          const done = this.reconnectDelayResolve;
          this.reconnectDelayResolve = null;
          done?.();
        }, delayMs);
      });
      if (this.reconnectEpoch !== epoch) {
        return;
      }
      try {
        this.reconnectChildDied = false;
        this.restartFromCrashReconnect = true;
        try {
          await this.restartAgent();
        } finally {
          this.restartFromCrashReconnect = false;
        }
        // R14.2: re-check epoch + liveness immediately before publishing ready
        // (intentional restart / second death can land during await).
        if (this.reconnectEpoch !== epoch) {
          return;
        }
        if (this.reconnectChildDied) {
          lastError = "Agent 在重连后再次退出";
          this.reconnectChildDied = false;
          continue;
        }
        // Final TOCTOU belt: still the same epoch and no late death flag.
        if (this.reconnectEpoch !== epoch) {
          return;
        }
        if (this.reconnectChildDied) {
          lastError = "Agent 在重连后再次退出";
          this.reconnectChildDied = false;
          continue;
        }
        this.setAuthState({
          ...this.authState,
          error: undefined,
          inProgress: false,
        });
        // Only claim ready if we still own the reconnect epoch.
        if (this.reconnectEpoch !== epoch) {
          return;
        }
        this.ready = Promise.resolve();
        // Rebind active mission in the background so the next send is cheap.
        const active = this.activeSessionId();
        if (active) {
          this.enqueueBackgroundLoad(active);
          this.emit({
            type: "block_add",
            sessionId: active,
            block: {
              type: "system",
              id: uid(),
              text: "Agent 已自动重连；可继续对话（首次发送会静默绑定上下文）",
              ts: Date.now(),
              kind: "info",
            },
          });
        }
        // Let the store re-drain local queues that parked while ready was offline.
        this.emit({ type: "agent_reconnected" });
        return;
      } catch (error) {
        lastError = errorText(error);
      }
    }
    if (this.reconnectEpoch !== epoch) {
      return;
    }
    const finalMessage = `${lastError}（已自动重连 2 次仍失败，请重启 Grox 或检查 Grok CLI）`;
    this.setAuthState({
      required: this.authState.required,
      inProgress: false,
      error: finalMessage,
    });
    const fail = new Error(finalMessage);
    this.ready = Promise.reject(fail);
    void this.ready.catch(() => undefined);
    throw fail;
  }

  private onLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = normalizeInboundExtension(JSON.parse(line) as JsonRpcMessage);
    } catch {
      this.diagnostics.push(`无效 ACP JSON：${line.slice(0, 500)}`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
      if (message.error !== undefined) {
        const error = record(message.error);
        pending.reject(
          new AcpRpcError(
            pending.method,
            number(error?.code),
            string(error?.message) ?? `ACP 请求失败：${pending.method}`,
            error?.data,
          ),
        );
      } else {
        const extension = pending.method.startsWith("x.ai/")
          ? record(message.result)
          : undefined;
        if (extension && "error" in extension && extension.error != null) {
          pending.reject(
            new AcpRpcError(
              pending.method,
              number(record(extension.error)?.code),
              errorText(extension.error),
              extension.error,
            ),
          );
        } else if (extension && "result" in extension) {
          pending.resolve(extension.result);
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      this.onServerRequest(message);
      return;
    }
    if (message.method) this.onNotification(message.method, message.params);
  }

  private onServerRequest(message: JsonRpcMessage) {
    if (message.method === ACP_METHODS.requestPermission) {
      this.handlePermission(message.id!, message.params);
      return;
    }
    if (message.method === "x.ai/exit_plan_mode") {
      this.handlePlanApproval(message.id!, message.params);
      return;
    }
    if (message.method === "x.ai/ask_user_question") {
      this.handleQuestion(message.id!, message.params);
      return;
    }
    if (message.method === "x.ai/queue/changed" || message.method === "_x.ai/queue/changed") {
      this.handleQueueChanged(message.params);
      void this.sendRaw({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    void this.sendRaw({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unsupported client method: ${message.method}` },
    });
  }

  private onNotification(method: string, paramsValue: unknown) {
    if (method === "session/update" || method === "x.ai/session/update") {
      const params = record(paramsValue);
      const sessionId = string(params?.sessionId);
      if (sessionId && this.silentReplaying.has(sessionId)) return;
      if (sessionId) this.handleSessionUpdate(sessionId, params?.update);
      return;
    }
    if (method === "x.ai/session_notification") {
      const params = record(paramsValue);
      const sessionId = string(params?.sessionId);
      if (sessionId && this.silentReplaying.has(sessionId)) return;
      if (sessionId) this.handleXaiUpdate(sessionId, params?.update);
      return;
    }
    if (method === "x.ai/models/update") {
      this.captureModelState(paramsValue);
      return;
    }
    if (method === "x.ai/queue/changed" || method === "_x.ai/queue/changed") {
      this.handleQueueChanged(paramsValue);
      return;
    }
    if (method === "x.ai/session/prompt_complete") {
      const params = record(paramsValue);
      const sessionId = string(params?.sessionId);
      if (sessionId) this.finishTurn(sessionId, record(params?.usage));
    }
  }

  private handleQueueChanged(paramsValue: unknown) {
    const params = record(paramsValue) ?? {};
    const sessionId = string(params.sessionId);
    if (!sessionId) return;
    const raw =
      params.queue ??
      params.entries ??
      record(params.update)?.queue ??
      record(params.update)?.entries ??
      [];
    const previous = this.cliQueues.get(sessionId) ?? [];
    const entries = normalizePromptQueue(raw, previous);
    this.cliQueues.set(sessionId, entries);
    this.emit({ type: "prompt_queue", sessionId, entries });
  }

  /** Fire-and-forget notification to the agent; failures are swallowed. */
  private queueNotify(method: string, sessionId: string, params: Record<string, unknown>): void {
    void this.sendRaw({
      jsonrpc: "2.0",
      method: wireMethod(method),
      params: {
        sessionId,
        clientIdentifier: "grox-desktop",
        ...params,
      },
    }).catch(() => {
      // Older CLIs ignore unknown notifications.
    });
  }

  private handleSessionUpdate(sessionId: string, updateValue: unknown) {
    const update = record(updateValue);
    if (!update) return;
    const type = string(update.sessionUpdate);
    // While replaying session/load, thought tokens are pure noise for the final
    // UI snapshot and dominate CPU on long sessions — drop them.
    if (this.replaying.has(sessionId) && type === "agent_thought_chunk") {
      return;
    }
    const cursor = this.cursor(sessionId);

    switch (type) {
      case "user_message_chunk": {
        if (!this.replaying.has(sessionId)) return;
        const delta = contentText(update.content);
        const promptIndex = number(record(update._meta)?.promptIndex);
        const userId = cursor.userId;
        const beginsNewPrompt =
          !userId ||
          !cursor.userOpen ||
          (promptIndex !== undefined &&
            cursor.userPromptIndex !== undefined &&
            promptIndex !== cursor.userPromptIndex);
        if (beginsNewPrompt) {
          const nextUserId = uid();
          cursor.userId = nextUserId;
          cursor.userText = delta;
          this.emit({
            type: "block_add",
            sessionId,
            block: { type: "user", id: nextUserId, text: delta, ts: Date.now() },
          });
        } else {
          cursor.userText = `${cursor.userText ?? ""}${delta}`;
          this.emit({
            type: "block_patch",
            sessionId,
            blockId: userId,
            patch: { type: "user", text: cursor.userText } as Partial<SessionBlock>,
          });
        }
        cursor.userOpen = true;
        if (promptIndex !== undefined) cursor.userPromptIndex = promptIndex;
        cursor.assistantId = undefined;
        cursor.thinkingId = undefined;
        cursor.thinkingStartedAt = undefined;
        this.resetTurnRetryState(cursor);
        return;
      }
      case "agent_message_chunk": {
        if (cursor.streamSuppressed) return;
        this.closeUser(sessionId);
        this.closeThinking(sessionId);
        const delta = contentText(update.content);
        if (!cursor.assistantId) {
          // After a stream retry, replace the same bubble instead of stacking a twin.
          if (cursor.expectReplace && cursor.lastAssistantId) {
            cursor.assistantId = cursor.lastAssistantId;
            this.discardStreamAppends(sessionId);
            this.emit({
              type: "block_patch",
              sessionId,
              blockId: cursor.assistantId,
              patch: { type: "assistant", text: "", streaming: true } as Partial<SessionBlock>,
            });
            cursor.visibleAssistantChars = 0;
          } else {
            cursor.assistantId = uid();
            this.emit({
              type: "block_add",
              sessionId,
              block: {
                type: "assistant",
                id: cursor.assistantId,
                text: "",
                ts: Date.now(),
                streaming: true,
              },
            });
          }
          cursor.lastAssistantId = cursor.assistantId;
          cursor.expectReplace = false;
        }
        cursor.visibleAssistantChars = (cursor.visibleAssistantChars ?? 0) + delta.length;
        this.queueStreamAppend({ type: "assistant_append", sessionId, blockId: cursor.assistantId, delta });
        return;
      }
      case "agent_thought_chunk": {
        if (cursor.streamSuppressed) return;
        this.closeUser(sessionId);
        this.closeAssistant(sessionId);
        const delta = contentText(update.content);
        if (!cursor.thinkingId) {
          if (cursor.expectReplace && cursor.lastThinkingId) {
            cursor.thinkingId = cursor.lastThinkingId;
            cursor.thinkingStartedAt = Date.now();
            this.discardStreamAppends(sessionId);
            this.emit({
              type: "block_patch",
              sessionId,
              blockId: cursor.thinkingId,
              patch: { type: "thinking", text: "", live: true } as Partial<SessionBlock>,
            });
          } else {
            cursor.thinkingId = uid();
            cursor.thinkingStartedAt = Date.now();
            this.emit({
              type: "block_add",
              sessionId,
              block: {
                type: "thinking",
                id: cursor.thinkingId,
                text: "",
                ts: Date.now(),
                live: true,
              },
            });
          }
          cursor.lastThinkingId = cursor.thinkingId;
          // Keep expectReplace for a following assistant chunk in the same retry cycle.
        }
        this.queueStreamAppend({ type: "thinking_append", sessionId, blockId: cursor.thinkingId, delta });
        return;
      }
      case "current_mode_update": {
        const modeId = string(update.currentModeId);
        const mode: AgentMode = modeId === "plan" ? "plan" : modeId === "ask" ? "ask" : "agent";
        this.emit({ type: "mode_state", sessionId, mode });
        return;
      }
      case "tool_call":
        this.closeUser(sessionId);
        this.addTool(sessionId, update);
        return;
      case "tool_call_update":
        this.patchTool(sessionId, update);
        return;
      case "plan": {
        this.closeUser(sessionId);
        const steps = mapPlanSteps(update.entries);
        if (!cursor.planId) {
          cursor.planId = uid();
          this.emit({
            type: "block_add",
            sessionId,
            block: { type: "plan", id: cursor.planId, steps, ts: Date.now() },
          });
        } else {
          this.emit({ type: "plan_patch", sessionId, blockId: cursor.planId, steps });
        }
        return;
      }
      case "turn_completed":
        this.finishTurn(sessionId, record(update.usage));
        return;
      default:
        return;
    }
  }

  private addTool(sessionId: string, update: JsonObject) {
    const cursor = this.cursor(sessionId);
    this.closeThinking(sessionId);
    this.closeAssistant(sessionId);
    const toolCallId = string(update.toolCallId) ?? uid();
    const blockId = cursor.toolBlocks.get(toolCallId) ?? uid();
    cursor.toolBlocks.set(toolCallId, blockId);
    const content = array(update.content);
    const kind = mapToolKind(update.kind, update.title);
    const call: ToolCall = {
      id: toolCallId,
      kind,
      rawKind: string(update.kind),
      title: string(update.title) ?? "tool",
      detail: string(update.detail),
      status: mapToolStatus(update.status),
      startedAt: Date.now(),
      input: jsonText(update.rawInput),
      output: toolOutputText(update.rawOutput, content),
      diff: extractDiffs([content, update.rawInput, update.rawOutput]),
      images: extractImages([content, update.rawOutput]),
      terminal: extractTerminal(
        kind,
        update.title,
        update.rawInput,
        update.rawOutput,
        content,
      ),
      locations: extractLocations(update.locations, update.rawInput, update.rawOutput, content),
    };
    if (kind === "computer" && call.status === "running") {
      this.activeComputerToolCalls.add(`${sessionId}:${toolCallId}`);
      this.activeComputerSessions.add(sessionId);
    }
    this.emit({
      type: "block_add",
      sessionId,
      block: { type: "tool", id: blockId, call, ts: Date.now() },
    });
  }

  private patchTool(sessionId: string, update: JsonObject) {
    const cursor = this.cursor(sessionId);
    const toolCallId = string(update.toolCallId);
    if (!toolCallId) return;
    let blockId = cursor.toolBlocks.get(toolCallId);
    if (!blockId) {
      this.addTool(sessionId, update);
      blockId = cursor.toolBlocks.get(toolCallId);
      if (!blockId) return;
    }
    const status = mapToolStatus(update.status);
    const content = array(update.content);
    const terminal = extractTerminal(
      mapToolKind(update.kind, update.title),
      update.title,
      update.rawInput,
      update.rawOutput,
      content,
    );
    const kind = mapToolKind(update.kind, update.title);
    const computerToolKey = `${sessionId}:${toolCallId}`;
    const isComputerTool = kind === "computer" || this.activeComputerToolCalls.has(computerToolKey);
    if (isComputerTool) {
      if (status === "running") {
        this.activeComputerToolCalls.add(computerToolKey);
        this.activeComputerSessions.add(sessionId);
      } else if (status === "done" || status === "error" || status === "cancelled") {
        this.activeComputerToolCalls.delete(computerToolKey);
        if (![...this.activeComputerToolCalls].some((key) => key.startsWith(`${sessionId}:`))) {
          this.activeComputerSessions.delete(sessionId);
        }
      }
    }
    const locations = extractLocations(update.locations, update.rawInput, update.rawOutput, content);
    this.queueToolPatch({
      type: "tool_patch",
      sessionId,
      blockId,
      call: {
        ...(update.kind !== undefined || update.title !== undefined ? { kind } : {}),
        ...(update.kind !== undefined ? { rawKind: string(update.kind) } : {}),
        status,
        ...(status === "done" || status === "error" || status === "cancelled" ? { endedAt: Date.now() } : {}),
        ...(update.title !== undefined ? { title: string(update.title) } : {}),
        ...(update.detail !== undefined ? { detail: string(update.detail) } : {}),
        ...(update.rawInput !== undefined ? { input: jsonText(update.rawInput) } : {}),
        ...(update.rawOutput !== undefined || content.length > 0 ? { output: toolOutputText(update.rawOutput, content) } : {}),
        ...(content.length > 0 || update.rawInput !== undefined || update.rawOutput !== undefined
          ? { diff: extractDiffs([content, update.rawInput, update.rawOutput]) }
          : {}),
        ...(content.length > 0 || update.rawOutput !== undefined ? { images: extractImages([content, update.rawOutput]) } : {}),
        ...(terminal ? { terminal } : {}),
        ...(locations ? { locations } : {}),
      },
    });
  }

  private handleXaiUpdate(sessionId: string, updateValue: unknown) {
    const update = record(updateValue);
    if (!update) return;
    switch (string(update.sessionUpdate)) {
      case "turn_completed":
        this.finishTurn(sessionId, record(update.usage));
        break;
      case "auto_compact_started":
        this.emit({
          type: "block_add",
          sessionId,
          block: {
            type: "system",
            id: uid(),
            text: `CONTEXT COMPACTION · ${number(update.percentage) ?? 0}%`,
            ts: Date.now(),
            kind: "compact",
          },
        });
        break;
      case "auto_compact_failed":
      case "auto_recovery_exhausted":
        this.emit({
          type: "error",
          sessionId,
          message: string(update.error) ?? "Grok Agent 恢复失败",
        });
        break;
      case "retry_state":
        this.handleRetryState(sessionId, update);
        break;
      case "auto_recovery_started":
        // Same failure mode as retry: drop partial draft so recovery rewrites one bubble.
        this.clearTurnDraft(sessionId);
        this.emit({
          type: "block_add",
          sessionId,
          block: {
            type: "system",
            id: uid(),
            text: `AUTO RECOVERY · ${string(update.error) ?? string(update.message) ?? "recovering"}`,
            ts: Date.now(),
            kind: "info",
          },
        });
        break;
      case "session_summary_generated": {
        const meta = this.catalogue.get(sessionId);
        const title = string(update.session_summary);
        if (meta && title) {
          this.catalogue.set(sessionId, { ...meta, title });
          this.emit({ type: "session_meta", sessionId, patch: { title } });
        }
        break;
      }
    }
  }

  private closeThinking(sessionId: string) {
    const cursor = this.cursor(sessionId);
    if (cursor.thinkingId) {
      this.flushStreamAppends(sessionId);
      this.emit({
        type: "block_patch",
        sessionId,
        blockId: cursor.thinkingId,
        patch: {
          type: "thinking",
          live: false,
          elapsedMs: cursor.thinkingStartedAt ? Date.now() - cursor.thinkingStartedAt : undefined,
        } as Partial<SessionBlock>,
      });
      cursor.lastThinkingId = cursor.thinkingId;
      cursor.thinkingId = undefined;
      cursor.thinkingStartedAt = undefined;
    }
  }

  private closeUser(sessionId: string) {
    const cursor = this.cursor(sessionId);
    cursor.userOpen = false;
    cursor.userId = undefined;
    cursor.userText = undefined;
  }

  private closeAssistant(sessionId: string) {
    const cursor = this.cursor(sessionId);
    if (cursor.assistantId) {
      this.flushStreamAppends(sessionId);
      this.emit({
        type: "block_patch",
        sessionId,
        blockId: cursor.assistantId,
        patch: { type: "assistant", streaming: false } as Partial<SessionBlock>,
      });
      cursor.lastAssistantId = cursor.assistantId;
      cursor.assistantId = undefined;
    }
  }

  private finishTurn(sessionId: string, usageValue?: JsonObject) {
    this.closeUser(sessionId);
    this.closeThinking(sessionId);
    this.closeAssistant(sessionId);
    this.flushToolPatches(sessionId);
    this.resetTurnRetryState(this.cursor(sessionId));
    if (usageValue) this.emitUsage(sessionId, usageValue);
    this.emit({ type: "status", sessionId, status: "idle" });
  }

  private emitUsage(sessionId: string, usageValue: JsonObject) {
    const previous = this.usage.get(sessionId) ?? { ...EMPTY_USAGE };
    const ticks = number(usageValue.costUsdTicks);
    const next: Usage = {
      ...previous,
      inputTokens: number(usageValue.inputTokens) ?? previous.inputTokens,
      outputTokens: number(usageValue.outputTokens) ?? previous.outputTokens,
      cacheReadTokens: number(usageValue.cachedReadTokens) ?? previous.cacheReadTokens,
      costUSD: ticks === undefined ? previous.costUSD : ticks / 10_000_000_000,
      turns: number(usageValue.numTurns) ?? previous.turns,
    };
    this.usage.set(sessionId, next);
    this.emit({ type: "usage", sessionId, usage: next });
  }

  private handlePermission(rpcId: RpcId, paramsValue: unknown) {
    const params = record(paramsValue) ?? {};
    const tool = record(params.toolCall) ?? {};
    const sessionId = string(params.sessionId);
    if (!sessionId) {
      void this.sendRaw({
        jsonrpc: "2.0",
        id: rpcId,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    const toolCallId = string(tool.toolCallId) ?? string(params.toolCallId) ?? uid();
    const blockId = `permission-${toolCallId}`;
    const optionIds: PendingInteraction["optionIds"] = {};
    for (const rawOption of array(params.options)) {
      const option = record(rawOption) ?? {};
      const optionId = string(option.optionId);
      if (!optionId) continue;
      const kindRaw = (
        string(option.kind) ??
        string(option.name) ??
        string(option.label) ??
        optionId
      ).toLowerCase();
      if (
        kindRaw === "allow_once" ||
        kindRaw === "allow-once" ||
        kindRaw === "allowonce" ||
        (kindRaw.includes("allow") && kindRaw.includes("once") && !kindRaw.includes("always"))
      ) {
        optionIds.allow_once = optionId;
      } else if (
        kindRaw === "allow_always" ||
        kindRaw === "allow-always" ||
        kindRaw === "allowalways" ||
        kindRaw === "allow_all" ||
        (kindRaw.includes("allow") && kindRaw.includes("always"))
      ) {
        optionIds.allow_always = optionId;
      } else if (
        kindRaw === "reject_once" ||
        kindRaw === "reject_always" ||
        kindRaw === "deny" ||
        kindRaw.includes("reject") ||
        kindRaw.includes("deny")
      ) {
        optionIds.deny ??= optionId;
      } else if (kindRaw.includes("allow") && !optionIds.allow_once) {
        // CLI variants that only expose a generic "allow" — treat as once.
        optionIds.allow_once = optionId;
      }
    }
    const options = (["allow_once", "allow_always", "deny"] as PermissionOption[]).filter(
      (option) => optionIds[option] !== undefined || option === "deny",
    );

    // Settings 「允许 Computer Use」 already authorizes the desktop harness.
    // Under DEFAULT permission mode the CLI still raises session/request_permission
    // for every MCP tool — auto-select allow so the operator is not double-gated.
    const toolName = computerToolNameFromPermissionTool({
      title: tool.title,
      kind: tool.kind,
      name: tool.name,
      toolName: tool.toolName ?? tool.tool_name,
      rawInput: tool.rawInput ?? tool.raw_input ?? params.rawInput,
    });
    // Auto-select when product mode is Auto/Bypass (CLI may still raise
    // request_permission — FE must not stall the turn), or when CU opt-in
    // already authorized the desktop harness for grok_desktop_computer tools.
    const modeAuto =
      this.permissionMode === "auto" || this.permissionMode === "bypass";
    const cuAuto =
      isComputerUseOperatorEnabled() && isComputerUseMcpTool(toolName);
    if (modeAuto || cuAuto) {
      const autoOptionId = optionIds.allow_always ?? optionIds.allow_once;
      if (autoOptionId) {
        void this.sendRaw({
          jsonrpc: "2.0",
          id: rpcId,
          result: { outcome: { outcome: "selected", optionId: autoOptionId } },
        }).catch((error) => {
          this.emit({ type: "error", sessionId, message: errorText(error) });
        });
        return;
      }
    }

    this.interactions.set(blockId, {
      rpcId,
      sessionId,
      blockId,
      kind: "permission",
      optionIds,
    });
    this.emit({
      type: "permission_request",
      sessionId,
      blockId,
      req: {
        id: String(rpcId),
        toolCallId,
        title: string(tool.title) ?? "Tool approval",
        description: string(tool.kind) ?? "Grok requests permission to continue.",
        payload: jsonText(tool.rawInput),
        options,
        purpose: "tool",
      },
    });
  }

  private handlePlanApproval(rpcId: RpcId, paramsValue: unknown) {
    const params = record(paramsValue) ?? {};
    const sessionId = string(params.sessionId);
    if (!sessionId) {
      void this.sendRaw({ jsonrpc: "2.0", id: rpcId, result: { outcome: "abandoned" } });
      return;
    }
    const toolCallId = string(params.toolCallId) ?? uid();
    const blockId = `plan-approval-${toolCallId}`;
    this.interactions.set(blockId, {
      rpcId,
      sessionId,
      blockId,
      kind: "plan",
      optionIds: {},
    });
    this.emit({
      type: "permission_request",
      sessionId,
      blockId,
      req: {
        id: String(rpcId),
        toolCallId,
        title: "Approve execution plan",
        description: "Grok has finished planning and is waiting to enter agent mode.",
        payload: string(params.planContent),
        options: ["allow_once", "deny"],
        purpose: "plan",
      },
    });
  }

  private handleQuestion(rpcId: RpcId, paramsValue: unknown) {
    const params = record(paramsValue) ?? {};
    const sessionId = string(params.sessionId);
    const toolCallId = string(params.toolCallId) ?? uid();
    const questions: QuestionItem[] = [];
    for (const value of array(params.questions)) {
      const question = record(value);
      const prompt = string(question?.question);
      if (!question || !prompt) continue;
      const options: QuestionItem["options"] = [];
      for (const optionValue of array(question.options)) {
        const option = record(optionValue);
        const label = string(option?.label);
        if (!option || !label) continue;
        const preview = string(option.preview);
        options.push({
          label,
          description: string(option.description) ?? "",
          ...(preview ? { preview } : {}),
        });
      }
      questions.push({
        question: prompt,
        multiSelect: question.multiSelect === true || question.multi_select === true,
        options,
      });
    }

    if (!sessionId || questions.length === 0) {
      void this.sendRaw({ jsonrpc: "2.0", id: rpcId, result: { outcome: "cancelled" } });
      return;
    }

    const blockId = `question-${toolCallId}`;
    this.interactions.set(blockId, {
      rpcId,
      sessionId,
      blockId,
      kind: "question",
      optionIds: {},
      questions,
    });
    this.emit({
      type: "question_request",
      sessionId,
      blockId,
      req: {
        id: String(rpcId),
        toolCallId,
        questions,
        mode: string(params.mode) === "plan" ? "plan" : "default",
      },
    });
  }

  private async sendRaw(message: JsonRpcMessage): Promise<void> {
    await invoke("acp_send", { line: JSON.stringify(message) });
  }

  private requestRaw(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeoutId = timeoutMs > 0
        ? window.setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            pending.reject(new Error(`Grok Agent 请求超时：${method}`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, method, timeoutId });
      void this.sendRaw({ jsonrpc: "2.0", id, method: wireMethod(method), params }).catch((cause) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
  }

  private async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    await this.ready;
    return this.requestRaw(method, params, timeoutMs);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.ready;
    await this.sendRaw({ jsonrpc: "2.0", method: wireMethod(method), params });
  }

  private captureModelState(responseValue: unknown) {
    const response = record(responseValue);
    const meta = record(response?._meta);
    const state =
      record(response?.models) ??
      record(meta?.modelState) ??
      (response?.availableModels !== undefined ? response : undefined);
    if (!state) return;
    const models = array(state.availableModels)
      .map((value) => {
        const model = record(value);
        const id = string(model?.modelId);
        if (!model || !id) return undefined;
        return {
          id,
          label: string(model.name) ?? id,
          tagline: string(model.description) ?? "Available through Grok Agent",
        };
      })
      .filter((model): model is ModelState["models"][number] => Boolean(model));
    const currentId = string(state.currentModelId) ?? this.modelState.currentId;
    this.modelState = {
      models: models.length > 0 ? models : this.modelState.models,
      currentId,
    };
    this.emit({ type: "model_state", state: this.modelState });
  }

  private metaFromRow(rowValue: unknown, fallbackCwd = this.workspace): SessionMeta | undefined {
    const row = record(rowValue);
    const id = string(row?.sessionId);
    if (!row || !id) return undefined;
    const title =
      string(row.title) ??
      string(row.summary) ??
      string(row.firstPrompt) ??
      "Untitled mission";
    return {
      id,
      title,
      cwd: string(row.cwd) ?? fallbackCwd,
      createdAt: parseTimestamp(row.createdAt),
      updatedAt: parseTimestamp(row.lastActiveAt ?? row.updatedAt),
      model: string(row.modelId) ?? "grok-build",
      parentId: string(row.parentSessionId),
    };
  }

  async getAuthState(): Promise<AuthState> {
    await this.ready;
    return { ...this.authState };
  }

  async getModelState(): Promise<ModelState> {
    await this.ready;
    return { ...this.modelState, models: [...this.modelState.models] };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    localStorage.setItem("grok.permissionMode", mode);
    void this.notify("x.ai/yolo_mode_changed", {
      clientIdentifier: "grok-desktop",
      permission_mode:
        mode === "bypass" ? "always-approve" : mode === "auto" ? "auto" : "default",
      yolo_mode: mode === "bypass",
      auto_mode: mode === "auto",
    }).catch((error) => {
      for (const sessionId of this.knownSessions) {
        this.emit({ type: "error", sessionId, message: errorText(error) });
      }
    });
  }

  private sessionPermissionMeta() {
    return {
      clientIdentifier: "grok-desktop",
      yoloMode: this.permissionMode === "bypass",
      autoMode: this.permissionMode === "auto",
    };
  }

  private async sessionMeta(cwd: string) {
    const cached = this.sessionMetaCache.get(cwd);
    if (cached && cached.expires > Date.now()) {
      // Permission flags may change from the composer; always merge live flags.
      return { ...cached.value, ...this.sessionPermissionMeta() };
    }
    let systemPromptOverride: string | undefined;
    try {
      const documents = await invoke<ConfigDocument[]>("read_config_documents", { cwd });
      systemPromptOverride = documents
        .find((document) => document.id === "system-prompt")
        ?.content.trim();
    } catch {
      // A missing optional prompt document must never block session creation.
    }
    const base = {
      ...(systemPromptOverride ? { systemPromptOverride } : {}),
    };
    this.sessionMetaCache.set(cwd, { expires: Date.now() + 60_000, value: base });
    return {
      ...base,
      ...this.sessionPermissionMeta(),
    };
  }

  async authenticate(): Promise<void> {
    await this.ready;
    if (!this.authMethodId) throw new Error("Grok Agent 没有可用的交互认证方式");
    if (this.authState.inProgress) return;
    this.setAuthState({ required: true, inProgress: true, error: undefined });
    const requestSeq = Date.now();
    try {
      const auth = this.requestRaw("authenticate", {
        methodId: this.authMethodId,
        _meta: { use_oauth: true, force_interactive: true, request_seq: requestSeq },
      }, 5 * 60_000).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      let authUrl: string | undefined;
      for (let attempt = 0; attempt < 60 && !authUrl; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        const urlResponse = record(await this.requestRaw("x.ai/auth/get_url", {}));
        authUrl = string(urlResponse?.auth_url) ?? string(urlResponse?.authUrl);
      }
      if (!authUrl) throw new Error("Grok Agent 未返回登录链接，请重试");
      if (!isAllowedOAuthUrl(authUrl)) {
        throw new Error("登录链接域名不受信任，已拒绝打开浏览器");
      }
      await invoke("open_external", { url: authUrl });
      const authResult = await auth;
      if (authResult.error) throw authResult.error;
      this.setAuthState({ required: false, inProgress: false, error: undefined });
    } catch (error) {
      void this.requestRaw("x.ai/auth/cancel", { request_seq: requestSeq }).catch(() => {});
      this.setAuthState({ required: true, inProgress: false, error: errorText(error) });
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.callExtension("x.ai/auth/logout", {});
    await invoke("configure_provider", { request: { kind: "oauth" } });
    await this.restartAgent();
  }

  async getAccountInfo(): Promise<AccountInfo> {
    await this.ready;
    let authInfo: JsonObject = {};
    let subscription: JsonObject = {};
    try {
      authInfo = record(await this.requestRaw("x.ai/auth/info", {})) ?? {};
    } catch {
      // API-key and unauthenticated deployments may not expose profile data.
    }
    try {
      subscription = record(await this.requestRaw("x.ai/auth/check_subscription", {})) ?? {};
    } catch {
      // Subscription metadata is OAuth-only.
    }
    const meta = record(subscription.meta) ?? {};
    return {
      authenticated: Boolean(subscription.authenticated) || !this.authState.required,
      methodId: string(authInfo.methodId),
      email: string(authInfo.email) ?? string(meta.email),
      firstName: string(authInfo.firstName),
      lastName: string(authInfo.lastName),
      profileImageUrl: string(authInfo.profileImageUrl),
      teamName: string(authInfo.teamName) ?? string(meta.team_name),
      organizationName: string(authInfo.organizationName),
      subscriptionTier: string(meta.subscription_tier) ?? string(meta.subscriptionTier),
    };
  }

  async getBillingInfo(): Promise<BillingInfo> {
    const raw = record(await this.callExtension<unknown>("x.ai/billing", {})) ?? {};
    const config = record(raw.config) ?? raw;
    const period = record(config.currentPeriod) ?? record(config.current_period) ?? {};
    return {
      subscriptionTier: string(raw.subscriptionTier) ?? string(raw.subscription_tier),
      creditUsagePercent: number(config.creditUsagePercent) ?? number(config.credit_usage_percent),
      periodType: string(period.type),
      periodStart: string(period.start),
      periodEnd: string(period.end),
      onDemandEnabled: Boolean(raw.onDemandEnabled ?? raw.on_demand_enabled),
      onDemandCap: number(config.onDemandCap) ?? number(config.on_demand_cap),
      onDemandUsed: number(config.onDemandUsed) ?? number(config.on_demand_used),
      prepaidBalance: number(config.prepaidBalance) ?? number(config.prepaid_balance),
    };
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    return invoke<ProviderStatus>("read_provider_status");
  }

  async configureProvider(config: ProviderConfig): Promise<void> {
    await invoke("configure_provider", { request: config });
    await this.restartAgent();
    if (config.kind === "oauth" && this.authState.required) await this.authenticate();
  }

  async listProviderProfiles(): Promise<ProviderProfilesState> {
    return invoke<ProviderProfilesState>("list_provider_profiles");
  }

  async saveProviderProfile(config: SaveProviderProfile): Promise<ProviderProfileSummary> {
    return invoke<ProviderProfileSummary>("save_provider_profile", { request: config });
  }

  async refreshProviderModels(id: string): Promise<ProviderProfileSummary> {
    return invoke<ProviderProfileSummary>("refresh_provider_models", { id });
  }

  async activateProviderProfile(id: string): Promise<void> {
    await invoke("activate_provider_profile", { id });
    await this.restartAgent();
  }

  async setSessionMode(sessionId: string, mode: AgentMode): Promise<void> {
    await this.requestRaw(ACP_METHODS.sessionSetMode, {
      sessionId,
      modeId: mode === "agent" ? "default" : mode,
    });
    const current = this.sessionOptions.get(sessionId);
    if (current) this.sessionOptions.set(sessionId, { ...current, mode });
  }

  async deleteProviderProfile(id: string): Promise<void> {
    const active = (await this.listProviderProfiles()).activeId === id;
    // Persist the deletion first so a failed agent reconnect cannot leave a
    // tombstoned profile stuck in the UI as if nothing changed.
    await invoke("delete_provider_profile", { id });
    if (active) {
      try {
        await this.restartAgent();
      } catch (error) {
        // Profile is already gone from disk; surface reconnect issues separately.
        console.warn("provider deleted, agent restart failed", error);
      }
    }
  }

  async readConfigDocuments(cwd: string): Promise<ConfigDocument[]> {
    return invoke<ConfigDocument[]>("read_config_documents", { cwd });
  }

  async writeConfigDocument(document: ConfigDocument): Promise<ConfigDocument> {
    return invoke<ConfigDocument>("write_config_document", {
      request: { id: document.id, cwd: this.workspace, content: document.content },
    });
  }

  async callExtension<T>(method: string, params: unknown = {}): Promise<T> {
    if (!method.startsWith("x.ai/")) throw new Error("只允许调用 x.ai 扩展");
    return (await this.request(method, params)) as T;
  }

  async getWorkspace(): Promise<string> {
    await this.ready;
    return this.workspace;
  }

  async setWorkspace(cwd: string): Promise<void> {
    await this.ready;
    const validated = await invoke<string>("validate_workspace", { cwd });
    this.workspace = validated;
    localStorage.setItem("grok.workspace", validated);
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const collected = new Map<string, SessionMeta>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const responseValue = await this.request(ACP_METHODS.sessionList, {
        ...(cwd ? { cwd } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
        _meta: { "x.ai/facetFilters": { kind: ["build"] } },
      });
      const response = record(responseValue);
      for (const row of array(response?.sessions)) {
        const meta = this.metaFromRow(row, cwd ?? this.workspace);
        if (meta) collected.set(meta.id, meta);
      }
      cursor = string(response?.nextCursor);
      if (!cursor) break;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    const sessions = [...collected.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const meta of sessions) this.catalogue.set(meta.id, meta);
    return sessions;
  }

  async newSession(cwd: string): Promise<string> {
    const metaRequest = await this.sessionMeta(cwd);
    const preferredModel = localStorage.getItem("grok.model")?.trim();
    // Soft-fail when CU opt-in is off: empty MCP/plugin lists, session still creates.
    const computer = await this.invokeComputerSessionExtensions();
    let responseValue: unknown;
    let attachedComputer = computer.mcpServers.length > 0 || computer.pluginDirs.length > 0;
    try {
      responseValue = await this.request(ACP_METHODS.sessionNew, {
        cwd,
        mcpServers: computer.mcpServers,
        _meta: {
          ...metaRequest,
          ...(preferredModel ? { modelId: preferredModel } : {}),
          pluginDirs: computer.pluginDirs,
        },
      });
    } catch (error) {
      // Older Grok CLIs reject Computer Use session extensions — fall back only
      // when we actually tried to attach them (not for unrelated failures).
      if (!attachedComputer) throw error;
      const message = errorText(error).toLowerCase();
      const looksLikeExtensionReject =
        message.includes("mcp") ||
        message.includes("plugin") ||
        message.includes("unknown") ||
        message.includes("invalid") ||
        message.includes("unsupported");
      if (!looksLikeExtensionReject) throw error;
      attachedComputer = false;
      responseValue = await this.request(ACP_METHODS.sessionNew, {
        cwd,
        mcpServers: [],
        _meta: metaRequest,
      });
    }
    const response = record(responseValue);
    const sessionId = string(response?.sessionId);
    if (!sessionId) throw new Error("session/new 未返回 sessionId");
    // Soft-fail CU returns empty MCP — only store a real lease when attached.
    const newLease = attachedComputer ? computerLeaseIfAttached(computer) : null;
    if (newLease) this.computerLeases.set(sessionId, newLease);
    this.captureModelState(response);
    const detail = record(record(response?._meta)?.["x.ai/sessionDetail"]);
    const now = Date.now();
    const meta: SessionMeta = {
      id: sessionId,
      title: string(detail?.title) ?? "Untitled mission",
      cwd,
      createdAt: now,
      updatedAt: now,
      model: string(detail?.modelId) ?? localStorage.getItem("grok.model") ?? "grok-build",
    };
    this.knownSessions.add(sessionId);
    this.catalogue.set(sessionId, meta);
    this.cursors.set(sessionId, { toolBlocks: new Map() });
    this.usage.set(sessionId, { ...EMPTY_USAGE });
    this.emit({ type: "session_ready", session: emptySession(meta) });
    return sessionId;
  }

  async loadSession(
    id: string,
    options?: { background?: boolean; silent?: boolean },
  ): Promise<void> {
    const inflight = this.loadPromises.get(id);
    if (inflight) return inflight;

    // Channel-serialized: at most one load (and no interleaved prompt) at a time.
    const run = this.runOnChannel(() => this.loadSessionInner(id, options)).finally(() => {
      this.loadPromises.delete(id);
    });
    this.loadPromises.set(id, run);
    return run;
  }

  private async loadSessionInner(
    id: string,
    options?: { background?: boolean; silent?: boolean },
  ): Promise<void> {
    const background = options?.background === true;
    // Silent agent-bind: CLI rehydrates context; UI keeps offline disk history.
    const silentBind = options?.silent === true;
    let meta = this.catalogue.get(id);
    if (!meta) {
      // Expensive: paginated x.ai/session/list. Prefer rememberSessionMeta() first.
      await this.listSessions();
      meta = this.catalogue.get(id);
    }
    if (!meta) throw new Error(`找不到会话：${id}`);

    // Foreground non-silent: paint empty shell. Background/silent: keep UI.
    if (!background && !silentBind) {
      this.emit({ type: "session_ready", session: emptySession(meta) });
    }

    this.cursors.set(id, { toolBlocks: new Map() });
    this.replaying.set(id, emptySession(meta));
    if (silentBind) {
      this.silentReplaying.add(id);
      await this.setSilentStream(true, id);
    } else if (!background) {
      this.progressiveLoad.add(id);
    }

    try {
      const metaRequest = await this.sessionMeta(meta.cwd);
      // Silent/background loads are for offline history + first-send bind only.
      // Starting Computer Use MCP there leaks localhost listeners on every visit
      // and adds bind latency that fights the offline-history path.
      const attachComputer = !silentBind && !background;
      let computer: ComputerSessionExtensions | null = null;
      if (attachComputer) {
        computer = await this.invokeComputerSessionExtensions();
      }
      // Large sessions can take several minutes for the agent to rehydrate.
      let response: unknown;
      if (computer && (computer.mcpServers.length > 0 || computer.pluginDirs.length > 0)) {
        try {
          response = await this.request(
            ACP_METHODS.sessionLoad,
            {
              sessionId: id,
              cwd: meta.cwd,
              mcpServers: computer.mcpServers,
              _meta: { ...metaRequest, pluginDirs: computer.pluginDirs },
            },
            2 * 60_000,
          );
        } catch (error) {
          // Older CLIs may reject Computer Use extensions — retry bare load.
          const message = errorText(error).toLowerCase();
          const looksLikeExtensionReject =
            message.includes("mcp") ||
            message.includes("plugin") ||
            message.includes("unknown") ||
            message.includes("invalid") ||
            message.includes("unsupported");
          if (!looksLikeExtensionReject) throw error;
          response = await this.request(
            ACP_METHODS.sessionLoad,
            {
              sessionId: id,
              cwd: meta.cwd,
              mcpServers: [],
              _meta: metaRequest,
            },
            2 * 60_000,
          );
          computer = null;
        }
      } else {
        response = await this.request(
          ACP_METHODS.sessionLoad,
          {
            sessionId: id,
            cwd: meta.cwd,
            mcpServers: [],
            _meta: metaRequest,
          },
          // Silent first-send bind: 5 min cap (was 10) so hung loads surface sooner;
          // large transcripts still fit; store restores draft on timeout.
          silentBind ? 5 * 60_000 : 2 * 60_000,
        );
      }
      // Soft-fail CU (opt-in off) returns non-null computer with empty lists —
      // must NOT write computerLeases or ensureComputerAttachedForPrompt short-circuits.
      const loadLease = computerLeaseIfAttached(computer);
      if (loadLease) {
        const previousLease = this.computerLeases.get(id);
        if (previousLease && previousLease !== loadLease) {
          await invoke("computer_clear_emergency_stop", { leaseId: previousLease }).catch(
            () => {},
          );
        }
        this.computerLeases.set(id, loadLease);
      }
      this.flushStreamAppends(id);
      this.flushToolPatches(id);
      this.captureModelState(response);
      void this.refreshSessionInfo(id).catch(() => {
        /* non-fatal */
      });

      const replayed = this.replaying.get(id) ?? emptySession(meta);
      this.clearProgressiveLoad(id);
      this.replaying.delete(id);
      this.silentReplaying.delete(id);
      this.knownSessions.add(id);
      await this.setSilentStream(false, id);

      if (silentBind) {
        // Bound for prompt; do not overwrite offline disk history with empty replay.
        return;
      }

      const finalized: Session = {
        ...replayed,
        usage: this.usage.get(id) ?? replayed.usage,
        status: "idle",
        blocks: replayed.blocks.map((block) =>
          block.type === "assistant"
            ? { ...block, streaming: false }
            : block.type === "thinking"
              ? { ...block, live: false }
              : block,
        ),
      };
      this.emit({ type: "session_ready", session: finalized });
    } catch (error) {
      this.clearProgressiveLoad(id);
      this.replaying.delete(id);
      this.silentReplaying.delete(id);
      await this.setSilentStream(false, id);
      throw error;
    }
  }

  async interject(sessionId: string, text: string, options: PromptOptions): Promise<InterjectResult> {
    await this.ready;
    // Do not optimistically mark bound — only session/new or successful session/load.
    const trimmed = text.trim();
    // Computer attach must be channel-serialized (silent filter is session-scoped).
    // The interject RPC itself must NOT wait behind an in-flight session/prompt
    // (that would block mid-turn 插话 until the turn ends — R3 regression).
    // Always enter ensure on Computer intent — even with an existing lease —
    // so opt-in OFF can revoke stale MCP (R4A-CU-01). Refuse aborts the turn (CU-02).
    if (this.promptRequestsComputer(trimmed)) {
      const cu = await this.runOnChannel(() =>
        this.ensureComputerAttachedForPrompt(sessionId, trimmed),
      );
      if (cu === "refused") {
        return {
          state: "refused",
          message: COMPUTER_USE_OPT_IN_REFUSE_MESSAGE,
          fallback: false,
        };
      }
    }
    const interjectionId = crypto.randomUUID();
    const content = promptContent(trimmed, options.attachments ?? []);
    try {
      await this.request(
        "x.ai/interject",
        {
          sessionId,
          text: trimmed,
          interjectionId,
          content,
        },
        30_000,
      );
      this.emit({
        type: "block_add",
        sessionId,
        block: {
          type: "user",
          id: interjectionId,
          text: trimmed,
          attachments: (options.attachments ?? []).map(({ id, kind, name, mime, size, data, path }) => ({
            id,
            kind,
            name,
            mime,
            size,
            ...(kind === "image" && data ? { data } : {}),
            ...(kind === "path" && path ? { path } : {}),
          })),
          ts: Date.now(),
        },
      });
      return {
        state: "interjected",
        message: "插话已提交到当前回合",
        fallback: false,
        entryId: interjectionId,
      };
    } catch (error) {
      if (isMethodUnavailable(error)) {
        return {
          state: "queued_head",
          message: "当前 CLI 不支持即时插话，已降级为队首排队",
          fallback: true,
          entryId: interjectionId,
        };
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async enqueuePrompt(
    sessionId: string,
    text: string,
    options: PromptOptions,
    queueOptions: { promptId?: string; sendNow?: boolean } = {},
  ): Promise<QueueOperationReceipt> {
    await this.ready;
    const trimmed = text.trim();
    const promptId = queueOptions.promptId ?? uid();
    const sendNow = queueOptions.sendNow === true;
    const content = promptContent(trimmed, options.attachments ?? []);

    // Must not race silent bind: serialize behind the same channel as load/prompt.
    // Await the wire write so callers keep `source: local` on failure (R7).
    try {
      await this.runOnChannel(async () => {
        await this.requestRaw(
          ACP_METHODS.sessionPrompt,
          {
            sessionId,
            prompt: content,
            _meta: {
              promptId,
              sendNow,
              clientIdentifier: "grox-desktop",
            },
          },
          1_800_000,
        );
      });
    } catch (error) {
      this.emit({
        type: "error",
        sessionId,
        message: `队列消息失败：${errorText(error)}`,
      });
      throw error instanceof Error ? error : new Error(errorText(error));
    }

    return {
      operationId: uid(),
      entryId: promptId,
      state: sendNow ? "interjected" : "queued",
      message: sendNow ? "插话已置顶并提交到 CLI 队列" : "消息已提交到 CLI 队列",
      fallback: false,
    };
  }

  async editQueuedPrompt(sessionId: string, id: string, text: string): Promise<QueueOperationReceipt> {
    this.queueNotify("x.ai/queue/edit", sessionId, { id, newText: text });
    return {
      operationId: uid(),
      entryId: id,
      state: "updated",
      message: "编辑已提交，等待 CLI 确认",
    };
  }

  async removeQueuedPrompt(
    sessionId: string,
    id: string,
    version = 0,
  ): Promise<QueueOperationReceipt> {
    this.queueNotify("x.ai/queue/remove", sessionId, { id, expectedVersion: version });
    return {
      operationId: uid(),
      entryId: id,
      state: "removed",
      message: "队列消息已移除",
    };
  }

  async reorderQueuedPrompt(sessionId: string, orderedIds: string[]): Promise<QueueOperationReceipt> {
    this.queueNotify("x.ai/queue/reorder", sessionId, { orderedIds });
    return {
      operationId: uid(),
      state: "reordered",
      message: "队列顺序已更新",
    };
  }

  async clearQueuedPrompts(sessionId: string): Promise<QueueOperationReceipt> {
    this.queueNotify("x.ai/queue/clear", sessionId, {});
    this.cliQueues.set(sessionId, []);
    return {
      operationId: uid(),
      state: "cleared",
      message: "等待队列已清空",
    };
  }

  async interjectQueuedPrompt(
    sessionId: string,
    id: string,
    options: { text?: string; version?: number } = {},
  ): Promise<QueueOperationReceipt> {
    this.queueNotify("x.ai/queue/interject", sessionId, {
      id,
      expectedVersion: options.version ?? 0,
      ...(options.text?.trim() ? { newText: options.text.trim() } : {}),
    });
    return {
      operationId: uid(),
      entryId: id,
      state: "interjected",
      message: "插话请求已提交；若 CLI 不支持即时插话，将按队首消息处理",
    };
  }

  async prompt(sessionId: string, text: string, options: PromptOptions): Promise<void> {
    await this.ready;
    // Channel-serialized with session/load so silent bind cannot overlap live turns.
    return this.runOnChannel(() => this.promptInner(sessionId, text, options));
  }

  private async promptInner(sessionId: string, text: string, options: PromptOptions): Promise<void> {
    this.closeUser(sessionId);
    // Fresh turn: drop retry/replace state so a prior interrupted stream cannot
    // hijack the next reply into the old bubble.
    this.resetTurnRetryState(this.cursor(sessionId));
    this.cursor(sessionId).assistantId = undefined;
    this.cursor(sessionId).thinkingId = undefined;
    this.cursor(sessionId).thinkingStartedAt = undefined;
    this.cursor(sessionId).planId = undefined;
    this.emit({ type: "status", sessionId, status: "running" });
    try {
      // Silent-bound sessions skip Computer MCP at load time; attach once when
      // the operator's prompt explicitly needs desktop control.
      // Refuse (opt-in off) aborts the turn — do not session/prompt (R4A-CU-02).
      const cu = await this.ensureComputerAttachedForPrompt(sessionId, text);
      if (cu === "refused") {
        // Throw so store can restore draft + pop optimistic bubble (busy-queue parity).
        throw new Error(COMPUTER_USE_OPT_IN_REFUSE_MESSAGE);
      }
      const previous = this.sessionOptions.get(sessionId);
      if (!previous || previous.model !== options.model || previous.effort !== options.effort) {
        await this.requestRaw(ACP_METHODS.sessionSetModel, {
          sessionId,
          modelId: options.model,
          _meta: { reasoningEffort: options.effort },
        });
      }
      if (!previous || previous.mode !== options.mode) {
        await this.requestRaw(ACP_METHODS.sessionSetMode, {
          sessionId,
          modeId: options.mode === "agent" ? "default" : options.mode,
        });
      }
      this.sessionOptions.set(sessionId, {
        model: options.model,
        effort: options.effort,
        mode: options.mode,
      });

      const responseValue = await this.requestRaw(ACP_METHODS.sessionPrompt, {
        sessionId,
        prompt: promptContent(text, options.attachments ?? []),
      }, 0);
      const response = record(responseValue);
      const meta = record(response?._meta);
      const promptUsage = record(meta?.usage);
      if (promptUsage) this.emitUsage(sessionId, promptUsage);
      await this.refreshSessionInfo(sessionId);
    } catch (error) {
      const detail = errorText(error);
      this.emit({ type: "error", sessionId, message: detail });
      // Propagate CU refuse so the store restores composer draft + pops the
      // optimistic user bubble (mirrors busy-queue CU refuse path).
      if (
        detail === COMPUTER_USE_OPT_IN_REFUSE_MESSAGE
        || /computer\s*use|GROX_COMPUTER_USE|未启用/i.test(detail)
      ) {
        throw error instanceof Error ? error : new Error(detail);
      }
    } finally {
      this.finishTurn(sessionId);
    }
  }

  cancel(sessionId: string): void {
    for (const [blockId, interaction] of this.interactions) {
      if (interaction.sessionId !== sessionId) continue;
      this.interactions.delete(blockId);
      const result =
        interaction.kind === "permission"
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: "cancelled" };
      void this.sendRaw({ jsonrpc: "2.0", id: interaction.rpcId, result });
    }
    void this.notify(ACP_METHODS.sessionCancel, {
      sessionId,
      _meta: { trigger: "user", cancelSubagents: true },
    }).catch((error) => {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    });
  }

  async compact(sessionId: string): Promise<void> {
    try {
      await this.request(ACP_METHODS.compact, { sessionId });
      this.emit({
        type: "block_add",
        sessionId,
        block: {
          type: "system",
          id: uid(),
          text: "CONTEXT COMPACTED",
          ts: Date.now(),
          kind: "compact",
        },
      });
      await this.refreshSessionInfo(sessionId);
    } catch (error) {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    }
  }

  async listRewindPoints(sessionId: string): Promise<RewindPoint[]> {
    const response = record(await this.callExtension<unknown>("x.ai/rewind/points", { session_id: sessionId }));
    return array(response?.rewind_points) as RewindPoint[];
  }

  async rewind(sessionId: string, targetPromptIndex: number, mode: RewindMode, force: boolean): Promise<RewindResult> {
    return this.callExtension<RewindResult>("x.ai/rewind/execute", {
      session_id: sessionId,
      target_prompt_index: targetPromptIndex,
      force,
      mode,
    });
  }

  respondPermission(
    sessionId: string,
    blockId: string,
    option: PermissionOption,
    feedback?: string,
  ): { duplicate: boolean; message?: string } {
    const priorByBlock = this.resolvedPlanByBlock.get(blockId);
    if (priorByBlock) {
      this.emit({ type: "permission_resolved", sessionId, blockId, option: priorByBlock });
      return { duplicate: true, message: "该计划决策已经提交，未重复执行" };
    }

    const pending = this.interactions.get(blockId);
    if (!pending || pending.sessionId !== sessionId) {
      return { duplicate: true, message: "该请求已处理" };
    }

    if (pending.kind === "plan") {
      const key = `${sessionId}:${String(pending.rpcId)}`;
      const prior = this.resolvedPlanDecisions.get(key);
      if (prior) {
        this.interactions.delete(blockId);
        this.resolvedPlanByBlock.set(blockId, prior);
        this.emit({ type: "permission_resolved", sessionId, blockId, option: prior });
        return { duplicate: true, message: "该计划决策已经提交，未重复执行" };
      }
      this.resolvedPlanDecisions.set(key, option);
      this.resolvedPlanByBlock.set(blockId, option);
      while (this.resolvedPlanDecisions.size > 128) {
        const oldest = this.resolvedPlanDecisions.keys().next().value;
        if (oldest === undefined) break;
        this.resolvedPlanDecisions.delete(oldest);
      }
      while (this.resolvedPlanByBlock.size > 128) {
        const oldest = this.resolvedPlanByBlock.keys().next().value;
        if (oldest === undefined) break;
        this.resolvedPlanByBlock.delete(oldest);
      }
    }

    this.interactions.delete(blockId);

    let result: unknown;
    if (pending.kind === "plan") {
      // Answer the original x.ai/exit_plan_mode request only — never invent a
      // synthetic "[Plan approved]" user prompt that would spawn a second turn.
      result = {
        outcome: option === "deny" ? "cancelled" : "approved",
        ...(option === "deny" && feedback?.trim() ? { feedback: feedback.trim() } : {}),
      };
    } else {
      const optionId = pending.optionIds[option];
      result = optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    void this.sendRaw({ jsonrpc: "2.0", id: pending.rpcId, result }).catch((error) => {
      // Roll back the lock so the operator can retry if the wire write failed.
      if (pending.kind === "plan") {
        this.resolvedPlanDecisions.delete(`${sessionId}:${String(pending.rpcId)}`);
        this.resolvedPlanByBlock.delete(blockId);
      }
      this.emit({ type: "error", sessionId, message: errorText(error) });
    });
    this.emit({ type: "permission_resolved", sessionId, blockId, option });
    return { duplicate: false };
  }

  respondQuestion(sessionId: string, blockId: string, response: QuestionResponse): void {
    const pending = this.interactions.get(blockId);
    if (!pending || pending.sessionId !== sessionId || pending.kind !== "question") return;
    this.interactions.delete(blockId);

    let result: unknown;
    if (response.outcome === "accepted") {
      const annotations: Record<string, { preview?: string; notes?: string }> = {};
      for (const question of pending.questions ?? []) {
        const selected = response.answers[question.question] ?? [];
        const preview = question.multiSelect
          ? undefined
          : question.options.find((option) => option.label === selected[0])?.preview;
        const notes = response.notes[question.question]?.trim() || undefined;
        if (preview || notes) annotations[question.question] = { preview, notes };
      }
      result = {
        outcome: "accepted",
        answers: response.answers,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      };
    } else if (response.outcome === "cancelled") {
      result = { outcome: "cancelled" };
    } else {
      result = { outcome: response.outcome, partial_answers: response.partialAnswers };
    }

    void this.sendRaw({ jsonrpc: "2.0", id: pending.rpcId, result }).catch((error) => {
      this.emit({ type: "error", sessionId, message: errorText(error) });
    });
    this.emit({ type: "question_resolved", sessionId, blockId, response });
  }

  async renameSession(id: string, title: string): Promise<void> {
    const meta = this.catalogue.get(id);
    await this.request(ACP_METHODS.sessionRename, {
      sessionId: id,
      title,
      cwd: meta?.cwd ?? this.workspace,
      kind: "build",
    });
    if (meta) this.catalogue.set(id, { ...meta, title });
  }

  async deleteSession(id: string): Promise<void> {
    const meta = this.catalogue.get(id);
    this.cancel(id);
    const computerLease = this.computerLeases.get(id);
    // Sticky-stop this lease then revoke process-wide bearer. Fail-closed: still
    // attempt revoke even if mark fails.
    if (computerLease) {
      try {
        await invoke("computer_emergency_stop", { leaseId: computerLease });
      } catch {
        await invoke("computer_revoke_http_auth").catch(() => {});
      }
    }
    await this.request(ACP_METHODS.sessionDelete, {
      sessionId: id,
      cwd: meta?.cwd ?? this.workspace,
      kind: "build",
    });
    this.catalogue.delete(id);
    this.computerLeases.delete(id);
    this.activeComputerSessions.delete(id);
    for (const key of this.activeComputerToolCalls) {
      if (key.startsWith(`${id}:`)) this.activeComputerToolCalls.delete(key);
    }
    this.knownSessions.delete(id);
    this.cursors.delete(id);
    this.usage.delete(id);
    // Drop inflight load so a late loadSessionInner cannot re-bind a deleted id.
    this.loadPromises.delete(id);
    this.silentReplaying.delete(id);
    this.replaying.delete(id);
    this.sessionOptions.delete(id);
    this.cliQueues.delete(id);
    void this.setSilentStream(false, id);
  }

  async emergencyStopComputer(sessionId: string): Promise<void> {
    const leaseId = this.computerLeases.get(sessionId);
    try {
      if (leaseId) {
        await invoke("computer_emergency_stop", { leaseId });
      }
    } finally {
      // Always cancel the turn even if invoke fails (hotkey fail-closed).
      this.cancel(sessionId);
    }
  }

  /**
   * Settings opt-out: revoke every lease + process-wide MCP bearer so
   * disable-after-attach cannot leave desktop control live (R4A-CU-01).
   */
  async revokeComputerUseCapability(): Promise<void> {
    const sessionIds = [...this.computerLeases.keys()];
    for (const sessionId of sessionIds) {
      await this.revokeComputerLease(sessionId);
    }
    this.computerLeases.clear();
    this.activeComputerSessions.clear();
    this.activeComputerToolCalls.clear();
    await invoke("computer_revoke_http_auth").catch(() => {});
  }

  /** Public wrapper for busy-queue CU gating (store enqueue path). */
  async prepareComputerForPrompt(
    sessionId: string,
    text: string,
  ): Promise<"ok" | "refused"> {
    return this.ensureComputerAttachedForPrompt(sessionId, text);
  }

  /** Drop one session lease and sticky-stop / revoke its MCP surface. */
  private async revokeComputerLease(sessionId: string): Promise<void> {
    const leaseId = this.computerLeases.get(sessionId);
    this.computerLeases.delete(sessionId);
    this.activeComputerSessions.delete(sessionId);
    for (const key of [...this.activeComputerToolCalls]) {
      if (key.startsWith(`${sessionId}:`)) this.activeComputerToolCalls.delete(key);
    }
    if (leaseId) {
      try {
        await invoke("computer_emergency_stop", { leaseId });
      } catch {
        await invoke("computer_revoke_http_auth").catch(() => {});
      }
    }
  }

  /**
   * Explicit Computer Use intent in the operator prompt (slash, @-mention, or
   * common CN/EN phrases). Silent loads intentionally skip MCP; attach only
   * when these fire so offline first-send stays cheap.
   */
  private promptRequestsComputer(text: string): boolean {
    const raw = text.trim();
    if (!raw) return false;
    if (/^\/computer(?:\s|$)/i.test(raw)) return true;
    if (/(^|[\s,，])@computer(?:\b|$)/i.test(raw)) return true;
    if (/\bcomputer\s*use\b/i.test(raw)) return true;
    if (/电脑控制|桌面控制|屏幕控制|Computer\s*Use/i.test(raw)) return true;
    return false;
  }

  /** Pull GROX_COMPUTER_USE from the host process into the FE opt-in helper. */
  private async refreshComputerUseHostEnv(): Promise<void> {
    try {
      const on = await invoke<boolean>("computer_use_env_enabled_cmd");
      setComputerUseHostEnvEnabled(on === true);
    } catch {
      /* older shells — leave cache unchanged / process.env only */
    }
  }

  /**
   * Secondary attach for sessions that were silent/background-bound without
   * Computer MCP. Re-issues session/load with MCP extensions under the silent
   * stream filter so offline history is not flooded.
   *
   * Re-checks opt-in even when a lease is already mapped (R4A-CU-01).
   * Returns `refused` when opt-in blocks Computer intent so callers abort the
   * turn (R4A-CU-02) instead of still calling session/prompt.
   */
  private async ensureComputerAttachedForPrompt(
    sessionId: string,
    text: string,
  ): Promise<"ok" | "refused"> {
    // Env may have been set after cold start; refresh once per ensure is cheap.
    if (!isComputerUseOperatorEnabled()) {
      await this.refreshComputerUseHostEnv();
    }
    const decision = decideComputerAttachForPrompt({
      requestsComputer: this.promptRequestsComputer(text),
      knownSession: this.knownSessions.has(sessionId),
      optIn: isComputerUseOperatorEnabled(),
      hasActiveLease: hasActiveComputerLease(this.computerLeases, sessionId),
    });
    switch (decision) {
      case "skip":
      case "already_attached":
        return "ok";
      case "refuse_opt_in":
        this.emit({
          type: "error",
          sessionId,
          message: COMPUTER_USE_OPT_IN_REFUSE_MESSAGE,
        });
        return "refused";
      case "revoke_stale_and_refuse":
        await this.revokeComputerLease(sessionId);
        // Process-wide bearer may still be live for other sessions; if this
        // was the last lease, revoke. Always best-effort revoke after opt-out
        // path so a single-session app cannot leave MCP open.
        if (this.computerLeases.size === 0) {
          await invoke("computer_revoke_http_auth").catch(() => {});
        }
        this.emit({
          type: "error",
          sessionId,
          message: COMPUTER_USE_OPT_IN_REFUSE_MESSAGE,
        });
        return "refused";
      case "attach":
        await this.attachComputerMcp(sessionId);
        return "ok";
    }
  }

  private async invokeComputerSessionExtensions(): Promise<ComputerSessionExtensions> {
    if (!isComputerUseOperatorEnabled()) {
      await this.refreshComputerUseHostEnv();
    }
    try {
      return await invoke<ComputerSessionExtensions>("computer_session_extensions", {
        operatorEnabled: isComputerUseOperatorEnabled(),
      });
    } catch (error) {
      // Belt-and-braces: older shells hard-Err when CU opt-in is off. Never let
      // that kill session/new for ordinary chat (Home "111" → 连接失败).
      const message = errorText(error);
      if (/computer\s*use|GROX_COMPUTER_USE|未启用/i.test(message)) {
        return { mcpServers: [], pluginDirs: [], leaseId: "" };
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private async attachComputerMcp(sessionId: string): Promise<void> {
    const meta = this.catalogue.get(sessionId);
    if (!meta) {
      throw new Error(`找不到会话，无法附加 Computer Use：${sessionId}`);
    }
    const computer = await this.invokeComputerSessionExtensions();
    const attachLease = computerLeaseIfAttached(computer);
    if (!attachLease) {
      // Soft-fail / non-Windows / harness unavailable — leave turn without MCP.
      return;
    }
    const metaRequest = await this.sessionMeta(meta.cwd);
    this.silentReplaying.add(sessionId);
    await this.setSilentStream(true, sessionId);
    try {
      try {
        await this.request(
          ACP_METHODS.sessionLoad,
          {
            sessionId,
            cwd: meta.cwd,
            mcpServers: computer.mcpServers,
            _meta: { ...metaRequest, pluginDirs: computer.pluginDirs },
          },
          2 * 60_000,
        );
      } catch (error) {
        const message = errorText(error).toLowerCase();
        const looksLikeExtensionReject =
          message.includes("mcp") ||
          message.includes("plugin") ||
          message.includes("unknown") ||
          message.includes("invalid") ||
          message.includes("unsupported");
        if (!looksLikeExtensionReject) throw error;
        // CLI rejected extensions — continue without Computer Use.
        return;
      }
      const previousLease = this.computerLeases.get(sessionId);
      if (previousLease && previousLease !== attachLease) {
        await invoke("computer_clear_emergency_stop", { leaseId: previousLease }).catch(
          () => {},
        );
      }
      // Process-wide MCP bearer rotates on each serve_http — sibling leases are stale.
      for (const sid of [...this.computerLeases.keys()]) {
        if (sid !== sessionId) this.computerLeases.delete(sid);
      }
      this.computerLeases.set(sessionId, attachLease);
      this.emit({
        type: "status",
        sessionId,
        status: "running",
      });
    } finally {
      this.silentReplaying.delete(sessionId);
      await this.setSilentStream(false, sessionId);
    }
  }

  private async refreshSessionInfo(sessionId: string): Promise<void> {
    try {
      const responseValue = await this.requestRaw(ACP_METHODS.sessionInfo, { sessionId });
      const response = record(responseValue);
      const context = record(response?.context);
      const previous = this.usage.get(sessionId) ?? { ...EMPTY_USAGE };
      const next: Usage = {
        ...previous,
        contextUsed: number(context?.used) ?? previous.contextUsed,
        contextMax: number(context?.total) ?? previous.contextMax,
        turns: number(response?.turns) ?? previous.turns,
      };
      this.usage.set(sessionId, next);
      this.emit({ type: "usage", sessionId, usage: next });
    } catch {
      // Older agents may not expose the extension. Prompt usage still works.
    }
  }
}
