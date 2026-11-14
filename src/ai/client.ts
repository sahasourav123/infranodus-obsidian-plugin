/**
 * Provider-neutral chat completion, embeddings and model listing.
 *
 * - openai:    any OpenAI-compatible server (Bionic, LM Studio, Ollama,
 *              OpenAI, xAI, OpenRouter, LiteLLM …)
 * - anthropic: Anthropic Messages API (raw HTTP through requestUrl, which
 *              avoids CORS inside Obsidian)
 * - cli:       a local CLI that is signed in with a subscription
 *              (codex exec / claude -p); prompt on stdin
 * - chatgpt:   ChatGPT plan over OAuth (see ./chatgpt.ts)
 */
import { App, Platform, requestUrl, RequestUrlResponse } from "obsidian";
import { SETTINGS } from "src/settings";
import { completeChatGpt, listChatGptModels, setChatGptApp } from "./chatgpt";
import {
	AiProvider,
	AiTask,
	DEFAULT_PROVIDERS,
	DEFAULT_ROUTES,
	KEYWORD_SEARCH,
} from "./types";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface CompleteParams {
	system?: string;
	messages: ChatMessage[];
	maxTokens?: number;
	/** override provider temperature (openai only) */
	temperature?: number;
}

let appRef: App | null = null;
function setAiApp(app: App) {
	appRef = app;
	setChatGptApp(app);
}

function getApiKey(p: AiProvider): string {
	if (p.apiKeySecret && appRef && (appRef as any).secretStorage) {
		try {
			const v = (appRef as any).secretStorage.getSecret(p.apiKeySecret);
			if (v) return v;
		} catch (_) {
			/* invalid id */
		}
	}
	return p.apiKey || "";
}

function getProviders(): AiProvider[] {
	const list = SETTINGS.AI_PROVIDERS;
	return Array.isArray(list) && list.length > 0 ? list : DEFAULT_PROVIDERS;
}

function getProvider(id: string): AiProvider | undefined {
	return getProviders().find((p) => p.id === id);
}

function providerForTask(task: AiTask): AiProvider {
	const routes = { ...DEFAULT_ROUTES, ...(SETTINGS.AI_ROUTES || {}) };
	const p = getProvider(routes[task]) || getProviders()[0];
	if (!p) throw new Error("No AI provider is configured. Open the plugin settings to add one.");
	return p;
}

function embeddingProvider(): AiProvider | null {
	const routes = { ...DEFAULT_ROUTES, ...(SETTINGS.AI_ROUTES || {}) };
	if (routes.embeddings === KEYWORD_SEARCH) return null;
	const p = getProvider(routes.embeddings);
	if (!p || p.type !== "openai" || !p.embeddingModel) return null;
	return p;
}

function trimSlash(url: string) {
	return url.replace(/\/+$/, "");
}

/** Remove <think>…</think> blocks some local reasoning models emit inline. */
function stripThinking(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/^[\s\S]*?<\/think>/i, "")
		.trim();
}

function errorFromResponse(p: AiProvider, res: RequestUrlResponse): Error {
	let detail = "";
	try {
		const j = res.json;
		detail = j?.error?.message || j?.error || j?.message || JSON.stringify(j);
	} catch (_) {
		detail = (res.text || "").slice(0, 300);
	}
	if (typeof detail !== "string") detail = JSON.stringify(detail);
	return new Error(`${p.name}: HTTP ${res.status} — ${detail}`);
}

// ---------------------------------------------------------------- openai

const NON_CHAT = /embed|rerank|whisper|tts|phonon|speech|vision-encoder/i;
const detectedModels = new Map<string, string>();

/**
 * Pick a chat model when none is set. LM Studio / Bionic expose
 * /api/v0/models with type and load state: prefer the loaded LLM with the
 * largest context. Otherwise take the first non-embedding model.
 */
