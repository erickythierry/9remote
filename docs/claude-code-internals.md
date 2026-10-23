# Claude Code CLI Architecture and Internal Mechanisms

This document describes the internal architecture, runtime mechanisms, and execution flow of the Claude Code CLI (v2.1.309). It provides the technical foundation for native pairing between the terminal session and the 9remote chat interface.

---

## 1. Binary Packaging and Extraction Architecture

The Claude Code binary (`~/.local/share/mise/installs/claude/latest/claude`) is a 293 MB standalone executable created with `bun build --compile`.

### Binary Structure
* **Container format:** 64-bit ELF executable containing the Bun runtime and an appended `.bun` container section.
* **Section offset:** The `.bun` section starts at byte offset `115,335,168` and spans `178,077,618` bytes.
* **Module graph metadata:** The container ends with a 32-byte header struct and the sentinel bytes `\n---- Bun! ----\n`.
* **Module inventory:** 2,538 JavaScript/JSX modules, 141 file loaders, 105 binary assets, and 2 text assets.
* **Bytecode compilation:** Bun executes embedded JavaScriptCore (JSC) bytecode for speed. The embedded JavaScript source text remains intact in the section and totals 48.8 MB across 2,538 files.
* **Entry point:** `/$bunfs/root/cli` routes directly to `0007-cli.js`, which dynamically imports `0837-chunk-wthp4fjw.js`.

---

## 2. Agent Execution Loop (`mainLoop` and `queryModel`)

The core execution loop resides in `0837-chunk-wthp4fjw.js` and `0486-chunk-5hada5qy.js`.

### Turn Lifecycle
```
User Prompt
    │
    ▼
[Hook: UserPromptSubmit] ── (Can modify prompt or block)
    │
    ▼
[Request Builder: queryModel]
    │  - Model identification and active system prompt
    │  - Full message transcript with role attribution
    │  - Tool schemas (base tools + dynamically discovered tools)
    │  - Extended thinking configuration (budget and adaptive flags)
    │  - Context management settings (compaction boundaries)
    ▼
[Anthropic API Stream]
    │  - SSE stream emits content_block_delta
    │  - Delta types: text_delta, thinking_delta, input_json_delta
    │  - Message delta provides stop_reason
    ▼
Stop Reason Decision:
  ├── "end_turn"  ──► Emit assistant message, trigger [Hook: Stop], await next user turn.
  └── "tool_use"  ──► Route block array to [executeTool Queue].
```

### Context Compaction
1. When conversation token count exceeds the model limit, the agent triggers automatic compaction.
2. The runtime fires `PreCompact` with trigger type (`auto` or `manual`).
3. The model generates a structured summary turn. The runtime tags this record with `isCompactSummary: true`.
4. The runtime fires `PostCompact` and discards older message records from the active prompt window.

---

## 3. Tool System Architecture

Tool dispatching, permission evaluation, and execution run through `0722-chunk-v553rh4j.js` (`executeTool`) and `0486-chunk-5hada5qy.js` (`Y2`, `T7r`, `A7r`).

### Concurrency and Scheduling
* Every tool declares its concurrency safety through `isConcurrencySafe()`.
* **Parallel execution:** Read-only and idempotent tools (`Read`, `Glob`, `Grep`, `ToolSearch`) execute concurrently via `Promise.all`.
* **Serial execution:** Mutating tools (`Bash`, `Write`, `Edit`, `Agent`) block the execution queue. The scheduler drains all running concurrent tasks before starting a serial task.

