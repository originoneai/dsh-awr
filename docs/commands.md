# The `/awr` command (DSH-015)

Typed in a DeepSeek Harness conversation, `/awr` runs directly against the conversation's AWR
session and creates no model message. The result is shown by DSH outside the model's history.

| Command | What it runs |
| --- | --- |
| `/awr` or `/awr status` | `awr status`; shows the project, counts, the work in progress or the next action, and which AWR session this conversation is bound to |
| `/awr claim [WORK]` | `awr work claim WORK --session <bound session> --expected-revision <current>`; WORK defaults to the work the conversation was bound to |
| `/awr checkpoint DIGEST :: NEXT` | `awr context compile` for the bound work to get its hash, then `awr session checkpoint` with your digest and next action |
| `/awr end [ended\|interrupted\|incomplete]` | `awr session end --outcome …` (default `ended`); the reply says that work is not completed by ending a session |
| `/awr help` | the list above |

Code: `lib/commands.js`, mounted by `registerAwrCommand` in `lib/conversation.js`.

## Rules

- A command that writes first reads the project's current revision and sends it as
  `--expected-revision`.
- A revision conflict is reported as it is ("the project changed while the command was being
  prepared… nothing was written") and the write is not retried. Retrying with a fresh revision would
  apply a change the user has not seen the new state for.
- An incomplete checkpoint (no digest or no next action) is rejected before anything is sent.
- In a directory outside an AWR project the command says so and runs nothing. If the conversation
  has no AWR session, the writing commands say that instead of guessing one.
- The command is mounted through `ctx.inject(['commands'])`. A profile without the commands service,
  such as the headless one, still loads the plugin, without `/awr`.

## Checked

- `test/commands.test.js`: scripted `awr` programs for every subcommand and error, and the real
  `awr` end to end (bind, status, claim, checkpoint, end, and ending twice). Removing the expected
  revision from `end` fails tests.
- In the DeepSeek Harness 0.2.2-rc.1 desktop app (`docs/evidence/DSH-015/desktop-commands.json`):
  the plugin was installed from its local directory through Plugins > Install third-party plugin.
  The `/awr` entry appeared in the command list with its description. In a new conversation on a
  disposable AWR project, `/awr status`, `/awr claim`, `/awr checkpoint … :: …` and `/awr end
  interrupted` each returned `success` in the session log. Read back from AWR: the bound session
  ended as `interrupted`, its checkpoint held the digest and next action as typed, and its claim was
  released. The plugin was uninstalled afterwards.

## Not checked

- A revision conflict inside DSH. It is covered by a scripted test only.
- How DSH renders the reply. In a conversation that had no model turn yet, the reply text was not
  visible on screen; it is in the session log as `command/done`. This was not investigated.
