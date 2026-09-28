/**
 * The app's Kizlo client, as a kit sees it.
 *
 * A client is generated per app from that app's own WordPress introspection, so a kit cannot name its type — it declares the
 * structural slice it calls and reads the app's client through that. Nothing checks the narrowing at compile time, which is
 * what `assertKizloClient` is for.
 */

/**
 * Any Kizlo client. Deliberately as wide as "an object": the real type differs per app, and a kit narrows it to its own slice
 * on read rather than constraining what an app may pass.
 */
export type KizloClient = object

function missing(path: string) {
	return new Error(`the client passed to <KizloProvider> has no ${path} procedures`)
}

/**
 * Checks that a client actually carries the procedures a kit is about to call, and returns it narrowed to that slice.
 *
 * Without this, an app that passes a client built from an introspection missing the integration fails with a `TypeError` deep
 * inside a request — `Cannot read properties of undefined` — long after the mistake. This fails at the hook that needs it, and
 * names what is absent.
 *
 * @example
 * ```ts
 * import { assertKizloClient } from "@kizlo/kit"
 * import type { CartStoreClient } from "@kizlo/woocommerce-kit"
 *
 * const client = assertKizloClient<CartStoreClient>(appClient, "woocommerce.cart")
 * await client.woocommerce.cart.get.call()
 *
 * assertKizloClient({ woocommerce: {} }, "woocommerce.cart")
 * // Error: the client passed to <KizloProvider> has no woocommerce.cart procedures
 * ```
 */
export function assertKizloClient<T extends KizloClient>(client: unknown, path: string): T {
	if (!client || typeof client !== "object") throw missing(path)

	let current: unknown = client
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object" || !(segment in current)) throw missing(path)
		current = (current as Record<string, unknown>)[segment]
	}

	// The leaf has to be the procedures object itself, not a stray value parked at that name.
	if (!current || typeof current !== "object") throw missing(path)

	return client as T
}
