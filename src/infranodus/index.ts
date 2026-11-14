import { GraphAndStatementProcessingType, SETTINGS } from "src/settings";

import { AnswerInfraNodusTopics } from "src/types/messaging";
import { InfraNodusExtractedGraphData } from "./types";
import { StatementsObject, TopicsObject } from "src/types/general";
import { AdviceMode } from "src/graph_view/types";

import { PossibleError } from "src/graph_view/components/ErrorHandler";
import { INFRANODUS_API_ERROR_PREFIX } from "src/graph_view/lib/handleErrors";
import { GraphPanel } from "src/graph_view/types";

import { buildGraphAndStatements } from "src/engine/textNetwork";
import { complete } from "src/ai/client";
import {
	buildAdvicePrompt,
	buildChatSystem,
	buildTopicNamesPrompt,
	parseTopicNames,
	splitAlternatives,
} from "src/ai/prompts";
import { findRelatedStatements } from "src/ai/search";

const MAX_CONTEXT_SIZE = 54000;

/**
 * Local replacement for the InfraNodus API client. The method names and
 * response shapes are kept so the UI code is unchanged:
 *  - graph building runs in src/engine (no network)
 *  - AI calls go to the provider configured for each task (src/ai)
 */
class InfraNodus {
	public static async generateRelatedStatements(params: {
		query: any;
		text: any;
		similarityThreshold: any;
	}) {
		const similarityThreshold = params.similarityThreshold
			? parseFloat(params.similarityThreshold)
			: 0.3;
		const statements: string[] = Array.isArray(params.text)
			? params.text
			: String(params.text || "").split("\n");
		const data = await findRelatedStatements({
			query: String(params.query || ""),
			statements,
			similarityThreshold,
			numberOfResults: 10,
		});
		return { data };
	}

	public static async getGraphAndStatements(params: {
		name: string;
		text: string;
		contextSettings: GraphAndStatementProcessingType;
		stopwords?: string[];
		statements?: string[];
		categories?: string[][];
		linkPageToMentions?: string;
	}): Promise<{ data: AnswerInfraNodusTopics }> {
		// let the loading state render before the synchronous analysis
		await new Promise((resolve) => setTimeout(resolve, 20));
		try {
			const data = buildGraphAndStatements({
				text: params.text,
				statements:
					params.statements && params.statements.length > 0
						? params.statements
						: undefined,
				categories: params.categories,
				contextSettings: params.contextSettings,
				stopwords: params.stopwords,
				linkPageToMentions: params.linkPageToMentions,
				maxNodes: Number(SETTINGS.MAX_GRAPH_NODES) || 300,
			});
			return { data };
		} catch (err) {
			console.error("[graph-ai] local graph analysis failed", err);
			return {
				data: {
					error: `Local graph analysis failed: ${err?.message || err}`,
				} as any,
			};
		}
	}

