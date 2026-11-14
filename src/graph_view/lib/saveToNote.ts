/**
 * Save AI output and graph reports as notes in the vault
 * (replaces "save to InfraNodus").
 */
import { App, normalizePath, Notice, TFile } from "obsidian";
import { SETTINGS } from "src/settings";
import type { AnswerInfraNodusTopics } from "src/types/messaging";
import type { InfraNodusExtractedGraphData } from "src/infranodus/types";

function safeName(s: string) {
	return s
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

function stamp() {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

async function ensureFolder(app: App, folder: string) {
	if (!folder) return;
	const parts = normalizePath(folder).split("/");
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) {
			await app.vault.createFolder(cur).catch(() => {});
		}
	}
}

async function createNote(app: App, baseName: string, content: string): Promise<TFile> {
	const folder = (SETTINGS.SAVE_FOLDER || "").trim().replace(/^\/+|\/+$/g, "");
	await ensureFolder(app, folder);
	const name = safeName(baseName) || "Graph note";
	let path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
	let i = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(folder ? `${folder}/${name} ${i}.md` : `${name} ${i}.md`);
		i++;
	}
	const file = await app.vault.create(path, content);
	await app.workspace.getLeaf("tab").openFile(file);
	new Notice(`Saved to ${path}`);
	return file;
}

function sourceLink(app: App, sourcePath?: string) {
	if (!sourcePath) return "";
	const f = app.vault.getAbstractFileByPath(sourcePath);
	if (f instanceof TFile) return `[[${f.basename}]]`;
	return sourcePath;
}

async function saveTextToNote(params: {
	app: App;
	text: string;
	kind: string;
	sourcePath?: string;
	context?: string;
}) {
	if (!params.text || params.text.startsWith("ai generating")) return;
	const src = sourceLink(params.app, params.sourcePath);
	const content = `---
created: ${new Date().toISOString().slice(0, 10)}
tags: [graph-ai]
---

${src ? `Source: ${src}\n` : ""}${params.context ? `Focus: ${params.context}\n` : ""}
${params.text.trim()}
`;
	const title = `${params.kind} – ${
		params.sourcePath ? params.sourcePath.split("/").pop()?.replace(/\.md$/, "") : "graph"
	} ${stamp()}`;
	return createNote(params.app, title, content);
}

async function saveGraphReport(params: {
	app: App;
	title: string;
	graphData: AnswerInfraNodusTopics;
	extracted: InfraNodusExtractedGraphData;
	topicNames: Record<string, string>;
}) {
	const attrs: any = params.graphData.entriesAndGraphOfContext.graph.graphologyGraph.attributes;
	const nodes: any[] = params.graphData.entriesAndGraphOfContext.graph.graphologyGraph.nodes;
	const name = (id: string, fallback: string[]) =>
		params.topicNames[id] || fallback.slice(0, 3).join(" · ");

	const topics = (params.extracted.top_clusters as any[])
		.map((c) => {
			const words = c.nodes.map((n: any) => n.nodeName);
			const top = params.extracted.top_statements.find(
				(s: any) => String(s.topStatementOfCommunity) === String(c.community)
			) as any;
			return `### ${name(String(c.community), words)}
- Influence: ${Math.round(parseFloat(c.bcRatio) * 100)}% · Concepts: ${Math.round(parseFloat(c.numberRatio) * 100)}%
- Concepts: ${words.slice(0, 12).join(", ")}${top?.content ? `\n- Key statement: ${top.content.slice(0, 400)}` : ""}`;
		})
		.join("\n\n");

	const gaps = (attrs.gaps || [])
		.map(
			(g: any) =>
				`- **${name(String(g.from.community), g.from.nodes)}** ↔ **${name(String(g.to.community), g.to.nodes)}**`
		)
		.join("\n");

	const concepts = (attrs.top_nodes || []).slice(0, 15).join(", ");
	const relations = (params.extracted.bigrams || [])
		.slice(0, 15)
		.map((b) => b.split(" [weight")[0])
		.join(" · ");

	const content = `---
created: ${new Date().toISOString().slice(0, 10)}
tags: [graph-ai, graph-report]
---

Text network of ${params.title.startsWith("[[") ? params.title : `**${params.title}**`}: ${nodes.length} concepts, ${params.graphData.entriesAndGraphOfContext.graph.graphologyGraph.edges.length} links, ${(params.extracted.top_clusters as any[]).length} topics, modularity ${Number(attrs.modularity || 0).toFixed(2)}.

## Topics
${topics || "_none_"}

## Gaps between topics
${gaps || "_none found_"}

## Most influential concepts
${concepts}

## Strongest relations
${relations}
`;
	return createNote(params.app, `Graph report – ${params.title.split("/").pop()} ${stamp()}`, content);
}

export { saveTextToNote, saveGraphReport };
