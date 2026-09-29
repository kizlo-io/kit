"use client"

/**
 * React adapter for checkout: one query, one confirmation and no feature provider.
 *
 * The checkout snapshot is browser-session state. It runs on the app's query client, reads the browser Kizlo client from
 * `KizloProvider`, and seeds the cart's existing cache entry so checkout and every cart consumer see one cart.
 */

import { useKizloClient } from "@kizlo/kit/react"
import type { Checkout, ConfirmCheckoutInput } from "@kizlo/woocommerce"
import { isServer, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cartQueryKey } from "../cart"
import {
	type CheckoutCallbacks,
	type CheckoutError,
	type CheckoutErrorEvent,
	type CheckoutStartEvent,
	type CheckoutStoreClient,
	type CheckoutSuccessEvent,
	checkoutQueryKey,
} from "../checkout"
import { useWooCommerceConfig } from "./config"

/** The core checkout types, available beside the hook that returns them. */
export type {
	CheckoutActionPayload,
	CheckoutCallbacks,
	CheckoutError,
	CheckoutErrorEvent,
	CheckoutSettledEvent,
	CheckoutStartEvent,
	CheckoutStoreClient,
	CheckoutSuccessEvent,
} from "../checkout"

export type CheckoutHookOptions = CheckoutCallbacks & {
	/** A client override for a test or a second store. A storefront normally reads its client from `KizloProvider`. */
	client?: CheckoutStoreClient
}

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

function toCheckoutError(cause: unknown): CheckoutError {
	if (cause && typeof cause === "object") {
		const { code, data, message } = cause as { code?: unknown; data?: unknown; message?: unknown }
		return {
			code: typeof code === "string" ? code : "",
			...(data === undefined ? {} : { data }),
			message: typeof message === "string" ? message : "",
		}
	}

	return { code: "", message: typeof cause === "string" ? cause : "" }
}

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
	const { callbacks: providerCallbacks } = useWooCommerceConfig()
	const client = useKizloClient<CheckoutStoreClient>("woocommerce.checkout", options?.client)
	const queryClient = useCheckoutQueryClient()
	const hookCallbacks = useLatest<CheckoutCallbacks | undefined>(options)
	const [error, setError] = useState<CheckoutError | null>(null)

	const checkoutQuery = useQuery({
		enabled: !isServer,
		queryFn: async () => {
			const checkout = await client.woocommerce.checkout.get.call()
			queryClient.setQueryData(cartQueryKey, checkout.cart)
			return checkout
		},
		queryKey: checkoutQueryKey,
	})

	const mutation = useMutation({
		mutationFn: (input: ConfirmCheckoutInput) => client.woocommerce.checkout.confirm.call({ body: input }),
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

			try {
				const checkout = await mutateAsync.current(input)
				queryClient.setQueryData(checkoutQueryKey, checkout)
				queryClient.setQueryData(cartQueryKey, checkout.cart)
				setError(null)

				const success: CheckoutSuccessEvent = { ...payload, checkout, status: "success" }
				notify(hook?.onSuccess, success)
				notify(provider.onSuccess, success)
				notify(hook?.onSettled, success)
				notify(provider.onSettled, success)
				return checkout
			} catch (cause) {
				const failed = toCheckoutError(cause)
				setError(failed)

				const failure: CheckoutErrorEvent = { ...payload, error: failed, status: "error" }
				notify(hook?.onError, failure)
				notify(provider.onError, failure)
				notify(hook?.onSettled, failure)
				notify(provider.onSettled, failure)
				return null
			}
		},
		[hookCallbacks, mutateAsync, providerCallbacks, queryClient],
	)

	const queryError = useMemo(() => (checkoutQuery.error ? toCheckoutError(checkoutQuery.error) : null), [checkoutQuery.error])
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
