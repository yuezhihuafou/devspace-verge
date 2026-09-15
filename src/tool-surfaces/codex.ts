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
  logToolCall,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_EXEC_YIELD_MS = 5_000;
const CODEX_LONG_EXEC_YIELD_MS = 1_000;
const CODEX_INTERACTIVE_YIELD_MS = 250;

function execYieldMs(command: string): number {
  const likelyLong = /(?:^|[;&|]\s*)(?:sleep\s+\d|(?:pnpm|npm|yarn|bun)\s+(?:test|build|run\s+(?:test|build))|(?:node|tsx)\s+--test\b|pytest\b|colcon\s+(?:build|test)\b|cmake\s+--build\b|(?:make|ninja)\b|cargo\s+(?:test|build|clippy)\b|go\s+test\b|mvn\b|gradle\b)/i.test(command);
  return likelyLong ? CODEX_LONG_EXEC_YIELD_MS : CODEX_EXEC_YIELD_MS;
}

const CODEX_INSTRUCTIONS = `Use ${toolNames.read} for direct file reads, apply_patch for file changes, and exec_command for commands. Long non-interactive commands return durable taskId/runId handles and survive DevSpace restarts; use task_get, task_update only for input_required, and task_cancel. Honor pollIntervalMs. Retrieve saved output with devspace-log meta/read/tail/grep; use meta-full only for deep diagnostics. Interactive/TTY commands return sessionId; use process_status/write_stdin. Commands run with the local user's authority and are not sandboxed. Follow ${toolNames.openWorkspace} instructions and applicable instruction/skill files.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) register(context);
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerSemanticTools,
  registerCodexProcessTools,
];

const semanticReadActionSchema = z.enum([
  "overview",
  "find",
  "references",
  "implementations",
  "declaration",
  "diagnostics",
]);

function registerSemanticTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, semantic } = context;
  if (!semantic?.available) return;

  server.registerTool(
    "semantic_code",
    {
      title: "Semantic code query",
      description:
        "Query source code with Serena/LSP semantics. Use overview for file structure, find for symbols, references or implementations for relations, declaration for a symbol at a code pattern, and diagnostics for language-server errors. Results are bounded; refine broad queries instead of reading entire files.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        action: semanticReadActionSchema,
        path: z.string().describe("Workspace-relative source file or directory. Use an empty string only for a broad symbol find."),
        symbol: z.string().optional().describe("Symbol/name-path for find, references, or implementations."),
        pattern: z.string().optional().describe("Regex containing one capture group for declaration lookup."),
        detail: z.enum(["location", "info", "body"]).optional().describe("Find/declaration detail. Defaults to location."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, action, path: relativePath, symbol, pattern, detail }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      if (relativePath) workspaces.resolveReadPath(workspace, relativePath);
      let tool: string;
      let args: Record<string, unknown>;
      if (action === "overview") {
        tool = "get_symbols_overview";
        args = { relative_path: relativePath, max_answer_chars: 6_000 };
      } else if (action === "find") {
        if (!symbol) throw new Error("semantic_code action=find requires symbol.");
        tool = "find_symbol";
        args = { name_path_pattern: symbol, relative_path: relativePath, include_body: detail === "body", include_info: detail === "info", max_answer_chars: 6_000 };
      } else if (action === "references") {
        if (!symbol || !relativePath) throw new Error("semantic_code action=references requires symbol and path.");
        tool = "find_referencing_symbols";
        args = { name_path: symbol, relative_path: relativePath, max_answer_chars: 6_000 };
      } else if (action === "implementations") {
        if (!symbol || !relativePath) throw new Error("semantic_code action=implementations requires symbol and path.");
        tool = "find_implementations";
        args = { name_path: symbol, relative_path: relativePath, include_info: detail === "info", max_answer_chars: 6_000 };
      } else if (action === "declaration") {
        if (!relativePath || !pattern) throw new Error("semantic_code action=declaration requires path and pattern.");
        tool = "find_declaration";
        args = { relative_path: relativePath, regex: pattern, include_body: detail === "body", include_info: detail === "info" };
      } else {
        if (!relativePath) throw new Error("semantic_code action=diagnostics requires path.");
        tool = "get_diagnostics_for_file";
        args = { relative_path: relativePath, max_answer_chars: 6_000 };
      }
      const response = await semantic.call(workspace.root, tool, args);
      logToolCall(config, { tool: "semantic_code", workspaceId, path: relativePath, success: true, durationMs: Math.round(performance.now() - startedAt) });
      return {
        content: [textBlock(response.result)],
        structuredContent: { action, truncated: response.truncated, backendAgeMs: response.backendAgeMs },
      };
    },
  );

  const semanticEditActionSchema = z.enum(["rename", "replace_body", "insert_before", "insert_after", "safe_delete"]);
  server.registerTool(
    "semantic_edit",
    {
      title: "Semantic code edit",
      description:
        "Perform an LSP-aware symbol edit through Serena when plain patching would be less reliable. Use rename for cross-file symbol renames; replace or insert actions target a symbol name-path; safe_delete removes a symbol only when semantic checks allow it. Call show_changes after the final edit.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        action: semanticEditActionSchema,
        path: z.string().describe("Workspace-relative source file containing the target symbol."),
        symbol: z.string().describe("Target symbol/name-path."),
        newName: z.string().optional().describe("New symbol name for rename."),
        body: z.string().optional().describe("Replacement or inserted code for replace_body/insert_before/insert_after."),
      },
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, action, path: relativePath, symbol, newName, body }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      workspaces.resolveReadPath(workspace, relativePath);
      let tool: string;
      let args: Record<string, unknown>;
      if (action === "rename") {
        if (!newName) throw new Error("semantic_edit action=rename requires newName.");
        tool = "rename_symbol";
        args = { name_path: symbol, relative_path: relativePath, new_name: newName };
      } else if (action === "replace_body") {
        if (body === undefined) throw new Error("semantic_edit action=replace_body requires body.");
        tool = "replace_symbol_body";
        args = { name_path: symbol, relative_path: relativePath, body };
      } else if (action === "insert_before") {
        if (body === undefined) throw new Error("semantic_edit action=insert_before requires body.");
        tool = "insert_before_symbol";
        args = { name_path: symbol, relative_path: relativePath, body };
      } else if (action === "insert_after") {
        if (body === undefined) throw new Error("semantic_edit action=insert_after requires body.");
        tool = "insert_after_symbol";
        args = { name_path: symbol, relative_path: relativePath, body };
      } else {
        tool = "safe_delete_symbol";
        args = { name_path_pattern: symbol, relative_path: relativePath };
      }
      const response = await semantic.call(workspace.root, tool, args);
      logToolCall(config, { tool: "semantic_edit", workspaceId, path: relativePath, success: true, durationMs: Math.round(performance.now() - startedAt) });
      return {
        content: [textBlock(response.result)],
        structuredContent: { action, truncated: response.truncated, backendAgeMs: response.backendAgeMs },
      };
    },
  );
}

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
    lines.push(`log=${snapshot.runId}`);
  }
  return lines.join("\n");
}

function processIsError(snapshot: ProcessSnapshot): boolean {
  return Boolean(snapshot.signal) || (!snapshot.running && (snapshot.exitCode ?? 0) !== 0);
}

function processToolResponse(snapshot: ProcessSnapshot, task?: DurableTaskView) {
  const result = processResult(snapshot);
  const isTask = Boolean(snapshot.taskId && snapshot.running);
  const resultType = isTask ? "task" : "complete";
  const content = [textBlock(result)];
  return {
    content,
    isError: processIsError(snapshot),
    structuredContent: {
      resultType,
      sessionId: snapshot.sessionId,
      ...(isTask ? {
        taskId: snapshot.taskId,
        status: task?.status,
        statusMessage: task?.statusMessage,
        createdAt: task?.createdAt,
        lastUpdatedAt: task?.lastUpdatedAt,
        ttlMs: task?.ttlMs,
        pollIntervalMs: task?.pollIntervalMs,
      } : {}),
      runId: snapshot.runId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      ...(snapshot.running ? {
        idleTimeMs: snapshot.idleTimeMs,
        nextPollMs: recommendedPollMs(snapshot),
      } : {}),
      outputBytes: snapshot.outputBytes,
      outputLines: snapshot.outputLines,
      outputTruncated: snapshot.outputTruncated,
      ...(snapshot.logError ? { logError: snapshot.logError } : {}),
    },
  };
}

function taskViewResponse(view: DurableTaskView) {
  const state = view.status === "completed"
    ? `completed${view.result?.isError ? " isError=true" : ""}`
    : view.status;
  const result = [
    `task=${view.taskId} status=${state} run=${view.runId} poll=${view.pollIntervalMs ?? 0}ms`,
    view.statusMessage,
    view.status === "input_required" ? "Use task_update for outstanding inputRequests." : undefined,
  ].filter(Boolean).join("\n");
  return {
    content: [textBlock(result)],
    isError: view.status === "failed",
    structuredContent: {
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
        "Run a shell command in a workspace. Not sandboxed. Full output is saved locally. Long non-TTY commands become durable tasks; TTY commands return a process session. devspace-log reads saved output.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z.boolean().optional().describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z.string().optional().describe("Working directory relative to the workspace root. Defaults to the workspace root."),
      },
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
            }, execYieldMs(cmd));
          }
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs: execYieldMs(cmd),
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
        "Get one durable task without waiting. Honor pollIntervalMs before checking a working task again.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
      },
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
        "Provide requested input to a durable task in input_required state. Do not use for polling.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
        inputResponses: z.record(z.string(), z.unknown()).describe("Responses keyed by outstanding inputRequest identifiers."),
      },
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId, inputResponses }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      await durableTasks.update(workspace.root, taskId, inputResponses);
      const result = `Accepted task input for ${taskId}.`;
      return { content: [textBlock(result)], structuredContent: { resultType: "complete" as const } };
    },
  );

  server.registerTool(
    "task_cancel",
    {
      title: "Cancel durable task",
      description:
        "Request cancellation of one durable task. Use task_get only if the terminal state matters to later work.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
      },
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      await durableTasks.cancel(workspace.root, taskId);
      const result = `Cancellation requested for ${taskId}.`;
      return { content: [textBlock(result)], structuredContent: { resultType: "complete" as const } };
    },
  );

  server.registerTool(
    "process_status",
    {
      title: "Check process status",
      description:
        "Check a process session immediately without consuming buffered output. Use only when exec_command returned sessionId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
      },
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
      ];
      if (status.logError) result.push(`warning=full local log persistence failed: ${status.logError}`);
      return {
        content: [textBlock(result.join("\n"))],
        structuredContent: {
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
        "Interact with a process session: send characters/Ctrl-C, resize its PTY, or collect buffered output. Use process_status for status-only checks.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
      },
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
