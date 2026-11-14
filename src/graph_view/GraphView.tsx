import { App, MarkdownView, Notice, Platform } from "obsidian";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { InfraNodus } from "src/infranodus";
import { GraphViewOverlay } from "./components/GraphViewOverlay";
import { ErrorHandler, PossibleError } from "./components/ErrorHandler";
import { AnswerInfraNodusTopics } from "src/types/messaging";
import { arraysAreEqual } from "src/utils/arrays";
import { encodeInfraNodusGraphName } from "src/utils/graph";
import {
	findLineEntryInLeaf,
	focusOrOpenFile,
	getContentsFromFilePath,
	getMentionsOfFile,
	unhighlightStatements,
	findFileFromName,
	findFileFromPath,
	openLeafWithPath,
} from "src/utils/files";
import {
	AdviceMode,
	GraphInitialData,
	GraphViewContext,
	GraphViewStateRef,
	LoadingState,
	PluginGraphContext,
} from "./types";
import { InfraNodusExtractedGraphData } from "src/infranodus/types";
import { getPureTextFromMarkdown } from "src/utils/line";
import { filterStatements } from "src/utils/statements";
import { StatementsObject } from "src/types/general";
import {
	getStatementToJumpTo,
	jumpToStatementAndOpenFile,
} from "./lib/jumpToStatement";
import { INTERNAL_SETTINGS, SETTINGS } from "src/settings";
import { generateTextForContext } from "./lib/generateTextForContext";
import { saveGraphReport } from "./lib/saveToNote";
import { LocalGraph, GraphAction } from "./components/LocalGraph";
import { unObserveElementAttributes } from "src/utils/observer";
import { GraphViewOverlaySettings } from "./components/GraphViewOverlaySettings";
import { InfoTooltip } from "src/components/InfoTootip";
import { IconButton } from "src/components/IconButton";
import {
	GearIcon,
	SyncIcon,
	PlayIcon,
	RepoPullIcon,
	CheckIcon,
	NoteIcon,
} from "@primer/octicons-react";
import {
	handleGraphDataError,
	INFRANODUS_API_ERROR_PREFIX,
} from "./lib/handleErrors";
import { LoadingView } from "./components/LoadingView";
import { clearInterval } from "timers";

import { TFile } from "obsidian";

import { TopicsObject } from "src/types/general";

import { GraphPanel } from "./types";

