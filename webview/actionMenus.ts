import { PendingOperation, UNCOMMITTED, type Commit, type GitAction, type GraphData } from '../src/types.ts';
import type { ViewConfig } from '../src/view/protocol.ts';
import type { Dialog, DialogField, DialogSpec, DialogValues } from './dialog.ts';
import { shortHash } from './format.ts';
import type { MenuItem } from './menu.ts';
import type { RefLabel } from './render/table.ts';

/** What the action menus need from the view. */
export interface ActionContext {
	readonly data: GraphData;
	readonly config: ViewConfig;
	readonly dialog: Dialog;
	/** Runs an action on the host; resolves to an error message or null. */
	run(action: GitAction): Promise<string | null>;
}

/** Runs an action with no dialog; a failure is shown in a message box. */
export async function runNow(ctx: ActionContext, action: GitAction, what: string): Promise<void> {
	const error = await ctx.run(action);
	if (error !== null) ctx.dialog.alert(`${what} failed`, error);
}

const text = (values: DialogValues, id: string) => String(values[id] ?? '').trim();
const flag = (values: DialogValues, id: string) => values[id] === true;

/** Opens a dialog whose confirmation runs the action built from its values. */
function ask(ctx: ActionContext, spec: DialogSpec, build: (values: DialogValues) => GitAction): void {
	ctx.dialog.open(spec, (values) => ctx.run(build(values)));
}

function remoteField(ctx: ActionContext, id: string, label: string, preferred: string | null, allowNone: boolean): DialogField {
	const options = [...(allowNone ? [{ value: '', label: 'Do not push' }] : []), ...ctx.data.remotes.map((r) => ({ value: r, label: r }))];
	const value = preferred !== null && ctx.data.remotes.includes(preferred) ? preferred : allowNone ? '' : (ctx.data.remotes.includes('origin') ? 'origin' : ctx.data.remotes[0]);
	return { type: 'select', id, label, options, value };
}

/** For merge commits: which parent is the mainline (`-m`), as cherry-pick and revert need. */
function mainlineField(commit: Commit): DialogField[] {
	if (commit.parents.length < 2) return [];
	return [
		{
			type: 'select',
			id: 'mainline',
			label: 'Parent to use as mainline',
			options: commit.parents.map((parent, i) => ({ value: String(i + 1), label: `${i + 1}: ${shortHash(parent)}${i === 0 ? ' (the branch merged into)' : ''}` })),
			value: '1'
		}
	];
}

const mainline = (commit: Commit, values: DialogValues) => (commit.parents.length < 2 ? null : Number(values.mainline) || 1);

