"use client"

/**
 * The kit's one provider: configuration for every WooCommerce feature in the tree.
 *
 * It imports nothing but React — no query library, no URL-state library — so importing the provider resolves neither. The
 * configuration it holds is exactly that: no feature state lives here, which is what keeps its context value stable across
 * renders while the cart or checkout changes underneath.
 *
 * It does not hold the Kizlo client. That is `KizloProvider` in `kizlo/react`, one level up, because every kit reads the
 * same client.
 */

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

/**
 * Configures the WooCommerce kit for the tree below it.
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
	// Only the configuration is in the value, so it changes when the app changes it and not when the cart does.
	const value = useMemo<WooCommerceContextValue>(() => ({ cartEnabled, locale }), [cartEnabled, locale])

	return <WooCommerceContext.Provider value={value}>{children}</WooCommerceContext.Provider>
}
