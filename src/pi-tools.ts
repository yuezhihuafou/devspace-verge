import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import { resolveAllowedPath } from "./roots.js";
import { handleRunLogCommand } from "./compact-runtime/run-log-access.js";
import { persistShellRun } from "./compact-runtime/run-store.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  try {
    const runLogResult = await handleRunLogCommand(input.command);
    if (runLogResult !== null) {
      return { content: [{ type: "text", text: runLogResult }] };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }

  const startedAt = performance.now();
  const tool = createBashTool(context.cwd);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  const response = await runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);

  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  try {
    const stored = await persistShellRun({ input, context, response, durationMs });
    return {
      ...response,
      content: [{ type: "text", text: stored.compactText }],
      details: {
        ...(response.details ?? {}),
        devspaceCompact: {
          runId: stored.runId,
          outputBytes: stored.meta.outputBytes,
          outputLines: stored.meta.outputLines,
          exitCode: stored.meta.exitCode,
          fullLogPath: stored.meta.outputPath,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...response,
      content: [
        { type: "text", text: `compact-log-store-failed: ${message}` },
        ...response.content,
      ],
    };
  }
}