	public static extractDataFromGraphData(params: {
		graph_data: any;
		setError: (error: PossibleError) => void;
	}): InfraNodusExtractedGraphData {
		if (!params.graph_data) {
			throw new Error(
				"Could not retrieve data from InfraNodus. Please, check connection or your API key."
			);
		}

		// Topics Answer
		const topics_answer = params.graph_data;
		const error = params.graph_data?.error;

		if (error && error.includes("login")) {
			throw new Error(
				"Please, update your API key in the InfraNodus graph view settings."
			);
		} else if (
			typeof error === "string" &&
			error.length > 0 &&
			!params.graph_data.entriesAndGraphOfContext
		) {
			// Show the actual error reported by the API
			throw new Error(INFRANODUS_API_ERROR_PREFIX + error);
		} else if (!params.graph_data.entriesAndGraphOfContext) {
			throw new Error(
				"Could not parse the response from InfraNodus topics identifier. Please, check if there is any content on this page, check your text processing settings, and make sure your API key is up to date."
			);
		}

		// Top clusters, gaps, and top statements
		const top_clusters =
			topics_answer?.entriesAndGraphOfContext?.graph?.graphologyGraph?.attributes?.top_clusters?.map(
				(cluster: any) => {
					cluster.words = cluster.nodes.map(
						(node: any) => node?.nodeName
					);
					cluster.id = cluster.community;
					return cluster;
				}
			) || [];

		const top_words: string[] =
			topics_answer?.entriesAndGraphOfContext?.graph?.graphologyGraph
				?.attributes?.top_nodes ?? [];

		const gaps_extracted =
			topics_answer?.entriesAndGraphOfContext?.graph?.graphologyGraph
				?.attributes?.gaps || [];

		const dot_graph =
			topics_answer?.entriesAndGraphOfContext?.graph?.graphologyGraph
				?.attributes?.dotGraph || "";

		const bigrams =
			topics_answer?.entriesAndGraphOfContext?.graph?.graphologyGraph
				?.attributes?.bigrams || [];

		const dot_graph_clusters =
			topics_answer?.entriesAndGraphOfContext?.graph?.graphologyGraph
				?.attributes?.dotGraphByCluster || {};

		const all_statements =
			topics_answer?.entriesAndGraphOfContext?.statements || [];

		const top_statements_for_topics_extracted = top_clusters
			? top_clusters.map((topic: any) => {
					const topStatementId = topic.topStatementId;
					const topStatement = all_statements.find(
						(statement: any) =>
							statement.id == topStatementId ||
							parseInt(statement.id) == topStatementId
					);
					return {
						...topStatement,
						topStatementOfCommunity: topic.community,
					};
			  })
			: [];

		// Statements

		const top_statements = top_statements_for_topics_extracted;

		const all_statements_with_top: any[] = [];

		let statements_as_string = "";
		all_statements?.forEach((statement: any) => {
			const topStatements = top_statements_for_topics_extracted.filter(
				(topStatement: any) => topStatement.id == statement.id
			);

			if (topStatements.length > 0) {
				topStatements.forEach((topStatement: any) => {
					all_statements_with_top.push({
						...statement,
						topStatementOfCommunity:
							topStatement.topStatementOfCommunity,
					});
				});
				return;
			}

			statements_as_string += statement.content + "\n";
			all_statements_with_top.push(statement);
		});

		// Node Relations
		const all_relations =
			topics_answer &&
			topics_answer.entriesAndGraphOfContext &&
			topics_answer.entriesAndGraphOfContext.graph.graphologyGraph &&
			topics_answer.entriesAndGraphOfContext.graph.graphologyGraph.edges
				? topics_answer.entriesAndGraphOfContext.graph.graphologyGraph
						.edges
				: [];

		const contentExistsButNoAnalysis =
			!top_clusters.length && statements_as_string ? true : false;

		if (contentExistsButNoAnalysis) {
			params.setError("content-empty");
			throw new Error(
				`Could not convert the content of the page into a graph. `
			);
		}
		return {
			top_clusters,
			gaps_extracted,
			all_statements_with_top,
			top_statements,
			all_relations,
			statements_as_string,
			top_words,
			dot_graph,
			dot_graph_clusters,
			bigrams,
		};
	}

	public static extractTopicsArrayFromTopicsAnswer(params: {
		topics_answer: any;
		top_clusters: any[];
	}) {
		const newTopicsArray = params.top_clusters
			.map(
				(
					cluster: {
						community: string;
						nodes: any[];
						numberRatio: string;
						bcRatio: string;
					},
					index
				) => {
					const words = cluster.nodes.map((node) => node.nodeName);

					//   const tempTopicArray =
					//   aiTopicsAnswer && aiTopicsAnswer[index] ? aiTopicsAnswer[index].split('. ') : []

					// const aiWithDescription = tempTopicArray[1] ? tempTopicArray[1] : ''

					// let aiName = aiWithDescription
					// let aiDescription = ''

					// const aiWithDescriptionArray = aiWithDescription.split(' - ')

					// if (aiWithDescriptionArray && aiWithDescriptionArray.length > 1) {
					//   aiName = aiWithDescriptionArray[0]
					//   aiDescription = ` - ${aiWithDescriptionArray[1]}`
					// }

					// arrayOfTopicsAsText.push(`${aiWithDescription}\n${words.slice(0, 9).join(' ')}`)

					return {
						id: cluster.community,
						sortId: index,
						numberRatio: cluster.numberRatio,
						bcRatio: cluster.bcRatio,
						words,
						// aiName,
						// aiDescription,
					};
				}
			)
			.filter((topic) => topic !== null);
	}