### Tool Execution Sequence
```
Tool Call Request
    │
    ▼
1. Schema Validation (VNn)
    │  - Validates tool input against Zod schema.
    │  - Malformed JSON generates immediate InputValidationError.
    ▼
2. Deferred Tool Check (C7r)
    │  - Verifies if the schema was sent to the model.
    │  - If deferred and not loaded via ToolSearch, rejects with tool_not_loaded.
    ▼
3. Pre-Tool Execution Hooks
    │  - Dispatches [Hook: PreToolUse].
    │  - Hook can return updatedInput or deny execution.
    ▼
4. Permission Evaluation (A7r / canUseTool)
    │  - Evaluates active permission mode (default, acceptEdits, bypassPermissions).
    │  - If untrusted, fires [Hook: PermissionRequest].
    │  - If user/hook denies, records toolDenialKind and halts execution.
    ▼
5. Tool Invocation (e.call)
    │  - Executes native Node/Bun logic or spawns child process.
    │  - Emits progress events and tool_heartbeat over an internal channel.
    ▼
6. Post-Tool Execution Hooks (ePr)
    │  - Dispatches [Hook: PostToolUse].
    │  - Hook receives tool output and execution duration.
    │  - Hook can return updatedToolOutput to replace tool result data.
    ▼
7. Result Delivery
    │  - Formats content into tool_result block.
    │  - Writes turn entry into session transcript (.jsonl).
```

### Output Rewriting Mechanism (`updatedToolOutput`)
In `0486-chunk-5hada5qy.js:4038397` and `1696-chunk-tc2s6f0z.js`:
* `PostToolUse` hooks can return an object containing `updatedToolOutput`.
* The runtime checks:
  ```javascript
  if ("updatedToolOutput" in H && h.outputSchema?.safeParse(H.updatedToolOutput)?.success !== false) {
    N = H.updatedToolOutput;
  }
  ```
* When this occurs, the runtime discards original command stdout/stderr. The model sees only the filtered text. Plugins designed to compress token usage exploit this hook. If aggressive truncation occurs, the model detects unexpected brevity and outputs shell-filter warnings.

---

## 4. Complete Lifecycle Hook Reference

The Claude Code runtime contains 28 canonical lifecycle hook events defined at `0486-chunk-5hada5qy.js:4309803`:

| Event Name | Trigger Stage | Input Payload | Output Capabilities |
|---|---|---|---|
| `SessionStart` | CLI starts or resumes a session | `source`, `sessionId`, `model` | Injects `additionalContext` and `initialUserMessage` |
| `UserPromptSubmit` | User submits text in prompt | `prompt`, `session` | Alters prompt, suppresses input, or blocks turn |
| `UserPromptExpansion` | Slash command or skill invoked | `command_name`, `command_args` | Injects instructions into prompt buffer |
| `PreToolUse` | Before tool execution begins | `tool_name`, `tool_input`, `tool_use_id` | Can provide `updatedInput` or deny call |
| `PostToolUse` | After tool execution succeeds | `tool_name`, `tool_input`, `tool_output` | Can replace output via `updatedToolOutput` |
| `PostToolUseFailure` | Tool throws an unhandled error | `tool_name`, `error`, `durationMs` | Error reporting and failure telemetry |
| `PostToolBatch` | Parallel tool batch finishes | `tool_calls[]`, `durationMs` | Batch auditing and metrics recording |
| `PermissionRequest` | Tool requires user authorization | `tool_name`, `tool_input` | Returns `{ decision: { behavior: "allow" \| "deny" } }` |
| `PermissionDenied` | Tool call rejected by policy | `tool_name`, `reason` | Records audit log and permission telemetry |
| `Notification` | System emits alert/question | `type`, `message` | Relays notification to external surfaces |
| `Stop` | Turn finishes normally | `durationMs`, `usage`, `model` | Displays turn summaries, cleans temp resources |
| `StopFailure` | Turn crashes or aborts | `error`, `reason` | Emits crash diagnostics |
| `SubagentStart` | Subagent process initialized | `agentId`, `subagent_type`, `prompt` | Tracks multi-agent execution hierarchy |
| `SubagentStop` | Subagent process terminates | `agentId`, `status`, `usage` | Receives final subagent payload |
| `TaskCreated` | Async background task queued | `taskId`, `description` | Registers task in external job list |
| `TaskCompleted` | Async background task completed | `taskId`, `outputFile` | Notifies main agent with completed output |
| `PreCompact` | Context compaction starts | `trigger` (`auto` \| `manual`) | Backs up memory before context loss |
| `PostCompact` | Context compaction finishes | `compactSummary`, `tokensSaved` | Notifies UI of historical demarcations |
| `PreModelSwitch` | Model transition initiated | `from_model`, `to_model` | Verifies quotas for target model |
| `PostModelSwitch` | Model transition completed | `to_model`, `status` | Updates telemetry and token rate counters |
| `Setup` | Initial configuration runs | `trigger` | Validates environment and installed tools |
| `TeammateIdle` | Agent swarm member waits | `agentId`, `mailbox` | Triggers scheduler work reallocation |
| `Elicitation` | MCP server requests user input | `mcp_server_name`, `schema` | Prompts user for interactive credentials |
| `ElicitationResult` | User responds to MCP input | `mcp_server_name`, `result` | Transmits credentials to server |
| `ConfigChange` | Setting file updated on disk | `key`, `oldValue`, `newValue` | Reloads modified configuration dynamically |
| `InstructionsLoaded` | CLAUDE.md loaded or changed | `path`, `contentLength` | Validates active operational rules |
| `DirectoryAdded` | Working tree directory mounted | `path` | Refreshes repository file search indexes |