const GraphView = (params: {
	initialData?: GraphInitialData;
	graphContext: PluginGraphContext;
}) => {
	// console.log("initialData", params.initialData);
	// console.log("graphContext", params.graphContext);

	const { filePath, app, contentString, sourcePath } = params.graphContext;
	const cleanFilePath =
		filePath && filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
	const isFolder = filePath && !filePath.endsWith(".md") ? true : false;

	const vaultName = app.vault.getName();
	const [colorScheme, setColorScheme] = useState(SETTINGS.COLOR_SCHEME);

	const [useOwnUnlinkedSearch, setUseOwnUnlinkedSearch] = useState(
		SETTINGS.USE_OWN_UNLINKED_SEARCH
	);

	const obsidianColorSchemeRef = useRef<"dark" | "light">("light");

	const [graphData, setGraphData] = useState<AnswerInfraNodusTopics>();
	const [isSearchingWords, setIsSearchingWords] = useState(false);
	const [wordsToSearch, setWordsToSearch] = useState<string[]>(
		params.initialData?.wordsToSearch ?? []
	);
	const [connectedWords, setConnectedWords] = useState<string[]>([]);
	const [wordsToHide, setWordsToHide] = useState<string[]>([]);
	const [isHidingWords, setIsHidingWords] = useState(false);
	const [gapShown, setGapShown] = useState<any>(false);
	const [topicNames, setTopicNames] = useState<Record<string, string>>({});
	const [topicsFiltered, setTopicsFiltered] = useState<any[]>([]);
	const [adviceMode, setAdviceMode] = useState<AdviceMode>("none");
	const [overlayShowMode, setOverlayShowMode] = useState<
		"ai" | "aiChat" | "context" | null
	>(null);
	// const [textToShow, setTextToShow] = useState("ai generating...");

	const showIframe = true; // local renderer is always mounted
	const [isLoadingIframe, setIsLoadingIframe] = useState(false);
	const [error, setError] = useState<PossibleError>();
	const [errorText, setErrorText] = useState("");
	const [loadingState, setLoadingState] =
		useState<LoadingState>("initializing");

	// Extracted / filtered / fetched data
	const contentRef = useRef<string>();
	const pageNamesRef = useRef<string[][]>([]);
	const statementsRef = useRef<string[]>([]);
	const filteredStatementsRef = useRef<StatementsObject[]>([]);
	const extractedGraphDataRef = useRef<InfraNodusExtractedGraphData>();
	const lastSelectedWordRef = useRef<string | null>(
		params.initialData?.wordsToSearch?.[0] ?? null
	);
	const [currentContextShown, setCurrentContextShown] = useState(0);
	const [textToShow, setTextToShow] = useState("");
	const [statementsToShow, setStatementsToShow] = useState<string[]>([]);

	const [showingSettings, setShowingSettings] = useState(false);
	const [showingReloadButton, setShowingReloadButton] = useState(true);

	const [currentGraphPanel, setCurrentGraphPanel] = useState<GraphPanel>(
		SETTINGS.DEFAULT_GRAPH_MODE as GraphPanel
	);

	const currentUser = "";

	// For "context"
	// const [currentContextShown, setCurrentContextShown] = useState(0);

	// For "Jump to Statement" / "Locate"
	const statementToJumpToRef = useRef<Record<string, number>>({});
	const previousStatementToJumpToRef = useRef<string>("");

	const graph_top_text: React.MutableRefObject<HTMLIFrameElement> =
		useRef() as React.MutableRefObject<HTMLIFrameElement>;

	// Adjust filteredStatements
	useEffect(() => {
		const allStatements =
			extractedGraphDataRef.current?.all_statements_with_top;
		const filteredStatements = filterStatements({
			statements: allStatements ?? [],
			wordsToSearch,
			wordsToHide,
			topicsFiltered,
			connectedWords,
		});

		filteredStatementsRef.current =
			filteredStatements && filteredStatements.length > 0
				? filteredStatements
				: [];
	}, [wordsToHide, wordsToSearch, topicsFiltered, graphData, connectedWords]);

	// Separate state, for handling message from the iframe
	const stateForMessagesRef: GraphViewStateRef = useRef(undefined as any);
	useEffect(() => {
		stateForMessagesRef.current = {
			wordsToSearch,
			wordsToHide,
			topicsFiltered,
			graphData,
			filteredStatements: filteredStatementsRef.current,
			lastSelectedWord: lastSelectedWordRef.current,
			extractedGraphData: extractedGraphDataRef.current!,
		};
	}, [
		wordsToHide,
		wordsToSearch,
		topicsFiltered,
		graphData,
		filteredStatementsRef.current,
		lastSelectedWordRef.current,
		extractedGraphDataRef.current,
	]);

	// Graph View Context
	const [graphViewContext, setGraphViewContext] =
		useState<GraphViewContext>();
	useEffect(() => {
		// console.log("InfraNodus setting graph's viewContext");

		setGraphViewContext({
			stateRef: stateForMessagesRef,

			graphData: graphData!,
			adviceMode,
			wordsToSearch,
			wordsToHide,
			gapShown,
			loadingState,
			currentUser,

			setAdviceMode,
			setWordsToSearch,
			setWordsToHide,
			setGapShown,
			setLoadingState,
		});
	}, [
		stateForMessagesRef.current,
		graphData,
		adviceMode,
		wordsToSearch,
		wordsToHide,
		gapShown,
		loadingState,
		currentUser,
	]);

	const currentPlatform =
		Platform.isMobileApp || Platform.isMobile ? "mobile" : "desktop";

	// Initialize the color scheme — follow Obsidian's theme, not the OS preference.
	// Obsidian toggles `theme-dark` / `theme-light` on <body> independently of the OS.
	useEffect(() => {
		const detectObsidianScheme = (): "dark" | "light" =>
			document.body.classList.contains("theme-dark") ? "dark" : "light";

		obsidianColorSchemeRef.current = detectObsidianScheme();
		if (colorScheme === "auto") {
			setColorScheme(obsidianColorSchemeRef.current);
		}

		const observer = new MutationObserver(() => {
			const next = detectObsidianScheme();
			if (next === obsidianColorSchemeRef.current) return;
			obsidianColorSchemeRef.current = next;
			if (colorScheme === "auto") {
				setColorScheme(next);
			}
		});
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ["class"],
		});

		return () => {
			observer.disconnect();
		};
	}, []);

	function diff(a: Date) {
		return (new Date().valueOf() - a.valueOf()) / 1000;
	}

	// Initialize the graph
	useEffect(() => {
		// console.log("wordsToHide", wordsToHide);
		async function fetchGraphData() {
			if (loadingState != "complete") setLoadingState("initializing");

			const start1 = new Date();
			// console.log("fetching graph data for InfraNodus stopwords");
			if (!filePath && !contentString) {
				new Notice("No files or content provided for analysis");
				return console.log("No file path");
			}

			let content:
				| {
						content: string;
						pageNames?: string[][];
						files?: { path: string; content: string }[];
						statements?: string[];
				  }
				| undefined;

			let contentStatements: string[] = [];

			if (!contentRef.current && filePath) {
				// console.log("InfraNodus Error: no content obtained");
				setLoadingState("getting-content");
				content = await getContentsFromFilePath({
					app,
					filePath: filePath || "",
				});

				contentRef.current = content?.content;
				if (!content?.content) {
					setError("no-content");
					throw new Error("No content in the file");
				}

				pageNamesRef.current = content?.pageNames || [];
			}

			if (!contentRef.current && contentString) {
				contentRef.current = contentString;
			}

			if (!contentRef.current) return;
			if (!showIframe) return;

			// Check the size

			const contentSize = contentRef.current.length;

			if (contentSize > 50000000) {
				new Notice(
					"The content is too large for analysis. Please, reduce the size or try with a different folder, bookmark group, or file."
				);
				return;
			}

			if (loadingState != "complete") setIsLoadingIframe(true);

			// Push to statements
			const statementsBefore = statementsRef.current;
			statementsRef.current = [];

			const regex = /\[\[([^\]]+)\]\]/g;

			contentStatements = content?.statements || [];

			if (contentStatements.length > 0) {
				contentStatements.forEach((statement) => {
					statementsRef.current.push(statement);
				});
			} else {
				contentRef.current.split("\n").forEach((line) => {
					line = line.trim();
					if (!line) return;
					statementsRef.current.push(line);
				});
			}

			// If the statements are the same, don't update
			// if (arraysAreEqual(statementsBefore, statementsRef.current)) return;
			// console.log("statements: ", statementsRef.current);
			// console.log("[time] for statements", diff(start1));
			const start2 = new Date();
			if (loadingState != "complete") setLoadingState("generating-graph");

			const presetContextSettings = isFolder
				? SETTINGS.MULTI_PAGE_GRAPH_PROCESSING
				: SETTINGS.SINGLE_PAGE_GRAPH_PROCESSING;

			// TODO design another API path to send arrays with statements and tags
			// TODO then add category filters and statements view

			const linkPageToMentions =
				SETTINGS.LINK_PAGE_TO_MENTIONS == "true" ||
				SETTINGS.LINK_PAGE_TO_MENTIONS == "parent_and_paragraph"
					? "parent_and_paragraph"
					: SETTINGS.LINK_PAGE_TO_MENTIONS == "false" ||
					  SETTINGS.LINK_PAGE_TO_MENTIONS == "paragraph"
					? "paragraph"
					: "parent_only";

			const response = await InfraNodus.getGraphAndStatements({
				name: "Obsidian Plugin",
				text: statementsRef.current.join("\n"),
				statements:
					linkPageToMentions != "paragraph" &&
					contentStatements &&
					contentStatements.length > 0
						? contentStatements
						: [],
				contextSettings: presetContextSettings,
				stopwords: wordsToHide,
				categories:
					pageNamesRef.current &&
					pageNamesRef.current.length > 0 &&
					linkPageToMentions != "paragraph"
						? pageNamesRef.current
						: [],
				linkPageToMentions,
			});
			const graphData: AnswerInfraNodusTopics = response.data;

			// console.log("graphData", graphData);
			if (graphData.error) {
				handleGraphDataError({
					graphDataResponse: graphData,
					statements: statementsRef.current,
					setError,
					isFolder,
				});
			}

			const extracted = InfraNodus.extractDataFromGraphData({
				graph_data: graphData,
				setError,
			});
			extractedGraphDataRef.current = extracted;

			// Update the state
			setGraphData(graphData);

			const topicNames = extractedGraphDataRef.current?.top_clusters.map(
				(topic: any) => ({
					id: topic.community,
					name: topic.nodes
						.map((node: any) => node.nodeName)
						.slice(0, 3)
						.join(" "),
				})
			);
			// console.log("Obtained names for the Topics", topicNames);
			// Cluster ids can change after a rebuild: drop the old AI names
			setTopicNames({});

			if (loadingState != "complete") setIsLoadingIframe(false);
			setLoadingState("complete");
			new Notice("Graph loaded");

			// Name the topics with the AI provider configured for "Topic names"
			if (SETTINGS.AI_NAME_TOPICS !== "no") {
				try {
					const aiTopics = await InfraNodus.generateAiNamesForTopics({
						graph_data: graphData,
						top_clusters: extractedGraphDataRef.current?.top_clusters,
						language: "USER",
						top_statements:
							extractedGraphDataRef.current?.top_statements,
					});
					const names: Record<string, string> = {};
					for (const aiTopic of aiTopics) {
						names[aiTopic.id] = aiTopic.name;
						const topic: any =
							extractedGraphDataRef.current?.top_clusters.find(
								(topic: any) => topic.community == aiTopic.id
							);
						if (topic) {
							topic.aiName = aiTopic.name;
							topic.aiDescription = aiTopic.description;
						}
					}
					setTopicNames(names);
				} catch (err) {
					console.log("Error generating AI topics", err.message, err);
					new Notice(
						`Topic names: ${err.message || err}`.slice(0, 300),
						8000
					);
				}
			}
		}

		fetchGraphData().catch((err) => {
			setError((currentError) => {
				if (currentError) return currentError;

				const message = err.message || "An unknown error occurred";
				if (message.startsWith(INFRANODUS_API_ERROR_PREFIX)) {
					setErrorText(
						message.slice(INFRANODUS_API_ERROR_PREFIX.length)
					);
					return "api-error";
				}
				setErrorText(message);
				return "generic-error";
			});
		});
	}, [wordsToHide]);

	function showGraphContextAdvice(params: {
		wordsToSearch: string[];
		topicsFiltered: string[];
		source?: "next" | "back" | "gap";
	}) {
		setOverlayShowMode("context");
		setAdviceMode("context");

		const data = generateTextForContext(
			{
				wordsToSearch: params.wordsToSearch,
				filteredStatements:
					stateForMessagesRef.current.filteredStatements,
				currentContextShown: currentContextShown,
				extractedGraphData: extractedGraphDataRef.current!,
				topicsFiltered: params.topicsFiltered,
			},
			params.source || "next"
		);

		if (data) {
			setTextToShow(data.contentToShow);
			setCurrentContextShown(data.currentContextShown);
			setStatementsToShow(data.statementsToShow);
		}
	}

	// ---------------------------------------------------------------
	// Graph interactions (formerly messages from the InfraNodus iframe).
	// Handlers read the latest state from stateForMessagesRef so they are
	// safe to call from deferred callbacks.

	async function handleSelectNodes(payload: string[], connected: string[]) {
		const { wordsToSearch, wordsToHide } = stateForMessagesRef.current;
		if (!payload) payload = [];
		setIsSearchingWords(payload.length > 0);
		setCurrentGraphPanel(payload.length > 0 ? "concepts" : "graph");
		if (arraysAreEqual(wordsToSearch, payload)) return;

		const newWordsToSearch: string[] = Array.from(new Set(payload));
		const wordsUnselected = wordsToSearch.filter((word: string) => {
			if (newWordsToSearch.includes(word)) return false;
			if (lastSelectedWordRef.current === word) {
				lastSelectedWordRef.current = newWordsToSearch[0];
			}
			return true;
		});

		try {
			const allStatements =
				extractedGraphDataRef.current?.all_statements_with_top;
			const unselectedStatements = filterStatements({
				statements: allStatements ?? [],
				wordsToSearch: wordsUnselected,
				wordsToHide,
				connectedWords: connected,
			}).map((statement) => statement.content ?? "");
			const elements = await unhighlightStatements(app, unselectedStatements);
			unObserveElementAttributes(elements);
			elements.forEach((el) =>
				el.classList.remove("infranodus-plugin-yellow-highlight")
			);
		} catch (err) {}

		const newWordsSelected = newWordsToSearch.filter(
			(word: string) => !wordsToSearch.includes(word)
		);
		if (newWordsSelected.length > 0) {
			lastSelectedWordRef.current = newWordsSelected[0];
		}
		if (newWordsToSearch.length > 0) setTopicsFiltered([]);
		setConnectedWords(connected);
		setWordsToSearch(newWordsToSearch);
	}

	function handleHideNodes(payload: string[]) {
		const { wordsToHide } = stateForMessagesRef.current;
		setIsHidingWords(payload.length > 0);
		if (arraysAreEqual(wordsToHide, payload)) return;
		const { wordsToSearch } = stateForMessagesRef.current;
		const remaining = wordsToSearch.filter((w) => !payload.includes(w));
		if (remaining.length !== wordsToSearch.length) setWordsToSearch(remaining);
		setWordsToHide(Array.from(new Set(payload)));
	}

	function handleSelectTopics(ids: string[]) {
		const { topicsFiltered } = stateForMessagesRef.current;
		setCurrentGraphPanel("topics");
		if (ids.length > 0 && stateForMessagesRef.current.wordsToSearch.length > 0)
			setWordsToSearch([]);
		if (ids.length === 0) setGapShown(false);
		if (!arraysAreEqual(topicsFiltered, ids)) setTopicsFiltered(ids);
	}

	function handleShowGap(index: number | false, communities?: string[]) {
		setCurrentGraphPanel("gaps");
		setGapShown(index);
		let ids = communities || [];
		if (index !== false && ids.length === 0) {
			const gap: any =
				extractedGraphDataRef.current?.gaps_extracted?.[index - 1];
			if (gap) ids = [String(gap.from.community), String(gap.to.community)];
		}
		if (stateForMessagesRef.current.wordsToSearch.length > 0)
			setWordsToSearch([]);
		setTopicsFiltered(index === false ? [] : ids);
	}

	function showContext(source: "next" | "gap") {
		const { wordsToSearch, topicsFiltered } = stateForMessagesRef.current;
		setAdviceMode("context");
		setOverlayShowMode("context");
		showGraphContextAdvice({ wordsToSearch, source, topicsFiltered });
		if (!Platform.isMobileApp && !Platform.isMobile)
			getMentionsOfFile(app, filePath || "", wordsToSearch);
	}

	function handleAction(action: GraphAction) {
		switch (action) {
			case "question":
			case "develop":
			case "transcend":
				setAdviceMode("none");
				setTimeout(() => setAdviceMode(action), 100);
				break;
			case "summarize":
				setAdviceMode("none");
				setTimeout(() => setAdviceMode("summary"), 100);
				break;
			case "chat":
				setOverlayShowMode("aiChat");
				break;
			case "context":
				showContext("next");
				break;
			case "context_gap":
				showContext("gap");
				break;
		}
	}

	function openVaultSearch(node: string) {
		const wikilink = node.match(/^\[\[(.+)\]\]$/);
		const query = wikilink ? `"${wikilink[1].trim()}"` : node.trim();
		const searchPlugin = (app as any).internalPlugins?.getPluginById?.(
			"global-search"
		);
		searchPlugin?.instance?.openGlobalSearch?.(query);
	}

	function handleOpenNode(node: string) {
		if (node.startsWith("[[") && node.endsWith("]]")) {
			navigateToStatement({
				app,
				filePath: filePath || "",
				filteredStatements: [],
				wordsToSearch: [node],
				graphContext: params.graphContext,
			});
		} else {
			openVaultSearch(node);
		}
	}

	// Stable callbacks for the canvas (always call the latest handlers)
	const handlersRef = useRef({
		handleSelectNodes,
		handleHideNodes,
		handleSelectTopics,
		handleShowGap,
		handleAction,
		handleOpenNode,
		openVaultSearch,
	});
	handlersRef.current = {
		handleSelectNodes,
		handleHideNodes,
		handleSelectTopics,
		handleShowGap,
		handleAction,
		handleOpenNode,
		openVaultSearch,
	};

	// Check for changes in text, but only for manual
	useEffect(() => {
		if (SETTINGS.RELOADING_GRAPH === "manual") {
			setShowingReloadButton(true);
			return;
		}
		// let originalText: string | undefined;
		let textCheck: number;

		let cleared = false;
		(async () => {
			const oldText =
				(
					await getContentsFromFilePath({
						app,
						filePath: filePath || "",
						ignoreLinkedUnlinked: true,
					})
				)?.content.trim() ?? "";

			textCheck = window.setInterval(async () => {
				if (cleared) {
					window.clearInterval(textCheck);
					return;
				}

				const newText =
					(
						await getContentsFromFilePath({
							app,
							filePath: filePath || "",
							ignoreLinkedUnlinked: true,
						})
					)?.content.trim() ?? "";
				if (cleared) return;
				if (newText !== oldText) {
					cleared = true;
					if (SETTINGS.RELOADING_GRAPH === "manual") {
						// console.log("[manual] showing reload button");
						// setShowingReloadButton(true);
						window.clearInterval(textCheck);
					} else if (SETTINGS.RELOADING_GRAPH === "automatic") {
						// console.log("[automatic] reloading graph");
						cleared = true;
						// params.graphContext.reloadGraph().catch((_) => {});
						window.clearInterval(textCheck);
						return;
					} else if (SETTINGS.RELOADING_GRAPH === "into reading") {
						window.clearInterval(textCheck);
					}
					window.clearInterval(textCheck);
				}
			}, 3000);
		})();
		return () => {
			cleared = true;
			window.clearInterval(textCheck);
		};
	}, []);

	const graphHeight = getGraphHeight({
		topTextElement: graph_top_text.current,
		maxHeight: params.graphContext.maxHeight,
		currentPlatform,
	});

	const [exportedGraph, setExportedGraph] = useState(false);

	return (
		<>
			<div
				className="flex flex-col items-center pb-2"
				ref={graph_top_text}
			>
				{filePath &&
					(params.graphContext.isRoot
						? `[ROOT] ${cleanFilePath}`
						: isFolder
						? `[FOLDER] ${cleanFilePath}`
						: cleanFilePath)}
				{contentString && sourcePath}
			</div>
			<div className={`relative ${colorScheme} @container/main`}>
				{graphData && (
					<GraphViewOverlay
						graphViewContext={graphViewContext!}
						graphContext={params.graphContext}
						overlayShowMode={overlayShowMode}
						setOverlayShowMode={setOverlayShowMode}
						showGraphContextAdvice={(source) =>
							showGraphContextAdvice({
								wordsToSearch,
								topicsFiltered,
								source,
							})
						}
						setTextToShow={setTextToShow}
						textToShow={textToShow}
						statementsToShow={statementsToShow}
						filteredStatements={filteredStatementsRef.current}
						topicsFiltered={topicsFiltered}
						navigateToStatement={navigateToStatement}
						showGap={(index: number) =>
							handlersRef.current.handleShowGap(index)
						}
						currentGraphPanel={currentGraphPanel}
						// showingGraphAdvice={showingGraphAdvice}
						// adviceMode="question"
					/>
				)}

				{/* Bottom right settings */}
				{showingSettings && (
					<GraphViewOverlaySettings
						graphContext={params.graphContext}
						closeSettings={() => setShowingSettings(false)}
						isFolder={isFolder}
						reloadGraph={params.graphContext.reloadGraph}
					/>
				)}

				<div className="absolute bottom-4 left-2 z-50 space-y-2">
					{/* Reloading graph button */}
					{((showingReloadButton && !showingSettings) || error) && (
						<InfoTooltip text="Reload graph" direction="right">
							<IconButton
								icon={SyncIcon}
								onClick={params.graphContext.reloadGraph}
							/>
						</InfoTooltip>
					)}

					{!showingSettings && graphData && (
						<InfoTooltip
							text="Save graph report to a note"
							direction="right"
						>
							<IconButton
								icon={exportedGraph ? CheckIcon : NoteIcon}
								onClick={async () => {
									if (exportedGraph || !extractedGraphDataRef.current)
										return;
									setExportedGraph(true);
									try {
										await saveGraphReport({
											app,
											title:
												(filePath && cleanFilePath) ||
												sourcePath ||
												"Graph",
											graphData: graphData!,
											extracted: extractedGraphDataRef.current,
											topicNames,
										});
									} catch (err) {
										new Notice(`Could not save report: ${err.message || err}`);
									}
									setTimeout(() => setExportedGraph(false), 2000);
								}}
							/>
						</InfoTooltip>
					)}

					{!showingSettings && (
						<InfoTooltip text="Plugin settings" direction="right">
							<IconButton
								icon={GearIcon}
								onClick={() => {
									setShowingSettings(true);
								}}
							/>
						</InfoTooltip>
					)}
				</div>

				<div id="graph-container" className="relative h-min mr-2">
					<LocalGraph
						graphData={graphData}
						topicNames={topicNames}
						colorScheme={
							colorScheme === "auto"
								? obsidianColorSchemeRef.current
								: colorScheme
						}
						height={graphHeight}
						wordsToSearch={wordsToSearch}
						wordsToHide={wordsToHide}
						topicsFiltered={topicsFiltered}
						gapShown={gapShown}
						panel={currentGraphPanel}
						isLoading={isLoadingIframe}
						onSelectNodes={(w, c) =>
							handlersRef.current.handleSelectNodes(w, c)
						}
						onHideNodes={(w) => handlersRef.current.handleHideNodes(w)}
						onSelectTopics={(ids) =>
							handlersRef.current.handleSelectTopics(ids)
						}
						onShowGap={(i, c) => handlersRef.current.handleShowGap(i, c)}
						onAction={(a) => handlersRef.current.handleAction(a)}
						onOpenNode={(n) => handlersRef.current.handleOpenNode(n)}
						onSearchNode={(n) => handlersRef.current.openVaultSearch(n)}
						onPanelChange={(p) => setCurrentGraphPanel(p)}
					/>
					{!showIframe && !error && (
						<div
							className="w-full bg-gray-300 dark:bg-gray-800"
							style={{ height: `${graphHeight}px` }}
						></div>
					)}
					{isLoadingIframe && !error && (
						<LoadingView loadingState={loadingState} />
					)}
					{!filePath && !contentString && !error && (
						<div className="absolute inset-0 z-[5] flex flex-col items-center justify-center dark:bg-black bg-opacity-50 bg-white">
							<span className="text-lg text-gray-600 dark:text-gray-200 animate-pulse">
								No file or content to analyze. Please, choose a
								specific file, folder, or search results.
							</span>
						</div>
					)}
					{error && (
						<ErrorHandler
							graphContext={params.graphContext}
							error={error}
							errorText={errorText}
							setError={setError}
							context={{
								setShowingSettings,
							}}
						/>
					)}
				</div>
			</div>
		</>
	);
};

