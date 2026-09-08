import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { consumeSseData } from "../../lib/ai/sse";
import {
	AiStreamError,
	parseAiCancelResponse,
	parseAiRunEvent,
} from "../../lib/ai/run-events";
import type {
	AiAction,
	AiConnection,
	AiCredentialRoute,
	AiModel,
	AiReviewContext,
	AiSourceId,
	AiSurface,
	AiConversationTurn,
} from "../../lib/ai/types";

interface AiResult {
	runId?: string;
	text: string;
	warnings: string[];
	canceled?: boolean;
	/** Local delivery stopped; provider termination is not yet confirmed. */
	cancellationConfirmed?: false;
}

interface RunInput {
	surface: AiSurface;
	action: AiAction;
	context: AiReviewContext;
	prompt?: string;
	conversationId?: string;
	history?: AiConversationTurn[];
	signal?: AbortSignal;
	onDelta?: (text: string) => void;
	onStart?: (runId: string) => void;
	onWarning?: (message: string) => void;
}

interface AiContextValue {
	connections: AiConnection[];
	models: AiModel[];
	selectedModel: string;
	defaultModel: string;
	reasoningEffort: string;
	railWidth: number;
	settingsExpanded: boolean;
	loading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	selectModel: (modelId: string) => Promise<void>;
	setDefaultModel: (modelId: string) => Promise<void>;
	setReasoningEffort: (effort: string) => Promise<void>;
	setRailWidth: (width: number) => Promise<void>;
	setSettingsExpanded: (expanded: boolean) => Promise<void>;
	connectKey: (
		source: AiSourceId,
		key: string,
		remember: boolean,
	) => Promise<void>;
	setup: (
		source: AiSourceId,
		route: AiCredentialRoute,
		providerId?: string,
	) => Promise<string>;
	disconnect: (source: AiSourceId) => Promise<void>;
	run: (input: RunInput) => Promise<AiResult>;
	cancel: (runId: string) => Promise<void>;
}

const AiContext = createContext<AiContextValue | null>(null);

async function jsonError(response: Response): Promise<Error> {
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	return new Error(body.error || `HTTP ${response.status}`);
}

