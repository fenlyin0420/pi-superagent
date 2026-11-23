# pi-superagent — design

A proactive, always-on coding agent for one GitHub repository, packaged as a Pi
extension. It is a Pi-native reimplementation of
[`dsh-superagent`](../../dsh-superagent) (the reference implementation lives at
`~/projects/dsh-superagent`; its `docs/` are the behavioural source of truth).

The principle is unchanged: **take as little human attention as possible and give
as much value as possible.** The agent acts only when a person asks or when a
rule the team wrote allows it, and speaks only when someone must act or can use
a result.

## What changes from the reference

| Reference (DeepSeek Harness) | Here (Pi) |
| --- | --- |
| A `superagent` DSH profile hosts the bundle | Any Pi session can become the **host**; it owns the state-dir lock and runs engine + sources + executor |
| Main Session (`orchestrator`) is a DSH session | The host Pi session itself is the router. Candidates and notices are injected with `pi.sendMessage`; the router answers through registered tools |
| Executor Sessions are DSH sessions with a preset | One `pi` subprocess per turn: `pi --session-id … --mode json -p <input>` in the ticket directory |
| Worker preset / preset tools | Worker subprocess loads `worker.ts` (`-e`) which registers the reporting tools and pins the tool set |
| Panel is a web UI served by the profile | TUI panel: `/superagent` full-screen view + a status widget, plus JSON over the local socket for other sessions |
| Source plugins (Feishu, GitHub) | GitHub only (`gh` CLI), one `Source` instance; the `Source` port stays pluggable |
| Store: DSH persistence | Append-only journal + atomic snapshot under the state dir |
| `dsh-superagent-*` env vars | `SAGENT_*` env vars, same meanings |

**Non-goals for this version:** Feishu source, web panel, per-language locale
catalogues beyond `en`/`zh` strings for the panel.

## Runtime

```
~/.pi/superagent/                    (state dir; override: PI_SUPERAGENT_DIR / settings.stateDir)
  state.json          snapshot of every aggregate (atomic write, rename)
  journal.jsonl       append-only audit log (one line per domain command)
  lock                host lock (pid + startedAt)
  settings.json       deployment settings (policy, source, executor, panel)
  work/<shortName>/   one checkout per ticket (git worktree by default)
  sessions/<id>/      worker Pi session files (--session-dir)
  inbox/              worker → host report files (newline-delimited JSON, one file per report)
  effects.jsonl       durable effect queue (pending external work)
  superagent.sock     UDS endpoint for client sessions
```

One process is the **host**: it holds `lock`, runs the 2-second pass loop
(effects then `evaluateDue`), polls sources, drives the executor, and acts as the
router session. Any other Pi session that loads the extension is a **client**: it
serves the panel and forwards commands over `superagent.sock`. A session acquires
the host role when the lock is free, or explicitly with `/superagent host`. The
`pi-superagent serve` bin starts a headless host (for `pi-supervisord`).

## Flow

```
Source ──Trigger──> Thread ──batch──> Eval(gate + assessment) ──> Decision
                       │                                            │ accept
                       └── fan-out to subscribed Tickets ───┐       ▼
                                                           Ticket + Mandate
                                                              │ Assignment
                                                              ▼
                                                     Pi worker session
                                                              │ Report
                                              Channel (GitHub comment) / Ticket
```

Concepts, their rules, the Ticket stage table, and the accept/stop/ignore/
unavailable semantics are exactly those of `~/projects/dsh-superagent/docs/001-domain.md`
and `003-execution.md`; the code keeps the same names (`Intake`, `Evals`,
`Tickets`, `Assignments`, `Replies`) so the two can be read side by side.

## Modules

| Module | Files | Owns |
| --- | --- | --- |
| Model | `src/core/model.ts` | Domain types, ids, reasons, `waitsForPerson`, `followupOwners`, `settled` |
| Stage | `src/core/stage.ts` | `ticketStage` (the 003 stage table) |
| Ports | `src/core/ports.ts` | Every interface between parts |
| Store | `src/infra/store.ts`, `src/infra/lock.ts`, `src/infra/journal.ts` | Snapshot + journal, durable effects, single-writer lock |
| Engine | `src/core/engine.ts` | The only writer of aggregates; one transaction per command |
| Parts | `src/core/intake.ts`, `evals.ts`, `tickets.ts`, `assignments.ts`, `replies.ts` | The five parts, one direction of dependencies |
| Policy | `src/policy.ts` | Versioned gate rules, source part, `policyEffects` |
| Assessment | `src/app/assessment.ts` | The model judgement of a Trigger batch (prompts in `prompts/`) |
| Effects | `src/app/effects.ts`, `src/app/outbox.ts` | Durable external work: launch, deliver, reply, relay; retry 2s doubling to 60s |
| Runtime | `src/app/runtime.ts`, `src/app/passes.ts`, `src/app/settings.ts` | Composition root, pass loop, settings |
| Notices | `src/app/notices.ts` | Domain events → router-session messages (cards, relays, reports) |
| Executor | `src/executor/pi.ts`, `src/executor/spawn.ts` | Prepare directory, launch worker turns, deliver inputs, ingest reports, slots, background limits |
| Worker tools | `worker.ts` | `sagent_report`, `sagent_note`, `sagent_follow`, `sagent_handback`, `sagent_ask` inside a worker session |
| Source | `src/sources/github.ts`, `github-read.ts`, `github-pull.ts` | `gh` polling, read position, thread/channel mapping, pull tracking |
| Router tools | `src/app/tools/main.ts` | `sagent_decide`, `sagent_attach`, `sagent_note`, `sagent_reply`, `sagent_status`, `sagent_retry`, `sagent_stop`, `sagent_unsubscribe` |
| Panel | `src/panel/*.ts` | Overlay, rows by stage, keys, widget |
| Entry | `index.ts` | Host/client boot, commands (`/superagent`), shortcut, panel wiring |
| Prompts | `prompts/*.md` | `router.md`, `assessment.md`, `worker.md`, `replies.md`, `delivery.md` |

