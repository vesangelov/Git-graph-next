# Security

## Reporting a vulnerability

Please report security issues privately to **<vesangelovdev@gmail.com>**, or
through GitHub's [private vulnerability
reporting](https://github.com/vesangelov/Git-graph-next/security/advisories/new).
Do not open a public issue for one.

Useful to include: what an attacker can do, what they need in order to do it
(a repository you can clone? a crafted branch name? a setting?), and the
versions of Git Graph Next, VS Code and git you saw it on.

You can expect an acknowledgement within a few days. Fixes go out as a patch
release, and you will be credited in the changelog unless you prefer not to be.

## Supported versions

The latest released version is the one that receives fixes.

## What this extension does

Knowing the shape of it makes reports easier to judge.

- **It runs `git`** against the repositories in your workspace, always by
  spawning the binary with an argument array. No shell is involved, so there is
  no command line for an argument to break out of. The one exception is the
  **Run in Terminal** offer, which writes a quoted command line into a VS Code
  terminal for you to run yourself.
- **It is disabled in untrusted workspaces**, because running git against a
  repository can execute code the repository controls (hooks, `core.fsmonitor`,
  filters).
- **The webview renders repository content** — commit messages, branch names,
  author names — which anyone who can get a commit into your repository
  controls. It builds its DOM through `createElement` and `textContent`, never
  `innerHTML`, and runs under a Content-Security-Policy with `default-src
  'none'`, no `unsafe-inline`, and a per-load nonce on the only script.
- **The webview is treated as untrusted by the host.** Values it posts back are
  validated before they reach a git argument list: commit hashes must be 40 hex
  characters, repository paths must be ones already known, ref names may not
  begin with `-` or contain control characters, and extra `git log` arguments
  are checked against an explicit list of what is refused.
- **It talks to the network only through your git** when you fetch, pull or
  push — with one opt-in exception below.

## Privacy

Git Graph Next collects no telemetry and sends nothing anywhere by itself.

The one exception is `git-graph-next.fetchAvatars`, which is **off by default**.
With it on, for each author shown the extension requests an avatar: the MD5 hash
of their e-mail address from Gravatar, or their user name from GitHub for GitHub
no-reply addresses. Those services therefore learn which authors appear in your
graph. Images are cached on disk in the extension's own storage directory and
can be removed with **Git Graph Next: Clear Avatar Cache**.

Passwords and SSH key passphrases typed into the extension's prompt are passed
straight to the git command that asked for them and are never stored, logged or
written to disk.

## Known limits

These are design trade-offs rather than bugs, and reports about them are not
treated as vulnerabilities:

- The editor bridge listens on a local socket (a named pipe on Windows) so that
  git's editor and askpass helpers can reach VS Code. Every request must carry a
  random per-session token, but on POSIX the socket lives in the system
  temporary directory, so it is protected by that token rather than by file
  permissions.
- Extra `git log` arguments and `diff.guitool` come from your own settings and
  are run as you configured them. A setting that runs a program is a setting
  that runs a program.
