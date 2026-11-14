/**
 * Prompts for the graph-based AI features. They take the same inputs the
 * InfraNodus `aiAdvice` endpoint took (prompt, promptGraph, promptContext)
 * so the existing prompt builders keep working.
 */
import { SETTINGS } from "src/settings";

const SYSTEM = `You are a research assistant working on a text network graph built from the user's own notes.
In the graph, concepts are nodes, links mean the concepts appear close together in the text, topics are clusters of densely connected concepts, and gaps are important topics that are only weakly connected to each other.
Ground every answer in the graph and the excerpts provided. Do not invent facts about the user or their notes. Be specific and concise; write in Markdown.`;

function languageRule(): string {
	const lang = (SETTINGS.AI_RESPONSE_LANGUAGE || "").trim();
	return lang
		? `Respond in ${lang}.`
		: "Respond in the same language as the source text.";
}

interface AdviceInput {
	mode: string;
	prompt: string;
	promptGraph?: string;
	promptContext?: string;
	transcend?: boolean;
}

const ALT_SEPARATOR = "-----";

function section(title: string, body?: string) {
	return body && body.trim() ? `### ${title}\n${body.trim()}\n\n` : "";
}

function buildAdvicePrompt(input: AdviceInput): { system: string; user: string; alternatives: boolean } {
	const graph = section("Graph (topics, concepts and their relations)", input.promptGraph);
	const context = section("Excerpts from the notes", input.promptContext);
	const focus = section("Focus", input.prompt);
	const lang = languageRule();
	const alt = `Give exactly 3 distinct alternatives. Separate them with a line containing only ${ALT_SEPARATOR}. No preamble, no numbering.`;

	switch (input.mode) {
		case "question":
			return {
				system: SYSTEM,
				alternatives: true,
				user: `${focus}${graph}${context}Task: write a thought-provoking research question that bridges the topics above — the structural gap in this discourse. Name the concepts it connects, then add one or two sentences on why the connection is worth exploring.
${alt}
${lang}`,
			};
		case "develop":
			return {
				system: SYSTEM,
				alternatives: true,
				user: `${focus}${graph}${context}Task: propose an idea that develops this discourse further by combining the topics above in a non-obvious way. State the idea in one bold sentence, then explain it in two or three sentences using the concepts from the graph.
${alt}
${lang}`,
			};
		case "transcend":
			return {
				system: SYSTEM,
				alternatives: true,
				user: `${focus}${graph}${context}Task: propose an idea that goes beyond this discourse — connect the topics above to a field, perspective or concept that is absent from the notes. State the idea in one bold sentence, then explain in two or three sentences what it adds.
${alt}
${lang}`,
			};
		case "graph summary":
			return {
				system: SYSTEM,
				alternatives: false,
				user: `${graph}${context}${focus}Task: summarize this discourse topic by topic. For each topic write a short heading with a fitting name and two or three sentences based on the excerpts. Finish with one paragraph on how the topics relate and where the most interesting gap is.
${lang}`,
			};
		case "summary":
		default:
			return {
				system: SYSTEM,
				alternatives: false,
				user: `${focus}${graph}${context}Task: write a concise summary of this content organized around its main topics (5–8 bullet points, each naming the key concepts it covers). Then add one line on what seems to be missing.
${lang}`,
			};
	}
}

function splitAlternatives(text: string): string[] {
	let parts = text
		.split(/^\s*-{3,}\s*$/m)
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length <= 1) {
		// fall back to a numbered list
		const numbered = text
			.split(/^\s*(?:\d+[.)]|#{1,3}\s*\d+[.)]?)\s+/m)
			.map((s) => s.trim())
			.filter(Boolean);
		if (numbered.length > 1) parts = numbered;
	}
	return parts.length > 0 ? parts : [text.trim()];
}

function buildTopicNamesPrompt(params: {
	clusters: { id: string; words: string[] }[];
	statements: { community: string; content: string }[];
}): { system: string; user: string } {
	const list = params.clusters
		.map((c, i) => {
			const ex = params.statements
				.filter((s) => s.community == c.id)
				.map((s) => s.content.slice(0, 280))
				.slice(0, 1)
				.join(" ");
			return `${i + 1}. concepts: ${c.words.slice(0, 9).join(", ")}${
				ex ? `\n   example: ${ex}` : ""
			}`;
		})
		.join("\n");
	return {
		system:
			"You name topical clusters from a text network graph. Reply with a numbered list only: one line per cluster, same order, 2–4 word title-case names, no explanations.",
		user: `Name each cluster:\n${list}\n\n${languageRule()}`,
	};
}

function parseTopicNames(text: string, count: number): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const named = lines
		.filter((l) => /^\d+[.)]\s*/.test(l))
		.map((l) => l.replace(/^\d+[.)]\s*/, ""));
	const source = named.length >= Math.min(count, 1) ? named : lines;
	return Array.from({ length: count }, (_, i) =>
		(source[i] || "")
			.replace(/^\*\*|\*\*$/g, "")
			.replace(/^["“]|["”]$/g, "")
			.replace(/\s+[—–-]\s+.*$/, "")
			.trim()
	);
}

function buildChatSystem(graphContext: string): string {
	return `${SYSTEM}
${graphContext ? `\n### Graph of the notes\n${graphContext}\n` : ""}
${languageRule()}`;
}

export {
	buildAdvicePrompt,
	splitAlternatives,
	buildTopicNamesPrompt,
	parseTopicNames,
	buildChatSystem,
	SYSTEM,
};
