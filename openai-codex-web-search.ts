import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_DOMAINS = ["csdn.net"];

type ProviderPayload = {
	tools: unknown[];
	[key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addWebSearch(payload: ProviderPayload): ProviderPayload {
	if (payload.tools.some((tool) => isRecord(tool) && tool.type === "web_search")) return payload;

	return {
		...payload,
		tools: [
			...payload.tools,
			{
				type: "web_search",
				filters: { blocked_domains: BLOCKED_DOMAINS },
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex" || !isRecord(event.payload)) return;
		return addWebSearch(event.payload as ProviderPayload);
	});
}