/** Actions on a commit row. */
export function commitActions(ctx: ActionContext, commit: Commit): MenuItem[] {
	if (commit.hash === UNCOMMITTED) return uncommittedActions(ctx);
	if (commit.stash !== null) return stashActions(ctx, commit);

	const hash = commit.hash;
	const short = shortHash(hash);
	const current = ctx.data.repo.head;
	const isHead = hash === ctx.data.repo.headHash;
	const items: MenuItem[] = [
		{
			label: 'Create Branch…',
			action: () =>
				ask(
					ctx,
					{
						title: `Create branch at ${short}`,
						fields: [
							{ type: 'text', id: 'name', label: 'Name', required: true, placeholder: 'feature/my-change' },
							{ type: 'checkbox', id: 'checkout', label: 'Check out the new branch' }
						],
						confirm: 'Create Branch'
					},
					(v) => ({ kind: 'createBranch', name: text(v, 'name'), startPoint: hash, checkout: flag(v, 'checkout'), force: false })
				)
		},
		{
			label: 'Create Tag…',
			action: () =>
				ask(
					ctx,
					{
						title: `Create tag at ${short}`,
						fields: [
							{ type: 'text', id: 'name', label: 'Name', required: true, placeholder: 'v1.0.0' },
							{ type: 'text', id: 'message', label: 'Message (leave empty for a lightweight tag)', multiline: true },
							remoteField(ctx, 'push', 'Push to', null, true)
						],
						confirm: 'Create Tag'
					},
					(v) => ({
						kind: 'createTag',
						name: text(v, 'name'),
						target: hash,
						message: text(v, 'message') === '' ? null : String(v.message),
						force: false,
						pushTo: text(v, 'push') === '' ? null : text(v, 'push')
					})
				)
		},
		{
			label: 'Check Out This Commit…',
			action: () =>
				ask(
					ctx,
					{
						title: `Check out ${short}`,
						message: 'HEAD will be detached at this commit: new commits will not belong to any branch until you create one.',
						confirm: 'Check Out'
					},
					() => ({ kind: 'checkoutDetached', hash })
				)
		},
		{ separator: true },
		{
			label: 'Cherry-pick…',
			action: () =>
				ask(
					ctx,
					{
						title: `Cherry-pick ${short} onto ${current ?? 'HEAD'}`,
						fields: [
							...mainlineField(commit),
							{ type: 'checkbox', id: 'origin', label: 'Record the original commit in the message (-x)' },
							{ type: 'checkbox', id: 'noCommit', label: 'Apply the changes without committing' }
						],
						confirm: 'Cherry-pick'
					},
					(v) => ({ kind: 'cherryPick', hash, mainline: mainline(commit, v), noCommit: flag(v, 'noCommit'), recordOrigin: flag(v, 'origin') })
				)
		},
		{
			label: 'Revert…',
			action: () =>
				ask(
					ctx,
					{
						title: `Revert ${short}`,
						message: 'A new commit will undo the changes this commit made.',
						fields: mainlineField(commit),
						confirm: 'Revert'
					},
					(v) => ({ kind: 'revert', hash, mainline: mainline(commit, v) })
				)
		}
	];

	if (current !== null && !isHead) {
		items.push(mergeItem(ctx, hash, short), rebaseItem(ctx, hash, short), {
			label: `Reset ${current} to This Commit…`,
			action: () =>
				ask(
					ctx,
					{
						title: `Reset ${current} to ${short}`,
						message: `Moves ${current} to this commit. Commits after it are no longer on the branch.`,
						fields: [
							{
								type: 'select',
								id: 'mode',
								label: 'Mode',
								options: [
									{ value: 'soft', label: 'Soft — keep all changes, staged' },
									{ value: 'mixed', label: 'Mixed — keep all changes, unstaged' },
									{ value: 'hard', label: 'Hard — discard all changes (cannot be undone)' }
								],
								value: 'mixed'
							}
						],
						confirm: 'Reset',
						danger: true
					},
					(v) => ({ kind: 'reset', hash, mode: (text(v, 'mode') as 'soft' | 'mixed' | 'hard') || 'mixed' })
				)
		});
	}
	return items;
}

function mergeItem(ctx: ActionContext, ref: string, name: string): MenuItem {
	const current = ctx.data.repo.head ?? 'HEAD';
	return {
		label: `Merge into ${current}…`,
		action: () =>
			ask(
				ctx,
				{
					title: `Merge ${name} into ${current}`,
					fields: [
						{ type: 'checkbox', id: 'noFF', label: 'Always create a merge commit (--no-ff)', value: true },
						{ type: 'checkbox', id: 'squash', label: 'Squash the changes into one uncommitted change (--squash)' },
						{ type: 'checkbox', id: 'noCommit', label: 'Merge without committing (--no-commit)' }
					],
					confirm: 'Merge'
				},
				(v) => ({ kind: 'merge', ref, noFastForward: flag(v, 'noFF'), squash: flag(v, 'squash'), noCommit: flag(v, 'noCommit') })
			)
	};
}