function getGraphHeight(params: {
	topTextElement?: HTMLElement;
	maxHeight: number;
	currentPlatform: string;
}) {
	const topTextElement = params.topTextElement;
	const maxHeight = params.maxHeight;

	if (!topTextElement) return 700;
	const topTextHeight = topTextElement.getBoundingClientRect().height;

	// Accomodate for bottom bar, 70 for mobile, 50 for desktop
	const toRemoveBottom = params.currentPlatform === "mobile" ? 80 : 50;
	const graphHeight = maxHeight - topTextHeight - toRemoveBottom;
	return graphHeight;
}

export { GraphView };

async function navigateToStatement(params: {
	filteredStatements: StatementsObject[];
	filePath: string;
	app: App;
	wordsToSearch: string[];
	graphContext: PluginGraphContext;
}) {
	if (params.wordsToSearch.length === 0) return;
	// const file = params.app.vault.getAbstractFileByPath(params.filePath);
	// if (file?.parent) params.filePath = file.parent.path;
	const wordToSearch = params.wordsToSearch[0];

	// ===================================================================
	// Navigate to file with link ========================================

	let link = wordToSearch;
	if (wordToSearch.startsWith("[[") && wordToSearch.endsWith("]]")) {
		link = wordToSearch.slice(2, -2);
	}

	new Notice(`Navigating to file - ${link}`);
	let file: TFile | null = null;

	if (link.contains("|")) {
		let linkpath = link.split("|")[0];
		if (!linkpath.endsWith(".md")) linkpath += ".md";

		const abstractFile = findFileFromPath(params.app, linkpath);
		if (abstractFile) file = abstractFile;
		// console.log("Find file from path", file, linkpath);
	} else {
		let linkpath = link;
		// if (!linkpath.endsWith(".md")) linkpath += ".md";

		const abstractFile = findFileFromName(params.app, linkpath);
		if (abstractFile) file = abstractFile;
		// file = params.app.metadataCache.getFirstLinkpathDest(
		// 	getLinkpath(link),
		// 	link
		// );
	}

	// ===================================================================
	// Create file ===================================
	if (!file) {
		const newLink = link.replace(/_/g, " ");

		const abstractFile = findFileFromName(params.app, link);
		if (abstractFile) file = abstractFile;

		if (!file) {
			// console.log("File not found, creating");
			new Notice("File not found, creating");

			// Create a new file
			// const newFile = await params.app.vault.create(link + ".md", "");
			let linkPath = newLink;
			if (linkPath.contains("|")) linkPath = newLink.split("|")[0];
			if (!linkPath.endsWith(".md")) linkPath += ".md";

			const newFile = await params.app.vault.create(linkPath, "");
			// console.log("New File!", newFile.path, newFile);
			file = newFile;
		}
	}

	if (file) {
		const leaf = await openLeafWithPath(file, params.app.workspace);
		// console.log("Leaf", leaf);
		if (leaf) {
			const file = ((leaf?.view ?? ({} as any)) as any).file;
			await params.graphContext.reloadGraph(
				{
					leaf,
					filePath: file?.path ?? params.filePath,
					fromLayoutChange: true,
					initialData: { wordsToSearch: params.wordsToSearch },
				},
				true
			);
		}
		return;
	}
}

