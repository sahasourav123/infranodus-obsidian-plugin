/**
 * Lightweight English singularizer used to merge plural/singular concepts
 * ("strategies" → "strategy"). A full lexicon-based lemmatizer adds ~1.7 MB
 * to the bundle; for concept merging the plural rules cover most cases.
 */
const IRREGULAR: Record<string, string> = {
	people: "person",
	men: "man",
	women: "woman",
	children: "child",
	mice: "mouse",
	feet: "foot",
	teeth: "tooth",
	geese: "goose",
	criteria: "criterion",
	phenomena: "phenomenon",
	analyses: "analysis",
	theses: "thesis",
	hypotheses: "hypothesis",
	crises: "crisis",
	diagnoses: "diagnosis",
	indices: "index",
	matrices: "matrix",
	vertices: "vertex",
	lives: "life",
	wives: "wife",
	knives: "knife",
	leaves: "leaf",
	halves: "half",
	selves: "self",
	shelves: "shelf",
	wolves: "wolf",
	thieves: "thief",
	caches: "cache",
	niches: "niche",
	headaches: "headache",
	axes: "axis",
	quizzes: "quiz",
};

const INVARIANT = new Set(
	`news series species physics mathematics economics politics ethics analytics statistics logistics dynamics
	electronics graphics semantics linguistics genetics robotics aerobics athletics gymnastics
	gas bus lens status bias plus minus bonus campus virus census canvas atlas alias basis crisis
	analysis thesis axis tennis chaos kudos ethos pathos cosmos radius focus corpus genus
	always perhaps thus various previous famous serious numerous obvious this his yes us its
	data media sales means headquarters goods clothes scissors trousers glasses thanks`
		.split(/\s+/)
		.filter(Boolean)
);

const cache = new Map<string, string>();

function singularize(word: string): string {
	const hit = cache.get(word);
	if (hit !== undefined) return hit;
	const out = rule(word);
	cache.set(word, out);
	return out;
}

function rule(w: string): string {
	if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
	if (IRREGULAR[w]) return IRREGULAR[w];
	if (INVARIANT.has(w)) return w;
	if (/(ss|us|is|ous|ics|sis|ness)$/.test(w)) return w;
	if (/[^aeiou]ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
	if (/(sses|ches|shes|xes|zzes)$/.test(w)) return w.slice(0, -2);
	if (/s$/.test(w)) return w.slice(0, -1);
	return w;
}

export { singularize };
