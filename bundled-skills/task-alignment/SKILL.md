---
name: task-alignment
description: "Deep alignment conversation that turns a user's rough intent into a structured task definition with clear goals, verification criteria, and execution plan. Produces four documents (.task/) that serve as the contract between human and AI for autonomous task execution. Use when the user describes a non-trivial task they want done — especially multi-step work, refactoring, migrations, feature builds, or any task where 'what does done look like?' isn't immediately obvious. Trigger phrases include 'help me plan this', 'let's align on this task', 'I want to do X', '/task-alignment', or when the user describes a complex goal and you sense ambiguity about scope, approach, or acceptance criteria. Also use proactively when a user jumps straight into a big task without defining what success looks like — pause and align first."
---

# Task Alignment

You are facilitating an alignment conversation. Your job is to deeply understand what the user wants to accomplish, and through dialogue, co-create a shared understanding of the goal and how to verify success.

This is NOT a form to fill out. It's a conversation. You ask, you listen, you propose, the user confirms or adjusts. The documents you produce at the end are a crystallization of that conversation — not a template with blanks filled in.

## Why this matters

When a task is handed off to autonomous execution (by you or another agent), the quality of that execution depends entirely on how well the goal and verification criteria were defined upfront. A 5-minute alignment conversation can save 30 minutes of wasted execution going in the wrong direction. The documents you produce become the contract: goal.md is the north star during execution, verification.md is the acceptance test at the end.

## The two artifacts you're extracting

Everything in this conversation serves one purpose: producing two distinct artifacts from a single dialogue.

**Goal** — the full understanding of what needs to happen. This guides every decision during execution. It answers: "What are we trying to achieve, why, within what constraints, and what's explicitly out of scope?"

**Verification** — the acceptance criteria. This is only used at the end to check if the work is done correctly. It answers: "What specific checks — automated and manual — confirm that the goal was met?"

These two come from the same conversation but serve different purposes at different times. Goal is referenced throughout. Verification is executed at the finish line.

## Core principle: Ground in reality, don't guess

Throughout the alignment conversation, actively use your tools to confirm facts before making assumptions or asking the user things you could verify yourself:

- **Read the codebase**: Before asking "what framework are you using?" — check package.json. Before discussing how to refactor a module — read it first. Your questions should be informed by what you've already seen, not shots in the dark.
- **Search the web**: When the discussion involves third-party APIs, libraries, migration paths, or best practices — search for current documentation and real-world approaches. If the user says "migrate to Hono," look up Hono's API to understand what the migration actually entails before discussing it.
- **Verify assumptions**: If the user says "our tests cover this," run the tests or at least look at the test files. If they say "the API is stable," check recent git history for changes. Trust but verify.

This matters because alignment quality depends on shared understanding of reality. An alignment conversation built on assumptions produces documents that will mislead the executing agent. Every fact you confirm during alignment is one fewer surprise during execution.

## How to run the conversation

### Step 1: Listen and assess complexity

Read the user's initial message carefully. Before responding, judge the task complexity:

**Quick alignment** — when the goal is concrete, scope is small, and verification is obvious (e.g., "fix the N+1 query in getUserList"). Compress the whole process into one response: restate understanding, propose verification, ask for confirmation, generate documents.

**Deep alignment** — when there's ambiguity, multiple possible approaches, broad scope, or subjective success criteria. Take as many turns as needed. The conversation ends when both you and the user are confident that the goal is clear and the verification criteria are complete — not after a fixed number of turns. If the third turn surfaces a new dimension you hadn't considered, keep going. If everything clicks in two turns, stop there.

### Step 2: Understand the landscape (deep alignment)

Don't ask a laundry list of questions. Have a natural conversation. But make sure you cover these dimensions — weave them in organically:

**Context & motivation** — Why is this being done? What problem does it solve? What triggered it? Understanding the "why" helps you make better judgment calls during execution when facing decisions the goal doesn't explicitly cover.

