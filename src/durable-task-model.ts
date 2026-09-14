export type DurableTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "cancelled"
  | "failed";

export interface DurableTaskResult {
  isError: boolean;
  runId: string;
  exitCode: number | null;
  signal: string | null;
  outputBytes: number;
  outputLines: number;
}

export interface DurableTaskError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface DurableTaskState {
  schemaVersion: 2;
  taskId: string;
  status: DurableTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, unknown>;
  result?: DurableTaskResult;
  error?: DurableTaskError;

  // DevSpace execution metadata. These fields are local implementation details,
  // not part of the MCP Tasks wire shape.
  workspaceId: string;
  runId: string;
  command: string;
  cwd: string;
  root: string;
  outputPath: string;
  lastActivityAt: string;
  finishedAt?: string;
  runnerPid?: number;
  childPid?: number;
  unitName?: string;
  outputBytes: number;
  outputLines: number;
  exitCode?: number | null;
  signal?: string | null;
}

export interface DurableTaskView {
  taskId: string;
  status: DurableTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, unknown>;
  result?: DurableTaskResult;
  error?: DurableTaskError;
  runId: string;
  workspaceId: string;
}

export function taskPollIntervalMs(state: Pick<DurableTaskState, "status" | "createdAt" | "lastActivityAt">): number {
  if (state.status !== "working" && state.status !== "input_required") return 0;
  if (state.status === "input_required") return 60_000;
  const now = Date.now();
  const createdAt = Date.parse(state.createdAt);
  const activityAt = Date.parse(state.lastActivityAt);
  const age = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;
  const idle = Number.isFinite(activityAt) ? Math.max(0, now - activityAt) : 0;
  if (idle >= 120_000) return 60_000;
  if (age < 30_000) return 5_000;
  if (age < 120_000) return 15_000;
  if (age < 600_000) return 30_000;
  return 60_000;
}

export function durableTaskView(state: DurableTaskState): DurableTaskView {
  return {
    taskId: state.taskId,
    status: state.status,
    statusMessage: state.statusMessage,
    createdAt: state.createdAt,
    lastUpdatedAt: state.lastUpdatedAt,
    ttlMs: state.ttlMs,
    pollIntervalMs: taskPollIntervalMs(state),
    inputRequests: state.inputRequests,
    result: state.result,
    error: state.error,
    runId: state.runId,
    workspaceId: state.workspaceId,
  };
}
