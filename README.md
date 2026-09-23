# Git Graph Next

A fast, interactive Git graph for VS Code: browse your repository's history, see what every commit changed, and branch, merge, rebase and more — right from the graph.

![The graph with a commit's details open](media/screenshots/overview.png)

## Getting started

Open the graph from the **Git Graph Next** icon in the Activity Bar, the **Git Graph** item in the status bar, the Source Control title bar, or the command **Git Graph Next: View Git Graph**.

- **Click** a commit to see its details and changed files; click a file for its diff.
- **Right-click** a commit, a branch, a tag or a stash for everything you can do with it.
- **Ctrl/Cmd+click** or **Shift+click** to select several commits — two selected commits are compared.
- **Double-click** a branch label to check it out.
- **Ctrl/Cmd+F** to search.

## Features

### A graph that stays readable

- Branch, remote-branch and tag labels. A local branch and its remote copy at the same commit share one label.
- The Uncommitted Changes row and your stashes appear in the graph.
- **Pin** long-lived branches like `main` or `develop` to a column of their own, drawn as a straight line.
- Give branches **fixed colours**, and optionally show each commit's branch colour on its row.
- **Compact** mode folds long stretches of linear history into single rows, so the branching structure fits on one screen.
- Issue references such as `#123` become links — automatically for GitHub and GitLab, and through your own rules for Jira or anything else.
- Git notes are marked on commits and shown in their details.
- Hover a commit to bring out the line of the branch it is on; a detached HEAD is shown where it is.
- Staged and working tree changes can be shown as two separate rows.
- Open a second graph tab to compare two repositories, or two places in one history, side by side.

### Search and filter

![Searching with operators, with the filter bar open](media/screenshots/search.png)

- Search with operators: `author:alice`, `message:"null check"`, `tag:v1`, `after:2024-01-01`, `date:>=2024-03-15`, and more. Press the **?** in the search bar for the full list.
- A match further back than what is loaded? **Search older commits** finds it and loads the graph up to it.
- Filter the graph by **branches and tags**, **author**, **file or folder**, or any extra **`git log` arguments** (`--no-merges`, `--since=…`).
- **Hide** branches and tags by pattern (`dependabot/*`, `nightly-*`).
- **View File History** from the Explorer or the editor: the graph filtered to one file, followed across renames.

### Review and compare

- **Code review**: start one on a commit, on two selected commits, or on a branch against the current one (everything since they forked, as a pull request shows it). Every file you open is marked reviewed; **Alt+]** and **Alt+[** go to the next and previous file not yet reviewed, right from the diff editor. Reviews are kept per workspace and can be resumed after a restart.
- **All Changes** opens every changed file of a commit or comparison in one scrolling editor.
- **Select two commits** to compare them, or compare any commit with your working tree; open a file as it was at a commit, or compare it with your working copy.
- **Go to Branch, Tag or Stash…** jumps to anything in the graph.
- **Open External Directory Diff** in your graphical diff tool (`diff.guitool`).

### Act on it

![The context menu of a branch](media/screenshots/menu.png)

- **Branches**: check out, create, rename, delete (also on the remote), delete several at once, merge, rebase, push, pull.
- **Commits**: cherry-pick, revert, reset, create a branch or tag, check out.
- **Several commits**: cherry-pick, revert, squash or drop them together.
- **Interactive rebase** in a normal VS Code editor: reorder the list, change `pick` to `reword`, `squash`, `fixup`, `edit` or `drop`, then **Start Rebase**.
- **Fixup commits** and **autosquash**, straight from the commit you want to fix.
- **Stashes**: apply, pop, drop, or turn into a branch.
- **Patches**: create them from commits or uncommitted changes, and apply them to the working tree or as commits.
- **Archives**: save the files of any commit as `.zip` or `.tar.gz`.
- **Repository settings**: add, change and remove remotes; set the user name and e-mail for one repository.
- Copy a commit's link, or open it on GitHub, GitLab or Bitbucket.
- When a merge, rebase, cherry-pick or revert stops at a conflict, a banner offers **Continue** and **Abort**.

Every action shows exactly what it will do before it runs, and destructive ones are marked as such. When git or ssh needs a password or a key passphrase, it is asked for in VS Code. **Show Git Output** (in **More**) lists every git command the actions ran.

## Settings

All settings are under **Git Graph Next** in the Settings editor. The ones most worth knowing:

| Setting | What it does |
|---|---|
| `git-graph-next.graph.pinnedBranches` | Branches drawn as a straight line in their own column, e.g. `["main", "develop"]`. |
| `git-graph-next.graph.branchColours` | Fixed colours, e.g. `{ "main": "#e5484d", "release/*": "#f5a524" }`. |
| `git-graph-next.graph.colourCommitRows` | Show each commit's branch colour on its row. |
| `git-graph-next.excludeBranches` | Branches and tags to hide, as `git log --exclude` patterns. |
| `git-graph-next.extraLogArguments` | Extra arguments for `git log`, e.g. `["--no-merges"]`. |
| `git-graph-next.issueLinking.rules` | Your own issue links, e.g. `{ "pattern": "([A-Z]+-\\d+)", "url": "https://jira.example.com/browse/$1" }`. |
| `git-graph-next.maxCommits` | How many commits load at first (more load as you scroll). |
| `git-graph-next.commitOrdering` | `date`, `author-date` or `topological`. |
| `git-graph-next.repository.sign.commits` / `.sign.tags` | Sign what the graph creates. |
| `git-graph-next.fetchAvatars` | Show author avatars (off by default — see Privacy). |
| `git-graph-next.separateStagedChanges` | Staged and working tree changes as two rows. |
| `git-graph-next.openOnStartup` | Open the graph automatically in windows with a repository. |

## Performance

Tested on a repository with 100,000 commits and 20,000 branches: laying out all 100,000 commits takes under a tenth of a second, and scrolling costs the same at any size. Most of the time goes into `git log` itself, which is much faster when the repository has a *commit-graph* file. Recent versions of git write one during `git gc`; you can also write it yourself:

```sh
git commit-graph write --reachable
```

## Requirements

- Git 2.17 or later on your `PATH`, or set in `git-graph-next.git.path` (or VS Code's `git.path`).
- VS Code 1.85 or later. Only public VS Code APIs are used, so VSCodium and remote windows (SSH, containers, WSL) are supported too.
- Git Graph Next runs git in your workspace, so it is disabled in untrusted workspaces.

## Privacy

Git Graph Next collects no data. It talks to the network only when you fetch, pull or push, through your own git — and, if you turn on `git-graph-next.fetchAvatars`, to fetch avatars: for each author shown, the MD5 hash of their e-mail address is sent to Gravatar (or their user name to GitHub, for GitHub no-reply addresses). Avatars are off by default.

## Feedback and bug reports

Bugs, feature requests, questions and anything else are welcome.

- **Issues:** <https://github.com/vesangelov/Git-graph-next/issues> — the best place for anything that others may hit too.
- **E-mail:** <vesangelovdev@gmail.com> — for anything you would rather not file in public.

A bug report goes a long way with your VS Code version, your `git --version`, and what **Show Git Output** (in **More**) printed for the command that went wrong.

Patches are welcome too — see [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is arranged and how to build it. For security issues, see [SECURITY.md](SECURITY.md).

## About

Git Graph Next is an independent, clean-room project under the MIT licence. It is not a fork of, and not affiliated with, the Git Graph extension by mhutchie; no code from that project was used. See [NOTICE.md](NOTICE.md).
