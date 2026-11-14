/**
 * ChatGPT subscription over OAuth ("Sign in with ChatGPT").
 *
 * Uses the same public OAuth client (PKCE, localhost:1455 callback) and the
 * same Responses backend as the Codex CLI, so requests count against your
 * ChatGPT plan instead of an API key. The plugin keeps its own sign-in,
 * separate from the Codex CLI's, so refreshing one never logs out the other.
 *
 * Tokens live in Obsidian's secret storage (system keychain), never in the
 * plugin's data.json. Sign-in needs the desktop app (local callback server).
 */
import { App, Platform, requestUrl, RequestUrlResponse } from "obsidian";
import type { AiProvider } from "./types";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Sent to /models; the backend filters models by client version */
const CLIENT_VERSION = "0.167.0";
const ORIGINATOR = "codex_cli_rs";
const SECRET_ID = "chatgpt-oauth";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh when the access token has less than this left */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface ChatGptTokens {
	access_token: string;
	refresh_token: string;
	id_token?: string;
	account_id: string;
	/** epoch ms */
	expires_at: number;
	email?: string;
	plan?: string;
}

interface ChatGptAccount {
	email?: string;
	plan?: string;
	accountId: string;
}

interface Msg {
	role: "system" | "user" | "assistant";
	content: string;
}

let appRef: App | null = null;
function setChatGptApp(app: App) {
	appRef = app;
}

// ------------------------------------------------------------ storage

function storage() {
	const s = (appRef as any)?.secretStorage;
	if (!s) throw new Error("ChatGPT sign-in needs Obsidian 1.11.4 or newer (secret storage).");
	return s as { getSecret(id: string): string | null; setSecret(id: string, v: string): void };
}

function loadTokens(): ChatGptTokens | null {
	try {
		const raw = storage().getSecret(SECRET_ID);
		if (!raw) return null;
		const t = JSON.parse(raw);
		return t?.access_token && t?.refresh_token ? (t as ChatGptTokens) : null;
	} catch (_) {
		return null;
	}
}

function saveTokens(t: ChatGptTokens | null) {
	storage().setSecret(SECRET_ID, t ? JSON.stringify(t) : "");
}

function getChatGptAccount(): ChatGptAccount | null {
	const t = loadTokens();
	return t ? { email: t.email, plan: t.plan, accountId: t.account_id } : null;
}

function signOutChatGpt() {
	saveTokens(null);
}

// --------------------------------------------------------------- utils

