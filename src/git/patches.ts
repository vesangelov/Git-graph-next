import type { GitExecutor } from './executor.ts';
import type { Hash } from '../types.ts';

/**
 * A file name in the style of `git format-patch`: a four-digit sequence
 * number and the subject reduced to letters, digits and single dashes.
 */
export function patchFileName(sequence: number, subject: string): string {
	const slug = subject
		.normalize('NFKD')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 52)
		.replace(/-+$/, '');
	return `${String(sequence).padStart(4, '0')}-${slug === '' ? 'patch' : slug}.patch`;
}

/** One commit as a mailbox-format patch, as `git am` applies it. */
export async function commitPatch(git: GitExecutor, repo: string, hash: Hash): Promise<Buffer> {
	return git.runBinary(repo, ['format-patch', '-1', '--stdout', '--binary', hash]);
}

/** The subject of a commit, for naming its patch file. */
export async function commitSubject(git: GitExecutor, repo: string, hash: Hash): Promise<string> {
	return (await git.run(repo, ['log', '-1', '--format=%s', hash])).trim();
}

/** Staged and unstaged changes to tracked files, as one diff (`git apply` applies it). */
export async function uncommittedPatch(git: GitExecutor, repo: string): Promise<Buffer> {
	return git.runBinary(repo, ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD']);
}

/**
 * Applies patch files: to the working tree (`git apply`), or as commits
 * (`git am`, for patches made with `format-patch`). The files are paths the
 * user picked, never text from the view.
 */
export async function applyPatches(git: GitExecutor, repo: string, files: readonly string[], mode: 'apply' | 'am', threeWay: boolean): Promise<void> {
	const three = threeWay ? ['--3way'] : [];
	await git.run(repo, mode === 'am' ? ['am', ...three, ...files] : ['apply', ...three, ...files]);
}
