import { defineConfig } from "tsdown"

/**
 * The source modules that declare `"use client"`.
 *
 * The bundler drops the source directive, so it is re-added to every chunk one of these reaches: the entry itself, and the
 * shared chunk `react/server` pulls the collection provider out of. Matched on modules rather than on the chunk name, because a
 * name is emergent — `react/cart` does not contain the word "client", and a shared chunk is named after whichever module it
 * happened to come from.
 */
const clientModules = [
	"src/react/checkout-lock-store.ts",
	"src/react/checkout-lock-cache.ts",
	"src/react/checkout-watch.ts",
	"src/react/checkout-error-store.ts",
	"src/react/cart.tsx",
	"src/react/cart-action.ts",
	"src/react/cart-address.ts",
	"src/react/checkout.tsx",
	"src/react/checkout-fields.tsx",
	"src/react/checkout-fields-tanstack-form.tsx",
	"src/react/checkout-fields-react-hook-form.tsx",
	"src/react/session-queries.tsx",
	"src/react/client.tsx",
	"src/react/context.tsx",
	"src/react/provider.tsx",
	"src/react/search.tsx",
	"src/react/storefront.tsx",
]

function isClientModule(id: string | null) {
	if (!id) return false

	const path = id.replaceAll("\\", "/")
	return clientModules.some((module) => path.endsWith(module))
}

export default defineConfig({
	format: ["esm"],
	entry: {
		index: "src/index.ts",
		"react/cart": "src/react/cart.tsx",
		"react/checkout": "src/react/checkout.tsx",
		"react/checkout-fields": "src/react/checkout-fields.tsx",
		"react/checkout-fields/tanstack-form": "src/react/checkout-fields-tanstack-form.tsx",
		"react/checkout-fields/react-hook-form": "src/react/checkout-fields-react-hook-form.tsx",
		"react/client": "src/react/client.tsx",
		"react/provider": "src/react/provider.tsx",
		"react/search": "src/react/search.tsx",
		"react/server": "src/react/server.tsx",
		"react/storefront": "src/react/storefront.tsx",
	},
	outputOptions: {
		legalComments: "inline",
		// A server entry importing a provider chunk without the directive turns that provider into a server component, which
		// fails at its first hook.
		banner: (chunk) => (isClientModule(chunk.facadeModuleId) || chunk.moduleIds.some(isClientModule) ? '"use client"' : ""),
	},
	dts: { tsconfig: "tsconfig.build.json" },
})
