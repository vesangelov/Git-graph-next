import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { GitExecutor } from './executor.ts';

/**
 * Folders never descended into while scanning for nested repositories. They
 * are either huge (dependency trees) or cannot contain a repository the user
 * means to browse, and walking them makes discovery take seconds.
 */
const SKIPPED_FOLDERS = new Set(['node_modules', 'bower_components', 'vendor', '.venv', 'venv', '__pycache__', 'target', 'dist', 'out', 'build']);

/** A repository known to the extension. */
export interface RepositoryInfo {
	/** Absolute path of the working tree root, as git reports it. */
	readonly path: string;
	/** Folder name, used as the label in the repository dropdown. */
	readonly name: string;
}

/**
 * Canonical form of a repository path, used as the identity when merging
 * repositories reported by several sources. Symlinks are resolved so a folder
 * opened through a link is not listed twice.
 */
export function normaliseRepoPath(path: string): string {
	let resolved = resolve(path);
	try {
		resolved = realpathSync.native(resolved);
	} catch {
		/* The folder may have been deleted; keep the lexical form. */
	}
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function repositoryInfo(path: string): RepositoryInfo {
	const resolved = resolve(path);
	return { path: resolved, name: basename(resolved) || resolved };
}

/**
 * Returns the working tree root containing `path` (a folder or a file), or null
 * when it is not inside a repository (or is inside the `.git` directory itself, where
 * `--show-toplevel` fails).
 */
export async function findEnclosingRepository(git: GitExecutor, path: string): Promise<string | null> {
	let folder: string;
	try {
		// git must run in a directory; for a file, ask about the folder holding it.
		folder = statSync(path).isDirectory() ? path : dirname(path);
	} catch {
		return null;
	}
	const output = await git.runOrNull(folder, ['rev-parse', '--show-toplevel']);
	const root = output?.trim() ?? '';
	return root === '' ? null : resolve(root);
}

/**
 * Lists folders below `root` (excluding `root` itself) that contain a `.git`
 * entry, descending at most `maxDepth` levels.
 *
 * `.git` may be a directory or, for worktrees and submodules, a file; both
 * count. The walk does not stop at a repository, because monorepo-style
 * layouts nest repositories inside each other.
 */
export function scanForNestedRepositories(root: string, maxDepth: number): string[] {
	const found: string[] = [];
	if (maxDepth <= 0) return found;

	const walk = (folder: string, depth: number): void => {
		let entries;
		try {
			entries = readdirSync(folder, { withFileTypes: true });
		} catch {
			return; // Unreadable folder: permissions, or deleted mid-scan.
		}
		for (const entry of entries) {
			// Symlinked folders are not followed, which also rules out cycles.
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) continue;
			const child = join(folder, entry.name);
			if (existsSync(join(child, '.git'))) found.push(child);
			if (depth < maxDepth) walk(child, depth + 1);
		}
	};

	walk(root, 1);
	return found;
}

/**
 * Discovers every repository relevant to a set of workspace folders: the one
 * enclosing each folder, plus nested ones down to `maxDepth`.
 */
export async function discoverRepositories(git: GitExecutor, folders: readonly string[], maxDepth: number): Promise<string[]> {
	const candidates: string[] = [];
	for (const folder of folders) {
		const enclosing = await findEnclosingRepository(git, folder);
		if (enclosing !== null) candidates.push(enclosing);
		candidates.push(...scanForNestedRepositories(folder, maxDepth));
	}

	// Nested candidates are only folders with a `.git` entry; ask git for the
	// real root so a broken or half-initialised `.git` is not offered.
	const roots = await Promise.all(candidates.map((candidate) => findEnclosingRepository(git, candidate)));
	return dedupePaths(roots.filter((root): root is string => root !== null));
}

/** Removes duplicate repository paths, keeping the first spelling of each. */
export function dedupePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const key = normaliseRepoPath(path);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(path);
	}
	return result;
}

/** Where a repository's git data lives, when that is not simply `<root>/.git`. */
export interface GitDirectories {
	/** This working tree's own git directory: HEAD, index, `MERGE_HEAD`, … */
	readonly gitDir: string;
	/** The directory shared by all worktrees: refs, `packed-refs`, `FETCH_HEAD`. */
	readonly commonDir: string;
}

/**
 * The git directories of a repository that lie outside its working tree, or
 * null when everything is in `<root>/.git`.
 *
 * A linked worktree keeps HEAD and its index in `<main>/.git/worktrees/<name>`
 * and its branches in `<main>/.git/refs`; a submodule keeps everything in the
 * superproject's `.git/modules/<name>`. A commit made in either changes
 * nothing inside the working tree itself, so watching only the working tree
 * never notices it.
 */
export async function externalGitDirectories(git: GitExecutor, root: string): Promise<GitDirectories | null> {
	const output = await git.runOrNull(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
	const [gitDir, commonDir] = (output ?? '').split('\n').map((line) => line.trim());
	if (gitDir === undefined || gitDir === '' || commonDir === undefined || commonDir === '') return null;
	// `--git-common-dir` is relative to the directory git ran in, unless absolute.
	const resolved = { gitDir: resolve(gitDir), commonDir: resolve(root, commonDir) };
	const inside = (dir: string) => {
		const rel = relative(normaliseRepoPath(root), normaliseRepoPath(dir));
		return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
	};
	return inside(resolved.gitDir) && inside(resolved.commonDir) ? null : resolved;
}

/**
 * The paths among `paths` (repo-relative, forward slashes) that git ignores:
 * build output, dependencies, anything `.gitignore` covers. A change to one
 * cannot alter the graph or the uncommitted changes, so it need not reload.
 * Tracked files are never reported, even when a pattern matches them.
 */
export async function ignoredPaths(git: GitExecutor, root: string, paths: readonly string[]): Promise<Set<string>> {
	if (paths.length === 0) return new Set();
	// Exit code 1 means "none ignored", which is an answer, not a failure.
	const output = await git.runOrNull(root, ['check-ignore', '--stdin', '-z'], { stdin: `${paths.join('\0')}\0`, ignoreExitCode: true });
	return new Set((output ?? '').split('\0').filter((path) => path !== ''));
}
