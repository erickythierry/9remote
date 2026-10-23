# Claude Code CLI and Chat UI Integration Plan

This document defines the implementation plan to achieve full feature parity between the Claude Code terminal CLI and the 9remote web chat user interface (Chat UI). The objective is to make the terminal view optional so the operator can control, inspect, and approve all Claude Code workflows entirely from the chat interface.

The design supports multiple Claude Code profiles (`~/.claude`, `~/.claude-*`, and custom launcher directories) automatically and without manual configuration.

---

## 1. Architectural Strategy and Parity Gaps

### Current Architecture
* **Execution:** 9remote launches the Claude Code CLI inside a pseudo-terminal (PTY) managed by `ptyDaemon`.
* **State synchronization:** 9remote tails the session `.jsonl` transcript file (`claudeTranscript.ts`).
* **Interception:** 9remote injects lifecycle hooks (`PreToolUse` and `PermissionRequest`) to intercept questions through `/api/claude/question`.

### Root Causes of Terminal Dependence
1. **Interactive Ink prompts:** Folder trust dialogs, permission bypass prompts, and model selectors use terminal cursor keys. If 9remote fails to detect them, the process waits in the terminal.
2. **Limited hook response contracts:** 9remote supports only binary `allow` or `deny` decisions. Claude Code supports parameter modification via `updatedInput` before execution starts.
3. **Subagent visibility limits:** Background agents write to separate transcript files (`subagents/agent-<id>.jsonl` and `tasks/<id>.output`). 9remote does not link these tasks dynamically in real time.
4. **Context compaction silence:** Context compaction removes history without notifying the Chat UI. The chat timeline suddenly loses context records.
5. **MCP server elicitation blocks:** Interactive credential requests (`Elicitation`) block the terminal because 9remote does not hook the event.

---

## 2. Component Implementation Plan

### Phase 1: Universal Multi-Profile Hook Pipeline

#### Goal
Ensure all Claude Code profiles receive the complete set of 9remote lifecycle hooks automatically.

#### Changes in `host/features/terminal/hookManager.ts`
1. **Profile discovery expansion:**
   Ensure `claudeSettingsFiles()` detects:
   * Default directory: `~/.claude/settings.json`
   * Environment directory: `$CLAUDE_CONFIG_DIR/settings.json`
   * Suffix patterns: `~/.claude-*/settings.json`
   * Custom launcher profiles configured in 9remote settings.

2. **Hook registration additions:**
   Register the following new lifecycle hooks in every discovered `settings.json`:
   ```json
   {
     "hooks": {
       "SubagentStart": [
         {
           "type": "command",
           "command": "curl -s --max-time 2 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:${PORT}/api/notify?type=subagent_start&sessionId=$NINE_REMOTE_SESSION_ID&tool=claude' >/dev/null 2>&1 & true"
         }
       ],
       "SubagentStop": [
         {
           "type": "command",
           "command": "curl -s --max-time 2 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:${PORT}/api/notify?type=subagent_stop&sessionId=$NINE_REMOTE_SESSION_ID&tool=claude' >/dev/null 2>&1 & true"
         }
       ],
       "PreCompact": [
         {
           "type": "command",
           "command": "curl -s --max-time 2 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:${PORT}/api/notify?type=pre_compact&sessionId=$NINE_REMOTE_SESSION_ID&tool=claude' >/dev/null 2>&1 & true"
         }
       ],
       "PostCompact": [
         {
           "type": "command",
           "command": "curl -s --max-time 2 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:${PORT}/api/notify?type=post_compact&sessionId=$NINE_REMOTE_SESSION_ID&tool=claude' >/dev/null 2>&1 & true"
         }
       ],
       "Elicitation": [
         {
           "type": "command",
           "command": "curl -s --max-time 120 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://localhost:${PORT}/api/claude/question?sessionId=$NINE_REMOTE_SESSION_ID&tool=claude' 2>/dev/null; true",
           "timeout": 120
         }
       ]
     }
   }
   ```

3. **Atomic workspace trust bypass:**
   In `claudeTerminal.ts:confirmTrust()`, avoid sending simulated keystrokes (`ARROW_DOWN` and `\r`). Write directory trust directly into the profile state file (`.claude.json`):
   ```typescript
   export function preTrustDirectory(cwd: string, launcher: string = ""): void {
     const statePath = claudeStateFile(claudeConfigDir(launcher));
     const state = readJsonFile<{ projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }>(statePath);
     state.projects = state.projects || {};
     state.projects[path.resolve(cwd)] = { hasTrustDialogAccepted: true };
     writeJsonAtomic(statePath, state, { mode: 0o644 });
   }
   ```
   Execute `preTrustDirectory(s.cwd)` before booting the PTY process. This completely eliminates the startup trust dialog in the terminal.

---

### Phase 2: Interactive Permission Editing and Elicitation

#### Goal
Allow the user to modify tool commands before approval (for example, edit a Bash command in the chat card) and handle interactive MCP server prompts.

#### Changes in `host/api/question.ts`
1. Support `updatedInput` payloads in `handleQuestionPost`:
   ```typescript
   if (hook.hook_event_name === "PermissionRequest") {
     const decision = await terminal.ask(
       `${PERMISSION_GATE_PREFIX}${Date.now()}`,
       toolName,
       input,
       CLAUDE_QUESTION_WAIT_MS
     );
     if (!decision) return res.end();

     // Support parameter overrides from the Chat UI
     const updatedInput = decision.updatedInput || input;
     return reply(res, {
       hookEventName: "PermissionRequest",
       decision: decision.behavior === "allow"
         ? { behavior: "allow", updatedInput }
         : { behavior: "deny", message: decision.message || "Denied from the chat." }
     });
   }
   ```

