# pi-superagent

A Pi extension that turns a Pi session into an always-on coding agent for one
GitHub repository. The session that takes the state directory's lock is the
**host**: it polls the repository through `gh`, and it is the **router** — the
model in that session reads each request that reached the agent's account and
decides whether to accept it, attach it to work already running, ignore it, or
stop. An accepted request becomes a **ticket** under a written mandate, and a
ticket is carried out by a **worker**: a separate `pi` process per turn, in its
own checkout and its own Pi session, which investigates, implements, opens a pull
request and reports back. Tickets, read positions and pending external work live
in a state directory, so a host that restarts resumes where it stopped. The whole
design follows one principle: take as little human attention as possible and give
as much value as possible — the agent acts only when a person asks or a rule the
team wrote allows, and speaks only when someone must act or can use a result.

Operator guide with a worked example and troubleshooting: [docs/001-usage.md](docs/001-usage.md).

## Requirements

- **Pi 1.5 or newer.** Every worker turn is a `pi` subprocess, so the `pi` binary
  must be on the PATH of the process that runs the host; `PI_SUPERAGENT_PI_BIN`
  points at another binary.
- **Node 22 or newer** (the package's `engines`), to build it and to run the
  `pi-superagent` bin.
- **`gh`, authenticated as the agent account** (`gh auth status`). The source
  reads with `gh api` in that account's name and posts comments with it: read
  access to the repository, write access to issue and pull-request comments, and
  the account's notification list, which is how a mention reaches the agent.
- **`git`**, plus a way to produce one checkout per ticket. The default prepare
  runs `git worktree add <ticket dir> -b sagent/<name> <baseBranch>` from the
  state directory's `work/` folder, which only works when that folder already
  sits inside a checkout of the repository; most deployments set
  `executor.prepare` to a clone instead (example below).
- **A model configured in Pi.** The host session uses its own session model;
  workers run with Pi's default model and provider.

## Install

```sh
cd /home/fenlyin/projects/pi-superagent
npm install
npm run build
pi install /home/fenlyin/projects/pi-superagent
```

The build is not optional: the package's Pi entry is `dist/index.js`, and
`pi install` only adds the package to your Pi settings. `pi list` shows it.
Pass `-l` to install it project-locally inside one repository instead of for
every session on the machine.

To work on the extension itself, `npm link` puts the `pi-superagent` bin on your
PATH, and a session can load the built file directly:

```sh
npm link
pi -e /home/fenlyin/projects/pi-superagent/dist/index.js
```

Every Pi session that loads the package joins the state directory: the first one
to get `<state>/lock` hosts, the others are clients that serve the panel and
forward commands over `<state>/superagent.sock`. Run `/superagent host` in a
client to take the host role when the previous host is gone.

A host without a terminal (server, supervisor):

```sh
pi-superagent serve                 # owns the lock, prints one JSON line per domain event
pi-superagent status                # what the host sees; --json prints the whole view
pi-superagent --state-dir /path serve
```

## First run

1. Start `pi` and open the panel with `/superagent`, or ask
   `/superagent settings` what the running host believes. An empty policy means
   nothing will ever start: `acceptMode` is `off` and the GitHub source is
   disabled.
2. Write `<state>/settings.json` (default `~/.pi/superagent/settings.json`). The
   host reads it once at start, so restart the host session after an edit. A
   document that fails validation stops the runtime, and the notice names the
   field, for example `policy.sources.github.repository must read owner/name`.
3. Check the wiring: `pi-superagent status` shows the repository, the policy
   version, the host pid, the ticket counts and the sources; `/superagent poll`
   forces one poll instead of waiting for the interval.

`stateDir` decides where the state is; a `settings.json` that names another
directory is still read from the default location and only moves the rest of the
state. Precedence: `--state-dir` (bin), then `settings.stateDir`, then
`PI_SUPERAGENT_DIR`, then `~/.pi/superagent`.

### Settings keys

| Key | Type, default | Effect |
| --- | --- | --- |
| `stateDir` | string, `""` → `~/.pi/superagent` | Root of the state directory. |
| `policy.version` | integer, `1` | Bookkeeping: the version recorded in each ticket's mandate. Policy itself is edited in this file. |
| `policy.acceptMode` | `"off"` \| `"explicit"` \| `"inferred"`, `"off"` | Strongest basis that may start work: `off` nothing, `explicit` only a direct request to the agent, `inferred` direct requests and proactive candidates. |
| `policy.rules` | array, `[]` | Rules proactive work may cite: `{ id, text, scope?, strength? }`. `id` matches `^[a-z][a-z0-9_-]*$` (64 characters), `text` and `scope` up to 2000 characters, `strength` `"explicit"` or `"inferred"` (default `"explicit"`). |
| `policy.sources.github.enabled` | boolean, `false` | Whether the GitHub source polls at all. |
| `policy.sources.github.repository` | string, `""` | The one repository watched, as `owner/name`. |
| `policy.sources.github.allowedActors` | array of logins, `[]` | Only these accounts originate work. |
| `policy.sources.github.botActors` | array of logins, `[]` | Extra accounts treated as bots (never originate work). |
| `policy.sources.github.watchAll` | boolean, `false` | Also read newly opened issues and pull requests nobody addressed to the agent (`issue_opened`, `pr_opened`). |
| `policy.sources.github.pollMs` | integer, `60000` (1000–3600000) | Poll interval, jittered by ±10%; the source never polls faster than 10 seconds. |
| `policy.updatedAt` | integer, now | Bookkeeping; the host maintains it. |
| `executor.prepare` | string, `""` | Shell command run once per ticket, before its first turn, with `SAGENT_*` in the environment. Empty means the `git worktree add` default. |
| `executor.concurrency` | integer 1–16, `2` | Worker turns that may run at once, not counting the extra slot a person's message or a status request takes. |
| `executor.baseBranch` | string, `"main"` | Branch the default prepare branches from, and what a pull request should target. |
| `executor.account` | GitHub login, `""` | The agent's own account: its events are dropped so it never answers itself. |
| `executor.model` | string, `""` | Accepted and stored; see "Not implemented". |
| `executor.root` | string, `<state>/work` | Accepted and stored; ticket directories are created under `<state>/work`. |
| `executor.commitEmail` | string, `""` | Accepted and stored; see "Not implemented". |
| `panel.locale` | `"en"` \| `"zh"`, `"en"` | The panel, widget and command wording. Save it with `/superagent settings locale <en\|zh>` in the host session. |

### Example `settings.json`

```json
{
	"version": 1,
	"policy": {
		"version": 1,
		"acceptMode": "explicit",
		"rules": [
			{
				"id": "flaky-tests",
				"text": "A failing test on the default branch may be fixed without asking.",
				"scope": "the failing test and the smallest change that makes it pass",
				"strength": "inferred"
			}
		],
		"sources": {
			"github": {
				"enabled": true,
				"repository": "alice/widgets",
				"allowedActors": ["alice", "bob"],
				"botActors": ["dependabot"],
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

### What may start work

The gate is deterministic and runs before any model does. A trigger is admitted
only when the source is enabled and names a repository, its author is on
`allowedActors`, its author is not a bot (including `botActors` and the agent's
own login), and `acceptMode` admits its strength. A trigger is `explicit` when
the source says a person addressed the agent — a mention, an assignment, a review
request — or when its text names `@<account>`; everything else is `inferred`. A
proactive accept additionally needs at least one matched rule, and a rule matches
when its id or one of the words of its text (at least four characters long)
occurs as a whole word in the trigger's text. External text never changes these
settings.

## How the router and the workers talk to people

The source turns what it reads into triggers on threads (`issue:42`, `pr:57`,
`ci:<sha>`). The engine batches one thread's waiting triggers into a single
evaluation and hands the host session a candidate card as a Pi message;
a turn starts, and the router answers with a tool call (`sagent_decide`,
`sagent_attach`, `sagent_note`, `sagent_reply`, `sagent_status`, `sagent_retry`,
`sagent_stop`, `sagent_unsubscribe`, `sagent_unread`). An accept creates the
ticket, its mandate and its first assignment; the acknowledgement the accept
carries is the first thing the person sees. The worker then runs as
`pi --session-id sagent-<ticketId> --session-dir <state>/sessions/<ticketId> --mode json -p <turn input> -e <package>/dist/worker.js`
in the ticket's checkout, with `read`, `write`, `edit`, `grep`, `find`, `ls`,
`bash` and its own reporting tools, and reports by appending a line to
`<state>/inbox/<ticketId>.jsonl`. The host reads that file, updates the ticket,
and relays what a person must see back to the router, which posts one comment
where the request was written.

What a person sees on GitHub:

- On accept, one short comment on the issue or pull request: "Thanks — picked
  this up and will report back here."
- Nothing for ordinary progress. A progress report stays on its ticket and is
  read in the panel.
- One comment when a worker reports a ready result: what changed and the
  evidence that the checks ran.
- One comment forwarding a question the worker cannot answer, unchanged and in
  its own words, where the person wrote.
- A blocked or failed ticket does not post by itself. The engine checks a reply's
  purpose, so a comment can carry a ready result, an answer to a person's
  question, or a forwarded question — a blocker waits for a person in the panel.

Inside the host session the same events appear as messages (candidate cards,
report relays, follow-up notices, ticket endings, problems). In the TUI a
three-line widget shows how many tickets need a person, how many are working and
how many are idle, plus the host pid when this session is a client.

## The panel

`/superagent` opens a full-screen overlay. Sections and labels come from the
ticket stage table; the panel never computes a stage itself.

```
pi-superagent  repo: alice/widgets  host: this session  policy v3
───────────────────────────────────────────────────────────────
── needs a person ─────────────────────────────────────────────
  ● #12 fix flaky upload test   Awaiting review  pr#31  2m
── working ────────────────────────────────────────────────────
  ◐ #14 cache warm-up           Working          —      1m
  ○ #15 bump deps               Queued           —      —
```

| Stage | Section | Meaning |
| --- | --- | --- |
| Input undelivered | needs a person | The host could not deliver a message to the worker; `r` retries it. |
| Awaiting answer | needs a person | The worker asked a question; `a` answers it. |
| Awaiting review | needs a person | The worker reported a ready result. |
| Blocked | needs a person | The worker reported blocked and no person has written since. |
| Failed | needs a person | A turn or a report failed and no person has written since. |
| Queued | working | Accepted; the first turn has not started. |
| Working | working | A turn is running. |
| Waiting for a Trigger | working | Idle after a report, waiting for a message on its threads. |

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move the selection. |
| `enter` | Open the selected ticket (stage, scope, thread, reports, last report, open question); `enter` or `escape` returns to the list. |
| `a` | Answer the selected ticket, when it is `Awaiting answer`. `enter` sends, `escape` cancels, `backspace` deletes. |
| `r` | Retry: a failed input delivery, or a blocked or failed report no person has answered yet. |
| `s` | Stop the ticket for good; it never resumes. |
| `u` | Drop every subscription on the selected ticket's thread; the ticket stays open but stops hearing from it. |
| `p` | Pause processing — no new evaluations, no evaluation timeouts, no resumes; a running turn is not interrupted. Press again to resume, which moves every deadline later by the length of the pause. |
| `t` | Recent triggers, with status, kind, age and text; `escape` returns. |
| `q` | Close the panel. |

The panel lists open tickets. Ended tickets stay in the state but are not shown
by this version. `/superagent list [--json]` prints the same rows without a
terminal, which is what a client session without a TUI uses.

## Commands

`/superagent` in any session that loaded the package. A client session forwards
every subcommand to the host over the socket; the panel needs a TUI and falls
back to `list`.

| Command | Effect |
| --- | --- |
| `/superagent` | Open the panel. |
| `/superagent list [--json]` | Open tickets by stage. |
| `/superagent triggers [--limit n]` | Recent triggers with their disposition (default 20, at most 200). |
| `/superagent decide <triggerId> <accept\|stop\|ignore\|unavailable> [--basis text] [--scope text]` | Record a decision on a trigger's evaluation, the same call the router makes. |
| `/superagent attach <ticketId> <triggerId> [--note text]` | Route a message to an existing ticket. |
| `/superagent note <ticketId> <text>` | Record one fact on a ticket; grants nothing and wakes nobody. |
| `/superagent stop <ticketId> [reason]` | Stop a ticket for good. |
| `/superagent retry <ticketId>` | Retry a stalled ticket. |
| `/superagent unsubscribe <thread>` | Drop every subscription on a thread. |
| `/superagent pause` \| `/superagent resume` | Stop or resume starting new work. |
| `/superagent poll` | Poll the source now. |
| `/superagent host` | Take the host role in this session, if no live process holds the lock. |
| `/superagent settings [--json]` | What the host believes: policy version and mode, repository, rules, account, locale, state dir. |
| `/superagent settings locale <en\|zh>` | Save the surface language (host session only). |
| `/superagent log [--limit n]` | The journal tail (default 20). |
| `/superagent help` | The list above. |

`pi-superagent`, the package's bin. Every command except `serve` is a client: it
talks to the running host over the socket and reports that no host answered when
nothing is listening.

| Command | Effect |
| --- | --- |
| `pi-superagent serve` | Run a headless host in this terminal until a signal. |
| `pi-superagent status [--json]` | What the host sees: repository, policy, host pid, paused, ticket counts, problems, sources. |
| `pi-superagent stop <ticketId> [reason]` | Stop a ticket. |
| `pi-superagent poll` | Poll the source now. |
| `pi-superagent log [--limit n]` | The journal tail. |
| `pi-superagent --state-dir <dir> <command>` | Use another state directory. |

## The state directory

Default `~/.pi/superagent`, created on first start.

```
settings.json       your settings; the host reads it at start
state.json          snapshot of every ticket, trigger, thread and read position
journal.jsonl       append-only audit log, one JSON line per domain command
effects.jsonl       durable queue of pending external work
lock                the host lock: pid, start time, session id
superagent.sock     local socket the clients command the host through (0600)
work/<name>/        one checkout per ticket, named after the ticket's scope
sessions/<id>/      worker Pi session files, one directory per ticket
inbox/<id>.jsonl    worker reports, one JSON line per report
```

| Path | Safe to delete? |
| --- | --- |
| `work/<name>/` | Yes once the ticket has ended and no turn is running; uncommitted work in it is lost with it. |
| `sessions/<id>/` | Yes when no turn runs; a later turn continues with the same session id but without the earlier conversation. |
| `inbox/<id>.jsonl` | Yes when no turn runs; the executor starts reading at the current end of the file, so lines written before it opened are ignored, not replayed. |
| `journal.jsonl` | Yes; it is an audit trail and no reader depends on it, so you only lose history. |
| `lock` | Only when no host process is alive. A lock whose pid is dead is taken over automatically; a live holder is honoured. |
| `superagent.sock` | Yes when no host is listening; the next host removes and recreates it. |
| `effects.jsonl` | No while a host runs: rows in it are external work that has not happened yet. |
| `state.json` | No: it is the authority for tickets, triggers and read positions. Deleting it forgets all work and replays the repository from that moment. |
| `settings.json` | Deleting reverts to defaults — `acceptMode` `off`, source disabled — so nothing starts until you write it again. |

## Security

Read this before pointing the agent at a repository that matters.

- A worker is `pi --mode json -p <input>`: a non-interactive Pi process that runs
  **as your OS user, with `bash`, and nothing asks you before it acts**. There is
  no approval step, no command deny list, no filesystem jail and no container.
  `SAGENT_BLOCKED_COMMANDS` is passed to every turn, but the runtime fills it
  with an empty list; nothing reads it as a restriction.
- The per-ticket directory, the router's instructions (act only as the deployment
  account, never merge, never close an issue) and the prompts are **defaults and
  conventions, not a security boundary**. A worker can run any command your user
  can, read any file your user can read, reach the network, and use the same `gh`
  login, on any repository that login can see.
- A pull request is a review checkpoint, not a sandbox: the agent can push to
  branches, comment, and change issues. Merging is left to a person by
  instruction only.
- Everything the agents read from GitHub — comments, issue bodies, quoted
  documents, diffs, pull-request descriptions — is untrusted input. Policy lives
  only in `settings.json`, which no agent writes, but a worker still decides what
  a piece of text means; a comment written to look like an instruction is
  indistinguishable from one at the model level. Isolation is the mitigation, not
  wording in a prompt.
- Therefore: **use a dedicated GitHub account** whose access is limited to the one
  repository, and **run the host on a machine or container that holds nothing
  else** — no personal checkouts, no other credentials, no home directory worth
  reading. The state directory then contains a full clone per ticket, worker
  transcripts and comment bodies, and is as sensitive as the repository.
- The socket carries commands that write the state directory. It is
  `chmod 0600`, and the state directory's own permissions are the remaining
  control; do not share it between users.

## Not implemented

- **Feishu**, or any source other than GitHub. The `Source` port is the extension
  point; one GitHub instance is wired.
- **A web panel.** The surface is the TUI overlay, the status widget, the
  `/superagent` commands and the local socket for other Pi sessions.
- **Locales beyond `en` and `zh`**, and only for the panel, widget, commands and
  their error sentences; the agents' own prompts and tool descriptions are
  English.
- Ended tickets are kept in the state but not listed by the panel.
- `executor.model`, `executor.root` and `executor.commitEmail` are validated and
  stored but not applied: a worker turn runs with Pi's default model, ticket
  directories live under `<state>/work`, and a worker commits with whatever git
  identity its checkout has.
- `prompts/worker.md`, `prompts/assessment.md`, `prompts/replies.md` and
  `prompts/delivery.md` are not loaded by the running extension; only
  `prompts/router.md` is appended to the host session's system prompt, and a
  worker's instructions are the rendered assignment plus its tool descriptions.
