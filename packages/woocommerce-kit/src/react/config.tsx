"use client"

/**
 * The kit's configuration context, shared by `./provider` and every feature entry.
 *
 * Not an entry point of its own: an app mounts `WooCommerceProvider` and the hooks read this. Kept separate so the provider
 * entry exports the provider and nothing else, and so a feature chunk can read the configuration without importing the
 * provider's own module graph.
 */

import { createContext, type RefObject, useContext } from "react"
import type { WooCommerceCallbacks } from "../checkout"

export type WooCommerceConfig = {
	/** Whether the cart may fetch itself. False on a route that seeds `cartQueryKey` instead. */
	cartEnabled: boolean
	/** The kit-level action listeners, behind a ref so an inline callback does not change the context value. */
	callbacks: RefObject<WooCommerceCallbacks>
	/** Locale for money formatting. Decides grouping and symbol placement, never the currency. */
	locale: string | undefined
}

export const WooCommerceConfigContext = createContext<WooCommerceConfig | null>(null)

/** Reads the kit's configuration, or says which provider is missing. */
export function useWooCommerceConfig(): WooCommerceConfig {
	const config = useContext(WooCommerceConfigContext)

	if (!config) {
		throw new Error("mount <WooCommerceProvider> from @kizlo/woocommerce-kit/react/provider above this component.")
	}

	return config
}
