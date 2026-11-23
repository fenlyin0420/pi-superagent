# Using pi-superagent

The operator guide: one request followed end to end, then what to do when
something stops. What the extension is, how to install it and what each setting
means: [README.md](../README.md).

## One request, end to end

The repository is `alice/widgets`, the agent's GitHub account is `sagent-agent`,
and the deployment looks like this:

```json
{
	"version": 1,
	"policy": {
		"version": 1,
		"acceptMode": "explicit",
		"rules": [],
		"sources": {
			"github": {
				"enabled": true,
				"repository": "alice/widgets",
				"allowedActors": ["alice"],
				"botActors": [],
				"watchAll": false,
				"pollMs": 60000
			}
		}
	},
	"executor": {
		"account": "sagent-agent",
		"baseBranch": "main",
		"concurrency": 2,
		"prepare": "git clone --depth 1 https://github.com/alice/widgets.git \"$SAGENT_TICKET_DIR\""
	},
	"panel": { "locale": "en" }
}
```

A host session is running in a terminal (`pi` and `/superagent host`, or
`pi-superagent serve` on a server), and `gh auth status` is signed in as
`sagent-agent`.

### 1. An issue comment becomes a trigger

`alice` comments on issue #42:

> @sagent-agent the upload test is flaky on CI — please fix it.

Within one poll interval the source reads the account's notifications, finds
issue #42, reads the comment and stores a trigger: kind `issue_comment`, thread
`issue:42`, id `github:issue_comment:<comment id>`, stored once per comment. The
gate admits it — the source is enabled with a repository, `alice` is an allowed
actor, she is not a bot, and `@sagent-agent` makes it an explicit request — so
the thread's triggers become one evaluation and a candidate card appears in the
host session. No ticket exists yet, so the panel is still empty;
`/superagent triggers` lists the trigger as `evaluated`.

The journal records the intake:

```json
{"at":1731420000000,"cmd":"receive","detail":{"triggerId":"github:issue_comment:4012345678"}}
```

### 2. The router accepts, and a ticket starts

The router session answers the card:

```
sagent_decide { triggerId: "github:issue_comment:4012345678",
                outcome: "accept",
                scope: "fix the flaky upload test",
                basis: "alice asks directly on issue #42" }
```

The engine creates `ticket-1` under that mandate, names its directory after the
scope (`<state>/work/fix-the-flaky-upload-test`), and sends the first thing the
person sees — one comment on issue #42:

> Thanks — picked this up and will report back here.

It then runs `executor.prepare` once, from `<state>/work`, with
`SAGENT_TICKET_DIR` naming the directory the command has to fill (the clone
above), and starts the first worker turn: `pi --mode json -p <turn input>` in
that checkout, with the assignment (scope, mandate, how to report) and the
trigger text. In the panel the row moves from `Queued` to `Working`:

```
  ◐ #1 fix-the-flaky-upload-test   Working   —   1m
```

```json
{"at":1731420006000,"cmd":"decide","detail":{"triggerId":"github:issue_comment:4012345678","outcome":"accept"}}
{"at":1731420009000,"cmd":"assignmentStarted","detail":{"ticketId":"ticket-1","assignmentId":"asg-1"}}
```

### 3. A worker opens a pull request

The worker reproduces the failure, finds the race in the upload path, patches it,
runs the upload tests, commits, pushes and opens pull request #57. Two
conventions matter here:

- The branch's last path segment must be the ticket's directory name, for example
  `agent/fix-the-flaky-upload-test`. That is how the source recognises a pull
  request as this ticket's own. (The default `git worktree add` prepare already
  creates `sagent/<name>`.)
- The commit author is whatever git identity the checkout has, so give the
  deployment account its own checkout or git config.

