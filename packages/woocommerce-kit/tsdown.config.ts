import { defineConfig } from "tsdown"

export default defineConfig({
	format: ["esm"],
	entry: { index: "src/index.ts", "react/client": "src/react/client.tsx", "react/server": "src/react/server.tsx" },
	outputOptions: {
		legalComments: "inline",
		// The bundler drops the source directive, and a framework's server entry importing a chunk without it would turn the
		// provider into a server component. Every module reachable from a `client` entry is a client module, so the banner goes
		// on those chunks.
		banner: (chunk) => (chunk.name.includes("client") ? '"use client"' : ""),
	},
	dts: { tsconfig: "tsconfig.build.json" },
})
