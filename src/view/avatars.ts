import * as vscode from 'vscode';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { avatarUrl } from './avatarUrl.ts';

/** The Memento key the cache used before it moved to a file; cleared on sight. */
const LEGACY_CACHE_KEY = 'gitGraphNext.avatars';
/** Enough for the authors of a large project; each entry is a small image. */
const CACHE_LIMIT = 500;
const CONCURRENCY = 4;
const TIMEOUT_MS = 5000;
/** A refusal to grow past this, whatever the images turn out to weigh. */
const MAX_BYTES = 8 * 1024 * 1024;
/** How long a write waits for more entries, so a scroll costs one write. */
const WRITE_DEBOUNCE_MS = 2000;

/**
 * Author avatars, an opt-in (`git-graph-next.fetchAvatars`): fetching them
 * tells Gravatar or GitHub which authors appear in the graph. Images are
 * fetched on the host (the webview may not reach the network), only for rows
 * on screen, and kept as data URIs.
 *
 * The cache is a file in the extension's global storage, not a Memento: a
 * Memento is a synchronously-read key-value store meant for small settings,
 * and several megabytes of base64 in it is paid for on every window that
 * starts. On disk it is read once, lazily, and a corrupt or unreadable file
 * only costs the cache.
 */
export class AvatarService implements vscode.Disposable {
	/** e-mail → data URI, or null for "has none" (not asked again). */
	private cache = new Map<string, string | null>();
	private readonly pending = new Map<string, Promise<string | null>>();
	private loaded: Promise<void> | undefined;
	private writeTimer: ReturnType<typeof setTimeout> | undefined;
	private writing: Promise<void> = Promise.resolve();
	private dirty = false;

	constructor(
		private readonly file: string,
		/** Only to clear the cache older versions left behind. */
		private readonly legacyState?: vscode.Memento
	) {}

	/** Avatars for these addresses, fetching those not cached yet. */
	async get(emails: readonly string[]): Promise<Record<string, string | null>> {
		await this.load();
		const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
		const missing = wanted.filter((email) => !this.cache.has(email));
		for (let i = 0; i < missing.length; i += CONCURRENCY) {
			await Promise.all(missing.slice(i, i + CONCURRENCY).map((email) => this.fetchOnce(email)));
		}
		if (missing.length > 0) this.schedulePersist();
		const result: Record<string, string | null> = {};
		for (const email of wanted) result[email] = this.cache.get(email) ?? null;
		return result;
	}

	async clear(): Promise<void> {
		clearTimeout(this.writeTimer);
		this.cache.clear();
		this.dirty = false;
		// Anything still loading would repopulate an emptied cache.
		this.loaded = Promise.resolve();
		await this.writing;
		await rm(this.file, { force: true }).catch(() => undefined);
	}

	/** Flushes a pending write, so a cache filled just before exit survives. */
	dispose(): void {
		if (this.writeTimer !== undefined) {
			clearTimeout(this.writeTimer);
			void this.persist();
		}
	}

	private load(): Promise<void> {
		this.loaded ??= (async () => {
			// A cache written by a version that used the Memento is dropped, not
			// migrated: it refills itself, and leaving it behind keeps paying for
			// the megabytes this move exists to stop loading.
			if (this.legacyState?.get(LEGACY_CACHE_KEY) !== undefined) await this.legacyState.update(LEGACY_CACHE_KEY, undefined);
			try {
				const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
				for (const [email, image] of Object.entries(parsed)) {
					// Only data URIs, so a tampered file cannot point the webview at a
					// remote address it would then load.
					if (image === null || (typeof image === 'string' && image.startsWith('data:image/'))) this.cache.set(email, image);
				}
			} catch {
				// No cache yet, or one that cannot be read: start empty.
			}
		})();
		return this.loaded;
	}

	private fetchOnce(email: string): Promise<string | null> {
		let request = this.pending.get(email);
		if (request === undefined) {
			request = this.download(email).finally(() => this.pending.delete(email));
			this.pending.set(email, request);
		}
		return request;
	}

	private async download(email: string): Promise<string | null> {
		let image: string | null = null;
		try {
			const response = await fetch(avatarUrl(email), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
			const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
			if (response.ok && /^image\/(png|jpeg|gif|webp)$/.test(type)) {
				image = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
			}
		} catch {
			// Offline or blocked: show names only, and try again next session.
			return null;
		}
		this.cache.set(email, image);
		this.trim();
		return image;
	}

	/** Oldest first out, so neither the entry count nor the size runs away. */
	private trim(): void {
		let bytes = 0;
		for (const image of this.cache.values()) bytes += image?.length ?? 0;
		while (this.cache.size > CACHE_LIMIT || (bytes > MAX_BYTES && this.cache.size > 1)) {
			const oldest = this.cache.keys().next().value!;
			bytes -= this.cache.get(oldest)?.length ?? 0;
			this.cache.delete(oldest);
		}
	}

	/** Collects the entries of a burst of rows into one write. */
	private schedulePersist(): void {
		this.dirty = true;
		clearTimeout(this.writeTimer);
		this.writeTimer = setTimeout(() => void this.persist(), WRITE_DEBOUNCE_MS);
	}

	private persist(): Promise<void> {
		this.writeTimer = undefined;
		if (!this.dirty) return this.writing;
		this.dirty = false;
		const snapshot = JSON.stringify(Object.fromEntries(this.cache));
		// One write at a time, or two overlapping ones can interleave and leave
		// a half-written file behind.
		this.writing = this.writing.then(async () => {
			try {
				await mkdir(dirname(this.file), { recursive: true });
				// Written beside the cache and renamed over it, so an interrupted
				// write cannot leave a truncated file to be read next time.
				const temporary = `${this.file}.${process.pid}.tmp`;
				await writeFile(temporary, snapshot, 'utf8');
				await rename(temporary, this.file);
			} catch {
				// A cache that cannot be written is not worth an error: the
				// avatars are still in memory for this session.
			}
		});
		return this.writing;
	}
}

/** Where the avatar cache lives, inside the extension's own storage. */
export function avatarCacheFile(globalStorage: vscode.Uri): string {
	return join(globalStorage.fsPath, 'avatars.json');
}
