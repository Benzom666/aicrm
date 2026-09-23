import { describe, expect, it } from "bun:test";
import {
	findNimModel,
	isNimModelId,
	NIM_DEFAULT_BASE_URL,
	NIM_MODELS,
	nimModelSuffix,
	parseNimKeys,
	resolveNimBaseUrl,
} from "@crm/db/settings";
import {
	createNimFetch,
	NimKeyPool,
	nimConfigFromEnv,
	resolveModelTarget,
} from "../agent/lib/nim";

describe("the NIM model table", () => {
	it("holds usable entries and nothing else", () => {
		expect(NIM_MODELS.length).toBeGreaterThan(0);
		for (const model of NIM_MODELS) {
			expect(model.id.length).toBeGreaterThan(0);
			expect(model.id.includes("/")).toBe(true);
			expect(isNimModelId(model.id)).toBe(false);
			expect(model.name.length).toBeGreaterThan(0);
			expect(Number.isInteger(model.contextWindowTokens)).toBe(true);
			expect(model.contextWindowTokens).toBeGreaterThan(0);
			expect(findNimModel(model.id)).toEqual(model);
		}
	});

	it("returns null for unknown suffixes", () => {
		expect(findNimModel("acme/does-not-exist")).toBeNull();
	});

	it("detects the prefix and strips it once", () => {
		expect(isNimModelId("nim/mistralai/mistral-large-2-instruct")).toBe(true);
		expect(isNimModelId("anthropic/claude-sonnet-5")).toBe(false);
		expect(nimModelSuffix("nim/mistralai/mistral-large-2-instruct")).toBe(
			"mistralai/mistral-large-2-instruct",
		);
		expect(nimModelSuffix("nim/nim/x")).toBe("nim/x");
		expect(nimModelSuffix("anthropic/claude-sonnet-5")).toBe(
			"anthropic/claude-sonnet-5",
		);
	});
});

describe("the NIM base URL", () => {
	it("defaults when unset or blank", () => {
		expect(resolveNimBaseUrl(undefined)).toBe(NIM_DEFAULT_BASE_URL);
		expect(resolveNimBaseUrl("   ")).toBe(NIM_DEFAULT_BASE_URL);
	});

	it("keeps a custom URL and drops trailing slashes", () => {
		expect(resolveNimBaseUrl("https://nim.internal.example.com/v1/")).toBe(
			"https://nim.internal.example.com/v1",
		);
	});

	it("falls back on garbage", () => {
		expect(resolveNimBaseUrl("not a url")).toBe(NIM_DEFAULT_BASE_URL);
	});
});

describe("the NIM key list", () => {
	it("splits on commas, trims, drops empties and duplicates", () => {
		expect(parseNimKeys("nvapi-a, nvapi-b,,nvapi-a , ")).toEqual([
			"nvapi-a",
			"nvapi-b",
		]);
	});

	it("treats missing or blank input as unconfigured", () => {
		expect(parseNimKeys(undefined)).toEqual([]);
		expect(parseNimKeys("   ")).toEqual([]);
	});
});

describe("the NIM config", () => {
	it("reads the keys and trims them", () => {
		expect(
			nimConfigFromEnv({ NVIDIA_NIM_API_KEY: "  nvapi-a,nvapi-b  " }),
		).toEqual({
			apiKeys: ["nvapi-a", "nvapi-b"],
			baseUrl: NIM_DEFAULT_BASE_URL,
		});
	});

	it("treats a missing key as unconfigured", () => {
		expect(nimConfigFromEnv({})).toEqual({
			apiKeys: [],
			baseUrl: NIM_DEFAULT_BASE_URL,
		});
	});
});

describe("the NIM key pool", () => {
	it("rotates across keys in order", () => {
		const pool = new NimKeyPool(["a", "b", "c"]);
		expect([pool.take(1), pool.take(1), pool.take(1), pool.take(1)]).toEqual([
			"a",
			"b",
			"c",
			"a",
		]);
	});

	it("skips rejected keys until they recover", () => {
		const pool = new NimKeyPool(["a", "b"]);
		pool.skip("a", 1_000, 60_000);
		expect(pool.take(2_000)).toBe("b");
		expect(pool.take(2_000)).toBe("b");
		expect(pool.take(61_001)).toBe("a");
	});

	it("still answers when every key is skipped", () => {
		const pool = new NimKeyPool(["a"]);
		pool.skip("a", 1_000, 60_000);
		expect(pool.take(2_000)).toBe("a");
	});

	it("answers null with no keys", () => {
		expect(new NimKeyPool([]).take(1)).toBeNull();
	});
});

