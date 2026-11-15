/**
 * Settings UI for AI providers and task routing.
 */
import { App, Menu, Notice, Setting } from "obsidian";
import * as obsidian from "obsidian";
import { SETTINGS } from ".";
import {
	AiProvider,
	AiTask,
	DEFAULT_ROUTES,
	KEYWORD_SEARCH,
	PROVIDER_PRESETS,
	TASK_LABELS,
	newProviderId,
} from "src/ai/types";
import { getProviders, listModels, testProvider } from "src/ai/client";
import { getChatGptAccount, signInChatGpt, signOutChatGpt } from "src/ai/chatgpt";

type Save = (settings: any) => Promise<void>;

function renderAiSettings(params: {
	containerEl: HTMLElement;
	app: App;
	save: Save;
	refresh: () => void;
}) {
	const { containerEl, app, save, refresh } = params;
	const providers: AiProvider[] = getProviders().map((p) => ({ ...p }));
	const persist = async () => {
		await save({ AI_PROVIDERS: providers.map((p) => ({ ...p })) });
	};

	new Setting(containerEl).setName("AI").setHeading();
	const intro = containerEl.createEl("p", { cls: "setting-item-description" });
	intro.setText(
		"The graph is built locally. AI requests go only to the providers you add here: local servers (LiteLLM, LM Studio, Ollama), API keys (Claude, OpenAI, Grok) your ChatGPT plan (sign in with ChatGPT) or subscription CLIs (Codex, Claude Code). Keys and sign-ins are kept in Obsidian's secret storage, not in the plugin data."
	);

	// --------------------------------------------------- routing
	new Setting(containerEl).setName("Which AI does what").setHeading();
	const routes: Record<string, string> = {
		...DEFAULT_ROUTES,
		...(SETTINGS.AI_ROUTES || {}),
	};
	(Object.keys(TASK_LABELS) as AiTask[]).forEach((task) => {
		new Setting(containerEl)
			.setName(TASK_LABELS[task].name)
			.setDesc(TASK_LABELS[task].desc)
			.addDropdown((dd) => {
				if (task === "embeddings") dd.addOption(KEYWORD_SEARCH, "Keyword search (no AI)");
				for (const p of providers) {
					if (task === "embeddings" && p.type !== "openai") continue;
					dd.addOption(p.id, task === "embeddings" ? `${p.name} · ${p.embeddingModel || "no embedding model"}` : p.name);
				}
				dd.setValue(routes[task] || "");
				dd.onChange(async (v) => {
					routes[task] = v;
					await save({ AI_ROUTES: { ...routes } });
				});
			});
	});

	new Setting(containerEl)
		.setName("Response language")
		.setDesc("Blank = same language as your notes.")
		.addText((t) =>
			t
				.setPlaceholder("e.g. English")
				.setValue(SETTINGS.AI_RESPONSE_LANGUAGE || "")
				.onChange(async (v) => save({ AI_RESPONSE_LANGUAGE: v.trim() }))
		);

	new Setting(containerEl)
		.setName("Name topics with AI")
		.setDesc("Ask the topic-names AI to title each cluster after the graph is built.")
		.addToggle((t) =>
			t
				.setValue(SETTINGS.AI_NAME_TOPICS !== "no")
				.onChange(async (v) => save({ AI_NAME_TOPICS: v ? "yes" : "no" }))
		);

	new Setting(containerEl)
		.setName("Max context size")
		.setDesc("Characters of excerpts sent with insight prompts. Lower it for small local context windows.")
		.addText((t) =>
			t.setValue(String(SETTINGS.AI_MAX_CONTEXT_CHARS || 40000)).onChange(async (v) => {
				const n = parseInt(v, 10);
				if (!isNaN(n) && n > 1000) await save({ AI_MAX_CONTEXT_CHARS: n });
			})
		);

	// ------------------------------------------------- providers
	new Setting(containerEl).setName("Providers").setHeading();

	providers.forEach((p, idx) => {
		const box = containerEl.createEl("details", { cls: "graph-ai-provider" });
		box.style.border = "1px solid var(--background-modifier-border)";
		box.style.borderRadius = "8px";
		box.style.padding = "4px 12px";
		box.style.marginBottom = "8px";
		const summary = box.createEl("summary");
		summary.style.cursor = "pointer";
		summary.style.padding = "6px 0";
		const kind =
			p.type === "cli"
				? "subscription CLI"
				: p.type === "chatgpt"
				? "ChatGPT sign-in"
				: p.type === "anthropic"
				? "Anthropic API"
				: "OpenAI-compatible";
		summary.setText(`${p.name}  ·  ${kind}${p.model ? `  ·  ${p.model}` : ""}`);

		new Setting(box).setName("Name").addText((t) =>
			t.setValue(p.name).onChange(async (v) => {
				p.name = v;
				await persist();
			})
		);

		if (p.type === "chatgpt") {
			const account = getChatGptAccount();
			const accountSetting = new Setting(box)
				.setName("ChatGPT account")
				.setDesc(
					account
						? `Signed in${account.email ? ` as ${account.email}` : ""}${account.plan ? ` · ${account.plan} plan` : ""}. Shared by every ChatGPT provider in this vault.`
						: "Not signed in. Opens chatgpt.com in your browser; the sign-in is stored in the system keychain."
				);
			accountSetting.addButton((b) => {
				b.setButtonText(account ? "Sign in again" : "Sign in with ChatGPT");
				if (!account) b.setCta();
				b.onClick(async () => {
					b.setDisabled(true);
					b.setButtonText("Waiting for browser…");
					try {
						const acc = await signInChatGpt();
						new Notice(`ChatGPT connected${acc.email ? `: ${acc.email}` : ""}.`, 6000);
						refresh();
					} catch (err) {
						new Notice(String(err.message || err), 10000);
						b.setDisabled(false);
						b.setButtonText(account ? "Sign in again" : "Sign in with ChatGPT");
					}
				});
			});
			if (account) {
				accountSetting.addButton((b) =>
					b.setButtonText("Sign out").onClick(() => {
						signOutChatGpt();
						new Notice("Signed out of ChatGPT.");
						refresh();
					})
				);
			}
		}

		if (p.type === "openai" || p.type === "anthropic") {
			new Setting(box)
				.setName("Base URL")
				.setDesc(p.type === "anthropic" ? "https://api.anthropic.com" : "OpenAI style, ends with /v1")
				.addText((t) =>
					t.setValue(p.baseUrl).onChange(async (v) => {
						p.baseUrl = v.trim();
						await persist();
					})
				);

			const keySetting = new Setting(box)
				.setName("API key")
				.setDesc(
					p.type === "anthropic" || /openai\.com|x\.ai|openrouter/.test(p.baseUrl)
						? "Pick or create a secret (stored in the system keychain)."
						: "Usually not needed for local servers."
				);
			const SecretComponent = (obsidian as any).SecretComponent;
			if (SecretComponent && (app as any).secretStorage) {
				keySetting.addComponent((el: HTMLElement) =>
					new SecretComponent(app, el).setValue(p.apiKeySecret || "").onChange(async (v: string) => {
						p.apiKeySecret = v;
						await persist();
					})
				);
			} else {
				keySetting.addText((t) => {
					t.inputEl.type = "password";
					t.setValue(p.apiKey || "").onChange(async (v) => {
						p.apiKey = v.trim();
						await persist();
					});
				});
			}
		}

		const modelSetting = new Setting(box)
			.setName("Model")
			.setDesc(
				p.type === "cli"
					? "Optional; blank = the CLI's default model."
					: p.type === "chatgpt"
					? "A model your ChatGPT plan offers, e.g. gpt-6.1-sol (workhorse) or gpt-6-luna (fast)."
					: "Blank = first model the server lists."
			);
		let modelInput: obsidian.TextComponent | null = null;
		modelSetting.addText((t) => {
			modelInput = t;
			t.setValue(p.model || "").onChange(async (v) => {
				p.model = v.trim();
				await persist();
			});
		});
		if (p.type !== "cli") {
			modelSetting.addExtraButton((b) =>
				b
					.setIcon("list")
					.setTooltip("Choose from the provider's models")
					.onClick(async () => {
						try {
							const models = await listModels(p);
							if (models.length === 0) return new Notice("No models returned.");
							const menu = new Menu();
							models
								.filter((m) => !/embed/i.test(m))
								.slice(0, 60)
								.forEach((m) =>
									menu.addItem((i) =>
										i.setTitle(m).onClick(async () => {
											p.model = m;
											modelInput?.setValue(m);
											await persist();
										})
									)
								);
							menu.showAtMouseEvent((window.event as MouseEvent) || new MouseEvent("click"));
						} catch (err) {
							new Notice(String(err.message || err), 8000);
						}
					})
			);
		}

		if (p.type === "openai") {
			let embInput: obsidian.TextComponent | null = null;
			new Setting(box)
				.setName("Embedding model")
				.setDesc("For semantic search in chat (e.g. nomic-embed-text). Blank = not used.")
				.addText((t) => {
					embInput = t;
					t.setValue(p.embeddingModel || "").onChange(async (v) => {
						p.embeddingModel = v.trim();
						await persist();
					});
				})
				.addExtraButton((b) =>
					b
						.setIcon("list")
						.setTooltip("Choose an embedding model")
						.onClick(async () => {
							try {
								const models = (await listModels(p)).filter((m) => /embed/i.test(m));
								if (models.length === 0) return new Notice("No embedding models found on this server.");
								const menu = new Menu();
								models.forEach((m) =>
									menu.addItem((i) =>
										i.setTitle(m).onClick(async () => {
											p.embeddingModel = m;
											embInput?.setValue(m);
											await persist();
										})
									)
								);
								menu.showAtMouseEvent((window.event as MouseEvent) || new MouseEvent("click"));
							} catch (err) {
								new Notice(String(err.message || err), 8000);
							}
						})
				);
		}

		if (p.type !== "cli") {
			new Setting(box)
				.setName("Reasoning effort")
				.setDesc(
					p.type === "anthropic"
						? "Claude effort level (none = low)."
						: p.type === "chatgpt"
						? "How long the model thinks. Low is fastest."
						: "Sent as reasoning_effort. 'none' turns thinking off on Qwen3-style local models (much faster)."
				)
				.addDropdown((dd) => {
					dd.addOption("", "Model default");
					if (p.type !== "chatgpt") dd.addOption("none", "None");
					dd.addOption("low", "Low")
						.addOption("medium", "Medium")
						.addOption("high", "High")
						.setValue(p.type === "chatgpt" && p.reasoningEffort === "none" ? "low" : p.reasoningEffort || "")
						.onChange(async (v) => {
							p.reasoningEffort = v as any;
							await persist();
						});
				});
		}

		if (p.type === "openai" || p.type === "anthropic") {
			new Setting(box).setName("Max output tokens").addText((t) =>
				t.setValue(String(p.maxTokens ?? "")).onChange(async (v) => {
					const n = parseInt(v, 10);
					p.maxTokens = isNaN(n) ? undefined : n;
					await persist();
				})
			);
		}

		if (p.type === "openai") {
			new Setting(box)
				.setName("Temperature")
				.setDesc("Blank = server default. Ignored for OpenAI reasoning models.")
				.addText((t) =>
					t.setValue(p.temperature === undefined ? "" : String(p.temperature)).onChange(async (v) => {
						const n = parseFloat(v);
						p.temperature = isNaN(n) ? undefined : n;
						await persist();
					})
				);
		}

		if (p.type === "cli") {
			new Setting(box)
				.setName("Command")
				.setDesc("Executable name or absolute path (e.g. /opt/homebrew/bin/codex).")
				.addText((t) =>
					t.setValue(p.command || "").onChange(async (v) => {
						p.command = v.trim();
						await persist();
					})
				);
			new Setting(box)
				.setName("Arguments")
				.setDesc("The prompt is sent on stdin. Placeholders: {model}, {output} (file the CLI writes its answer to).")
				.addTextArea((t) => {
					t.inputEl.rows = 2;
					t.inputEl.style.width = "100%";
					t.setValue(p.args || "").onChange(async (v) => {
						p.args = v.trim();
						await persist();
					});
				});
			new Setting(box).setName("Timeout (seconds)").addText((t) =>
				t.setValue(String(p.timeout ?? 240)).onChange(async (v) => {
					const n = parseInt(v, 10);
					p.timeout = isNaN(n) ? 240 : n;
					await persist();
				})
			);
		}

		new Setting(box)
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true);
					b.setButtonText("Testing…");
					try {
						const res = await testProvider(p);
						new Notice(`${p.name}: ${res}`, 6000);
					} catch (err) {
						new Notice(String(err.message || err), 10000);
					}
					b.setDisabled(false);
					b.setButtonText("Test");
				})
			)
			.addButton((b) =>
				b
					.setButtonText("Delete")
					.setWarning()
					.onClick(async () => {
						if (providers.length <= 1) return new Notice("Keep at least one provider.");
						providers.splice(idx, 1);
						const fallback = providers[0].id;
						for (const task of Object.keys(routes)) {
							if (routes[task] === p.id) routes[task] = task === "embeddings" ? KEYWORD_SEARCH : fallback;
						}
						await save({ AI_PROVIDERS: providers, AI_ROUTES: { ...routes } });
						refresh();
					})
			);
	});

	let presetKey = PROVIDER_PRESETS[0].key;
	new Setting(containerEl)
		.setName("Add a provider")
		.setDesc("Start from a preset, then adjust.")
		.addDropdown((dd) => {
			for (const preset of PROVIDER_PRESETS) dd.addOption(preset.key, preset.label);
			dd.setValue(presetKey).onChange((v) => (presetKey = v));
		})
		.addButton((b) =>
			b
				.setButtonText("Add")
				.setCta()
				.onClick(async () => {
					const preset = PROVIDER_PRESETS.find((x) => x.key === presetKey)!;
					providers.push({ id: newProviderId(), ...preset.make() });
					await persist();
					refresh();
				})
		);
}

export { renderAiSettings };
