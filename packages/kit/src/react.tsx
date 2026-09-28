"use client"

/**
 * The app's Kizlo client, made available to every client component below it.
 *
 * Configuration, not state: the provider holds one value the app already owns. It imports nothing but React, so a kit that
 * depends on `@kizlo/kit` does not drag a query or URL-state library into an app that uses neither.
 *
 * Server components cannot read React context, so they keep taking the client as a prop.
 */

import { createContext, type ReactNode, useContext } from "react"
import { assertKizloClient, type KizloClient } from "./client"

const KizloClientContext = createContext<KizloClient | null>(null)

export type KizloProviderProps = {
	children: ReactNode
	/** The app's browser Kizlo client, generated from its own WordPress introspection. */
	client: KizloClient
}

/**
 * Holds the app's browser Kizlo client for the client components below it. Mount it once, above every kit provider.
 *
 * @example
 * ```tsx
 * // app/providers.tsx
 * "use client"
 * import { KizloProvider } from "@kizlo/kit/react"
 * import { QueryClientProvider } from "@tanstack/react-query"
 * import { client } from "@/lib/kizlo/client"
 * import { queryClient } from "@/lib/query-client"
 *
 * export function Providers({ children }) {
 * 	return (
 * 		<QueryClientProvider client={queryClient}>
 * 			<KizloProvider client={client}>{children}</KizloProvider>
 * 		</QueryClientProvider>
 * 	)
 * }
 * ```
 */
export function KizloProvider({ children, client }: KizloProviderProps) {
	return <KizloClientContext.Provider value={client}>{children}</KizloClientContext.Provider>
}

/**
 * Reads the app's client, narrowed to the slice named by `path` and checked at runtime.
 *
 * `path` is the dotted procedure path the caller is about to use. A client that does not carry it fails here, naming what is
 * absent, instead of throwing a `TypeError` inside the request. Pass `override` to supply a client directly — a stub in a test,
 * or a second store — in which case no provider is required.
 *
 * @example
 * ```tsx
 * "use client"
 * import { useKizloClient } from "@kizlo/kit/react"
 * import type { CartStoreClient } from "@kizlo/woocommerce-kit"
 *
 * function useCartProcedures(override?: CartStoreClient) {
 * 	const client = useKizloClient<CartStoreClient>("woocommerce.cart", override)
 * 	return client.woocommerce.cart
 * }
 * ```
 */
export function useKizloClient<T extends KizloClient>(path: string, override?: T): T {
	const client = useContext(KizloClientContext)

	if (override) return assertKizloClient<T>(override, path)
	if (!client) {
		throw new Error(
			`a Kizlo client is needed for ${path}: mount <KizloProvider client={client}> above this component, or pass a client to the hook.`,
		)
	}

	return assertKizloClient<T>(client, path)
}