function b64url(bytes: Uint8Array): string {
	let s = "";
	bytes.forEach((b) => (s += String.fromCharCode(b)));
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64(n: number) {
	return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256B64(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return b64url(new Uint8Array(digest));
}

function jwtClaims(jwt?: string): Record<string, any> {
	if (!jwt) return {};
	try {
		const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
		const json = decodeURIComponent(
			atob(part + "=".repeat((4 - (part.length % 4)) % 4))
				.split("")
				.map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
				.join("")
		);
		return JSON.parse(json);
	} catch (_) {
		return {};
	}
}

function uuid() {
	return (crypto as any).randomUUID
		? (crypto as any).randomUUID()
		: randomB64(16);
}

/** Build the stored token record from a token-endpoint response. */
function toTokens(res: any, prev?: ChatGptTokens | null): ChatGptTokens {
	const access = res.access_token || prev?.access_token;
	const idToken = res.id_token || prev?.id_token;
	const refresh = res.refresh_token || prev?.refresh_token;
	if (!access || !refresh) throw new Error("ChatGPT: the sign-in response had no tokens.");
	const idc = jwtClaims(idToken);
	const atc = jwtClaims(access);
	const auth = idc["https://api.openai.com/auth"] || atc["https://api.openai.com/auth"] || {};
	const accountId = auth.chatgpt_account_id || prev?.account_id || "";
	if (!accountId)
		throw new Error("ChatGPT: no ChatGPT account on this login. Sign in with an account that has a ChatGPT plan.");
	const exp = atc.exp
		? atc.exp * 1000
		: Date.now() + (Number(res.expires_in) || 3600) * 1000;
	return {
		access_token: access,
		refresh_token: refresh,
		id_token: idToken,
		account_id: accountId,
		expires_at: exp,
		email: idc.email || idc["https://api.openai.com/profile"]?.email || prev?.email,
		plan: auth.chatgpt_plan_type || prev?.plan,
	};
}

function oauthError(prefix: string, res: RequestUrlResponse) {
	let detail = "";
	try {
		const j = res.json;
		detail = j?.error_description || j?.error?.message || j?.error || j?.message || "";
	} catch (_) {
		detail = (res.text || "").slice(0, 200);
	}
	if (typeof detail !== "string") detail = JSON.stringify(detail);
	return new Error(`${prefix}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
}

// --------------------------------------------------------------- login

let activeLogin: { cancel: () => void } | null = null;

function page(title: string, body: string) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}
@media(prefers-color-scheme:dark){body{background:#1e1e1e;color:#ddd}}</style></head>
<body><h2>${title}</h2><p>${body}</p></body></html>`;
}

async function exchangeCode(code: string, verifier: string): Promise<ChatGptTokens> {
	const res = await requestUrl({
		url: `${ISSUER}/oauth/token`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: CLIENT_ID,
			code_verifier: verifier,
		}).toString(),
		throw: false,
	});
	if (res.status >= 400) throw oauthError("ChatGPT sign-in", res);
	return toTokens(res.json);
}

/**
 * Opens the ChatGPT sign-in page in the browser and waits for the redirect
 * to http://localhost:1455/auth/callback.
 */
async function signInChatGpt(): Promise<ChatGptAccount> {
	if (!Platform.isDesktopApp) throw new Error("ChatGPT sign-in works in the desktop app only.");
	activeLogin?.cancel();

	const http = (window as any).require("http");
	const verifier = randomB64(64);
	const challenge = await sha256B64(verifier);
	const state = randomB64(32);
	const authUrl =
		`${ISSUER}/oauth/authorize?` +
		new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			state,
			originator: ORIGINATOR,
		}).toString();

	return new Promise<ChatGptAccount>((resolve, reject) => {
		let finished = false;
		const server = http.createServer(async (req: any, res: any) => {
			const url = new URL(req.url || "/", REDIRECT_URI);
			const reply = (status: number, title: string, body: string) => {
				res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
				res.end(page(title, body));
			};
			if (url.pathname === "/cancel") {
				reply(200, "Sign-in cancelled", "You can close this tab.");
				finish(new Error("ChatGPT sign-in was cancelled."));
				return;
			}
			if (url.pathname !== "/auth/callback") {
				res.writeHead(404);
				res.end();
				return;
			}
			if (url.searchParams.get("state") !== state) {
				reply(400, "Sign-in failed", "The response did not match this sign-in attempt. Start again from Obsidian.");
				finish(new Error("ChatGPT sign-in: state mismatch. Try again."));
				return;
			}
			const err = url.searchParams.get("error");
			if (err) {
				const desc = url.searchParams.get("error_description") || err;
				reply(400, "Sign-in failed", desc);
				finish(new Error(`ChatGPT sign-in: ${desc}`));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				reply(400, "Sign-in failed", "No authorization code was returned.");
				finish(new Error("ChatGPT sign-in: no authorization code."));
				return;
			}
			try {
				const tokens = await exchangeCode(code, verifier);
				saveTokens(tokens);
				reply(200, "Signed in to ChatGPT", "Obsidian is connected. You can close this tab and go back to Obsidian.");
				finish(null, { email: tokens.email, plan: tokens.plan, accountId: tokens.account_id });
			} catch (e) {
				reply(500, "Sign-in failed", String(e.message || e));
				finish(e);
			}
		});

		const timer = window.setTimeout(
			() => finish(new Error("ChatGPT sign-in timed out after 5 minutes.")),
			LOGIN_TIMEOUT_MS
		);

		function finish(err: Error | null, account?: ChatGptAccount) {
			if (finished) return;
			finished = true;
			window.clearTimeout(timer);
			activeLogin = null;
			try {
				server.close();
				// let the confirmation page flush before dropping sockets
				window.setTimeout(() => server.closeAllConnections?.(), 2000);
			} catch (_) {
				/* already closed */
			}
			if (err) reject(err);
			else resolve(account!);
		}

		activeLogin = { cancel: () => finish(new Error("ChatGPT sign-in was replaced by a new attempt.")) };

		server.on("error", (e: any) => {
			finish(
				e?.code === "EADDRINUSE"
					? new Error(
							"ChatGPT sign-in: port 1455 is busy (another sign-in, e.g. `codex login`, is running). Finish or close it and try again."
					  )
					: e
			);
		});
		server.listen(CALLBACK_PORT, "127.0.0.1", () => {
			window.open(authUrl);
		});
	});
}