async function autoDetectModel(p: AiProvider): Promise<string> {
	const cached = detectedModels.get(p.id + p.baseUrl);
	if (cached) return cached;
	let model = "";
	try {
		const root = trimSlash(p.baseUrl).replace(/\/v1$/, "");
		const res = await requestUrl({ url: `${root}/api/v0/models`, throw: false });
		const data: any[] = res.status < 400 ? res.json?.data || [] : [];
		const chat = data.filter(
			(m) => (m.type === "llm" || m.type === "vlm") && !NON_CHAT.test(m.id)
		);
		const loaded = chat
			.filter((m) => m.state === "loaded")
			.sort((a, b) => (b.loaded_context_length || 0) - (a.loaded_context_length || 0));
		model = (loaded[0] || chat[0])?.id || "";
	} catch (_) {
		/* not LM Studio */
	}
	if (!model) {
		const models = await listModels(p).catch(() => [] as string[]);
		model = models.find((m) => !NON_CHAT.test(m)) || "";
	}
	if (model) detectedModels.set(p.id + p.baseUrl, model);
	return model;
}

function isOpenAiCloud(p: AiProvider) {
	return /api\.openai\.com/.test(p.baseUrl);
}

async function completeOpenAi(p: AiProvider, params: CompleteParams): Promise<string> {
	const key = getApiKey(p);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (key) headers.Authorization = `Bearer ${key}`;
	if (/openrouter\.ai/.test(p.baseUrl)) {
		headers["X-Title"] = "Obsidian Graph AI";
	}

	const messages: ChatMessage[] = [];
	if (params.system) messages.push({ role: "system", content: params.system });
	messages.push(...params.messages);

	const model = p.model || (await autoDetectModel(p));
	if (!model) throw new Error(`${p.name}: no model selected and none could be detected.`);

	const body: Record<string, any> = { model, messages };
	const maxTokens = params.maxTokens ?? p.maxTokens ?? 4096;
	if (isOpenAiCloud(p)) body.max_completion_tokens = maxTokens;
	else body.max_tokens = maxTokens;
	const temperature = params.temperature ?? p.temperature;
	if (temperature !== undefined && temperature !== null && !isOpenAiCloud(p))
		body.temperature = temperature;
	if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;

	const send = () =>
		requestUrl({
			url: `${trimSlash(p.baseUrl)}/chat/completions`,
			method: "POST",
			headers,
			body: JSON.stringify(body),
			throw: false,
		});

	let res = await send();
	if (res.status === 400) {
		// Some servers reject optional parameters: retry once without them
		const msg = (res.text || "").toLowerCase();
		let changed = false;
		for (const k of ["reasoning_effort", "temperature"]) {
			if (k in body && msg.includes(k.split("_")[0])) {
				delete body[k];
				changed = true;
			}
		}
		if (msg.includes("max_tokens") && "max_tokens" in body) {
			body.max_completion_tokens = body.max_tokens;
			delete body.max_tokens;
			changed = true;
		}
		if (changed) res = await send();
	}
	if (res.status >= 400) throw errorFromResponse(p, res);

	const data = res.json;
	const choice = data?.choices?.[0];
	let content = choice?.message?.content;
	if (Array.isArray(content)) {
		content = content.map((c: any) => c?.text || "").join("");
	}
	const text = stripThinking(String(content || ""));
	if (!text) {
		if (choice?.finish_reason === "length")
			throw new Error(
				`${p.name}: the model used all ${maxTokens} tokens on reasoning. Raise max tokens or lower the reasoning effort.`
			);
		throw new Error(`${p.name}: empty response from the model.`);
	}
	return text;
}

async function embedOpenAi(p: AiProvider, inputs: string[]): Promise<number[][]> {
	const key = getApiKey(p);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (key) headers.Authorization = `Bearer ${key}`;
	const res = await requestUrl({
		url: `${trimSlash(p.baseUrl)}/embeddings`,
		method: "POST",
		headers,
		body: JSON.stringify({ model: p.embeddingModel, input: inputs }),
		throw: false,
	});
	if (res.status >= 400) throw errorFromResponse(p, res);
	const data = res.json?.data;
	if (!Array.isArray(data)) throw new Error(`${p.name}: bad embeddings response.`);
	return data
		.slice()
		.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
		.map((d: any) => d.embedding as number[]);
}

// ------------------------------------------------------------- anthropic

const ANTHROPIC_VERSION = "2026-10-21";

