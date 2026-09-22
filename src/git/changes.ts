import type { GitExecutor } from './executor.ts';
import { FileChangeType, UNCOMMITTED, type ChangeTarget, type FileChange, type Hash } from '../types.ts';

/**
 * Flags every diff invocation needs. `--no-color` matters: with
 * `color.ui=always` in the user's config, git colours even piped output, and
 * the escape codes end up inside the parsed paths.
 */
const DIFF_FLAGS = ['-z', '-M', '--no-color', '--no-ext-diff'];

function statusType(letter: string): FileChangeType {
	switch (letter) {
		case 'A':
		case 'C':
			return FileChangeType.Added;
		case 'D':
			return FileChangeType.Deleted;
		case 'R':
			return FileChangeType.Renamed;
		default:
			// M, T (type change) and anything newer git invents.
			return FileChangeType.Modified;
	}
}

/**
 * Parses `--name-status -z`: a status field, then one path, or two for renames
 * and copies (`R100\0old\0new\0`).
 */
export function parseNameStatus(stdout: string): { type: FileChangeType; path: string; oldPath: string | null }[] {
	const fields = stdout.split('\0');
	const result: { type: FileChangeType; path: string; oldPath: string | null }[] = [];
	let i = 0;
	while (i < fields.length) {
		const status = fields[i].replace(/^\n/, '');
		if (status === '') {
			i++;
			continue;
		}
		const letter = status[0];
		if (letter === 'R' || letter === 'C') {
			if (i + 2 >= fields.length) break;
			result.push({ type: statusType(letter), oldPath: fields[i + 1], path: fields[i + 2] });
			i += 3;
		} else {
			if (i + 1 >= fields.length) break;
			result.push({ type: statusType(letter), oldPath: null, path: fields[i + 1] });
			i += 2;
		}
	}
	return result;
}

/**
 * Parses `--numstat -z` into line counts keyed by (new) path. Binary files
 * report `-` for both counts and map to null. A rename is written as
 * `add\tdel\t\0old\0new\0` — the empty third column says the paths follow.
 */
export function parseNumstat(stdout: string): Map<string, { additions: number | null; deletions: number | null }> {
	const counts = new Map<string, { additions: number | null; deletions: number | null }>();
	const fields = stdout.split('\0');
	let i = 0;
	while (i < fields.length) {
		const field = fields[i].replace(/^\n/, '');
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
		if (match === null) {
			i++;
			continue;
		}
		const value = {
			additions: match[1] === '-' ? null : parseInt(match[1], 10),
			deletions: match[2] === '-' ? null : parseInt(match[2], 10)
		};
		if (match[3] === '') {
			counts.set(fields[i + 2] ?? '', value);
			i += 3;
		} else {
			counts.set(match[3], value);
			i += 1;
		}
	}
	return counts;
}

function combine(nameStatus: string, numstat: string): FileChange[] {
	const counts = parseNumstat(numstat);
	return parseNameStatus(nameStatus).map((entry) => ({
		...entry,
		additions: counts.get(entry.path)?.additions ?? null,
		deletions: counts.get(entry.path)?.deletions ?? null
	}));
}

/** Files changed by a commit (against `base`), or in the working tree when `hash` is `UNCOMMITTED`. */
export async function readChanges(git: GitExecutor, target: ChangeTarget, includeUntracked = true): Promise<FileChange[]> {
	if (target.hash === UNCOMMITTED) return readUncommittedChanges(git, target.repo, target.base, includeUntracked);

	const range = target.base === null ? ['--root', target.hash] : [target.base, target.hash];
	const [nameStatus, numstat] = await Promise.all([
		git.run(target.repo, ['diff-tree', '-r', '--no-commit-id', ...DIFF_FLAGS, '--name-status', ...range]),
		git.run(target.repo, ['diff-tree', '-r', '--no-commit-id', ...DIFF_FLAGS, '--numstat', ...range])
	]);
	return sortChanges(combine(nameStatus, numstat));
}

/**
 * Changes in the index and working tree together, against `base` (HEAD), plus
 * untracked files — i.e. everything that would be lost by a hard reset.
 */
async function readUncommittedChanges(git: GitExecutor, repo: string, base: Hash | null, includeUntracked: boolean): Promise<FileChange[]> {
	const against = base ?? 'HEAD';
	const [nameStatus, numstat, untracked] = await Promise.all([
		git.run(repo, ['diff', ...DIFF_FLAGS, '--name-status', against]),
		git.run(repo, ['diff', ...DIFF_FLAGS, '--numstat', against]),
		includeUntracked ? git.run(repo, ['ls-files', '--others', '--exclude-standard', '-z']) : Promise.resolve('')
	]);
	const changes = combine(nameStatus, numstat);
	for (const path of untracked.split('\0')) {
		if (path !== '') changes.push({ type: FileChangeType.Untracked, path, oldPath: null, additions: null, deletions: null });
	}
	return sortChanges(changes);
}

/** Orders by path, the way a file tree reads, so the list is stable between loads. */
function sortChanges(changes: FileChange[]): FileChange[] {
	return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Reads a file's bytes at a revision, exactly as stored, or null when the file
 * does not exist there. Bytes rather than text, so binary files and notebooks
 * reach VS Code untouched and it can pick the right editor for them.
 */
export async function readBlobAtRevision(git: GitExecutor, repo: string, revision: Hash, path: string): Promise<Buffer | null> {
	try {
		return await git.runBinary(repo, ['show', '--no-textconv', `${revision}:${path}`]);
	} catch {
		return null;
	}
}

/**
 * The content of the missing side of a diff (an added or deleted file).
 * Normally nothing; but a notebook must parse as one, or VS Code's notebook
 * diff (#598) refuses to open and falls back to raw JSON.
 */
export function emptySideContent(path: string): string {
	if (path.toLowerCase().endsWith('.ipynb')) return JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
	return '';
}
