# Changelog

All notable changes to Git Graph Next are listed here.

## 0.1.0 — first release

### Graph

- Fast, virtualised commit graph: only visible rows are drawn, so 100,000 commits scroll like 100.
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
- Fetch, pull and push (with `--force-with-lease`).
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
- Author avatars, off by default.
- Passwords and SSH key passphrases are asked for in VS Code, so pushing and pulling work without a credential helper.
- Staged and working tree changes as separate rows, with Stage All and Unstage All.
- Several graph tabs at once; Go to Branch, Tag or Stash; open the graph automatically on startup.
- Compare any commit with the working tree; hovering a commit brings out its branch line; a detached HEAD is shown in the graph; many refs on one commit fold into "+N".
