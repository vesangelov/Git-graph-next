import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

/**
 * The slice of `vscode.CancellationToken` this module needs.
 *
 * Declaring it structurally keeps the git layer free of a `vscode` import, so
 * it can be exercised by tests that run in plain Node — the layer where format
 * drift between git versions actually bites.
 */
export interface CancellationLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Raised when a command is abandoned because its token was cancelled. */
export class CancelledError extends Error {
	constructor() {
		super('The git command was cancelled');
		this.name = 'CancelledError';
	}
}

/** Thrown when git exits non-zero, carrying enough context to show the user. */
export class GitError extends Error {
	constructor(
		message: string,
		readonly exitCode: number | null,
		readonly args: readonly string[],
		readonly stderr: string
	) {
		super(message);
		this.name = 'GitError';
	}
}

export interface GitVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly raw: string;
}

export interface RunOptions {
	/** Extra environment entries merged over the base environment. */
	readonly env?: Readonly<Record<string, string>>;
	/** Text written to git's stdin, then closed. */
	readonly stdin?: string;
	/** Resolve with the output even when git exits non-zero. */
	readonly ignoreExitCode?: boolean;
	readonly token?: CancellationLike;
}

/**
 * Compares two git versions. Returns a negative number when `a` is older.
 * Used to gate arguments that older git binaries reject outright.
 */
export function compareVersions(a: GitVersion, b: { major: number; minor: number; patch?: number }): number {
	return a.major - b.major || a.minor - b.minor || a.patch - (b.patch ?? 0);
}

function parseVersion(raw: string): GitVersion | null {
	// `git version 2.43.0`, `git version 2.39.3 (Apple Git-145)`,
	// `git version 2.45.1.windows.1` — take the first three numeric fields.
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
	if (match === null) return null;
	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: match[3] !== undefined ? parseInt(match[3], 10) : 0,
		raw: raw.trim()
	};
}

/**
 * Runs git commands for a single repository.
 *
 * Output is streamed and concatenated rather than collected by `exec`, so a
 * `git log` over a repository with hundreds of thousands of commits cannot
 * overflow a fixed buffer and truncate the graph.
 */
export class GitExecutor {
	private constructor(
		readonly binary: string,
		readonly version: GitVersion
	) {}

