"use client"

/**
 * The kit's own context, shared by `./provider` and every feature entry.
 *
 * Not an entry point of its own: an app mounts `WooCommerceProvider` and the hooks read this. Kept separate so the provider
 * entry exports the provider and nothing else, and so a feature chunk can read the context without importing the provider's
 * own module graph.
 */

import type { QueryClient } from "@tanstack/react-query"
import { createContext, useContext } from "react"

export type WooCommerceContextValue = {
	/** Whether the cart may fetch itself. False on a route that seeds `cartQueryKey` instead. */
	cartEnabled: boolean
	/** Locale for money formatting. Decides grouping and symbol placement, never the currency. */
	locale: string | undefined
	/** The app's own query client, read once here so every feature shares one cache. */
	queryClient: QueryClient
}

export const WooCommerceContext = createContext<WooCommerceContextValue | null>(null)

/** Reads the kit's context, or says which provider is missing. */
export function useWooCommerceContext(): WooCommerceContextValue {
	const value = useContext(WooCommerceContext)

	if (!value) {
		throw new Error("mount <WooCommerceProvider> from @kizlo/woocommerce-kit/react/provider above this component.")
	}

	return value
}
