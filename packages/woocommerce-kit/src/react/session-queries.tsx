"use client"

import { isServer, skipToken, useQuery } from "@tanstack/react-query"
import { useCallback, useId, useLayoutEffect } from "react"
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

export { addressMutationKey, addressQueueKey, cartMutationKey } from "../session-keys"

export function useAddressQueueActivity() {
	const binding = useCheckoutLockStore()
	const owner = useId()
	return useCallback((active: boolean) => binding.queue(addressQueueKey, owner, active), [binding, owner])
}

export function useCheckoutQuery() {
	const binding = useCheckoutLockStore()
	useLayoutEffect(() => binding.enableCheckout(), [binding])
	return useQuery<Checkout, CheckoutError>({
		enabled: !isServer,
		queryFn: () => binding.readCheckout(),
		queryKey: checkoutQueryKey,
	})
}

/** A disabled observer still reads cart API updates initiated by checkout. */
export function useCartQuery(bootstrapped = true) {
	const binding = useCheckoutLockStore()
	return useQuery<Cart, CartError>({
		enabled: bootstrapped && !isServer,
		queryFn: () => binding.readCart(),
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