describe("the NIM fetch", () => {
	function track(responses: Response[]) {
		const seen: (string | null)[] = [];
		const calls = { count: 0 };
		const baseFetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		): Promise<Response> => {
			calls.count += 1;
			seen.push(new Headers(init?.headers).get("authorization"));
			const next = responses.shift();
			if (!next) throw new Error("fake fetch ran out of responses");
			return next;
		}) as typeof fetch;
		return { baseFetch, seen, calls };
	}

	it("authorizes each request with the next key", async () => {
		const pool = new NimKeyPool(["a", "b"]);
		const { baseFetch, seen } = track([
			new Response("one", { status: 200 }),
			new Response("two", { status: 200 }),
		]);
		const nimFetch = createNimFetch(pool, baseFetch, () => 1_000);
		await nimFetch("https://nim.test/v1/chat/completions");
		await nimFetch("https://nim.test/v1/chat/completions");
		expect(seen).toEqual(["Bearer a", "Bearer b"]);
	});

	it("fails over past throttled and rejected keys", async () => {
		const pool = new NimKeyPool(["a", "b", "c"]);
		const { baseFetch, seen } = track([
			new Response("slow", { status: 429 }),
			new Response("bad", { status: 401 }),
			new Response("fine", { status: 200 }),
		]);
		const nimFetch = createNimFetch(pool, baseFetch, () => 1_000);
		const response = await nimFetch("https://nim.test/v1/chat/completions");
		expect(response.status).toBe(200);
		expect([...seen].sort()).toEqual(["Bearer a", "Bearer b", "Bearer c"]);
		const followUp = track([new Response("again", { status: 200 })]);
		const retry = createNimFetch(pool, followUp.baseFetch, () => 2_000);
		await retry("https://nim.test/v1/chat/completions");
		expect(followUp.seen).toEqual(["Bearer b"]);
	});

	it("returns the last throttled answer instead of looping", async () => {
		const pool = new NimKeyPool(["a", "b"]);
		const { baseFetch, calls } = track([
			new Response("slow", { status: 429 }),
			new Response("slow", { status: 429 }),
		]);
		const nimFetch = createNimFetch(pool, baseFetch, () => 1_000);
		const response = await nimFetch("https://nim.test/v1/chat/completions");
		expect(response.status).toBe(429);
		expect(calls.count).toBe(2);
	});
});

describe("model target resolution", () => {
	it("passes gateway ids through untouched without any key", () => {
		expect(
			resolveModelTarget(
				{ id: "anthropic/claude-sonnet-5", contextWindowTokens: 200_000 },
				{ apiKeys: [], baseUrl: NIM_DEFAULT_BASE_URL },
			),
		).toBe("anthropic/claude-sonnet-5");
	});

	it("never routes gateway ids to NIM even with a key set", () => {
		expect(
			resolveModelTarget(
				{ id: "anthropic/claude-sonnet-5", contextWindowTokens: 200_000 },
				{ apiKeys: ["nvapi-a", "nvapi-b"], baseUrl: NIM_DEFAULT_BASE_URL },
			),
		).toBe("anthropic/claude-sonnet-5");
	});

	it("falls back instead of throwing without a key", () => {
		expect(
			resolveModelTarget(
				{
					id: "nim/mistralai/mistral-large-2-instruct",
					contextWindowTokens: 128_000,
				},
				{ apiKeys: [], baseUrl: NIM_DEFAULT_BASE_URL },
			),
		).toBeNull();
	});

	it("builds a direct model carrying the NIM suffix", () => {
		const target = resolveModelTarget(
			{
				id: "nim/mistralai/mistral-large-2-instruct",
				contextWindowTokens: 128_000,
			},
			{ apiKeys: ["nvapi-a", "nvapi-b"], baseUrl: NIM_DEFAULT_BASE_URL },
		);
		expect(target).toMatchObject({
			modelId: "mistralai/mistral-large-2-instruct",
		});
	});
});
