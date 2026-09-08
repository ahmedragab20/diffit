import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiConnectionsPanel } from "../AiConnectionsPanel";

const mocks = vi.hoisted(() => ({
	setSettingsExpanded: vi.fn(),
	setDefaultModel: vi.fn(),
	connectKey: vi.fn(),
	setup: vi.fn(),
	disconnect: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("../AiContext", () => ({
	useOptionalAi: () => ({
		connections: [
			{
				id: "claude",
				label: "Claude",
				status: "connected",
				runtimeAvailable: true,
				credentialRoutes: ["subscription"],
				activeRoutes: [],
				authentication: { evidence: "runtime-status", verified: false, configuredRoutes: [] },
			},
			{
				id: "xai",
				label: "xAI",
				status: "connected",
				runtimeAvailable: true,
				credentialRoutes: ["direct-key"],
				activeRoutes: [],
				authentication: { evidence: "key-configured", verified: false, configuredRoutes: ["direct-key"] },
			},
		],
		models: [],
		defaultModel: "",
		settingsExpanded: true,
		loading: false,
		error: null,
		...mocks,
	}),
}));

describe("AiConnectionsPanel", () => {
	it("shows honest unverified connection labels without side effects", () => {
		render(<AiConnectionsPanel />);

		expect(screen.getByText("Runtime detected · unverified")).toBeInTheDocument();
		expect(screen.getByText("Key configured · unverified")).toBeInTheDocument();
		expect(screen.queryByText("Connected", { exact: true })).not.toBeInTheDocument();
		for (const action of Object.values(mocks)) expect(action).not.toHaveBeenCalled();
	});
});