// ------------------------------------------------------------- refresh

let refreshing: Promise<ChatGptTokens> | null = null;

async function refreshTokens(prev: ChatGptTokens): Promise<ChatGptTokens> {
	const res = await requestUrl({
		url: `${ISSUER}/oauth/token`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({
			client_id: CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: prev.refresh_token,
			scope: "openid profile email",
		}),
		throw: false,
	});
	if (res.status >= 400) {
		if (res.status === 400 || res.status === 401) {
			saveTokens(null);
			throw new Error("ChatGPT: your sign-in expired. Sign in again in the plugin settings.");
		}
		throw oauthError("ChatGPT token refresh", res);
	}
	const next = toTokens(res.json, prev);
	saveTokens(next);
	return next;
}

async function validTokens(force = false): Promise<ChatGptTokens> {
	const t = loadTokens();
	if (!t) throw new Error("ChatGPT: not signed in. Open the plugin settings → Providers → ChatGPT → Sign in.");
	if (!force && t.expires_at - Date.now() > REFRESH_MARGIN_MS) return t;
	if (!refreshing) {
		refreshing = refreshTokens(t).finally(() => {
			refreshing = null;
		});
	}
	return refreshing;
}

// ---------------------------------------------------------------- calls

function headersFor(t: ChatGptTokens, sessionId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${t.access_token}`,
		"chatgpt-account-id": t.account_id,
		"OpenAI-Beta": "responses=experimental",
		originator: ORIGINATOR,
		session_id: sessionId,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	};
}

function apiError(p: AiProvider, res: RequestUrlResponse): Error {
	let j: any = null;
	try {
		j = res.json;
	} catch (_) {
		/* not json */
	}
	const e = j?.error || j?.detail || j;
	if (res.status === 429 || e?.type === "usage_limit_reached") {
		const secs = Number(e?.resets_in_seconds);
		const when = secs > 0 ? ` Resets in ~${Math.ceil(secs / 60)} min.` : "";
		return new Error(`${p.name}: ChatGPT usage limit reached${e?.plan_type ? ` (${e.plan_type} plan)` : ""}.${when}`);
	}
	let detail = typeof e === "string" ? e : e?.message || "";
	if (!detail) detail = (res.text || "").slice(0, 300);
	return new Error(`${p.name}: HTTP ${res.status} — ${detail}`);
}

function toInput(messages: Msg[]) {
	return messages.map((m) => ({
		type: "message",
		role: m.role === "system" ? "developer" : m.role,
		content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
	}));
}

/** Pull the answer out of a buffered server-sent-event stream. */
function parseSse(p: AiProvider, text: string): string {
	let deltas = "";
	let finalText = "";
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		let ev: any;
		try {
			ev = JSON.parse(data);
		} catch (_) {
			continue;
		}
		switch (ev.type) {
			case "response.output_text.delta":
				deltas += ev.delta || "";
				break;
			case "response.completed":
			case "response.done": {
				const out = ev.response?.output || [];
				finalText = out
					.filter((o: any) => o?.type === "message")
					.flatMap((o: any) => o.content || [])
					.filter((c: any) => c?.type === "output_text")
					.map((c: any) => c.text || "")
					.join("");
				break;
			}
			case "response.incomplete": {
				const why = ev.response?.incomplete_details?.reason || "incomplete";
				if (!deltas) throw new Error(`${p.name}: response incomplete (${why}).`);
				break;
			}
			case "response.failed":
			case "error": {
				const err = ev.response?.error || ev.error || ev;
				throw new Error(`${p.name}: ${err?.message || err?.code || "request failed"}`);
			}
		}
	}
	return (finalText || deltas).trim();
}

async function completeChatGpt(
	p: AiProvider,
	params: { system?: string; messages: Msg[] }
): Promise<string> {
	const sessionId = uuid();
	const body: Record<string, any> = {
		model: p.model || "gpt-6.1-sol",
		instructions: params.system || "You are a helpful assistant.",
		input: toInput(params.messages),
		tools: [],
		tool_choice: "auto",
		parallel_tool_calls: false,
		store: false,
		stream: true,
		include: [],
		prompt_cache_key: sessionId,
	};
	const effort = p.reasoningEffort === "none" ? "low" : p.reasoningEffort;
	if (effort) body.reasoning = { effort };

	const send = (t: ChatGptTokens) =>
		requestUrl({
			url: `${(p.baseUrl || CHATGPT_BASE_URL).replace(/\/+$/, "")}/responses`,
			method: "POST",
			headers: headersFor(t, sessionId),
			body: JSON.stringify(body),
			throw: false,
		});

	let tokens = await validTokens();
	let res = await send(tokens);
	if (res.status === 401) {
		tokens = await validTokens(true);
		res = await send(tokens);
	}
	// Backend insists on its own model instructions: send those as
	// `instructions` and ours as a developer message instead
	if (res.status === 400 && /instruction/i.test(res.text || "")) {
		const official = await modelInstructions(p, body.model).catch(() => "");
		if (official) {
			body.instructions = official;
			body.input = toInput([
				{ role: "system", content: params.system || "You are a helpful assistant." },
				...params.messages,
			]);
			res = await send(tokens);
		}
	}
	// Drop a parameter the backend says it doesn't support, once
	if (res.status === 400) {
		const m = /unsupported parameter:?\s*'?([a-z_.]+)/i.exec(res.text || "");
		const key = m?.[1]?.split(".")[0];
		if (key && key in body && key !== "model" && key !== "input") {
			delete body[key];
			res = await send(tokens);
		}
	}
	if (res.status >= 400) throw apiError(p, res);

	const text = parseSse(p, res.text || "");
	if (!text) throw new Error(`${p.name}: empty response from ChatGPT.`);
	return text;
}

async function fetchModels(p: AiProvider): Promise<any[]> {
	const t = await validTokens();
	const res = await requestUrl({
		url: `${(p.baseUrl || CHATGPT_BASE_URL).replace(/\/+$/, "")}/models?client_version=${CLIENT_VERSION}`,
		headers: { ...headersFor(t, uuid()), Accept: "application/json" },
		throw: false,
	});
	if (res.status >= 400) throw apiError(p, res);
	return res.json?.models || res.json?.data || [];
}

const instructionsCache = new Map<string, string>();

async function modelInstructions(p: AiProvider, model: string): Promise<string> {
	if (instructionsCache.has(model)) return instructionsCache.get(model)!;
	const info = (await fetchModels(p)).find((m) => (m.slug || m.id) === model);
	const text = info?.base_instructions || info?.model_messages?.instructions_template || "";
	if (text) instructionsCache.set(model, text);
	return text;
}

async function listChatGptModels(p: AiProvider): Promise<string[]> {
	const models = await fetchModels(p);
	return models
		.filter((m) => m && m.visibility !== "hide")
		.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
		.map((m) => m.slug || m.id)
		.filter(Boolean);
}

export {
	CHATGPT_BASE_URL,
	setChatGptApp,
	signInChatGpt,
	signOutChatGpt,
	getChatGptAccount,
	completeChatGpt,
	listChatGptModels,
};
export type { ChatGptAccount };
