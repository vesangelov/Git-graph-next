import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { GitExecutor } from '../git/executor.ts';
import { readChanges } from '../git/changes.ts';
import { FileChangeType, UNCOMMITTED, type ChangeTarget, type FileChange } from '../types.ts';
import { showUntrackedFiles } from '../config.ts';

export const CHANGES_VIEW_ID = 'gitGraphNext.changesView';

/** Scheme of the tree items' resource URIs; exists only to carry a file decoration. */
const CHANGE_SCHEME = 'git-graph-next-change';

/** Committed changes never change, so they are cached; a handful covers flicking between rows. */
const CACHE_SIZE = 50;

const STATUS: Record<FileChangeType, { label: string; colour: string }> = {
	[FileChangeType.Added]: { label: 'Added', colour: 'gitDecoration.addedResourceForeground' },
	[FileChangeType.Modified]: { label: 'Modified', colour: 'gitDecoration.modifiedResourceForeground' },
	[FileChangeType.Deleted]: { label: 'Deleted', colour: 'gitDecoration.deletedResourceForeground' },
	[FileChangeType.Renamed]: { label: 'Renamed', colour: 'gitDecoration.renamedResourceForeground' },
	[FileChangeType.Untracked]: { label: 'Untracked', colour: 'gitDecoration.untrackedResourceForeground' }
};

export class ChangeItem extends vscode.TreeItem {
	constructor(
		readonly target: ChangeTarget,
		readonly change: FileChange
	) {
		super(vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${change.path}`, query: change.type }));
		const dir = posix.dirname(change.path);
		const parts: string[] = [];
		if (dir !== '.') parts.push(dir);
		if (change.oldPath !== null) parts.push(`← ${posix.basename(change.oldPath)}`);
		if (change.additions !== null && change.deletions !== null) parts.push(`+${change.additions} −${change.deletions}`);
		this.label = posix.basename(change.path);
		this.description = parts.join('  ');
		this.tooltip = `${change.path}${change.oldPath !== null ? `\nRenamed from ${change.oldPath}` : ''}\n${STATUS[change.type].label}`;
		this.contextValue = change.type === FileChangeType.Deleted ? 'change.deleted' : 'change';
		this.command = { command: 'gitGraphNext.openChangeDiff', title: 'Open Changes', arguments: [this] };
	}
}

/** Colours each changed file and badges it with its status letter, as the Source Control view does. */
class ChangeDecorations implements vscode.FileDecorationProvider {
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== CHANGE_SCHEME) return undefined;
		const status = STATUS[uri.query as FileChangeType];
		if (status === undefined) return undefined;
		return new vscode.FileDecoration(uri.query, status.label, new vscode.ThemeColor(status.colour));
	}
}

/**
 * Loads the files changed by a commit, and shows the most recently selected
 * commit's files in the sidebar Changes view. Both graph views (panel and
 * sidebar) report their selection here, so the view follows whichever the
 * user touched last.
 */
export class ChangesService implements vscode.TreeDataProvider<ChangeItem>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	private readonly treeView: vscode.TreeView<ChangeItem>;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly cache = new Map<string, readonly FileChange[]>();
	private items: ChangeItem[] = [];
	private generation = 0;

	constructor(private readonly git: GitExecutor) {
		this.treeView = vscode.window.createTreeView(CHANGES_VIEW_ID, { treeDataProvider: this, showCollapseAll: false });
		this.treeView.message = 'Select a commit in the graph to see the files it changed.';
		this.disposables.push(this.treeView, this.changed, vscode.window.registerFileDecorationProvider(new ChangeDecorations()));
	}

	getTreeItem(item: ChangeItem): vscode.TreeItem {
		return item;
	}

	getChildren(item?: ChangeItem): ChangeItem[] {
		return item === undefined ? this.items : [];
	}

	/** Loads a commit's changes, from the cache when possible. Uncommitted changes are always re-read. */
	async load(target: ChangeTarget): Promise<readonly FileChange[]> {
		const key = `${target.repo}\0${target.base ?? ''}\0${target.hash}`;
		const cached = this.cache.get(key);
		if (cached !== undefined) return cached;

		const changes = await readChanges(this.git, target, showUntrackedFiles());
		if (target.hash !== UNCOMMITTED) {
			this.cache.set(key, changes);
			if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
		}
		return changes;
	}

	/**
	 * Selects a commit: shows its files in the Changes view and resolves to
	 * them, or rejects with the git error (which the view also shows).
	 */
	async select(target: ChangeTarget, title: string): Promise<readonly FileChange[]> {
		const generation = ++this.generation;
		this.treeView.description = title;
		try {
			const changes = await this.load(target);
			if (generation === this.generation) {
				this.items = changes.map((change) => new ChangeItem(target, change));
				this.treeView.message = changes.length === 0 ? 'This commit changes no files.' : undefined;
				this.changed.fire();
			}
			return changes;
		} catch (error) {
			if (generation === this.generation) {
				this.items = [];
				this.treeView.message = error instanceof Error ? error.message : String(error);
				this.changed.fire();
			}
			throw error;
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) disposable.dispose();
	}
}
