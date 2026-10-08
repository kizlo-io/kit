"use client"

import { useKizloContext } from "kizlo/react"
import { useCallback, useEffect, useSyncExternalStore } from "react"
import { type CheckoutLockState, type CheckoutLockStore, checkoutLockStore } from "../checkout-locks"
import { bindCheckoutLocks } from "./checkout-lock-cache"
import { useWooCommerceContext } from "./context"

export function useCheckoutLockStore() {
	const { client } = useKizloContext()
	const { queryClient, cartEnabled } = useWooCommerceContext()
	const store = checkoutLockStore(client, queryClient)
	const binding = bindCheckoutLocks(store, queryClient, client, cartEnabled)
	useEffect(() => binding.attach(), [binding])
	return binding
}

export function useCheckoutLockState(store: CheckoutLockStore): CheckoutLockState {
	const subscribe = useCallback((listener: () => void) => store.state.listen(listener), [store])
	return useSyncExternalStore(subscribe, store.state.get, store.state.get)
}

export function useCheckoutReadiness(binding: ReturnType<typeof useCheckoutLockStore>) {
	const { state } = binding.readiness
	const subscribe = useCallback((listener: () => void) => state.listen(listener), [state])
	return useSyncExternalStore(subscribe, state.get, state.get)
}
