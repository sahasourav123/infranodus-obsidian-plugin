/**
 * Local text network analysis — replaces the InfraNodus
 * `api/v1/graphAndStatements` endpoint.
 *
 * Method (after InfraNodus):
 *  1. Split the text into statements (lines / paragraphs).
 *  2. Extract tokens per statement: [[wiki links]], #tags and lemmatized
 *     concepts (stopwords removed).
 *  3. Link tokens that co-occur within a 4-token window
 *     (distance 1 → weight 3, 2 → 2, 3 → 1).
 *  4. Keep the most connected nodes, then compute betweenness centrality
 *     (influence) and Louvain communities (topics).
 *  5. Derive top nodes, topical clusters, structural gaps between
 *     clusters, top statements per cluster, bigrams and a DOT-like edge
 *     list for the AI prompts.
 *
 * The output keeps the response shape the rest of the plugin already
 * consumes (AnswerInfraNodusTopics), so the UI needs no changes.
 */
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import betweennessCentrality from "graphology-metrics/centrality/betweenness";
import { STOPWORDS } from "./stopwords";
import { singularize } from "./lemma";
import type { GraphAndStatementProcessingType } from "src/settings";
import type { AnswerInfraNodusTopics } from "src/types/messaging";

type LinkMode = "paragraph" | "parent_and_paragraph" | "parent_only";

interface BuildParams {
	text: string;
	statements?: string[];
	categories?: string[][];
	contextSettings: GraphAndStatementProcessingType;
	stopwords?: string[];
	linkPageToMentions?: LinkMode | string;
	maxNodes?: number;
	maxClusters?: number;
}

interface Token {
	name: string;
	kind: "word" | "link" | "tag";
}

interface RawStatement {
	content: string;
	categories: string[];
}

const WINDOW = 4;

function mulberry32(seed: number) {
	return function () {
		let t = (seed += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	const after = text.indexOf("\n", end + 4);
	return after === -1 ? "" : text.slice(after + 1);
}

function stripCodeBlocks(text: string): string {
	return text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
}

/** Split a document into statements: one per non-empty line. */
function splitDocument(doc: string): string[] {
	const cleaned = stripCodeBlocks(stripFrontmatter(doc));
	const out: string[] = [];
	for (const raw of cleaned.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		// skip pure markup lines (tables separators, rules)
		if (/^[-|:=*_\s]+$/.test(line)) continue;
		out.push(line);
	}
	return out;
}

function lemmatize(word: string): string {
	return singularize(word);
}

const TOKEN_RE =
	/\[\[([^\]\n]+)\]\]|(?:^|(?<=[\s(]))#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)|([\p{L}\p{N}][\p{L}\p{N}'’-]*)/gu;

function cleanLine(line: string): string {
	return (
		line
			// embeds and images
			.replace(/!\[\[[^\]]*\]\]/g, " ")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
			// markdown links → link text
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			// urls
			.replace(/https?:\/\/\S+/g, " ")
			// inline dataview fields [key:: value] and key:: value
			.replace(/\[[\w -]+::[^\]]*\]/g, " ")
			.replace(/\b[\w-]+::\s*\S+/g, " ")
			// inline code, html tags
			.replace(/`[^`]*`/g, " ")
			.replace(/<[^>]+>/g, " ")
			// task checkboxes, list markers, heading markers
			.replace(/^\s*[-*+]\s+\[.\]\s*/, " ")
			.replace(/^\s*#{1,6}\s+/, " ")
	);
}

/** Canonical display names for links, merged case-insensitively. */
class NameRegistry {
	private map = new Map<string, string>();
	get(name: string): string {
		const key = name.toLowerCase();
		const found = this.map.get(key);
		if (found) return found;
		this.map.set(key, name);
		return name;
	}
}

function tokenizeLine(
	line: string,
	mode: GraphAndStatementProcessingType,
	hidden: Set<string>,
	links: NameRegistry
): Token[] {
	const text = cleanLine(line);
	const tokens: Token[] = [];
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN_RE.exec(text))) {
		if (m[1] !== undefined) {
			// [[target#heading|alias]]
			const target = m[1].split("|")[0].split("#")[0].trim();
			if (!target) continue;
			if (mode === "Concepts only") {
				// treat link text as plain concepts
				const alias = (m[1].split("|")[1] || target).trim();
				for (const w of alias.split(/[^\p{L}\p{N}'’-]+/u)) {
					const t = wordToken(w, hidden);
					if (t) tokens.push(t);
				}
				continue;
			}
			const name = `[[${links.get(target)}]]`;
			if (hidden.has(name) || hidden.has(name.toLowerCase())) continue;
			tokens.push({ name, kind: "link" });
		} else if (m[2] !== undefined) {
			if (mode === "Concepts only") {
				const t = wordToken(m[2], hidden);
				if (t) tokens.push(t);
				continue;
			}
			const name = `#${m[2].toLowerCase()}`;
			if (hidden.has(name)) continue;
			tokens.push({ name, kind: "tag" });
		} else if (m[3] !== undefined) {
			const t = wordToken(m[3], hidden);
			if (t) tokens.push(t);
		}
	}

	if (mode === "[[Wiki Links]] Only") {
		return tokens.filter((t) => t.kind !== "word");
	}
	if (mode === "[[Wiki Links]] Prioritized") {
		const linksOnly = tokens.filter((t) => t.kind !== "word");
		return linksOnly.length > 0 ? linksOnly : tokens;
	}
	return tokens;
}

