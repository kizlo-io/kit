"use client"

import { useCallback, useEffect, useId, useMemo, useRef } from "react"
import { useDebouncedCallback } from "use-debounce"
import { cartQueryKey, normalizeCartAddress, shippingQuoteSignature } from "../cart"
import { defaultShouldUpdateAddress } from "../cart-address-policy"
import { CheckoutLockedError } from "../checkout-locks"
import type { Cart, CartAddressInput, CartAddressSnapshotInput, Storefront, UpdateCartInput } from "../types"
import type { CartAddressApi, CartAddressHookOptions } from "./cart"
import { useCartAction } from "./cart-action"
import { useCheckoutLockStore } from "./checkout-lock-store"
import { useWooCommerceContext } from "./context"
import { addressMutationKey, addressQueueKey } from "./session-queries"
import { storefrontQueryKey, useStorefront } from "./storefront"

function matchesSavedAddresses(input: CartAddressSnapshotInput, cart: Cart | null): boolean {
	if (!cart || (!input.shippingAddress && !input.billingAddress)) return false
	return (["shippingAddress", "billingAddress"] as const).every((key) => {
		const address = input[key]
		if (!address) return true
		const saved = cart[key]
		if (!address.country.trim() || !saved || shippingQuoteSignature(address) !== shippingQuoteSignature(saved)) return false
		return Object.entries(address).every(
			([field, value]) =>
				["country", "state", "city", "postcode"].includes(field) ||
				value === saved[field as keyof typeof saved] ||
				(value !== null && typeof value === "object" && JSON.stringify(value) === JSON.stringify(saved[field as keyof typeof saved])),
		)
	})
}

export function useCartAddressTransport(
	options?: CartAddressHookOptions,
	project?: (input: CartAddressInput) => UpdateCartInput,
	bootstrapped = true,
): CartAddressApi & {
	cancelQueued: () => void
	clearSavedFailure: (input: CartAddressSnapshotInput, cart: Cart | null) => void
} {
	useStorefront()
	const scope = useMemo(() => addressMutationKey, [])
	const { error, isPending, mutate, mutateAsync, reset, cancelFailures, rejectAdmission } = useCartAction(
		scope,
		options,
		true,
		bootstrapped,
	)
	const { queryClient } = useWooCommerceContext()
	const binding = useCheckoutLockStore()
	const { store } = binding
	const queuedGeneration = useRef<number | null>(null)
	const owner = useId()
	const latest = useRef<CartAddressSnapshotInput | null>(null)
	const waiters = useRef<{ resolve: (cart: Cart | undefined) => void; reject: (error: unknown) => void }[]>([])
	const { addressDebounceMs = 1500, shouldUpdateAddress = defaultShouldUpdateAddress } = options ?? {}

	const markQueued = useCallback(
		(queued: boolean) => {
			if (!queued) queuedGeneration.current = null
			binding.queue(addressQueueKey, owner, queued)
			if (queued) queuedGeneration.current = store.generation
		},
		[binding, owner, store],
	)

	useEffect(
		() => () => {
			latest.current = null
			for (const waiter of waiters.current.splice(0)) waiter.resolve(undefined)
			markQueued(false)
		},
		[markQueued],
	)

	const normalize = useCallback(
		(input: CartAddressInput) =>
			project
				? project(input)
				: normalizeCartAddress(
						input,
						queryClient.getQueryData<Cart>(cartQueryKey) ?? null,
						queryClient.getQueryData<Storefront>(storefrontQueryKey) ?? null,
					),
		[queryClient, project],
	)
	const update = useCallback((input: CartAddressInput) => mutate({ input: normalize(input), type: "update_customer" }), [mutate, normalize])
	const updateAsync = useCallback(
		(input: CartAddressInput) => mutateAsync({ input: normalize(input), type: "update_customer" }),
		[mutateAsync, normalize],
	)

	const clearSavedFailure = useCallback(
		(input: CartAddressSnapshotInput, cart: Cart | null) => {
			if (matchesSavedAddresses(input, cart)) {
				cancelFailures({ type: "update_customer", input })
				reset()
			}
		},
		[cancelFailures, reset],
	)

	const push = useDebouncedCallback(() => {
		const snapshot = latest.current
		if (!snapshot) return
		// Compare only after the store has answered: a revert can match the old cache while the in-flight save will change it.
		if (binding.pending(scope)) {
			push()
			return
		}
		latest.current = null
		const cart = queryClient.getQueryData<Cart>(cartQueryKey) ?? null
		const input = normalize(snapshot) as CartAddressSnapshotInput
		// Detach this batch before dispatch so edits during the request belong to the next batch.
		const batch = waiters.current.splice(0)
		if (shouldUpdateAddress(input, cart)) {
			if (batch.length === 0) update(snapshot)
			else
				void updateAsync(snapshot).then(
					(saved) => {
						for (const waiter of batch) waiter.resolve(saved)
					},
					(error) => {
						for (const waiter of batch) waiter.reject(error)
					},
				)
		} else {
			clearSavedFailure(input, cart)
			for (const waiter of batch) waiter.resolve(undefined)
		}
		markQueued(false)
	}, addressDebounceMs)

	const onAddressChange = useCallback(
		(input: CartAddressSnapshotInput) => {
			// The form may mutate its values in place; the queued snapshot must describe this particular edit.
			latest.current = structuredClone(input)
			const cart = queryClient.getQueryData<Cart>(cartQueryKey) ?? null
			const projected = normalize(latest.current) as CartAddressSnapshotInput
			if (!binding.pending(scope) && !shouldUpdateAddress(projected, cart)) {
				clearSavedFailure(projected, cart)
				latest.current = null
				push.cancel()
				for (const waiter of waiters.current.splice(0)) waiter.resolve(undefined)
				markQueued(false)
				return
			}
			try {
				markQueued(true)
			} catch (error) {
				if (!(error instanceof CheckoutLockedError)) throw error
				rejectAdmission(error, { input: projected, type: "update_customer" })
				latest.current = null
				for (const waiter of waiters.current.splice(0)) waiter.reject(error)
				return
			}
			push()
		},
		[binding, clearSavedFailure, markQueued, normalize, push, queryClient, scope, shouldUpdateAddress, rejectAdmission],
	)

	const onAddressChangeAsync = useCallback(
		(input: CartAddressSnapshotInput): Promise<Cart | undefined> =>
			new Promise((resolve, reject) => {
				waiters.current.push({ resolve, reject })
				onAddressChange(input)
			}),
		[onAddressChange],
	)

	const cancelQueued = useCallback(() => {
		latest.current = null
		push.cancel()
		for (const waiter of waiters.current.splice(0)) waiter.resolve(undefined)
		markQueued(false)
	}, [push, markQueued])
	const cancel = useCallback(() => {
		cancelQueued()
		cancelFailures()
		reset()
	}, [cancelQueued, cancelFailures, reset])
	useEffect(
		() =>
			store.state.listen(() => {
				if (queuedGeneration.current !== null && queuedGeneration.current !== store.generation) cancelQueued()
			}),
		[cancelQueued, store],
	)
	const flush = useCallback(() => {
		if (!binding.pending(scope)) push.flush()
	}, [binding, push, scope])
	return {
		error,
		isPending,
		onAddressChange,
		onAddressChangeAsync,
		flush,
		cancel,
		cancelQueued,
		clearSavedFailure,
		reset,
		update,
		updateAsync,
	}
}
