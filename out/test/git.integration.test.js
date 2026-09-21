"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// test/git.integration.test.ts
var import_node_assert = require("node:assert");
var import_node_test = require("node:test");
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");

// src/git/executor.ts
var import_child_process = require("child_process");
var CancelledError = class extends Error {
  constructor() {
    super("The git command was cancelled");
    this.name = "CancelledError";
  }
};
var GitError = class extends Error {
  constructor(message, exitCode, args, stderr) {
    super(message);
    this.exitCode = exitCode;
    this.args = args;
    this.stderr = stderr;
    this.name = "GitError";
  }
};
function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - (b.patch ?? 0);
}
function parseVersion(raw) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (match === null) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3] !== void 0 ? parseInt(match[3], 10) : 0,
    raw: raw.trim()
  };
}
var GitExecutor = class _GitExecutor {
  constructor(binary, version) {
    this.binary = binary;
    this.version = version;
  }
  /**
   * Resolves the git binary to use, trying each candidate path in turn.
   * Rejects with a user-facing message when none of them run.
   */
  static async locate(candidates) {
    const failures = [];
    for (const candidate of candidates) {
      try {
        const output = await runRaw(candidate, ["--version"], process.cwd(), {});
        const version = parseVersion(output.stdout);
        if (version === null) {
          failures.push(`${candidate}: unrecognised version string "${output.stdout.trim()}"`);
          continue;
        }
        if (compareVersions(version, { major: 2, minor: 4 }) < 0) {
          failures.push(`${candidate}: git ${version.raw} is too old, 2.4.0 or later is required`);
          continue;
        }
        return new _GitExecutor(candidate, version);
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(
      'Git Graph Next could not find a usable git executable. Set "git-graph-next.git.path" to its location.\n' + failures.map((f) => `  \u2022 ${f}`).join("\n")
    );
  }
  /** True when the binary is at least the given version. */
  atLeast(major, minor, patch = 0) {
    return compareVersions(this.version, { major, minor, patch }) >= 0;
  }
  /** Runs git in `cwd` and resolves with stdout as UTF-8 text. */
  async run(cwd, args, options = {}) {
    const result = await runRaw(this.binary, args, cwd, options);
    if (result.code !== 0 && options.ignoreExitCode !== true) {
      throw new GitError(cleanStderr(result.stderr) || `git exited with code ${result.code}`, result.code, args, result.stderr);
    }
    return result.stdout;
  }
  /**
   * Runs git and resolves with raw stdout bytes, for content that is not
   * necessarily valid UTF-8 (`git show` of a binary blob, for example).
   */
  async runBinary(cwd, args, options = {}) {
    const result = await runRaw(this.binary, args, cwd, { ...options, binary: true });
    if (result.code !== 0 && options.ignoreExitCode !== true) {
      throw new GitError(cleanStderr(result.stderr) || `git exited with code ${result.code}`, result.code, args, result.stderr);
    }
    return result.stdoutBuffer;
  }
  /** Runs git and resolves to null instead of throwing when it fails. */
  async runOrNull(cwd, args, options = {}) {
    try {
      return await this.run(cwd, args, options);
    } catch {
      return null;
    }
  }
};
function cleanStderr(stderr) {
  return stderr.split("\n").map((line) => line.replace(/^(?:error|fatal):\s*/i, "").trim()).filter((line) => line.length > 0).join("\n").trim();
}
function runRaw(binary, args, cwd, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = (0, import_child_process.spawn)(binary, args, {
        cwd,
        env: buildEnvironment(options.env),
        windowsHide: true
      });
    } catch (error) {
      reject(new Error(`failed to spawn "${binary}": ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      fn();
    };
    const cancellation = options.token?.onCancellationRequested(() => {
      child.kill("SIGTERM");
      finish(() => reject(new CancelledError()));
    });
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      finish(
        () => resolve({
          code,
          stdout: options.binary === true ? "" : stdoutBuffer.toString("utf8"),
          stdoutBuffer,
          stderr: Buffer.concat(stderrChunks).toString("utf8")
        })
      );
    });
    if (options.stdin !== void 0) {
      child.stdin.on("error", () => {
      });
      child.stdin.end(options.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}
function buildEnvironment(extra) {
  return {
    ...process.env,
    ...extra,
    // Keep git's own messages and date formatting predictable for parsing,
    // while leaving user content (commit messages, paths) untouched.
    LC_ALL: "C",
    LANG: "C",
    // Read-only commands must not take index.lock, otherwise refreshing the
    // graph fights with VS Code's built-in Git extension over the same file.
    GIT_OPTIONAL_LOCKS: "0",
    // Never block on an interactive credential or passphrase prompt: a
    // hidden prompt leaves the extension hanging with no way to answer it.
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    // Avoid an editor that never returns for commands that may open one.
    GIT_EDITOR: "true"
  };
}

// src/git/log.ts
var LOG_FIELDS = ["%H", "%P", "%an", "%ae", "%at", "%cn", "%ce", "%ct", "%s", "%b"];
var LOG_FORMAT = `--format=${LOG_FIELDS.join("%x00")}`;
var FIELDS_PER_COMMIT = LOG_FIELDS.length;
function buildLogArgs(request, supportsExclude) {
  const { filter } = request;
  const args = ["log", LOG_FORMAT, "-z"];
  args.push(`-n${request.maxCommits + 1}`);
  switch (request.ordering) {
    case "date":
      args.push("--date-order");
      break;
    case "author-date":
      args.push("--author-date-order");
      break;
    case "topological":
      args.push("--topo-order");
      break;
  }
  if (request.onlyFollowFirstParent) args.push("--first-parent");
  if (supportsExclude) {
    for (const glob of filter.excludeGlobs) args.push(`--exclude=${glob}`);
  }
  if (filter.branches.length > 0) {
    args.push(...filter.branches);
  } else {
    args.push("--branches");
    if (filter.showRemoteBranches) args.push("--remotes");
    if (filter.showTags) args.push("--tags");
    args.push("HEAD");
    if (request.includeCommitsMentionedByReflogs) args.push("--reflog");
    if (request.includeStashes) args.push("--glob=refs/stash");
  }
  for (const author of filter.authors) args.push(`--author=${author}`);
  if (filter.grep !== null && filter.grep !== "") {
    args.push(`--grep=${filter.grep}`, "--regexp-ignore-case");
  }
  if (filter.since !== null) args.push(`--since=${filter.since}`);
  if (filter.until !== null) args.push(`--until=${filter.until}`);
  args.push(...filter.extraArgs);
  if (filter.paths.length > 0) {
    if (request.followRenames && filter.paths.length === 1) args.push("--follow");
    args.push("--", ...filter.paths);
  }
  return args;
}
function parseLog(stdout) {
  if (stdout.length === 0) return [];
  const fields = stdout.split("\0");
  const commits = [];
  const usableRecords = Math.floor(fields.length / FIELDS_PER_COMMIT);
  for (let record = 0; record < usableRecords; record++) {
    const base = record * FIELDS_PER_COMMIT;
    const hash = fields[base].replace(/^\n/, "");
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    const parentField = fields[base + 1];
    commits.push({
      hash,
      parents: parentField.length === 0 ? [] : parentField.split(" "),
      author: fields[base + 2],
      authorEmail: fields[base + 3],
      authorDate: parseInt(fields[base + 4], 10) || 0,
      committer: fields[base + 5],
      committerEmail: fields[base + 6],
      committerDate: parseInt(fields[base + 7], 10) || 0,
      subject: fields[base + 8],
      body: fields[base + 9].replace(/\n+$/, ""),
      stash: null
    });
  }
  return commits;
}
var GitLogReader = class {
  constructor(git2, repoPath) {
    this.git = git2;
    this.repoPath = repoPath;
  }
  async read(request) {
    const args = buildLogArgs(request, this.git.atLeast(1, 9));
    const stdout = await this.git.run(this.repoPath, args);
    const commits = parseLog(stdout);
    if (commits.length > request.maxCommits) {
      return { commits: commits.slice(0, request.maxCommits), moreAvailable: true };
    }
    return { commits, moreAvailable: false };
  }
  /** Resolves a revision to a full hash, or null when it does not exist. */
  async resolve(revision) {
    const output = await this.git.runOrNull(this.repoPath, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    const hash = output?.trim() ?? "";
    return /^[0-9a-f]{40}$/.test(hash) ? hash : null;
  }
};

// src/types.ts
var UNCOMMITTED = "*".repeat(40);
var RefType = {
  Head: "head",
  RemoteHead: "remoteHead",
  Tag: "tag"
};
var PendingOperation = {
  Merge: "merge",
  Rebase: "rebase",
  CherryPick: "cherry-pick",
  Revert: "revert",
  Bisect: "bisect"
};

// src/git/refs.ts
var REF_FIELDS = [
  "%(refname)",
  "%(objectname)",
  "%(objecttype)",
  "%(*objectname)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(symref)"
];
var REF_FORMAT = `--format=${REF_FIELDS.join("%00")}%00`;
var FIELDS_PER_REF = REF_FIELDS.length;
function parseUpstreamTrack(track) {
  if (track === "" || track.includes("gone")) return { ahead: null, behind: null };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (ahead === null && behind === null) {
    return { ahead: 0, behind: 0 };
  }
  return {
    ahead: ahead !== null ? parseInt(ahead[1], 10) : 0,
    behind: behind !== null ? parseInt(behind[1], 10) : 0
  };
}
function splitRemoteRef(shortName, remotes) {
  for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
    if (shortName === remote) return null;
    if (shortName.startsWith(`${remote}/`)) {
      return { remote, branch: shortName.slice(remote.length + 1) };
    }
  }
  return null;
}
function parseRefs(stdout, remotes) {
  const heads = [];
  const remoteHeads = [];
  const tags = [];
  const remoteHeadSymrefs = {};
  const fields = stdout.split("\0");
  const records = Math.floor(fields.length / FIELDS_PER_REF);
  for (let record = 0; record < records; record++) {
    const base = record * FIELDS_PER_REF;
    const refname = fields[base].replace(/^\n/, "");
    const objectname = fields[base + 1];
    const objecttype = fields[base + 2];
    const dereferenced = fields[base + 3];
    const upstream = fields[base + 4];
    const track = fields[base + 5];
    const symref = fields[base + 6];
    if (refname.startsWith("refs/heads/")) {
      const { ahead, behind } = parseUpstreamTrack(track);
      heads.push({
        type: RefType.Head,
        name: refname.slice("refs/heads/".length),
        hash: objectname,
        upstream: upstream === "" ? null : upstream,
        ahead: upstream === "" ? null : ahead,
        behind: upstream === "" ? null : behind
      });
    } else if (refname.startsWith("refs/remotes/")) {
      const shortName = refname.slice("refs/remotes/".length);
      const split = splitRemoteRef(shortName, remotes);
      if (split === null) continue;
      if (split.branch === "HEAD") {
        if (symref !== "") {
          remoteHeadSymrefs[split.remote] = symref.replace(/^refs\/remotes\//, "");
        }
        continue;
      }
      remoteHeads.push({ type: RefType.RemoteHead, name: shortName, remote: split.remote, hash: objectname });
    } else if (refname.startsWith("refs/tags/")) {
      const annotated = objecttype === "tag";
      tags.push({
        type: RefType.Tag,
        name: refname.slice("refs/tags/".length),
        // An annotated tag's own object id is not a commit; the graph
        // must attach the label to the commit it dereferences to.
        hash: annotated && dereferenced !== "" ? dereferenced : objectname,
        annotated
      });
    }
  }
  return { heads, remoteHeads, tags, remoteHeadSymrefs };
}
var GitRefReader = class {
  constructor(git2, repoPath) {
    this.git = git2;
    this.repoPath = repoPath;
  }
  async remotes() {
    const output = await this.git.run(this.repoPath, ["remote"]);
    return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  }
  async readRefs(remotes) {
    const stdout = await this.git.run(this.repoPath, [
      "for-each-ref",
      REF_FORMAT,
      "refs/heads",
      "refs/remotes",
      "refs/tags"
    ]);
    return parseRefs(stdout, remotes);
  }
  /**
   * Reads the stash list. Stashes are commits that no branch points at, so
   * they must be collected separately or they vanish from the graph.
   */
  async readStashes() {
    const output = await this.git.runOrNull(this.repoPath, [
      "stash",
      "list",
      "--format=%gd%x00%H%x00%P%x00%at%x00%gs"
    ]);
    if (output === null) return [];
    const stashes = [];
    for (const line of output.split("\n")) {
      if (line.length === 0) continue;
      const parts = line.split("\0");
      if (parts.length < 5) continue;
      const parents = parts[2].split(" ").filter((p) => p.length > 0);
      const index = /^stash@\{(\d+)\}$/.exec(parts[0]);
      stashes.push({
        index: index !== null ? parseInt(index[1], 10) : stashes.length,
        hash: parts[1],
        baseHash: parents[0] ?? "",
        selector: parts[0],
        message: parts[4],
        date: parseInt(parts[3], 10) || 0
      });
    }
    return stashes;
  }
  /** Reads which branch is checked out, and whether an operation is in progress. */
  async readState() {
    const [headName, headHash, pending] = await Promise.all([
      this.git.runOrNull(this.repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]),
      this.git.runOrNull(this.repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]),
      this.readPendingOperation()
    ]);
    const head = headName?.trim() ?? "";
    const hash = headHash?.trim() ?? "";
    return {
      head: head === "" ? null : head,
      headHash: /^[0-9a-f]{40}$/.test(hash) ? hash : null,
      isDetached: head === "",
      pendingOperation: pending
    };
  }
  /**
   * Detects an interrupted merge, rebase, cherry-pick, revert or bisect.
   *
   * These are read from the git directory rather than inferred, so the view
   * can offer `--continue` / `--abort` instead of leaving the user stuck in a
   * state the graph does not acknowledge.
   */
  async readPendingOperation() {
    const gitDir = (await this.git.runOrNull(this.repoPath, ["rev-parse", "--absolute-git-dir"]))?.trim();
    if (gitDir === void 0 || gitDir === "") return null;
    const { existsSync } = await import("node:fs");
    const { join: join2 } = await import("node:path");
    const has = (...parts) => existsSync(join2(gitDir, ...parts));
    if (has("rebase-merge") || has("rebase-apply")) return PendingOperation.Rebase;
    if (has("MERGE_HEAD")) return PendingOperation.Merge;
    if (has("CHERRY_PICK_HEAD")) return PendingOperation.CherryPick;
    if (has("REVERT_HEAD")) return PendingOperation.Revert;
    if (has("BISECT_LOG")) return PendingOperation.Bisect;
    return null;
  }
  /** Returns the hashes of commits that are stash entries, for graph inclusion. */
  static stashHashes(stashes) {
    return new Set(stashes.map((stash) => stash.hash));
  }
  /** Type guard used by the view when narrowing a mixed ref list. */
  static isHead(ref) {
    return ref.type === RefType.Head;
  }
};

// test/git.integration.test.ts
var repo;
var git;
function fixture(cwd, ...args) {
  return (0, import_node_child_process.execFileSync)("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  });
}
function commitFile(cwd, name, content, message) {
  (0, import_node_fs.writeFileSync)((0, import_node_path.join)(cwd, name), content);
  fixture(cwd, "add", name);
  fixture(cwd, "-c", "commit.gpgsign=false", "commit", "-m", message);
}
(0, import_node_test.before)(async () => {
  repo = (0, import_node_fs.mkdtempSync)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "ggn-test-"));
  fixture(repo, "init", "-q", "-b", "main");
  fixture(repo, "config", "user.email", "test@example.com");
  fixture(repo, "config", "user.name", "\u0422\u0435\u0441\u0442 \u041F\u043E\u0442\u0440\u0435\u0431\u0438\u0442\u0435\u043B");
  commitFile(repo, "a.txt", "a\n", "\u043F\u044A\u0440\u0432\u0438 \u043A\u043E\u043C\u0438\u0442 \u0441 \u043A\u0438\u0440\u0438\u043B\u0438\u0446\u0430 \u{1F389}");
  commitFile(repo, "a.txt", "ab\n", 'subject line\n\nA body with a blank line.\n\nAnd a "quoted" $(thing) | pipe.');
  fixture(repo, "checkout", "-q", "-b", "feature");
  commitFile(repo, "c.txt", "c\n", "work on the feature");
  fixture(repo, "checkout", "-q", "main");
  commitFile(repo, "d.txt", "d\n", "main moves on");
  fixture(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "feature", "-m", "merge feature");
  fixture(repo, "tag", "-a", "v1.0", "-m", "release one");
  fixture(repo, "tag", "lightweight");
  git = await GitExecutor.locate(["git"]);
});
(0, import_node_test.after)(() => {
  (0, import_node_fs.rmSync)(repo, { recursive: true, force: true });
});
(0, import_node_test.test)("locates a usable git binary and reports its version", () => {
  import_node_assert.strict.ok(git.version.major >= 2, `unexpected git version ${git.version.raw}`);
  import_node_assert.strict.equal(git.atLeast(2, 0), true);
  import_node_assert.strict.equal(git.atLeast(99, 0), false);
});
(0, import_node_test.test)("reports a clear error when no git binary can be found", async () => {
  await import_node_assert.strict.rejects(
    () => GitExecutor.locate(["/nonexistent/git-binary"]),
    (error) => {
      import_node_assert.strict.match(error.message, /could not find a usable git executable/);
      import_node_assert.strict.match(error.message, /git-graph-next\.git\.path/, "the message must say how to fix it");
      return true;
    }
  );
});
(0, import_node_test.test)("reads every commit with its parents in order", async () => {
  const reader = new GitLogReader(git, repo);
  const result = await reader.read({
    filter: {
      paths: [],
      authors: [],
      branches: [],
      excludeGlobs: [],
      showRemoteBranches: true,
      showTags: true,
      grep: null,
      since: null,
      until: null,
      extraArgs: []
    },
    maxCommits: 100,
    ordering: "date",
    onlyFollowFirstParent: false,
    includeCommitsMentionedByReflogs: false,
    followRenames: false,
    includeStashes: false
  });
  import_node_assert.strict.equal(result.commits.length, 5);
  import_node_assert.strict.equal(result.moreAvailable, false);
  import_node_assert.strict.equal(result.commits[0].subject, "merge feature");
  import_node_assert.strict.equal(result.commits[0].parents.length, 2, "a merge commit keeps both parents");
  import_node_assert.strict.equal(result.commits[4].parents.length, 0, "the root commit has no parents");
  for (const commit of result.commits) {
    import_node_assert.strict.match(commit.hash, /^[0-9a-f]{40}$/);
    import_node_assert.strict.ok(commit.authorDate > 0, "author date must be a real timestamp");
  }
});
(0, import_node_test.test)("preserves non-ASCII authors and hostile commit messages", async () => {
  const reader = new GitLogReader(git, repo);
  const { commits } = await reader.read({
    filter: {
      paths: [],
      authors: [],
      branches: [],
      excludeGlobs: [],
      showRemoteBranches: true,
      showTags: true,
      grep: null,
      since: null,
      until: null,
      extraArgs: []
    },
    maxCommits: 100,
    ordering: "date",
    onlyFollowFirstParent: false,
    includeCommitsMentionedByReflogs: false,
    followRenames: false,
    includeStashes: false
  });
  const root = commits[commits.length - 1];
  import_node_assert.strict.equal(root.subject, "\u043F\u044A\u0440\u0432\u0438 \u043A\u043E\u043C\u0438\u0442 \u0441 \u043A\u0438\u0440\u0438\u043B\u0438\u0446\u0430 \u{1F389}");
  import_node_assert.strict.equal(root.author, "\u0422\u0435\u0441\u0442 \u041F\u043E\u0442\u0440\u0435\u0431\u0438\u0442\u0435\u043B");
  const bodied = commits.find((c) => c.subject === "subject line");
  import_node_assert.strict.ok(bodied !== void 0, "the multi-line commit must be present");
  import_node_assert.strict.match(bodied.body, /A body with a blank line\./);
  import_node_assert.strict.match(bodied.body, /"quoted" \$\(thing\) \| pipe\./, "shell metacharacters must survive verbatim");
});
(0, import_node_test.test)("reports when more commits are available than were requested", async () => {
  const reader = new GitLogReader(git, repo);
  const { commits, moreAvailable } = await reader.read({
    filter: {
      paths: [],
      authors: [],
      branches: [],
      excludeGlobs: [],
      showRemoteBranches: true,
      showTags: true,
      grep: null,
      since: null,
      until: null,
      extraArgs: []
    },
    maxCommits: 2,
    ordering: "date",
    onlyFollowFirstParent: false,
    includeCommitsMentionedByReflogs: false,
    followRenames: false,
    includeStashes: false
  });
  import_node_assert.strict.equal(commits.length, 2, "exactly the requested number is returned");
  import_node_assert.strict.equal(moreAvailable, true);
});
(0, import_node_test.test)("filters history to a single path", async () => {
  const reader = new GitLogReader(git, repo);
  const { commits } = await reader.read({
    filter: {
      paths: ["c.txt"],
      authors: [],
      branches: [],
      excludeGlobs: [],
      showRemoteBranches: true,
      showTags: true,
      grep: null,
      since: null,
      until: null,
      extraArgs: []
    },
    maxCommits: 100,
    ordering: "date",
    onlyFollowFirstParent: false,
    includeCommitsMentionedByReflogs: false,
    followRenames: false,
    includeStashes: false
  });
  import_node_assert.strict.equal(commits.length, 1);
  import_node_assert.strict.equal(commits[0].subject, "work on the feature");
});
(0, import_node_test.test)("filters history by author", async () => {
  const reader = new GitLogReader(git, repo);
  const { commits } = await reader.read({
    filter: {
      paths: [],
      authors: ["nobody@example.com"],
      branches: [],
      excludeGlobs: [],
      showRemoteBranches: true,
      showTags: true,
      grep: null,
      since: null,
      until: null,
      extraArgs: []
    },
    maxCommits: 100,
    ordering: "date",
    onlyFollowFirstParent: false,
    includeCommitsMentionedByReflogs: false,
    followRenames: false,
    includeStashes: false
  });
  import_node_assert.strict.equal(commits.length, 0, "an author with no commits yields nothing, not everything");
});
(0, import_node_test.test)("resolves revisions and rejects ones that do not exist", async () => {
  const reader = new GitLogReader(git, repo);
  import_node_assert.strict.match(await reader.resolve("main") ?? "", /^[0-9a-f]{40}$/);
  import_node_assert.strict.equal(await reader.resolve("no-such-branch"), null);
});
(0, import_node_test.test)("attaches annotated tags to the commit, not the tag object", async () => {
  const refReader = new GitRefReader(git, repo);
  const remotes = await refReader.remotes();
  const refs = await refReader.readRefs(remotes);
  const annotated = refs.tags.find((t) => t.name === "v1.0");
  const lightweight = refs.tags.find((t) => t.name === "lightweight");
  import_node_assert.strict.ok(annotated !== void 0 && lightweight !== void 0);
  import_node_assert.strict.equal(annotated.annotated, true);
  import_node_assert.strict.equal(lightweight.annotated, false);
  const head = await new GitLogReader(git, repo).resolve("HEAD");
  import_node_assert.strict.equal(annotated.hash, head, "the annotated tag must dereference to its commit");
  import_node_assert.strict.equal(lightweight.hash, head);
});
(0, import_node_test.test)("reads local branches and their tracking state", async () => {
  const refReader = new GitRefReader(git, repo);
  const refs = await refReader.readRefs(await refReader.remotes());
  import_node_assert.strict.deepEqual(refs.heads.map((h) => h.name).sort(), ["feature", "main"]);
  for (const head of refs.heads) {
    import_node_assert.strict.equal(head.upstream, null, "this fixture has no remotes configured");
    import_node_assert.strict.equal(head.ahead, null);
  }
});
(0, import_node_test.test)("reads the checked out branch and detached HEAD", async () => {
  const refReader = new GitRefReader(git, repo);
  const onBranch = await refReader.readState();
  import_node_assert.strict.equal(onBranch.head, "main");
  import_node_assert.strict.equal(onBranch.isDetached, false);
  import_node_assert.strict.equal(onBranch.pendingOperation, null);
  fixture(repo, "checkout", "-q", "--detach", "HEAD");
  const detached = await refReader.readState();
  import_node_assert.strict.equal(detached.head, null);
  import_node_assert.strict.equal(detached.isDetached, true);
  import_node_assert.strict.match(detached.headHash ?? "", /^[0-9a-f]{40}$/);
  fixture(repo, "checkout", "-q", "main");
});
(0, import_node_test.test)("reads stash entries with the commit they were taken against", async () => {
  (0, import_node_fs.writeFileSync)((0, import_node_path.join)(repo, "a.txt"), "dirty\n");
  fixture(repo, "stash", "push", "-m", "work in progress");
  const stashes = await new GitRefReader(git, repo).readStashes();
  import_node_assert.strict.equal(stashes.length, 1);
  import_node_assert.strict.equal(stashes[0].index, 0);
  import_node_assert.strict.equal(stashes[0].selector, "stash@{0}");
  import_node_assert.strict.match(stashes[0].message, /work in progress/);
  import_node_assert.strict.match(stashes[0].hash, /^[0-9a-f]{40}$/);
  import_node_assert.strict.match(stashes[0].baseHash, /^[0-9a-f]{40}$/);
  fixture(repo, "stash", "drop");
});
(0, import_node_test.test)("detects an interrupted merge so the view can offer to abort it", async () => {
  const conflict = (0, import_node_fs.mkdtempSync)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "ggn-conflict-"));
  fixture(conflict, "init", "-q", "-b", "main");
  fixture(conflict, "config", "user.email", "test@example.com");
  fixture(conflict, "config", "user.name", "Test");
  commitFile(conflict, "f.txt", "base\n", "base");
  fixture(conflict, "checkout", "-q", "-b", "other");
  commitFile(conflict, "f.txt", "other\n", "other side");
  fixture(conflict, "checkout", "-q", "main");
  commitFile(conflict, "f.txt", "main\n", "main side");
  try {
    fixture(conflict, "-c", "commit.gpgsign=false", "merge", "other");
  } catch {
  }
  const state = await new GitRefReader(git, conflict).readState();
  import_node_assert.strict.equal(state.pendingOperation, PendingOperation.Merge);
  (0, import_node_fs.rmSync)(conflict, { recursive: true, force: true });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vdGVzdC9naXQuaW50ZWdyYXRpb24udGVzdC50cyIsICIuLi8uLi9zcmMvZ2l0L2V4ZWN1dG9yLnRzIiwgIi4uLy4uL3NyYy9naXQvbG9nLnRzIiwgIi4uLy4uL3NyYy90eXBlcy50cyIsICIuLi8uLi9zcmMvZ2l0L3JlZnMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHN0cmljdCBhcyBhc3NlcnQgfSBmcm9tICdub2RlOmFzc2VydCc7XG5pbXBvcnQgeyBhZnRlciwgYmVmb3JlLCB0ZXN0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgR2l0RXhlY3V0b3IgfSBmcm9tICcuLi9zcmMvZ2l0L2V4ZWN1dG9yLnRzJztcbmltcG9ydCB7IEdpdExvZ1JlYWRlciB9IGZyb20gJy4uL3NyYy9naXQvbG9nLnRzJztcbmltcG9ydCB7IEdpdFJlZlJlYWRlciB9IGZyb20gJy4uL3NyYy9naXQvcmVmcy50cyc7XG5pbXBvcnQgeyBQZW5kaW5nT3BlcmF0aW9uIH0gZnJvbSAnLi4vc3JjL3R5cGVzLnRzJztcblxubGV0IHJlcG86IHN0cmluZztcbmxldCBnaXQ6IEdpdEV4ZWN1dG9yO1xuXG4vKiogUnVucyBnaXQgZGlyZWN0bHksIGJ5cGFzc2luZyB0aGUgbGF5ZXIgdW5kZXIgdGVzdCwgdG8gYnVpbGQgZml4dHVyZXMuICovXG5mdW5jdGlvbiBmaXh0dXJlKGN3ZDogc3RyaW5nLCAuLi5hcmdzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG5cdHJldHVybiBleGVjRmlsZVN5bmMoJ2dpdCcsIGFyZ3MsIHtcblx0XHRjd2QsXG5cdFx0ZW5jb2Rpbmc6ICd1dGY4Jyxcblx0XHRlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIExDX0FMTDogJ0MnLCBHSVRfQ09ORklHX0dMT0JBTDogJy9kZXYvbnVsbCcsIEdJVF9DT05GSUdfU1lTVEVNOiAnL2Rldi9udWxsJyB9XG5cdH0pO1xufVxuXG5mdW5jdGlvbiBjb21taXRGaWxlKGN3ZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG5cdHdyaXRlRmlsZVN5bmMoam9pbihjd2QsIG5hbWUpLCBjb250ZW50KTtcblx0Zml4dHVyZShjd2QsICdhZGQnLCBuYW1lKTtcblx0Zml4dHVyZShjd2QsICctYycsICdjb21taXQuZ3Bnc2lnbj1mYWxzZScsICdjb21taXQnLCAnLW0nLCBtZXNzYWdlKTtcbn1cblxuYmVmb3JlKGFzeW5jICgpID0+IHtcblx0cmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnZ24tdGVzdC0nKSk7XG5cdGZpeHR1cmUocmVwbywgJ2luaXQnLCAnLXEnLCAnLWInLCAnbWFpbicpO1xuXHRmaXh0dXJlKHJlcG8sICdjb25maWcnLCAndXNlci5lbWFpbCcsICd0ZXN0QGV4YW1wbGUuY29tJyk7XG5cdGZpeHR1cmUocmVwbywgJ2NvbmZpZycsICd1c2VyLm5hbWUnLCAnXHUwNDIyXHUwNDM1XHUwNDQxXHUwNDQyIFx1MDQxRlx1MDQzRVx1MDQ0Mlx1MDQ0MFx1MDQzNVx1MDQzMVx1MDQzOFx1MDQ0Mlx1MDQzNVx1MDQzQicpO1xuXG5cdGNvbW1pdEZpbGUocmVwbywgJ2EudHh0JywgJ2FcXG4nLCAnXHUwNDNGXHUwNDRBXHUwNDQwXHUwNDMyXHUwNDM4IFx1MDQzQVx1MDQzRVx1MDQzQ1x1MDQzOFx1MDQ0MiBcdTA0NDEgXHUwNDNBXHUwNDM4XHUwNDQwXHUwNDM4XHUwNDNCXHUwNDM4XHUwNDQ2XHUwNDMwIFx1RDgzQ1x1REY4OScpO1xuXHRjb21taXRGaWxlKHJlcG8sICdhLnR4dCcsICdhYlxcbicsICdzdWJqZWN0IGxpbmVcXG5cXG5BIGJvZHkgd2l0aCBhIGJsYW5rIGxpbmUuXFxuXFxuQW5kIGEgXCJxdW90ZWRcIiAkKHRoaW5nKSB8IHBpcGUuJyk7XG5cdGZpeHR1cmUocmVwbywgJ2NoZWNrb3V0JywgJy1xJywgJy1iJywgJ2ZlYXR1cmUnKTtcblx0Y29tbWl0RmlsZShyZXBvLCAnYy50eHQnLCAnY1xcbicsICd3b3JrIG9uIHRoZSBmZWF0dXJlJyk7XG5cdGZpeHR1cmUocmVwbywgJ2NoZWNrb3V0JywgJy1xJywgJ21haW4nKTtcblx0Y29tbWl0RmlsZShyZXBvLCAnZC50eHQnLCAnZFxcbicsICdtYWluIG1vdmVzIG9uJyk7XG5cdGZpeHR1cmUocmVwbywgJy1jJywgJ2NvbW1pdC5ncGdzaWduPWZhbHNlJywgJ21lcmdlJywgJy1xJywgJy0tbm8tZmYnLCAnZmVhdHVyZScsICctbScsICdtZXJnZSBmZWF0dXJlJyk7XG5cdGZpeHR1cmUocmVwbywgJ3RhZycsICctYScsICd2MS4wJywgJy1tJywgJ3JlbGVhc2Ugb25lJyk7XG5cdGZpeHR1cmUocmVwbywgJ3RhZycsICdsaWdodHdlaWdodCcpO1xuXG5cdGdpdCA9IGF3YWl0IEdpdEV4ZWN1dG9yLmxvY2F0ZShbJ2dpdCddKTtcbn0pO1xuXG5hZnRlcigoKSA9PiB7XG5cdHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgnbG9jYXRlcyBhIHVzYWJsZSBnaXQgYmluYXJ5IGFuZCByZXBvcnRzIGl0cyB2ZXJzaW9uJywgKCkgPT4ge1xuXHRhc3NlcnQub2soZ2l0LnZlcnNpb24ubWFqb3IgPj0gMiwgYHVuZXhwZWN0ZWQgZ2l0IHZlcnNpb24gJHtnaXQudmVyc2lvbi5yYXd9YCk7XG5cdGFzc2VydC5lcXVhbChnaXQuYXRMZWFzdCgyLCAwKSwgdHJ1ZSk7XG5cdGFzc2VydC5lcXVhbChnaXQuYXRMZWFzdCg5OSwgMCksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KCdyZXBvcnRzIGEgY2xlYXIgZXJyb3Igd2hlbiBubyBnaXQgYmluYXJ5IGNhbiBiZSBmb3VuZCcsIGFzeW5jICgpID0+IHtcblx0YXdhaXQgYXNzZXJ0LnJlamVjdHMoXG5cdFx0KCkgPT4gR2l0RXhlY3V0b3IubG9jYXRlKFsnL25vbmV4aXN0ZW50L2dpdC1iaW5hcnknXSksXG5cdFx0KGVycm9yOiBFcnJvcikgPT4ge1xuXHRcdFx0YXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC9jb3VsZCBub3QgZmluZCBhIHVzYWJsZSBnaXQgZXhlY3V0YWJsZS8pO1xuXHRcdFx0YXNzZXJ0Lm1hdGNoKGVycm9yLm1lc3NhZ2UsIC9naXQtZ3JhcGgtbmV4dFxcLmdpdFxcLnBhdGgvLCAndGhlIG1lc3NhZ2UgbXVzdCBzYXkgaG93IHRvIGZpeCBpdCcpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fVxuXHQpO1xufSk7XG5cbnRlc3QoJ3JlYWRzIGV2ZXJ5IGNvbW1pdCB3aXRoIGl0cyBwYXJlbnRzIGluIG9yZGVyJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCByZWFkZXIgPSBuZXcgR2l0TG9nUmVhZGVyKGdpdCwgcmVwbyk7XG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlYWRlci5yZWFkKHtcblx0XHRmaWx0ZXI6IHtcblx0XHRcdHBhdGhzOiBbXSwgYXV0aG9yczogW10sIGJyYW5jaGVzOiBbXSwgZXhjbHVkZUdsb2JzOiBbXSxcblx0XHRcdHNob3dSZW1vdGVCcmFuY2hlczogdHJ1ZSwgc2hvd1RhZ3M6IHRydWUsIGdyZXA6IG51bGwsIHNpbmNlOiBudWxsLCB1bnRpbDogbnVsbCwgZXh0cmFBcmdzOiBbXVxuXHRcdH0sXG5cdFx0bWF4Q29tbWl0czogMTAwLFxuXHRcdG9yZGVyaW5nOiAnZGF0ZScsXG5cdFx0b25seUZvbGxvd0ZpcnN0UGFyZW50OiBmYWxzZSxcblx0XHRpbmNsdWRlQ29tbWl0c01lbnRpb25lZEJ5UmVmbG9nczogZmFsc2UsXG5cdFx0Zm9sbG93UmVuYW1lczogZmFsc2UsXG5cdFx0aW5jbHVkZVN0YXNoZXM6IGZhbHNlXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29tbWl0cy5sZW5ndGgsIDUpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0Lm1vcmVBdmFpbGFibGUsIGZhbHNlKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5jb21taXRzWzBdLnN1YmplY3QsICdtZXJnZSBmZWF0dXJlJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29tbWl0c1swXS5wYXJlbnRzLmxlbmd0aCwgMiwgJ2EgbWVyZ2UgY29tbWl0IGtlZXBzIGJvdGggcGFyZW50cycpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbW1pdHNbNF0ucGFyZW50cy5sZW5ndGgsIDAsICd0aGUgcm9vdCBjb21taXQgaGFzIG5vIHBhcmVudHMnKTtcblx0Zm9yIChjb25zdCBjb21taXQgb2YgcmVzdWx0LmNvbW1pdHMpIHtcblx0XHRhc3NlcnQubWF0Y2goY29tbWl0Lmhhc2gsIC9eWzAtOWEtZl17NDB9JC8pO1xuXHRcdGFzc2VydC5vayhjb21taXQuYXV0aG9yRGF0ZSA+IDAsICdhdXRob3IgZGF0ZSBtdXN0IGJlIGEgcmVhbCB0aW1lc3RhbXAnKTtcblx0fVxufSk7XG5cbnRlc3QoJ3ByZXNlcnZlcyBub24tQVNDSUkgYXV0aG9ycyBhbmQgaG9zdGlsZSBjb21taXQgbWVzc2FnZXMnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHJlYWRlciA9IG5ldyBHaXRMb2dSZWFkZXIoZ2l0LCByZXBvKTtcblx0Y29uc3QgeyBjb21taXRzIH0gPSBhd2FpdCByZWFkZXIucmVhZCh7XG5cdFx0ZmlsdGVyOiB7XG5cdFx0XHRwYXRoczogW10sIGF1dGhvcnM6IFtdLCBicmFuY2hlczogW10sIGV4Y2x1ZGVHbG9iczogW10sXG5cdFx0XHRzaG93UmVtb3RlQnJhbmNoZXM6IHRydWUsIHNob3dUYWdzOiB0cnVlLCBncmVwOiBudWxsLCBzaW5jZTogbnVsbCwgdW50aWw6IG51bGwsIGV4dHJhQXJnczogW11cblx0XHR9LFxuXHRcdG1heENvbW1pdHM6IDEwMCwgb3JkZXJpbmc6ICdkYXRlJywgb25seUZvbGxvd0ZpcnN0UGFyZW50OiBmYWxzZSxcblx0XHRpbmNsdWRlQ29tbWl0c01lbnRpb25lZEJ5UmVmbG9nczogZmFsc2UsIGZvbGxvd1JlbmFtZXM6IGZhbHNlLCBpbmNsdWRlU3Rhc2hlczogZmFsc2Vcblx0fSk7XG5cblx0Y29uc3Qgcm9vdCA9IGNvbW1pdHNbY29tbWl0cy5sZW5ndGggLSAxXTtcblx0YXNzZXJ0LmVxdWFsKHJvb3Quc3ViamVjdCwgJ1x1MDQzRlx1MDQ0QVx1MDQ0MFx1MDQzMlx1MDQzOCBcdTA0M0FcdTA0M0VcdTA0M0NcdTA0MzhcdTA0NDIgXHUwNDQxIFx1MDQzQVx1MDQzOFx1MDQ0MFx1MDQzOFx1MDQzQlx1MDQzOFx1MDQ0Nlx1MDQzMCBcdUQ4M0NcdURGODknKTtcblx0YXNzZXJ0LmVxdWFsKHJvb3QuYXV0aG9yLCAnXHUwNDIyXHUwNDM1XHUwNDQxXHUwNDQyIFx1MDQxRlx1MDQzRVx1MDQ0Mlx1MDQ0MFx1MDQzNVx1MDQzMVx1MDQzOFx1MDQ0Mlx1MDQzNVx1MDQzQicpO1xuXG5cdGNvbnN0IGJvZGllZCA9IGNvbW1pdHMuZmluZCgoYykgPT4gYy5zdWJqZWN0ID09PSAnc3ViamVjdCBsaW5lJyk7XG5cdGFzc2VydC5vayhib2RpZWQgIT09IHVuZGVmaW5lZCwgJ3RoZSBtdWx0aS1saW5lIGNvbW1pdCBtdXN0IGJlIHByZXNlbnQnKTtcblx0YXNzZXJ0Lm1hdGNoKGJvZGllZC5ib2R5LCAvQSBib2R5IHdpdGggYSBibGFuayBsaW5lXFwuLyk7XG5cdGFzc2VydC5tYXRjaChib2RpZWQuYm9keSwgL1wicXVvdGVkXCIgXFwkXFwodGhpbmdcXCkgXFx8IHBpcGVcXC4vLCAnc2hlbGwgbWV0YWNoYXJhY3RlcnMgbXVzdCBzdXJ2aXZlIHZlcmJhdGltJyk7XG59KTtcblxudGVzdCgncmVwb3J0cyB3aGVuIG1vcmUgY29tbWl0cyBhcmUgYXZhaWxhYmxlIHRoYW4gd2VyZSByZXF1ZXN0ZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHJlYWRlciA9IG5ldyBHaXRMb2dSZWFkZXIoZ2l0LCByZXBvKTtcblx0Y29uc3QgeyBjb21taXRzLCBtb3JlQXZhaWxhYmxlIH0gPSBhd2FpdCByZWFkZXIucmVhZCh7XG5cdFx0ZmlsdGVyOiB7XG5cdFx0XHRwYXRoczogW10sIGF1dGhvcnM6IFtdLCBicmFuY2hlczogW10sIGV4Y2x1ZGVHbG9iczogW10sXG5cdFx0XHRzaG93UmVtb3RlQnJhbmNoZXM6IHRydWUsIHNob3dUYWdzOiB0cnVlLCBncmVwOiBudWxsLCBzaW5jZTogbnVsbCwgdW50aWw6IG51bGwsIGV4dHJhQXJnczogW11cblx0XHR9LFxuXHRcdG1heENvbW1pdHM6IDIsIG9yZGVyaW5nOiAnZGF0ZScsIG9ubHlGb2xsb3dGaXJzdFBhcmVudDogZmFsc2UsXG5cdFx0aW5jbHVkZUNvbW1pdHNNZW50aW9uZWRCeVJlZmxvZ3M6IGZhbHNlLCBmb2xsb3dSZW5hbWVzOiBmYWxzZSwgaW5jbHVkZVN0YXNoZXM6IGZhbHNlXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChjb21taXRzLmxlbmd0aCwgMiwgJ2V4YWN0bHkgdGhlIHJlcXVlc3RlZCBudW1iZXIgaXMgcmV0dXJuZWQnKTtcblx0YXNzZXJ0LmVxdWFsKG1vcmVBdmFpbGFibGUsIHRydWUpO1xufSk7XG5cbnRlc3QoJ2ZpbHRlcnMgaGlzdG9yeSB0byBhIHNpbmdsZSBwYXRoJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCByZWFkZXIgPSBuZXcgR2l0TG9nUmVhZGVyKGdpdCwgcmVwbyk7XG5cdGNvbnN0IHsgY29tbWl0cyB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoe1xuXHRcdGZpbHRlcjoge1xuXHRcdFx0cGF0aHM6IFsnYy50eHQnXSwgYXV0aG9yczogW10sIGJyYW5jaGVzOiBbXSwgZXhjbHVkZUdsb2JzOiBbXSxcblx0XHRcdHNob3dSZW1vdGVCcmFuY2hlczogdHJ1ZSwgc2hvd1RhZ3M6IHRydWUsIGdyZXA6IG51bGwsIHNpbmNlOiBudWxsLCB1bnRpbDogbnVsbCwgZXh0cmFBcmdzOiBbXVxuXHRcdH0sXG5cdFx0bWF4Q29tbWl0czogMTAwLCBvcmRlcmluZzogJ2RhdGUnLCBvbmx5Rm9sbG93Rmlyc3RQYXJlbnQ6IGZhbHNlLFxuXHRcdGluY2x1ZGVDb21taXRzTWVudGlvbmVkQnlSZWZsb2dzOiBmYWxzZSwgZm9sbG93UmVuYW1lczogZmFsc2UsIGluY2x1ZGVTdGFzaGVzOiBmYWxzZVxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwoY29tbWl0cy5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwoY29tbWl0c1swXS5zdWJqZWN0LCAnd29yayBvbiB0aGUgZmVhdHVyZScpO1xufSk7XG5cbnRlc3QoJ2ZpbHRlcnMgaGlzdG9yeSBieSBhdXRob3InLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHJlYWRlciA9IG5ldyBHaXRMb2dSZWFkZXIoZ2l0LCByZXBvKTtcblx0Y29uc3QgeyBjb21taXRzIH0gPSBhd2FpdCByZWFkZXIucmVhZCh7XG5cdFx0ZmlsdGVyOiB7XG5cdFx0XHRwYXRoczogW10sIGF1dGhvcnM6IFsnbm9ib2R5QGV4YW1wbGUuY29tJ10sIGJyYW5jaGVzOiBbXSwgZXhjbHVkZUdsb2JzOiBbXSxcblx0XHRcdHNob3dSZW1vdGVCcmFuY2hlczogdHJ1ZSwgc2hvd1RhZ3M6IHRydWUsIGdyZXA6IG51bGwsIHNpbmNlOiBudWxsLCB1bnRpbDogbnVsbCwgZXh0cmFBcmdzOiBbXVxuXHRcdH0sXG5cdFx0bWF4Q29tbWl0czogMTAwLCBvcmRlcmluZzogJ2RhdGUnLCBvbmx5Rm9sbG93Rmlyc3RQYXJlbnQ6IGZhbHNlLFxuXHRcdGluY2x1ZGVDb21taXRzTWVudGlvbmVkQnlSZWZsb2dzOiBmYWxzZSwgZm9sbG93UmVuYW1lczogZmFsc2UsIGluY2x1ZGVTdGFzaGVzOiBmYWxzZVxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwoY29tbWl0cy5sZW5ndGgsIDAsICdhbiBhdXRob3Igd2l0aCBubyBjb21taXRzIHlpZWxkcyBub3RoaW5nLCBub3QgZXZlcnl0aGluZycpO1xufSk7XG5cbnRlc3QoJ3Jlc29sdmVzIHJldmlzaW9ucyBhbmQgcmVqZWN0cyBvbmVzIHRoYXQgZG8gbm90IGV4aXN0JywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCByZWFkZXIgPSBuZXcgR2l0TG9nUmVhZGVyKGdpdCwgcmVwbyk7XG5cdGFzc2VydC5tYXRjaCgoYXdhaXQgcmVhZGVyLnJlc29sdmUoJ21haW4nKSkgPz8gJycsIC9eWzAtOWEtZl17NDB9JC8pO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgcmVhZGVyLnJlc29sdmUoJ25vLXN1Y2gtYnJhbmNoJyksIG51bGwpO1xufSk7XG5cbnRlc3QoJ2F0dGFjaGVzIGFubm90YXRlZCB0YWdzIHRvIHRoZSBjb21taXQsIG5vdCB0aGUgdGFnIG9iamVjdCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgcmVmUmVhZGVyID0gbmV3IEdpdFJlZlJlYWRlcihnaXQsIHJlcG8pO1xuXHRjb25zdCByZW1vdGVzID0gYXdhaXQgcmVmUmVhZGVyLnJlbW90ZXMoKTtcblx0Y29uc3QgcmVmcyA9IGF3YWl0IHJlZlJlYWRlci5yZWFkUmVmcyhyZW1vdGVzKTtcblxuXHRjb25zdCBhbm5vdGF0ZWQgPSByZWZzLnRhZ3MuZmluZCgodCkgPT4gdC5uYW1lID09PSAndjEuMCcpO1xuXHRjb25zdCBsaWdodHdlaWdodCA9IHJlZnMudGFncy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09ICdsaWdodHdlaWdodCcpO1xuXHRhc3NlcnQub2soYW5ub3RhdGVkICE9PSB1bmRlZmluZWQgJiYgbGlnaHR3ZWlnaHQgIT09IHVuZGVmaW5lZCk7XG5cdGFzc2VydC5lcXVhbChhbm5vdGF0ZWQuYW5ub3RhdGVkLCB0cnVlKTtcblx0YXNzZXJ0LmVxdWFsKGxpZ2h0d2VpZ2h0LmFubm90YXRlZCwgZmFsc2UpO1xuXG5cdGNvbnN0IGhlYWQgPSAoYXdhaXQgbmV3IEdpdExvZ1JlYWRlcihnaXQsIHJlcG8pLnJlc29sdmUoJ0hFQUQnKSkhO1xuXHRhc3NlcnQuZXF1YWwoYW5ub3RhdGVkLmhhc2gsIGhlYWQsICd0aGUgYW5ub3RhdGVkIHRhZyBtdXN0IGRlcmVmZXJlbmNlIHRvIGl0cyBjb21taXQnKTtcblx0YXNzZXJ0LmVxdWFsKGxpZ2h0d2VpZ2h0Lmhhc2gsIGhlYWQpO1xufSk7XG5cbnRlc3QoJ3JlYWRzIGxvY2FsIGJyYW5jaGVzIGFuZCB0aGVpciB0cmFja2luZyBzdGF0ZScsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgcmVmUmVhZGVyID0gbmV3IEdpdFJlZlJlYWRlcihnaXQsIHJlcG8pO1xuXHRjb25zdCByZWZzID0gYXdhaXQgcmVmUmVhZGVyLnJlYWRSZWZzKGF3YWl0IHJlZlJlYWRlci5yZW1vdGVzKCkpO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwocmVmcy5oZWFkcy5tYXAoKGgpID0+IGgubmFtZSkuc29ydCgpLCBbJ2ZlYXR1cmUnLCAnbWFpbiddKTtcblx0Zm9yIChjb25zdCBoZWFkIG9mIHJlZnMuaGVhZHMpIHtcblx0XHRhc3NlcnQuZXF1YWwoaGVhZC51cHN0cmVhbSwgbnVsbCwgJ3RoaXMgZml4dHVyZSBoYXMgbm8gcmVtb3RlcyBjb25maWd1cmVkJyk7XG5cdFx0YXNzZXJ0LmVxdWFsKGhlYWQuYWhlYWQsIG51bGwpO1xuXHR9XG59KTtcblxudGVzdCgncmVhZHMgdGhlIGNoZWNrZWQgb3V0IGJyYW5jaCBhbmQgZGV0YWNoZWQgSEVBRCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgcmVmUmVhZGVyID0gbmV3IEdpdFJlZlJlYWRlcihnaXQsIHJlcG8pO1xuXHRjb25zdCBvbkJyYW5jaCA9IGF3YWl0IHJlZlJlYWRlci5yZWFkU3RhdGUoKTtcblx0YXNzZXJ0LmVxdWFsKG9uQnJhbmNoLmhlYWQsICdtYWluJyk7XG5cdGFzc2VydC5lcXVhbChvbkJyYW5jaC5pc0RldGFjaGVkLCBmYWxzZSk7XG5cdGFzc2VydC5lcXVhbChvbkJyYW5jaC5wZW5kaW5nT3BlcmF0aW9uLCBudWxsKTtcblxuXHRmaXh0dXJlKHJlcG8sICdjaGVja291dCcsICctcScsICctLWRldGFjaCcsICdIRUFEJyk7XG5cdGNvbnN0IGRldGFjaGVkID0gYXdhaXQgcmVmUmVhZGVyLnJlYWRTdGF0ZSgpO1xuXHRhc3NlcnQuZXF1YWwoZGV0YWNoZWQuaGVhZCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChkZXRhY2hlZC5pc0RldGFjaGVkLCB0cnVlKTtcblx0YXNzZXJ0Lm1hdGNoKGRldGFjaGVkLmhlYWRIYXNoID8/ICcnLCAvXlswLTlhLWZdezQwfSQvKTtcblxuXHRmaXh0dXJlKHJlcG8sICdjaGVja291dCcsICctcScsICdtYWluJyk7XG59KTtcblxudGVzdCgncmVhZHMgc3Rhc2ggZW50cmllcyB3aXRoIHRoZSBjb21taXQgdGhleSB3ZXJlIHRha2VuIGFnYWluc3QnLCBhc3luYyAoKSA9PiB7XG5cdHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCAnYS50eHQnKSwgJ2RpcnR5XFxuJyk7XG5cdGZpeHR1cmUocmVwbywgJ3N0YXNoJywgJ3B1c2gnLCAnLW0nLCAnd29yayBpbiBwcm9ncmVzcycpO1xuXG5cdGNvbnN0IHN0YXNoZXMgPSBhd2FpdCBuZXcgR2l0UmVmUmVhZGVyKGdpdCwgcmVwbykucmVhZFN0YXNoZXMoKTtcblx0YXNzZXJ0LmVxdWFsKHN0YXNoZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHN0YXNoZXNbMF0uaW5kZXgsIDApO1xuXHRhc3NlcnQuZXF1YWwoc3Rhc2hlc1swXS5zZWxlY3RvciwgJ3N0YXNoQHswfScpO1xuXHRhc3NlcnQubWF0Y2goc3Rhc2hlc1swXS5tZXNzYWdlLCAvd29yayBpbiBwcm9ncmVzcy8pO1xuXHRhc3NlcnQubWF0Y2goc3Rhc2hlc1swXS5oYXNoLCAvXlswLTlhLWZdezQwfSQvKTtcblx0YXNzZXJ0Lm1hdGNoKHN0YXNoZXNbMF0uYmFzZUhhc2gsIC9eWzAtOWEtZl17NDB9JC8pO1xuXG5cdGZpeHR1cmUocmVwbywgJ3N0YXNoJywgJ2Ryb3AnKTtcbn0pO1xuXG50ZXN0KCdkZXRlY3RzIGFuIGludGVycnVwdGVkIG1lcmdlIHNvIHRoZSB2aWV3IGNhbiBvZmZlciB0byBhYm9ydCBpdCcsIGFzeW5jICgpID0+IHtcblx0Ly8gQnVpbGQgYSBnZW51aW5lIGNvbmZsaWN0OiBib3RoIGJyYW5jaGVzIGNoYW5nZSB0aGUgc2FtZSBsaW5lLlxuXHRjb25zdCBjb25mbGljdCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnZ24tY29uZmxpY3QtJykpO1xuXHRmaXh0dXJlKGNvbmZsaWN0LCAnaW5pdCcsICctcScsICctYicsICdtYWluJyk7XG5cdGZpeHR1cmUoY29uZmxpY3QsICdjb25maWcnLCAndXNlci5lbWFpbCcsICd0ZXN0QGV4YW1wbGUuY29tJyk7XG5cdGZpeHR1cmUoY29uZmxpY3QsICdjb25maWcnLCAndXNlci5uYW1lJywgJ1Rlc3QnKTtcblx0Y29tbWl0RmlsZShjb25mbGljdCwgJ2YudHh0JywgJ2Jhc2VcXG4nLCAnYmFzZScpO1xuXHRmaXh0dXJlKGNvbmZsaWN0LCAnY2hlY2tvdXQnLCAnLXEnLCAnLWInLCAnb3RoZXInKTtcblx0Y29tbWl0RmlsZShjb25mbGljdCwgJ2YudHh0JywgJ290aGVyXFxuJywgJ290aGVyIHNpZGUnKTtcblx0Zml4dHVyZShjb25mbGljdCwgJ2NoZWNrb3V0JywgJy1xJywgJ21haW4nKTtcblx0Y29tbWl0RmlsZShjb25mbGljdCwgJ2YudHh0JywgJ21haW5cXG4nLCAnbWFpbiBzaWRlJyk7XG5cdHRyeSB7XG5cdFx0Zml4dHVyZShjb25mbGljdCwgJy1jJywgJ2NvbW1pdC5ncGdzaWduPWZhbHNlJywgJ21lcmdlJywgJ290aGVyJyk7XG5cdH0gY2F0Y2gge1xuXHRcdC8qIHRoZSBtZXJnZSBpcyBleHBlY3RlZCB0byBmYWlsIHdpdGggYSBjb25mbGljdCAqL1xuXHR9XG5cblx0Y29uc3Qgc3RhdGUgPSBhd2FpdCBuZXcgR2l0UmVmUmVhZGVyKGdpdCwgY29uZmxpY3QpLnJlYWRTdGF0ZSgpO1xuXHRhc3NlcnQuZXF1YWwoc3RhdGUucGVuZGluZ09wZXJhdGlvbiwgUGVuZGluZ09wZXJhdGlvbi5NZXJnZSk7XG5cblx0cm1TeW5jKGNvbmZsaWN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcbiIsICJpbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3NXaXRob3V0TnVsbFN0cmVhbXMgfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcblxuLyoqXG4gKiBUaGUgc2xpY2Ugb2YgYHZzY29kZS5DYW5jZWxsYXRpb25Ub2tlbmAgdGhpcyBtb2R1bGUgbmVlZHMuXG4gKlxuICogRGVjbGFyaW5nIGl0IHN0cnVjdHVyYWxseSBrZWVwcyB0aGUgZ2l0IGxheWVyIGZyZWUgb2YgYSBgdnNjb2RlYCBpbXBvcnQsIHNvXG4gKiBpdCBjYW4gYmUgZXhlcmNpc2VkIGJ5IHRlc3RzIHRoYXQgcnVuIGluIHBsYWluIE5vZGUgXHUyMDE0IHRoZSBsYXllciB3aGVyZSBmb3JtYXRcbiAqIGRyaWZ0IGJldHdlZW4gZ2l0IHZlcnNpb25zIGFjdHVhbGx5IGJpdGVzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIENhbmNlbGxhdGlvbkxpa2Uge1xuXHRyZWFkb25seSBpc0NhbmNlbGxhdGlvblJlcXVlc3RlZDogYm9vbGVhbjtcblx0b25DYW5jZWxsYXRpb25SZXF1ZXN0ZWQobGlzdGVuZXI6ICgpID0+IHZvaWQpOiB7IGRpc3Bvc2UoKTogdm9pZCB9O1xufVxuXG4vKiogUmFpc2VkIHdoZW4gYSBjb21tYW5kIGlzIGFiYW5kb25lZCBiZWNhdXNlIGl0cyB0b2tlbiB3YXMgY2FuY2VsbGVkLiAqL1xuZXhwb3J0IGNsYXNzIENhbmNlbGxlZEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuXHRjb25zdHJ1Y3RvcigpIHtcblx0XHRzdXBlcignVGhlIGdpdCBjb21tYW5kIHdhcyBjYW5jZWxsZWQnKTtcblx0XHR0aGlzLm5hbWUgPSAnQ2FuY2VsbGVkRXJyb3InO1xuXHR9XG59XG5cbi8qKiBUaHJvd24gd2hlbiBnaXQgZXhpdHMgbm9uLXplcm8sIGNhcnJ5aW5nIGVub3VnaCBjb250ZXh0IHRvIHNob3cgdGhlIHVzZXIuICovXG5leHBvcnQgY2xhc3MgR2l0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG5cdGNvbnN0cnVjdG9yKFxuXHRcdG1lc3NhZ2U6IHN0cmluZyxcblx0XHRyZWFkb25seSBleGl0Q29kZTogbnVtYmVyIHwgbnVsbCxcblx0XHRyZWFkb25seSBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcblx0XHRyZWFkb25seSBzdGRlcnI6IHN0cmluZ1xuXHQpIHtcblx0XHRzdXBlcihtZXNzYWdlKTtcblx0XHR0aGlzLm5hbWUgPSAnR2l0RXJyb3InO1xuXHR9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgR2l0VmVyc2lvbiB7XG5cdHJlYWRvbmx5IG1ham9yOiBudW1iZXI7XG5cdHJlYWRvbmx5IG1pbm9yOiBudW1iZXI7XG5cdHJlYWRvbmx5IHBhdGNoOiBudW1iZXI7XG5cdHJlYWRvbmx5IHJhdzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJ1bk9wdGlvbnMge1xuXHQvKiogRXh0cmEgZW52aXJvbm1lbnQgZW50cmllcyBtZXJnZWQgb3ZlciB0aGUgYmFzZSBlbnZpcm9ubWVudC4gKi9cblx0cmVhZG9ubHkgZW52PzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG5cdC8qKiBUZXh0IHdyaXR0ZW4gdG8gZ2l0J3Mgc3RkaW4sIHRoZW4gY2xvc2VkLiAqL1xuXHRyZWFkb25seSBzdGRpbj86IHN0cmluZztcblx0LyoqIFJlc29sdmUgd2l0aCB0aGUgb3V0cHV0IGV2ZW4gd2hlbiBnaXQgZXhpdHMgbm9uLXplcm8uICovXG5cdHJlYWRvbmx5IGlnbm9yZUV4aXRDb2RlPzogYm9vbGVhbjtcblx0cmVhZG9ubHkgdG9rZW4/OiBDYW5jZWxsYXRpb25MaWtlO1xufVxuXG4vKipcbiAqIENvbXBhcmVzIHR3byBnaXQgdmVyc2lvbnMuIFJldHVybnMgYSBuZWdhdGl2ZSBudW1iZXIgd2hlbiBgYWAgaXMgb2xkZXIuXG4gKiBVc2VkIHRvIGdhdGUgYXJndW1lbnRzIHRoYXQgb2xkZXIgZ2l0IGJpbmFyaWVzIHJlamVjdCBvdXRyaWdodC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbXBhcmVWZXJzaW9ucyhhOiBHaXRWZXJzaW9uLCBiOiB7IG1ham9yOiBudW1iZXI7IG1pbm9yOiBudW1iZXI7IHBhdGNoPzogbnVtYmVyIH0pOiBudW1iZXIge1xuXHRyZXR1cm4gYS5tYWpvciAtIGIubWFqb3IgfHwgYS5taW5vciAtIGIubWlub3IgfHwgYS5wYXRjaCAtIChiLnBhdGNoID8/IDApO1xufVxuXG5mdW5jdGlvbiBwYXJzZVZlcnNpb24ocmF3OiBzdHJpbmcpOiBHaXRWZXJzaW9uIHwgbnVsbCB7XG5cdC8vIGBnaXQgdmVyc2lvbiAyLjQzLjBgLCBgZ2l0IHZlcnNpb24gMi4zOS4zIChBcHBsZSBHaXQtMTQ1KWAsXG5cdC8vIGBnaXQgdmVyc2lvbiAyLjQ1LjEud2luZG93cy4xYCBcdTIwMTQgdGFrZSB0aGUgZmlyc3QgdGhyZWUgbnVtZXJpYyBmaWVsZHMuXG5cdGNvbnN0IG1hdGNoID0gLyhcXGQrKVxcLihcXGQrKSg/OlxcLihcXGQrKSk/Ly5leGVjKHJhdyk7XG5cdGlmIChtYXRjaCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG5cdHJldHVybiB7XG5cdFx0bWFqb3I6IHBhcnNlSW50KG1hdGNoWzFdLCAxMCksXG5cdFx0bWlub3I6IHBhcnNlSW50KG1hdGNoWzJdLCAxMCksXG5cdFx0cGF0Y2g6IG1hdGNoWzNdICE9PSB1bmRlZmluZWQgPyBwYXJzZUludChtYXRjaFszXSwgMTApIDogMCxcblx0XHRyYXc6IHJhdy50cmltKClcblx0fTtcbn1cblxuLyoqXG4gKiBSdW5zIGdpdCBjb21tYW5kcyBmb3IgYSBzaW5nbGUgcmVwb3NpdG9yeS5cbiAqXG4gKiBPdXRwdXQgaXMgc3RyZWFtZWQgYW5kIGNvbmNhdGVuYXRlZCByYXRoZXIgdGhhbiBjb2xsZWN0ZWQgYnkgYGV4ZWNgLCBzbyBhXG4gKiBgZ2l0IGxvZ2Agb3ZlciBhIHJlcG9zaXRvcnkgd2l0aCBodW5kcmVkcyBvZiB0aG91c2FuZHMgb2YgY29tbWl0cyBjYW5ub3RcbiAqIG92ZXJmbG93IGEgZml4ZWQgYnVmZmVyIGFuZCB0cnVuY2F0ZSB0aGUgZ3JhcGguXG4gKi9cbmV4cG9ydCBjbGFzcyBHaXRFeGVjdXRvciB7XG5cdHByaXZhdGUgY29uc3RydWN0b3IoXG5cdFx0cmVhZG9ubHkgYmluYXJ5OiBzdHJpbmcsXG5cdFx0cmVhZG9ubHkgdmVyc2lvbjogR2l0VmVyc2lvblxuXHQpIHt9XG5cblx0LyoqXG5cdCAqIFJlc29sdmVzIHRoZSBnaXQgYmluYXJ5IHRvIHVzZSwgdHJ5aW5nIGVhY2ggY2FuZGlkYXRlIHBhdGggaW4gdHVybi5cblx0ICogUmVqZWN0cyB3aXRoIGEgdXNlci1mYWNpbmcgbWVzc2FnZSB3aGVuIG5vbmUgb2YgdGhlbSBydW4uXG5cdCAqL1xuXHRzdGF0aWMgYXN5bmMgbG9jYXRlKGNhbmRpZGF0ZXM6IHJlYWRvbmx5IHN0cmluZ1tdKTogUHJvbWlzZTxHaXRFeGVjdXRvcj4ge1xuXHRcdGNvbnN0IGZhaWx1cmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IG91dHB1dCA9IGF3YWl0IHJ1blJhdyhjYW5kaWRhdGUsIFsnLS12ZXJzaW9uJ10sIHByb2Nlc3MuY3dkKCksIHt9KTtcblx0XHRcdFx0Y29uc3QgdmVyc2lvbiA9IHBhcnNlVmVyc2lvbihvdXRwdXQuc3Rkb3V0KTtcblx0XHRcdFx0aWYgKHZlcnNpb24gPT09IG51bGwpIHtcblx0XHRcdFx0XHRmYWlsdXJlcy5wdXNoKGAke2NhbmRpZGF0ZX06IHVucmVjb2duaXNlZCB2ZXJzaW9uIHN0cmluZyBcIiR7b3V0cHV0LnN0ZG91dC50cmltKCl9XCJgKTtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoY29tcGFyZVZlcnNpb25zKHZlcnNpb24sIHsgbWFqb3I6IDIsIG1pbm9yOiA0IH0pIDwgMCkge1xuXHRcdFx0XHRcdGZhaWx1cmVzLnB1c2goYCR7Y2FuZGlkYXRlfTogZ2l0ICR7dmVyc2lvbi5yYXd9IGlzIHRvbyBvbGQsIDIuNC4wIG9yIGxhdGVyIGlzIHJlcXVpcmVkYCk7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIG5ldyBHaXRFeGVjdXRvcihjYW5kaWRhdGUsIHZlcnNpb24pO1xuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0ZmFpbHVyZXMucHVzaChgJHtjYW5kaWRhdGV9OiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0dGhyb3cgbmV3IEVycm9yKFxuXHRcdFx0J0dpdCBHcmFwaCBOZXh0IGNvdWxkIG5vdCBmaW5kIGEgdXNhYmxlIGdpdCBleGVjdXRhYmxlLiBTZXQgXCJnaXQtZ3JhcGgtbmV4dC5naXQucGF0aFwiIHRvIGl0cyBsb2NhdGlvbi5cXG4nICtcblx0XHRcdFx0ZmFpbHVyZXMubWFwKChmKSA9PiBgICBcdTIwMjIgJHtmfWApLmpvaW4oJ1xcbicpXG5cdFx0KTtcblx0fVxuXG5cdC8qKiBUcnVlIHdoZW4gdGhlIGJpbmFyeSBpcyBhdCBsZWFzdCB0aGUgZ2l2ZW4gdmVyc2lvbi4gKi9cblx0YXRMZWFzdChtYWpvcjogbnVtYmVyLCBtaW5vcjogbnVtYmVyLCBwYXRjaCA9IDApOiBib29sZWFuIHtcblx0XHRyZXR1cm4gY29tcGFyZVZlcnNpb25zKHRoaXMudmVyc2lvbiwgeyBtYWpvciwgbWlub3IsIHBhdGNoIH0pID49IDA7XG5cdH1cblxuXHQvKiogUnVucyBnaXQgaW4gYGN3ZGAgYW5kIHJlc29sdmVzIHdpdGggc3Rkb3V0IGFzIFVURi04IHRleHQuICovXG5cdGFzeW5jIHJ1bihjd2Q6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIG9wdGlvbnM6IFJ1bk9wdGlvbnMgPSB7fSk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUmF3KHRoaXMuYmluYXJ5LCBhcmdzLCBjd2QsIG9wdGlvbnMpO1xuXHRcdGlmIChyZXN1bHQuY29kZSAhPT0gMCAmJiBvcHRpb25zLmlnbm9yZUV4aXRDb2RlICE9PSB0cnVlKSB7XG5cdFx0XHR0aHJvdyBuZXcgR2l0RXJyb3IoY2xlYW5TdGRlcnIocmVzdWx0LnN0ZGVycikgfHwgYGdpdCBleGl0ZWQgd2l0aCBjb2RlICR7cmVzdWx0LmNvZGV9YCwgcmVzdWx0LmNvZGUsIGFyZ3MsIHJlc3VsdC5zdGRlcnIpO1xuXHRcdH1cblx0XHRyZXR1cm4gcmVzdWx0LnN0ZG91dDtcblx0fVxuXG5cdC8qKlxuXHQgKiBSdW5zIGdpdCBhbmQgcmVzb2x2ZXMgd2l0aCByYXcgc3Rkb3V0IGJ5dGVzLCBmb3IgY29udGVudCB0aGF0IGlzIG5vdFxuXHQgKiBuZWNlc3NhcmlseSB2YWxpZCBVVEYtOCAoYGdpdCBzaG93YCBvZiBhIGJpbmFyeSBibG9iLCBmb3IgZXhhbXBsZSkuXG5cdCAqL1xuXHRhc3luYyBydW5CaW5hcnkoY3dkOiBzdHJpbmcsIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLCBvcHRpb25zOiBSdW5PcHRpb25zID0ge30pOiBQcm9taXNlPEJ1ZmZlcj4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blJhdyh0aGlzLmJpbmFyeSwgYXJncywgY3dkLCB7IC4uLm9wdGlvbnMsIGJpbmFyeTogdHJ1ZSB9KTtcblx0XHRpZiAocmVzdWx0LmNvZGUgIT09IDAgJiYgb3B0aW9ucy5pZ25vcmVFeGl0Q29kZSAhPT0gdHJ1ZSkge1xuXHRcdFx0dGhyb3cgbmV3IEdpdEVycm9yKGNsZWFuU3RkZXJyKHJlc3VsdC5zdGRlcnIpIHx8IGBnaXQgZXhpdGVkIHdpdGggY29kZSAke3Jlc3VsdC5jb2RlfWAsIHJlc3VsdC5jb2RlLCBhcmdzLCByZXN1bHQuc3RkZXJyKTtcblx0XHR9XG5cdFx0cmV0dXJuIHJlc3VsdC5zdGRvdXRCdWZmZXI7XG5cdH1cblxuXHQvKiogUnVucyBnaXQgYW5kIHJlc29sdmVzIHRvIG51bGwgaW5zdGVhZCBvZiB0aHJvd2luZyB3aGVuIGl0IGZhaWxzLiAqL1xuXHRhc3luYyBydW5Pck51bGwoY3dkOiBzdHJpbmcsIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLCBvcHRpb25zOiBSdW5PcHRpb25zID0ge30pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIGF3YWl0IHRoaXMucnVuKGN3ZCwgYXJncywgb3B0aW9ucyk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cdH1cbn1cblxuLyoqIFN0cmlwcyB0aGUgbm9pc2UgZ2l0IHByZWZpeGVzIG9udG8gbW9zdCBlcnJvcnMsIGxlYXZpbmcgdGhlIHVzZWZ1bCBzZW50ZW5jZS4gKi9cbmZ1bmN0aW9uIGNsZWFuU3RkZXJyKHN0ZGVycjogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHN0ZGVyclxuXHRcdC5zcGxpdCgnXFxuJylcblx0XHQubWFwKChsaW5lKSA9PiBsaW5lLnJlcGxhY2UoL14oPzplcnJvcnxmYXRhbCk6XFxzKi9pLCAnJykudHJpbSgpKVxuXHRcdC5maWx0ZXIoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMClcblx0XHQuam9pbignXFxuJylcblx0XHQudHJpbSgpO1xufVxuXG5pbnRlcmZhY2UgUmF3UmVzdWx0IHtcblx0cmVhZG9ubHkgY29kZTogbnVtYmVyIHwgbnVsbDtcblx0cmVhZG9ubHkgc3Rkb3V0OiBzdHJpbmc7XG5cdHJlYWRvbmx5IHN0ZG91dEJ1ZmZlcjogQnVmZmVyO1xuXHRyZWFkb25seSBzdGRlcnI6IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcnVuUmF3KFxuXHRiaW5hcnk6IHN0cmluZyxcblx0YXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG5cdGN3ZDogc3RyaW5nLFxuXHRvcHRpb25zOiBSdW5PcHRpb25zICYgeyBiaW5hcnk/OiBib29sZWFuIH1cbik6IFByb21pc2U8UmF3UmVzdWx0PiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZTxSYXdSZXN1bHQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRsZXQgY2hpbGQ6IENoaWxkUHJvY2Vzc1dpdGhvdXROdWxsU3RyZWFtcztcblx0XHR0cnkge1xuXHRcdFx0Y2hpbGQgPSBzcGF3bihiaW5hcnksIGFyZ3MgYXMgc3RyaW5nW10sIHtcblx0XHRcdFx0Y3dkLFxuXHRcdFx0XHRlbnY6IGJ1aWxkRW52aXJvbm1lbnQob3B0aW9ucy5lbnYpLFxuXHRcdFx0XHR3aW5kb3dzSGlkZTogdHJ1ZVxuXHRcdFx0fSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdHJlamVjdChuZXcgRXJyb3IoYGZhaWxlZCB0byBzcGF3biBcIiR7YmluYXJ5fVwiOiAke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX1gKSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc3Rkb3V0Q2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuXHRcdGNvbnN0IHN0ZGVyckNodW5rczogQnVmZmVyW10gPSBbXTtcblx0XHRsZXQgc2V0dGxlZCA9IGZhbHNlO1xuXG5cdFx0Y29uc3QgZmluaXNoID0gKGZuOiAoKSA9PiB2b2lkKSA9PiB7XG5cdFx0XHRpZiAoc2V0dGxlZCkgcmV0dXJuO1xuXHRcdFx0c2V0dGxlZCA9IHRydWU7XG5cdFx0XHRjYW5jZWxsYXRpb24/LmRpc3Bvc2UoKTtcblx0XHRcdGZuKCk7XG5cdFx0fTtcblxuXHRcdGNvbnN0IGNhbmNlbGxhdGlvbiA9IG9wdGlvbnMudG9rZW4/Lm9uQ2FuY2VsbGF0aW9uUmVxdWVzdGVkKCgpID0+IHtcblx0XHRcdGNoaWxkLmtpbGwoJ1NJR1RFUk0nKTtcblx0XHRcdGZpbmlzaCgoKSA9PiByZWplY3QobmV3IENhbmNlbGxlZEVycm9yKCkpKTtcblx0XHR9KTtcblxuXHRcdGNoaWxkLnN0ZG91dC5vbignZGF0YScsIChjaHVuazogQnVmZmVyKSA9PiBzdGRvdXRDaHVua3MucHVzaChjaHVuaykpO1xuXHRcdGNoaWxkLnN0ZGVyci5vbignZGF0YScsIChjaHVuazogQnVmZmVyKSA9PiBzdGRlcnJDaHVua3MucHVzaChjaHVuaykpO1xuXG5cdFx0Y2hpbGQub24oJ2Vycm9yJywgKGVycm9yKSA9PiB7XG5cdFx0XHQvLyBFTk9FTlQgaGVyZSBtZWFucyB0aGUgYmluYXJ5IGRvZXMgbm90IGV4aXN0OyBzdXJmYWNlIGl0IHZlcmJhdGltIHNvXG5cdFx0XHQvLyBgbG9jYXRlYCBjYW4gcmVwb3J0IHdoaWNoIGNhbmRpZGF0ZSBmYWlsZWQgYW5kIHdoeS5cblx0XHRcdGZpbmlzaCgoKSA9PiByZWplY3QoZXJyb3IpKTtcblx0XHR9KTtcblxuXHRcdGNoaWxkLm9uKCdjbG9zZScsIChjb2RlKSA9PiB7XG5cdFx0XHRjb25zdCBzdGRvdXRCdWZmZXIgPSBCdWZmZXIuY29uY2F0KHN0ZG91dENodW5rcyk7XG5cdFx0XHRmaW5pc2goKCkgPT5cblx0XHRcdFx0cmVzb2x2ZSh7XG5cdFx0XHRcdFx0Y29kZSxcblx0XHRcdFx0XHRzdGRvdXQ6IG9wdGlvbnMuYmluYXJ5ID09PSB0cnVlID8gJycgOiBzdGRvdXRCdWZmZXIudG9TdHJpbmcoJ3V0ZjgnKSxcblx0XHRcdFx0XHRzdGRvdXRCdWZmZXIsXG5cdFx0XHRcdFx0c3RkZXJyOiBCdWZmZXIuY29uY2F0KHN0ZGVyckNodW5rcykudG9TdHJpbmcoJ3V0ZjgnKVxuXHRcdFx0XHR9KVxuXHRcdFx0KTtcblx0XHR9KTtcblxuXHRcdGlmIChvcHRpb25zLnN0ZGluICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdGNoaWxkLnN0ZGluLm9uKCdlcnJvcicsICgpID0+IHtcblx0XHRcdFx0LyogZ2l0IGNhbiBleGl0IGJlZm9yZSByZWFkaW5nIHN0ZGluOyBFUElQRSBoZXJlIGlzIG5vdCBhbiBlcnJvci4gKi9cblx0XHRcdH0pO1xuXHRcdFx0Y2hpbGQuc3RkaW4uZW5kKG9wdGlvbnMuc3RkaW4sICd1dGY4Jyk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNoaWxkLnN0ZGluLmVuZCgpO1xuXHRcdH1cblx0fSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkRW52aXJvbm1lbnQoZXh0cmE6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHwgdW5kZWZpbmVkKTogTm9kZUpTLlByb2Nlc3NFbnYge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnByb2Nlc3MuZW52LFxuXHRcdC4uLmV4dHJhLFxuXHRcdC8vIEtlZXAgZ2l0J3Mgb3duIG1lc3NhZ2VzIGFuZCBkYXRlIGZvcm1hdHRpbmcgcHJlZGljdGFibGUgZm9yIHBhcnNpbmcsXG5cdFx0Ly8gd2hpbGUgbGVhdmluZyB1c2VyIGNvbnRlbnQgKGNvbW1pdCBtZXNzYWdlcywgcGF0aHMpIHVudG91Y2hlZC5cblx0XHRMQ19BTEw6ICdDJyxcblx0XHRMQU5HOiAnQycsXG5cdFx0Ly8gUmVhZC1vbmx5IGNvbW1hbmRzIG11c3Qgbm90IHRha2UgaW5kZXgubG9jaywgb3RoZXJ3aXNlIHJlZnJlc2hpbmcgdGhlXG5cdFx0Ly8gZ3JhcGggZmlnaHRzIHdpdGggVlMgQ29kZSdzIGJ1aWx0LWluIEdpdCBleHRlbnNpb24gb3ZlciB0aGUgc2FtZSBmaWxlLlxuXHRcdEdJVF9PUFRJT05BTF9MT0NLUzogJzAnLFxuXHRcdC8vIE5ldmVyIGJsb2NrIG9uIGFuIGludGVyYWN0aXZlIGNyZWRlbnRpYWwgb3IgcGFzc3BocmFzZSBwcm9tcHQ6IGFcblx0XHQvLyBoaWRkZW4gcHJvbXB0IGxlYXZlcyB0aGUgZXh0ZW5zaW9uIGhhbmdpbmcgd2l0aCBubyB3YXkgdG8gYW5zd2VyIGl0LlxuXHRcdEdJVF9URVJNSU5BTF9QUk9NUFQ6ICcwJyxcblx0XHRHSVRfUEFHRVI6ICdjYXQnLFxuXHRcdFBBR0VSOiAnY2F0Jyxcblx0XHQvLyBBdm9pZCBhbiBlZGl0b3IgdGhhdCBuZXZlciByZXR1cm5zIGZvciBjb21tYW5kcyB0aGF0IG1heSBvcGVuIG9uZS5cblx0XHRHSVRfRURJVE9SOiAndHJ1ZSdcblx0fTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IEdpdEV4ZWN1dG9yIH0gZnJvbSAnLi9leGVjdXRvci50cyc7XG5pbXBvcnQgdHlwZSB7IENvbW1pdCwgSGFzaCwgTG9nRmlsdGVyIH0gZnJvbSAnLi4vdHlwZXMudHMnO1xuXG4vKipcbiAqIEZpZWxkcyByZXF1ZXN0ZWQgZnJvbSBgZ2l0IGxvZ2AsIGluIG9yZGVyLiBUaGV5IGFyZSBzZXBhcmF0ZWQgYnkgTlVMLCB3aGljaFxuICogZ2l0IGZvcmJpZHMgaW5zaWRlIGNvbW1pdCBtZXNzYWdlcywgYXV0aG9yIG5hbWVzIGFuZCBwYXRocyBhbGlrZSBcdTIwMTQgc28gdW5saWtlXG4gKiBhIHByaW50YWJsZSBkZWxpbWl0ZXIgaXQgY2Fubm90IGJlIGZvcmdlZCBieSByZXBvc2l0b3J5IGNvbnRlbnQuXG4gKi9cbmNvbnN0IExPR19GSUVMRFMgPSBbJyVIJywgJyVQJywgJyVhbicsICclYWUnLCAnJWF0JywgJyVjbicsICclY2UnLCAnJWN0JywgJyVzJywgJyViJ10gYXMgY29uc3Q7XG5jb25zdCBMT0dfRk9STUFUID0gYC0tZm9ybWF0PSR7TE9HX0ZJRUxEUy5qb2luKCcleDAwJyl9YDtcbmNvbnN0IEZJRUxEU19QRVJfQ09NTUlUID0gTE9HX0ZJRUxEUy5sZW5ndGg7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTG9nUmVxdWVzdCB7XG5cdHJlYWRvbmx5IGZpbHRlcjogTG9nRmlsdGVyO1xuXHQvKiogTWF4aW11bSBjb21taXRzIHRvIHJldHVybi4gKi9cblx0cmVhZG9ubHkgbWF4Q29tbWl0czogbnVtYmVyO1xuXHQvKiogQ29tbWl0IG9yZGVyaW5nLCBtYXBwZWQgb250byBnaXQncyAtLWRhdGUtb3JkZXIvLS10b3BvLW9yZGVyIGZsYWdzLiAqL1xuXHRyZWFkb25seSBvcmRlcmluZzogJ2RhdGUnIHwgJ2F1dGhvci1kYXRlJyB8ICd0b3BvbG9naWNhbCc7XG5cdHJlYWRvbmx5IG9ubHlGb2xsb3dGaXJzdFBhcmVudDogYm9vbGVhbjtcblx0cmVhZG9ubHkgaW5jbHVkZUNvbW1pdHNNZW50aW9uZWRCeVJlZmxvZ3M6IGJvb2xlYW47XG5cdC8qKiBGb2xsb3cgcmVuYW1lcy4gT25seSB2YWxpZCB3aGVuIHRoZSBmaWx0ZXIgbmFtZXMgZXhhY3RseSBvbmUgcGF0aC4gKi9cblx0cmVhZG9ubHkgZm9sbG93UmVuYW1lczogYm9vbGVhbjtcblx0LyoqIEluY2x1ZGUgY29tbWl0cyByZWFjaGFibGUgb25seSBmcm9tIHN0YXNoIGVudHJpZXMuICovXG5cdHJlYWRvbmx5IGluY2x1ZGVTdGFzaGVzOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIExvZ1Jlc3VsdCB7XG5cdHJlYWRvbmx5IGNvbW1pdHM6IHJlYWRvbmx5IENvbW1pdFtdO1xuXHQvKiogVHJ1ZSB3aGVuIGdpdCBoYWQgbW9yZSBjb21taXRzIHRvIGdpdmUgdGhhbiBgbWF4Q29tbWl0c2AuICovXG5cdHJlYWRvbmx5IG1vcmVBdmFpbGFibGU6IGJvb2xlYW47XG59XG5cbi8qKlxuICogQnVpbGRzIHRoZSBgZ2l0IGxvZ2AgYXJndW1lbnQgbGlzdCBmb3IgYSByZXF1ZXN0LlxuICpcbiAqIEV4cG9ydGVkIHNvIGl0IGNhbiBiZSB1bml0IHRlc3RlZCB3aXRob3V0IGEgcmVwb3NpdG9yeTogYXJndW1lbnQgY29uc3RydWN0aW9uXG4gKiBpcyB3aGVyZSBmaWx0ZXIgY29tYmluYXRpb25zIGdvIHdyb25nLCBhbmQgdGhvc2UgYnVncyBhcmUgaW52aXNpYmxlIGluIHRoZSBVSVxuICogdW50aWwgc29tZW9uZSdzIGhpc3Rvcnkgc2lsZW50bHkgb21pdHMgY29tbWl0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTG9nQXJncyhyZXF1ZXN0OiBMb2dSZXF1ZXN0LCBzdXBwb3J0c0V4Y2x1ZGU6IGJvb2xlYW4pOiBzdHJpbmdbXSB7XG5cdGNvbnN0IHsgZmlsdGVyIH0gPSByZXF1ZXN0O1xuXHRjb25zdCBhcmdzID0gWydsb2cnLCBMT0dfRk9STUFULCAnLXonXTtcblxuXHQvLyBBc2sgZm9yIG9uZSBtb3JlIGNvbW1pdCB0aGFuIG5lZWRlZCwgc28gdGhlIGNhbGxlciBjYW4gdGVsbCB3aGV0aGVyIG1vcmVcblx0Ly8gaGlzdG9yeSBleGlzdHMgd2l0aG91dCBydW5uaW5nIGEgc2Vjb25kIGNvdW50IGNvbW1hbmQuXG5cdGFyZ3MucHVzaChgLW4ke3JlcXVlc3QubWF4Q29tbWl0cyArIDF9YCk7XG5cblx0c3dpdGNoIChyZXF1ZXN0Lm9yZGVyaW5nKSB7XG5cdFx0Y2FzZSAnZGF0ZSc6XG5cdFx0XHRhcmdzLnB1c2goJy0tZGF0ZS1vcmRlcicpO1xuXHRcdFx0YnJlYWs7XG5cdFx0Y2FzZSAnYXV0aG9yLWRhdGUnOlxuXHRcdFx0YXJncy5wdXNoKCctLWF1dGhvci1kYXRlLW9yZGVyJyk7XG5cdFx0XHRicmVhaztcblx0XHRjYXNlICd0b3BvbG9naWNhbCc6XG5cdFx0XHRhcmdzLnB1c2goJy0tdG9wby1vcmRlcicpO1xuXHRcdFx0YnJlYWs7XG5cdH1cblxuXHRpZiAocmVxdWVzdC5vbmx5Rm9sbG93Rmlyc3RQYXJlbnQpIGFyZ3MucHVzaCgnLS1maXJzdC1wYXJlbnQnKTtcblxuXHQvLyAtLWV4Y2x1ZGUgb25seSBhZmZlY3RzIHRoZSByZWYgZ2xvYnMgdGhhdCBmb2xsb3cgaXQsIHNvIGl0IG11c3QgcHJlY2VkZVxuXHQvLyAtLWFsbCAvIC0tYnJhbmNoZXMgLyAtLXJlbW90ZXMgcmF0aGVyIHRoYW4gdHJhaWwgdGhlbS5cblx0aWYgKHN1cHBvcnRzRXhjbHVkZSkge1xuXHRcdGZvciAoY29uc3QgZ2xvYiBvZiBmaWx0ZXIuZXhjbHVkZUdsb2JzKSBhcmdzLnB1c2goYC0tZXhjbHVkZT0ke2dsb2J9YCk7XG5cdH1cblxuXHRpZiAoZmlsdGVyLmJyYW5jaGVzLmxlbmd0aCA+IDApIHtcblx0XHQvLyBBbiBleHBsaWNpdCBicmFuY2ggc2VsZWN0aW9uIHJlcGxhY2VzIHRoZSByZWYgZ2xvYnMgZW50aXJlbHkuXG5cdFx0YXJncy5wdXNoKC4uLmZpbHRlci5icmFuY2hlcyk7XG5cdH0gZWxzZSB7XG5cdFx0YXJncy5wdXNoKCctLWJyYW5jaGVzJyk7XG5cdFx0aWYgKGZpbHRlci5zaG93UmVtb3RlQnJhbmNoZXMpIGFyZ3MucHVzaCgnLS1yZW1vdGVzJyk7XG5cdFx0aWYgKGZpbHRlci5zaG93VGFncykgYXJncy5wdXNoKCctLXRhZ3MnKTtcblx0XHQvLyBIRUFEIGlzIG5vdCBjb3ZlcmVkIGJ5IC0tYnJhbmNoZXMgd2hlbiB0aGUgcmVwb3NpdG9yeSBpcyBkZXRhY2hlZC5cblx0XHRhcmdzLnB1c2goJ0hFQUQnKTtcblx0XHRpZiAocmVxdWVzdC5pbmNsdWRlQ29tbWl0c01lbnRpb25lZEJ5UmVmbG9ncykgYXJncy5wdXNoKCctLXJlZmxvZycpO1xuXHRcdGlmIChyZXF1ZXN0LmluY2x1ZGVTdGFzaGVzKSBhcmdzLnB1c2goJy0tZ2xvYj1yZWZzL3N0YXNoJyk7XG5cdH1cblxuXHRmb3IgKGNvbnN0IGF1dGhvciBvZiBmaWx0ZXIuYXV0aG9ycykgYXJncy5wdXNoKGAtLWF1dGhvcj0ke2F1dGhvcn1gKTtcblx0aWYgKGZpbHRlci5ncmVwICE9PSBudWxsICYmIGZpbHRlci5ncmVwICE9PSAnJykge1xuXHRcdGFyZ3MucHVzaChgLS1ncmVwPSR7ZmlsdGVyLmdyZXB9YCwgJy0tcmVnZXhwLWlnbm9yZS1jYXNlJyk7XG5cdH1cblx0aWYgKGZpbHRlci5zaW5jZSAhPT0gbnVsbCkgYXJncy5wdXNoKGAtLXNpbmNlPSR7ZmlsdGVyLnNpbmNlfWApO1xuXHRpZiAoZmlsdGVyLnVudGlsICE9PSBudWxsKSBhcmdzLnB1c2goYC0tdW50aWw9JHtmaWx0ZXIudW50aWx9YCk7XG5cblx0YXJncy5wdXNoKC4uLmZpbHRlci5leHRyYUFyZ3MpO1xuXG5cdGlmIChmaWx0ZXIucGF0aHMubGVuZ3RoID4gMCkge1xuXHRcdC8vIC0tZm9sbG93IHRyYWNrcyBhIGZpbGUgYWNyb3NzIHJlbmFtZXMgYnV0IGdpdCBvbmx5IGFjY2VwdHMgaXQgZm9yIGFcblx0XHQvLyBzaW5nbGUgcGF0aCwgc28gaXQgaXMgdGhlIGNhbGxlcidzIGpvYiB0byByZXF1ZXN0IGl0IGFwcHJvcHJpYXRlbHkuXG5cdFx0aWYgKHJlcXVlc3QuZm9sbG93UmVuYW1lcyAmJiBmaWx0ZXIucGF0aHMubGVuZ3RoID09PSAxKSBhcmdzLnB1c2goJy0tZm9sbG93Jyk7XG5cdFx0YXJncy5wdXNoKCctLScsIC4uLmZpbHRlci5wYXRocyk7XG5cdH1cblxuXHRyZXR1cm4gYXJncztcbn1cblxuLyoqXG4gKiBQYXJzZXMgdGhlIE5VTC1kZWxpbWl0ZWQgb3V0cHV0IG9mIGBnaXQgbG9nYCBpbnRvIGNvbW1pdHMuXG4gKlxuICogQSB0cmFpbGluZyBwYXJ0aWFsIHJlY29yZCBpcyBkaXNjYXJkZWQgcmF0aGVyIHRoYW4gcHJvZHVjaW5nIGEgY29tbWl0IHdpdGhcbiAqIGVtcHR5IGZpZWxkczogdHJ1bmNhdGVkIG91dHB1dCBtZWFucyB0aGUgcHJvY2VzcyB3YXMga2lsbGVkLCBhbmQgaGFsZiBhXG4gKiBjb21taXQgcmVuZGVyZWQgaW4gdGhlIGdyYXBoIGlzIHdvcnNlIHRoYW4gb25lIG1pc3Npbmcgcm93LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VMb2coc3Rkb3V0OiBzdHJpbmcpOiBDb21taXRbXSB7XG5cdGlmIChzdGRvdXQubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG5cblx0Y29uc3QgZmllbGRzID0gc3Rkb3V0LnNwbGl0KCdcXDAnKTtcblx0Ly8gYGdpdCBsb2cgLXpgIHRlcm1pbmF0ZXMgZWFjaCByZWNvcmQgd2l0aCBOVUwsIGxlYXZpbmcgYSBmaW5hbCBlbXB0eVxuXHQvLyBlbGVtZW50OyBhbmQgcmVjb3JkcyBhZnRlciB0aGUgZmlyc3QgYXJlIHByZWZpeGVkIHdpdGggdGhlIG5ld2xpbmUgZ2l0XG5cdC8vIHdyaXRlcyBiZXR3ZWVuIGVudHJpZXMuXG5cdGNvbnN0IGNvbW1pdHM6IENvbW1pdFtdID0gW107XG5cdGNvbnN0IHVzYWJsZVJlY29yZHMgPSBNYXRoLmZsb29yKGZpZWxkcy5sZW5ndGggLyBGSUVMRFNfUEVSX0NPTU1JVCk7XG5cblx0Zm9yIChsZXQgcmVjb3JkID0gMDsgcmVjb3JkIDwgdXNhYmxlUmVjb3JkczsgcmVjb3JkKyspIHtcblx0XHRjb25zdCBiYXNlID0gcmVjb3JkICogRklFTERTX1BFUl9DT01NSVQ7XG5cdFx0Y29uc3QgaGFzaCA9IGZpZWxkc1tiYXNlXS5yZXBsYWNlKC9eXFxuLywgJycpO1xuXHRcdGlmICghL15bMC05YS1mXXs0MH0kLy50ZXN0KGhhc2gpKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IHBhcmVudEZpZWxkID0gZmllbGRzW2Jhc2UgKyAxXTtcblx0XHRjb21taXRzLnB1c2goe1xuXHRcdFx0aGFzaCxcblx0XHRcdHBhcmVudHM6IHBhcmVudEZpZWxkLmxlbmd0aCA9PT0gMCA/IFtdIDogcGFyZW50RmllbGQuc3BsaXQoJyAnKSxcblx0XHRcdGF1dGhvcjogZmllbGRzW2Jhc2UgKyAyXSxcblx0XHRcdGF1dGhvckVtYWlsOiBmaWVsZHNbYmFzZSArIDNdLFxuXHRcdFx0YXV0aG9yRGF0ZTogcGFyc2VJbnQoZmllbGRzW2Jhc2UgKyA0XSwgMTApIHx8IDAsXG5cdFx0XHRjb21taXR0ZXI6IGZpZWxkc1tiYXNlICsgNV0sXG5cdFx0XHRjb21taXR0ZXJFbWFpbDogZmllbGRzW2Jhc2UgKyA2XSxcblx0XHRcdGNvbW1pdHRlckRhdGU6IHBhcnNlSW50KGZpZWxkc1tiYXNlICsgN10sIDEwKSB8fCAwLFxuXHRcdFx0c3ViamVjdDogZmllbGRzW2Jhc2UgKyA4XSxcblx0XHRcdGJvZHk6IGZpZWxkc1tiYXNlICsgOV0ucmVwbGFjZSgvXFxuKyQvLCAnJyksXG5cdFx0XHRzdGFzaDogbnVsbFxuXHRcdH0pO1xuXHR9XG5cblx0cmV0dXJuIGNvbW1pdHM7XG59XG5cbi8qKiBSZWFkcyBjb21taXRzIGZvciBhIHJlcG9zaXRvcnkuICovXG5leHBvcnQgY2xhc3MgR2l0TG9nUmVhZGVyIHtcblx0Y29uc3RydWN0b3IoXG5cdFx0cHJpdmF0ZSByZWFkb25seSBnaXQ6IEdpdEV4ZWN1dG9yLFxuXHRcdHByaXZhdGUgcmVhZG9ubHkgcmVwb1BhdGg6IHN0cmluZ1xuXHQpIHt9XG5cblx0YXN5bmMgcmVhZChyZXF1ZXN0OiBMb2dSZXF1ZXN0KTogUHJvbWlzZTxMb2dSZXN1bHQ+IHtcblx0XHRjb25zdCBhcmdzID0gYnVpbGRMb2dBcmdzKHJlcXVlc3QsIHRoaXMuZ2l0LmF0TGVhc3QoMSwgOSkpO1xuXHRcdGNvbnN0IHN0ZG91dCA9IGF3YWl0IHRoaXMuZ2l0LnJ1bih0aGlzLnJlcG9QYXRoLCBhcmdzKTtcblx0XHRjb25zdCBjb21taXRzID0gcGFyc2VMb2coc3Rkb3V0KTtcblxuXHRcdGlmIChjb21taXRzLmxlbmd0aCA+IHJlcXVlc3QubWF4Q29tbWl0cykge1xuXHRcdFx0cmV0dXJuIHsgY29tbWl0czogY29tbWl0cy5zbGljZSgwLCByZXF1ZXN0Lm1heENvbW1pdHMpLCBtb3JlQXZhaWxhYmxlOiB0cnVlIH07XG5cdFx0fVxuXHRcdHJldHVybiB7IGNvbW1pdHMsIG1vcmVBdmFpbGFibGU6IGZhbHNlIH07XG5cdH1cblxuXHQvKiogUmVzb2x2ZXMgYSByZXZpc2lvbiB0byBhIGZ1bGwgaGFzaCwgb3IgbnVsbCB3aGVuIGl0IGRvZXMgbm90IGV4aXN0LiAqL1xuXHRhc3luYyByZXNvbHZlKHJldmlzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhhc2ggfCBudWxsPiB7XG5cdFx0Y29uc3Qgb3V0cHV0ID0gYXdhaXQgdGhpcy5naXQucnVuT3JOdWxsKHRoaXMucmVwb1BhdGgsIFsncmV2LXBhcnNlJywgJy0tdmVyaWZ5JywgJy0tcXVpZXQnLCBgJHtyZXZpc2lvbn1ee2NvbW1pdH1gXSk7XG5cdFx0Y29uc3QgaGFzaCA9IG91dHB1dD8udHJpbSgpID8/ICcnO1xuXHRcdHJldHVybiAvXlswLTlhLWZdezQwfSQvLnRlc3QoaGFzaCkgPyBoYXNoIDogbnVsbDtcblx0fVxufVxuIiwgIi8qKlxuICogVHlwZXMgc2hhcmVkIGJldHdlZW4gdGhlIGV4dGVuc2lvbiBob3N0IGFuZCB0aGUgd2Vidmlldy4gQW55dGhpbmcgZGVjbGFyZWRcbiAqIGhlcmUgY3Jvc3NlcyBhIHBvc3RNZXNzYWdlIGJvdW5kYXJ5LCBzbyBpdCBtdXN0IHN0YXkgSlNPTi1zZXJpYWxpc2FibGU6XG4gKiBubyBEYXRlLCBubyBNYXAsIG5vIGNsYXNzIGluc3RhbmNlcy5cbiAqL1xuXG4vKiogQSA0MC1jaGFyYWN0ZXIgbG93ZXJjYXNlIGhleCBvYmplY3QgaWQuICovXG5leHBvcnQgdHlwZSBIYXNoID0gc3RyaW5nO1xuXG4vKiogVGhlIHN5bnRoZXRpYyBoYXNoIHVzZWQgZm9yIHRoZSBVbmNvbW1pdHRlZCBDaGFuZ2VzIHJvdy4gKi9cbmV4cG9ydCBjb25zdCBVTkNPTU1JVFRFRDogSGFzaCA9ICcqJy5yZXBlYXQoNDApO1xuXG5leHBvcnQgY29uc3QgUmVmVHlwZSA9IHtcblx0SGVhZDogJ2hlYWQnLFxuXHRSZW1vdGVIZWFkOiAncmVtb3RlSGVhZCcsXG5cdFRhZzogJ3RhZydcbn0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWZUeXBlID0gKHR5cGVvZiBSZWZUeXBlKVtrZXlvZiB0eXBlb2YgUmVmVHlwZV07XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGVhZFJlZiB7XG5cdHJlYWRvbmx5IHR5cGU6IHR5cGVvZiBSZWZUeXBlLkhlYWQ7XG5cdC8qKiBTaG9ydCBuYW1lLCBlLmcuIGBtYWluYC4gKi9cblx0cmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuXHRyZWFkb25seSBoYXNoOiBIYXNoO1xuXHQvKiogYG9yaWdpbi9tYWluYCwgd2hlbiB0aGUgbG9jYWwgYnJhbmNoIHRyYWNrcyBhIHJlbW90ZSBicmFuY2guICovXG5cdHJlYWRvbmx5IHVwc3RyZWFtOiBzdHJpbmcgfCBudWxsO1xuXHQvKiogQ29tbWl0cyBhaGVhZCBvZiAvIGJlaGluZCB0aGUgdXBzdHJlYW0sIG9yIG51bGwgd2hlbiB0aGVyZSBpcyBubyB1cHN0cmVhbS4gKi9cblx0cmVhZG9ubHkgYWhlYWQ6IG51bWJlciB8IG51bGw7XG5cdHJlYWRvbmx5IGJlaGluZDogbnVtYmVyIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZW1vdGVIZWFkUmVmIHtcblx0cmVhZG9ubHkgdHlwZTogdHlwZW9mIFJlZlR5cGUuUmVtb3RlSGVhZDtcblx0LyoqIEZ1bGwgbmFtZSBpbmNsdWRpbmcgdGhlIHJlbW90ZSwgZS5nLiBgb3JpZ2luL21haW5gLiAqL1xuXHRyZWFkb25seSBuYW1lOiBzdHJpbmc7XG5cdHJlYWRvbmx5IHJlbW90ZTogc3RyaW5nO1xuXHRyZWFkb25seSBoYXNoOiBIYXNoO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRhZ1JlZiB7XG5cdHJlYWRvbmx5IHR5cGU6IHR5cGVvZiBSZWZUeXBlLlRhZztcblx0cmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuXHRyZWFkb25seSBoYXNoOiBIYXNoO1xuXHQvKiogVHJ1ZSBmb3IgYW5ub3RhdGVkIG9yIHNpZ25lZCB0YWdzLCB3aGljaCBjYXJyeSB0aGVpciBvd24gb2JqZWN0LiAqL1xuXHRyZWFkb25seSBhbm5vdGF0ZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIFJlZiA9IEhlYWRSZWYgfCBSZW1vdGVIZWFkUmVmIHwgVGFnUmVmO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0YXNoIHtcblx0cmVhZG9ubHkgaW5kZXg6IG51bWJlcjtcblx0cmVhZG9ubHkgaGFzaDogSGFzaDtcblx0LyoqIFRoZSBjb21taXQgdGhlIHN0YXNoIHdhcyB0YWtlbiBhZ2FpbnN0LiAqL1xuXHRyZWFkb25seSBiYXNlSGFzaDogSGFzaDtcblx0cmVhZG9ubHkgc2VsZWN0b3I6IHN0cmluZztcblx0cmVhZG9ubHkgbWVzc2FnZTogc3RyaW5nO1xuXHRyZWFkb25seSBkYXRlOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWl0IHtcblx0cmVhZG9ubHkgaGFzaDogSGFzaDtcblx0cmVhZG9ubHkgcGFyZW50czogcmVhZG9ubHkgSGFzaFtdO1xuXHRyZWFkb25seSBhdXRob3I6IHN0cmluZztcblx0cmVhZG9ubHkgYXV0aG9yRW1haWw6IHN0cmluZztcblx0LyoqIFVuaXggc2Vjb25kcy4gKi9cblx0cmVhZG9ubHkgYXV0aG9yRGF0ZTogbnVtYmVyO1xuXHRyZWFkb25seSBjb21taXR0ZXI6IHN0cmluZztcblx0cmVhZG9ubHkgY29tbWl0dGVyRW1haWw6IHN0cmluZztcblx0cmVhZG9ubHkgY29tbWl0dGVyRGF0ZTogbnVtYmVyO1xuXHRyZWFkb25seSBzdWJqZWN0OiBzdHJpbmc7XG5cdHJlYWRvbmx5IGJvZHk6IHN0cmluZztcblx0LyoqIFBvcHVsYXRlZCBmb3IgdGhlIEhFQUQgY29tbWl0IG9ubHk7IHNlZSBgR2l0TG9nUmVhZGVyYC4gKi9cblx0cmVhZG9ubHkgc3Rhc2g6IFN0YXNoIHwgbnVsbDtcbn1cblxuLyoqIE9uZSB2ZXJ0aWNhbCBsYW5lIG9mIHRoZSBkcmF3biBncmFwaCwgcmVzb2x2ZWQgYnkgdGhlIGxheW91dCBwYXNzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHcmFwaFZlcnRleCB7XG5cdHJlYWRvbmx5IGhhc2g6IEhhc2g7XG5cdC8qKiBaZXJvLWJhc2VkIGNvbHVtbiB0aGUgY29tbWl0J3MgY2lyY2xlIHNpdHMgb24uICovXG5cdHJlYWRvbmx5IGNvbHVtbjogbnVtYmVyO1xuXHQvKiogSW5kZXggaW50byB0aGUgY29uZmlndXJlZCBjb2xvdXIgbGlzdC4gKi9cblx0cmVhZG9ubHkgY29sb3VyOiBudW1iZXI7XG5cdC8qKiBUcnVlIHdoZW4gdGhlIGNvbW1pdCBpcyByZWFjaGFibGUgb25seSBmcm9tIHJlZnMgdGhhdCBhcmUgZmlsdGVyZWQgb3V0LiAqL1xuXHRyZWFkb25seSBkaW1tZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgR3JhcGhFZGdlIHtcblx0LyoqIFJvdyBpbmRleCBvZiB0aGUgY2hpbGQgY29tbWl0LiAqL1xuXHRyZWFkb25seSBmcm9tSW5kZXg6IG51bWJlcjtcblx0LyoqIFJvdyBpbmRleCBvZiB0aGUgcGFyZW50IGNvbW1pdCwgb3IgLTEgd2hlbiB0aGUgcGFyZW50IHdhcyBub3QgbG9hZGVkLiAqL1xuXHRyZWFkb25seSB0b0luZGV4OiBudW1iZXI7XG5cdHJlYWRvbmx5IGZyb21Db2x1bW46IG51bWJlcjtcblx0cmVhZG9ubHkgdG9Db2x1bW46IG51bWJlcjtcblx0LyoqIFRoZSBjb2x1bW4gdGhlIGVkZ2UgdHJhdmVscyBkb3duIGJldHdlZW4gdGhlIHR3byByb3dzLiAqL1xuXHRyZWFkb25seSBsYW5lQ29sdW1uOiBudW1iZXI7XG5cdHJlYWRvbmx5IGNvbG91cjogbnVtYmVyO1xuXHQvKiogVHJ1ZSBmb3IgdGhlIGVkZ2UgbGVhdmluZyB0aGUgVW5jb21taXR0ZWQgQ2hhbmdlcyByb3csIHdoaWNoIGlzIGRyYXduIGRhc2hlZC4gKi9cblx0cmVhZG9ubHkgZGFzaGVkOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEdyYXBoTGF5b3V0IHtcblx0cmVhZG9ubHkgdmVydGljZXM6IHJlYWRvbmx5IEdyYXBoVmVydGV4W107XG5cdHJlYWRvbmx5IGVkZ2VzOiByZWFkb25seSBHcmFwaEVkZ2VbXTtcblx0LyoqIE51bWJlciBvZiBjb2x1bW5zIHJlcXVpcmVkLCB1c2VkIHRvIHNpemUgdGhlIFNWRy4gKi9cblx0cmVhZG9ubHkgd2lkdGg6IG51bWJlcjtcbn1cblxuLyoqIEEgYnJhbmNoIHRoYXQgaXMgYWx3YXlzIGRyYXduIGluIGl0cyBvd24gcmVzZXJ2ZWQgY29sdW1uICgjMjA3KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGlubmVkQnJhbmNoIHtcblx0cmVhZG9ubHkgaGFzaDogSGFzaDtcblx0cmVhZG9ubHkgbmFtZTogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgRmlsZUNoYW5nZVR5cGUgPSB7XG5cdEFkZGVkOiAnQScsXG5cdE1vZGlmaWVkOiAnTScsXG5cdERlbGV0ZWQ6ICdEJyxcblx0UmVuYW1lZDogJ1InLFxuXHRVbnRyYWNrZWQ6ICdVJ1xufSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIEZpbGVDaGFuZ2VUeXBlID0gKHR5cGVvZiBGaWxlQ2hhbmdlVHlwZSlba2V5b2YgdHlwZW9mIEZpbGVDaGFuZ2VUeXBlXTtcblxuZXhwb3J0IGludGVyZmFjZSBGaWxlQ2hhbmdlIHtcblx0cmVhZG9ubHkgdHlwZTogRmlsZUNoYW5nZVR5cGU7XG5cdC8qKiBSZXBvLXJlbGF0aXZlIHBhdGgsIGZvcndhcmQgc2xhc2hlcy4gKi9cblx0cmVhZG9ubHkgcGF0aDogc3RyaW5nO1xuXHQvKiogUHJldmlvdXMgcGF0aCBmb3IgcmVuYW1lcywgb3RoZXJ3aXNlIG51bGwuICovXG5cdHJlYWRvbmx5IG9sZFBhdGg6IHN0cmluZyB8IG51bGw7XG5cdHJlYWRvbmx5IGFkZGl0aW9uczogbnVtYmVyIHwgbnVsbDtcblx0cmVhZG9ubHkgZGVsZXRpb25zOiBudW1iZXIgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1pdERldGFpbHMge1xuXHRyZWFkb25seSBoYXNoOiBIYXNoO1xuXHRyZWFkb25seSBwYXJlbnRzOiByZWFkb25seSBIYXNoW107XG5cdHJlYWRvbmx5IGF1dGhvcjogc3RyaW5nO1xuXHRyZWFkb25seSBhdXRob3JFbWFpbDogc3RyaW5nO1xuXHRyZWFkb25seSBhdXRob3JEYXRlOiBudW1iZXI7XG5cdHJlYWRvbmx5IGNvbW1pdHRlcjogc3RyaW5nO1xuXHRyZWFkb25seSBjb21taXR0ZXJFbWFpbDogc3RyaW5nO1xuXHRyZWFkb25seSBjb21taXR0ZXJEYXRlOiBudW1iZXI7XG5cdHJlYWRvbmx5IHN1YmplY3Q6IHN0cmluZztcblx0cmVhZG9ubHkgYm9keTogc3RyaW5nO1xuXHRyZWFkb25seSBzaWduYXR1cmU6IENvbW1pdFNpZ25hdHVyZSB8IG51bGw7XG5cdHJlYWRvbmx5IGZpbGVDaGFuZ2VzOiByZWFkb25seSBGaWxlQ2hhbmdlW107XG59XG5cbmV4cG9ydCBjb25zdCBTaWduYXR1cmVTdGF0dXMgPSB7XG5cdEdvb2Q6ICdHJyxcblx0QmFkU2lnbmF0dXJlOiAnQicsXG5cdEdvb2RVbmtub3duVmFsaWRpdHk6ICdVJyxcblx0R29vZEV4cGlyZWQ6ICdYJyxcblx0R29vZEV4cGlyZWRLZXk6ICdZJyxcblx0R29vZFJldm9rZWRLZXk6ICdSJyxcblx0Q2Fubm90QmVDaGVja2VkOiAnRScsXG5cdE5vU2lnbmF0dXJlOiAnTidcbn0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBTaWduYXR1cmVTdGF0dXMgPSAodHlwZW9mIFNpZ25hdHVyZVN0YXR1cylba2V5b2YgdHlwZW9mIFNpZ25hdHVyZVN0YXR1c107XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWl0U2lnbmF0dXJlIHtcblx0cmVhZG9ubHkgc3RhdHVzOiBTaWduYXR1cmVTdGF0dXM7XG5cdHJlYWRvbmx5IGtleTogc3RyaW5nO1xuXHRyZWFkb25seSBzaWduZXI6IHN0cmluZztcbn1cblxuLyoqIEEgZmlsdGVyIGFwcGxpZWQgdG8gYGdpdCBsb2dgLCBtaXJyb3JpbmcgdGhlIGZpbHRlciBiYXIgaW4gdGhlIHZpZXcuICovXG5leHBvcnQgaW50ZXJmYWNlIExvZ0ZpbHRlciB7XG5cdC8qKiBSZXN0cmljdCBoaXN0b3J5IHRvIGNvbW1pdHMgdG91Y2hpbmcgdGhlc2UgcmVwby1yZWxhdGl2ZSBwYXRocyAoIzcwKS4gKi9cblx0cmVhZG9ubHkgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuXHQvKiogYC0tYXV0aG9yPWAgcGF0dGVybnMgKCMxNzEpLiAqL1xuXHRyZWFkb25seSBhdXRob3JzOiByZWFkb25seSBzdHJpbmdbXTtcblx0LyoqIEJyYW5jaGVzIHRvIGluY2x1ZGU7IGVtcHR5IG1lYW5zIHRoZSBjdXJyZW50IEhFQUQgb3IgYWxsIHJlZnMuICovXG5cdHJlYWRvbmx5IGJyYW5jaGVzOiByZWFkb25seSBzdHJpbmdbXTtcblx0LyoqIGAtLWV4Y2x1ZGU9YCBnbG9iIHBhdHRlcm5zICgjMzYwKS4gKi9cblx0cmVhZG9ubHkgZXhjbHVkZUdsb2JzOiByZWFkb25seSBzdHJpbmdbXTtcblx0cmVhZG9ubHkgc2hvd1JlbW90ZUJyYW5jaGVzOiBib29sZWFuO1xuXHRyZWFkb25seSBzaG93VGFnczogYm9vbGVhbjtcblx0LyoqIEZyZWUgdGV4dCBtYXRjaGVkIGFnYWluc3QgdGhlIGNvbW1pdCBtZXNzYWdlLCBgLS1ncmVwPWAuICovXG5cdHJlYWRvbmx5IGdyZXA6IHN0cmluZyB8IG51bGw7XG5cdHJlYWRvbmx5IHNpbmNlOiBzdHJpbmcgfCBudWxsO1xuXHRyZWFkb25seSB1bnRpbDogc3RyaW5nIHwgbnVsbDtcblx0LyoqIEV4dHJhIGFyZ3VtZW50cyBhcHBlbmRlZCB2ZXJiYXRpbSB0byBgZ2l0IGxvZ2AgKCM1OTEpLiAqL1xuXHRyZWFkb25seSBleHRyYUFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlGaWx0ZXIoKTogTG9nRmlsdGVyIHtcblx0cmV0dXJuIHtcblx0XHRwYXRoczogW10sXG5cdFx0YXV0aG9yczogW10sXG5cdFx0YnJhbmNoZXM6IFtdLFxuXHRcdGV4Y2x1ZGVHbG9iczogW10sXG5cdFx0c2hvd1JlbW90ZUJyYW5jaGVzOiB0cnVlLFxuXHRcdHNob3dUYWdzOiB0cnVlLFxuXHRcdGdyZXA6IG51bGwsXG5cdFx0c2luY2U6IG51bGwsXG5cdFx0dW50aWw6IG51bGwsXG5cdFx0ZXh0cmFBcmdzOiBbXVxuXHR9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcG9TdGF0ZSB7XG5cdHJlYWRvbmx5IHBhdGg6IHN0cmluZztcblx0cmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuXHQvKiogU2hvcnQgbmFtZSBvZiB0aGUgY2hlY2tlZCBvdXQgYnJhbmNoLCBvciBudWxsIHdoZW4gZGV0YWNoZWQuICovXG5cdHJlYWRvbmx5IGhlYWQ6IHN0cmluZyB8IG51bGw7XG5cdHJlYWRvbmx5IGhlYWRIYXNoOiBIYXNoIHwgbnVsbDtcblx0cmVhZG9ubHkgaXNEZXRhY2hlZDogYm9vbGVhbjtcblx0LyoqIFNldCB3aGlsZSBhIG1lcmdlLCByZWJhc2UsIGNoZXJyeS1waWNrIG9yIHJldmVydCBpcyBpbiBwcm9ncmVzcy4gKi9cblx0cmVhZG9ubHkgcGVuZGluZ09wZXJhdGlvbjogUGVuZGluZ09wZXJhdGlvbiB8IG51bGw7XG59XG5cbmV4cG9ydCBjb25zdCBQZW5kaW5nT3BlcmF0aW9uID0ge1xuXHRNZXJnZTogJ21lcmdlJyxcblx0UmViYXNlOiAncmViYXNlJyxcblx0Q2hlcnJ5UGljazogJ2NoZXJyeS1waWNrJyxcblx0UmV2ZXJ0OiAncmV2ZXJ0Jyxcblx0QmlzZWN0OiAnYmlzZWN0J1xufSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFBlbmRpbmdPcGVyYXRpb24gPSAodHlwZW9mIFBlbmRpbmdPcGVyYXRpb24pW2tleW9mIHR5cGVvZiBQZW5kaW5nT3BlcmF0aW9uXTtcbiIsICJpbXBvcnQgdHlwZSB7IEdpdEV4ZWN1dG9yIH0gZnJvbSAnLi9leGVjdXRvci50cyc7XG5pbXBvcnQgeyBQZW5kaW5nT3BlcmF0aW9uLCBSZWZUeXBlLCB0eXBlIEhhc2gsIHR5cGUgSGVhZFJlZiwgdHlwZSBSZWYsIHR5cGUgUmVtb3RlSGVhZFJlZiwgdHlwZSBSZXBvU3RhdGUsIHR5cGUgU3Rhc2gsIHR5cGUgVGFnUmVmIH0gZnJvbSAnLi4vdHlwZXMudHMnO1xuXG4vKipcbiAqIFJlZiBmaWVsZHMsIE5VTC1zZXBhcmF0ZWQuXG4gKlxuICogYGZvci1lYWNoLXJlZmAgc3BlbGxzIGEgTlVMIGFzIGAlMDBgIFx1MjAxNCBub3RlIHRoYXQgYGdpdCBsb2dgIGFuZCBgZ2l0IHN0YXNoXG4gKiBsaXN0YCBzcGVsbCB0aGUgc2FtZSBieXRlIGAleDAwYCBpbnN0ZWFkLCBzbyB0aGVzZSBmb3JtYXRzIGFyZSBub3RcbiAqIGludGVyY2hhbmdlYWJsZS4gVGhlIHRyYWlsaW5nIHNlcGFyYXRvciBtYXR0ZXJzIHRvbzogd2l0aG91dCBpdCB0aGUgbGFzdFxuICogZmllbGQgb2Ygb25lIHJlY29yZCBydW5zIGludG8gdGhlIGZpcnN0IGZpZWxkIG9mIHRoZSBuZXh0LCBzZXBhcmF0ZWQgb25seSBieVxuICogdGhlIG5ld2xpbmUgZ2l0IHdyaXRlcyBiZXR3ZWVuIHJlY29yZHMsIGFuZCBldmVyeSByZWNvcmQgYWZ0ZXIgdGhlIGZpcnN0IGlzXG4gKiBwYXJzZWQgb25lIGZpZWxkIG91dCBvZiBzdGVwLlxuICovXG5jb25zdCBSRUZfRklFTERTID0gW1xuXHQnJShyZWZuYW1lKScsXG5cdCclKG9iamVjdG5hbWUpJyxcblx0JyUob2JqZWN0dHlwZSknLFxuXHQnJSgqb2JqZWN0bmFtZSknLFxuXHQnJSh1cHN0cmVhbTpzaG9ydCknLFxuXHQnJSh1cHN0cmVhbTp0cmFjayknLFxuXHQnJShzeW1yZWYpJ1xuXSBhcyBjb25zdDtcbmNvbnN0IFJFRl9GT1JNQVQgPSBgLS1mb3JtYXQ9JHtSRUZfRklFTERTLmpvaW4oJyUwMCcpfSUwMGA7XG5jb25zdCBGSUVMRFNfUEVSX1JFRiA9IFJFRl9GSUVMRFMubGVuZ3RoO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlZnNSZXN1bHQge1xuXHRyZWFkb25seSBoZWFkczogcmVhZG9ubHkgSGVhZFJlZltdO1xuXHRyZWFkb25seSByZW1vdGVIZWFkczogcmVhZG9ubHkgUmVtb3RlSGVhZFJlZltdO1xuXHRyZWFkb25seSB0YWdzOiByZWFkb25seSBUYWdSZWZbXTtcblx0LyoqIFJlbW90ZSBuYW1lIHRvIHRoZSBicmFuY2ggaXRzIEhFQUQgcG9pbnRzIGF0LCBlLmcuIGBvcmlnaW5gIFx1MjE5MiBgb3JpZ2luL21haW5gLiAqL1xuXHRyZWFkb25seSByZW1vdGVIZWFkU3ltcmVmczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG59XG5cbi8qKlxuICogUGFyc2VzIGBbYWhlYWQgMywgYmVoaW5kIDFdYCBhcyBwcm9kdWNlZCBieSBgJSh1cHN0cmVhbTp0cmFjaylgLlxuICpcbiAqIFdpdGggTENfQUxMPUMgdGhlIHdvcmRpbmcgaXMgZml4ZWQsIGJ1dCB0aGUgc2hhcGUgdmFyaWVzOiBlaXRoZXIgaGFsZiBjYW4gYmVcbiAqIGFic2VudCwgYW5kIGEgZGVsZXRlZCB1cHN0cmVhbSByZXBvcnRzIGBbZ29uZV1gLiBBbnl0aGluZyB1bnJlY29nbmlzZWQgeWllbGRzXG4gKiBudWxscyByYXRoZXIgdGhhbiBhIG1pc2xlYWRpbmcgemVyby5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVXBzdHJlYW1UcmFjayh0cmFjazogc3RyaW5nKTogeyBhaGVhZDogbnVtYmVyIHwgbnVsbDsgYmVoaW5kOiBudW1iZXIgfCBudWxsIH0ge1xuXHRpZiAodHJhY2sgPT09ICcnIHx8IHRyYWNrLmluY2x1ZGVzKCdnb25lJykpIHJldHVybiB7IGFoZWFkOiBudWxsLCBiZWhpbmQ6IG51bGwgfTtcblx0Y29uc3QgYWhlYWQgPSAvYWhlYWQgKFxcZCspLy5leGVjKHRyYWNrKTtcblx0Y29uc3QgYmVoaW5kID0gL2JlaGluZCAoXFxkKykvLmV4ZWModHJhY2spO1xuXHRpZiAoYWhlYWQgPT09IG51bGwgJiYgYmVoaW5kID09PSBudWxsKSB7XG5cdFx0Ly8gYFtdYCBvciBhbiBlbXB0eSB0cmFjayB3aXRoIGFuIHVwc3RyZWFtIHNldCBtZWFucyBmdWxseSBpbiBzeW5jLlxuXHRcdHJldHVybiB7IGFoZWFkOiAwLCBiZWhpbmQ6IDAgfTtcblx0fVxuXHRyZXR1cm4ge1xuXHRcdGFoZWFkOiBhaGVhZCAhPT0gbnVsbCA/IHBhcnNlSW50KGFoZWFkWzFdLCAxMCkgOiAwLFxuXHRcdGJlaGluZDogYmVoaW5kICE9PSBudWxsID8gcGFyc2VJbnQoYmVoaW5kWzFdLCAxMCkgOiAwXG5cdH07XG59XG5cbi8qKiBTcGxpdHMgYSByZW1vdGUtdHJhY2tpbmcgcmVmIGxpa2UgYG9yaWdpbi9mZWF0dXJlL3hgIGludG8gcmVtb3RlIGFuZCByZXN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0UmVtb3RlUmVmKHNob3J0TmFtZTogc3RyaW5nLCByZW1vdGVzOiByZWFkb25seSBzdHJpbmdbXSk6IHsgcmVtb3RlOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIH0gfCBudWxsIHtcblx0Ly8gTG9uZ2VzdCByZW1vdGUgbmFtZSBmaXJzdCwgc28gYG9yaWdpbi9zdWJgIGRvZXMgbm90IHNoYWRvdyBhIHJlbW90ZVxuXHQvLyBsaXRlcmFsbHkgY2FsbGVkIGBvcmlnaW4vc3ViYCB3aGVuIGJvdGggZXhpc3QuXG5cdGZvciAoY29uc3QgcmVtb3RlIG9mIFsuLi5yZW1vdGVzXS5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKSkge1xuXHRcdGlmIChzaG9ydE5hbWUgPT09IHJlbW90ZSkgcmV0dXJuIG51bGw7XG5cdFx0aWYgKHNob3J0TmFtZS5zdGFydHNXaXRoKGAke3JlbW90ZX0vYCkpIHtcblx0XHRcdHJldHVybiB7IHJlbW90ZSwgYnJhbmNoOiBzaG9ydE5hbWUuc2xpY2UocmVtb3RlLmxlbmd0aCArIDEpIH07XG5cdFx0fVxuXHR9XG5cdHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZWZzKHN0ZG91dDogc3RyaW5nLCByZW1vdGVzOiByZWFkb25seSBzdHJpbmdbXSk6IFJlZnNSZXN1bHQge1xuXHRjb25zdCBoZWFkczogSGVhZFJlZltdID0gW107XG5cdGNvbnN0IHJlbW90ZUhlYWRzOiBSZW1vdGVIZWFkUmVmW10gPSBbXTtcblx0Y29uc3QgdGFnczogVGFnUmVmW10gPSBbXTtcblx0Y29uc3QgcmVtb3RlSGVhZFN5bXJlZnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblxuXHRjb25zdCBmaWVsZHMgPSBzdGRvdXQuc3BsaXQoJ1xcMCcpO1xuXHRjb25zdCByZWNvcmRzID0gTWF0aC5mbG9vcihmaWVsZHMubGVuZ3RoIC8gRklFTERTX1BFUl9SRUYpO1xuXG5cdGZvciAobGV0IHJlY29yZCA9IDA7IHJlY29yZCA8IHJlY29yZHM7IHJlY29yZCsrKSB7XG5cdFx0Y29uc3QgYmFzZSA9IHJlY29yZCAqIEZJRUxEU19QRVJfUkVGO1xuXHRcdGNvbnN0IHJlZm5hbWUgPSBmaWVsZHNbYmFzZV0ucmVwbGFjZSgvXlxcbi8sICcnKTtcblx0XHRjb25zdCBvYmplY3RuYW1lID0gZmllbGRzW2Jhc2UgKyAxXTtcblx0XHRjb25zdCBvYmplY3R0eXBlID0gZmllbGRzW2Jhc2UgKyAyXTtcblx0XHRjb25zdCBkZXJlZmVyZW5jZWQgPSBmaWVsZHNbYmFzZSArIDNdO1xuXHRcdGNvbnN0IHVwc3RyZWFtID0gZmllbGRzW2Jhc2UgKyA0XTtcblx0XHRjb25zdCB0cmFjayA9IGZpZWxkc1tiYXNlICsgNV07XG5cdFx0Y29uc3Qgc3ltcmVmID0gZmllbGRzW2Jhc2UgKyA2XTtcblxuXHRcdGlmIChyZWZuYW1lLnN0YXJ0c1dpdGgoJ3JlZnMvaGVhZHMvJykpIHtcblx0XHRcdGNvbnN0IHsgYWhlYWQsIGJlaGluZCB9ID0gcGFyc2VVcHN0cmVhbVRyYWNrKHRyYWNrKTtcblx0XHRcdGhlYWRzLnB1c2goe1xuXHRcdFx0XHR0eXBlOiBSZWZUeXBlLkhlYWQsXG5cdFx0XHRcdG5hbWU6IHJlZm5hbWUuc2xpY2UoJ3JlZnMvaGVhZHMvJy5sZW5ndGgpLFxuXHRcdFx0XHRoYXNoOiBvYmplY3RuYW1lLFxuXHRcdFx0XHR1cHN0cmVhbTogdXBzdHJlYW0gPT09ICcnID8gbnVsbCA6IHVwc3RyZWFtLFxuXHRcdFx0XHRhaGVhZDogdXBzdHJlYW0gPT09ICcnID8gbnVsbCA6IGFoZWFkLFxuXHRcdFx0XHRiZWhpbmQ6IHVwc3RyZWFtID09PSAnJyA/IG51bGwgOiBiZWhpbmRcblx0XHRcdH0pO1xuXHRcdH0gZWxzZSBpZiAocmVmbmFtZS5zdGFydHNXaXRoKCdyZWZzL3JlbW90ZXMvJykpIHtcblx0XHRcdGNvbnN0IHNob3J0TmFtZSA9IHJlZm5hbWUuc2xpY2UoJ3JlZnMvcmVtb3Rlcy8nLmxlbmd0aCk7XG5cdFx0XHRjb25zdCBzcGxpdCA9IHNwbGl0UmVtb3RlUmVmKHNob3J0TmFtZSwgcmVtb3Rlcyk7XG5cdFx0XHRpZiAoc3BsaXQgPT09IG51bGwpIGNvbnRpbnVlO1xuXHRcdFx0aWYgKHNwbGl0LmJyYW5jaCA9PT0gJ0hFQUQnKSB7XG5cdFx0XHRcdC8vIGBvcmlnaW4vSEVBRGAgaXMgYSBzeW1ib2xpYyByZWYgbmFtaW5nIHRoZSByZW1vdGUncyBkZWZhdWx0XG5cdFx0XHRcdC8vIGJyYW5jaDsgaXQgaXMgbm90IGEgYnJhbmNoIG9mIGl0cyBvd24gYW5kIG11c3Qgbm90IGJlIGRyYXduLlxuXHRcdFx0XHRpZiAoc3ltcmVmICE9PSAnJykge1xuXHRcdFx0XHRcdHJlbW90ZUhlYWRTeW1yZWZzW3NwbGl0LnJlbW90ZV0gPSBzeW1yZWYucmVwbGFjZSgvXnJlZnNcXC9yZW1vdGVzXFwvLywgJycpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0cmVtb3RlSGVhZHMucHVzaCh7IHR5cGU6IFJlZlR5cGUuUmVtb3RlSGVhZCwgbmFtZTogc2hvcnROYW1lLCByZW1vdGU6IHNwbGl0LnJlbW90ZSwgaGFzaDogb2JqZWN0bmFtZSB9KTtcblx0XHR9IGVsc2UgaWYgKHJlZm5hbWUuc3RhcnRzV2l0aCgncmVmcy90YWdzLycpKSB7XG5cdFx0XHRjb25zdCBhbm5vdGF0ZWQgPSBvYmplY3R0eXBlID09PSAndGFnJztcblx0XHRcdHRhZ3MucHVzaCh7XG5cdFx0XHRcdHR5cGU6IFJlZlR5cGUuVGFnLFxuXHRcdFx0XHRuYW1lOiByZWZuYW1lLnNsaWNlKCdyZWZzL3RhZ3MvJy5sZW5ndGgpLFxuXHRcdFx0XHQvLyBBbiBhbm5vdGF0ZWQgdGFnJ3Mgb3duIG9iamVjdCBpZCBpcyBub3QgYSBjb21taXQ7IHRoZSBncmFwaFxuXHRcdFx0XHQvLyBtdXN0IGF0dGFjaCB0aGUgbGFiZWwgdG8gdGhlIGNvbW1pdCBpdCBkZXJlZmVyZW5jZXMgdG8uXG5cdFx0XHRcdGhhc2g6IGFubm90YXRlZCAmJiBkZXJlZmVyZW5jZWQgIT09ICcnID8gZGVyZWZlcmVuY2VkIDogb2JqZWN0bmFtZSxcblx0XHRcdFx0YW5ub3RhdGVkXG5cdFx0XHR9KTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4geyBoZWFkcywgcmVtb3RlSGVhZHMsIHRhZ3MsIHJlbW90ZUhlYWRTeW1yZWZzIH07XG59XG5cbi8qKiBSZWFkcyByZWZzLCBzdGFzaGVzIGFuZCB3b3JraW5nLXRyZWUgc3RhdGUgZm9yIG9uZSByZXBvc2l0b3J5LiAqL1xuZXhwb3J0IGNsYXNzIEdpdFJlZlJlYWRlciB7XG5cdGNvbnN0cnVjdG9yKFxuXHRcdHByaXZhdGUgcmVhZG9ubHkgZ2l0OiBHaXRFeGVjdXRvcixcblx0XHRwcml2YXRlIHJlYWRvbmx5IHJlcG9QYXRoOiBzdHJpbmdcblx0KSB7fVxuXG5cdGFzeW5jIHJlbW90ZXMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuXHRcdGNvbnN0IG91dHB1dCA9IGF3YWl0IHRoaXMuZ2l0LnJ1bih0aGlzLnJlcG9QYXRoLCBbJ3JlbW90ZSddKTtcblx0XHRyZXR1cm4gb3V0cHV0LnNwbGl0KCdcXG4nKS5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKS5maWx0ZXIoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cdH1cblxuXHRhc3luYyByZWFkUmVmcyhyZW1vdGVzOiByZWFkb25seSBzdHJpbmdbXSk6IFByb21pc2U8UmVmc1Jlc3VsdD4ge1xuXHRcdGNvbnN0IHN0ZG91dCA9IGF3YWl0IHRoaXMuZ2l0LnJ1bih0aGlzLnJlcG9QYXRoLCBbXG5cdFx0XHQnZm9yLWVhY2gtcmVmJyxcblx0XHRcdFJFRl9GT1JNQVQsXG5cdFx0XHQncmVmcy9oZWFkcycsXG5cdFx0XHQncmVmcy9yZW1vdGVzJyxcblx0XHRcdCdyZWZzL3RhZ3MnXG5cdFx0XSk7XG5cdFx0cmV0dXJuIHBhcnNlUmVmcyhzdGRvdXQsIHJlbW90ZXMpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlYWRzIHRoZSBzdGFzaCBsaXN0LiBTdGFzaGVzIGFyZSBjb21taXRzIHRoYXQgbm8gYnJhbmNoIHBvaW50cyBhdCwgc29cblx0ICogdGhleSBtdXN0IGJlIGNvbGxlY3RlZCBzZXBhcmF0ZWx5IG9yIHRoZXkgdmFuaXNoIGZyb20gdGhlIGdyYXBoLlxuXHQgKi9cblx0YXN5bmMgcmVhZFN0YXNoZXMoKTogUHJvbWlzZTxTdGFzaFtdPiB7XG5cdFx0Ly8gYGdpdCBzdGFzaCBsaXN0YCB0YWtlcyBhIGxvZyBmb3JtYXQsIHdoZXJlIE5VTCBpcyB3cml0dGVuIGAleDAwYDtcblx0XHQvLyBgJTAwYCB3b3VsZCBiZSBlbWl0dGVkIGFzIHRob3NlIHRocmVlIGxpdGVyYWwgY2hhcmFjdGVycy5cblx0XHRjb25zdCBvdXRwdXQgPSBhd2FpdCB0aGlzLmdpdC5ydW5Pck51bGwodGhpcy5yZXBvUGF0aCwgW1xuXHRcdFx0J3N0YXNoJyxcblx0XHRcdCdsaXN0Jyxcblx0XHRcdCctLWZvcm1hdD0lZ2QleDAwJUgleDAwJVAleDAwJWF0JXgwMCVncydcblx0XHRdKTtcblx0XHRpZiAob3V0cHV0ID09PSBudWxsKSByZXR1cm4gW107XG5cblx0XHRjb25zdCBzdGFzaGVzOiBTdGFzaFtdID0gW107XG5cdFx0Zm9yIChjb25zdCBsaW5lIG9mIG91dHB1dC5zcGxpdCgnXFxuJykpIHtcblx0XHRcdGlmIChsaW5lLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cdFx0XHRjb25zdCBwYXJ0cyA9IGxpbmUuc3BsaXQoJ1xcMCcpO1xuXHRcdFx0aWYgKHBhcnRzLmxlbmd0aCA8IDUpIGNvbnRpbnVlO1xuXHRcdFx0Y29uc3QgcGFyZW50cyA9IHBhcnRzWzJdLnNwbGl0KCcgJykuZmlsdGVyKChwKSA9PiBwLmxlbmd0aCA+IDApO1xuXHRcdFx0Y29uc3QgaW5kZXggPSAvXnN0YXNoQFxceyhcXGQrKVxcfSQvLmV4ZWMocGFydHNbMF0pO1xuXHRcdFx0c3Rhc2hlcy5wdXNoKHtcblx0XHRcdFx0aW5kZXg6IGluZGV4ICE9PSBudWxsID8gcGFyc2VJbnQoaW5kZXhbMV0sIDEwKSA6IHN0YXNoZXMubGVuZ3RoLFxuXHRcdFx0XHRoYXNoOiBwYXJ0c1sxXSxcblx0XHRcdFx0YmFzZUhhc2g6IHBhcmVudHNbMF0gPz8gJycsXG5cdFx0XHRcdHNlbGVjdG9yOiBwYXJ0c1swXSxcblx0XHRcdFx0bWVzc2FnZTogcGFydHNbNF0sXG5cdFx0XHRcdGRhdGU6IHBhcnNlSW50KHBhcnRzWzNdLCAxMCkgfHwgMFxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdHJldHVybiBzdGFzaGVzO1xuXHR9XG5cblx0LyoqIFJlYWRzIHdoaWNoIGJyYW5jaCBpcyBjaGVja2VkIG91dCwgYW5kIHdoZXRoZXIgYW4gb3BlcmF0aW9uIGlzIGluIHByb2dyZXNzLiAqL1xuXHRhc3luYyByZWFkU3RhdGUoKTogUHJvbWlzZTxPbWl0PFJlcG9TdGF0ZSwgJ3BhdGgnIHwgJ25hbWUnPj4ge1xuXHRcdGNvbnN0IFtoZWFkTmFtZSwgaGVhZEhhc2gsIHBlbmRpbmddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuXHRcdFx0dGhpcy5naXQucnVuT3JOdWxsKHRoaXMucmVwb1BhdGgsIFsnc3ltYm9saWMtcmVmJywgJy0tc2hvcnQnLCAnLXEnLCAnSEVBRCddKSxcblx0XHRcdHRoaXMuZ2l0LnJ1bk9yTnVsbCh0aGlzLnJlcG9QYXRoLCBbJ3Jldi1wYXJzZScsICctLXZlcmlmeScsICctLXF1aWV0JywgJ0hFQUQnXSksXG5cdFx0XHR0aGlzLnJlYWRQZW5kaW5nT3BlcmF0aW9uKClcblx0XHRdKTtcblxuXHRcdGNvbnN0IGhlYWQgPSBoZWFkTmFtZT8udHJpbSgpID8/ICcnO1xuXHRcdGNvbnN0IGhhc2ggPSBoZWFkSGFzaD8udHJpbSgpID8/ICcnO1xuXHRcdHJldHVybiB7XG5cdFx0XHRoZWFkOiBoZWFkID09PSAnJyA/IG51bGwgOiBoZWFkLFxuXHRcdFx0aGVhZEhhc2g6IC9eWzAtOWEtZl17NDB9JC8udGVzdChoYXNoKSA/IGhhc2ggOiBudWxsLFxuXHRcdFx0aXNEZXRhY2hlZDogaGVhZCA9PT0gJycsXG5cdFx0XHRwZW5kaW5nT3BlcmF0aW9uOiBwZW5kaW5nXG5cdFx0fTtcblx0fVxuXG5cdC8qKlxuXHQgKiBEZXRlY3RzIGFuIGludGVycnVwdGVkIG1lcmdlLCByZWJhc2UsIGNoZXJyeS1waWNrLCByZXZlcnQgb3IgYmlzZWN0LlxuXHQgKlxuXHQgKiBUaGVzZSBhcmUgcmVhZCBmcm9tIHRoZSBnaXQgZGlyZWN0b3J5IHJhdGhlciB0aGFuIGluZmVycmVkLCBzbyB0aGUgdmlld1xuXHQgKiBjYW4gb2ZmZXIgYC0tY29udGludWVgIC8gYC0tYWJvcnRgIGluc3RlYWQgb2YgbGVhdmluZyB0aGUgdXNlciBzdHVjayBpbiBhXG5cdCAqIHN0YXRlIHRoZSBncmFwaCBkb2VzIG5vdCBhY2tub3dsZWRnZS5cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgcmVhZFBlbmRpbmdPcGVyYXRpb24oKTogUHJvbWlzZTxQZW5kaW5nT3BlcmF0aW9uIHwgbnVsbD4ge1xuXHRcdGNvbnN0IGdpdERpciA9IChhd2FpdCB0aGlzLmdpdC5ydW5Pck51bGwodGhpcy5yZXBvUGF0aCwgWydyZXYtcGFyc2UnLCAnLS1hYnNvbHV0ZS1naXQtZGlyJ10pKT8udHJpbSgpO1xuXHRcdGlmIChnaXREaXIgPT09IHVuZGVmaW5lZCB8fCBnaXREaXIgPT09ICcnKSByZXR1cm4gbnVsbDtcblxuXHRcdGNvbnN0IHsgZXhpc3RzU3luYyB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzJyk7XG5cdFx0Y29uc3QgeyBqb2luIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6cGF0aCcpO1xuXHRcdGNvbnN0IGhhcyA9ICguLi5wYXJ0czogc3RyaW5nW10pID0+IGV4aXN0c1N5bmMoam9pbihnaXREaXIsIC4uLnBhcnRzKSk7XG5cblx0XHRpZiAoaGFzKCdyZWJhc2UtbWVyZ2UnKSB8fCBoYXMoJ3JlYmFzZS1hcHBseScpKSByZXR1cm4gUGVuZGluZ09wZXJhdGlvbi5SZWJhc2U7XG5cdFx0aWYgKGhhcygnTUVSR0VfSEVBRCcpKSByZXR1cm4gUGVuZGluZ09wZXJhdGlvbi5NZXJnZTtcblx0XHRpZiAoaGFzKCdDSEVSUllfUElDS19IRUFEJykpIHJldHVybiBQZW5kaW5nT3BlcmF0aW9uLkNoZXJyeVBpY2s7XG5cdFx0aWYgKGhhcygnUkVWRVJUX0hFQUQnKSkgcmV0dXJuIFBlbmRpbmdPcGVyYXRpb24uUmV2ZXJ0O1xuXHRcdGlmIChoYXMoJ0JJU0VDVF9MT0cnKSkgcmV0dXJuIFBlbmRpbmdPcGVyYXRpb24uQmlzZWN0O1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0LyoqIFJldHVybnMgdGhlIGhhc2hlcyBvZiBjb21taXRzIHRoYXQgYXJlIHN0YXNoIGVudHJpZXMsIGZvciBncmFwaCBpbmNsdXNpb24uICovXG5cdHN0YXRpYyBzdGFzaEhhc2hlcyhzdGFzaGVzOiByZWFkb25seSBTdGFzaFtdKTogU2V0PEhhc2g+IHtcblx0XHRyZXR1cm4gbmV3IFNldChzdGFzaGVzLm1hcCgoc3Rhc2gpID0+IHN0YXNoLmhhc2gpKTtcblx0fVxuXG5cdC8qKiBUeXBlIGd1YXJkIHVzZWQgYnkgdGhlIHZpZXcgd2hlbiBuYXJyb3dpbmcgYSBtaXhlZCByZWYgbGlzdC4gKi9cblx0c3RhdGljIGlzSGVhZChyZWY6IFJlZik6IHJlZiBpcyBIZWFkUmVmIHtcblx0XHRyZXR1cm4gcmVmLnR5cGUgPT09IFJlZlR5cGUuSGVhZDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLHlCQUFpQztBQUNqQyx1QkFBb0M7QUFDcEMsZ0NBQTZCO0FBQzdCLHFCQUFtRDtBQUNuRCxxQkFBdUI7QUFDdkIsdUJBQXFCOzs7QUNMckIsMkJBQTJEO0FBZXBELElBQU0saUJBQU4sY0FBNkIsTUFBTTtBQUFBLEVBQ3pDLGNBQWM7QUFDYixVQUFNLCtCQUErQjtBQUNyQyxTQUFLLE9BQU87QUFBQSxFQUNiO0FBQ0Q7QUFHTyxJQUFNLFdBQU4sY0FBdUIsTUFBTTtBQUFBLEVBQ25DLFlBQ0MsU0FDUyxVQUNBLE1BQ0EsUUFDUjtBQUNELFVBQU0sT0FBTztBQUpKO0FBQ0E7QUFDQTtBQUdULFNBQUssT0FBTztBQUFBLEVBQ2I7QUFDRDtBQXVCTyxTQUFTLGdCQUFnQixHQUFlLEdBQTZEO0FBQzNHLFNBQU8sRUFBRSxRQUFRLEVBQUUsU0FB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