	/**
	 * Resolves the git binary to use, trying each candidate path in turn.
	 * Rejects with a user-facing message when none of them run.
	 */
	static async locate(candidates: readonly string[]): Promise<GitExecutor> {
		const failures: string[] = [];
		for (const candidate of candidates) {
			try {
				const output = await runRaw(candidate, ['--version'], process.cwd(), {});
				const version = parseVersion(output.stdout);
				if (version === null) {
					failures.push(`${candidate}: unrecognised version string "${output.stdout.trim()}"`);
					continue;
				}
				// 2.17 is the oldest git with everything the actions use
				// (`stash push`, `merge --continue`, `fetch --prune-tags`, …).
				if (compareVersions(version, { major: 2, minor: 17 }) < 0) {
					failures.push(`${candidate}: git ${version.raw} is too old, 2.17.0 or later is required`);
					continue;
				}
				return new GitExecutor(candidate, version);
			} catch (error) {
				failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(
			'Git Graph Next could not find a usable git executable. Set "git-graph-next.git.path" to its location.\n' +
				failures.map((f) => `  • ${f}`).join('\n')
		);
	}

	/** True when the binary is at least the given version. */
	atLeast(major: number, minor: number, patch = 0): boolean {
		return compareVersions(this.version, { major, minor, patch }) >= 0;
	}

	/** Runs git in `cwd` and resolves with stdout as UTF-8 text. */
	async run(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
		const result = await runRaw(this.binary, args, cwd, options);
		if (result.code !== 0 && options.ignoreExitCode !== true) {
			// Some failures are reported on stdout alone — a merge conflict's
			// "CONFLICT … Automatic merge failed" is — so fall back to it rather
			// than telling the user only the exit code.
			const message = cleanStderr(result.stderr) || cleanStderr(result.stdout) || `git exited with code ${result.code}`;
			throw new GitError(message, result.code, args, result.stderr);
		}
		return result.stdout;
	}

	/**
	 * Runs git and resolves with raw stdout bytes, for content that is not
	 * necessarily valid UTF-8 (`git show` of a binary blob, for example).
	 */
	async runBinary(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
		const result = await runRaw(this.binary, args, cwd, { ...options, binary: true });
		if (result.code !== 0 && options.ignoreExitCode !== true) {
			throw new GitError(cleanStderr(result.stderr) || `git exited with code ${result.code}`, result.code, args, result.stderr);
		}
		return result.stdoutBuffer;
	}

	/** Runs git and resolves to null instead of throwing when it fails. */
	async runOrNull(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<string | null> {
		try {
			return await this.run(cwd, args, options);
		} catch {
			return null;
		}
	}
}

/** Strips the noise git prefixes onto most errors, leaving the useful sentence. */
function cleanStderr(stderr: string): string {
	return stderr
		.split('\n')
		.map((line) => line.replace(/^(?:error|fatal):\s*/i, '').trim())
		.filter((line) => line.length > 0)
		.join('\n')
		.trim();
}

interface RawResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stdoutBuffer: Buffer;
	readonly stderr: string;
}

function runRaw(
	binary: string,
	args: readonly string[],
	cwd: string,
	options: RunOptions & { binary?: boolean }
): Promise<RawResult> {
	return new Promise<RawResult>((resolve, reject) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(binary, args as string[], {
				cwd,
				env: buildEnvironment(options.env),
				windowsHide: true
			});
		} catch (error) {
			reject(new Error(`failed to spawn "${binary}": ${error instanceof Error ? error.message : String(error)}`));
			return;
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cancellation?.dispose();
			fn();
		};

		const cancellation = options.token?.onCancellationRequested(() => {
			child.kill('SIGTERM');
			finish(() => reject(new CancelledError()));
		});

		child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

		child.on('error', (error) => {
			// ENOENT here means the binary does not exist; surface it verbatim so
			// `locate` can report which candidate failed and why.
			finish(() => reject(error));
		});

		child.on('close', (code) => {
			const stdoutBuffer = Buffer.concat(stdoutChunks);
			finish(() =>
				resolve({
					code,
					stdout: options.binary === true ? '' : stdoutBuffer.toString('utf8'),
					stdoutBuffer,
					stderr: Buffer.concat(stderrChunks).toString('utf8')
				})
			);
		});

		if (options.stdin !== undefined) {
			child.stdin.on('error', () => {
				/* git can exit before reading stdin; EPIPE here is not an error. */
			});
			child.stdin.end(options.stdin, 'utf8');
		} else {
			child.stdin.end();
		}
	});
}

function buildEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
	return {
		...process.env,
		// Never wait for an editor that cannot be seen: accept the default
		// message. The sequence editor must be set too, or a `sequence.editor`
		// in the user's config (which beats GIT_EDITOR) would open a terminal
		// editor with no terminal. Callers that provide an editor override both.
		GIT_EDITOR: 'true',
		GIT_SEQUENCE_EDITOR: 'true',
		...extra,
		// Keep git's own messages and date formatting predictable for parsing,
		// while leaving user content (commit messages, paths) untouched.
		LC_ALL: 'C',
		LANG: 'C',
		// Read-only commands must not take index.lock, otherwise refreshing the
		// graph fights with VS Code's built-in Git extension over the same file.
		GIT_OPTIONAL_LOCKS: '0',
		// Never block on an interactive credential or passphrase prompt: a
		// hidden prompt leaves the extension hanging with no way to answer it.
		GIT_TERMINAL_PROMPT: '0',
		GIT_PAGER: 'cat',
		PAGER: 'cat'
	};
}