function rebaseItem(ctx: ActionContext, onto: string, name: string): MenuItem {
	const current = ctx.data.repo.head ?? 'HEAD';
	return {
		label: `Rebase ${current} onto ${name}…`,
		action: () =>
			ask(
				ctx,
				{
					title: `Rebase ${current} onto ${name}`,
					message: `The commits of ${current} that are not in ${name} are re-applied on top of it. Their hashes change; avoid this for commits already pushed and shared.`,
					confirm: 'Rebase'
				},
				() => ({ kind: 'rebase', onto })
			)
	};
}

/** Actions on a branch, tag or stash label. */
export function labelActions(ctx: ActionContext, label: RefLabel, commit: Commit): MenuItem[] {
	const current = ctx.data.repo.head;
	switch (label.kind) {
		case 'head': {
			const name = label.name;
			const head = ctx.data.heads.find((h) => h.name === name);
			const upstream = head?.upstream ?? null;
			const upstreamRemote = upstream !== null ? (ctx.data.remotes.find((r) => upstream.startsWith(`${r}/`)) ?? null) : null;
			const items: MenuItem[] = [];
			if (!label.current) {
				items.push({ label: `Check Out ${name}`, action: () => void runNow(ctx, { kind: 'checkout', branch: name }, 'Checkout') });
				if (current !== null) items.push(mergeItem(ctx, name, name), rebaseItem(ctx, name, name));
			}
			if (ctx.data.remotes.length > 0) {
				items.push({
					label: 'Push…',
					action: () =>
						ask(
							ctx,
							{
								title: `Push ${name}`,
								fields: [
									remoteField(ctx, 'remote', 'Remote', upstreamRemote, false),
									{ type: 'checkbox', id: 'upstream', label: 'Set as upstream (--set-upstream)', value: upstream === null },
									{
										type: 'select',
										id: 'force',
										label: 'When the remote has diverged',
										options: [
											{ value: 'none', label: 'Refuse (normal push)' },
											{ value: 'with-lease', label: 'Overwrite if unchanged since last fetch (--force-with-lease)' },
											{ value: 'force', label: 'Overwrite unconditionally (--force)' }
										],
										value: 'none'
									}
								],
								confirm: 'Push'
							},
							(v) => ({
								kind: 'push',
								branch: name,
								remote: text(v, 'remote'),
								setUpstream: flag(v, 'upstream'),
								force: (text(v, 'force') as 'none' | 'with-lease' | 'force') || 'none'
							})
						)
				});
			}
			if (label.current && upstream !== null) {
				items.push({
					label: `Pull from ${upstream}…`,
					action: () =>
						ask(
							ctx,
							{
								title: `Pull ${upstream} into ${name}`,
								fields: [
									{
										type: 'select',
										id: 'mode',
										label: 'Integrate by',
										options: [
											{ value: 'merge', label: 'Merging' },
											{ value: 'rebase', label: 'Rebasing' },
											{ value: 'ff-only', label: 'Fast-forward only' }
										],
										value: 'merge'
									}
								],
								confirm: 'Pull'
							},
							(v) => ({ kind: 'pull', mode: (text(v, 'mode') as 'merge' | 'rebase' | 'ff-only') || 'merge' })
						)
				});
			}
			items.push({
				label: 'Rename…',
				action: () =>
					ask(
						ctx,
						{ title: `Rename ${name}`, fields: [{ type: 'text', id: 'name', label: 'New name', value: name, required: true }], confirm: 'Rename' },
						(v) => ({ kind: 'renameBranch', from: name, to: text(v, 'name') })
					)
			});
			if (!label.current) {
				// Only offer to delete the remote copy when it is the same-named branch.
				const remoteCopy = upstreamRemote !== null && upstream === `${upstreamRemote}/${name}` ? upstreamRemote : null;
				items.push({
					label: 'Delete…',
					action: () =>
						ask(
							ctx,
							{
								title: `Delete branch ${name}`,
								fields: [
									{ type: 'checkbox', id: 'force', label: 'Delete even if it is not merged (-D)' },
									...(remoteCopy !== null ? [{ type: 'checkbox' as const, id: 'remote', label: `Also delete ${upstream} on the remote` }] : [])
								],
								confirm: 'Delete',
								danger: true
							},
							(v) => ({ kind: 'deleteBranch', name, force: flag(v, 'force'), deleteOnRemote: flag(v, 'remote') ? remoteCopy : null })
						)
				});
			}
			return items;
		}
		case 'remote': {
			const full = label.name;
			const remote = ctx.data.remotes.filter((r) => full.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
			if (remote === undefined) return [];
			const branch = full.slice(remote.length + 1);
			const tracking = ctx.data.heads.find((h) => h.upstream === full);
			const items: MenuItem[] = [
				tracking !== undefined
					? { label: `Check Out ${tracking.name}`, action: () => void runNow(ctx, { kind: 'checkout', branch: tracking.name }, 'Checkout') }
					: {
							label: 'Check Out…',
							action: () =>
								ask(
									ctx,
									{
										title: `Check out ${full}`,
										message: 'Creates a local branch that tracks the remote branch.',
										fields: [{ type: 'text', id: 'name', label: 'Local branch name', value: branch, required: true }],
										confirm: 'Check Out'
									},
									(v) => ({ kind: 'checkoutRemote', remoteBranch: full, localName: text(v, 'name') })
								)
						}
			];
			if (current !== null) items.push(mergeItem(ctx, full, full), rebaseItem(ctx, full, full));
			items.push({
				label: 'Delete Remote Branch…',
				action: () =>
					ask(
						ctx,
						{
							title: `Delete ${full}`,
							message: `Deletes the branch ${branch} on ${remote} for everyone who uses that remote.`,
							confirm: 'Delete on Remote',
							danger: true
						},
						() => ({ kind: 'deleteRemoteBranch', remote, branch })
					)
			});
			return items;
		}
		case 'tag': {
			const name = label.name;
			const items: MenuItem[] = [];
			if (ctx.data.remotes.length > 0) {
				items.push({
					label: 'Push Tag…',
					action: () =>
						ask(ctx, { title: `Push tag ${name}`, fields: [remoteField(ctx, 'remote', 'Remote', null, false)], confirm: 'Push' }, (v) => ({
							kind: 'pushTag',
							name,
							remote: text(v, 'remote')
						}))
				});
			}
			items.push({
				label: 'Delete Tag…',
				action: () =>
					ask(
						ctx,
						{
							title: `Delete tag ${name}`,
							fields:
								ctx.data.remotes.length > 0
									? [{ type: 'select', id: 'remote', label: 'Also delete on', options: [{ value: '', label: 'No remote (local only)' }, ...ctx.data.remotes.map((r) => ({ value: r, label: r }))], value: '' }]
									: [],
							confirm: 'Delete',
							danger: true
						},
						(v) => ({ kind: 'deleteTag', name, deleteOnRemote: text(v, 'remote') === '' ? null : text(v, 'remote') })
					)
			});
			return items;
		}
		case 'stash':
			return stashActions(ctx, commit);
		default:
			return [];
	}
}

function stashActions(ctx: ActionContext, commit: Commit): MenuItem[] {
	const selector = commit.stash?.selector;
	if (selector === undefined) return [];
	const reinstate: DialogField = { type: 'checkbox', id: 'index', label: 'Also restore what was staged (--index)' };
	return [
		{
			label: 'Apply Stash…',
			action: () =>
				ask(ctx, { title: `Apply ${selector}`, fields: [reinstate], confirm: 'Apply' }, (v) => ({ kind: 'stashApply', selector, reinstateIndex: flag(v, 'index') }))
		},
		{
			label: 'Pop Stash…',
			action: () =>
				ask(ctx, { title: `Pop ${selector}`, message: 'Applies the stash, then removes it.', fields: [reinstate], confirm: 'Pop' }, (v) => ({
					kind: 'stashPop',
					selector,
					reinstateIndex: flag(v, 'index')
				}))
		},
		{
			label: 'Create Branch from Stash…',
			action: () =>
				ask(
					ctx,
					{
						title: `Create a branch from ${selector}`,
						message: 'Creates a branch at the commit the stash was made on, checks it out, applies the stash and drops it.',
						fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
						confirm: 'Create Branch'
					},
					(v) => ({ kind: 'stashBranch', selector, name: text(v, 'name') })
				)
		},
		{ separator: true },
		{
			label: 'Drop Stash…',
			action: () =>
				ask(ctx, { title: `Drop ${selector}`, message: 'The stashed changes are deleted.', confirm: 'Drop', danger: true }, () => ({ kind: 'stashDrop', selector }))
		}
	];
}

function uncommittedActions(ctx: ActionContext): MenuItem[] {
	return [
		{
			label: 'Stash Changes…',
			action: () =>
				ask(
					ctx,
					{
						title: 'Stash uncommitted changes',
						fields: [
							{ type: 'text', id: 'message', label: 'Message (optional)' },
							{ type: 'checkbox', id: 'untracked', label: 'Include untracked files', value: true }
						],
						confirm: 'Stash'
					},
					(v) => ({ kind: 'stashPush', message: text(v, 'message'), includeUntracked: flag(v, 'untracked') })
				)
		},
		{ separator: true },
		{
			label: 'Discard Changes to Tracked Files…',
			action: () =>
				ask(
					ctx,
					{
						title: 'Discard changes',
						message: 'All staged and unstaged changes to tracked files are lost (git reset --hard). Untracked files are kept. This cannot be undone.',
						confirm: 'Discard',
						danger: true
					},
					() => ({ kind: 'discardChanges' })
				)
		},
		{
			label: 'Delete Untracked Files…',
			action: () =>
				ask(
					ctx,
					{
						title: 'Delete untracked files',
						message: 'Untracked files are deleted (git clean). Ignored files are kept. This cannot be undone.',
						fields: [{ type: 'checkbox', id: 'dirs', label: 'Also delete untracked folders', value: true }],
						confirm: 'Delete',
						danger: true
					},
					(v) => ({ kind: 'cleanUntracked', directories: flag(v, 'dirs') })
				)
		}
	];
}

/** The Fetch dialog: one remote or all, with pruning defaults from the settings. */
export function fetchDialog(ctx: ActionContext): void {
	ask(
		ctx,
		{
			title: 'Fetch',
			fields: [
				{ type: 'select', id: 'remote', label: 'From', options: [{ value: '', label: 'All remotes' }, ...ctx.data.remotes.map((r) => ({ value: r, label: r }))], value: '' },
				{ type: 'checkbox', id: 'prune', label: 'Prune remote branches deleted on the remote', value: ctx.config.fetchAndPrune },
				{ type: 'checkbox', id: 'pruneTags', label: 'Also prune local tags deleted on the remote', value: ctx.config.fetchAndPruneTags }
			],
			confirm: 'Fetch'
		},
		(v) => ({ kind: 'fetch', remote: text(v, 'remote') === '' ? null : text(v, 'remote'), prune: flag(v, 'prune'), pruneTags: flag(v, 'prune') && flag(v, 'pruneTags') })
	);
}

/** Continue / Abort for an interrupted operation (#519). */
export function pendingOperationActions(ctx: ActionContext, operation: PendingOperation): { continue: (() => void) | null; abort: () => void } {
	const noun = operation === PendingOperation.CherryPick ? 'cherry-pick' : operation;
	return {
		continue:
			operation === PendingOperation.Bisect
				? null
				: () => void runNow(ctx, { kind: 'continueOperation', operation }, `Continuing the ${noun}`),
		abort: () =>
			ask(
				ctx,
				{
					title: `Abort the ${noun}`,
					message:
						operation === PendingOperation.Bisect
							? 'Ends the bisect and returns to the commit you started from.'
							: `Stops the ${noun} and returns the branch and working tree to how they were before it started. Conflict resolutions made so far are lost.`,
					confirm: 'Abort',
					danger: true
				},
				() => ({ kind: 'abortOperation', operation })
			)
	};
}
