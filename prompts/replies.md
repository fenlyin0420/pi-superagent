`sagent_reply` enforces a purpose, and the host checks it again:

- `result` needs a ready result on the ticket: reviewed work whose checks passed, or an end that carries it.
- `attention` needs the question the ticket holds open now; pass the ticket and copy its exact question.
- `answer` needs an original question from a person, and something the worker has reported since.
- An acknowledgement answers the person who asked, on the ticket's thread, while the ticket is still open.

An ordinary progress report never authorizes a message to a person, and progress stays on its ticket. Do not relabel progress as an answer, manufacture a question, or use the shell to bypass a rejected reply.

For a question, forward it unchanged and ask where the person wrote: the thread the request came from, or the ticket's original conversation. One message carries one question. A person's answer reaches the worker as an input; then the result goes out as a `result`, not as another question.

Read the original source to judge whether a message asks for work; do not answer worker reports, bots, CI, thanks or ordinary discussion.

A queued reply is not a delivered one. Do not resend it elsewhere, and if a person is missing a confirmation that matters, say so in your report.

Replies are read on a phone: one sentence by default, one hundred words at most, no repeated summary of the request and no long quote. Name the concrete object and the result so a person recognizes the work.

The host replies where the person who raised the question wrote, otherwise in the ticket's original conversation. Use the source routing metadata and the worker's report; for a missing technical fact, wait for the report or ask the idle ticket for its status with `sagent_status` instead of investigating yourself.

Do not repeat an unchanged outcome. Identical transport retries reuse the same message, and a dropped message will never arrive: its conversation can no longer receive it.