function anthropicHeaders(p: AiProvider) {
	const key = getApiKey(p);
	if (!key)
		throw new Error(
			`${p.name}: no API key. Set the secret "${p.apiKeySecret}" in the plugin settings.`
		);
	return {
		"Content-Type": "application/json",
		"x-api-key": key,
		"anthropic-version": ANTHROPIC_VERSION,
	} as Record<string, string>;
}

/** Models that accept server-side refusal fallbacks. */
function supportsFallbacks(model: string) {
	return /^claude-(opus-5|sonnet-5-5|fable-5|mythos-5)/.test(model);
}

async function completeAnthropic(p: AiProvider, params: CompleteParams): Promise<string> {
	const headers = anthropicHeaders(p);
	const model = p.model || "claude-opus-5-5";

	// Anthropic has no system role inside messages; merge consecutive roles
	const messages: { role: "user" | "assistant"; content: string }[] = [];
	for (const m of params.messages) {
		if (m.role === "system") continue;
		const last = messages[messages.length - 1];
		if (last && last.role === m.role) last.content += "\n\n" + m.content;
		else messages.push({ role: m.role, content: m.content });
	}
	if (messages.length === 0 || messages[0].role !== "user")
		messages.unshift({ role: "user", content: "(context follows)" });

	const body: Record<string, any> = {
		model,
		max_tokens: params.maxTokens ?? p.maxTokens ?? 16000,
		messages,
	};
	if (params.system) body.system = params.system;
	// Current models take no sampling params; depth is set with effort
	const effort = p.reasoningEffort === "none" ? "low" : p.reasoningEffort;
	if (effort) body.output_config = { effort };
	if (supportsFallbacks(model)) {
		headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
		body.fallbacks = "default";
	}

	const send = () =>
		requestUrl({
			url: `${trimSlash(p.baseUrl || "https://api.anthropic.com")}/v1/messages`,
			method: "POST",
			headers,
			body: JSON.stringify(body),
			throw: false,
		});

	let res = await send();
	if (res.status === 400 && body.fallbacks) {
		// model or account without fallback support: retry plain
		delete body.fallbacks;
		delete headers["anthropic-beta"];
		res = await send();
	}
	if (res.status >= 400) throw errorFromResponse(p, res);

	const data = res.json;
	if (data?.stop_reason === "refusal") {
		const why = data?.stop_details?.explanation || data?.stop_details?.category || "";
		throw new Error(`${p.name}: the model declined this request${why ? ` (${why})` : ""}.`);
	}
	const text = (data?.content || [])
		.filter((b: any) => b?.type === "text")
		.map((b: any) => b.text)
		.join("")
		.trim();
	if (!text) {
		if (data?.stop_reason === "max_tokens")
			throw new Error(`${p.name}: hit max tokens before answering. Raise max tokens.`);
		throw new Error(`${p.name}: empty response.`);
	}
	return text;
}

// ------------------------------------------------------------------- cli

