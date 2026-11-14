/**
 * Local interactive graph view — replaces the remote graph.infranodus.com
 * iframe. Renders the text network on a canvas (force-graph / d3-force)
 * and provides the Topics / Gaps / Concepts panels and the AI action bar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph from "force-graph";
// @ts-ignore no types
import { forceCollide, forceX, forceY } from "d3-force-3d";
import { Menu } from "obsidian";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	CommentDiscussionIcon,
	LightBulbIcon,
	QuestionIcon,
	QuoteIcon,
	RocketIcon,
	SparkleFillIcon,
	XIcon,
} from "@primer/octicons-react";
import type { AnswerInfraNodusTopics } from "src/types/messaging";
import type { GraphPanel } from "../types";

const PALETTE = [
	"#8b5cf6",
	"#06b6d4",
	"#f59e0b",
	"#ef4444",
	"#10b981",
	"#ec4899",
	"#3b82f6",
	"#84cc16",
	"#f97316",
	"#14b8a6",
	"#a855f7",
	"#eab308",
];
const OTHER_COLOR = "#9ca3af";

type GraphAction =
	| "summarize"
	| "question"
	| "develop"
	| "transcend"
	| "chat"
	| "context"
	| "context_gap";

interface GNode {
	id: string;
	label: string;
	community: string;
	bc: number;
	bcNorm: number;
	degree: number;
	weightedDegree: number;
	kind: string;
	rank: number;
	r: number;
	color: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
}

interface GLink {
	source: string | GNode;
	target: string | GNode;
	weight: number;
}

interface LocalGraphProps {
	graphData?: AnswerInfraNodusTopics;
	topicNames: Record<string, string>;
	colorScheme: string;
	height: number;
	wordsToSearch: string[];
	wordsToHide: string[];
	topicsFiltered: string[];
	gapShown: number | false;
	panel: GraphPanel;
	isLoading: boolean;
	onSelectNodes: (words: string[], connected: string[]) => void;
	onHideNodes: (words: string[]) => void;
	onSelectTopics: (ids: string[]) => void;
	onShowGap: (index: number | false, communities: string[]) => void;
	onAction: (action: GraphAction) => void;
	onOpenNode: (node: string) => void;
	onSearchNode: (node: string) => void;
	onPanelChange: (panel: GraphPanel) => void;
}

function hexToRgba(hex: string, alpha: number) {
	const h = hex.replace("#", "");
	const n = parseInt(h, 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Canvas fonts cannot use CSS variables: resolve Obsidian's UI font once
let FONT_FAMILY = "";
function fontFamily(): string {
	if (FONT_FAMILY) return FONT_FAMILY;
	let f = "";
	try {
		f = getComputedStyle(document.body).getPropertyValue("--font-interface").trim();
	} catch (_) {
		/* ignore */
	}
	FONT_FAMILY = f || "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif";
	return FONT_FAMILY;
}

function linkEnd(v: string | GNode): string {
	return typeof v === "string" ? v : v.id;
}