	public static async generateAiNamesForTopics(params: {
		graph_data: any;
		top_clusters: any[];
		language: string;
		top_statements: any[];
	}) {
		const clusters = params.top_clusters.map((topic: any) => ({
			id: String(topic.id ?? topic.community),
			words: (topic.nodes || []).map((n: any) => n.nodeName),
		}));
		if (clusters.length === 0) return [];
		const statements = (params.top_statements || [])
			.filter((s: any) => s && s.content)
			.map((s: any) => ({
				community: String(s.topStatementOfCommunity),
				content: s.content,
			}));
		const { system, user } = buildTopicNamesPrompt({ clusters, statements });
		const text = await complete("topics", {
			system,
			messages: [{ role: "user", content: user }],
			maxTokens: 1500,
			temperature: 0.3,
		});
		const names = parseTopicNames(text, clusters.length);
		return clusters.map((c, i) => ({
			id: c.id,
			name: names[i] || c.words.slice(0, 3).join(" "),
			description: "",
		}));
	}

	public static generatePromptForAdvice(params: {
		adviceMode: AdviceMode;
		topics: TopicsObject[]; // this parameter will be always specific to selections
		topStatementsForTopics: StatementsObject[];
		allStatements: StatementsObject[];
		dotGraph: string;
		dotGraphClusters: any[];
		userSettings: any;
		currentGraphPanel: GraphPanel;
		wordsToSearch: string[];
		bigrams: string[];
	}) {
		let currentContextSize = 0;

		const { topics, topStatementsForTopics, allStatements } = params;

		const topicIdsToUse = topics.map(
			(topic: any) => topic.community || topic.id
		);

		const dotGraphClusters = params.dotGraphClusters;

		const { dotGraphByTopic, dotGraphConnectors } =
			InfraNodus.generateDotGraphByTopic({
				topicsFiltered: topicIdsToUse,
				topicsExtracted: topics,
				wordsToSearch: params.wordsToSearch,
				dotGraphByCluster: dotGraphClusters,
			});

		const dotGraphPrompt = dotGraphByTopic
			? Object.keys(dotGraphByTopic)
					.map((clusterId: any): string | undefined => {
						return dotGraphByTopic[clusterId].join("; ");
					})
					.filter((x): x is string => x !== undefined)
					.join("; \n") +
			  (dotGraphConnectors ? `\n${dotGraphConnectors}` : "")
			: "";

		const chronologicalTopStatements = topStatementsForTopics
			.sort((a: any, b: any) => {
				return a.id - b.id;
			})
			.filter((statement: any) =>
				topicIdsToUse.includes(statement.topStatementOfCommunity)
			)
			.map((statement: any) => statement.content)
			.join("\n\n");

		const typeOfSummaryToGenerate =
			params.currentGraphPanel == "topics" && topics && topics.length > 2
				? "graph summary"
				: "summary";

		const dotGraphClustersPrompt = topics
			.map((topic: any) => {
				if (!dotGraphClusters[topic.id]) return "";
				const statementToAdd = topStatementsForTopics
					.filter(
						(statement: any) =>
							statement.topStatementOfCommunity == topic.id
					)
					.map((statement: any) => statement.content)
					.join("\n\n");
				return `[cluster ${topic.id}]: ${
					topic.aiName
				} ${dotGraphClusters[topic.id].join("; ")} ${
					statementToAdd ? `\n${statementToAdd}` : ""
				}`;
			})
			.filter((n) => n)
			.join("\n");

		const bigramsWithWeight = params?.bigrams || [];

		const bigramsThatContainKeywords =
			bigramsWithWeight && bigramsWithWeight.length > 0
				? bigramsWithWeight.filter((bigram) =>
						params.wordsToSearch.some((word) =>
							bigram
								.split(" [weight")[0]
								.toLowerCase()
								.includes(word.toLowerCase())
						)
				  )
				: [];

		const bigramsForKeywords =
			bigramsThatContainKeywords
				?.slice(0, 10)
				.map((bigram: any) => bigram.split(" [weight")[0]) || [];

		const userPromptToUse =
			typeOfSummaryToGenerate == "summary"
				? params.wordsToSearch && params.wordsToSearch.length > 0
					? params.wordsToSearch.join(" ") +
					  "\n" +
					  bigramsForKeywords.join("\n ") +
					  "\n " +
					  chronologicalTopStatements
					: chronologicalTopStatements
				: typeOfSummaryToGenerate == "graph summary"
				? dotGraphClustersPrompt
				: params.wordsToSearch && params.wordsToSearch.length > 0
				? params.wordsToSearch.join(" ") +
				  "\n" +
				  bigramsForKeywords.join("")
				: topics
						.map(
							(topic: any) =>
								`"[cluster ${topic.id}]: ${
									topic.aiName ? topic.aiName + " — " : ""
								}${topic.words.slice(0, 9).join(", ")}"`
						)
						.join(" and ");

		currentContextSize += userPromptToUse.length;

		const totalTopicsNumber = topics.length;

		const topStatementsToAddToContext = {} as any;
		const allStatementsOfTopics = {} as any;

		allStatements.forEach((statement: any) => {
			topicIdsToUse.forEach((topicId: string) => {
				// what is the single top statement for this topic?
				// DO NOT ADD for summary mode as we have them in the main prompt
				if (
					statement.topStatementOfCommunity == topicId &&
					params.adviceMode != "summary"
				) {
					if (!topStatementsToAddToContext[topicId])
						topStatementsToAddToContext[topicId] = [];
					topStatementsToAddToContext[topicId].push(
						statement.content
					);
				}
				// which statements are in this topic?
				if (statement.topStatementCommunity == topicId) {
					if (!allStatementsOfTopics[topicId])
						allStatementsOfTopics[topicId] = [];
					allStatementsOfTopics[topicId].push(statement.content);
				}
			});
		});

		const conceptsInTopics = topics
			.map(
				(topic: any) =>
					`{topic: ${topic.id}${
						topic.aiName ? `, name: "${topic.aiName}"` : ""
					}, concepts: "${topic.words.slice(0, 9).join(", ")}"}`
			)
			.join(" | ");

		const dotGraph = dotGraphPrompt || conceptsInTopics;

		currentContextSize += dotGraph.length;

		const maxPromptSizeForModel =
			Number(SETTINGS.AI_MAX_CONTEXT_CHARS) || MAX_CONTEXT_SIZE;

		const defaultSizePerTopic =
			params.adviceMode == "summary" ? 5000 : 1500;

		const maxSizePerTopic = Math.min(
			Math.floor(
				(maxPromptSizeForModel - currentContextSize) / totalTopicsNumber
			),
			defaultSizePerTopic
		);

		const additionalPromptContext = topics
			.map((topic: any, index) => {
				let cumulativeLengthOfTopic = 0;

				const topStatements = topStatementsToAddToContext[topic.id]
					? topStatementsToAddToContext[topic.id].filter(
							(statement: any) => {
								cumulativeLengthOfTopic += statement.length;
								if (cumulativeLengthOfTopic > maxSizePerTopic)
									return false;
								return true;
							}
					  )
					: [];

				const additionalStatements = allStatementsOfTopics[topic.id]
					? allStatementsOfTopics[topic.id].filter(
							(statement: any) => {
								cumulativeLengthOfTopic += statement.length;
								if (cumulativeLengthOfTopic > maxSizePerTopic)
									return false;
								return true;
							}
					  )
					: [];

				const statements = [...topStatements, ...additionalStatements];

				return (
					"[cluster " +
					topic.id +
					"]" +
					(topic.aiName ? ' "' + topic.aiName + '"' : "") +
					':"\n' +
					topic.words.slice(0, 9).join(", ") +
					'":\n ' +
					statements.join(" ") +
					'"'
				);
			})
			.join("\n<---->\n");

		return {
			prompt: userPromptToUse,
			promptGraph: dotGraph,
			promptContext: additionalPromptContext,
		};
	}