function searchGoogleText(params: {
	topicsExtracted: TopicsObject[];
	topicsFiltered: string[];
	wordsToSearch: string[];
}) {
	const graphText = convertGraphToText({ noCodes: true, ...params });
	const encodedText = encodeURIComponent(graphText);
	const linkToOpen = `https://google.com/search?q=${encodedText}`;
	window.open(linkToOpen, "_blank");
}

function convertGraphToText(params: {
	noCodes?: boolean;
	topicsExtracted: TopicsObject[];
	topicsFiltered: string[];
	wordsToSearch: string[];
}) {
	const { noCodes, topicsExtracted, topicsFiltered, wordsToSearch } = params;

	let graphText = "";

	if (wordsToSearch && wordsToSearch.length > 0) {
		graphText = wordsToSearch.join(", ");
	} else if (topicsFiltered && topicsFiltered.length > 0) {
		const topicsToUse = topicsExtracted.filter((topic: any) =>
			topicsFiltered.includes(topic.id)
		);

		graphText = topicsToUse
			.map(
				(topic: any) =>
					`${noCodes ? "" : `[${topic.id}]: `}${
						topic.aiName ?? ""
					} (${topic.words.slice(0, 8).join(" ")})`
			)
			.join(", ");
	} else {
		graphText = topicsExtracted
			.map(
				(topic: any) =>
					`${noCodes ? "" : `[${topic.id}]: `}${
						topic.aiName ?? ""
					} (${topic.words.slice(0, 8).join(" ")})`
			)
			.join(", ");
	}
	return graphText;
}
