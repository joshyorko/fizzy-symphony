// fizzy-symphony v2 core contracts.
//
// These types are the boring runtime contract for the v2 cockpit spike. They
// are intentionally independent of the Fizzy SDK and the Codex SDK: the daemon
// and cockpit speak this vocabulary, and adapters translate at the edges.
//
// Runtime is plain ESM JavaScript with native TypeScript type stripping
// (Node >= 23.6 / project engine >= 25). Nothing here emits runtime code.

export const STATUS_SCHEMA_VERSION = "fizzy-symphony-status-v2";
export type StatusSchemaVersion = "fizzy-symphony-status-v2";

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

export type ReadinessState = "ready" | "blocked" | "locked" | "unknown";

export interface InstanceStatus {
  id: string;
  label?: string;
  pid?: number | null;
  startedAt?: string | null;
  endpoint?: string | null;
  daemonVersion?: string;
}

export interface ReadinessBlocker {
  code: string;
  message: string;
  detail?: unknown;
}

export interface ReadinessStatus {
  state: ReadinessState;
  ready: boolean;
  blockers: ReadinessBlocker[];
  dispatchPaused?: boolean;
  runnerStatus?: string;
}

export type CapabilityCategory =
  | "fizzy"
  | "codex"
  | "board"
  | "route"
  | "runner"
  | "worktree"
  | "doctor"
  | "control"
  | "webhook"
  | "diagnostics";

export interface Capability {
  id: string;
  title: string;
  category: CapabilityCategory;
  description: string;
  enabled: boolean;
  disabledReason?: string;
  commands?: string[];
  endpoints?: string[];
  stateFields?: string[];
  risks?: string[];
}

export interface BoardRuntimeStatus {
  id: string;
  name: string;
  routeIds: string[];
  activeCardCount: number;
  goldenCardCount: number;
}

export interface RouteRuntimeStatus {
  id: string;
  boardId: string;
  name: string;
  sourceColumnId?: string;
  sourceColumnName?: string;
  goldenCardId?: string;
  goldenCardNumber?: number | string;
  backend?: string;
  model?: string;
  enabled: boolean;
  disabledReason?: string;
}

export type CardRuntimeState =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface CardRuntimeStatus {
  id: string;
  number?: number | string;
  title: string;
  boardId: string;
  routeId?: string;
  columnId?: string;
  columnName?: string;
  state: CardRuntimeState;
  golden: boolean;
  runId?: string;
  claimId?: string;
  workspacePath?: string;
  attention?: string;
}

export type RunState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "preempted";

export interface RunStatus {
  id: string;
  attemptId?: string;
  state: RunState;
  boardId?: string;
  cardId?: string;
  cardNumber?: number | string;
  cardTitle?: string;
  routeId?: string;
  claimId?: string;
  sessionId?: string;
  turnId?: string;
  workspacePath?: string;
  startedAt?: string;
  updatedAt?: string;
  stalled?: boolean;
  error?: RuntimeErrorInfo;
  recommendedAction?: string;
}

export interface RuntimeErrorInfo {
  code: string;
  message: string;
  remediation?: string;
}

export type ClaimState =
  | "claimed"
  | "renewed"
  | "released"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost";

export interface ClaimStatus {
  id: string;
  cardId?: string;
  boardId?: string;
  routeId?: string;
  runId?: string;
  state: ClaimState;
  expiresAt?: string;
  workspaceKey?: string;
}

export interface WorktreeStatus {
  workspaceKey: string;
  path: string;
  cardId?: string;
  cardNumber?: number | string;
  runId?: string;
  branch?: string;
  dirty: boolean;
  preserved: boolean;
  dirtyPaths?: string[];
  lastError?: RuntimeErrorInfo;
  recommendedAction?: string;
}

export interface RetryQueueItem {
  runId: string;
  cardId?: string;
  attempt: number;
  maxAttempts?: number;
  nextRetryAt?: string;
  reason?: string;
}

export interface DoctorStatus {
  goalClosable: boolean;
  blockers: DoctorBlocker[];
  checkedAt?: string;
}

export interface DoctorBlocker {
  code: string;
  message: string;
  workspaceKey?: string;
  recommendedAction?: string;
}

