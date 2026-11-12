# DSH-010: plugin skeleton loads in DeepSeek Harness

Checked on 2026-11-11 with DeepSeek Harness `0.2.2-rc.1` (its bundled `dsh` CLI and pnpm 11.28.5).
Raw material is in `docs/evidence/DSH-010/`.

## What exists

A plain ESM package at the repository root, no build step: `package.json` (manifest with
`dsh.bundle.patch`, exports for the entry point, `./locale/*.json` and `./icon`), `cordis.patch.yml`
(inserts the plugin row), `index.js` (`name` and an `apply(ctx)` that only logs), `locale/en.json`,
`locale/zh.json`, `icon.svg` and `test/skeleton.test.js`. The license is `UNLICENSED` and the
package `private` until the owner decides (DSH-041).

## How it was checked

1. **Unit tests.** `npm test` (Node's built-in runner, no dependencies): 6 tests cover the manifest,
   the exported display resources, sentence-case titles, the icon limit, and `apply` against a stub
   context that fails the test if the skeleton touches anything on `ctx` besides `logger`.
2. **Local link install.** A dedicated dev profile was created from the shipped headless template
   (`dsh dsh-awr-dev --from-default-profile headless`) and the package was installed with
   `dsh plugin --profile dsh-awr-dev add link:<path to this repository>`. DSH added it to the
   profile's bundles and `dependencies`.
3. **Composition dump.** `dsh dsh-awr-dev --dump-config` shows the plugin's own layer, last in the
   stack (`composed-tree-excerpt.yml`).
4. **Boot.** `dsh dsh-awr-dev "say ok"` stopped at the model call (`MISSING_CREDENTIAL`, no API key
   in this shell) and printed no "entry did not activate" warning for the plugin
   (`boot-plugin-only.stderr.txt`).
5. **Control.** To show that the loader calls `apply` for a package linked this way, a throwaway
   package outside the repository, built the same way, printed from its `apply`. That line appeared
   on stderr before the credential error (`boot-with-control.stderr.txt`). The control was removed
   afterwards and no longer appears in the composed tree.

## What this does not show

- The skeleton's own log line was not seen. `ctx.logger` output is not printed by the headless
  profile at its default level, so "`apply` ran for this package" rests on steps 3 to 5 together:
  the entry is in the composed tree, it did not fail to activate, and a package loaded the same way
  did run its `apply`.
- The desktop app was not used. Its profile is managed by the Electron app, so installing there
  goes through the Plugins page or `plugin_manager`; that is not exercised yet.
- Display resources (title, description, icon) were checked as files, not as rendered in the
  Plugins page.

## Repeat it

```sh
npm test
DSH=/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime
PATH="$DSH/bin:$PATH" "$DSH/cli/bin/dsh" dsh-awr-dev --from-default-profile headless --dump-config >/dev/null
PATH="$DSH/bin:$PATH" "$DSH/cli/bin/dsh" plugin --profile dsh-awr-dev add link:"$PWD"
PATH="$DSH/bin:$PATH" "$DSH/cli/bin/dsh" dsh-awr-dev --dump-config | grep -A3 'dsh-awr'
```

The profile lives in `~/.dsh/profiles/dsh-awr-dev`; delete that directory to remove it.