export function AiProvider({ children }: { children: ReactNode }) {
	const [connections, setConnections] = useState<AiConnection[]>([]);
	const [models, setModels] = useState<AiModel[]>([]);
	const [selectedModel, setSelectedModel] = useState("");
	const [defaultModel, setDefaultModelState] = useState("");
	const [reasoningEffort, setReasoningState] = useState("");
	const [railWidth, setRailWidthState] = useState(360);
	const [settingsExpanded, setSettingsExpandedState] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const hydrated = useRef(false);

	const refresh = useCallback(async () => {
		setError(null);
		const [connectionResponse, modelResponse, settingsResponse] =
			await Promise.all([
				fetch("/api/ai/connections"),
				fetch("/api/ai/models"),
				fetch("/api/settings"),
			]);
		if (!connectionResponse.ok) throw await jsonError(connectionResponse);
		if (!modelResponse.ok) throw await jsonError(modelResponse);
		const connectionBody = (await connectionResponse.json()) as {
			connections?: AiConnection[];
		};
		const modelBody = (await modelResponse.json()) as { models?: AiModel[] };
		const settings = settingsResponse.ok
			? ((await settingsResponse.json()) as {
					aiModel?: string | null;
					aiReasoningEffort?: string | null;
					aiRailWidth?: number;
					aiSettingsExpanded?: boolean;
				})
			: {};
		const nextModels = modelBody.models ?? [];
		const savedDefault = settings.aiModel || "";
		const isInitialHydration = !hydrated.current;
		setConnections(connectionBody.connections ?? []);
		setModels(nextModels);
		setSelectedModel((current) => {
			const requested = isInitialHydration ? savedDefault : current;
			if (nextModels.some((model) => model.id === requested)) return requested;
			return (
				nextModels.find((model) => model.isDefault)?.id ?? nextModels[0]?.id ?? ""
			);
		});
		if (isInitialHydration) {
			setDefaultModelState(savedDefault);
			setReasoningState(settings.aiReasoningEffort || "");
			setRailWidthState(Math.max(320, Math.min(720, settings.aiRailWidth || 360)));
			setSettingsExpandedState(settings.aiSettingsExpanded === true);
		}
		hydrated.current = true;
	}, []);

	useEffect(() => {
		refresh()
			.catch((nextError) =>
				setError(
					nextError instanceof Error ? nextError.message : String(nextError),
				),
			)
			.finally(() => setLoading(false));
	}, [refresh]);

	const persistSettings = useCallback(async (patch: Record<string, unknown>) => {
		const response = await fetch("/api/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		if (!response.ok) throw await jsonError(response);
		window.dispatchEvent(
			new CustomEvent("diffing-ai-settings", { detail: patch }),
		);
	}, []);

	const persistModel = useCallback(
		async (modelId: string) => {
			setError(null);
			setDefaultModelState(modelId);
			setSelectedModel(modelId);
			try {
				await persistSettings({ aiModel: modelId });
			} catch (nextError) {
				setError(
					nextError instanceof Error ? nextError.message : String(nextError),
				);
			}
		},
		[persistSettings],
	);

	const selectModel = persistModel;
	const setDefaultModel = persistModel;

	const setReasoningEffort = useCallback(
		async (effort: string) => {
			setReasoningState(effort);
			await persistSettings({ aiReasoningEffort: effort || null });
		},
		[persistSettings],
	);

	const setRailWidth = useCallback(
		async (width: number) => {
			const next = Math.max(320, Math.min(720, Math.round(width)));
			setRailWidthState(next);
			await persistSettings({ aiRailWidth: next });
		},
		[persistSettings],
	);

	const setSettingsExpanded = useCallback(
		async (expanded: boolean) => {
			setSettingsExpandedState(expanded);
			await persistSettings({ aiSettingsExpanded: expanded });
		},
		[persistSettings],
	);

	useEffect(() => {
		document.documentElement.style.setProperty(
			"--ai-rail-width",
			`${railWidth}px`,
		);
		return () => {
			document.documentElement.style.removeProperty("--ai-rail-width");
		};
	}, [railWidth]);

	const connectKey = useCallback(
		async (source: AiSourceId, key: string, remember: boolean) => {
			const response = await fetch(`/api/ai/connections/${source}/key`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ apiKey: key, remember }),
			});
			if (!response.ok) throw await jsonError(response);
			await refresh();
		},
		[refresh],
	);

	const setup = useCallback(
		async (source: AiSourceId, route: AiCredentialRoute, providerId?: string) => {
			const endpoint = route === "runtime-key" ? "configure-runtime-key" : "login";
			const response = await fetch(`/api/ai/connections/${source}/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ route, providerId }),
			});
			if (!response.ok) throw await jsonError(response);
			const body = (await response.json()) as { command?: string };
			return body.command || "";
		},
		[],
	);

	const disconnect = useCallback(
		async (source: AiSourceId) => {
			const response = await fetch(`/api/ai/connections/${source}`, {
				method: "DELETE",
			});
			if (!response.ok) throw await jsonError(response);
			await refresh();
		},
		[refresh],
	);

	const run = useCallback(
		async ({
			surface,
			action,
			context,
			prompt,
			conversationId,
			history,
			signal,
			onDelta,
			onStart,
			onWarning,
		}: RunInput) => {
			if (!selectedModel)
				throw new Error("Connect an AI source and choose a model first.");
			let text = "";
			let runId: string | undefined;
			let completed = false;
			const warnings: string[] = [];
			const consume = (data: string) => {
				const event = parseAiRunEvent(data);
				if (event.type === "error")
					throw new AiStreamError(event.message, event.code);
				if (event.type === "start") {
					if (runId) throw new Error("AI stream contains a duplicate start event.");
					runId = event.runId;
					onStart?.(event.runId);
					return;
				}
				if (!runId) throw new Error("AI stream is missing its start event.");
				if (event.type === "text-delta") {
					text += event.text;
					onDelta?.(text);
				}
				if (event.type === "warning") {
					warnings.push(event.message);
					onWarning?.(event.message);
				}
				if (event.type === "complete") {
					text = event.text;
					completed = true;
					return true;
				}
			};
			try {
				signal?.throwIfAborted();
				const response = await fetch("/api/ai/run", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						trigger: "user",
						conversationId: conversationId || crypto.randomUUID(),
						modelId: selectedModel,
						reasoningEffort: reasoningEffort || undefined,
						surface,
						action,
						prompt,
						context,
						history,
					}),
					signal,
				});
				if (!response.ok) throw await jsonError(response);
				if (!response.body) throw new Error("AI response stream is unavailable.");
				await consumeSseData(response.body, consume, signal);
				if (!completed)
					throw new Error(
						"AI response stream ended before completion. The response is incomplete.",
					);
			} catch (nextError) {
				if (
					signal?.aborted ||
					(nextError instanceof AiStreamError && nextError.code === "cancelled")
				)
					return {
						runId,
						text,
						warnings,
						canceled: true,
						cancellationConfirmed: false as const,
					};
				throw nextError;
			}
			return { runId, text, warnings };
		},
		[reasoningEffort, selectedModel],
	);

	const cancel = useCallback(async (runId: string) => {
		const response = await fetch(
			`/api/ai/runs/${encodeURIComponent(runId)}/cancel`,
			{
				method: "POST",
			},
		);
		if (!response.ok) throw await jsonError(response);
		parseAiCancelResponse(await response.json());
	}, []);

	const value = useMemo<AiContextValue>(
		() => ({
			connections,
			models,
			selectedModel,
			defaultModel,
			reasoningEffort,
			railWidth,
			settingsExpanded,
			loading,
			error,
			refresh,
			selectModel,
			setDefaultModel,
			setReasoningEffort,
			setRailWidth,
			setSettingsExpanded,
			connectKey,
			setup,
			disconnect,
			run,
			cancel,
		}),
		[
			connections,
			models,
			selectedModel,
			defaultModel,
			reasoningEffort,
			railWidth,
			settingsExpanded,
			loading,
			error,
			refresh,
			selectModel,
			setDefaultModel,
			setReasoningEffort,
			setRailWidth,
			setSettingsExpanded,
			connectKey,
			setup,
			disconnect,
			run,
			cancel,
		],
	);

	return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

export function useAi(): AiContextValue {
	const value = useContext(AiContext);
	if (!value) throw new Error("useAi must be used inside AiProvider");
	return value;
}

export function useOptionalAi(): AiContextValue | null {
	return useContext(AiContext);
}