const LocalGraph = (props: LocalGraphProps) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasHostRef = useRef<HTMLDivElement>(null);
	const fgRef = useRef<any>(null);
	const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
	const lastClickRef = useRef<{ id: string; t: number } | null>(null);
	const fittedRef = useRef(false);

	const [hoverNode, setHoverNode] = useState<string | null>(null);
	const [hoverTopic, setHoverTopic] = useState<string | null>(null);
	const [panelOpen, setPanelOpen] = useState(true);
	const [search, setSearch] = useState("");
	const [width, setWidth] = useState(600);

	const dark = props.colorScheme === "dark";

	// ------------------------------------------------------------ data
	const attrs: any =
		props.graphData?.entriesAndGraphOfContext?.graph?.graphologyGraph?.attributes || {};
	const topClusters: any[] = attrs.top_clusters || [];
	const gaps: any[] = attrs.gaps || [];

	const communityColor = useMemo(() => {
		const map: Record<string, string> = {};
		topClusters.forEach((c: any, i: number) => {
			map[String(c.community)] = PALETTE[i % PALETTE.length];
		});
		return map;
	}, [props.graphData]);

	const model = useMemo(() => {
		const gg = props.graphData?.entriesAndGraphOfContext?.graph?.graphologyGraph;
		const rawNodes: any[] = gg?.nodes || [];
		const rawEdges: any[] = gg?.edges || [];
		const sorted = rawNodes
			.slice()
			.sort((a, b) => (b.attributes?.bc || 0) - (a.attributes?.bc || 0));
		const rank: Record<string, number> = {};
		sorted.forEach((n, i) => (rank[n.key] = i));
		const maxW = Math.max(...rawEdges.map((e) => e.attributes?.weight || 1), 1);

		const nodes: GNode[] = rawNodes.map((n) => {
			const a = n.attributes || {};
			const bcNorm = a.bcNorm ?? 0;
			const prev = positionsRef.current.get(n.key);
			return {
				id: n.key,
				label: a.label || n.key,
				community: String(a.community ?? ""),
				bc: a.bc || 0,
				bcNorm,
				degree: a.degree || 0,
				weightedDegree: a.weightedDegree || 0,
				kind: a.kind || "word",
				rank: rank[n.key] ?? 9999,
				r: 2.5 + 11 * Math.sqrt(bcNorm) + Math.min(3, Math.log1p(a.degree || 0) * 0.6),
				color: communityColor[String(a.community)] || OTHER_COLOR,
				...(prev ? { x: prev.x, y: prev.y } : {}),
			};
		});
		const links: GLink[] = rawEdges.map((e) => ({
			source: e.source,
			target: e.target,
			weight: e.attributes?.weight || 1,
		}));
		const neighbors = new Map<string, Set<string>>();
		for (const l of links) {
			const s = linkEnd(l.source);
			const t = linkEnd(l.target);
			if (!neighbors.has(s)) neighbors.set(s, new Set());
			if (!neighbors.has(t)) neighbors.set(t, new Set());
			neighbors.get(s)!.add(t);
			neighbors.get(t)!.add(s);
		}
		return { nodes, links, neighbors, maxW };
	}, [props.graphData, communityColor]);

	// ------------------------------------------------------- focus state
	const focusRef = useRef<{
		active: boolean;
		primary: Set<string>;
		secondary: Set<string>;
		selected: Set<string>;
		communities: Set<string>;
	}>({
		active: false,
		primary: new Set(),
		secondary: new Set(),
		selected: new Set(),
		communities: new Set(),
	});

	const searchMatches = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return [] as GNode[];
		return model.nodes
			.filter((n) => n.label.toLowerCase().includes(q))
			.sort((a, b) => a.rank - b.rank)
			.slice(0, 12);
	}, [search, model]);

	useEffect(() => {
		const primary = new Set<string>();
		const secondary = new Set<string>();
		const selected = new Set(props.wordsToSearch);
		const communities = new Set<string>();

		if (hoverNode) {
			primary.add(hoverNode);
			model.neighbors.get(hoverNode)?.forEach((n) => secondary.add(n));
		} else if (hoverTopic) {
			communities.add(hoverTopic);
		} else if (props.wordsToSearch.length > 0) {
			for (const w of props.wordsToSearch) {
				primary.add(w);
				model.neighbors.get(w)?.forEach((n) => secondary.add(n));
			}
		} else if (props.topicsFiltered.length > 0) {
			props.topicsFiltered.forEach((t) => communities.add(String(t)));
		} else if (searchMatches.length > 0) {
			searchMatches.forEach((n) => primary.add(n.id));
		}
		if (communities.size > 0) {
			for (const n of model.nodes) if (communities.has(n.community)) primary.add(n.id);
		}
		focusRef.current = {
			active: primary.size > 0 || communities.size > 0,
			primary,
			secondary,
			selected,
			communities,
		};
		redraw();
	}, [hoverNode, hoverTopic, props.wordsToSearch, props.topicsFiltered, searchMatches, model]);

	// --------------------------------------------------------- drawing
	const theme = useMemo(
		() => ({
			bg: dark ? "#0d1117" : "#f4f5f7",
			text: dark ? "#e6edf3" : "#1f2328",
			halo: dark ? "rgba(13,17,23,0.85)" : "rgba(244,245,247,0.9)",
			link: dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.09)",
			linkDim: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.025)",
		}),
		[dark]
	);
	const themeRef = useRef(theme);
	themeRef.current = theme;

	function drawNode(node: GNode, ctx: CanvasRenderingContext2D, scale: number) {
		const f = focusRef.current;
		const t = themeRef.current;
		const inPrimary = f.primary.has(node.id);
		const inSecondary = f.secondary.has(node.id);
		const dimmed = f.active && !inPrimary && !inSecondary;
		const alpha = dimmed ? 0.12 : inSecondary && !inPrimary ? 0.75 : 1;

		ctx.beginPath();
		ctx.arc(node.x!, node.y!, node.r, 0, 2 * Math.PI);
		ctx.fillStyle = hexToRgba(node.color, alpha);
		ctx.fill();
		if (node.kind !== "word") {
			ctx.lineWidth = 1.2 / scale;
			ctx.strokeStyle = hexToRgba(node.color, Math.min(1, alpha + 0.2));
			ctx.stroke();
		}
		if (f.selected.has(node.id)) {
			ctx.beginPath();
			ctx.arc(node.x!, node.y!, node.r + 3 / scale, 0, 2 * Math.PI);
			ctx.lineWidth = 2 / scale;
			ctx.strokeStyle = t.text;
			ctx.stroke();
		}

		// labels: most influential first, more as you zoom in, always for focus
		const budget = Math.max(30, Math.round(45 * scale * scale));
		const showLabel =
			f.selected.has(node.id) ||
			(inPrimary && (f.communities.size === 0 || node.rank < budget * 3)) ||
			(!f.active && node.rank < budget) ||
			(inSecondary && node.rank < budget * 2);
		if (!showLabel) return;
		const px = Math.min(20, 10 + 9 * Math.sqrt(node.bcNorm));
		const fontSize = px / scale;
		ctx.font = `${node.kind !== "word" || node.rank < 5 ? "600 " : ""}${fontSize}px ${fontFamily()}`;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		const y = node.y! + node.r + 2 / scale;
		ctx.lineWidth = 3 / scale;
		ctx.strokeStyle = t.halo;
		ctx.strokeText(node.label, node.x!, y);
		ctx.fillStyle = dimmed ? hexToRgba(t.text, 0.25) : t.text;
		ctx.fillText(node.label, node.x!, y);
	}

	function paintPointer(node: GNode, color: string, ctx: CanvasRenderingContext2D) {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(node.x!, node.y!, node.r + 2, 0, 2 * Math.PI);
		ctx.fill();
	}

	function linkColor(l: GLink) {
		const f = focusRef.current;
		const t = themeRef.current;
		if (!f.active) return t.link;
		const s = linkEnd(l.source);
		const d = linkEnd(l.target);
		const sp = f.primary.has(s);
		const dp = f.primary.has(d);
		if (sp || dp) {
			const n = (typeof l.source === "string" ? null : (sp ? l.source : l.target)) as GNode | null;
			const color = n?.color || OTHER_COLOR;
			if (sp && dp) return hexToRgba(color, f.communities.size > 0 ? 0.35 : 0.7);
			// topic focus: keep links leaving the topic faint
			return hexToRgba(color, f.communities.size > 0 ? 0.06 : 0.4);
		}
		return t.linkDim;
	}

	const panelOpenRef = useRef(true);
	function fitView(duration: number) {
		const fg = fgRef.current;
		if (!fg) return;
		fg.zoomToFit(duration, 24);
		const w = containerRef.current?.clientWidth || 0;
		if (!panelOpenRef.current || w < 520) return;
		// leave room for the side panel on the right
		setTimeout(() => {
			const f = fgRef.current;
			if (!f) return;
			const k = f.zoom();
			const usable = Math.max(0.5, (w - 290) / w);
			f.zoom(k * usable, 0);
			const c = f.centerAt();
			f.centerAt(c.x + 145 / (k * usable), c.y, 0);
		}, duration + 10);
	}

	function redraw() {
		const fg = fgRef.current;
		if (!fg) return;
		fg.nodeCanvasObject((n: GNode, c: CanvasRenderingContext2D, s: number) => drawNode(n, c, s));
		fg.linkColor((l: GLink) => linkColor(l));
	}

	// --------------------------------------------------- graph instance
	useEffect(() => {
		if (!canvasHostRef.current) return;
		const fg = new (ForceGraph as any)(canvasHostRef.current);
		fgRef.current = fg;
		fg.backgroundColor("rgba(0,0,0,0)")
			.nodeId("id")
			.nodeRelSize(1)
			.nodeVal((n: GNode) => n.r * n.r)
			.nodeLabel((n: GNode) => {
				const topic = topicNamesRef.current[n.community];
				return `<div style="padding:4px 6px;font-size:12px"><b>${escapeHtml(n.label)}</b><br/>influence ${(n.bcNorm * 100).toFixed(0)}% · ${n.degree} links${topic ? `<br/>topic: ${escapeHtml(topic)}` : ""}</div>`;
			})
			.nodeCanvasObject((n: GNode, c: CanvasRenderingContext2D, s: number) => drawNode(n, c, s))
			.nodePointerAreaPaint((n: GNode, color: string, c: CanvasRenderingContext2D) => paintPointer(n, color, c))
			.linkColor((l: GLink) => linkColor(l))
			.linkWidth((l: GLink) => 0.2 + 1.8 * Math.sqrt(l.weight / (modelRef.current?.maxW || 1)))
			.linkVisibility((l: GLink) => {
				const f = focusRef.current;
				if (f.active) return true;
				// hide the weakest links in big graphs to reduce the hairball
				const m = modelRef.current;
				return !m || m.links.length < 800 || l.weight > m.maxW * 0.04;
			})
			.d3VelocityDecay(0.35)
			.onEngineStop(() => {
				for (const n of modelRef.current?.nodes || []) {
					if (n.x !== undefined && n.y !== undefined)
						positionsRef.current.set(n.id, { x: n.x, y: n.y });
				}
				if (!fittedRef.current) {
					fittedRef.current = true;
					fitView(400);
				}
			})
			.onNodeHover((n: GNode | null) => {
				setHoverNode(n ? n.id : null);
				if (canvasHostRef.current)
					canvasHostRef.current.style.cursor = n ? "pointer" : "default";
			})
			.onNodeClick((n: GNode, ev: MouseEvent) => handlersRef.current.click(n, ev))
			.onNodeRightClick((n: GNode, ev: MouseEvent) => handlersRef.current.menu(n, ev))
			.onBackgroundClick(() => handlersRef.current.background());

		return () => {
			try {
				fg._destructor();
			} catch (_) {
				/* ignore */
			}
			fgRef.current = null;
		};
	}, []);

	// keep latest values reachable from the canvas callbacks
	const modelRef = useRef(model);
	modelRef.current = model;
	const topicNamesRef = useRef(props.topicNames);
	topicNamesRef.current = props.topicNames;

	const handlersRef = useRef({
		click: (_n: GNode, _ev: MouseEvent) => {},
		menu: (_n: GNode, _ev: MouseEvent) => {},
		background: () => {},
	});
	handlersRef.current = {
		click: (n, ev) => {
			const now = Date.now();
			if (lastClickRef.current && lastClickRef.current.id === n.id && now - lastClickRef.current.t < 350) {
				lastClickRef.current = null;
				props.onOpenNode(n.id);
				return;
			}
			lastClickRef.current = { id: n.id, t: now };
			const current = props.wordsToSearch;
			let next: string[];
			if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
				next = current.includes(n.id) ? current.filter((w) => w !== n.id) : [...current, n.id];
			} else {
				next = current.length === 1 && current[0] === n.id ? [] : [n.id];
			}
			props.onSelectNodes(next, connectedOf(next));
		},
		menu: (n, ev) => {
			const menu = new Menu();
			const selected = props.wordsToSearch.includes(n.id);
			menu.addItem((i) =>
				i.setTitle(selected ? "Deselect" : "Select").setIcon("mouse-pointer-click").onClick(() => {
					const next = selected ? props.wordsToSearch.filter((w) => w !== n.id) : [n.id];
					props.onSelectNodes(next, connectedOf(next));
				})
			);
			if (!selected)
				menu.addItem((i) =>
					i.setTitle("Add to selection").setIcon("plus").onClick(() => {
						const next = [...props.wordsToSearch, n.id];
						props.onSelectNodes(next, connectedOf(next));
					})
				);
			menu.addItem((i) =>
				i.setTitle("Hide concept (rebuild graph)").setIcon("eye-off").onClick(() => {
					props.onHideNodes([...props.wordsToHide, n.id]);
				})
			);
			menu.addSeparator();
			if (n.kind === "link")
				menu.addItem((i) =>
					i.setTitle("Open note").setIcon("file-text").onClick(() => props.onOpenNode(n.id))
				);
			menu.addItem((i) =>
				i.setTitle("Search in vault").setIcon("search").onClick(() => props.onSearchNode(n.id))
			);
			menu.addItem((i) =>
				i.setTitle("Show excerpts").setIcon("quote").onClick(() => {
					props.onSelectNodes([n.id], connectedOf([n.id]));
					setTimeout(() => props.onAction("context"), 50);
				})
			);
			menu.showAtMouseEvent(ev);
		},
		background: () => {
			if (props.wordsToSearch.length > 0) props.onSelectNodes([], []);
			if (props.topicsFiltered.length > 0) props.onSelectTopics([]);
			if (props.gapShown !== false) props.onShowGap(false, []);
		},
	};

	function connectedOf(words: string[]) {
		const set = new Set<string>();
		for (const w of words) model.neighbors.get(w)?.forEach((n) => set.add(n));
		words.forEach((w) => set.delete(w));
		return Array.from(set);
	}

	// feed data
	useEffect(() => {
		const fg = fgRef.current;
		if (!fg) return;
		const n = model.nodes.length;
		const charge = -Math.max(40, Math.min(160, 3200 / Math.sqrt(n + 1)));
		fg.d3Force("charge")?.strength(charge).distanceMax(500);

		// Topic layout: each top cluster gets an anchor on a circle, its
		// nodes are pulled towards it, so topics read as separate regions
		const tops = topClusters.map((c: any) => String(c.community));
		const R = 40 + 26 * Math.sqrt(n);
		const anchors: Record<string, { x: number; y: number }> = {};
		tops.forEach((id, i) => {
			const share = Math.max(0.15, parseFloat(topClusters[i]?.bcRatio || "0"));
			const radius = i === 0 ? R * 0.35 : R * (1.05 - share);
			const angle = (2 * Math.PI * i) / Math.max(tops.length, 1) - Math.PI / 2;
			anchors[id] = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
		});
		const sameTopic = (l: GLink) => {
			const a = typeof l.source === "string" ? null : l.source;
			const b = typeof l.target === "string" ? null : l.target;
			return a && b ? a.community === b.community : false;
		};
		fg.d3Force("link")
			?.distance((l: GLink) => (sameTopic(l) ? 22 : 70) + 20 * (1 - Math.min(1, l.weight / model.maxW)))
			.strength((l: GLink) =>
				(sameTopic(l) ? 0.25 : 0.03) + 0.35 * Math.min(1, l.weight / model.maxW)
			);
		fg.d3Force("x", forceX((nd: GNode) => anchors[nd.community]?.x ?? 0).strength((nd: GNode) => (anchors[nd.community] ? 0.09 : 0.02)));
		fg.d3Force("y", forceY((nd: GNode) => anchors[nd.community]?.y ?? 0).strength((nd: GNode) => (anchors[nd.community] ? 0.09 : 0.02)));
		fg.d3Force("collide", forceCollide((nd: GNode) => nd.r + 3).iterations(1));
		const hasPositions = model.nodes.some((nd) => nd.x !== undefined);
		// Lay out synchronously first so the graph is readable at once,
		// even when the view opens hidden (no animation frames yet)
		fg.warmupTicks(hasPositions ? 0 : Math.min(160, 40 + Math.round(n / 2)));
		fg.cooldownTicks(hasPositions ? 80 : 200);
		fg.graphData({ nodes: model.nodes, links: model.links });
		if (!hasPositions && n > 0) {
			fittedRef.current = false;
			setTimeout(() => {
				if (fgRef.current === fg) fitView(0);
			}, 60);
		}
	}, [model]);

	// size
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(() => {
			const w = el.clientWidth;
			setWidth(w);
			fgRef.current?.width(w).height(props.height);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [props.height]);

	useEffect(() => {
		fgRef.current?.height(props.height);
	}, [props.height]);

	panelOpenRef.current = panelOpen;
	const narrow = width > 0 && width < 520;
	useEffect(() => {
		setPanelOpen(!narrow);
	}, [narrow]);

	useEffect(() => {
		redraw();
	}, [theme]);

	// ---------------------------------------------------------- panels
	const topicLabel = (id: string, fallbackWords?: string[]) =>
		props.topicNames[id] ||
		(fallbackWords || topClusters.find((c) => String(c.community) === id)?.nodes?.map((x: any) => x.nodeName) || [])
			.slice(0, 3)
			.join(" · ");

	const topConcepts = model.nodes.slice().sort((a, b) => a.rank - b.rank).slice(0, 40);
	const activePanel: GraphPanel = props.panel === "gaps" || props.panel === "concepts" ? props.panel : "topics";

	const chip =
		"flex items-center gap-1 px-2 py-1 rounded-md text-sm cursor-pointer select-none whitespace-nowrap bg-white/80 dark:bg-gray-800/90 hover:bg-violet-100 dark:hover:bg-violet-900/60 border border-solid border-gray-300 dark:border-gray-700 text-gray-800 dark:text-gray-100";

	const selectionText =
		props.wordsToSearch.length > 0
			? props.wordsToSearch.join(" + ")
			: props.topicsFiltered.length > 0
			? props.topicsFiltered.map((t) => topicLabel(String(t))).join(" + ")
			: "";

	return (
		<div
			ref={containerRef}
			className="relative w-full overflow-hidden rounded"
			style={{ height: `${props.height}px`, background: theme.bg }}
		>
			<div ref={canvasHostRef} className="absolute inset-0" />

			{/* Right panel */}
			<div
				className="absolute z-20 right-2 top-2 flex flex-col text-gray-900 dark:text-gray-100 bg-white/90 dark:bg-gray-900/90 border border-solid border-gray-300 dark:border-gray-700 rounded-lg shadow"
				style={{ width: panelOpen ? 270 : "auto", maxHeight: props.height - 70 }}
			>
				<div className="flex flex-row items-center gap-1 px-2 pt-2 pb-1">
					{(["topics", "gaps", "concepts"] as GraphPanel[]).map((p) => (
						<span
							key={p}
							className={`px-2 py-0.5 rounded text-sm cursor-pointer capitalize ${
								activePanel === p && panelOpen
									? "bg-violet-600 text-white"
									: "hover:bg-gray-200 dark:hover:bg-gray-700"
							}`}
							onClick={() => {
								setPanelOpen(true);
								props.onPanelChange(p);
							}}
						>
							{p}
						</span>
					))}
					<span
						className="ml-auto cursor-pointer opacity-70 hover:opacity-100"
						onClick={() => setPanelOpen((o) => !o)}
						title={panelOpen ? "Collapse" : "Expand"}
					>
						{panelOpen ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
					</span>
				</div>

				{panelOpen && model.nodes.length > 0 && (
					<div className="px-3 pb-1 text-xs opacity-60">
						{`${model.nodes.length} concepts · ${model.links.length} links · ${topClusters.length} topics · modularity ${Number(attrs.modularity || 0).toFixed(2)}`}
					</div>
				)}
				{panelOpen && (
					<div className="px-2 pb-2 overflow-y-auto">
						<input
							type="text"
							placeholder="Find a concept…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && searchMatches[0]) {
									const id = searchMatches[0].id;
									props.onSelectNodes([id], connectedOf([id]));
									setSearch("");
								}
								if (e.key === "Escape") setSearch("");
							}}
							className="w-full mb-2 text-sm"
						/>
						{searchMatches.length > 0 && (
							<div className="flex flex-wrap gap-1 mb-2">
								{searchMatches.map((n) => (
									<span
										key={n.id}
										className="px-1.5 py-0.5 text-sm rounded cursor-pointer bg-gray-200 dark:bg-gray-700"
										onClick={() => {
											props.onSelectNodes([n.id], connectedOf([n.id]));
											setSearch("");
										}}
									>
										{n.label}
									</span>
								))}
							</div>
						)}

						{activePanel === "topics" && (
							<div className="flex flex-col gap-1">
								{topClusters.length === 0 && <span className="text-sm opacity-70">No topics found.</span>}
								{topClusters.map((c: any) => {
									const id = String(c.community);
									const on = props.topicsFiltered.map(String).includes(id);
									return (
										<div
											key={id}
											className={`flex flex-col px-2 py-1 rounded cursor-pointer ${
												on ? "bg-violet-100 dark:bg-violet-900/50" : "hover:bg-gray-100 dark:hover:bg-gray-800"
											}`}
											onMouseEnter={() => setHoverTopic(id)}
											onMouseLeave={() => setHoverTopic(null)}
											onClick={(ev) => {
												const cur = props.topicsFiltered.map(String);
												const next =
													ev.shiftKey || ev.metaKey
														? on
															? cur.filter((x) => x !== id)
															: [...cur, id]
														: on && cur.length === 1
														? []
														: [id];
												props.onSelectTopics(next);
											}}
										>
											<div className="flex flex-row items-center gap-2">
												<span
													className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
													style={{ background: communityColor[id] }}
												/>
												<span className="text-base font-semibold leading-tight">{topicLabel(id)}</span>
												<span className="ml-auto text-xs opacity-60">
													{Math.round(parseFloat(c.bcRatio) * 100)}%
												</span>
											</div>
											<span className="text-sm opacity-70 leading-tight pl-4">
												{c.nodes
													.slice(0, 6)
													.map((x: any) => x.nodeName)
													.join(", ")}
											</span>
										</div>
									);
								})}
								<span className="text-xs opacity-60 mt-1">
									Click a topic to focus it, shift-click to combine. % = share of influence.
								</span>
							</div>
						)}

						{activePanel === "gaps" && (
							<div className="flex flex-col gap-1">
								{gaps.length === 0 && (
									<span className="text-sm opacity-70">Not enough topics to find gaps.</span>
								)}
								{gaps.map((g: any, idx: number) => {
									const a = String(g.from.community);
									const b = String(g.to.community);
									const on = props.gapShown === idx + 1;
									return (
										<div
											key={idx}
											className={`flex flex-col gap-1 px-2 py-1 rounded cursor-pointer ${
												on ? "bg-violet-100 dark:bg-violet-900/50" : "hover:bg-gray-100 dark:hover:bg-gray-800"
											}`}
											onClick={() => props.onShowGap(on ? false : idx + 1, on ? [] : [a, b])}
										>
											<div className="flex flex-row items-center gap-1 text-base leading-tight">
												<span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: communityColor[a] }} />
												<span className="font-semibold">{topicLabel(a, g.from.nodes)}</span>
											</div>
											<div className="flex flex-row items-center gap-1 text-base leading-tight">
												<span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: communityColor[b] }} />
												<span className="font-semibold">{topicLabel(b, g.to.nodes)}</span>
											</div>
											{on && (
												<div className="flex flex-row gap-1 mt-1">
													<span className={chip} onClick={(e) => { e.stopPropagation(); props.onAction("question"); }}>
														<QuestionIcon size={14} /> bridge with AI
													</span>
													<span className={chip} onClick={(e) => { e.stopPropagation(); props.onAction("context_gap"); }}>
														<QuoteIcon size={14} /> excerpts
													</span>
												</div>
											)}
										</div>
									);
								})}
								<span className="text-xs opacity-60 mt-1">
									Gaps are influential topics that are weakly connected — good places for new ideas.
								</span>
							</div>
						)}

						{activePanel === "concepts" && (
							<div className="flex flex-col gap-0.5">
								{topConcepts.map((n) => {
									const on = props.wordsToSearch.includes(n.id);
									return (
										<div
											key={n.id}
											className={`flex flex-row items-center gap-2 px-1 rounded cursor-pointer ${
												on ? "bg-violet-100 dark:bg-violet-900/50" : "hover:bg-gray-100 dark:hover:bg-gray-800"
											}`}
											onMouseEnter={() => setHoverNode(n.id)}
											onMouseLeave={() => setHoverNode(null)}
											onClick={(ev) => {
												const cur = props.wordsToSearch;
												const next = ev.shiftKey || ev.metaKey
													? on ? cur.filter((w) => w !== n.id) : [...cur, n.id]
													: on && cur.length === 1 ? [] : [n.id];
												props.onSelectNodes(next, connectedOf(next));
											}}
										>
											<span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: n.color }} />
											<span className="text-sm truncate">{n.label}</span>
											<span className="ml-auto h-1.5 rounded bg-violet-400/70" style={{ width: `${Math.max(4, n.bcNorm * 60)}px` }} />
										</div>
									);
								})}
								{props.wordsToHide.length > 0 && (
									<div className="mt-2">
										<span className="text-xs font-semibold opacity-70">Hidden (click to restore)</span>
										<div className="flex flex-wrap gap-1 mt-1">
											{props.wordsToHide.map((w) => (
												<span
													key={w}
													className="px-1.5 py-0.5 text-sm rounded cursor-pointer bg-gray-200 dark:bg-gray-700 line-through"
													onClick={() => props.onHideNodes(props.wordsToHide.filter((x) => x !== w))}
												>
													{w}
												</span>
											))}
										</div>
									</div>
								)}
								<span className="text-xs opacity-60 mt-1">
									Ranked by betweenness centrality (influence). Right-click a node to hide it.
								</span>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Selection bar */}
			{selectionText && (
				<div className="absolute z-20 left-1/2 -translate-x-1/2 bottom-14 flex flex-row items-center gap-2 px-3 py-1 rounded-full text-sm bg-gray-900/80 text-white">
					<span className="truncate max-w-[50vw]">{selectionText}</span>
					<span
						className="cursor-pointer opacity-80 hover:opacity-100"
						onClick={() => handlersRef.current.background()}
						title="Clear selection"
					>
						<XIcon size={14} />
					</span>
				</div>
			)}

			{/* Action bar */}
			<div className="absolute z-20 bottom-3 left-14 right-2 flex flex-row flex-wrap justify-center gap-1">
				<span className={chip} onClick={() => props.onAction("summarize")} title="Summarize the selection, topics or whole graph">
					<SparkleFillIcon size={14} className="text-violet-600 dark:text-violet-400" /> Summarize
				</span>
				<span className={chip} onClick={() => props.onAction("question")} title="Research question that bridges the gap">
					<QuestionIcon size={14} /> Question
				</span>
				<span className={chip} onClick={() => props.onAction("develop")} title="Develop the ideas further">
					<LightBulbIcon size={14} /> Develop
				</span>
				<span className={chip} onClick={() => props.onAction("transcend")} title="Ideas beyond this discourse">
					<RocketIcon size={14} /> Transcend
				</span>
				<span className={chip} onClick={() => props.onAction("context")} title="Show the excerpts behind the selection">
					<QuoteIcon size={14} /> Excerpts
				</span>
				<span className={chip} onClick={() => props.onAction("chat")} title="Chat with these notes">
					<CommentDiscussionIcon size={14} /> Chat
				</span>
			</div>

			{!props.isLoading && model.nodes.length === 0 && props.graphData && (
				<div className="absolute inset-0 flex items-center justify-center text-base opacity-70 text-gray-800 dark:text-gray-200">
					Not enough content to build a graph.
				</div>
			)}
		</div>
	);
};

function escapeHtml(s: string) {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export { LocalGraph };
export type { GraphAction };
