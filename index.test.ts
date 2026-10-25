import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createRebriefExtension,
  describeChanges,
  renderProjectContext,
  type ContextFile,
} from "./index.ts";

// Minimal stand-in for Pi's extension host: records registered hooks and the /rebrief
// command, stubs disk loading and the poll timer so tests can drive them deterministically,
// and exposes the user-visible outputs (notifications and status bar text).
function setup(startupFiles: ContextFile[], { contextFilesDisabled = false } = {}) {
  let rebriefCommand!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();

  // Context files currently on disk; returned whenever the extension reloads from disk.
  let diskFiles = startupFiles.map((f) => ({ ...f }));
  // Callback the extension passes to startTimer on session_start, so tests can run a poll check on demand.
  let pollDisk: (() => void) | undefined;
  let agentIdle = true;
  let statusBar: string | undefined;
  const notices: string[] = [];

  const pi = {
    registerCommand(name: string, options: { handler: typeof rebriefCommand }) {
      if (name === "rebrief") rebriefCommand = options.handler;
    },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  createRebriefExtension({
    loadProjectContextFiles: () => diskFiles.map((f) => ({ ...f })),
    contextFilesDisabled: () => contextFilesDisabled,
    startTimer: (tick) => {
      pollDisk = tick;
      return () => {
        pollDisk = undefined;
      };
    },
  })(pi);

  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (_key: string, text: string | undefined) => {
        statusBar = text;
      },
      theme: { fg: (_color: string, text: string) => text },
    },
    isIdle: () => agentIdle,
  } as unknown as ExtensionCommandContext;

  return {
    notices,
    get statusBar() {
      return statusBar;
    },
    writeDisk(files: ContextFile[]) {
      diskFiles = files;
    },
    setAgentIdle(idle: boolean) {
      agentIdle = idle;
    },
    pollDisk: () => pollDisk?.(),
    isPolling: () => pollDisk !== undefined,
    rebrief: () => rebriefCommand("", ctx),
    startSession: () => handlers.get("session_start")?.({ type: "session_start" }, ctx),
    // Runs before_agent_start for a new turn and returns the contextFiles the turn will use.
    async startTurn(): Promise<ContextFile[]> {
      const systemPromptOptions = { cwd: "/repo", contextFiles: startupFiles.map((f) => ({ ...f })) };
      await handlers.get("before_agent_start")?.(
        { type: "before_agent_start", systemPromptOptions } as BeforeAgentStartEvent,
        ctx,
      );
      return systemPromptOptions.contextFiles;
    },
    // Runs context_with_system before an LLM request inside a turn; returns the modified transcript, if any.
    prepareRequest(messages: any[]): any[] | undefined {
      return handlers.get("context_with_system")?.({ type: "context_with_system", messages }, ctx)?.messages;
    },
  };
}

test("/rebrief between turns reloads context files for subsequent turns", async () => {
  const v1 = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const v2 = [{ path: "/repo/AGENTS.md", content: "v2" }];
  const session = setup(v1);
  await session.startSession();

  // User edits AGENTS.md and runs /rebrief while the agent is idle.
  session.writeDisk(v2);
  await session.rebrief();
  assert.equal(session.notices.at(-1), "Reloaded context files: changed AGENTS.md.");

  // The next turn builds its system prompt with the reloaded file.
  assert.deepEqual(await session.startTurn(), v2);

  // Running /rebrief again with no further edits reports that nothing changed.
  await session.rebrief();
  assert.equal(session.notices.at(-1), "Context files unchanged (1 context file).");
});

test("status bar flags when context files change on disk and clears after /rebrief", async () => {
  const v1 = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const session = setup(v1);
  await session.startSession();

  // Disk matches what the session loaded: no warning in the status bar.
  session.pollDisk();
  assert.equal(session.statusBar, undefined);

  // A file changes on disk (e.g. after git pull): the next poll shows the warning.
  session.writeDisk([{ path: "/repo/AGENTS.md", content: "v2" }]);
  session.pollDisk();
  assert.equal(session.statusBar, "● context files changed — /rebrief");

  // Running /rebrief reloads the file and clears the warning.
  await session.rebrief();
  assert.equal(session.statusBar, undefined);
});

test("/rebrief mid-turn injects the new instructions into the running turn", async () => {
  const v1 = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const v2 = [{ path: "/repo/AGENTS.md", content: "v2" }];
  const session = setup(v1);
  await session.startSession();

  // A turn is already running with v1 in its initial system message.
  session.setAgentIdle(false);
  const turnStart = [
    { role: "system", content: "", sections: { project_context: renderProjectContext(v1) }, timestamp: 1 },
    { role: "user", content: "go", timestamp: 2 },
  ];

  // User edits AGENTS.md and runs /rebrief while the agent is working.
  session.writeDisk(v2);
  await session.rebrief();
  assert.equal(session.notices.at(-1), "Reloaded context files: changed AGENTS.md — applies to the running turn.");

  // Before the agent's next model call in this turn, a system section update with v2 is appended.
  const afterAssistantStep = [...turnStart, { role: "assistant", content: [], timestamp: 3 }];
  const requestMessages = session.prepareRequest(afterAssistantStep);
  assert.deepEqual(requestMessages?.at(-1)?.sections, { project_context: renderProjectContext(v2) });

  // Later requests in the same turn keep the update where it was first inserted, not at the end,
  // so it reads as happening at that point and the cached prefix stays the same.
  const afterToolResult = [...afterAssistantStep, { role: "toolResult", content: [], timestamp: 4 }];
  const laterRequest = session.prepareRequest(afterToolResult);
  assert.equal(laterRequest?.length, 5);
  assert.deepEqual(laterRequest?.[3]?.sections, { project_context: renderProjectContext(v2) });
  assert.equal(laterRequest?.at(-1)?.role, "toolResult");

  // Once the next turn starts, its own system prompt has v2, so per-request injection stops.
  await session.startTurn();
  assert.equal(session.prepareRequest(afterAssistantStep), undefined);
});

test("with --no-context-files, nothing is watched and /rebrief does nothing", async () => {
  const v1 = [{ path: "/repo/AGENTS.md", content: "v1" }];
  const session = setup(v1, { contextFilesDisabled: true });
  await session.startSession();
  assert.equal(session.isPolling(), false);

  // Editing a file and running /rebrief leaves the next turn untouched.
  session.writeDisk([{ path: "/repo/AGENTS.md", content: "v2" }]);
  await session.rebrief();
  assert.equal(session.notices.at(-1), "Context files are disabled (--no-context-files) — nothing to rebrief.");
  assert.deepEqual(await session.startTurn(), v1);
});

test("describeChanges summarizes changed, added, and removed files with readable paths", () => {
  assert.equal(
    describeChanges(
      [
        { path: "/repo/AGENTS.md", content: "v1" },
        { path: "/repo/old/CLAUDE.md", content: "gone" },
      ],
      [
        { path: "/repo/AGENTS.md", content: "v2" },
        { path: "/home/me/.pi/agent/AGENTS.md", content: "global" },
      ],
      "/repo",
      "/home/me",
    ),
    "changed AGENTS.md, added ~/.pi/agent/AGENTS.md, removed old/CLAUDE.md",
  );
});
