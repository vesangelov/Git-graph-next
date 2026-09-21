import * as vscode from 'vscode';
import { isAbsolute, relative } from 'node:path';
import type { GitExecutor } from './git/executor.ts';
import { dedupePaths, discoverRepositories, findEnclosingRepository, normaliseRepoPath, repositoryInfo, type RepositoryInfo } from './git/repository.ts';
import { maxDepthOfRepoSearch } from './config.ts';

/**
 * The slice of the built-in Git extension's API (`vscode.git`, API version 1)
 * used here, declared structurally. Only documented members are relied upon,
 * and every one is treated as possibly absent: VSCodium, remote hosts and a
 * disabled Git extension all expose less than the desktop build (#863).
 */
interface GitRepositoryLike {
	readonly rootUri?: vscode.Uri | null;
}
interface GitApiLike {
	readonly state?: 'uninitialized' | 'initialized';
	readonly onDidChangeState?: vscode.Event<string>;
	readonly repositories?: readonly (GitRepositoryLike | null | undefined)[];
	readonly onDidOpenRepository?: vscode.Event<GitRepositoryLike>;
	readonly onDidCloseRepository?: vscode.Event<GitRepositoryLike>;
}
interface GitExtensionLike {
	readonly enabled?: boolean;
	getAPI?(version: 1): GitApiLike;
}

const ADDED_KEY = 'gitGraphNext.addedRepositories';
const REMOVED_KEY = 'gitGraphNext.removedRepositories';

/**
 * Keeps the list of repositories the graph can show.
 *
 * Three sources are merged: the built-in Git extension (which knows about
 * repositories opened in ways a scan would miss), a scan of the workspace
 * folders, and repositories the user added by hand. The Git extension is a
 * source, never a requirement — the scan alone must produce a working list.
 */
export class RepoManager implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	private readonly disposables: vscode.Disposable[] = [this.changed];
	private gitApi: GitApiLike | null = null;
	private scanned: string[] = [];
	private list: RepositoryInfo[] = [];
	private rescanTimer: ReturnType<typeof setTimeout> | undefined;
	private scanGeneration = 0;

	constructor(
		private readonly git: GitExecutor,
		private readonly state: vscode.Memento
	) {}

	get repositories(): readonly RepositoryInfo[] {
		return this.list;
	}

	async initialise(): Promise<void> {
		await this.connectGitExtension();
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRescan()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-graph-next.maxDepthOfRepoSearch')) this.scheduleRescan();
			})
		);
		await this.rescan();
	}

	/**
	 * The repository containing a file, or null. When repositories nest, the
	 * innermost one wins, as that is the one whose history the file is in.
	 */
	repositoryFor(fsPath: string): RepositoryInfo | null {
		const target = normaliseRepoPath(fsPath);
		let best: RepositoryInfo | null = null;
		for (const repo of this.list) {
			const rel = relative(normaliseRepoPath(repo.path), target);
			const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
			if (inside && (best === null || repo.path.length > best.path.length)) best = repo;
		}
		return best;
	}

	/** Adds a repository by hand. Resolves to its root, or null when it is not one. */
	async add(folder: string): Promise<RepositoryInfo | null> {
		const root = await findEnclosingRepository(this.git, folder);
		if (root === null) return null;
		const key = normaliseRepoPath(root);
		await this.state.update(ADDED_KEY, dedupePaths([...this.stored(ADDED_KEY), root]));
		await this.state.update(REMOVED_KEY, this.stored(REMOVED_KEY).filter((p) => normaliseRepoPath(p) !== key));
		this.rebuild();
		return repositoryInfo(root);
	}

	/** Hides a repository until it is added again, whichever source reported it. */
	async remove(path: string): Promise<void> {
		const key = normaliseRepoPath(path);
		await this.state.update(ADDED_KEY, this.stored(ADDED_KEY).filter((p) => normaliseRepoPath(p) !== key));
		await this.state.update(REMOVED_KEY, dedupePaths([...this.stored(REMOVED_KEY), path]));
		this.rebuild();
	}

	dispose(): void {
		clearTimeout(this.rescanTimer);
		for (const disposable of this.disposables) disposable.dispose();
	}

	private stored(key: string): string[] {
		const value = this.state.get<unknown>(key);
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
	}

	private async connectGitExtension(): Promise<void> {
		try {
			const extension = vscode.extensions.getExtension<GitExtensionLike>('vscode.git');
			if (extension === undefined) return;
			const exports = extension.isActive ? extension.exports : await extension.activate();
			if (exports?.enabled === false || typeof exports?.getAPI !== 'function') return;
			const api = exports.getAPI(1);
			this.gitApi = api;
			const refresh = () => this.rebuild();
			for (const event of [api.onDidOpenRepository, api.onDidCloseRepository, api.onDidChangeState]) {
				if (typeof event === 'function') this.disposables.push(event(refresh));
			}
		} catch {
			// The Git extension is optional; the workspace scan still works.
			this.gitApi = null;
		}
	}

	/** Repositories the Git extension currently reports, skipping any without a root (#794). */
	private gitExtensionRepositories(): string[] {
		const repositories = this.gitApi?.repositories ?? [];
		const paths: string[] = [];
		for (const repository of repositories) {
			const root = repository?.rootUri;
			if (root !== null && root !== undefined && root.scheme === 'file') paths.push(root.fsPath);
		}
		return paths;
	}

	private scheduleRescan(): void {
		clearTimeout(this.rescanTimer);
		this.rescanTimer = setTimeout(() => void this.rescan(), 300);
	}

	private async rescan(): Promise<void> {
		const generation = ++this.scanGeneration;
		const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
		const found = await discoverRepositories(this.git, folders, maxDepthOfRepoSearch());
		// A newer scan started while this one ran; its result supersedes ours.
		if (generation !== this.scanGeneration) return;
		this.scanned = found;
		this.rebuild();
	}

	private rebuild(): void {
		const removed = new Set(this.stored(REMOVED_KEY).map(normaliseRepoPath));
		const paths = dedupePaths([...this.scanned, ...this.gitExtensionRepositories(), ...this.stored(ADDED_KEY)])
			.filter((path) => !removed.has(normaliseRepoPath(path)));
		const next = paths.map(repositoryInfo).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

		const same = next.length === this.list.length && next.every((repo, i) => repo.path === this.list[i].path);
		if (same) return;
		this.list = next;
		this.changed.fire();
	}
}