function wordToken(raw: string, hidden: Set<string>): Token | null {
	let w = raw
		.toLowerCase()
		.replace(/[’']s$/, "")
		.replace(/^[-'’]+|[-'’]+$/g, "");
	if (w.length < 2) return null;
	if (/^\d+([.,:\-/]\d+)*$/.test(w)) return null; // numbers, dates
	if (!/\p{L}/u.test(w)) return null;
	if (STOPWORDS.has(w) || hidden.has(w)) return null;
	w = lemmatize(w);
	if (w.length < 2 || STOPWORDS.has(w) || hidden.has(w)) return null;
	return { name: w, kind: "word" };
}

function edgeKey(a: string, b: string) {
	return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
}

function buildGraphAndStatements(params: BuildParams): AnswerInfraNodusTopics {
	const mode = params.contextSettings || "[[Wiki Links]] and Concepts";
	const linkMode: LinkMode =
		params.linkPageToMentions === "parent_only" ||
		params.linkPageToMentions === "parent_and_paragraph"
			? (params.linkPageToMentions as LinkMode)
			: "paragraph";
	const maxNodes = params.maxNodes ?? 300;
	const maxClusters = params.maxClusters ?? 10;

	const hidden = new Set(
		(params.stopwords || []).flatMap((w) => [w, w.toLowerCase()])
	);
	const links = new NameRegistry();

	// ---------- 1. statements ----------
	const raw: RawStatement[] = [];
	if (params.statements && params.statements.length > 0) {
		params.statements.forEach((doc, i) => {
			const cats = params.categories?.[i] || [];
			for (const line of splitDocument(doc)) {
				raw.push({ content: line, categories: cats });
			}
		});
	} else {
		const cats = params.categories?.[0] || [];
		for (const line of splitDocument(params.text || "")) {
			raw.push({ content: line, categories: cats });
		}
	}

	// ---------- 2-3. tokens and co-occurrence ----------
	const edgeWeights = new Map<string, number>();
	const nodeFreq = new Map<string, number>();
	const nodeKind = new Map<string, Token["kind"]>();
	const statementTokens: string[][] = [];

	const addEdge = (a: string, b: string, w: number) => {
		if (a === b) return;
		const k = edgeKey(a, b);
		edgeWeights.set(k, (edgeWeights.get(k) || 0) + w);
	};

	const useCategories =
		linkMode !== "paragraph" && mode !== "Concepts only";

	for (const st of raw) {
		const tokens = tokenizeLine(st.content, mode, hidden, links);
		const names: string[] = [];

		for (const t of tokens) {
			nodeFreq.set(t.name, (nodeFreq.get(t.name) || 0) + 1);
			if (!nodeKind.has(t.name)) nodeKind.set(t.name, t.kind);
			names.push(t.name);
		}

		const onlyLinks =
			tokens.length > 0 && tokens.every((t) => t.kind !== "word");

		if (onlyLinks) {
			// links-only statement: connect all mentions to each other
			if (linkMode !== "parent_only") {
				const uniq = Array.from(new Set(names)).slice(0, 30);
				for (let i = 0; i < uniq.length; i++)
					for (let j = i + 1; j < uniq.length; j++)
						addEdge(uniq[i], uniq[j], 1);
			}
		} else {
			// 4-gram sliding window
			for (let i = 0; i < names.length; i++) {
				for (let d = 1; d < WINDOW && i + d < names.length; d++) {
					addEdge(names[i], names[i + d], WINDOW - d);
				}
			}
			// mentions in the same paragraph link to each other
			if (linkMode !== "parent_only") {
				const mentions = Array.from(
					new Set(
						tokens.filter((t) => t.kind !== "word").map((t) => t.name)
					)
				).slice(0, 30);
				for (let i = 0; i < mentions.length; i++)
					for (let j = i + 1; j < mentions.length; j++)
						addEdge(mentions[i], mentions[j], 1);
			}
		}

		// page (category) → mentions
		if (useCategories && st.categories.length > 0) {
			for (const cat of st.categories) {
				const catName = `[[${links.get(cat)}]]`;
				if (hidden.has(catName)) continue;
				const targets =
					linkMode === "parent_only"
						? names.filter((n) => nodeKind.get(n) !== "word")
						: names;
				if (targets.length === 0) continue;
				nodeKind.set(catName, "link");
				nodeFreq.set(catName, (nodeFreq.get(catName) || 0) + 1);
				for (const t of new Set(targets)) addEdge(catName, t, 1);
				names.push(catName);
			}
		}

		statementTokens.push(names);
	}

	// ---------- 4. prune & build graph ----------
	const weightedDegree = new Map<string, number>();
	for (const [k, w] of edgeWeights) {
		const [a, b] = k.split("\u0001");
		weightedDegree.set(a, (weightedDegree.get(a) || 0) + w);
		weightedDegree.set(b, (weightedDegree.get(b) || 0) + w);
	}

	const ranked = Array.from(weightedDegree.entries()).sort(
		(x, y) => y[1] - x[1] || (nodeFreq.get(y[0]) || 0) - (nodeFreq.get(x[0]) || 0)
	);
	const kept = new Set(ranked.slice(0, maxNodes).map(([n]) => n));

	const graph = new Graph({ type: "undirected", multi: false });
	for (const n of kept) graph.addNode(n);
	for (const [k, w] of edgeWeights) {
		const [a, b] = k.split("\u0001");
		if (kept.has(a) && kept.has(b)) graph.addEdge(a, b, { weight: w });
	}
	graph.forEachNode((n) => {
		if (graph.degree(n) === 0) graph.dropNode(n);
	});

	if (graph.order < 2) {
		return emptyAnswer(raw, statementTokens);
	}

	// ---------- metrics ----------
	const bc: Record<string, number> = betweennessCentrality(graph, {
		getEdgeWeight: null,
		normalized: true,
	});
	const louvainResult = louvain.detailed(graph, {
		getEdgeWeight: "weight",
		resolution: 1,
		rng: mulberry32(42),
	});
	const rawCommunities = louvainResult.communities as Record<string, number>;

	const degree: Record<string, number> = {};
	const wdeg: Record<string, number> = {};
	graph.forEachNode((n) => {
		degree[n] = graph.degree(n);
		let s = 0;
		graph.forEachEdge(n, (_e, attr) => (s += attr.weight));
		wdeg[n] = s;
	});

	const totalBc = Object.values(bc).reduce((s, v) => s + v, 0) || 1;
	const totalNodes = graph.order;

	// group by community, rank communities by influence (sum of BC)
	const groups = new Map<number, string[]>();
	for (const [n, c] of Object.entries(rawCommunities)) {
		if (!groups.has(c)) groups.set(c, []);
		groups.get(c)!.push(n);
	}
	const sortedGroups = Array.from(groups.entries())
		.map(([c, nodes]) => ({
			raw: c,
			nodes: nodes.sort((a, b) => bc[b] - bc[a] || wdeg[b] - wdeg[a]),
			bcSum: nodes.reduce((s, n) => s + bc[n], 0),
			wSum: nodes.reduce((s, n) => s + wdeg[n], 0),
		}))
		.sort((a, b) => b.bcSum - a.bcSum || b.wSum - a.wSum || b.nodes.length - a.nodes.length);

	const community: Record<string, string> = {};
	sortedGroups.forEach((g, idx) => {
		for (const n of g.nodes) community[n] = String(idx);
	});

	const minClusterSize = totalNodes > 30 ? 3 : 2;
	const topGroups = sortedGroups
		.map((g, idx) => ({ ...g, id: String(idx) }))
		.filter((g) => g.nodes.length >= minClusterSize)
		.slice(0, maxClusters);

	// ---------- statements ----------
	const statements = raw.map((st, i) => {
		const hashtags = Array.from(
			new Set(statementTokens[i].filter((n) => graph.hasNode(n)))
		);
		const commScore = new Map<string, number>();
		for (const n of hashtags) {
			const c = community[n];
			commScore.set(c, (commScore.get(c) || 0) + bc[n] + 0.0001);
		}
		let topComm = "";
		let best = -1;
		for (const [c, s] of commScore) {
			if (s > best) {
				best = s;
				topComm = c;
			}
		}
		return {
			id: i,
			sortId: i,
			content: st.content,
			categories: st.categories.map((c) => `[[${c}]]`),
			contextId: 0,
			statementHashtags: hashtags,
			statementCommunities: Array.from(new Set(hashtags.map((n) => community[n]))),
			topStatementCommunity: topComm,
		};
	});

	const nodesToStatements: Record<string, number[]> = {};
	statements.forEach((s) => {
		for (const n of s.statementHashtags) {
			(nodesToStatements[n] ||= []).push(s.id);
		}
	});

	// ---------- clusters ----------
	const topClusters = topGroups.map((g) => {
		const nodeSet = new Set(g.nodes);
		let topStatementId: number | null = null;
		let bestScore = -1;
		statements.forEach((s) => {
			let score = 0;
			let hits = 0;
			for (const n of s.statementHashtags) {
				if (nodeSet.has(n)) {
					score += bc[n] + 0.001;
					hits++;
				}
			}
			if (hits === 0) return;
			// prefer statements that combine several of the cluster's concepts
			score *= Math.min(hits, 5);
			if (s.content.length > 1200) score *= 0.5;
			if (score > bestScore) {
				bestScore = score;
				topStatementId = s.id;
			}
		});
		return {
			community: g.id,
			id: g.id,
			nodes: g.nodes.map((n) => ({
				nodeName: n,
				bc: bc[n],
				degree: degree[n],
				weightedDegree: wdeg[n],
			})),
			numberRatio: (g.nodes.length / totalNodes).toFixed(2),
			bcRatio: (g.bcSum / totalBc).toFixed(2),
			topStatementId,
		};
	});

	// ---------- gaps ----------
	const clusterOf = (n: string) => community[n];
	const between = new Map<string, number>();
	graph.forEachEdge((_e, attr, a, b) => {
		const ca = clusterOf(a);
		const cb = clusterOf(b);
		if (ca === cb) return;
		const k = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
		between.set(k, (between.get(k) || 0) + attr.weight);
	});

	// Gap = two influential topics with fewer links between them than
	// expected from their size (observed / expected inter-cluster weight,
	// as in modularity). Lower ratio + higher influence = bigger gap.
	const volume = new Map<string, number>();
	let totalWeight = 0;
	graph.forEachNode((n) => {
		const c = community[n];
		volume.set(c, (volume.get(c) || 0) + wdeg[n]);
		totalWeight += wdeg[n];
	});
	const twoM = totalWeight || 1;

	const gapCandidates = topClusters.slice(0, 8);
	const gaps: any[] = [];
	for (let i = 0; i < gapCandidates.length; i++) {
		for (let j = i + 1; j < gapCandidates.length; j++) {
			const A = gapCandidates[i];
			const B = gapCandidates[j];
			const k = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
			const link = between.get(k) || 0;
			const expected = ((volume.get(A.id) || 0) * (volume.get(B.id) || 0)) / twoM;
			const ratio = expected > 0 ? link / expected : 1;
			const importance = Math.sqrt(
				(parseFloat(A.bcRatio) + 0.01) * (parseFloat(B.bcRatio) + 0.01)
			);
			gaps.push({
				from: {
					community: A.id,
					nodes: A.nodes.slice(0, 4).map((n) => n.nodeName),
				},
				to: {
					community: B.id,
					nodes: B.nodes.slice(0, 4).map((n) => n.nodeName),
				},
				connectivity: link,
				ratio,
				score: importance * Math.pow(Math.max(0, 1 - Math.min(1, ratio)), 2),
			});
		}
	}
	gaps.sort((a, b) => b.score - a.score);
	const topGaps = gaps.slice(0, 6).map((g, idx) => ({ ...g, id: idx + 1 }));

	// ---------- edges as text ----------
	const edgesSorted: { a: string; b: string; w: number }[] = [];
	graph.forEachEdge((_e, attr, a, b) => edgesSorted.push({ a, b, w: attr.weight }));
	edgesSorted.sort((x, y) => y.w - x.w);

	const bigrams = edgesSorted
		.slice(0, 150)
		.map((e) => `${e.a} ${e.b} [weight: ${e.w}]`);

	const topNodes = Object.keys(bc)
		.sort((a, b) => bc[b] - bc[a] || wdeg[b] - wdeg[a])
		.slice(0, 15);
	const topNodeSet = new Set(topNodes.slice(0, 10));

	const dotGraphByCluster: Record<string, string[]> = {};
	for (const c of topClusters) dotGraphByCluster[c.id] = [];
	const interCluster: string[] = [];
	const topNodesEdges: string[] = [];
	for (const e of edgesSorted) {
		const ca = community[e.a];
		const cb = community[e.b];
		const s = `${e.a} <-> ${e.b}`;
		if (ca === cb && dotGraphByCluster[ca] && dotGraphByCluster[ca].length < 12) {
			dotGraphByCluster[ca].push(s);
		} else if (
			ca !== cb &&
			dotGraphByCluster[ca] &&
			dotGraphByCluster[cb] &&
			interCluster.length < 12
		) {
			interCluster.push(s);
		}
		if (topNodeSet.has(e.a) && topNodeSet.has(e.b) && topNodesEdges.length < 12) {
			topNodesEdges.push(s);
		}
	}
	dotGraphByCluster["inter_cluster"] = interCluster;
	dotGraphByCluster["top_nodes"] = topNodesEdges;

	const dotGraph = edgesSorted
		.slice(0, 40)
		.map((e) => `${e.a} <-> ${e.b}`)
		.join("; ");

	// ---------- serialize ----------
	const maxBc = Math.max(...Object.values(bc), 1e-9);
	const nodes = graph.mapNodes((n) => ({
		key: n,
		attributes: {
			label: n,
			community: community[n],
			bc: bc[n],
			bcNorm: bc[n] / maxBc,
			degree: degree[n],
			weightedDegree: wdeg[n],
			frequency: nodeFreq.get(n) || 0,
			kind: nodeKind.get(n) || "word",
		},
	}));
	const edges = graph.mapEdges((e, attr, a, b) => ({
		key: e,
		source: a,
		target: b,
		attributes: { weight: attr.weight },
	}));

	return {
		entriesAndGraphOfContext: {
			graph: {
				graphologyGraph: {
					attributes: {
						top_nodes: topNodes,
						top_clusters: topClusters,
						gaps: topGaps,
						modularity: louvainResult.modularity,
						nodes_to_statements_map: nodesToStatements,
						dotGraph,
						dotGraphByCluster,
						bigrams,
					} as any,
					nodes,
					edges,
					options: { type: "undirected" },
				},
				statementHashtags: {},
			},
			statements,
		},
	};
}

function emptyAnswer(raw: RawStatement[], tokens: string[][]): AnswerInfraNodusTopics {
	return {
		entriesAndGraphOfContext: {
			graph: {
				graphologyGraph: {
					attributes: {
						top_nodes: [],
						top_clusters: [],
						gaps: [],
						modularity: 0,
						nodes_to_statements_map: {},
					},
					nodes: [],
					edges: [],
					options: {},
				},
				statementHashtags: {},
			},
			statements: raw.map((st, i) => ({
				id: i,
				sortId: i,
				content: st.content,
				categories: st.categories,
				contextId: 0,
				statementHashtags: Array.from(new Set(tokens[i])),
				statementCommunities: [],
				topStatementCommunity: "",
			})),
		},
	};
}

export { buildGraphAndStatements };
export type { BuildParams };
