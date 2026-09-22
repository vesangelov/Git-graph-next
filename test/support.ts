/**
 * Shared setup for the tests that run real git.
 *
 * Two things make the difference between platforms:
 *
 *  - Git must not read the machine's own configuration, or a setting such as
 *    `core.autocrlf` (on by default on Windows CI) changes what git writes and
 *    reads. `/dev/null` is not a valid path on Windows, so an empty file is
 *    used instead, for the tests' own commands *and* for the code under test.
 *  - On macOS the temporary directory is reached through a symlink
 *    (`/var` → `/private/var`), and git reports the resolved path; expected
 *    paths have to be resolved the same way.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** An empty git config file, so no machine or user setting reaches the tests. */
export const EMPTY_CONFIG = join(mkdtempSync(join(tmpdir(), 'ggn-config-')), 'gitconfig');
writeFileSync(EMPTY_CONFIG, '');

/** Environment for running git in a test, with the machine's configuration out of the way. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...process.env, LC_ALL: 'C', GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_SYSTEM: EMPTY_CONFIG, ...extra };
}

/** The same environment, for `GitExecutor.run({ env })`, which merges over its own. */
export function gitRunEnv(extra: Record<string, string> = {}): Record<string, string> {
	return { GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_SYSTEM: EMPTY_CONFIG, ...extra };
}

/** The path as git reports it: symlinks resolved (macOS temporary directories). */
export function realPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * Creates a repository whose behaviour does not depend on the machine: an
 * identity to commit with, no signing, and no line-ending rewriting.
 */
export function initTestRepo(path: string, branch = 'main'): string {
	execFileSync('git', ['init', '-q', '-b', branch, path], { env: gitEnv() });
	for (const [key, value] of [
		['user.email', 'test@example.com'],
		['user.name', 'Test'],
		['commit.gpgsign', 'false'],
		['tag.gpgsign', 'false'],
		['core.autocrlf', 'false']
	]) {
		execFileSync('git', ['config', key, value], { cwd: path, env: gitEnv() });
	}
	return path;
}