function splitArgs(s: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

function flattenPrompt(params: CompleteParams): string {
	const parts: string[] = [];
	if (params.system) parts.push(`# Instructions\n${params.system}`);
	const convo = params.messages.filter((m) => m.role !== "system");
	if (convo.length === 1) {
		parts.push(convo[0].content);
	} else {
		for (const m of convo) {
			parts.push(`## ${m.role === "user" ? "User" : "Assistant"}\n${m.content}`);
		}
	}
	parts.push(
		"Answer directly in plain text/markdown. Do not run commands, read files or use tools."
	);
	return parts.join("\n\n");
}

async function completeCli(p: AiProvider, params: CompleteParams): Promise<string> {
	if (!Platform.isDesktopApp) throw new Error(`${p.name}: CLI providers work on desktop only.`);
	const req = (window as any).require;
	const cp = req("child_process");
	const os = req("os");
	const path = req("path");
	const fs = req("fs");

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-ai-"));
	const outFile = path.join(tmpDir, "last-message.txt");

	const argList: string[] = [];
	for (const a of splitArgs(p.args || "")) {
		if (a === "{model}") {
			if (p.model) argList.push(p.command?.includes("claude") ? "--model" : "-m", p.model);
			continue;
		}
		argList.push(a.replace("{output}", outFile));
	}

	const home = os.homedir();
	const extraPath = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		`${home}/.local/bin`,
		`${home}/.npm-global/bin`,
		`${home}/.bun/bin`,
		`${home}/.volta/bin`,
	].join(":");
	const env = { ...process.env, PATH: `${process.env.PATH || ""}:${extraPath}` };
	delete (env as any).CLAUDECODE;

	const prompt = flattenPrompt(params);
	const timeoutMs = (p.timeout || 240) * 1000;

	return new Promise<string>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		const child = cp.spawn(p.command || "", argList, { cwd: tmpDir, env });
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			child.kill("SIGTERM");
			reject(new Error(`${p.name}: timed out after ${p.timeout || 240}s.`));
		}, timeoutMs);
		child.stdout.on("data", (d: any) => (stdout += d.toString()));
		child.stderr.on("data", (d: any) => (stderr += d.toString()));
		child.on("error", (err: any) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			reject(
				new Error(
					`${p.name}: could not start "${p.command}" (${err.code || err.message}). Use the absolute path in settings.`
				)
			);
		});
		child.on("close", (code: number) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			let text = "";
			try {
				if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, "utf8");
			} catch (_) {
				/* ignore */
			}
			if (!text) text = stdout;
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch (_) {
				/* ignore */
			}
			text = stripThinking(text);
			if (code !== 0 && !text) {
				reject(new Error(`${p.name}: exited with ${code}. ${stderr.slice(-400)}`));
				return;
			}
			if (!text) {
				reject(new Error(`${p.name}: empty response. ${stderr.slice(-300)}`));
				return;
			}
			resolve(text);
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

// ------------------------------------------------------------ public api

async function completeWith(p: AiProvider, params: CompleteParams): Promise<string> {
	switch (p.type) {
		case "anthropic":
			return completeAnthropic(p, params);
		case "cli":
			return completeCli(p, params);
		case "chatgpt":
			return completeChatGpt(p, params);
		default:
			return completeOpenAi(p, params);
	}
}

async function complete(task: AiTask, params: CompleteParams): Promise<string> {
	return completeWith(providerForTask(task), params);
}

async function embed(inputs: string[]): Promise<number[][]> {
	const p = embeddingProvider();
	if (!p) throw new Error("No embedding provider configured.");
	const out: number[][] = [];
	const BATCH = 64;
	for (let i = 0; i < inputs.length; i += BATCH) {
		const chunk = inputs.slice(i, i + BATCH).map((s) => s.slice(0, 2000));
		out.push(...(await embedOpenAi(p, chunk)));
	}
	return out;
}

async function listModels(p: AiProvider): Promise<string[]> {
	if (p.type === "cli") return [];
	if (p.type === "chatgpt") return listChatGptModels(p);
	if (p.type === "anthropic") {
		const res = await requestUrl({
			url: `${trimSlash(p.baseUrl || "https://api.anthropic.com")}/v1/models?limit=100`,
			headers: anthropicHeaders(p),
			throw: false,
		});
		if (res.status >= 400) throw errorFromResponse(p, res);
		return (res.json?.data || []).map((m: any) => m.id);
	}
	const key = getApiKey(p);
	const headers: Record<string, string> = {};
	if (key) headers.Authorization = `Bearer ${key}`;
	const res = await requestUrl({
		url: `${trimSlash(p.baseUrl)}/models`,
		headers,
		throw: false,
	});
	if (res.status >= 400) throw errorFromResponse(p, res);
	const data = res.json?.data ?? res.json?.models ?? [];
	return data.map((m: any) => m.id || m.name).filter(Boolean);
}

async function testProvider(p: AiProvider): Promise<string> {
	const started = Date.now();
	const text = await completeWith(p, {
		system: "You are a connectivity check.",
		messages: [{ role: "user", content: "Reply with the single word: OK" }],
		maxTokens: p.type === "anthropic" ? 2000 : 400,
	});
	return `${text.slice(0, 60)} (${((Date.now() - started) / 1000).toFixed(1)}s)`;
}

export {
	setAiApp,
	complete,
	completeWith,
	embed,
	listModels,
	testProvider,
	getProviders,
	getProvider,
	providerForTask,
	embeddingProvider,
	getApiKey,
};
export type { ChatMessage, CompleteParams };
