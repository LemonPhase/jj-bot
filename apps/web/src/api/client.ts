/**
 * The single seam between the UI and the backend.
 *
 * Every component talks to the backend only through `JJApi` (via `useApi()`),
 * and every value crossing it is a `@jj/contracts` type: the contract types are
 * the view models. `resolveApi()` picks the live backend when `/api/bootstrap`
 * answers `mode: "backend"` with a compatible contract, and the in-memory demo
 * otherwise. Both implementations fold task events with `applyTaskEvent`, so
 * the screens run the same code against either.
 */
import type {
  ApiErrorCode,
  Bootstrap,
  Bot,
  BotMemory,
  Capabilities,
  ConversationMessage,
  ConversationView,
  CreateBotCommand,
  CreateRuntimeProfileCommand,
  CreateTaskCommand,
  ModelsView,
  PostTaskMessageCommand,
  RuntimeProfile,
  SandboxDriverInfo,
  SendBotMessageCommand,
  StopTaskCommand,
  Task,
  TaskMessage,
  TaskSummary,
  TaskView,
  UpdateBotCommand,
  UpdateBotMemoryCommand,
  UpdateRuntimeProfileCommand,
  WorkspaceHint,
} from "@jj/contracts";

export type ApiMode = "demo" | "live";

/** The sidebar mode chip. `Live` is shown only when `mode` is `live`. */
export interface ApiBadge {
  label: "Demo data" | "Live" | "No model configured" | "Scripted model";
  tone: "demo" | "live" | "warning";
  /** Why the chip says what it says; shown as its tooltip. */
  title: string;
}

/**
 * Errors the client raises itself, next to the contract's server codes.
 * `UNRECOGNIZED_ERROR`: the server sent an error envelope with a code this
 * client does not know (a newer server); `message` is still the server's and
 * `serverCode` holds the code as sent.
 */
export type ClientErrorCode =
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "UNRECOGNIZED_ERROR";

/**
 * Every failed call rejects with this. Server failures carry the contract
 * error envelope (`{ error: { code, message, details } }`) unchanged; show
 * `message` verbatim.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly code: ApiErrorCode | ClientErrorCode,
    message: string,
    readonly details?: unknown,
    /** HTTP status, when a response arrived. */
    readonly status?: number,
    /** The envelope's `code` exactly as the server sent it. */
    readonly serverCode?: string,
  ) {
    super(message);
  }
}

export const isApiError = (value: unknown): value is ApiError =>
  value instanceof ApiError;

export type Unsubscribe = () => void;

/** Connection state of a stream subscription, for the "live" indicators. */
export type StreamState = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamOptions {
  onState?: (state: StreamState) => void;
  /**
   * A failed snapshot load or a malformed frame. The subscription keeps
   * trying, except after a task load fails with NOT_FOUND or UNAUTHORIZED
   * (`isTerminalTaskError`), when it stops in the `closed` state.
   */
  onError?: (error: ApiError) => void;
}

export interface HintOptions extends StreamOptions {
  /**
   * The workspace stream (re)connected. It is not resumable, so refetch
   * whatever is on screen. Not called for the first connection.
   */
  onResync?: () => void;
}

export interface JJApi {
  readonly mode: ApiMode;
  readonly badge: ApiBadge;
  /** From bootstrap. Offer only what is reported here. */
  readonly capabilities: Capabilities;
  readonly contractVersion: string;

  /** `GET /api/bootstrap`. */
  bootstrap(): Promise<Bootstrap>;
  /** `GET /api/stream`: what to refetch. One shared connection per client. */
  subscribeHints(
    onHint: (hint: WorkspaceHint) => void,
    options?: HintOptions,
  ): Unsubscribe;

  // Bots
  listBots(): Promise<Bot[]>;
  getBot(botId: string): Promise<Bot>;
  createBot(command: CreateBotCommand): Promise<Bot>;
  updateBot(botId: string, command: UpdateBotCommand): Promise<Bot>;
  /** Rejects with `CONFLICT` while the bot has active tasks. */
  archiveBot(botId: string): Promise<void>;
  getMemory(botId: string): Promise<BotMemory>;
  putMemory(botId: string, command: UpdateBotMemoryCommand): Promise<BotMemory>;

  // Direct chat
  getConversation(botId: string): Promise<ConversationView>;
  /** Resolves with the stored user message; the reply arrives asynchronously. */
  sendBotMessage(
    botId: string,
    command: SendBotMessageCommand,
  ): Promise<ConversationMessage>;
  /** The conversation now, then again after every `conversation.changed` hint for this bot. */
  subscribeConversation(
    botId: string,
    onView: (view: ConversationView) => void,
    options?: StreamOptions,
  ): Unsubscribe;

  // Runtime profiles, drivers and models
  listProfiles(): Promise<RuntimeProfile[]>;
  getProfile(profileId: string): Promise<RuntimeProfile>;
  createProfile(command: CreateRuntimeProfileCommand): Promise<RuntimeProfile>;
  updateProfile(
    profileId: string,
    command: UpdateRuntimeProfileCommand,
  ): Promise<RuntimeProfile>;
  /** Rejects with `PROFILE_IN_USE` while a bot references the profile. */
  deleteProfile(profileId: string): Promise<void>;
  listDrivers(): Promise<SandboxDriverInfo[]>;
  getModels(): Promise<ModelsView>;

  // Tasks
  listTasks(): Promise<TaskSummary[]>;
  createTask(command: CreateTaskCommand): Promise<Task>;
  getTask(taskId: string): Promise<TaskView>;
  /**
   * Every user message steers the coordinator. Pass `goal` with the
   * `observedGoalVersion` on screen to replace the goal; a stale version
   * rejects with `STALE_GOAL_VERSION`.
   */
  postTaskMessage(
    taskId: string,
    command: PostTaskMessageCommand,
  ): Promise<TaskMessage>;
  stopTask(taskId: string, command?: StopTaskCommand): Promise<Task>;
  /**
   * The task snapshot, then every task event folded onto it with
   * `applyTaskEvent`. Resumes from the last sequence on reconnect, never
   * delivers an event twice, and ignores event types it does not know.
   */
  subscribeTask(
    taskId: string,
    onView: (view: TaskView) => void,
    options?: StreamOptions,
  ): Unsubscribe;
  /** Where an artifact's content downloads from. */
  artifactUrl(taskId: string, artifactId: string): string;
  /**
   * Present when requests need an `Authorization` header (an API token is
   * configured), which a plain link cannot send: fetch the content instead.
   */
  fetchArtifact?(taskId: string, artifactId: string): Promise<Blob>;

  /** Demo only: run the next scripted step of a demo task now. */
  advanceDemoTask?(taskId: string): Promise<void>;
}
