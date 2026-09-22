import * as vscode from 'vscode';
import { avatarUrl } from './avatarUrl.ts';

const CACHE_KEY = 'gitGraphNext.avatars';
/** Enough for the authors of a large project; each entry is a small image. */
const CACHE_LIMIT = 500;
const CONCURRENCY = 4;
const TIMEOUT_MS = 5000;

/**
 * Author avatars, an opt-in like in the original (`git-graph-next.fetchAvatars`):
 * fetching them tells Gravatar or GitHub which authors appear in the graph.
 * Images are fetched on the host (the webview may not reach the network),
 * only for rows on screen, and kept as data URIs in a size-limited cache.
 */
export class AvatarService {
	/** e-mail → data URI, or null for "has none" (not asked again). */
	private readonly cache: Map<string, string | null>;
	private readonly pending = new Map<string, Promise<string | null>>();

	constructor(private readonly state: vscode.Memento) {
		const stored = state.get<Record<string, string | null>>(CACHE_KEY) ?? {};
		this.cache = new Map(Object.entries(stored));
	}

	/** Avatars for these addresses, fetching those not cached yet. */
	async get(emails: readonly string[]): Promise<Record<string, string | null>> {
		const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
		const missing = wanted.filter((email) => !this.cache.has(email));
		for (let i = 0; i < missing.length; i += CONCURRENCY) {
			await Promise.all(missing.slice(i, i + CONCURRENCY).map((email) => this.fetchOnce(email)));
		}
		if (missing.length > 0) await this.persist();
		const result: Record<string, string | null> = {};
		for (const email of wanted) result[email] = this.cache.get(email) ?? null;
		return result;
	}

	async clear(): Promise<void> {
		this.cache.clear();
		await this.state.update(CACHE_KEY, undefined);
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
			const type = response.headers.get('content-type') ?? '';
			if (response.ok && /^image\/(png|jpeg|gif|webp)$/.test(type.split(';')[0].trim())) {
				image = `data:${type.split(';')[0].trim()};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
			}
		} catch {
			// Offline or blocked: show names only, and try again next session.
			return null;
		}
		this.cache.set(email, image);
		// Oldest first out, so the cache stays bounded.
		while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
		return image;
	}

	private async persist(): Promise<void> {
		await this.state.update(CACHE_KEY, Object.fromEntries(this.cache));
	}
}
