import { defineConfig } from "tsdown"

/**
 * The source modules that declare `"use client"`. The bundler drops the directive, so it is re-added to every chunk one of them
 * reaches — matched on modules rather than the chunk name, because a name is emergent.
 */
const clientModules = ["src/react.tsx"]

function isClientModule(id: string | null) {
	if (!id) return false

	const path = id.replaceAll("\\", "/")
	return clientModules.some((module) => path.endsWith(module))
}

export default defineConfig({
	format: ["esm"],
	entry: { index: "src/index.ts", react: "src/react.tsx" },
	outputOptions: {
		legalComments: "inline",
		// A framework's server entry importing a provider chunk without the directive turns that provider into a server
		// component, which fails at its first hook.
		banner: (chunk) => (isClientModule(chunk.facadeModuleId) || chunk.moduleIds.some(isClientModule) ? '"use client"' : ""),
	},
	dts: { tsconfig: "tsconfig.build.json" },
})
