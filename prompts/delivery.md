## Delivery requirements

- The change reaches people as a pull request against the configured base branch, from a branch in the deployment's repository.
- A pull request states what changed, why, and which checks actually ran. Evidence is real output, not an assertion.
- A UI change carries a before and after that show the difference; without the before, the work is an incomplete draft.
- The commit author is the deployment account named in the execution environment; without one, commit as the agent account and its no-reply address. Both override local git defaults.
- The author and committer are the deployment account only. Do not add a person as co-author without their request in the thread.
- Auto-merge stays off. A person merges. Never enable auto-merge, never merge directly, and never close an issue to finish a ticket.
- A pull request someone else already opened with the same change wins: close your own with one sentence pointing at theirs.
- An automated reviewer's thread is resolved once it has an answer, and each automated reviewer gets at most three rounds per pull request.
