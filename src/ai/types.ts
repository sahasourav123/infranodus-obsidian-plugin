/**
 * AI provider profiles and task routing.
 *
 * A *profile* is one way to reach a model: a local OpenAI-compatible
 * server (Bionic / LM Studio / Ollama), a cloud API key (OpenAI, xAI,
 * Anthropic, OpenRouter …) or a subscription-backed CLI (Codex CLI signed
 * in with ChatGPT, Claude Code signed in with a Claude plan) or ChatGPT
 * itself, signed in over OAuth from the plugin settings.
 *
 * Each *task* (topic naming, insights, chat, semantic search) is routed to
 * one profile, so different work can go to different models.
 */

type AiProviderType = "openai" | "anthropic" | "cli" | "chatgpt";

type ReasoningEffort = "" | "none" | "low" | "medium" | "high";

interface AiProvider {
	id: string;
	name: string;
	type: AiProviderType;
	/** openai / anthropic: API base URL (OpenAI style includes /v1) */
	baseUrl: string;
	/** Name of the secret in Obsidian's secret storage (keychain) */
	apiKeySecret: string;
	/** Fallback plain key (only when secret storage is unavailable) */
	apiKey?: string;
	model: string;
	/** openai only: model for /embeddings (semantic search) */
	embeddingModel?: string;
	/** "" = provider default */
	reasoningEffort?: ReasoningEffort;
	temperature?: number;
	maxTokens?: number;
	/** cli only: executable (name or absolute path) */
	command?: string;
	/** cli only: arguments; {model} {output} placeholders; prompt is sent on stdin */
	args?: string;
	/** request timeout in seconds (cli) */
	timeout?: number;
}

type AiTask = "topics" | "insights" | "chat" | "embeddings";

type AiRoutes = Record<AiTask, string>;

const KEYWORD_SEARCH = "keyword";