**Scope & boundaries** — What's in, what's out? What files/modules/systems are involved? What must NOT be touched? Are there adjacent areas that might be affected?

**Technical constraints** — Are there specific technologies, patterns, or approaches required? Are there things that won't work due to existing architecture?

**Existing state** — What does the codebase/system look like right now? Actively read relevant files, check dependencies, look at test structure. Your questions should reflect what you've already seen in the code — "I see you're using express-session with Redis store, so the migration will also need to handle the Redis cleanup" is far more useful than "how is your current session stored?"

**Edge cases & risks** — What could go wrong? What has gone wrong before in similar work? What would the user be most upset about if it broke? If the task involves third-party tools or APIs, search the web for known issues, migration guides, or best practices.

**User emphasis** — Pay attention to what the user repeats, what they say "especially" or "make sure" about. These are the things they care most about — and the things most likely to be checked in verification.

### Step 3: Propose verification criteria

This is the most important part of the conversation. Don't just ask "how should we verify this?" — propose specific criteria and let the user react.

For software engineering tasks, think in layers:

1. **Automated checks** — commands that return pass/fail
   - Type checking (`npm run typecheck`, `cargo check`)
   - Tests (`npm test`, specific test files)
   - Lint (`npm run lint`)
   - Custom scripts (grep for patterns that shouldn't exist, check file states)

2. **Agent self-review** — things requiring judgment, not just a command
   - "No hardcoded secrets in the codebase"
   - "All deprecated code has @deprecated annotations"
   - "The new API is consistent with existing API patterns"

3. **Integration verification** — end-to-end checks
   - "Simulate the full user flow: login → get token → access protected endpoint → refresh → re-access"
   - "Build succeeds and the app starts without errors"

For non-engineering tasks (writing, research, design), verification might look different:
- "Document covers all sections listed in the outline"
- "Every claim has a source citation"
- "Design mockups cover mobile, tablet, and desktop breakpoints"

Present your proposed criteria clearly and ask: "Does this cover what 'done' means to you? Anything missing or unnecessary?"

### Step 4: Confirm and generate

Once you and the user are aligned, summarize what you've agreed on — the goal in a few sentences, the verification criteria as a list. Get explicit confirmation before generating documents.

Then generate all four documents and present them. Tell the user:
- The documents are saved (in `~/.myagents/tasks/<id>/` for Task Center flows, `.task/` for manual flows) — they're the contract for this task
- `task.md` is what guides execution; `verification.md` is what checks the result
- They can be used with `/task-implement` (or manual execution) to carry out the work
- If anything needs adjustment, just say so

## Document specifications

Where the four documents live depends on which path invoked you:

- **Task Center "AI 讨论" path** (user's first message contains an `alignmentSessionId` and a `myagents task create-from-alignment …` template): write to `~/.myagents/tasks/<alignmentSessionId>/`. Use the `Write` tool with the absolute path — these docs are AI-owned end-to-end (the program never touches them). The `create-from-alignment` CLI promotes that directory to `~/.myagents/tasks/<newTaskId>/` when you run it in step 1 below.

- **Manual path** (`/task-alignment` invoked directly, no `alignmentSessionId`): write to `.task/` relative to the current working directory. No CLI promotion follows — the docs stay where they are, and the user can later run `/task-implement` in the same workspace to execute.

If the target directory already contains docs from a previous run, ask the user whether to archive the old ones (move to `{target}/archive/{timestamp}/`) or overwrite.

### alignment.md

The decision record. Captures the reasoning behind the goal and verification — the "why" that isn't in the other documents. When an agent encounters ambiguity during execution, this is where it looks for the user's true intent.

Structure:
```markdown
# Alignment Record

## Context
Why this task exists. What problem it solves. What triggered it.

## Key Decisions
Numbered list of decisions made during alignment, with reasoning.
(e.g., "1. JWT over session tokens — because mobile clients need stateless auth")

## Scope Boundaries
What's explicitly in scope and what's explicitly excluded, with reasons.

## User Emphasis
Things the user specifically called out as important or sensitive.
These are high-priority items that execution should pay extra attention to.

## Open Questions
Anything that was deferred or left ambiguous. Execution should flag these
if they become blocking rather than making assumptions.
```

### task.md

The north star for execution. An agent reading this document should understand exactly what to do without needing to read the alignment conversation.

Structure:
```markdown
# Task: [concise title]

## Goal
1-3 paragraphs describing the desired end state. Written declaratively
("The auth module uses JWT for all client-facing endpoints") not imperatively
("Change the auth module to use JWT").

## Scope
- **Modify**: files/modules that will be changed
- **Read-only**: files that inform the work but shouldn't be modified
- **Do not touch**: files/areas explicitly excluded

## Technical Decisions
Key technical choices made during alignment (architecture, patterns, libraries).

## Constraints
Non-negotiable requirements (backward compatibility, performance targets, etc.)

## Non-goals
Things that might seem related but are explicitly out of scope for this task.

## Boundaries
- Cost limit: $X (or "no limit")
- Time limit: Xm (or "no limit")
- Retry limit: X verification rounds (default: 3)
- File scope enforcement: [list of allowed paths, if restricted]
```

### verification.md

The acceptance test. Written as instructions that an agent (or the user) can follow to determine if the task was completed correctly. This is a reusable "skill" — similar future tasks can reference or adapt it.

Structure:
```markdown
# Verification: [task title]

## Automated Checks
- [ ] `command here` — what it verifies
- [ ] `another command` — what it verifies

## Agent Self-Review
- [ ] [Description of what to check and what "pass" looks like]
- [ ] [Another review item]

## Integration Verification
- [ ] [End-to-end scenario description with expected outcome]

## Reusability
Applicable to: [describe what types of future tasks could reuse this verification]
Adjust: [what would need to change for reuse]
```

### progress.md

Starts as the execution plan. During implementation, this becomes the living status document.

Structure:
```markdown
# Progress: [task title]

## Status: Planned

## Execution Plan
Numbered list of steps derived from the goal. This is the agent's best
estimate of how to accomplish the task — it may change during execution.

1. [ ] Step description
2. [ ] Step description
3. [ ] ...
N. [ ] Execute verification

## Resource Estimates
- Estimated time: ~Xm
- Estimated cost: ~$X
- Engines: [which AI backends are likely needed]

## Change Log
(Empty at creation. Updated during execution with key events, decisions, and re-alignments.)
```

## Adaptive behavior

**If the user provides a PRD or spec document**: Read it thoroughly, then use it as the starting point for alignment. Don't re-ask things that are already well-defined in the spec — focus your questions on gaps, ambiguities, and verification criteria that the spec doesn't cover.

**If there's an existing `.task/` directory**: Ask whether this is a continuation/refinement of the previous task or a new task. If continuing, load the existing documents and use them as context for the conversation.

**If the user seems impatient**: Compress. Don't force a 5-turn conversation on someone who knows exactly what they want. Match their energy — if they're being terse and specific, be terse and specific back. The goal is alignment, not process theater.

**If you're uncertain about something**: Apply the "ground in reality" principle — read code, search the web, run a quick command. The user's time is precious — don't ask questions you can answer yourself with your tools.

## What success looks like

A successful alignment produces documents that enable an agent to execute the task autonomously with minimal back-and-forth. The test: if you handed task.md and verification.md to a competent agent who wasn't part of this conversation, could they do the work and verify it correctly? If yes, the alignment was good.

## Task Center integration (v0.1.69+)

### Mode detection

When the user's first message contains a parameter dictionary shaped like:

```
本次上下文参数：
- alignmentSessionId: align-xxxxx
- workspaceId: <uuid>
- workspacePath: <absolute path>
- sourceThoughtId: <uuid>
```

…you are in **Task Center mode** — the user arrived via the "AI 讨论"
button on a thought card. The four parameters are everything you need
to sink the alignment into the Task Center. Remember them; they're used
twice (directory path for docs + CLI args for task creation).

If no such dictionary is present, fall through to **Manual mode** — the
user invoked `/task-alignment` directly. Write the four docs to `.task/`
relative to the current working directory and stop; no CLI call is
appropriate, there's no task-entity to create.

### Where to write (Task Center mode)

All four documents go to `~/.myagents/tasks/<alignmentSessionId>/`:

- Use the `Write` tool with an **absolute** path.
- Expand `~` to the real home dir — in bash use `$HOME`.
- This directory lives outside the workspace: task docs are user-scoped
  application data, not project content.
- The docs are AI-owned end-to-end; program code never writes to them.
- The `create-from-alignment` CLI (below) promotes this exact directory
  by renaming it to `~/.myagents/tasks/<newTaskId>/`.

### How to dialog

**Before writing any file**, actually have the alignment conversation —
understand goals, scope, verification criteria, emphasis points. The 4
docs are sinks, not starting points. Ask the user questions; don't race
to commit a plan in the first turn.

### Four possible outcomes

A good alignment ends in one of these four places. Pick the right one
based on where the conversation actually lands; don't force the "create
task" outcome if the discussion shows another path.

**① Worth doing — create the task.** Scope is clear and the user
agrees it's worth the investment. After writing all four docs, invoke:

```bash
myagents task create-from-alignment <alignmentSessionId> \
  --name "<短任务名>" \
  --workspaceId <workspaceId> \
  --workspacePath <workspacePath> \
  --sourceThoughtId <sourceThoughtId>
```

Substitute the four values from the prompt's parameter dictionary;
pick `--name` yourself based on the task. The CLI renames the docs
directory to `~/.myagents/tasks/<newTaskId>/`, backfills the source
thought's `convertedTaskIds`, and registers the task with
`dispatchOrigin=ai-aligned`. Then tell the user:
「已创建任务『XXX』，可在「任务」面板查看。需要现在派发执行吗？」
If yes → `myagents task run <newTaskId>`.

**② Should be split.** The "one thought" actually bundles multiple
independent tasks. Don't force them into a single alignment.md. Explain
the split to the user, then:

- Pick the sharpest slice they want to pursue first and alignment that
  one via the CLI call above.
- For the other slices, do NOT create tasks in this conversation. Tell
  the user they can re-trigger `/task-alignment` on the remaining ideas
  separately (from the thought card again, or as a manual flow). This
  keeps each task-entity focused and avoids the "mega-task that never
  finishes" trap.

**③ Needs upstream work first.** The idea is real but the user can't
commit to scope without more information — e.g. "first I need to run
the profiler to see where the bottleneck actually is" before we can
plan the fix. Don't create a task prematurely. Instead:

- Capture the reasoning and the upstream step in alignment.md anyway
  (useful context even if no task is minted yet).
- Tell the user: 「目前讨论还缺 X，我建议先做 Y 再来对齐。需要我留下
  这些文档以便下次再对齐时复用吗?」
- Leave the docs in `~/.myagents/tasks/<alignmentSessionId>/` without
  calling the CLI. The directory persists; a later `/task-alignment`
  can reference it.

**④ Not worth doing.** The discussion revealed this isn't valuable
enough right now. Don't call the CLI — leave the docs in place as a
record of the "why not", explain briefly, and stop. The originating
thought stays on the Task Center left column, unconverted. This is a
feature, not a failure; a thought that surfaces and gets rejected is
still worth capturing the rejection for.

### What lives where (skill vs prompt contract)

The prompt deliberately stays lean — it only supplies the parameter
dictionary and the raw thought text. Everything procedural (doc
layout, Write tool conventions, CLI syntax, outcome handling) lives
here in the skill. If you feel like the prompt "didn't tell you how
to do X", check this section first — the answer is almost always
already encoded as a skill rule.
