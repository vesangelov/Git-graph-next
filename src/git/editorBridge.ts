import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Decides what happens to a file git wants edited. Resolves to true when git
 * should continue with the file as it is now on disk, false to cancel.
 */
export type EditHandler = (file: string) => Promise<boolean>;

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
		private readonly command: string
	) {}

	/**
	 * Starts listening. `script` is the bundled editor client; `node` the
	 * runtime to run it with — in VS Code, its own binary in Node mode.
	 */
	static async start(script: string, node: string, handler: EditHandler): Promise<EditorBridge> {
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
		return new EditorBridge(server, socketPath, token, `${quote(node)} ${quote(script)}`);
	}

	/**
	 * Environment for a git command whose editors should open in VS Code.
	 * `GIT_SEQUENCE_EDITOR` is the todo list, `GIT_EDITOR` commit messages.
	 */
	environment(): Record<string, string> {
		return {
			GIT_EDITOR: this.command,
			GIT_SEQUENCE_EDITOR: this.command,
			ELECTRON_RUN_AS_NODE: '1',
			GIT_GRAPH_NEXT_EDITOR_SOCKET: this.socketPath,
			GIT_GRAPH_NEXT_EDITOR_TOKEN: this.token
		};
	}

	dispose(): void {
		this.server.close();
		if (process.platform !== 'win32') rmSync(this.socketPath, { force: true });
	}
}

function serve(socket: Socket, token: string, handler: EditHandler): void {
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

async function answer(socket: Socket, line: string, token: string, handler: EditHandler): Promise<void> {
	let ok = false;
	try {
		const request = JSON.parse(line) as { file?: unknown; token?: unknown };
		if (request.token === token && typeof request.file === 'string') ok = await handler(request.file);
	} catch {
		ok = false;
	}
	if (!socket.destroyed) socket.end(`${JSON.stringify({ ok })}\n`);
}
