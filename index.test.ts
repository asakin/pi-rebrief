import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  contextFilesDisabledByArgv,
  createRebriefExtension,
  formatTokens,
  type ContextFile,
  type RebriefDeps,
} from "./index.ts";

function setup(
  initialFiles: ContextFile[],
  diskFilesRef: { current: ContextFile[] },
  deps: RebriefDeps = {},
) {
  let commandHandler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const eventHandlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();

  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      if (name === "rebrief") commandHandler = options.handler;
    },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
      return () => {};
    },
  } as unknown as ExtensionAPI;

  const ext = createRebriefExtension({
    getAgentDir: () => "/fake/agent",
    loadProjectContextFiles: ({ cwd }) => {
      assert.equal(cwd, "/repo");
      return diskFilesRef.current.map((f) => ({ ...f }));
    },
    contextFilesDisabled: () => false,
    ...deps,
  });
  ext(pi);

  // Simulates AgentSession._baseSystemPromptOptions (which _rebuildSystemPrompt may reset to initialFiles)
  const baseOptions: BuildSystemPromptOptions = {
    cwd: "/repo",
    contextFiles: initialFiles.map((f) => ({ ...f })),
  };

  const notifications: Array<{ message: string; level?: string }> = [];
  let contextTokens: number | null | undefined = undefined;

  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    getSystemPromptOptions: () => baseOptions,
    getContextUsage: () =>
      contextTokens === undefined
        ? undefined
        : { tokens: contextTokens, contextWindow: 200_000, percent: contextTokens ? (contextTokens / 200_000) * 100 : 0 },
  } as unknown as ExtensionCommandContext;

  async function runTurn(): Promise<ContextFile[]> {
    // Simulates ExtensionRunner.emitBeforeAgentStart cloning _baseSystemPromptOptions per turn
    const turnOptions: BuildSystemPromptOptions = {
      cwd: baseOptions.cwd,
      contextFiles: (baseOptions.contextFiles ?? []).map((f) => ({ ...f })),
    };
    const event = {
      type: "before_agent_start",
      systemPromptOptions: turnOptions,
    } as unknown as BeforeAgentStartEvent;

    for (const handler of eventHandlers.get("before_agent_start") ?? []) {
      const result = await handler(event, ctx);
      // Must not return forceSystemPrompt replacement
      assert.equal(result, undefined);
    }
    return turnOptions.contextFiles ?? [];
  }

  async function emitSessionStart() {
    for (const handler of eventHandlers.get("session_start") ?? []) {
      await handler({ type: "session_start" }, ctx);
    }
  }

  return {
    baseOptions,
    notifications,
    setContextTokens(tokens: number | null | undefined) {
      contextTokens = tokens;
    },
    rebrief: () => commandHandler("", ctx),
    runTurn,
    emitSessionStart,
  };
}

test("rebrief persists across multiple turns and survives _baseSystemPromptOptions rebuilds", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const disk = { current: [{ path: "/repo/AGENTS.md", content: "v2 - Ms. Pac-Man" }] };
  const h = setup(initial, disk);

  await h.rebrief();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.level, "info");
  assert.match(h.notifications[0]!.message, /Reloaded 1 context file for the next turn/);

  // Turn 1 sees v2
  assert.deepEqual(await h.runTurn(), [{ path: "/repo/AGENTS.md", content: "v2 - Ms. Pac-Man" }]);

  // Simulate AgentSession._rebuildSystemPrompt resetting _baseSystemPromptOptions back to startup v1
  h.baseOptions.contextFiles = [{ path: "/repo/AGENTS.md", content: "v1" }];

  // Turn 2 still sees v2 (no Turn-2 revert!)
  assert.deepEqual(await h.runTurn(), [{ path: "/repo/AGENTS.md", content: "v2 - Ms. Pac-Man" }]);
});

test("rebrief warns with cached context token count when files change mid-session", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const disk = {
    current: [
      { path: "/repo/AGENTS.md", content: "v2" },
      { path: "/repo/sub/AGENTS.md", content: "sub" },
    ],
  };
  const h = setup(initial, disk);
  h.setContextTokens(48_320);

  await h.rebrief();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.level, "warning");
  assert.equal(
    h.notifications[0]?.message,
    "Reloaded 2 context files. Next turn will invalidate ~48.3k tokens of cached context.",
  );
});

test("rebrief reports unchanged when files on disk match current context files", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const disk = { current: [{ path: "/repo/AGENTS.md", content: "v1" }] };
  const h = setup(initial, disk);
  h.setContextTokens(65_000);

  await h.rebrief();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.level, "info");
  assert.equal(
    h.notifications[0]?.message,
    "Context files unchanged (1 context file) — prompt cache unaffected.",
  );
});

test("session_start clears rebriefed override for the new session", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const disk = { current: [{ path: "/repo/AGENTS.md", content: "v2" }] };
  const h = setup(initial, disk);

  await h.rebrief();
  assert.deepEqual(await h.runTurn(), [{ path: "/repo/AGENTS.md", content: "v2" }]);

  // New session starts with fresh baseOptions
  h.baseOptions.contextFiles = [{ path: "/repo/AGENTS.md", content: "v3-from-new-session" }];
  await h.emitSessionStart();
  assert.deepEqual(await h.runTurn(), [{ path: "/repo/AGENTS.md", content: "v3-from-new-session" }]);
});

test("rebrief surfaces loader errors via ui.notify without overwriting state", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  let shouldThrow = true;
  const h = setup(initial, {
    get current() {
      if (shouldThrow) throw new Error("EACCES: permission denied");
      return initial;
    },
  });

  await h.rebrief();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.level, "error");
  assert.match(h.notifications[0]!.message, /Failed to reload context files: EACCES: permission denied/);
  assert.deepEqual(await h.runTurn(), [{ path: "/repo/AGENTS.md", content: "v1" }]);
});

test("rebrief does nothing when Pi was started with --no-context-files", async () => {
  const disk = { current: [{ path: "/repo/AGENTS.md", content: "v1" }] };
  const h = setup([], disk, { contextFilesDisabled: () => true });

  await h.rebrief();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.level, "warning");
  assert.match(h.notifications[0]!.message, /--no-context-files/);
  assert.deepEqual(h.baseOptions.contextFiles, []);
  assert.deepEqual(await h.runTurn(), []);
});

test("contextFilesDisabledByArgv detects both flag spellings", () => {
  assert.equal(contextFilesDisabledByArgv(["node", "pi", "--no-context-files"]), true);
  assert.equal(contextFilesDisabledByArgv(["node", "pi", "-nc"]), true);
  assert.equal(contextFilesDisabledByArgv(["node", "pi", "-c"]), false);
});

test("formatTokens formats token counts readably", () => {
  assert.equal(formatTokens(1), "1 token");
  assert.equal(formatTokens(850), "850 tokens");
  assert.equal(formatTokens(1_250), "1.3k tokens");
  assert.equal(formatTokens(48_000), "48k tokens");
  assert.equal(formatTokens(125_400), "125k tokens");
  assert.equal(formatTokens(1_500_000), "1.5M tokens");
});
