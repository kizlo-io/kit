"use client"

/**
 * The app's Kizlo client, made available to every client component below it.
 *
 * Configuration, not state: the provider holds one value the app already owns. It imports nothing but React, so a kit that
 * depends on `@kizlo/kit` does not drag a query or URL-state library into an app that uses neither.
 *
 * Server components cannot read React context, so they keep taking the client as a prop.
 */

import type { ActiveKizloClient } from "kizlo"
import { createContext, type ReactNode, useContext, useMemo } from "react"

/**
 * What the context carries. One key today, which is why the hook hands back the object rather than the client itself: a
 * locale, a session or kit-wide configuration can join it without changing a signature.
 */
export type KizloContextValue = {
	/** The app's browser Kizlo client, typed from the procedures that app registered. */
	client: ActiveKizloClient
}

const KizloContext = createContext<KizloContextValue | null>(null)

export type KizloProviderProps = {
	children: ReactNode
	/** The app's browser Kizlo client, the one `createKizloClient` returned. */
	client: ActiveKizloClient
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
	// `ActiveKizloClient` is `any` until the app registers its procedures, so a missing client is not a type error there, and
	// the context value below is an object either way — nothing downstream would catch it before the first procedure call.
	if (!client) {
		throw new Error("<KizloProvider client={client}> needs the browser client `createKizloClient` returned.")
	}

	// Keyed on the client alone, so the value's identity survives every re-render of the app's provider tree.
	const value = useMemo<KizloContextValue>(() => ({ client }), [client])

	return <KizloContext.Provider value={value}>{children}</KizloContext.Provider>
}

/**
 * Reads the kit context, whose `client` is typed from the procedures the app registered — so a call the contract does not
 * carry is a compile error rather than a runtime surprise.
 *
 * @example
 * ```tsx
 * "use client"
 * import { useKizloContext } from "@kizlo/kit/react"
 *
 * function useCartProcedures() {
 * 	const { client } = useKizloContext()
 * 	return client.woocommerce.cart
 * }
 * ```
 */
export function useKizloContext(): KizloContextValue {
	const value = useContext(KizloContext)

	if (!value) {
		throw new Error("mount <KizloProvider client={client}> from @kizlo/kit/react above this component.")
	}

	return value
}