2. Add `Elicitation` handler for MCP credentials:
   ```typescript
   if (hook.hook_event_name === "Elicitation") {
     const credentials = await terminal.ask(
       `elicitation-${Date.now()}`,
       hook.mcp_server_name,
       { schema: hook.schema, message: hook.message },
       CLAUDE_QUESTION_WAIT_MS
     );
     if (!credentials) return res.end();
     return reply(res, {
       hookEventName: "ElicitationResult",
       result: credentials
     });
   }
   ```

#### Changes in Web UI (`web/features/ai/components/cards/AiPermissionCard.tsx`)
* Add an inline edit toggle to the permission card.
* When active for `Bash`, display an editable command input.
* Transmit `{ behavior: "allow", updatedInput: { command: editedCommand } }` to `resolveQuestion`.

---

### Phase 3: Subagent Tracking and Swarm Visualization

#### Goal
Represent subagents, background daemon tasks, and concurrent workers as nested execution trees inside the chat view.

#### Architecture
```
Chat Turn (Parent Agent)
    │
    ├── Tool Card: Agent ("Investigate modules")
    │     │
    │     ├── [Subagent Badge: Running | ID: sub-48fa]
    │     │     │
    │     │     ├── Step 1: Read chunk-5hada5qy.js
    │     │     ├── Step 2: Bash grep "updatedToolOutput"
    │     │     └── Result: Summary report
    │     │
    │     └── Completed in 4.2s (Tokens: 12.4k)
    │
    └── Assistant Response
```

#### Implementation Steps
1. **Dynamic discovery in `claudeTerminal.ts:readAgents()`:**
   * Watch the `<session-id>/subagents/` directory using file system notifications (`fs.watch`) instead of fixed polling.
   * Parse `agent-<id>.meta.json` immediately when created to associate child turns with the parent `tool_use_id`.
   * Stream child turn events with `parentToolUseId` tags.

2. **Background output tailing in `claudeTerminal.ts:readShells()`:**
   * Read `tasks/<id>.output` dynamically.
   * Emit intermediate chunks to `aiSocket.ts` as `tool_progress` events.
   * Mark background tasks as active until the harness emits the `TaskCompleted` notification.

3. **Web Chat Component (`web/features/ai/components/cards/AiAgentCard.tsx`):**
   * Render an expandable nested container for subagent execution steps.
   * Provide a direct action button: **Stop Subagent** (invoking `TaskStop` internally).
   * Provide an action button: **Message Subagent** (invoking `SendMessage` internally).

---

### Phase 4: Context Compaction and History Demarcation

#### Goal
Show clear visual indicators when the agent summarizes context, preventing confusion when older turns disappear from model memory.

#### Implementation Steps
1. **Event detection in `claudeTranscript.ts`:**
   * Identify transcript entries where `record.isCompactSummary === true`.
   * Identify `PostCompact` notifications from hooks.

2. **Event emission:**
   * Emit normalized event `context_compacted` with payload:
     ```json
     {
       "timestamp": 1729712000000,
       "summary": "Context summarized to 1,200 tokens.",
       "tokensSaved": 48500
     }
     ```

3. **Web Chat Presentation (`web/features/ai/components/AiMessagesList.tsx`):**
   * Render a distinct divider:
     ```
     ─── Context Compacted (48.5k tokens freed) ───
     [View archived conversation summary]
     ```

---

### Phase 5: Output Filter and Truncation Telemetry

#### Goal
Detect when a local hook or plugin replaces a tool result using `updatedToolOutput`, and alert the operator if output truncation occurs.

#### Implementation Steps
1. **Transcript inspection in `claudeTranscript.ts`:**
   * Compare `tool_result` byte length against known executed command outputs.
   * Detect signature warning markers (such as shell filter notices).
2. **Notification in Web Chat:**
   * Render an indicator badge on the tool card: `[Output modified by hook]`.
   * Prevent broken diff views by offering an option to reload the original file from disk.

---

### Phase 6: Out-of-Turn Slash Command Execution

#### Goal
Execute model switching, effort adjustments, and session resets without terminal keyboard entry.

#### Implementation Steps
1. **Direct execution in `claudeTerminal.ts:applyOptions`:**
   * For `/model` and `/effort`, check if the turn is running.
   * If running, queue the option change. Apply the command immediately when the turn concludes.
2. **Session reset `/clear`:**
   * Provide a clean reset function that restarts the PTY with `--session-id <new-uuid>` instead of typing `/clear` into an active prompt.

---

## 3. Implementation Verification Checklist

- [ ] **Multi-profile verification:** Run tests against `~/.claude`, a secondary `~/.claude-work`, and a custom launcher path. Verify hooks install in all profiles.
- [ ] **Trust bypass verification:** Start a session in a new unvisited folder. Confirm that Claude Code starts without displaying the Ink folder trust prompt.
- [ ] **Parameter edit verification:** Trigger a mutating command (`Bash`). In the Chat UI permission card, edit the command string and click approve. Confirm Claude Code executes the edited command.
- [ ] **Subagent tree verification:** Run a prompt that launches subagents (for example, `/code-review` or `/simplify`). Confirm that subagent steps render inside the nested card in the Chat UI.
- [ ] **Context compaction verification:** Trigger `/compact`. Verify that the compaction divider renders cleanly in the Chat UI timeline.
- [ ] **Interactive elicitation verification:** Connect an MCP server that requires credentials. Confirm that the credential card renders in the Chat UI and unlocks the server.