---

## 5. Subagents and Background Architecture

Subagents run through the `Agent` tool (`0674-chunk-0jnhrvcq.js` and `0449-chunk-9ps37sk6.js`). The CLI supports three operational modes:

### 1. In-Process Fork (`fork`)
* **Execution:** Runs in the same process memory space via `runEngine`.
* **State inheritance:** Inherits conversation context, tool state, and permission mode from the parent turn.
* **Result delivery:** Synchronous return via `SubagentHandback`.

### 2. Async Background Daemon (`async_launched`)
* **Execution:** Spawns a detached background CLI process with flags `--bg`, `--daemon-worker`, or `--bg-pty-host`.
* **Identification:** Generates a distinct `agentId`.
* **Output tracking:** Writes stream output to `tasks/<agentId>.output`.
* **Completion signal:** Dispatches `TaskCompleted` event. The parent agent receives a synthetic notification turn.

### 3. Multi-Agent Swarm (`teammate_spawned`)
* **Communication:** Operates via message queues and mailboxes.
* **Coordination tools:** Agents communicate using `SendMessage({ to: "<agentId>", message: "..." })` and discover peers with `ListAgents`.

---

## 6. Integration Architecture for 9remote

9remote currently interfaces with Claude Code through PTY terminal emulation and transcript streaming (`host/features/ai/claudeTerminal.ts` and `claudeTranscript.ts`).

### Current Integration Model
1. **PTY Command Injection:** Writes text into the terminal PTY with bracketed paste escapes (`\x1b[200~ ... \x1b[201~`).
2. **Transcript Following:** Monitors `~/.claude/projects/<slug>/<sessionId>.jsonl` using a file descriptor tail reader.
3. **Question and Permission Hooks:** Configures HTTP webhook callbacks in `~/.claude/settings.json` that POST to `/api/claude/question` on `PreToolUse:AskUserQuestion` and `PermissionRequest`.

### Architecture Recommendations for Full Native Parity

To match Claude Code native behavior inside the 9remote web interface, apply the following integration upgrades:

#### A. Real-Time Subagent Hierarchy (`SubagentStart` / `SubagentStop`)
* **Current state:** Background subagents create separate `sdk-cli` transcripts. The 9remote chat interface hides or separates these runs.
* **Improvement:** Configure `SubagentStart` and `SubagentStop` hooks in `hookManager.ts`. When a subagent starts, register its `agentId` as a child node in `aiManager`. Render the subagent as an expandable nested card under the parent `Agent` tool call.

#### B. Tool Progress and Heartbeat Stream
* **Current state:** Long-running tools show no output until completion.
* **Improvement:** Listen for `progress` and `tool_heartbeat` event types emitted by `AT` channels in `0722-chunk-v553rh4j.js`. Stream intermediate progress text directly to `aiSocket.ts` so the user sees live execution status.

#### C. Context Compaction Marker
* **Current state:** Compaction removes historical context silently.
* **Improvement:** Catch records with `isCompactSummary: true` and hook `PostCompact`. Display a clear horizontal separator in the chat view: *"Previous context compacted to save tokens"*.

#### D. Detection of Output Rewriting
* **Current state:** Truncated tool results caused by local plugin hooks can confuse the user and break editor diff views.
* **Improvement:** Inspect transcript metadata for `updatedToolOutput` overrides. Flag rewritten outputs in the UI with an informative badge.
