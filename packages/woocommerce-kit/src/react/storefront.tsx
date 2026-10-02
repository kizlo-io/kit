"use client"

/**
 * React adapter for the store's settings: one query, no feature provider.
 *
 * `storefront.get` is reference data — the store's countries and field rules now, its checkout, pricing and catalog settings for
 * later features. It has no page to hang off and is not session state, so it is fetched once in the browser through the app's
 * query client from `WooCommerceProvider` and kept for a long time. Every derivation over it lives in the core, which takes `storefront.address`.
 *
 * Renders nothing.
 */

import { isServer, useQuery } from "@tanstack/react-query"
import { useKizloContext } from "kizlo/react"
import { useCallback } from "react"
import type { Storefront, StorefrontError } from "../types"
import { useWooCommerceContext } from "./context"

/** The core address types, available beside the hook whose payload they describe. */
export type {
	AddressCompletenessInput,
	AddressCountryModel,
	AddressField,
	StorefrontAddress,
	StorefrontCountry,
	StorefrontState,
} from "../address"
export type { Storefront, StorefrontError } from "../types"

/** The one copy of the store's settings in the app's query client. */
export const storefrontQueryKey = ["kizlo", "woocommerce", "storefront"] as const

/**
 * How long the settings stay fresh. They change when a merchant edits WooCommerce, not while a shopper browses, so an hour; a
 * page that must see an edit sooner calls `refresh`.
 */
export const storefrontStaleTime = 60 * 60 * 1000

export type StorefrontApi = {
	/** The store's settings, or `null` before they load and when loading failed. */
	storefront: Storefront | null
	/** The last fetch failure. */
	error: StorefrontError | null
	isLoading: boolean
	refresh: () => Promise<void>
}

/**
 * The store's settings, fetched once and shared by every consumer.
 *
 * Fails soft: a dead request leaves `storefront` null and sets `error`, so an address form can fall back to free-text fields
 * rather than blanking.
 *
 * Needs `KizloProvider` and `WooCommerceProvider` above it. It takes no client.
 *
 * @example
 * ```tsx
 * "use client"
 * import { isAddressComplete, resolveAddressCountry, shippingCountries } from "@kizlo/woocommerce-kit"
 * import { useStorefront } from "@kizlo/woocommerce-kit/react/storefront"
 *
 * const { storefront } = useStorefront()
 * if (storefront) {
 * 	const countries = shippingCountries(storefront.address)
 * 	const { fields, states, stateLabel } = resolveAddressCountry(storefront.address, address.country)
 * 	const isComplete = isAddressComplete(storefront.address, address)
 * }
 * ```
 */
export function useStorefront(): StorefrontApi {
	const { client } = useKizloContext()
	const { queryClient } = useWooCommerceContext()

	const query = useQuery<Storefront, StorefrontError>({
		enabled: !isServer,
		// React Query reports a failure by rejection, which is what `.call` does.
		queryFn: () => client.woocommerce.storefront.get.call(),
		queryKey: storefrontQueryKey,
		staleTime: storefrontStaleTime,
	})

	const refresh = useCallback(async () => {
		await queryClient.refetchQueries({ queryKey: storefrontQueryKey })
	}, [queryClient])

	return { error: query.error, isLoading: query.isPending, refresh, storefront: query.data ?? null }
}
