"use client"

/**
 * React adapter for checkout: one query, one confirmation and no feature provider.
 *
 * The checkout snapshot is browser-session state. It runs on the app's query client from `WooCommerceProvider`, reads the
 * browser Kizlo client from `KizloProvider`, and seeds the cart's existing cache entry so checkout and every cart consumer see
 * one cart.
 */

import { useIsMutating, useMutation } from "@tanstack/react-query"
import { useKizloContext } from "kizlo/react"
import { useCallback } from "react"
import { cartQueryKey } from "../cart"
import { type CheckoutCallbacks, type CheckoutSuccessEvent, checkoutQueryKey, resolveCheckoutRedirect } from "../checkout"
import type { Checkout, CheckoutError, ConfirmCheckoutInput } from "../types"
import { useWooCommerceContext } from "./context"
import { notify } from "./notify"
import { useCheckoutQuery } from "./session-queries"

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
	/** Places the order. Returns nothing: the order and where to send the browser next arrive on the success event. */
	confirm: (input: ConfirmCheckoutInput) => void
	isLoading: boolean
	isPending: boolean
	refresh: () => Promise<void>
	/** Clears the last confirmation failure once it has settled. */
	reset: () => void
}

const checkoutMutationKey = [...checkoutQueryKey, "mutation"] as const

/** Module-level and pure, so both phases that report a success derive the same event from the same two inputs. */
function checkoutSuccessEvent(checkout: Checkout, input: ConfirmCheckoutInput): CheckoutSuccessEvent {
	return {
		checkout,
		input,
		redirectUrl: resolveCheckoutRedirect(checkout, input.successPath),
		status: "success",
		type: "confirm_checkout",
	}
}

/**
 * Loads and confirms the store checkout while keeping the shared cart cache in step.
 *
 * The hook owns no form state and performs no navigation. Render fields from `checkout`, use the cart hooks for shipping and
 * coupons, and send the browser to the `redirectUrl` the success event carries — `confirm` returns nothing to await, because
 * the redirect is derived on that event and was never on a return value. Its callbacks run in the four phases
 * `onStart` → `onSuccess` | `onError` → `onSettled`.
 *
 * Needs `KizloProvider` and `WooCommerceProvider` above it. It takes no client.
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
 * 		onSuccess: ({ checkout, redirectUrl }) => {
 * 			track("purchase", { orderId: checkout.orderId })
 * 			if (redirectUrl) window.location.assign(redirectUrl)
 * 		},
 * 	})
 *
 * 	if (isLoading) return <Spinner />
 * 	if (!checkout || !cart) return <EmptyCheckout />
 *
 * 	return (
 * 		<form onSubmit={(event) => {
 * 			event.preventDefault()
 * 			confirm(valuesFrom(event.currentTarget))
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
	const { client } = useKizloContext()
	const { queryClient } = useWooCommerceContext()

	const checkoutQuery = useCheckoutQuery()

	// One confirmation, run by React Query: the phases, the pending state and the last failure are all the mutation's own. The
	// options are read from the last committed render, which is what a callback ref used to buy.
	const mutation = useMutation<Checkout, CheckoutError, ConfirmCheckoutInput>({
		mutationFn: (input) => client.woocommerce.checkout.confirm.call({ body: input }),
		mutationKey: checkoutMutationKey,
		// Pinned rather than inherited: query-core's own default is `this.options.retry ?? 0`, and `this.options` carries the app's
		// `defaultOptions.mutations`. Placing an order twice is not a retry.
		retry: 0,
		onMutate: (input) => {
			notify(() => options?.onStart?.({ input, status: "start", type: "confirm_checkout" }))
		},
		onSuccess: (checkout, input) => {
			queryClient.setQueryData(checkoutQueryKey, checkout)
			queryClient.setQueryData(cartQueryKey, checkout.cart)
			notify(() => options?.onSuccess?.(checkoutSuccessEvent(checkout, input)))
		},
		onError: (error, input) => {
			notify(() => options?.onError?.({ error, input, status: "error", type: "confirm_checkout" }))
		},
		// A narrowing rather than a branch: query-core passes `(checkout, null, …)` on success and `(undefined, error, …)` on
		// failure, never neither.
		onSettled: (checkout, error, input) => {
			if (error) notify(() => options?.onSettled?.({ error, input, status: "error", type: "confirm_checkout" }))
			else if (checkout) notify(() => options?.onSettled?.(checkoutSuccessEvent(checkout, input)))
		},
	})

	// Read from the mutation cache, so every component that shows the order button sees the same confirmation in flight.
	const isPending = useIsMutating({ mutationKey: checkoutMutationKey }) > 0
	const { reset } = mutation

	// `reset` detaches the observer from the mutation it is watching, so resetting a confirmation that is still in flight would
	// leave the refusal it is about to report with nowhere to land. A settled failure is the only one cleared.
	const clearSettled = useCallback(() => {
		if (!isPending) reset()
	}, [isPending, reset])

	const refresh = useCallback(async () => {
		clearSettled()
		await queryClient.refetchQueries({ queryKey: checkoutQueryKey })
	}, [clearSettled, queryClient])

	return {
		checkout: checkoutQuery.data ?? null,
		confirm: mutation.mutate,
		error: mutation.error ?? checkoutQuery.error,
		isLoading: checkoutQuery.isPending,
		isPending,
		refresh,
		reset: clearSettled,
	}
}
