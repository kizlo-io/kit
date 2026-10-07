"use client"

import { useKizloContext } from "kizlo/react"
import { useCallback, useSyncExternalStore } from "react"
import { type CheckoutErrorStore, checkoutErrorStore } from "../checkout-errors"
import { useWooCommerceContext } from "./context"

export function useCheckoutErrorStore() {
	const { client } = useKizloContext()
	const { queryClient } = useWooCommerceContext()
	return checkoutErrorStore(client, queryClient)
}
export function useCheckoutErrorState(store: CheckoutErrorStore) {
	const subscribe = useCallback((listener: () => void) => store.state.listen(listener), [store])
	return useSyncExternalStore(subscribe, store.state.get, store.state.get)
}
