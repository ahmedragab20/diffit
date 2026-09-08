import { useState } from "react";
import {
	Bot,
	CheckCircle2,
	ChevronRight,
	Copy,
	Eye,
	EyeOff,
	KeyRound,
	RefreshCw,
	ShieldCheck,
	TerminalSquare,
	X,
} from "lucide-react";
import type { AiConnection, AiSourceId } from "../../lib/ai/types";
import { Modal } from "../primitives/Modal";
import { useOptionalAi } from "./AiContext";
import { aiSourceLabel } from "./labels";

const DIRECT_SOURCES: AiSourceId[] = ["xai"];
const SOURCE_LABELS: Partial<Record<AiSourceId, string>> = {
	xai: "Grok",
};

export function AiConnectionsPanel() {
	const ai = useOptionalAi();
	const [keySource, setKeySource] = useState<AiSourceId | null>(null);
	const [key, setKey] = useState("");
	const [remember, setRemember] = useState(true);
	const [showKey, setShowKey] = useState(false);
	const [command, setCommand] = useState("");
	const [busy, setBusy] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	if (!ai) return null;
	const {
		connections,
		models,
		defaultModel,
		settingsExpanded,
		setSettingsExpanded,
		setDefaultModel,
		connectKey,
		setup,
		disconnect,
		refresh,
		loading,
		error,
	} = ai;
	const connectedConnections = connections.filter(
		(connection) => connection.status === "connected",
	);
	const availableConnections = connections.filter(
		(connection) => connection.status !== "connected",
	);
	const connectedCount = connectedConnections.length;
	const keySourceLabel = keySource
		? SOURCE_LABELS[keySource] || keySource
		: "provider";
	const closeKeyModal = () => {
		setKeySource(null);
		setKey("");
		setShowKey(false);
		setLocalError(null);
	};

	const saveKey = async () => {
		if (!keySource) return;
		setBusy(true);
		setLocalError(null);
		try {
			await connectKey(keySource, key, remember);
			closeKeyModal();
		} catch (nextError) {
			setLocalError(
				nextError instanceof Error ? nextError.message : String(nextError),
			);
		} finally {
			setBusy(false);
		}
	};

	const renderConnection = (connection: AiConnection) => (
		<div className="ai-connection-row" key={connection.id}>
			<span
				className={`ai-connection-dot is-${connection.status}`}
				aria-hidden="true"
			/>
			<div className="ai-connection-copy">
				<strong>{connection.label}</strong>
				<small title={connection.detail}>
					{connection.status === "connected"
						? `${connection.authentication?.evidence === "key-configured" ? "Key configured" : "Runtime detected"} · unverified${connection.modelCount ? ` · ${connection.modelCount} models` : ""}`
						: connection.status.replaceAll("-", " ")}
				</small>
			</div>
			{connection.status === "connected" ? (
				<button
					className="btn btn-sm ai-connection-action"
					type="button"
					onClick={() =>
						void disconnect(connection.id).catch((nextError) =>
							setLocalError(
								nextError instanceof Error ? nextError.message : String(nextError),
							),
						)
					}
				>
					Disconnect
				</button>
			) : DIRECT_SOURCES.includes(connection.id) ? (
				<button
					className="btn btn-sm ai-connection-action"
					type="button"
					onClick={() => setKeySource(connection.id)}
				>
					<KeyRound size={12} /> Add key
				</button>
			) : (
				<div className="ai-connection-actions">
					{connection.credentialRoutes.includes("subscription") && (
						<button
							className="btn btn-sm ai-connection-action"
							type="button"
							onClick={() =>
								void setup(connection.id, "subscription")
									.then(setCommand)
									.catch((nextError) => setLocalError(String(nextError)))
							}
						>
							<TerminalSquare size={12} /> Sign in
						</button>
					)}
					{connection.credentialRoutes.includes("runtime-key") && (
						<button
							className="btn btn-sm ai-connection-action"
							type="button"
							onClick={() =>
								void setup(connection.id, "runtime-key")
									.then(setCommand)
									.catch((nextError) => setLocalError(String(nextError)))
							}
						>
							<KeyRound size={12} /> BYOK
						</button>
					)}
				</div>
			)}
		</div>
	);

	return (
		<>
			<section className="ai-settings-section">
				<button
					type="button"
					className="ai-settings-toggle"
					aria-expanded={settingsExpanded}
					onClick={() => void setSettingsExpanded(!settingsExpanded)}
				>
					<span className="ai-settings-toggle-icon">
						<Bot size={13} />
					</span>
					<span className="ai-settings-toggle-copy">
						<strong>AI connections</strong>
						<small>
							{connectedCount} configured / detected · {models.length} models
						</small>
					</span>
					<ChevronRight
						size={13}
						className={settingsExpanded ? "is-expanded" : ""}
					/>
				</button>
				{settingsExpanded && (
					<div className="ai-connections-settings">
						{connectedConnections.length > 0 && (
							<div className="ai-connection-group">
								<div className="ai-connection-group-label">
									<span>Configured / detected</span>
									<span>{connectedConnections.length}</span>
								</div>
								<div className="ai-connection-list">
									{connectedConnections.map(renderConnection)}
								</div>
							</div>
						)}
						{availableConnections.length > 0 && (
							<div className="ai-connection-group">
								<div className="ai-connection-group-label">
									<span>Available providers</span>
									<span>{availableConnections.length}</span>
								</div>
								<div className="ai-connection-list">
									{availableConnections.map(renderConnection)}
								</div>
							</div>
						)}
						{models.length > 0 && (
							<label className="ai-settings-model-label">
								<span className="ai-settings-model-copy">
									<strong>Default model</strong>
									<small>Used for new AI actions</small>
								</span>
								<select
									value={
										defaultModel ||
										models.find((model) => model.isDefault)?.id ||
										models[0]?.id ||
										""
									}
									onChange={(event) => void setDefaultModel(event.target.value)}
								>
									{models.map((model) => (
										<option value={model.id} key={model.id}>
											{model.displayName} · {aiSourceLabel(model.sourceId)}
										</option>
									))}
								</select>
							</label>
						)}
						<div className="ai-connections-footer">
							<span>Credentials stay local</span>
							<button
								className="ai-refresh-connections"
								type="button"
								onClick={() => void refresh()}
								disabled={loading}
							>
								<RefreshCw size={12} className={loading ? "is-spinning" : ""} /> Refresh
							</button>
						</div>
						{(error || localError) && (
							<div className="ai-settings-error" role="alert">
								{localError || error}
							</div>
						)}
					</div>
				)}
			</section>

			<Modal
				open={!!keySource}
				onClose={closeKeyModal}
				className="ai-key-modal"
				ariaLabel={`Connect ${keySourceLabel}`}
				ariaBusy={busy}
			>
				<form
					className="ai-key-form"
					onSubmit={(event) => {
						event.preventDefault();
						void saveKey();
					}}
				>
					<div className="ai-key-modal-header">
						<div className="ai-key-modal-heading">
							<span className="ai-key-modal-icon">
								<KeyRound size={18} />
							</span>
							<div>
								<span className="ai-key-modal-eyebrow">Secure provider connection</span>
								<h2>Connect {keySourceLabel}</h2>
							</div>
						</div>
						<button
							type="button"
							className="ai-key-modal-close"
							onClick={closeKeyModal}
							aria-label="Close"
						>
							<X size={16} />
						</button>
					</div>
					<div className="modal-body">
						<p className="ai-key-modal-intro">
							Paste your {keySourceLabel} API key to make its models available in
							diffing.
						</p>
						<label className="ai-key-field">
							<span>API key</span>
							<div className="ai-key-input-wrap">
								<input
									type={showKey ? "text" : "password"}
									value={key}
									onChange={(event) => setKey(event.target.value)}
									autoComplete="off"
									spellCheck={false}
									placeholder="Paste API key"
								/>
								<button
									type="button"
									onClick={() => setShowKey((current) => !current)}
									aria-label={showKey ? "Hide API key" : "Show API key"}
								>
									{showKey ? <EyeOff size={15} /> : <Eye size={15} />}
								</button>
							</div>
						</label>
						<label className="ai-key-remember">
							<input
								type="checkbox"
								checked={remember}
								onChange={(event) => setRemember(event.target.checked)}
							/>
							<ShieldCheck size={17} />
							<span>
								<strong>Remember securely</strong>
								<small>Use the OS credential vault when available.</small>
							</span>
						</label>
						<div className="ai-key-local-note">
							<ShieldCheck size={13} />
							<span>
								The key stays on this device and is never written to settings.json.
							</span>
						</div>
						{localError && (
							<div role="alert" className="ai-settings-error">
								{localError}
							</div>
						)}
					</div>
					<div className="modal-actions">
						<button type="button" className="btn" onClick={closeKeyModal}>
							Cancel
						</button>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={!key.trim() || busy}
						>
							<CheckCircle2 size={13} /> {busy ? "Connecting…" : "Connect"}
						</button>
					</div>
				</form>
			</Modal>

			<Modal
				open={!!command}
				onClose={() => setCommand("")}
				className="ai-command-modal"
				ariaLabel="Configure AI runtime"
			>
				<div className="modal-header">
					<TerminalSquare size={18} />
					<h2>Finish setup in your terminal</h2>
				</div>
				<div className="modal-body">
					<p>Run the provider’s native credential flow, then refresh connections.</p>
					<code>{command}</code>
				</div>
				<div className="modal-actions">
					<button
						className="btn"
						onClick={() => void navigator.clipboard.writeText(command)}
					>
						<Copy size={13} /> Copy command
					</button>
					<button
						className="btn btn-primary"
						onClick={() => {
							setCommand("");
							void refresh();
						}}
					>
						Done
					</button>
				</div>
			</Modal>
		</>
	);
}
