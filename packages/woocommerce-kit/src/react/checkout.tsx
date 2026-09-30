"use client"

/**
 * React adapter for checkout: one query, one confirmation and no feature provider.
 *
 * The checkout snapshot is browser-session state. It runs on the app's query client, reads the browser Kizlo client from
 * `KizloProvider`, and seeds the cart's existing cache entry so checkout and every cart consumer see one cart.
 */

import { isServer, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toKizloError } from "kizlo"
import { useKizloContext } from "kizlo/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { cartQueryKey } from "../cart"
import {
	type CheckoutCallbacks,
	type CheckoutErrorEvent,
	type CheckoutStartEvent,
	type CheckoutSuccessEvent,
	checkoutQueryKey,
} from "../checkout"
import type { Checkout, CheckoutError, ConfirmCheckoutInput } from "../types"
import { useWooCommerceContext } from "./context"

/** The core checkout types, available beside the hook that returns them. */
export type {
	CheckoutActionPayload,
	CheckoutCallbacks,
	CheckoutErrorEvent,
	CheckoutSettledEvent,
	CheckoutStartEvent,
	CheckoutSuccessEvent,
} from "../checkout"
export type { CheckoutError } from "../types"

export type CheckoutHookOptions = CheckoutCallbacks

export type CheckoutApi = {
	/** The store's raw checkout snapshot, or `null` before it loads and when loading failed. */
	checkout: Checkout | null
	/** The last fetch or confirmation failure. */
	error: CheckoutError | null
	/** Confirms the order. Resolves to the new checkout, or `null` on failure; it never rejects. */
	confirm: (input: ConfirmCheckoutInput) => Promise<Checkout | null>
	isLoading: boolean
	isPending: boolean
	refresh: () => Promise<void>
	/** Clears the last confirmation failure. */
	reset: () => void
}

const checkoutMutationKey = [...checkoutQueryKey, "mutation"] as const

function useLatest<T>(value: T) {
	const ref = useRef(value)
	useEffect(() => {
		ref.current = value
	}, [value])
	return ref
}

function notify<E>(listener: ((event: E) => void) | undefined, event: E) {
	if (!listener) return

	try {
		listener(event)
	} catch (error) {
		queueMicrotask(() => {
			throw error
		})
	}
}

/** What a confirmation resolves to: the new checkout, or a failure from `checkout.confirm`'s own error map. */
type ConfirmResult = { data: Checkout; error: null; success: true } | { data: undefined; error: CheckoutError; success: false }

function useCheckoutQueryClient() {
	try {
		// biome-ignore lint/correctness/useHookAtTopLevel: called once per render; the try only replaces the setup error.
		return useQueryClient()
	} catch {
		throw new Error(
			"checkout needs a <QueryClientProvider> above it: the kit uses the app's own QueryClient to share checkout and cart state.",
		)
	}
}

/**
 * Loads and confirms the store checkout while keeping the shared cart cache in step.
 *
 * The hook owns no form state and performs no navigation. Render fields from `checkout`, use the cart hooks for shipping and
 * coupons, and decide what `paymentResult.redirectUrl` means in the app. Confirmation callbacks run hook first, then provider,
 * in the same four phases as cart actions.
 *
 * @example
 * ```tsx
 * "use client"
 * import { useCart } from "@kizlo/woocommerce-kit/react/cart"
 * import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
 *
 * export function CheckoutForm() {
 * 	const { cart } = useCart()
 * 	const { checkout, confirm, error, isLoading, isPending } = useCheckout({
 * 		onSuccess: ({ checkout }) => track("purchase", { orderId: checkout.orderId }),
 * 	})
 *
 * 	if (isLoading) return <Spinner />
 * 	if (!checkout || !cart) return <EmptyCheckout />
 *
 * 	return (
 * 		<form onSubmit={(event) => {
 * 			event.preventDefault()
 * 			void confirm(valuesFrom(event.currentTarget))
 * 		}}>
 * 			{error ? <p role="alert">{error.message}</p> : null}
 * 			<p>{cart.itemCount} items</p>
 * 			<button disabled={isPending} type="submit">Place order</button>
 * 		</form>
 * 	)
 * }
 * ```
 */
export function useCheckout(options?: CheckoutHookOptions): CheckoutApi {
	const { callbacks: providerCallbacks } = useWooCommerceContext()
	const { client } = useKizloContext()
	const queryClient = useCheckoutQueryClient()
	const hookCallbacks = useLatest<CheckoutCallbacks | undefined>(options)
	const [error, setError] = useState<CheckoutError | null>(null)

	const checkoutQuery = useQuery<Checkout, CheckoutError>({
		enabled: !isServer,
		// React Query reports a failure by rejection, so the envelope is unwrapped here rather than carried into the cache.
		queryFn: async () => {
			const result = await client.woocommerce.checkout.get()
			if (!result.success) throw result.error
			queryClient.setQueryData(cartQueryKey, result.data.cart)
			return result.data
		},
		queryKey: checkoutQueryKey,
	})

	const mutation = useMutation({
		// The client answers failures rather than throwing them, so the only way here is something outside the contract. It is
		// folded into the same envelope so a confirmation still never rejects.
		mutationFn: async (input: ConfirmCheckoutInput): Promise<ConfirmResult> => {
			try {
				return await client.woocommerce.checkout.confirm({ body: input })
			} catch (cause) {
				return { data: undefined, error: toKizloError(cause) as CheckoutError, success: false }
			}
		},
		mutationKey: checkoutMutationKey,
	})
	const mutateAsync = useLatest(mutation.mutateAsync)
	const isPending = useIsMutating({ mutationKey: checkoutMutationKey }) > 0

	const confirm = useCallback(
		async (input: ConfirmCheckoutInput) => {
			const hook = hookCallbacks.current
			const provider = providerCallbacks.current
			const payload = { input, type: "confirm_checkout" } as const
			const start: CheckoutStartEvent = { ...payload, status: "start" }

			notify(hook?.onStart, start)
			notify(provider.onStart, start)

			const result = await mutateAsync.current(input)

			if (!result.success) {
				setError(result.error)

				const failure: CheckoutErrorEvent = { ...payload, error: result.error, status: "error" }
				notify(hook?.onError, failure)
				notify(provider.onError, failure)
				notify(hook?.onSettled, failure)
				notify(provider.onSettled, failure)
				return null
			}

			const checkout = result.data
			queryClient.setQueryData(checkoutQueryKey, checkout)
			queryClient.setQueryData(cartQueryKey, checkout.cart)
			setError(null)

			const success: CheckoutSuccessEvent = { ...payload, checkout, status: "success" }
			notify(hook?.onSuccess, success)
			notify(provider.onSuccess, success)
			notify(hook?.onSettled, success)
			notify(provider.onSettled, success)
			return checkout
		},
		[hookCallbacks, mutateAsync, providerCallbacks, queryClient],
	)

	const queryError = checkoutQuery.error
	const refresh = useCallback(async () => {
		setError(null)
		await queryClient.refetchQueries({ queryKey: checkoutQueryKey })
	}, [queryClient])
	const reset = useCallback(() => setError(null), [])

	return {
		checkout: checkoutQuery.data ?? null,
		confirm,
		error: error ?? queryError,
		isLoading: checkoutQuery.isPending,
		isPending,
		refresh,
		reset,
	}
}
