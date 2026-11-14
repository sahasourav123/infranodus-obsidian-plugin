import { App, PluginSettingTab, Setting, Platform } from "obsidian";
import InfraNodusPlugin from "src/main";
import { SETTINGS } from ".";
import { renderAiSettings } from "./aiSettings";

const currentPlatform =
	Platform.isMobileApp || Platform.isMobile ? "mobile" : "desktop";

class InfraNodusSettingTab extends PluginSettingTab {
	plugin: InfraNodusPlugin;

	constructor(app: App, plugin: InfraNodusPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		// console.log("InfraNodusSettingTab", this.plugin, SETTINGS);

		const onChange = (async (key: string, value: string) => {
			// @ts-ignore:next-line
			// this.plugin.settings[key] = value;
			// console.log("onChange settings tab", key, value);

			await this.plugin.saveSettings({ [key]: value });
		}).bind(this);

		containerEl.empty();
		renderAiSettings({
			containerEl,
			app: this.app,
			save: (settings) => this.plugin.saveSettings(settings),
			refresh: () => this.display(),
		});

		new Setting(containerEl).setName("Graph").setHeading();

		new Setting(containerEl)
			.setName("Max concepts in graph")
			.setDesc(
				"The most connected concepts are kept. Higher = more detail, slower layout."
			)
			.addText((text) =>
				text
					.setValue(String(SETTINGS.MAX_GRAPH_NODES || 300))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 30)
							await this.plugin.saveSettings({
								MAX_GRAPH_NODES: Math.min(n, 2000),
							});
					})
			);

		new Setting(containerEl)
			.setName("Save notes to folder")
			.setDesc(
				"Where AI output and graph reports are saved. Blank = vault root."
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. 00 Inbox")
					.setValue(SETTINGS.SAVE_FOLDER || "")
					.onChange(async (value) =>
						this.plugin.saveSettings({ SAVE_FOLDER: value.trim() })
					)
			);

		new Setting(containerEl)
			.setName("Link mentions to")
			.setDesc(
				"How to generate the links between the pages mentioned in your document."
			)
			.addDropdown((dropdown) => {
				const key = "LINK_PAGE_TO_MENTIONS";
				dropdown
					.addOption(
						"paragraph",
						"each other, if in the same paragraph (default)"
					)
					.addOption(
						"parent_and_paragraph",
						"to parent page and others in the same paragraph"
					)
					.addOption(
						"parent_only",
						"to parent page only (Obsidian style)"
					)
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		new Setting(containerEl)
			.setName("Single page processing")
			.setDesc(
				"Use [[wiki links]] and concepts for detailed results. Use [[wiki links]] only for sparser graphs."
			)
			.addDropdown((dropdown) => {
				const key = "SINGLE_PAGE_GRAPH_PROCESSING";
				dropdown
					.addOption(
						"[[Wiki Links]] and Concepts",
						"[[Wiki Links]] and Concepts"
					)
					.addOption("[[Wiki Links]] Only", "[[Wiki Links]] Only")
					.addOption(
						"[[Wiki Links]] Prioritized",
						"[[Wiki Links]] Prioritized"
					)
					.addOption("Concepts only", "Concepts Only")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		new Setting(containerEl)
			.setName("Multi page processing")
			.setDesc(
				"Use [[wiki links]] only for big folders and vaults. Use [[wiki links]] and concepts for more detail."
			)
			.addDropdown((dropdown) => {
				const key = "MULTI_PAGE_GRAPH_PROCESSING";
				dropdown
					.addOption(
						"[[Wiki Links]] and Concepts",
						"[[Wiki Links]] and Concepts"
					)
					.addOption("[[Wiki Links]] Only", "[[Wiki Links]] Only")
					.addOption(
						"[[Wiki Links]] Prioritized",
						"[[Wiki Links]] Prioritized"
					)
					.addOption("Concepts only", "Concepts Only")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		// color scheme
		new Setting(containerEl)
			.setName("Color scheme")
			.setDesc("Choose the color scheme to use.")
			.addDropdown((dropdown) => {
				const key = "COLOR_SCHEME";
				dropdown
					.addOption("auto", "Auto")
					.addOption("light", "Light")
					.addOption("dark", "Dark")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		// Linked & Unlinked mentions
		new Setting(containerEl)
			.setName("Include linked mentions")
			.setDesc(
				"Including linked mentions helps navigate between ideas better but may be too detailed."
			)
			.addDropdown((dropdown) => {
				const key = "INCLUDE_LINKED_MENTIONS";
				dropdown
					.addOption("For empty pages only", "For empty pages only")
					.addOption("For all pages", "For all pages")
					.addOption("Never", "Never")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		new Setting(containerEl)
			.setName("Include unlinked mentions")
			.setDesc(
				"Including unlinked mentions helps discover new connections but can also be overwhelming."
			)
			.addDropdown((dropdown) => {
				const key = "INCLUDE_UNLINKED_MENTIONS";
				dropdown
					.addOption("For empty pages only", "For empty pages only")
					.addOption("For all pages", "For all pages")
					.addOption("Never", "Never")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		// pattern matching for unlinked mentions
		new Setting(containerEl)
			.setName("Improve unlinked search")
			.setDesc("Use aggressive partial matching when searching.")
			.addDropdown((dropdown) => {
				const key = "USE_OWN_UNLINKED_SEARCH";
				dropdown
					.addOption("no", "No")
					.addOption("yes", "Yes")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		new Setting(containerEl)
			.setName("Updating graph")
			.setDesc(
				"Set manual if you want the graph to reload only when you click the reload button."
			)
			.addDropdown((dropdown) => {
				const key = "RELOADING_GRAPH";
				dropdown
					.addOption("automatic", "Automatic (on page view)")
					.addOption("manual", "Manual (button)")
					.addOption("into reading", "Entering reading mode")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		// default graph mode
		new Setting(containerEl)
			.setName("Default graph layer")
			.setDesc(
				"The default layer the graph should open on when loading the first time."
			)
			.addDropdown((dropdown) => {
				const key = "DEFAULT_GRAPH_MODE";
				dropdown
					.addOption("graph", "Graph")
					.addOption("topics", "Topics")
					.addOption("concepts", "Concepts")
					.addOption("gaps", "Gaps")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		// new Setting(containerEl)
		// 	.setName("Add links")
		// 	.setDesc("Choose where to add generated links.")
		// 	.addDropdown((dropdown) => {
		// 		const key = "ADD_LINKS";
		// 		dropdown
		// 			.addOption("End of statement", "End of statement")
		// 			.addOption("Lemmatization", "Lemmatization")
		// 			.addOption("Only exact words", "Only exact words")
		// 			.setValue(SETTINGS[key])
		// 			.onChange(async (value) => onChange(key, value));
		// 	});

		new Setting(containerEl)
			.setName("When using locate")
			.setDesc("Note: Locating works better in the Edit mode.")
			.addDropdown((dropdown) => {
				const key = "WHEN_USING_LOCATE";
				dropdown
					.addOption(
						"Do not force to Edit Mode",
						"Do not force to Edit Mode"
					)
					.addOption("Force to Edit Mode", "Force to Edit Mode")
					.setValue(SETTINGS[key])
					.onChange(async (value) => onChange(key, value));
			});

		// new Setting(containerEl)
		// 	.setName("Reload when into reading view")
		// 	.setDesc(
		// 		"Reload the graph when the reading mode is toggled from the editor."
		// 	)
		// 	.addToggle((toggle) => {
		// 		const key = "RELOAD_WHEN_TO_READING";
		// 		toggle
		// 			.setValue(SETTINGS[key])
		// 			.onChange(async (value) => onChange(key, value));
		// 	});

		if (currentPlatform === "mobile") {
			new Setting(containerEl)
				.setName("Open mobile graph in")
				.setDesc("Choose where to open the graph on mobile.")
				.addDropdown((dropdown) => {
					const key = "MOBILE_OPEN_GRAPH_IN";
					dropdown
						.addOption("Side view", "Side view")
						.addOption("New tab", "New tab")
						.setValue(SETTINGS[key])
						.onChange(async (value) => onChange(key, value));
				});
		}

	}
}

export { InfraNodusSettingTab };
