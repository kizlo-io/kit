"use client"

/**
 * The kit's one provider: configuration for every WooCommerce feature in the tree.
 *
 * It imports nothing but React — no query library, no URL-state library — so importing the provider resolves neither. The
 * configuration it holds is exactly that: no feature state lives here, which is what keeps its context value stable across
 * renders while the cart or checkout changes underneath.
 *
 * It does not hold the Kizlo client. That is `KizloProvider` in `@kizlo/kit/react`, one level up, because every kit reads the
 * same client.
 */

import { type ReactNode, useEffect, useMemo, useRef } from "react"
import type { WooCommerceCallbacks } from "../checkout"
import { type WooCommerceConfig, WooCommerceConfigContext } from "./config"

export type WooCommerceProviderProps = WooCommerceCallbacks & {
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
 * Configures the WooCommerce kit for the tree below it, and hears every cart and checkout action in that tree.
 *
 * Its callbacks are where a concern that belongs to the whole storefront goes — analytics, or opening the cart drawer the
 * moment an add starts — wired once instead of at each call site. A hook's own callbacks fire as well, and first.
 *
 * @example
 * ```tsx
 * // app/providers.tsx
 * "use client"
 * import { KizloProvider } from "@kizlo/kit/react"
 * import { WooCommerceProvider } from "@kizlo/woocommerce-kit/react/provider"
 * import { QueryClientProvider } from "@tanstack/react-query"
 * import { client } from "@/lib/kizlo/client"
 * import { queryClient } from "@/lib/query-client"
 *
 * export function Providers({ children }) {
 * 	return (
 * 		<QueryClientProvider client={queryClient}>
 * 			<KizloProvider client={client}>
 * 				<WooCommerceProvider
 * 					locale="en-IN"
 * 					onStart={(event) => {
 * 						if (event.type === "add_to_cart") openCartDrawer()
 * 					}}
 * 					onSuccess={(event) => {
 * 						if (event.type === "confirm_checkout") track("purchase", { orderId: event.checkout.orderId })
 * 					}}
 * 				>
 * 					{children}
 * 				</WooCommerceProvider>
 * 			</KizloProvider>
 * 		</QueryClientProvider>
 * 	)
 * }
 * ```
 */
export function WooCommerceProvider({ cartEnabled = true, children, locale, ...callbacks }: WooCommerceProviderProps) {
	const callbacksRef = useRef<WooCommerceCallbacks>(callbacks)

	useEffect(() => {
		callbacksRef.current = callbacks
	})

	// Only the configuration is in the value, so it changes when the app changes it and not when the cart does.
	const config = useMemo<WooCommerceConfig>(() => ({ callbacks: callbacksRef, cartEnabled, locale }), [cartEnabled, locale])

	return <WooCommerceConfigContext.Provider value={config}>{children}</WooCommerceConfigContext.Provider>
}
