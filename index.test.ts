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
  describeChanges,
  renderProjectContext,
  withContextUpdate,
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

  let tick: (() => void) | undefined;
  const ext = createRebriefExtension({
    getAgentDir: () => "/fake/agent",
    loadProjectContextFiles: ({ cwd }) => {
      assert.equal(cwd, "/repo");
      return diskFilesRef.current.map((f) => ({ ...f }));
    },
    contextFilesDisabled: () => false,
    startTimer: (fn) => {
      tick = fn;
      return () => {
        tick = undefined;
      };
    },
    ...deps,
  });
  ext(pi);

  // Simulates AgentSession._baseSystemPromptOptions (which _rebuildSystemPrompt may reset to initialFiles)
  const baseOptions: BuildSystemPromptOptions = {
    cwd: "/repo",
    contextFiles: initialFiles.map((f) => ({ ...f })),
  };

  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<string | undefined> = [];
  let idle = true;

  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, text: string | undefined) {
        assert.equal(key, "pi-rebrief");
        statuses.push(text);
      },
      theme: { fg: (_color: string, text: string) => text },
    },
    isIdle: () => idle,
    getSystemPromptOptions: () => baseOptions,
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

  async function emitContext(messages: any[]): Promise<any[] | undefined> {
    for (const handler of eventHandlers.get("context_with_system") ?? []) {
      const result = await handler({ type: "context_with_system", messages }, ctx);
      if (result?.messages) return result.messages;
    }
    return undefined;
  }

  return {
    baseOptions,
    notifications,
    statuses,
    setIdle(value: boolean) {
      idle = value;
    },
    tick: () => tick?.(),
    hasTimer: () => tick !== undefined,
    emitContext,
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
  assert.equal(h.notifications[0]!.message, "Reloaded context files: changed AGENTS.md.");

  // Turn 1 sees v2
  assert.deepEqual(await h.runTurn(), [{ path: "/repo/AGENTS.md", content: "v2 - Ms. Pac-Man" }]);

  // Simulate AgentSession._rebuildSystemPrompt resetting _baseSystemPromptOptions back to startup v1
  h.baseOptions.contextFiles = [{ path: "/repo/AGENTS.md", content: "v1" }];

  // Turn 2 still sees v2 (no Turn-2 revert!)
  assert.deepEqual(await h.runTurn(), [{ path: "/repo/AGENTS.md", content: "v2 - Ms. Pac-Man" }]);
});

test("rebrief names the files that changed, were added, or were removed", async () => {
  const initial = [
    { path: "/repo/AGENTS.md", content: "v1" },
    { path: "/repo/old/CLAUDE.md", content: "gone" },
  ];
  const disk = {
    current: [
      { path: "/repo/AGENTS.md", content: "v2" },
      { path: "/repo/sub/AGENTS.md", content: "sub" },
    ],
  };
  const h = setup(initial, disk);

  await h.rebrief();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.level, "info");
  assert.equal(
    h.notifications[0]?.message,
    "Reloaded context files: changed AGENTS.md, added sub/AGENTS.md, removed old/CLAUDE.md.",
  );
});

test("rebrief reports unchanged when files on disk match current context files", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const disk = { current: [{ path: "/repo/AGENTS.md", content: "v1" }] };
  const h = setup(initial, disk);

  await h.rebrief();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]?.level, "info");
  assert.equal(
    h.notifications[0]?.message,
    "Context files unchanged (1 context file).",
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

test("describeChanges shortens paths outside cwd and caps the list", () => {
  const files = (contents: string[]) =>
    ["/repo/a.md", "/repo/b.md", "/repo/c.md", "/home/me/.pi/agent/AGENTS.md", "/etc/AGENTS.md"].map((path, i) => ({
      path,
      content: contents[i] ?? "",
    }));
  assert.equal(
    describeChanges(files(["1", "1", "1", "1", "1"]), files(["2", "2", "2", "2", "2"]), "/repo", "/home/me"),
    "changed a.md, b.md, c.md, and 2 more",
  );
  assert.equal(
    describeChanges(
      [{ path: "/home/me/.pi/agent/AGENTS.md", content: "1" }],
      [{ path: "/home/me/.pi/agent/AGENTS.md", content: "2" }],
      "/repo",
      "/home/me",
    ),
    "changed ~/.pi/agent/AGENTS.md",
  );
  const a = { path: "/repo/a.md", content: "a" };
  const b = { path: "/repo/b.md", content: "b" };
  assert.equal(describeChanges([a, b], [b, a], "/repo", "/home/me"), "order changed");
});

test("status bar warns when context files change on disk and clears after rebrief", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const disk = { current: initial.map((f) => ({ ...f })) };
  const h = setup(initial, disk);
  await h.emitSessionStart();

  h.tick();
  assert.deepEqual(h.statuses, []);

  disk.current = [{ path: "/repo/AGENTS.md", content: "v2" }];
  h.tick();
  h.tick();
  assert.deepEqual(h.statuses, ["● context files changed — /rebrief"]);

  await h.rebrief();
  h.tick();
  assert.deepEqual(h.statuses, ["● context files changed — /rebrief", undefined]);
});

test("no polling when Pi was started with --no-context-files", async () => {
  const h = setup([], { current: [] }, { contextFilesDisabled: () => true });
  await h.emitSessionStart();
  assert.equal(h.hasTimer(), false);
});

test("rebrief during a run updates the running turn until the next run starts", async () => {
  const initial = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const disk = { current: [{ path: "/repo/AGENTS.md", content: "v2" }] };
  const h = setup(initial, disk);
  const transcript = [
    { role: "system", content: "", sections: { project_context: renderProjectContext(initial) }, timestamp: 1 },
    { role: "user", content: "go", timestamp: 2 },
  ];
  assert.equal(await h.emitContext(transcript), undefined);

  h.setIdle(false);
  await h.rebrief();
  assert.equal(h.notifications[0]?.message, "Reloaded context files: changed AGENTS.md — applies to the running turn.");

  const next = [...transcript, { role: "assistant", content: [], timestamp: 3 }];
  const sent = await h.emitContext(next);
  assert.equal(sent?.length, 4);
  assert.equal(sent?.[3].role, "system");
  assert.deepEqual(sent?.[3].sections, { project_context: renderProjectContext(disk.current) });

  // Later requests keep the update at the same place
  const later = await h.emitContext([...next, { role: "toolResult", content: [], timestamp: 4 }]);
  assert.equal(later?.[3].role, "system");
  assert.equal(later?.length, 5);

  await h.runTurn();
  assert.equal(await h.emitContext(next), undefined);
});

test("withContextUpdate leaves a transcript that already has the files alone", () => {
  const files = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const messages = [{ role: "system", content: "", sections: { project_context: renderProjectContext(files) }, timestamp: 1 }];
  assert.equal(withContextUpdate(messages as any, files, 1, 9), undefined);
  assert.equal(renderProjectContext([]), null);
});