	public static generatePromptForAiTopics(params: {
		topics_answer: any;
		top_statements: any[];
	}) {
		const dotGraphByCluster =
			params.topics_answer?.entriesAndGraphOfContext?.graph
				?.graphologyGraph?.attributes?.dotGraphByCluster || {};

		const topClusters =
			params.topics_answer?.entriesAndGraphOfContext?.graph
				.graphologyGraph.attributes.top_clusters || [];

		const topStatements = params.top_statements;

		const promptContext = topStatements
			.map((statement: any) => {
				return `[cluster ${statement.topStatementOfCommunity}]: ${statement.content}`;
			})
			.join("\n");

		const topClustersPrompt = topClusters.map((topic: any) => {
			return {
				text: `"${topic.nodes
					.map((node: any) => node.nodeName)
					.slice(0, 9)
					.join(", ")}"`,
				id: topic.id,
				community: topic.id,
				dotGraph: dotGraphByCluster[topic.id] || "",
			};
		});

		return {
			prompt: topClustersPrompt,
			promptContext: promptContext,
		};
	}

	private static generateDotGraphByTopic({
		topicsFiltered,
		topicsExtracted,
		wordsToSearch,
		dotGraphByCluster,
	}: {
		topicsFiltered: string[];
		topicsExtracted: any[];
		wordsToSearch: string[];
		dotGraphByCluster: any;
	}) {
		const dotGraphByTopic =
			topicsFiltered && topicsFiltered.length > 0
				? topicsFiltered.map((id: string) => dotGraphByCluster[id])
				: topicsExtracted
						.map((topic: any) => {
							const topicClusters =
								dotGraphByCluster[topic.id] || [];

							const clustersToReturn = topicClusters
								.map((cluster: any) => {
									if (
										!wordsToSearch ||
										(wordsToSearch &&
											wordsToSearch.length === 0)
									) {
										return cluster;
									}

									if (
										wordsToSearch &&
										wordsToSearch.length > 0 &&
										wordsToSearch.some((word: string) =>
											cluster.includes(word)
										)
									) {
										return cluster;
									}
								})
								.filter((cluster: any) => cluster)
								.join("; ");

							return clustersToReturn;
						})
						.filter((cluster: any) => cluster);

		const dotGraphConnectors = Object.keys(dotGraphByCluster)
			.map((id: string) => {
				if (id != "inter_cluster" && id != "top_nodes") {
					return null;
				}

				const extraClusters = dotGraphByCluster[id].slice(0, 4);

				const clustersToReturn = extraClusters
					.map((cluster: any) => {
						if (
							(!wordsToSearch ||
								(wordsToSearch &&
									wordsToSearch.length === 0)) &&
							(!topicsFiltered ||
								(topicsFiltered && topicsFiltered.length === 0))
						) {
							return cluster;
						}

						if (
							wordsToSearch &&
							wordsToSearch.length > 0 &&
							wordsToSearch.some((word: string) =>
								cluster.includes(word)
							)
						) {
							return cluster;
						}

						if (topicsFiltered && topicsFiltered.length > 0) {
							let clusterToReturn = "";
							topicsExtracted.forEach((topic: any) => {
								if (!topicsFiltered.includes(topic.id)) return;

								if (
									topic.words.some((word: string) =>
										cluster.includes(word)
									)
								) {
									clusterToReturn = cluster;
								}
							});
							return clusterToReturn;
						}
					})
					.filter((cluster: any) => cluster)
					.join(", ");

				return clustersToReturn;
			})
			.filter((cluster: any) => cluster)
			.join("\n\n");

		return {
			dotGraphByTopic,
			dotGraphConnectors,
		};
	}