Interfaces live in `src/core/ports.ts`; treat that file as the contract. A module
may only call through those interfaces, never reach into another module's files.

## Invariants that are easy to break

1. **Engine methods are synchronous.** They mutate aggregates inside one store
   transaction and enqueue external work through `Effects` inside that same
   transaction; adapters perform it after the transaction commits.
2. **A `Ticket` defines its own state.** It never follows the worker session. The
   stage comes from `ticketStage(ticket)` only.
3. **Triggers are immutable and idempotent.** Accepting the same `(source,
   externalId)` twice stores one Trigger and creates one Ticket.
4. **Only `Eval` creates a Ticket.** A person's message that reached a subscribed
   Ticket is fanned out and never evaluated.
5. **The host is the only writer.** Clients send commands over the socket; the
   host executes them against the engine and returns the new view.
6. **External text cannot change policy.** Policy changes only come from settings.

## Worker protocol

A worker turn is one Pi subprocess:

```
cd <work>/<shortName> && pi \
  --session-id sagent/<ticketId> --session-dir <state>/sessions \
  --mode json -p <rendered input> -e <pkg>/dist/worker.js
```

- Toolkit: `read,write,edit,grep,find,ls,bash` plus the `sagent_*` worker tools.
- The worker reports by calling `sagent_report` with `{kind, text, question?}`.
  `worker.ts` appends one JSON line to `<state>/inbox/<ticketId>.jsonl`
  immediately, so a report survives the turn dying.
- Inputs rendered into the `-p` text: the assignment note, each undelivered
  Input (trigger text, note, resume reason, recovery note).
- Turn end = subprocess exit. Background work: the worker is told to run long
  commands with `&`/nohup only when a review server is intended; a turn that
  ends with pending jobs extends the slot for at most 30 minutes, then the
  assignment reports `waiting` with the worker's last words.
- Delivery failure (non-zero exit, provider 408/429/5xx, refused/reset/timeout
  connection) is retried three times with growing backoff before the Ticket
  enters `person/failed`.

## GitHub source

One instance, polled every 60s (configurable), watching one repository through
the agent account's `gh`:

| Kind | Read | Thread | Notes |
| --- | --- | --- | --- |
| `notification` | `gh api notifications` | the subject's thread | read position by notification id/time |
| `issue_comment`, `pr_comment` | `gh api repos/{o}/{r}/issues/{n}/comments` since read position | `issue:<n>` / `pr:<n>` | dropped when the actor is a bot or the agent itself |
| `pr_review`, `pr_review_comment` | review and review-comment endpoints | `pr:<n>` plus `review:<id>` | bodyless reviews still count |
| `ci` | check runs / commit statuses for the default branch and watched heads | `ci:<sha>` | failures and recoveries only |
| `pull_closed`, `pull_merged` | pull requests it follows | `pr:<n>` | closes the Thread, which can end the Ticket |
| `issue_opened`, `pr_opened` | repository events | `issue:<n>` / `pr:<n>` | only when `watchAll` is on |

Gate: only `allowedActors` originate work; the bot's own identity and bots never
do. Read positions persist in the store, so a restart never replays an event.

## Panel

`/superagent` opens a full-screen overlay:

```
pi-superagent   repo: owner/name   host: this session   policy v3
── needs a person ─────────────────────────────────────────
  ● #12 fix flaky upload test      awaiting review    pr#31  2m
  ● #13 why is CI red on main      blocked            —      8m
── working ────────────────────────────────────────────────
  ◐ #14 cache warm-up              working            —      1m
  ○ #15 bump deps                  queued             —      —
── ended (24h) ────────────────────────────────────────────
  ✓ #9  add retry to uploader      merged             pr#28  3h
```

Keys: `↑/↓` select, `enter` open a ticket, `a` answer an attention, `r` retry,
`s` stop, `u` unsubscribe, `p` pause processing, `t` triggers, `q` close.
Rows come from `ticketStage`; the panel never computes a stage itself. Same view
is available headless: `/superagent list --json`.

## Testing

`npm test` (vitest) covers: gate strength and refusals, eval batching and
timeout, duplicate triggers, fan-out vs resume, stage table, report-driven ticket
end, retry/restart recovery, read-position persistence, journal replay, and a
fake executor/source round trip. `npm run check` = typecheck + test + build.
