"use client"

/**
 * The kit's one provider: configuration for every WooCommerce feature in the tree.
 *
 * It reads the app's `QueryClient` once and hands it to every feature, so the cart, checkout and store settings share the app's
 * cache rather than each looking it up. It still imports no URL-state library. No feature state lives here, which is what keeps
 * its context value stable across renders while the cart or checkout changes underneath.
 *
 * It does not hold the Kizlo client. That is `KizloProvider` in `kizlo/react`, one level up, because every kit reads the
 * same client.
 */

import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useMemo } from "react"
import { WooCommerceContext, type WooCommerceContextValue } from "./context"

export type WooCommerceProviderProps = {
	/**
	 * Whether the cart fetches itself. Set it false on a route that seeds `cartQueryKey` from its own request — a checkout
	 * snapshot, for instance — so the two do not race.
	 */
	cartEnabled?: boolean
	children: ReactNode
	/** Locale for money formatting. Decides grouping and symbol placement, never the currency, which comes from the store. */
	locale?: string
}

/** The app's query client, or a message that names what is missing rather than react-query's own. */
function useAppQueryClient() {
	try {
		// biome-ignore lint/correctness/useHookAtTopLevel: called once per render; the try only rewrites the error.
		return useQueryClient()
	} catch {
		throw new Error(
			"<WooCommerceProvider> needs a <QueryClientProvider> above it: the kit uses the app's own QueryClient so every feature shares one cache.",
		)
	}
}

/**
 * Configures the WooCommerce kit for the tree below it.
 *
 * Needs the app's `QueryClientProvider` above it: the kit uses the app's own `QueryClient` and never creates one.
 *
 * Configuration and nothing else. An action reports itself through the callbacks on the hook that performs it, which is where
 * a listener goes — a storefront-wide concern wires the same listener on each hook it cares about.
 *
 * @example
 * ```tsx
 * // app/providers.tsx
 * "use client"
 * import { KizloProvider } from "kizlo/react"
 * import { WooCommerceProvider } from "@kizlo/woocommerce-kit/react/provider"
 * import { QueryClientProvider } from "@tanstack/react-query"
 * import { client } from "@/lib/kizlo/client"
 * import { queryClient } from "@/lib/query-client"
 *
 * export function Providers({ children }) {
 * 	return (
 * 		<QueryClientProvider client={queryClient}>
 * 			<KizloProvider client={client}>
 * 				<WooCommerceProvider locale="en-IN">{children}</WooCommerceProvider>
 * 			</KizloProvider>
 * 		</QueryClientProvider>
 * 	)
 * }
 * ```
 */
export function WooCommerceProvider({ cartEnabled = true, children, locale }: WooCommerceProviderProps) {
	const queryClient = useAppQueryClient()

	// Only the configuration is in the value, so it changes when the app changes it and not when the cart does.
	const value = useMemo<WooCommerceContextValue>(() => ({ cartEnabled, locale, queryClient }), [cartEnabled, locale, queryClient])

	return <WooCommerceContext.Provider value={value}>{children}</WooCommerceContext.Provider>
}
