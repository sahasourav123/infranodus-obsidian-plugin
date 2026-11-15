import { PluginGraphContext } from "../types";

type PossibleError =
	| "no-wiki-links"
	| "invalid-api-key"
	| "api-key-free-exceeded"
	| "api-key-paid-exceeded"
	| "generic-error"
	| "api-error"
	| "no-content"
	| "content-empty";

const ErrorHandler = (params: {
	graphContext: PluginGraphContext;
	error: PossibleError;
	errorText?: string;
	setError: (error: PossibleError) => void;
	context: {
		setShowingSettings: (showingSettings: boolean) => void;
	};
}) => {
	const ctx = params.context;

	return (
		<div className="absolute inset-0 z-[5] flex flex-col items-center justify-center p-10 bg-white dark:bg-black">
			<span className="text-lg text-gray-600 dark:text-gray-200">
				{params.error === "no-wiki-links" && (
					<>
						<h2>No wiki links found</h2>
						<p>
							No [[wiki links]] were detected. You can open a page
							with [[wiki links]] or change the
							<ActionLink
								text="settings"
								action={() => ctx.setShowingSettings(true)}
								addSpacesAround={true}
							/>
							to also process text in the documents.
						</p>
					</>
				)}
				{params.error === "no-content" && (
					<>
						<h2>No content found</h2>
						<p>
							No content was found in the file. Please, make sure
							the file is not empty and contains text. Or check if
							you turned on the option to process linked and
							unlinked mentions in the
							<ActionLink
								text="settings"
								action={() => ctx.setShowingSettings(true)}
								addSpacesAround={true}
							/>
							panel.
						</p>
						<p>
							Alternatively, if there is additional content in the
							file since it was loaded, you can
							<ActionLink
								text="reload"
								action={() =>
									params.graphContext.reloadGraph({
										filePath:
											params.graphContext.filePath || "",
										leaf: params.graphContext.app.workspace.getLeaf(),
										fromLayoutChange: true,
									})
								}
								addSpacesAround={true}
							/>
							the graph.
						</p>
					</>
				)}
				{params.error === "content-empty" && (
					<>
						<h2>Content processing issue</h2>
						<p>
							Could not generate an InfraNodus graph even though
							content is present. This may be due to your text
							processing settings. For instance, if you have
							"[[Wiki Links]] Only" turned on, but there are no
							[[wiki links]] on the analyzed page. Please, go to
							the
							<ActionLink
								text="plugin settings"
								action={() => ctx.setShowingSettings(true)}
								addSpacesAround={true}
							/>
							and check your setup or try another page.
						</p>
						<p>
							Alternatively, if there is additional content in the
							file since it was loaded, you can
							<ActionLink
								text="reload"
								action={() =>
									params.graphContext.reloadGraph({
										filePath:
											params.graphContext.filePath || "",
										leaf: params.graphContext.app.workspace.getLeaf(),
										fromLayoutChange: true,
									})
								}
								addSpacesAround={true}
							/>
							the graph.
						</p>
					</>
				)}

				{params.error === "generic-error" && (
					<>
						<h2>Ooops, there was an error...</h2>
						{(params.errorText == "net::ERR_CONNECTION_REFUSED" ||
							params.errorText == "net::ERR_NAME_NOT_RESOLVED") && (
							<p>
								Could not reach the AI provider. Check that your
								local server (LiteLLM / LM Studio) is running, or
								the provider settings.
							</p>
						)}
						{params.errorText != "net::ERR_CONNECTION_REFUSED" &&
							params.errorText !=
								"net::ERR_NAME_NOT_RESOLVED" && (
								<p>
									{typeof params.errorText === "string" &&
									params.errorText.length > 0
										? params.errorText
										: "An unknown error occured. Please try again later or with another page."}
									{isRateLimitError(params.errorText) && (
										<>
											<br></br>
											The provider reported a rate limit.
											Wait a minute or route this task to
											another provider in the settings.
										</>
									)}
								</p>
							)}
						{typeof params.errorText === "string" &&
							params.errorText.includes("API key") && (
								<>
									<br></br>
									<ActionLink
										text="go to plugin settings"
										action={() =>
											ctx.setShowingSettings(true)
										}
										addSpacesAround={true}
									/>
								</>
							)}
					</>
				)}

				{params.error === "api-error" && (
					<>
						<h2>Ooops, there was an error...</h2>
						<p>
							{typeof params.errorText === "string" &&
							params.errorText.length > 0
								? params.errorText
								: "An unknown error occured. Please try again later or with another page."}
						</p>
						<p>
							Check that your AI provider is running and reachable in the
							<ActionLink
								text="plugin settings"
								action={() => ctx.setShowingSettings(true)}
								addSpaceLeft={true}
							/>
							{"."}
						</p>
					</>
				)}
			</span>
		</div>
	);
};

const isRateLimitError = (errorText?: string) => {
	if (typeof errorText !== "string") return false;
	const lower = errorText.toLowerCase();
	return (
		lower.includes("rate limit") ||
		lower.includes("rate-limit") ||
		lower.includes("too many requests") ||
		lower.includes("call limit has been exceeded") ||
		lower.includes("quota")
	);
};

const ActionLink = (params: {
	action?: () => void;
	href?: string;
	text: string;
	addSpacesAround?: boolean;
	addSpaceLeft?: boolean;
	addSpaceRight?: boolean;
}) => {
	return (
		<>
			{(params.addSpacesAround || params.addSpaceLeft) && " "}
			<a
				className="text-blue-500 underline cursor-pointer"
				onClick={params.action}
				href={params.href}
			>
				{params.text}
			</a>
			{(params.addSpacesAround || params.addSpaceRight) && " "}
		</>
	);
};

export { ErrorHandler };
export type { PossibleError };
