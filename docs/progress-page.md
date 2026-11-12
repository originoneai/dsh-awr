# The Progress tab (DSH-062)

AWR has a Project Progress Overview (`awr overview`): the whole project as a node graph, a mainline graph and
swimlanes. This is the same picture inside DeepSeek Harness, as a tab beside Chat and Trajectory
(`client/50-page.js`, the `conversation.view` slot). The card in the header (`docs/panel.md`) says how the project
stands; this tab is where a person looks at the project.

## What it shows

1. **The gauge.** One number ("30 / 31 done") and one bar, in which each part is a state: done (ink), in progress,
   blocked, waiting, ready, not started. The legend under it counts them and filters the page by a click.
2. **Needs you.** Work with a recorded blocker, with the reason; goals nobody confirmed; and, while the project is
   incomplete, one item saying so (below). Three at first, the rest on request.
3. **The work, three ways**, one control: *Mainlines* (what is left in each mainline, finished work folded),
   *Dependencies* (what waits for what, in layers; pointing at a card lights its whole chain and dims the rest) and
   *Lanes* (the mainlines side by side, with the dependencies between them). Search, "show finished", zoom and fit.
4. **The details of one piece of work**, in a drawer: its state, what blocks it, the next step, what it is done when,
   what it depends on and what it unlocks (each a link to that work). Identifiers and the source file are folded under
   **Technical details**.

The states are AWR's own facts in the order a person looks at them: cancelled or archived, done, blocked (a blocker
is recorded), in progress (in progress or claimed), ready, waiting (AWR names a wait), else not started. A mainline is the
prefix of the work key (`AWR-TF-014` is in `AWR-TF`); a key AWR generated (a hash) has none, so the identifier its title
starts with is used; mainlines with fewer than three items are shown together as "other".

Nothing is invented: a card is as AWR reports it, and what AWR does not report is left out. AWR words work without
acceptance criteria as "accepted completion of <key> — <title>", where the key of work that came from a Markdown item is
a hash; that is no criterion, so the drawer shows no "done when" for it. A criterion somebody wrote is shown as written.

## Where the data comes from

`awr overview snapshot [--refresh] --json` (`work_graph`, `nav.mainline_graph`, `goals`, `sessions`), turned into the
view by `lib/progress-view.js` (`buildProgress`: nodes with a state, edges, lanes, counts, what needs the person, and the
identifiers apart in `tech`) and written by `lib/progress.js` to
`<home>/.local/state/dsh-awr/panel/<conversation>.progress.json`, `schema: 1`. The tab reads the file through DeepSeek
Harness's workspace-file service, so reading puts nothing in the conversation (`docs/conversation-rows.md`).

- The host asks `awr capabilities` whether the awr has `overview snapshot` and never runs the command to find out: an
  awr that does not know it answers `Unsupported`, which poisons the plugin's use of that awr. An old awr gets a sentence
  saying so.
- The tab reads the file every 5 s while it is visible; when it is missing, older than a minute, of another schema or
  says `not_managed` it asks the host (`/awr progress`, drawn as no row), and then once a minute. **Refresh** asks again;
  **Sync project files** has AWR read the project's source files first (`--refresh`).
- After the agent ran an awr command that can change the work, and when a takeover finishes, the host writes the file
  again (only for a conversation whose tab was opened).
- A project AWR does not manage shows the offer to take it over, the same as the card.

## One story with the card

AWR's dependency graph calls work ready when nothing it depends on is open, and `awr status` counts the same work as
blocked when the project is incomplete: AWR starts nothing until its goal, acceptance criteria and next steps are
written (`organization.business_execution_ready` is false; right after a takeover of a plain TODO list it always is).
The card says so (`docs/panel.md`), so the tab holds ready work back while that is the case: it is "not started", and
"The project is not complete yet · 8 details are still to fill in" is the first item under Needs you. In a complete
project the tab shows the graph as AWR does.

## Keyboard

The three views are tabs: one stop of the Tab key, and the arrow keys, Home and End move between them. Escape closes
the drawer. Focus rings are the host's.

## Checked

- `test/progress-view.test.js` (12 tests): the six states and their order, the layers (and a cycle), the mainlines (a
  generated key, small lanes, order), the criteria (the placeholder dropped, a written one kept), what needs the person,
  an unknown edge, a project with no work.
- `test/client-page.test.js` (21 tests): the gauge and the legend, needs, mainlines, no identifier visible by default,
  the drawer and its links, Escape, the keyboard, the dependency layout and lines, the chain of a card, the lanes, search
  and the legend as filters, the asks of the host (missing, old, other schema, once a minute, refresh, sync), an unmanaged
  project, an old awr, the zoom, Chinese, the incomplete project, and that the card and the tab read one store.
- In the desktop app, real data: this project (30 of 31 done), the demo project after a real takeover, and the 597-item
  AWR project (479 done, 21 stuck): the three views, the drawer on a blocked card with its real criteria, the chain of a
  card, the keyboard. In a browser harness with the host's own theme: four fixtures (an empty project, a dozen items, the
  demo, 597 items), light and dark, English and Chinese, at phone width.

## Not checked

- A project of several thousand items (the 597-item one lays out in a fraction of a second; the graph is drawn in SVG,
  so very large ones will want a canvas).
- Editing: the tab only reads. Work is changed through the agent or `awr`, not here.
- A global page for all projects (a sidebar entry): the tab is per conversation, because the host binds a project to a
  conversation.
