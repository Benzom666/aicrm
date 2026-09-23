import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	isNimModelId,
	NIM_PROVIDER,
	nimModelSuffix,
	parseNimKeys,
	resolveNimBaseUrl,
} from "@crm/db/settings";
import type { LanguageModel } from "ai";

const MINUTE_MS = 60_000;

export const NIM_REQUEST = {
	skipKeyForMs: { rateLimited: MINUTE_MS, rejected: 60 * MINUTE_MS },
} as const;

export interface NimConfig {
	apiKeys: string[];
	baseUrl: string;
}

export function nimConfigFromEnv(
	env: Record<string, string | undefined>,
): NimConfig {
	return {
		apiKeys: parseNimKeys(env.NVIDIA_NIM_API_KEY),
		baseUrl: resolveNimBaseUrl(env.NVIDIA_NIM_BASE_URL),
	};
}

export class NimKeyPool {
	readonly keys: string[];
	private skippedUntil = new Map<string, number>();
	private cursor = 0;

	constructor(keys: string[]) {
		this.keys = [...keys];
	}

	usableKeys(now: number): string[] {
		const usable = this.keys.filter(
			(key) => (this.skippedUntil.get(key) ?? 0) <= now,
		);
		return usable.length > 0 ? usable : [...this.keys];
	}

	take(now: number): string | null {
		const usable = this.usableKeys(now);
		const key = usable[this.cursor % usable.length];
		if (key === undefined) return null;
		this.cursor += 1;
		return key;
	}

	skip(key: string, now: number, forMs: number): void {
		this.skippedUntil.set(key, now + forMs);
	}
}

export function createNimFetch(
	pool: NimKeyPool,
	baseFetch: typeof fetch = fetch,
	now: () => number = Date.now,
): typeof fetch {
	return async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		let response: Response | null = null;
		for (let attempt = 0; attempt < pool.keys.length; attempt += 1) {
			const key = pool.take(now());
			if (!key) break;
			response = await baseFetch(input, withKey(init, key));
			if (response.status === 429) {
				pool.skip(key, now(), NIM_REQUEST.skipKeyForMs.rateLimited);
				continue;
			}
			if (response.status === 401 || response.status === 403) {
				pool.skip(key, now(), NIM_REQUEST.skipKeyForMs.rejected);
				continue;
			}
			return response;
		}
		if (!response) throw new Error("No NVIDIA NIM key answered the request.");
		return response;
	};
}

function withKey(init: RequestInit | undefined, key: string): RequestInit {
	const headers = new Headers(init?.headers);
	headers.set("authorization", `Bearer ${key}`);
	return { ...init, headers };
}

let pool: NimKeyPool | null = null;

function poolFor(apiKeys: string[]): NimKeyPool {
	if (!pool || pool.keys.join(",") !== apiKeys.join(",")) {
		pool = new NimKeyPool(apiKeys);
	}
	return pool;
}

export function resolveModelTarget(
	selection: { id: string; contextWindowTokens: number },
	nim: NimConfig,
): string | LanguageModel | null {
	if (!isNimModelId(selection.id)) return selection.id;
	if (nim.apiKeys.length === 0) {
		console.error(
			`[agent] ${selection.id} needs NVIDIA_NIM_API_KEY, which is not set. Using the default model instead.`,
		);
		return null;
	}
	const provider = createOpenAICompatible({
		baseURL: nim.baseUrl,
		name: NIM_PROVIDER,
		fetch: createNimFetch(poolFor(nim.apiKeys)),
	});
	return provider.languageModel(nimModelSuffix(selection.id));
}
