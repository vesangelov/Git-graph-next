import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** What git asked for: a file to edit, or a password to type. */
export interface BridgeRequest {
	readonly kind: 'edit' | 'prompt';
	/** The file to edit, or the prompt git printed. */
	readonly value: string;
}

/**
 * Answers a request: `ok` false cancels (git aborts, or fails the
 * authentication); for a prompt, `value` is what git reads as the answer.
 */
export type BridgeHandler = (request: BridgeRequest) => Promise<{ ok: boolean; value?: string }>;

/**
 * The extension's end of the editor protocol (see src/editor/client.ts): a
 * local socket that git's editor script connects to, one connection per file.
 *
 * Every request must carry this session's random token, so another local
 * process that finds the socket cannot use it to open files in the editor.
 */
export class EditorBridge {
	private constructor(
		private readonly server: Server,
		readonly socketPath: string,
		private readonly token: string,
		private readonly command: string,
		private readonly node: string,
		private readonly script: string,
		private readonly askpassFile: string | null
	) {}

	/**
	 * Starts listening. `script` is the bundled editor client; `node` the
	 * runtime to run it with — in VS Code, its own binary in Node mode.
	 */
	static async start(script: string, node: string, handler: BridgeHandler, askpassScript?: string): Promise<EditorBridge> {
		const id = randomBytes(8).toString('hex');
		const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\git-graph-next-editor-${id}` : join(tmpdir(), `git-graph-next-editor-${id}.sock`);
		const token = randomBytes(24).toString('hex');

		const server = createServer((socket) => serve(socket, token, handler));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(socketPath, () => {
				server.off('error', reject);
				resolve();
			});
		});
		// git runs the editor through a POSIX shell (also on Windows, where Git
		// for Windows brings sh), so single quotes are the safe quoting.
		const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

		// Unlike the editor, git and ssh run the askpass program directly, with
		// no shell: it has to be an executable file, not a command line. A shell
		// script works on Windows too — git reads the shebang and runs it with
		// the `sh` it ships with.
		let askpassFile: string | null = null;
		if (askpassScript !== undefined) {
			try {
				mkdirSync(dirname(askpassScript), { recursive: true });
				writeFileSync(askpassScript, '#!/bin/sh\nexec "$GIT_GRAPH_NEXT_NODE" "$GIT_GRAPH_NEXT_SCRIPT" --askpass "$@"\n', { mode: 0o700 });
				if (process.platform !== 'win32') chmodSync(askpassScript, 0o700);
				askpassFile = askpassScript;
			} catch {
				askpassFile = null;
			}
		}
		return new EditorBridge(server, socketPath, token, `${quote(node)} ${quote(script)}`, node, script, askpassFile);
	}

	/**
	 * Environment for a git command whose editors should open in VS Code.
	 * `GIT_SEQUENCE_EDITOR` is the todo list, `GIT_EDITOR` commit messages.
	 */
	environment(): Record<string, string> {
		return {
			GIT_EDITOR: `${this.command} --editor`,
			GIT_SEQUENCE_EDITOR: `${this.command} --editor`,
			...this.common()
		};
	}

	/**
	 * Environment that lets git and ssh ask for passwords and passphrases in
	 * VS Code (#755, #813). Empty when the helper could not be written; git
	 * then fails with "terminal prompts disabled" and the view offers to run
	 * the command in a terminal instead.
	 */
	askpassEnvironment(): Record<string, string> {
		if (this.askpassFile === null) return {};
		return {
			GIT_ASKPASS: this.askpassFile,
			SSH_ASKPASS: this.askpassFile,
			// ssh asks the program only when it has no terminal; `force` makes it
			// ask regardless, which is what is needed inside an editor.
			SSH_ASKPASS_REQUIRE: 'force',
			...this.common()
		};
	}

	private common(): Record<string, string> {
		return {
			ELECTRON_RUN_AS_NODE: '1',
			GIT_GRAPH_NEXT_NODE: this.node,
			GIT_GRAPH_NEXT_SCRIPT: this.script,
			GIT_GRAPH_NEXT_EDITOR_SOCKET: this.socketPath,
			GIT_GRAPH_NEXT_EDITOR_TOKEN: this.token
		};
	}

	dispose(): void {
		this.server.close();
		if (process.platform !== 'win32') rmSync(this.socketPath, { force: true });
		if (this.askpassFile !== null) rmSync(this.askpassFile, { force: true });
	}
}

function serve(socket: Socket, token: string, handler: BridgeHandler): void {
	let buffer = '';
	socket.setEncoding('utf8');
	socket.on('error', () => socket.destroy());
	socket.on('data', (chunk: string) => {
		buffer += chunk;
		const end = buffer.indexOf('\n');
		if (end === -1) {
			if (buffer.length > 64 * 1024) socket.destroy();
			return;
		}
		const line = buffer.slice(0, end);
		buffer = '';
		void answer(socket, line, token, handler);
	});
}

async function answer(socket: Socket, line: string, token: string, handler: BridgeHandler): Promise<void> {
	let reply: { ok: boolean; value?: string } = { ok: false };
	try {
		const request = JSON.parse(line) as { kind?: unknown; value?: unknown; token?: unknown };
		if (request.token === token && (request.kind === 'edit' || request.kind === 'prompt') && typeof request.value === 'string') {
			reply = await handler({ kind: request.kind, value: request.value });
		}
	} catch {
		reply = { ok: false };
	}
	if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
}
