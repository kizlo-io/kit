"use client"

import { isServer, skipToken, useQuery } from "@tanstack/react-query"
import { cartStaleTime } from "../cart"
import {
	addressMutationKey,
	addressQueueKey,
	cartMutationKey,
	cartQueryKey,
	checkoutQueryKey,
	noQueuedWork,
	shippingMutationKey,
} from "../session-keys"
import type { Cart, CartError, Checkout, CheckoutError } from "../types"
import { useCheckoutLockStore, useCheckoutReadiness } from "./checkout-lock-store"
import { useWooCommerceContext } from "./context"

export { addressMutationKey, addressQueueKey, cartMutationKey } from "../session-keys"

export function useCheckoutQuery() {
	const binding = useCheckoutLockStore()
	return useQuery<Checkout, CheckoutError>({
		enabled: !isServer,
		queryFn: ({ signal }) => binding.readCheckout(signal),
		queryKey: checkoutQueryKey,
	})
}

/** A disabled observer still reads cart updates while checkout owns bootstrap. */
export function useCartQuery(bootstrapped = true) {
	const { cartEnabled } = useWooCommerceContext()
	const binding = useCheckoutLockStore()
	return useQuery<Cart, CartError>({
		enabled: bootstrapped && cartEnabled && !isServer,
		queryFn: ({ signal }) => binding.readCart(signal),
		queryKey: cartQueryKey,
		staleTime: (query) => (query.state.data == null ? 0 : cartStaleTime),
	})
}

export function useCartActivity() {
	const binding = useCheckoutLockStore()
	useCheckoutReadiness(binding)
	const { data: queuedAddresses = noQueuedWork } = useQuery({
		queryKey: addressQueueKey,
		queryFn: skipToken,
		initialData: noQueuedWork,
		gcTime: Infinity,
	})
	return {
		isMutating: binding.pending(cartMutationKey),
		isRepricing: binding.pending(addressMutationKey) || queuedAddresses.length > 0,
		isSelectingRate: binding.pending(shippingMutationKey),
	}
}
