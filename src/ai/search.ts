/**
 * Finds the statements most related to a query — replaces the InfraNodus
 * `api/v1/aiSearch` endpoint. Uses embeddings from the configured
 * provider (e.g. nomic-embed on LM Studio, via LiteLLM) and falls back to keyword (BM25)
 * scoring when no embedding model is available.
 */
import { STOPWORDS } from "src/engine/stopwords";
import { singularize } from "src/engine/lemma";
import { embed, embeddingProvider } from "./client";

interface SearchResult {
	matchedContent: string;
	similarity: number;
}

const embeddingCache = new Map<string, number[]>();
const MAX_EMBED_CANDIDATES = 600;

function terms(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [])
		.filter((w) => w.length > 1 && !STOPWORDS.has(w))
		.map((w) => singularize(w));
}

function keywordScores(query: string, statements: string[]): number[] {
	const q = Array.from(new Set(terms(query)));
	if (q.length === 0) return statements.map(() => 0);
	const docs = statements.map((s) => terms(s));
	const N = docs.length;
	const avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(N, 1) || 1;
	const df = new Map<string, number>();
	for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
	return docs.map((d) => {
		let score = 0;
		for (const t of q) {
			const tf = d.filter((x) => x === t).length;
			if (!tf) continue;
			const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
			score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.length / avgLen))));
		}
		return score;
	});
}

function cosine(a: number[], b: number[]) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function semanticScores(query: string, statements: string[]): Promise<number[]> {
	const p = embeddingProvider()!;
	const nomic = /nomic/i.test(p.embeddingModel || "");
	const qText = nomic ? `search_query: ${query}` : query;
	const docText = (s: string) => (nomic ? `search_document: ${s}` : s);
	const keyOf = (s: string) => `${p.id}|${p.embeddingModel}|${s}`;

	const missing = Array.from(
		new Set(statements.filter((s) => !embeddingCache.has(keyOf(s))))
	);
	if (missing.length > 0) {
		const vectors = await embed(missing.map(docText));
		missing.forEach((s, i) => embeddingCache.set(keyOf(s), vectors[i]));
	}
	const [qv] = await embed([qText]);
	return statements.map((s) => cosine(qv, embeddingCache.get(keyOf(s))!));
}

async function findRelatedStatements(params: {
	query: string;
	statements: string[];
	similarityThreshold: number;
	numberOfResults?: number;
}): Promise<SearchResult[]> {
	const k = params.numberOfResults ?? 10;
	const unique = Array.from(new Set(params.statements.filter((s) => s && s.trim())));
	if (unique.length === 0) return [];

	const kw = keywordScores(params.query, unique);

	if (embeddingProvider()) {
		try {
			let candidates = unique;
			if (unique.length > MAX_EMBED_CANDIDATES) {
				// pre-filter large corpora with keywords, keep the top candidates
				candidates = unique
					.map((s, i) => ({ s, score: kw[i], len: s.length }))
					.sort((a, b) => b.score - a.score || b.len - a.len)
					.slice(0, MAX_EMBED_CANDIDATES)
					.map((x) => x.s);
			}
			const sims = await semanticScores(params.query, candidates);
			return candidates
				.map((s, i) => ({ matchedContent: s, similarity: sims[i] }))
				.filter((r) => r.similarity >= params.similarityThreshold)
				.sort((a, b) => b.similarity - a.similarity)
				.slice(0, k);
		} catch (err) {
			console.warn("[graph-ai] embeddings failed, using keyword search", err);
		}
	}

	const max = Math.max(...kw, 0);
	return unique
		.map((s, i) => ({
			matchedContent: s,
			similarity: max > 0 ? kw[i] / max : 0,
		}))
		.filter((r) => r.similarity > 0 && r.similarity >= Math.min(params.similarityThreshold, 0.99))
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, k);
}

export { findRelatedStatements };
export type { SearchResult };
