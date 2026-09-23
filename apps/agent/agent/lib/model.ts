import { db } from "@crm/db";
import { readAgentModel } from "@crm/db/settings";
import type { LanguageModel } from "ai";
import { nimConfigFromEnv, resolveModelTarget } from "./nim";

export interface ModelSelection {
	model: string | LanguageModel;
	modelContextWindowTokens: number;
}

export async function selectedModel(): Promise<ModelSelection | null> {
	try {
		const setting = await readAgentModel(db);

		if (setting.isDefault) return null;

		const target = resolveModelTarget(
			{ id: setting.id, contextWindowTokens: setting.contextWindowTokens },
			nimConfigFromEnv(process.env),
		);

		if (!target) return null;

		return {
			model: target,
			modelContextWindowTokens: setting.contextWindowTokens,
		};
	} catch (error) {
		console.error(
			`[agent] could not read the configured model, falling back: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}
