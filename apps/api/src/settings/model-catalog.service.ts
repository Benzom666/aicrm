import {
	NIM_MODEL_PREFIX,
	NIM_MODELS,
	NIM_PROVIDER,
	parseNimKeys,
	resolveNimBaseUrl,
} from "@crm/db/settings";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Cache } from "cache-manager";
import { z } from "zod";

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

const CATALOG_TTL_MS = 30 * 60_000;

const CATALOG_KEY = "settings:model-catalog";

const CATALOG_TIMEOUT_MS = 5_000;

export interface CatalogModel {
	id: string;
	name: string;
	provider: string;
	contextWindowTokens: number;
	pricing: { input: number; output: number } | null;
}

const gatewayRate = z
	.union([z.number(), z.string()])
	.transform((value) => Number(value))
	.refine((value) => Number.isFinite(value))
	.nullable()
	.catch(null);

const gatewayModel = z.object({
	id: z.string(),
	name: z.string().catch(""),
	owned_by: z.string().catch(""),
	type: z.string().catch(""),
	tags: z.array(z.json()).catch([]),
	context_window: z.number(),
	pricing: z
		.object({ input: gatewayRate, output: gatewayRate })
		.nullable()
		.catch(null),
});

type GatewayModel = z.infer<typeof gatewayModel>;

const gatewayCatalog = z
	.object({ data: z.array(z.json()).catch([]) })
	.catch({ data: [] });

const nimCatalog = z
	.object({ data: z.array(z.json()).catch([]) })
	.catch({ data: [] });

const nimModelId = z.object({ id: z.string() });

function usable(model: GatewayModel): boolean {
	return model.type === "language" && model.tags.includes("tool-use");
}

function toCatalogModel(model: GatewayModel): CatalogModel {
	const input = model.pricing?.input ?? null;
	const output = model.pricing?.output ?? null;

	return {
		id: model.id,
		name: model.name || model.id,
		provider: model.owned_by || (model.id.split("/")[0] ?? model.id),
		contextWindowTokens: model.context_window,
		pricing: input !== null && output !== null ? { input, output } : null,
	};
}

@Injectable()
export class ModelCatalogService {
	private readonly logger = new Logger(ModelCatalogService.name);

	constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

	async models(): Promise<CatalogModel[] | null> {
		const cached = await this.cache.get<CatalogModel[]>(CATALOG_KEY);
		if (cached) return cached;

		const [gateway, nim] = await Promise.all([
			this.fetchCatalog(),
			this.nimModels(),
		]);

		if (!gateway && nim.length === 0) return null;

		const models = [...(gateway ?? []), ...nim];
		await this.cache.set(CATALOG_KEY, models, CATALOG_TTL_MS);
		return models;
	}

	async nimModels(): Promise<CatalogModel[]> {
		const apiKeys = parseNimKeys(process.env.NVIDIA_NIM_API_KEY);
		if (apiKeys.length === 0) return [];

		const baseUrl = resolveNimBaseUrl(process.env.NVIDIA_NIM_BASE_URL);
		const found = new Map<string, CatalogModel>();
		for (const apiKey of apiKeys) {
			const live = await this.fetchNimModelIds(baseUrl, apiKey);
			if (!live) continue;
			for (const model of NIM_MODELS) {
				if (live.has(model.id) && !found.has(model.id)) {
					found.set(model.id, {
						id: `${NIM_MODEL_PREFIX}${model.id}`,
						name: model.name,
						provider: NIM_PROVIDER,
						contextWindowTokens: model.contextWindowTokens,
						pricing: null,
					});
				}
			}
		}

		const models = [...found.values()];
		this.logger.log({
			message: "NIM model list loaded",
			models: models.length,
		});
		return models;
	}

	private async fetchNimModelIds(
		baseUrl: string,
		apiKey: string,
	): Promise<Set<string> | null> {
		try {
			const response = await fetch(`${baseUrl}/models`, {
				headers: {
					accept: "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
			});

			if (!response.ok) {
				this.logger.warn({
					message: "NIM model list request failed",
					status: response.status,
				});
				return null;
			}

			const body = nimCatalog.parse(await response.json());
			const live = new Set<string>();
			for (const entry of body.data) {
				const parsed = nimModelId.safeParse(entry);
				if (parsed.success) live.add(parsed.data.id);
			}
			return live;
		} catch (error) {
			this.logger.warn({
				message: "NIM model list unavailable",
				reason: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async find(id: string): Promise<CatalogModel | null> {
		const models = await this.models();
		return models?.find((model) => model.id === id) ?? null;
	}

	private async fetchCatalog(): Promise<CatalogModel[] | null> {
		try {
			const response = await fetch(CATALOG_URL, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
			});

			if (!response.ok) {
				this.logger.warn({
					message: "Model catalog request failed",
					status: response.status,
				});
				return null;
			}

			const body = gatewayCatalog.parse(await response.json());

			const models = body.data.flatMap((entry) => {
				const parsed = gatewayModel.safeParse(entry);
				return parsed.success && usable(parsed.data)
					? [toCatalogModel(parsed.data)]
					: [];
			});

			models.sort(
				(a, b) =>
					a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
			);

			this.logger.log({
				message: "Model catalog loaded",
				models: models.length,
			});

			return models;
		} catch (error) {
			this.logger.warn({
				message: "Model catalog unavailable",
				reason: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
}