interface ProviderPreset {
	key: string;
	label: string;
	description: string;
	make: () => Omit<AiProvider, "id">;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		key: "bionic",
		label: "Bionic (local, LM Studio)",
		description: "Local OpenAI-compatible server started by Bionic.",
		make: () => ({
			name: "Bionic (local)",
			type: "openai",
			baseUrl: "http://127.0.0.1:1235/v1",
			apiKeySecret: "",
			model: "",
			embeddingModel: "text-embedding-nomic-embed-text-v1.5",
			reasoningEffort: "none",
			temperature: 0.4,
			maxTokens: 4096,
		}),
	},
	{
		key: "lmstudio",
		label: "LM Studio (local)",
		description: "LM Studio developer server on the default port.",
		make: () => ({
			name: "LM Studio (local)",
			type: "openai",
			baseUrl: "http://127.0.0.1:1234/v1",
			apiKeySecret: "",
			model: "",
			embeddingModel: "",
			reasoningEffort: "none",
			temperature: 0.4,
			maxTokens: 4096,
		}),
	},
	{
		key: "ollama",
		label: "Ollama (local)",
		description: "Ollama's OpenAI-compatible endpoint.",
		make: () => ({
			name: "Ollama (local)",
			type: "openai",
			baseUrl: "http://127.0.0.1:11434/v1",
			apiKeySecret: "",
			model: "",
			embeddingModel: "",
			reasoningEffort: "",
			temperature: 0.4,
			maxTokens: 4096,
		}),
	},
	{
		key: "anthropic",
		label: "Claude (Anthropic API key)",
		description: "Anthropic Messages API with your API key.",
		make: () => ({
			name: "Claude API",
			type: "anthropic",
			baseUrl: "https://api.anthropic.com",
			apiKeySecret: "anthropic-api-key",
			model: "claude-opus-5-5",
			reasoningEffort: "low",
			maxTokens: 16000,
		}),
	},
	{
		key: "openai",
		label: "OpenAI (API key)",
		description: "OpenAI API with your API key.",
		make: () => ({
			name: "OpenAI API",
			type: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKeySecret: "openai-api-key",
			model: "gpt-5.4-mini",
			embeddingModel: "text-embedding-3-small",
			reasoningEffort: "low",
			maxTokens: 8000,
		}),
	},
	{
		key: "xai",
		label: "Grok (xAI API key)",
		description: "xAI's OpenAI-compatible API with your API key.",
		make: () => ({
			name: "Grok (xAI)",
			type: "openai",
			baseUrl: "https://api.x.ai/v1",
			apiKeySecret: "xai-api-key",
			model: "grok-4",
			embeddingModel: "",
			reasoningEffort: "",
			temperature: 0.4,
			maxTokens: 8000,
		}),
	},
	{
		key: "openrouter",
		label: "OpenRouter (API key)",
		description: "Any model through OpenRouter.",
		make: () => ({
			name: "OpenRouter",
			type: "openai",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKeySecret: "openrouter-api-key",
			model: "",
			embeddingModel: "",
			reasoningEffort: "",
			temperature: 0.4,
			maxTokens: 8000,
		}),
	},
	{
		key: "chatgpt",
		label: "ChatGPT subscription (sign in with ChatGPT)",
		description:
			"Your ChatGPT plan over OAuth, no API key or CLI. Sign in from the provider settings. Desktop only.",
		make: () => ({
			name: "ChatGPT",
			type: "chatgpt",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			apiKeySecret: "",
			model: "gpt-6.1-sol",
			reasoningEffort: "low",
		}),
	},
	{
		key: "codex",
		label: "ChatGPT subscription (Codex CLI)",
		description:
			"Runs `codex exec` signed in with your ChatGPT plan. Desktop only.",
		make: () => ({
			name: "ChatGPT (Codex CLI)",
			type: "cli",
			baseUrl: "",
			apiKeySecret: "",
			model: "",
			command: "codex",
			args: "exec --skip-git-repo-check --ephemeral -s read-only --color never -c model_reasoning_effort=low {model} -o {output} -",
			timeout: 240,
		}),
	},
	{
		key: "claude-code",
		label: "Claude subscription (Claude Code CLI)",
		description:
			"Runs `claude -p` signed in with your Claude plan. Desktop only.",
		make: () => ({
			name: "Claude (Claude Code CLI)",
			type: "cli",
			baseUrl: "",
			apiKeySecret: "",
			model: "",
			command: "claude",
			args: "-p --output-format text --no-session-persistence {model}",
			timeout: 240,
		}),
	},
	{
		key: "custom",
		label: "Custom OpenAI-compatible",
		description: "Any server with an OpenAI-style /v1/chat/completions.",
		make: () => ({
			name: "Custom",
			type: "openai",
			baseUrl: "http://127.0.0.1:8080/v1",
			apiKeySecret: "",
			model: "",
			embeddingModel: "",
			reasoningEffort: "",
			temperature: 0.4,
			maxTokens: 4096,
		}),
	},
];

function newProviderId() {
	return "p-" + Math.random().toString(36).slice(2, 10);
}

const DEFAULT_PROVIDERS: AiProvider[] = [
	{
		id: "local-bionic",
		...PROVIDER_PRESETS[0].make(),
	},
];

const DEFAULT_ROUTES: AiRoutes = {
	topics: "local-bionic",
	insights: "local-bionic",
	chat: "local-bionic",
	embeddings: "local-bionic",
};

const TASK_LABELS: Record<AiTask, { name: string; desc: string }> = {
	topics: {
		name: "Topic names",
		desc: "Names the topical clusters after each graph build. Fast models work best.",
	},
	insights: {
		name: "Insights",
		desc: "Summaries, research questions, ideas and gap bridging.",
	},
	chat: {
		name: "Chat",
		desc: "Chat with your notes (RAG over the graph's statements).",
	},
	embeddings: {
		name: "Semantic search",
		desc: "Finds the statements relevant to a chat question. Needs an embedding model, or use keyword search.",
	},
};

export {
	PROVIDER_PRESETS,
	DEFAULT_PROVIDERS,
	DEFAULT_ROUTES,
	TASK_LABELS,
	KEYWORD_SEARCH,
	newProviderId,
};
export type {
	AiProvider,
	AiProviderType,
	AiTask,
	AiRoutes,
	ReasoningEffort,
	ProviderPreset,
};
