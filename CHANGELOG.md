# Changelog

All notable changes to Git Graph Next are listed here.

## 1.0.0 — first release

### Graph

- Fast, virtualised commit graph: only visible rows are drawn, so 100,000 commits scroll like 100.
- Laying out the graph takes the same time with 2 branches open side by side as with 20,000.
- SHA-256 repositories (`git init --object-format=sha256`) as well as SHA-1 ones.
- Refreshes by itself after a commit, checkout or fetch — also in linked worktrees and submodules, whose git data lives outside the working tree — but not for builds that only write files git ignores.
- Rounded or angular edges, configurable colours, sticky column header.
- Branch, remote-branch and tag labels; local and remote labels folded together when they point at the same commit.
- Uncommitted Changes row and stash rows in the graph.
- Pin long-lived branches to a column of their own, drawn as a straight line (setting or context menu).
- Fixed colours for chosen branches, and an optional colour stripe on every row.
- Compact mode: long runs of linear history fold into one row, to see the branch structure.
- Git notes shown on commits and in the details.
- Issue references become links: automatic for GitHub and GitLab, configurable rules for anything else.

### Details and diffs

- Commit details: author, committer, dates, parents, refs, the full message, and the changed files with line counts.
- Click a file for its diff; notebooks open in VS Code's notebook diff.
- Select two commits to compare them.
- An Activity Bar view with a compact graph and a Changes view.

### Code review and comparing

- Code review mode for a commit, two commits, or a branch against another: opened files are marked reviewed, Alt+] / Alt+[ go to the next / previous file not yet reviewed, and reviews survive restarts.
- All Changes: every changed file in one scrolling editor.
- Open a file at a revision, compare it with the working file, or open an external directory diff.

### Search and filters

- Search with operators: `author:`, `committer:`, `message:`, `hash:`, `branch:`, `tag:`, `ref:`, `after:`, `before:`, `date:`.
- Search older commits that are not loaded yet; the graph loads up to the match.
- Filter by branches and tags, author, file or folder (with file history across renames), extra `git log` arguments, and hide branches by pattern.

### Actions

- Checkout, create, rename and delete branches (also on the remote), delete several at once.
- Create, push and delete tags.
- Fetch, pull and push. A force-push goes with a lease plus `--force-if-includes` (git 2.30+), so it refuses to overwrite commits that only a background fetch has brought in.
- Merge, rebase, cherry-pick, revert and reset; on several selected commits too.
- Interactive rebase edited in a VS Code editor; squash or drop selected commits; fixup commits and autosquash.
- Stash, apply, pop, drop, and create a branch from a stash.
- Continue or abort an interrupted merge, rebase, cherry-pick, revert, bisect or `git am`.
- Create patches from commits or uncommitted changes, and apply patches.
- Create archives (.zip, .tar.gz) of any commit.
- Repository settings: add, change and remove remotes; set the user for one repository.
- Check out and force-push tags; fetch without tags; "Current Branch (HEAD)" in the branch filter.
- Copy or open a commit's web link; plain web addresses in messages are links.
- A HEAD button to jump to the checked-out commit; Show Git Output with every command the actions ran.
- Author avatars, off by default, cached on disk in the extension's own storage.
- Passwords and SSH key passphrases are asked for in VS Code, so pushing and pulling work without a credential helper. When git still cannot ask, **Run in Terminal** quotes the command for the shell it opens: PowerShell, Command Prompt or a POSIX shell.
- Staged and working tree changes as separate rows, with Stage All and Unstage All.
- Several graph tabs at once; Go to Branch, Tag or Stash; open the graph automatically on startup.
- Compare any commit with the working tree; hovering a commit brings out its branch line; a detached HEAD is shown in the graph; many refs on one commit fold into "+N".

### Keyboard and screen readers

- Arrow keys, Page Up/Down, Home and End move through the history; Shift extends the selection.
- The menu key or Shift+F10 opens the context menu of the selected commit, with each of its branches and tags one entry away.
- The commit list, its menus and the changed files are announced to screen readers, one sentence per commit or file.

### Security

- Files at a revision (`git-graph-next:` URIs) are served only for repositories the extension knows and for full commit hashes or the index; nothing else reaches git.
- Paths sent back by the graph view are checked to stay inside the repository before a file is opened.
