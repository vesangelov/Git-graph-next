# Contributing

Thanks for taking the time. Bug reports and feature requests are as welcome as
pull requests.

## Before anything else: the one hard rule

Git Graph Next is an independent, clean-room implementation. **No code, markup,
CSS or asset from `mhutchie/vscode-git-graph` may enter this repository**, and
you should not read that project's source while working on a feature here. Its
licence permits use and modification but withholds permission to publish
derivative works, so a single copied function would make this extension
undistributable. See [NOTICE.md](NOTICE.md).

Its *issue tracker* is a different matter: those are user-written descriptions
of bugs and wanted behaviour, and they are where much of this project's feature
list came from. Facts about how Git behaves and the documented VS Code
extension API are not covered by that licence either.

## Reporting a bug

Open an issue at <https://github.com/vesangelov/Git-graph-next/issues>, or write
to <vesangelovdev@gmail.com> if you would rather not file it in public.

What makes a report quick to act on:

- Your VS Code version and the output of `git --version`.
- Your operating system, and whether you are in a remote window (SSH, WSL, a
  container).
- What **Show Git Output** (under **More** in the graph) printed for the command
  that went wrong — it lists every git command the extension ran.
- What you expected, and what happened instead.

A repository that reproduces it is the single most useful thing you can attach,
but do not go out of your way: a clear description is usually enough.

## Getting set up

```sh
npm ci
npm run watch      # rebuild on change
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
the extension loaded.

```sh
npm run typecheck  # tsc --noEmit, strict
npm test           # 140+ tests, most against real repositories
npm run package    # production bundle
npm run vsce:package
```

`npm test` creates temporary repositories and runs the real `git` binary against
them, so the tests catch format drift between git versions — the thing that
actually breaks a graph. They need `git` 2.17 or later on your `PATH`.

## How the code is arranged

| Directory | What lives there |
|---|---|
| `src/git/` | Everything that runs git and parses its output. No `vscode` import, so it is testable in plain Node. |
| `src/graph/` | Pure layout: turning a commit list into rows, columns and edges. |
| `src/view/` | The extension-host side: webview panels, the Changes view, diffs, actions, code review. |
| `src/search/` | The query language the search bar parses. |
| `webview/` | The graph itself, running in the webview sandbox. |
| `test/` | Unit tests for the pure parts, integration tests against real repositories. |

The split matters: anything that can be written without `vscode` should be,
because that is the code a test can exercise directly.

## Things worth knowing before you send a patch

- **The webview is not trusted.** It renders repository content — commit
  messages, branch names, author names — so treat everything it posts to the
  host as hostile input. Values that reach a git argument list go through
  `src/view/validation.ts` first.
- **No `innerHTML`.** The webview builds its DOM through `document.createElement`
  and `textContent`. The Content-Security-Policy has no `unsafe-inline`, and it
  should stay that way.
- **Arguments, never command lines.** git is spawned with an argument array; no
  shell is involved anywhere.
- **Read-only commands must not take `index.lock`**, or refreshing the graph
  fights VS Code's built-in Git extension. `GIT_OPTIONAL_LOCKS=0` handles this;
  do not undo it.
- **Destructive actions say so** before they run, and show what they will do.
- Comments explain *why*, not *what*. The existing code is a good guide to the
  level of detail expected.
- Tabs for indentation, single quotes, semicolons — match the file you are in.

## Pull requests

Run `npm run typecheck` and `npm test` before pushing; CI runs both on Linux,
macOS and Windows, and a red build is the usual reason a PR waits.

Describe what the change does and why. If it fixes something a user reported,
link the issue. If it changes behaviour anyone would notice, update `README.md`
and add a line to `CHANGELOG.md`.

By contributing you agree that your work is licensed under the MIT Licence, and
that it contains nothing copied from `mhutchie/vscode-git-graph`.
