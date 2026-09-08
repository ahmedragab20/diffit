import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiProvider } from "../../src/ui/ai/AiContext";
import { AiAssistantRail } from "../../src/ui/ai/AiAssistantRail";
import type { AiReviewContext, AiSurface } from "../../src/lib/ai/types";
import "../../src/ui/styles/global.css";
import "../../src/ui/styles/gridline.css";

const requested = new URLSearchParams(location.search).get("surface");
const surface: AiSurface =
	requested === "plan" || requested === "pr-diff" ? requested : "diff";
const context: AiReviewContext =
	surface === "plan"
		? {
				kind: "plan",
				planId: "synthetic-plan",
				title: "Synthetic plan",
				version: 1,
				body: "# Plan\nVerify before shipping.",
			}
		: { kind: "diff", repoName: "synthetic", branch: "baseline", patch: "" };
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Fixture() {
	const [open, setOpen] = useState(true);
	return (
		<div style={{ display: "flex", height: "100vh", justifyContent: "flex-end" }}>
			{!open && <button onClick={() => setOpen(true)}>Reopen assistant</button>}
			<AiAssistantRail
				open={open}
				onClose={() => setOpen(false)}
				surface={surface}
				context={context}
			/>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<AiProvider>
			<Fixture />
		</AiProvider>
	</QueryClientProvider>,
);