The worker then calls `sagent_report` with `kind: "ready"`, naming #57 and
stating what changed and which checks ran. The host reads the report from
`<state>/inbox/ticket-1.jsonl`, the row becomes `Awaiting review`, and the router
posts the result on issue #42 with `sagent_reply { thread: "issue:42", purpose:
"result", body: "…" }`. A `progress` report would have stayed on the ticket and
posted nothing.

The next poll sees #57 came from `sagent-agent`'s branch and binds `pr:57` to the
ticket, so reviews, inline comments and CI results on it now reach the worker.

```json
{"at":1731423000000,"cmd":"report","detail":{"ticketId":"ticket-1","assignmentId":"asg-1","kind":"ready"}}
{"at":1731423060000,"cmd":"bindThread","detail":{"ticketId":"ticket-1","thread":"pr:57"}}
```

### 4. A review comment resumes the ticket

`alice` reviews #57 and writes: "Please keep the retry limit at 3."

`pr:57` is subscribed, so this is not a new evaluation: the comment
(kind `pr_review_comment`, id `github:pr_review_comment:<comment id>`) reaches
the ticket as an input, and the worker gets another turn on the same ticket, in
the same directory and session. It fixes the limit, pushes, reports `ready`
again, and the router posts the update. Nothing was accepted, no new ticket, no
second acknowledgement.

```json
{"at":1731426600000,"cmd":"receive","detail":{"triggerId":"github:pr_review_comment:4012399001"}}
{"at":1731426605000,"cmd":"inputsDelivered","detail":{"ticketId":"ticket-1","assignmentId":"asg-2","inputs":1}}
```

### 5. A merge ends it

`alice` merges #57. The poll reads the pull request as merged, closes the
`pr:57` thread, and the ticket ends with outcome `merged` because every thread it
follows is closed and no newer person's message is waiting. The router receives

> Ticket ticket-1 (fix-the-flaky-upload-test) ended: merged by executor — pull_merged.

and the row leaves the panel. Closing the pull request without merging ends the
ticket the same way with outcome `closed`. A later comment on #42 resumes the
same ticket under the same mandate — unless a person stopped it, in which case it
stays stopped and new work needs a new accept.

Throughout, the operator did nothing but write the settings. When they did want
to look: `/superagent` for the panel, `/superagent triggers` for what arrived,
`/superagent log --limit 50` for the journal.

## Troubleshooting

### The host lock is held

Symptom: `/superagent host` answers "Another session holds the host lock; commands
go through it"; `pi-superagent serve` exits with "Another session holds the host
lock on <state dir>"; `pi-superagent status` prints `host: pid 1234 since …`.

Cause: one live process owns `<state>/lock`, and only that process writes the
state directory. The other sessions are clients, and their commands are forwarded
to it — this is normal, not an error.

Fix: use the session that hosts, or quit it to release the lock. If the pid is
gone but the file remains, the next host takes the lock over on its own; if the
file is corrupt, `probe` reads it as no lock and the next host replaces it. Only
delete `lock` by hand once `ps -p <pid>` shows nothing alive.

### `gh` is not authenticated

Symptom: after three consecutive failed polls the router receives
`Problem poll_failed (3 in a row): …`. `pi-superagent status --json` shows
`sources[].lastError` with the failing message, and `lastPollAt` stops moving.

Fix: run `gh auth status` and `gh auth login` **as the user that runs the host**,
then `pi-superagent poll` to try one round immediately. The source needs read
access to the repository, comment write access, and the account's notification
list — the notification endpoint is how a mention is found; a token that cannot
read notifications produces an authenticated account that never sees a request.

### A worker keeps failing

Symptom: the row sits in `Failed` (or `Blocked`) under "needs a person" and does
not move; the last report in the panel detail says why.

What to check, in order:

1. `executor.prepare`. A failing prepare reports "The prepare command failed: …"
   with the command's output, and no turn ever starts. Run the same command by
   hand with the same `SAGENT_TICKET_DIR` to see the error.
2. The `pi` binary. If `pi` is not on the PATH of the host process (or
   `PI_SUPERAGENT_PI_BIN` is wrong), every turn fails with an exit error naming
   the binary.
3. The provider. An HTTP 408, 429, 5xx, a reset or a timeout is retried twice with
   a growing backoff before the ticket reports failed; a persistent rate limit
   looks like a worker that fails on every turn.
4. The turn itself. Read `<state>/work/<name>/` for the state of the checkout,
   `<state>/inbox/<ticketId>.jsonl` for the reports the worker wrote, the newest
   `report` lines in the journal, and `<state>/sessions/<ticketId>/` for the
   worker's own Pi session.

Then either write a comment on the ticket's thread — a person's message lifts a
blocked or failed hold and starts a turn — or run `/superagent retry <ticketId>`.
Retry only succeeds for a failed input delivery, or for a blocked or failed
report no person has answered yet; for anything else the engine answers
"Retry needs a failed input delivery, or a blocked or failed report a person has
not answered yet."

### A source stopped polling

Symptom: `pi-superagent status --json` shows a `sources[].lastPollAt` that is
minutes or hours old, or the router keeps receiving `Problem poll_failed`
messages and `status` counts `problems`.

Check, in order:

1. `policy.sources.github.enabled` is `true` and `repository` reads `owner/name`.
   Either one missing means a poll does nothing at all.
2. A host is running: `status` shows `host: none` when the lock is free, and a
   client session polls nothing.
3. `pollMs` is not misread: the interval is jittered by ±10% and never shorter
   than 10 seconds, so `pollMs: 1000` still polls every 10 seconds.
4. `gh auth status` as the host's user (see above).

`/superagent poll` or `pi-superagent poll` runs one round now, awaits it, and
reports the failure instead of waiting for the next interval.

### Retrying or stopping a ticket

- Panel: select the row and press `r` to retry, `s` to stop.
- Commands: `/superagent retry <ticketId>`, `/superagent stop <ticketId> [reason]`,
  `pi-superagent stop <ticketId> [reason]`.
- A stop is final. It ends every open assignment, records the reason in the
  ticket, and the engine refuses any new work on it; a later message on its
  threads does not resume it.
- A retry ends the stalled assignment and starts a new one in the same session
  and directory, handing over the messages the old one never took.
- To hold everything instead of one ticket, `/superagent pause`: no new
  evaluations, no evaluation timeouts, no resumes; running turns finish on their
  own. `/superagent resume` moves every deadline later by the length of the pause.

### Reading the journal

`<state>/journal.jsonl` is append-only, one JSON object per line, written after
the state snapshot commits:

```json
{"at":1731420000000,"cmd":"decide","detail":{"triggerId":"github:issue_comment:4012345678","outcome":"accept"}}
```

`cmd` is the domain command, and `detail` names the ids it concerned. The ones
you will see most often: `receive`, `decide`, `attach`, `note`, `reply`,
`requestStatus`, `stopTicket`, `retryTicket`, `unsubscribe`, `pause`, `resume`,
`reevaluate`, `report`, `assignmentStarted`, `inputsDelivered`, `inputsRead`,
`turnEnded`, `deliveryFailed`, `assignmentInterrupted`, `bindThread`,
`threadClosed`, `evalDue`, `resumeTicket`, `policyChanged`, `problem`. Read the
tail with `/superagent log [--limit n]` in a session or `pi-superagent log
[--limit n]` from a shell. The journal never replays: it is an audit trail, and
`state.json` is the authority.

## Repository map

```
index.ts              the Pi extension entry: boots the runtime, registers the
                      /superagent command, router tools, panel and widget