	/**
	 * AI advice / chat. Returns `{ data: { choices } }` like the InfraNodus
	 * API did: `choices[i].text` for advice, `choices[0].message.content`
	 * for chat responses.
	 */
	public static async generateAdvice(params: {
		prompt: string;
		language?: string;
		promptGraph?: string;
		promptContext?: string;
		type?: string;
		source?: string;
		modal?: string;
		requestMode?: string;
	}): Promise<{ data: any }> {
		try {
			if (params.type === "chatResponse" || params.type === "response") {
				const text = await complete("chat", {
					system: buildChatSystem(params.promptGraph || ""),
					messages: [{ role: "user", content: params.prompt }],
				});
				return {
					data: { choices: [{ message: { role: "assistant", content: text }, text }] },
				};
			}

			const mode = params.requestMode === "transcend" ? "transcend" : params.type || "summary";
			const built = buildAdvicePrompt({
				mode,
				prompt: params.prompt,
				promptGraph: params.promptGraph,
				promptContext: params.promptContext,
			});
			const text = await complete("insights", {
				system: built.system,
				messages: [{ role: "user", content: built.user }],
			});
			const choices = (built.alternatives ? splitAlternatives(text) : [text]).map(
				(t) => ({ text: t })
			);
			return { data: { choices } };
		} catch (err) {
			console.error("[graph-ai] AI request failed", err);
			return { data: { error: err?.message || String(err), choices: [] } };
		}
	}
}

export { InfraNodus };
