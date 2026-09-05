import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleRunLogCommand } from "./compact-runtime/run-log-access.js";
import { persistShellRun } from "./compact-runtime/run-store.js";

const previousRoot = process.env.DEVSPACE_COMPACT_RUN_ROOT;
const root = await mkdtemp(path.join(tmpdir(), "devspace-compact-test-"));
process.env.DEVSPACE_COMPACT_RUN_ROOT = root;

try {
  const success = await persistShellRun({
    input: { command: "printf 'alpha\\nbeta\\ngamma\\n'" },
    context: { cwd: "/tmp", root: "/tmp" },
    response: { content: [{ type: "text", text: "alpha\nbeta\ngamma" }] },
    durationMs: 3,
  });
  assert.match(success.compactText, /status=ok/);
  assert.match(success.compactText, /log=run_/);
  assert.equal(await handleRunLogCommand(`devspace-log read ${success.runId} 2 1`), "beta");
  assert.equal(await handleRunLogCommand(`devspace-log tail ${success.runId} 1`), "gamma");
  assert.equal(await handleRunLogCommand(`devspace-log grep ${success.runId} beta`), "beta");
  const meta = JSON.parse(await handleRunLogCommand(`devspace-log meta ${success.runId}`) as string);
  assert.equal(meta.exitCode, 0);
  assert.equal(await readFile(meta.outputPath, "utf8"), "alpha\nbeta\ngamma");

  const failure = await persistShellRun({
    input: { command: "sh -c 'echo boom; exit 7'" },
    context: { cwd: "/tmp", root: "/tmp" },
    response: {
      content: [{ type: "text", text: "boom\n\nCommand exited with code 7" }],
      isError: true,
    },
    durationMs: 4,
  });
  assert.match(failure.compactText, /status=error exit=7/);
  assert.match(failure.compactText, /boom/);
} finally {
  if (previousRoot === undefined) delete process.env.DEVSPACE_COMPACT_RUN_ROOT;
  else process.env.DEVSPACE_COMPACT_RUN_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
}
