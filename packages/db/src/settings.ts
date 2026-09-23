import type { Db } from "./client";
import {
	DEFAULT_REPORTING_CURRENCY,
	isCurrencyCode,
	normalizeCurrency,
} from "./currency";

export const SETTINGS_ID = "app";

export const DEFAULT_AGENT_MODEL = {
	id: "zai/glm-5.2-fast",
	contextWindowTokens: 1_000_000,
} as const;

export interface AgentModelSetting {
	id: string;
	contextWindowTokens: number;
	isDefault: boolean;
}

export async function readAgentModel(db: Db): Promise<AgentModelSetting> {
	const row = await db.appSetting.findUnique({
		where: { id: SETTINGS_ID },
		select: { agentModelId: true, agentModelContextWindow: true },
	});

	if (!row?.agentModelId) {
		return { ...DEFAULT_AGENT_MODEL, isDefault: true };
	}

	return {
		id: row.agentModelId,
		contextWindowTokens:
			row.agentModelContextWindow ?? DEFAULT_AGENT_MODEL.contextWindowTokens,
		isDefault: false,
	};
}

export async function writeAgentModel(
	db: Db,
	model: { id: string; contextWindowTokens: number } | null,
): Promise<void> {
	const fields = {
		agentModelId: model?.id ?? null,
		agentModelContextWindow: model?.contextWindowTokens ?? null,
	};

	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, ...fields },
		update: fields,
	});
}

export const NIM_MODEL_PREFIX = "nim/";

export const NIM_PROVIDER = "NVIDIA NIM";

export const NIM_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export const NIM_MODELS = [
	{
		id: "mistralai/mistral-large-2-instruct",
		name: "Mistral Large 2",
		contextWindowTokens: 128_000,
	},
	{
		id: "nvidia/llama-3.1-nemotron-70b-instruct",
		name: "Llama Nemotron 70B",
		contextWindowTokens: 128_000,
	},
	{
		id: "openai/gpt-oss-20b",
		name: "GPT-OSS 20B",
		contextWindowTokens: 128_000,
	},
	{
		id: "moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		contextWindowTokens: 256_000,
	},
	{
		id: "mistralai/mixtral-8x22b-v0.1",
		name: "Mixtral 8x22B",
		contextWindowTokens: 64_000,
	},
	{
		id: "nvidia/nemotron-3.5-lightning-30b-a3b",
		name: "Nemotron 3.5 Lightning",
		contextWindowTokens: 256_000,
	},
] as const;

export type NimModel = (typeof NIM_MODELS)[number];

export function isNimModelId(id: string): boolean {
	return id.startsWith(NIM_MODEL_PREFIX);
}

export function nimModelSuffix(id: string): string {
	return isNimModelId(id) ? id.slice(NIM_MODEL_PREFIX.length) : id;
}

export function findNimModel(suffix: string): NimModel | null {
	return NIM_MODELS.find((model) => model.id === suffix) ?? null;
}

export function parseNimKeys(raw: string | undefined): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const part of raw.split(",")) {
		const key = part.trim();
		if (key && !seen.has(key)) seen.add(key);
	}
	return [...seen];
}

export function resolveNimBaseUrl(raw: string | undefined): string {
	const trimmed = raw?.trim();
	if (!trimmed) return NIM_DEFAULT_BASE_URL;
	try {
		return new URL(trimmed).toString().replace(/\/+$/, "");
	} catch {
		return NIM_DEFAULT_BASE_URL;
	}
}

export const CONTEXT_DEV_SIGNUP_URL = "https://link.context.dev/crm";

export const CONTEXT_DEV_DISCOUNT_CODE = "CRM";

export async function readContextDevKey(db: Db): Promise<string | null> {
	const row = await db.appSetting.findUnique({
		where: { id: SETTINGS_ID },
		select: { contextDevApiKey: true },
	});

	return row?.contextDevApiKey?.trim() || null;
}

export async function writeContextDevKey(db: Db, key: string): Promise<void> {
	const contextDevApiKey = key.trim();

	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, contextDevApiKey },
		update: { contextDevApiKey },
	});
}

export async function readReportingCurrency(db: Db): Promise<string> {
	const row = await db.appSetting.findUnique({
		where: { id: SETTINGS_ID },
		select: { reportingCurrency: true },
	});

	const stored = normalizeCurrency(row?.reportingCurrency);

	return isCurrencyCode(stored) ? stored : DEFAULT_REPORTING_CURRENCY;
}

export async function writeReportingCurrency(
	db: Db,
	code: string,
): Promise<string> {
	const reportingCurrency = normalizeCurrency(code);

	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, reportingCurrency },
		update: { reportingCurrency },
	});

	return reportingCurrency;
}

export async function readRatesRefreshedAt(db: Db): Promise<Date | null> {
	const row = await db.appSetting.findUnique({
		where: { id: SETTINGS_ID },
		select: { ratesRefreshedAt: true },
	});

	return row?.ratesRefreshedAt ?? null;
}

export async function writeRatesRefreshedAt(
	db: Db,
	ratesRefreshedAt: Date,
): Promise<void> {
	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, ratesRefreshedAt },
		update: { ratesRefreshedAt },
	});
}

export const DEFAULT_ARCHIVE_RETENTION_DAYS = 180;

export const MIN_ARCHIVE_RETENTION_DAYS = 1;

export const MAX_ARCHIVE_RETENTION_DAYS = 3650;

export async function readArchiveRetentionDays(db: Db): Promise<number> {
	const row = await db.appSetting.findUnique({
		where: { id: SETTINGS_ID },
		select: { archiveRetentionDays: true },
	});

	return row?.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS;
}

export async function writeArchiveRetentionDays(
	db: Db,
	days: number,
): Promise<number> {
	const archiveRetentionDays = Math.min(
		Math.max(Math.round(days), MIN_ARCHIVE_RETENTION_DAYS),
		MAX_ARCHIVE_RETENTION_DAYS,
	);

	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, archiveRetentionDays },
		update: { archiveRetentionDays },
	});

	return archiveRetentionDays;
}

export function maskKey(key: string): string {
	const trimmed = key.trim();
	return trimmed.length > 4 ? `••••${trimmed.slice(-4)}` : "••••";
}
