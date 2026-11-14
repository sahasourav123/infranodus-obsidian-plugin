import {
	AiProvider,
	AiRoutes,
	DEFAULT_PROVIDERS,
	DEFAULT_ROUTES,
} from "src/ai/types";

type GraphAndStatementProcessingType =
	| "[[Wiki Links]] and Concepts"
	| "[[Wiki Links]] Only"
	| "[[Wiki Links]] Prioritized"
	| "Concepts only";

interface PluginSettings {
	// AI providers (local servers, API keys, subscription CLIs) and routing
	AI_PROVIDERS: AiProvider[];
	AI_ROUTES: AiRoutes;
	AI_RESPONSE_LANGUAGE: string;
	AI_MAX_CONTEXT_CHARS: number;
	AI_NAME_TOPICS: "yes" | "no";
	// Local graph engine
	MAX_GRAPH_NODES: number;
	// Where "save to note" writes AI output and graph reports
	SAVE_FOLDER: string;
	SINGLE_PAGE_GRAPH_PROCESSING: GraphAndStatementProcessingType;
	MULTI_PAGE_GRAPH_PROCESSING: GraphAndStatementProcessingType;
	COLOR_SCHEME: "auto" | "light" | "dark";
	LINK_PAGE_TO_MENTIONS:
		| "paragraph"
		| "parent_and_paragraph"
		| "parent_only"
		| "false"
		| "true";
	DEFAULT_GRAPH_MODE: "graph" | "topics" | "concepts" | "gaps" | "trends";
	INCLUDE_LINKED_MENTIONS: "For empty pages only" | "For all pages" | "Never";
	INCLUDE_UNLINKED_MENTIONS:
		| "For empty pages only"
		| "For all pages"
		| "Never";
	USE_OWN_UNLINKED_SEARCH: "no" | "yes";
	RELOADING_GRAPH: "automatic" | "manual" | "into reading";
	ADD_LINKS: "End of statement" | "Lemmatization" | "Only exact words";
	WHEN_USING_LOCATE: "Do not force to Edit Mode" | "Force to Edit Mode";
	// RELOAD_WHEN_TO_READING: boolean;

	MOBILE_OPEN_GRAPH_IN: "Side view" | "New tab";
}

// Kept for import compatibility; there are no remote endpoints any more
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface PluginInternalSettings {}

const SETTINGS: PluginSettings = {
	AI_PROVIDERS: DEFAULT_PROVIDERS.map((p) => ({ ...p })),
	AI_ROUTES: { ...DEFAULT_ROUTES },
	AI_RESPONSE_LANGUAGE: "",
	AI_MAX_CONTEXT_CHARS: 40000,
	AI_NAME_TOPICS: "yes",
	MAX_GRAPH_NODES: 300,
	SAVE_FOLDER: "",
	SINGLE_PAGE_GRAPH_PROCESSING: "[[Wiki Links]] and Concepts",
	MULTI_PAGE_GRAPH_PROCESSING: "[[Wiki Links]] and Concepts",
	COLOR_SCHEME: "auto",
	LINK_PAGE_TO_MENTIONS: "paragraph",
	INCLUDE_LINKED_MENTIONS: "For empty pages only",
	INCLUDE_UNLINKED_MENTIONS: "For empty pages only",
	USE_OWN_UNLINKED_SEARCH: "no",
	DEFAULT_GRAPH_MODE: "graph",
	RELOADING_GRAPH: "manual",
	ADD_LINKS: "End of statement",
	WHEN_USING_LOCATE: "Do not force to Edit Mode",
	// RELOAD_WHEN_TO_READING: true,

	// Mobile Only
	MOBILE_OPEN_GRAPH_IN: "New tab",
};

const INTERNAL_SETTINGS: PluginInternalSettings = {};

export { INTERNAL_SETTINGS, SETTINGS };
export type {
	PluginSettings,
	PluginInternalSettings,
	GraphAndStatementProcessingType,
};