worker.ts             the extension a worker turn loads with -e: the sagent_*
                      reporting tools that append to <state>/inbox
cli.ts                the pi-superagent bin: serve, status, stop, poll, log

prompts/
	router.md           the host session's router prompt (appended at start)
	assessment.md       standalone assessor prompt (not loaded by the entry points)
	worker.md           worker instructions (not loaded by the running extension)
	replies.md          reply rules (not loaded; enforced in src/core/replies.ts)
	delivery.md         delivery requirements (not loaded; see "Not implemented")

src/core/             the domain: no I/O, no model calls
	model.ts            types, ids, reasons, waitsForPerson, settled
	stage.ts            the ticket stage table and its labels
	ports.ts            every interface between parts
	engine.ts           the only writer of aggregates; one transaction per command
	intake.ts           triggers, fan-out to subscribed tickets, resume
	evals.ts            one batch per thread, its candidate and decision
	tickets.ts          ticket lifecycle, inputs, reports, end, retry, stop
	assignments.ts      assignment lifecycle and what a report does to it
	replies.ts          outbound replies and their purpose rules
	part.ts             shared engine helpers, UserError, domain events
	reasons.ts          refusal codes and their wording
src/app/
	runtime.ts          composition root, host/client roles, socket protocol
	passes.ts           the 2 second pass: effects, then due evaluations
	settings.ts         settings schema, validation, atomic writes
	effects.ts          durable effect queue with backoff, and the assignment brief
	outbox.ts           routes a reply to the source that can write it
	notices.ts          domain events to router-session cards and notices
	assessment.ts       model-backed assessor (library; not wired by default)
	tools/main.ts       the router's sagent_* tools
src/executor/
	pi.ts               prepares directories, launches turns, ingests reports, slots
	spawn.ts            one pi subprocess per turn and its result
src/sources/
	github.ts           the polling source, threads, outbox writes
	github-read.ts      the gh calls and their parsing
	github-pull.ts      pull-request tracking, branch to ticket binding
src/infra/
	store.ts            snapshot store, atomic write, one journal line per command
	journal.ts          the append-only journal
	lock.ts             the single-writer host lock
	paths.ts            every path inside the state directory
src/panel/
	app.ts              the full-screen overlay
	keys.ts             the key map and the inline answer editor
	rows.ts             sections, rows, relative time
	widget.ts           the three-line status widget
src/i18n.ts           the en/zh surface strings
src/policy.ts         the gate, rule matching, policy effects
src/testing/fakes.ts  fixtures for the tests

tests/                vitest suites: engine, evals, stage, tickets, policy,
                      reasons, store, runtime, executor, panel
docs/                 000-design.md (design), 001-usage.md (this file)
```
