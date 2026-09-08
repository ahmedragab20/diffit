import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Deliberately separate from the real dev server: no auth bridge or API proxy.
export default defineConfig({
	plugins: [
		react(),
		{
			name: "reject-unmocked-api",
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					if (!request.url?.startsWith("/api/")) return next();
					response.writeHead(503, { "Content-Type": "application/json" });
					response.end(JSON.stringify({ error: "Unmocked browser fixture API" }));
				});
			},
		},
	],
	resolve: { dedupe: ["react", "react-dom"] },
	server: { host: "127.0.0.1", port: 4179, strictPort: true },
});
