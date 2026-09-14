import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import { handleRunLogCommand } from "../compact-runtime/run-log-access.js";
import { compactPreview } from "../compact-runtime/output-policy.js";
import type { DurableTaskView } from "../durable-task-model.js";
import type { ProcessSnapshot, ProcessStatusSnapshot } from "../process-sessions.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_EXEC_YIELD_MS = 5_000;
const CODEX_INTERACTIVE_YIELD_MS = 250;

const CODEX_INSTRUCTIONS = `Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, and exec_command for inspection, tests, builds, and other commands. Non-interactive long-running commands return a durable taskId and runId without keeping the MCP call open and continue across DevSpace restarts. Use task_get for durable task state, task_update only when a task reports input_required, and task_cancel to request cancellation. Honor pollIntervalMs and do not create tight polling loops. process_status and write_stdin are only for interactive or compatibility process sessions that returned a sessionId. Commands run with the local user's authority and are not sandboxed; workspace validation only selects their initial working directory. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) register(context);
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function recommendedPollMs(snapshot: Pick<ProcessSnapshot, "running" | "wallTimeMs" | "idleTimeMs">): number {
  if (!snapshot.running) return 0;
  if (snapshot.idleTimeMs >= 120_000) return 60_000;
  if (snapshot.wallTimeMs < 30_000) return 5_000;
  if (snapshot.wallTimeMs < 120_000) return 15_000;
  if (snapshot.wallTimeMs < 600_000) return 30_000;
  return 60_000;
}

function processResult(snapshot: ProcessSnapshot): string {
  const isError = Boolean(snapshot.signal) || (!snapshot.running && (snapshot.exitCode ?? 0) !== 0);
  const status = snapshot.running
    ? snapshot.sessionId === undefined
      ? `running task=${snapshot.taskId ?? snapshot.runId}`
      : `running session=${snapshot.sessionId}`
    : snapshot.signal
      ? `signal=${snapshot.signal}`
      : `exit=${snapshot.exitCode ?? "unknown"}`;
  const lines = [
    `run=${snapshot.runId} status=${status} duration=${snapshot.wallTimeMs}ms output=${snapshot.outputLines}L/${snapshot.outputBytes}B`,
  ];
  if (snapshot.running) {
    lines[0] += ` idle=${snapshot.idleTimeMs}ms next_check>=${recommendedPollMs(snapshot)}ms`;
  }
  const preview = compactPreview(snapshot.output, isError, snapshot.command);
  if (preview) lines.push(preview);
  if (snapshot.logError) {
    lines.push(`log=unavailable; warning=full local log persistence failed: ${snapshot.logError}`);
  } else {
    lines.push(`log=${snapshot.runId}; status=devspace-log meta ${snapshot.runId}; more=devspace-log read ${snapshot.runId} 1 80; search=devspace-log grep ${snapshot.runId} <pattern>`);
  }
  return lines.join("\n");
}

function processIsError(snapshot: ProcessSnapshot): boolean {
  return Boolean(snapshot.signal) || (!snapshot.running && (snapshot.exitCode ?? 0) !== 0);
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    resultType: z.enum(["task", "complete"]),
    sessionId: z.number().optional(),
    taskId: z.string().optional(),
    status: taskStatusSchema.optional(),
    statusMessage: z.string().optional(),
    createdAt: z.string().optional(),
    lastUpdatedAt: z.string().optional(),
    ttlMs: z.number().int().nonnegative().nullable().optional(),
    pollIntervalMs: z.number().int().nonnegative().optional(),
    runId: z.string(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    idleTimeMs: z.number().nonnegative(),
    nextPollMs: z.number().nonnegative(),
    outputBytes: z.number().nonnegative(),
    outputLines: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    logError: z.string().optional(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot, task?: DurableTaskView) {
  const result = processResult(snapshot);
  const resultType = snapshot.taskId && snapshot.running ? "task" : "complete";
  const content = [textBlock(result)];
  return {
    content,
    isError: processIsError(snapshot),
    structuredContent: {
      result,
      resultType,
      sessionId: snapshot.sessionId,
      taskId: snapshot.taskId,
      status: task?.status,
      statusMessage: task?.statusMessage,
      createdAt: task?.createdAt,
      lastUpdatedAt: task?.lastUpdatedAt,
      ttlMs: task?.ttlMs,
      pollIntervalMs: task?.pollIntervalMs,
      runId: snapshot.runId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      idleTimeMs: snapshot.idleTimeMs,
      nextPollMs: recommendedPollMs(snapshot),
      outputBytes: snapshot.outputBytes,
      outputLines: snapshot.outputLines,
      outputTruncated: snapshot.outputTruncated,
      ...(snapshot.logError ? { logError: snapshot.logError } : {}),
    },
  };
}

const taskStatusSchema = z.enum(["working", "input_required", "completed", "cancelled", "failed"]);

function taskViewSchema(): z.ZodRawShape {
  return resultOutputSchema({
    resultType: z.literal("complete"),
    taskId: z.string(),
    status: taskStatusSchema,
    statusMessage: z.string().optional(),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
    ttlMs: z.number().int().nonnegative().nullable(),
    pollIntervalMs: z.number().int().nonnegative().optional(),
    inputRequests: z.record(z.string(), z.unknown()).optional(),
    taskResult: z.record(z.string(), z.unknown()).optional(),
    error: z.record(z.string(), z.unknown()).optional(),
    runId: z.string(),
  });
}

function taskViewResponse(view: DurableTaskView) {
  const state = view.status === "completed"
    ? `completed${view.result?.isError ? " isError=true" : ""}`
    : view.status;
  const result = [
    `task=${view.taskId} status=${state} run=${view.runId} poll=${view.pollIntervalMs ?? 0}ms`,
    view.statusMessage,
    view.status === "completed"
      ? `result=ready; inspect with devspace-log tail ${view.runId} 80 or devspace-log read ${view.runId} 1 80`
      : view.status === "input_required"
        ? "result=input_required; answer outstanding inputRequests with task_update"
        : view.status === "working"
          ? "result=pending"
          : undefined,
  ].filter(Boolean).join("\n");
  return {
    content: [textBlock(result)],
    isError: view.status === "failed",
    structuredContent: {
      result,
      resultType: "complete" as const,
      taskId: view.taskId,
      status: view.status,
      statusMessage: view.statusMessage,
      createdAt: view.createdAt,
      lastUpdatedAt: view.lastUpdatedAt,
      ttlMs: view.ttlMs,
      pollIntervalMs: view.pollIntervalMs,
      inputRequests: view.inputRequests,
      taskResult: view.result,
      error: view.error,
      runId: view.runId,
    },
  };
}

function runLogToolResponse(command: string, result: string) {
  const runId = command.trim().split(/\s+/)[2] ?? "run_unknown";
  return {
    content: [textBlock(result)],
    structuredContent: {
      result,
      resultType: "complete" as const,
      runId,
      running: false,
      wallTimeMs: 0,
      idleTimeMs: 0,
      nextPollMs: 0,
      outputBytes: Buffer.byteLength(result, "utf8"),
      outputLines: result === "" ? 0 : result.split(/\r?\n/).length,
      outputTruncated: false,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;
  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        patch: z.string().describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previousPath: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, patch }) => {
      const startedAt = performance.now();
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.root, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];
      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files,
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, durableTasks } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command with the local user's authority. Commands are not sandboxed; workspace validation only selects the initial working directory. Full output is persisted locally. Non-interactive long-running commands use durable execution and return a taskId plus runId; query them with task_get. Interactive/TTY commands use process sessions. devspace-log commands are handled internally for bounded log retrieval.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z.boolean().optional().describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z.string().optional().describe("Working directory relative to the workspace root. Defaults to the workspace root."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory }) => {
      await workspaces.getWorkspace(workspaceId);
      const runLogResult = await handleRunLogCommand(cmd);
      if (runLogResult !== null) return runLogToolResponse(cmd, runLogResult);

      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
          if (!tty && durableTasks?.available) {
            return durableTasks.start({
              workspaceId,
              command: cmd,
              cwd,
              workspaceRoot: workspace.root,
              tty: false,
            }, CODEX_EXEC_YIELD_MS);
          }
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs: CODEX_EXEC_YIELD_MS,
          });
        },
      );
      if (snapshot.taskId && durableTasks?.available) {
        const workspace = await workspaces.getWorkspace(workspaceId);
        const task = await durableTasks.get(workspace.root, snapshot.taskId, {
          acknowledge: !snapshot.running,
        });
        return processToolResponse(snapshot, task);
      }
      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "task_get",
    {
      title: "Get durable task",
      description:
        "Get one durable task without waiting. This is the compatibility equivalent of MCP Tasks tasks/get while the host does not advertise io.modelcontextprotocol/tasks. Honor pollIntervalMs before checking a working task again.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
      },
      outputSchema: taskViewSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, taskId }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      return taskViewResponse(await durableTasks.get(workspace.root, taskId));
    },
  );

  server.registerTool(
    "task_update",
    {
      title: "Update durable task",
      description:
        "Provide responses requested by a durable task in input_required state. Compatibility equivalent of MCP Tasks tasks/update. Do not use for ordinary progress polling.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
        inputResponses: z.record(z.string(), z.unknown()).describe("Responses keyed by outstanding inputRequest identifiers."),
      },
      outputSchema: resultOutputSchema({ resultType: z.literal("complete") }),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId, inputResponses }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      await durableTasks.update(workspace.root, taskId, inputResponses);
      const result = `Accepted task input for ${taskId}.`;
      return { content: [textBlock(result)], structuredContent: { result, resultType: "complete" as const } };
    },
  );

  server.registerTool(
    "task_cancel",
    {
      title: "Cancel durable task",
      description:
        "Request cancellation of one durable task. Compatibility equivalent of MCP Tasks tasks/cancel. Cancellation is cooperative; use task_get only if the resulting terminal state matters to subsequent work.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
      },
      outputSchema: resultOutputSchema({ resultType: z.literal("complete") }),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      await durableTasks.cancel(workspace.root, taskId);
      const result = `Cancellation requested for ${taskId}.`;
      return { content: [textBlock(result)], structuredContent: { result, resultType: "complete" as const } };
    },
  );

  server.registerTool(
    "process_status",
    {
      title: "Check process status",
      description:
        "Check an interactive or compatibility process session without waiting and without consuming its buffered output. Use this only when exec_command returned a sessionId. Durable non-interactive commands return a runId instead; check those with devspace-log meta <runId>.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
      },
      outputSchema: resultOutputSchema({
        sessionId: z.number(),
        runId: z.string(),
        running: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        wallTimeMs: z.number().nonnegative(),
        idleTimeMs: z.number().nonnegative(),
        outputBytes: z.number().nonnegative(),
        outputLines: z.number().nonnegative(),
        nextPollMs: z.number().nonnegative(),
        logError: z.string().optional(),
      }),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId }) => {
      const startedAt = performance.now();
      const status = await runLoggedToolOperation(
        config,
        { tool: "process_status", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.status(workspaceId, sessionId);
        },
      );
      const nextPollMs = recommendedPollMs(status);
      const state = status.running
        ? "running"
        : status.signal
          ? `signal=${status.signal}`
          : `exit=${status.exitCode ?? "unknown"}`;
      const result = [
        `run=${status.runId} status=${state} session=${status.sessionId} duration=${status.wallTimeMs}ms idle=${status.idleTimeMs}ms output=${status.outputLines}L/${status.outputBytes}B next_check>=${nextPollMs}ms`,
        status.running
          ? `result=pending; avoid tight polling; full output remains local under runId=${status.runId}`
          : `result=ready; inspect with devspace-log tail ${status.runId} 80 or devspace-log read ${status.runId} 1 80`,
      ];
      if (status.logError) result.push(`warning=full local log persistence failed: ${status.logError}`);
      return {
        content: [textBlock(result.join("\n"))],
        structuredContent: {
          result: result.join("\n"),
          sessionId: status.sessionId,
          runId: status.runId,
          running: status.running,
          exitCode: status.exitCode,
          signal: status.signal,
          wallTimeMs: status.wallTimeMs,
          idleTimeMs: status.idleTimeMs,
          outputBytes: status.outputBytes,
          outputLines: status.outputLines,
          nextPollMs,
          ...(status.logError ? { logError: status.logError } : {}),
        },
      };
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Interact with a process returned by exec_command: send characters, resize a PTY, send Ctrl-C, or collect buffered output. Empty compatibility polls return immediately; use process_status for normal non-blocking status checks. Full output remains in the same local run log.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows }) => {
      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          const interactionRequested = Boolean(chars?.length) || columns !== undefined || rows !== undefined;
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs: interactionRequested ? CODEX_INTERACTIVE_YIELD_MS : 0,
          });
        },
      );
      return processToolResponse(snapshot);
    },
  );
}
