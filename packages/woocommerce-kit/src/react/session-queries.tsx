"use client"

import { isServer, skipToken, useIsMutating, useQuery } from "@tanstack/react-query"
import { useKizloContext } from "kizlo/react"
import { cartQueryKey, cartStaleTime } from "../cart"
import { checkoutQueryKey } from "../checkout"
import type { Cart, CartError, Checkout, CheckoutError } from "../types"
import { useWooCommerceContext } from "./context"

export const cartMutationKey = [...cartQueryKey, "mutation"] as const
export const addressMutationKey = [...cartMutationKey, "address"] as const
export const addressQueueKey = [...cartQueryKey, "addressQueue"] as const
export const noQueuedAddresses: string[] = []

export function useCheckoutQuery() {
	const { client } = useKizloContext()
	const { queryClient } = useWooCommerceContext()
	return useQuery<Checkout, CheckoutError>({
		enabled: !isServer,
		queryFn: async () => {
			const checkout = await client.woocommerce.checkout.get.call()
			queryClient.setQueryData(cartQueryKey, checkout.cart)
			return checkout
		},
		queryKey: checkoutQueryKey,
	})
}

/** A disabled observer still reads cart updates while checkout owns bootstrap. */
export function useCartQuery(bootstrapped = true) {
	const { client } = useKizloContext()
	const { cartEnabled } = useWooCommerceContext()
	return useQuery<Cart, CartError>({
		enabled: bootstrapped && cartEnabled && !isServer,
		queryFn: () => client.woocommerce.cart.get.call(),
		queryKey: cartQueryKey,
		staleTime: (query) => (query.state.data == null ? 0 : cartStaleTime),
	})
}

export function useCartActivity() {
	const isMutating = useIsMutating({ mutationKey: cartMutationKey }) > 0
	const isAddressPending = useIsMutating({ mutationKey: addressMutationKey }) > 0
	const isSelectingRate = useIsMutating({ mutationKey: [...cartMutationKey, "shippingRate"] }) > 0
	const { data: queuedAddresses = noQueuedAddresses } = useQuery({
		queryKey: addressQueueKey,
		queryFn: skipToken,
		initialData: noQueuedAddresses,
		gcTime: Infinity,
	})
	return { isMutating, isRepricing: isAddressPending || queuedAddresses.length > 0, isSelectingRate }
}