export type WarningSeverity = "info" | "warning" | "error";

export interface RuntimeWarning {
  code: string;
  message: string;
  severity: WarningSeverity;
  at?: string;
  cardId?: string;
  runId?: string;
}

export interface CapacityRefusal {
  cardId?: string;
  routeId?: string;
  reason: string;
  refusedAt?: string;
}

export interface RuntimeEvent {
  id: string;
  type: string;
  severity: WarningSeverity;
  message: string;
  at: string;
  boardId?: string;
  cardId?: string;
  cardNumber?: number | string;
  runId?: string;
  sessionId?: string;
  workspacePath?: string;
  data?: unknown;
}

export interface RunBuckets {
  queued: RunStatus[];
  running: RunStatus[];
  completed: RunStatus[];
  failed: RunStatus[];
  cancelled: RunStatus[];
  preempted: RunStatus[];
}

export interface SymphonyStatus {
  schemaVersion: StatusSchemaVersion;
  instance: InstanceStatus;
  readiness: ReadinessStatus;
  capabilities: Capability[];
  boards: BoardRuntimeStatus[];
  routes: RouteRuntimeStatus[];
  cards: CardRuntimeStatus[];
  runs: RunBuckets;
  claims: ClaimStatus[];
  worktrees: WorktreeStatus[];
  retryQueue: RetryQueueItem[];
  capacityRefusals: CapacityRefusal[];
  doctor: DoctorStatus;
  warnings: RuntimeWarning[];
  recentEvents: RuntimeEvent[];
  lastUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Command model
// ---------------------------------------------------------------------------

export type OperatorCommand =
  | { type: "dispatch.pause"; reason?: string }
  | { type: "dispatch.resume"; reason?: string }
  | { type: "run.cancel"; runId: string; reason: string }
  | { type: "session.stop"; sessionId: string; reason: string }
  | { type: "card.rerun"; cardId: string; reason: string }
  | { type: "card.move"; cardId: string; targetColumnId: string; reason: string }
  | { type: "worktree.preserve"; workspaceKey: string; reason: string }
  | { type: "worktree.cleanup"; workspaceKey: string; reason: string };

export type OperatorCommandType = OperatorCommand["type"];

export interface CommandValidation {
  ok: boolean;
  command?: OperatorCommand;
  code?: string;
  message?: string;
}

export type CommandOutcome = "accepted" | "rejected" | "unavailable" | "dry-run";

export interface CommandResult {
  outcome: CommandOutcome;
  commandType?: OperatorCommandType;
  message: string;
  code?: string;
  event?: RuntimeEvent;
}

// ---------------------------------------------------------------------------
// Cockpit model
// ---------------------------------------------------------------------------

export type FactoryState = "open" | "running" | "blocked" | "locked" | "unknown";
export type CockpitMode = "SETUP" | "OFFLINE" | "LIVE" | "DEMO";
export type CockpitSectionId = "factory" | "runs" | "worktrees" | "doctor" | "manual" | "events" | "settings" | "advanced";

export interface CockpitApp {
  mode: CockpitMode;
  source: string;
  configPath: string;
  endpoint?: string | null;
}

export interface CockpitSection {
  id: CockpitSectionId;
  label: string;
  key: string;
  shortcutHint?: string;
}

export interface CockpitNextAction {
  id: string;
  label: string;
  command: string;
  enabled: boolean;
  mutates: boolean;
  disabledReason?: string;
}

export interface CockpitSettingsSummary {
  configPath: string;
  source: string;
  mode: CockpitMode;
  endpoint?: string | null;
  runnerStatus?: string;
  readiness: ReadinessState;
  readinessBlockers: number;
  workspaceCount: number;
  dirtyWorktrees: number;
  boardCount: number;
  routeCount: number;
  hasLiveEndpoint: boolean;
}

export interface CockpitAdvancedCommand {
  id: string;
  key: string;
  label: string;
  command: string;
  enabled: boolean;
  mutates: boolean;
  disabledReason?: string;
}

export interface CockpitPaletteRow {
  id: string;
  key: string;
  label: string;
  section?: CockpitSectionId;
  enabled: boolean;
  disabledReason?: string;
  mutates: boolean;
  command?: OperatorCommandType;
  endpoint?: string;
}

export interface CockpitHeader {
  instanceId: string;
  instanceLabel?: string;
  endpoint?: string | null;
  readiness: ReadinessState;
  factoryState: FactoryState;
  runnerStatus?: string;
  lastUpdatedAt: string;
  counts: {
    boards: number;
    routes: number;
    running: number;
    queued: number;
    failed: number;
    dirtyWorktrees: number;
    warnings: number;
  };
}

export interface CockpitLaneCard {
  id: string;
  themeLabel: string;
  title: string;
  number?: number | string;
  state: CardRuntimeState;
  golden: boolean;
  runId?: string;
  hazard: boolean;
  attention?: string;
}

export interface CockpitLane {
  routeId: string;
  boardId: string;
  title: string;
  themeLabel: string;
  factoryLine: string;
  cards: CockpitLaneCard[];
  enabled: boolean;
  disabledReason?: string;
}

export interface CockpitSelection {
  kind: "card" | "run" | "worktree" | "route" | "none";
  id?: string;
  themeLabel?: string;
  raw: Record<string, unknown>;
  recommendedAction?: string;
}

export interface CockpitRunSummary {
  id: string;
  state: RunState;
  themeLabel: string;
  cardNumber?: number | string;
  cardTitle?: string;
  stalled: boolean;
  error?: RuntimeErrorInfo;
}

export interface CockpitWorktreeSummary {
  workspaceKey: string;
  path: string;
  dirty: boolean;
  preserved: boolean;
  themeLabel: string;
  recommendedAction?: string;
}

export interface CockpitDoctorSummary {
  goalClosable: boolean;
  themeLabel: string;
  blockers: DoctorBlocker[];
}

export interface CockpitEventSummary {
  id: string;
  severity: WarningSeverity;
  message: string;
  at: string;
  themeLabel: string;
}

export interface CapabilitySummary {
  id: string;
  title: string;
  category: CapabilityCategory;
  enabled: boolean;
  disabledReason?: string;
}

export interface CockpitAction {
  id: string;
  commandType?: OperatorCommandType;
  key?: string;
  label: string;
  enabled: boolean;
  disabledReason?: string;
}

export interface CockpitHelp {
  manualTitle: string;
  keys: Array<{ key: string; description: string }>;
  capabilities: CapabilitySummary[];
}

export interface CockpitModel {
  app: CockpitApp;
  sections: CockpitSection[];
  selectedSectionId: CockpitSectionId;
  nextActions: CockpitNextAction[];
  settings: CockpitSettingsSummary;
  commandPaletteOpen: boolean;
  commandPalette: CockpitPaletteRow[];
  advancedCommands: CockpitAdvancedCommand[];
  header: CockpitHeader;
  factoryState: FactoryState;
  lanes: CockpitLane[];
  selected?: CockpitSelection;
  panels: {
    activeRuns: CockpitRunSummary[];
    worktrees: CockpitWorktreeSummary[];
    doctor: CockpitDoctorSummary;
    events: CockpitEventSummary[];
    capabilities: CapabilitySummary[];
  };
  actions: CockpitAction[];
  help: CockpitHelp;
}

export interface CockpitModelInput {
  status: SymphonyStatus;
  events?: RuntimeEvent[];
  capabilities?: Capability[];
  selectedId?: string;
  filter?: string;
  app?: CockpitApp;
  sections?: CockpitSection[];
  selectedSectionId?: CockpitSectionId;
  commandPaletteOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Fixture bundle (status + events shipped together for fixture-first tests)
// ---------------------------------------------------------------------------

export interface FixtureBundle {
  status: SymphonyStatus;
  events?: RuntimeEvent[];
  capabilities?: Capability[];
}

// ---------------------------------------------------------------------------
// Fizzy port (independent of any SDK)
// ---------------------------------------------------------------------------

export interface FizzyBoard {
  id: string;
  name: string;
  columns?: FizzyColumn[];
}

export interface FizzyColumn {
  id: string;
  name: string;
}

export interface FizzyCard {
  id: string;
  number?: number | string;
  title: string;
  boardId: string;
  columnId?: string;
  tags?: string[];
  golden?: boolean;
}

export interface FizzyComment {
  id: string;
  cardId: string;
  body: string;
  createdAt?: string;
}

export interface FizzyWebhook {
  id: string;
  boardId: string;
  url: string;
}

export interface ListBoardsInput {
  accountSlug?: string;
}
export interface GetBoardInput {
  boardId: string;
}
export interface ListCardsInput {
  boardId: string;
  columnId?: string;
}
export interface GetCardInput {
  cardId: string;
}
export interface ListCommentsInput {
  cardId: string;
}
export interface CreateCommentInput {
  cardId: string;
  cardNumber?: number | string;
  body: string;
}
export interface UpdateCommentInput {
  commentId: string;
  cardId?: string;
  cardNumber?: number | string;
  body: string;
}
export interface MoveCardInput {
  cardId: string;
  cardNumber?: number | string;
  targetColumnId: string;
}
export interface ListWebhooksInput {
  boardId: string;
}
export interface VerifyWebhookInput {
  signature: string;
  payload: string;
}

export interface FizzyPort {
  describe(): { kind: string; sdk: boolean; note?: string };
  listBoards(input?: ListBoardsInput): Promise<FizzyBoard[]>;
  getBoard(input: GetBoardInput): Promise<FizzyBoard>;
  listCards(input: ListCardsInput): Promise<FizzyCard[]>;
  getCard(input: GetCardInput): Promise<FizzyCard>;
  listComments(input: ListCommentsInput): Promise<FizzyComment[]>;
  createComment(input: CreateCommentInput): Promise<FizzyComment>;
  updateComment(input: UpdateCommentInput): Promise<FizzyComment>;
  moveCard(input: MoveCardInput): Promise<FizzyCard>;
  listWebhooks?(input: ListWebhooksInput): Promise<FizzyWebhook[]>;
  verifyWebhook?(input: VerifyWebhookInput): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Codex runner port (SDK-compatible shape)
// ---------------------------------------------------------------------------

export interface RunnerDetectInput {
  cwd?: string;
}
export interface RunnerDetectResult {
  kind: string;
  available: boolean;
  contract: string;
  version?: string;
  sdk: boolean;
  note?: string;
}
export interface RunnerHealthInput {
  cwd?: string;
}
export interface RunnerHealthResult {
  status: "ready" | "unavailable" | "unknown";
  kind: string;
  contract: string;
  checkedAt?: string;
  failureCode?: string;
  remediation?: string;
}
export interface StartSessionInput {
  workspacePath: string;
  model?: string;
  reasoningEffort?: string;
  sandboxPolicy?: string;
  metadata?: Record<string, unknown>;
}
export interface SessionHandle {
  sessionId: string;
  workspacePath: string;
}
export interface StartTurnInput {
  session: SessionHandle;
  prompt: string;
  metadata?: Record<string, unknown>;
}
export interface TurnHandle {
  turnId: string;
  sessionId: string;
}
export interface StreamTurnInput {
  turn: TurnHandle;
}
export interface RunnerEvent {
  type: string;
  text?: string;
  data?: unknown;
}
export type RunnerEventSink = (event: RunnerEvent) => void;
export interface TurnResult {
  status: "completed" | "failed" | "cancelled" | "input_required";
  turnId: string;
  sessionId: string;
  error?: RuntimeErrorInfo;
}
export interface CancelTurnInput {
  turn: TurnHandle;
  reason: string;
}
export interface StopSessionInput {
  session: SessionHandle;
  reason: string;
}
export interface TerminateProcessInput {
  sessionId: string;
  reason: string;
}

export interface CodexRunnerPort {
  describe(): { kind: string; sdk: boolean; contract: string; note?: string };
  detect(input?: RunnerDetectInput): Promise<RunnerDetectResult>;
  health(input?: RunnerHealthInput): Promise<RunnerHealthResult>;
  startSession(input: StartSessionInput): Promise<SessionHandle>;
  startTurn(input: StartTurnInput): Promise<TurnHandle>;
  streamTurn(input: StreamTurnInput, onEvent: RunnerEventSink): Promise<TurnResult>;
  cancelTurn(input: CancelTurnInput): Promise<TurnResult>;
  stopSession(input: StopSessionInput): Promise<void>;
  terminateOwnedProcess?(input: TerminateProcessInput): Promise<void>;
}
