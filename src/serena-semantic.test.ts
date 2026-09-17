import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { SERENA_STDERR_MODE, SerenaSemanticManager } from "./serena-semantic.js";

test("Serena stderr cannot use an unread pipe", () => {
  assert.equal(SERENA_STDERR_MODE, "inherit");
});

test("Serena semantic backends use bounded LRU reuse", async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const manager = new SerenaSemanticManager({
    available: true,
    maxBackends: 2,
    createClient: async (root) => {
      created.push(root);
      return {
        callTool: async () => ({ content: [{ type: "text", text: root }] }),
        close: async () => { closed.push(root); },
      };
    },
  });

  const a = path.resolve("/tmp/devspace-serena-a");
  const b = path.resolve("/tmp/devspace-serena-b");
  const c = path.resolve("/tmp/devspace-serena-c");
  await manager.call(a, "find_symbol", {});
  await manager.call(b, "find_symbol", {});
  await manager.call(a, "find_symbol", {}); // A becomes most recently used.
  await manager.call(c, "find_symbol", {});

  assert.deepEqual(closed, [b]);
  assert.equal(created.filter((root) => root === a).length, 1);
  assert.equal(created.filter((root) => root === b).length, 1);
  assert.equal(created.filter((root) => root === c).length, 1);

  await manager.call(b, "find_symbol", {});
  assert.equal(created.filter((root) => root === b).length, 2);
  await manager.close();
});

test("Serena semantic LRU never evicts a backend while it is busy", async () => {
  let releaseA!: () => void;
  let startedA!: () => void;
  const aStarted = new Promise<void>((resolve) => { startedA = resolve; });
  const aRelease = new Promise<void>((resolve) => { releaseA = resolve; });
  const closed: string[] = [];
  const a = path.resolve("/tmp/devspace-serena-busy-a");
  const b = path.resolve("/tmp/devspace-serena-busy-b");
  const manager = new SerenaSemanticManager({
    available: true,
    maxBackends: 1,
    createClient: async (root) => ({
      callTool: async () => {
        if (root === a) {
          startedA();
          await aRelease;
        }
        return { content: [{ type: "text", text: root }] };
      },
      close: async () => { closed.push(root); },
    }),
  });

  const activeA = manager.call(a, "find_symbol", {});
  await aStarted;
  await manager.call(b, "find_symbol", {});
  assert.deepEqual(closed, [b]);
  releaseA();
  await activeA;
  assert.equal(closed.includes(a), false);
  await manager.close();
});
