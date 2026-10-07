"use client"

/**
 * React adapter for checkout: one query, one confirmation and no feature provider.
 *
 * The checkout snapshot is browser-session state. It runs on the app's query client from `WooCommerceProvider`, reads the
 * browser Kizlo client from `KizloProvider`, and seeds the cart's existing cache entry so checkout and every cart consumer see
 * one cart.
 */

import { useMutation } from "@tanstack/react-query"
import { useKizloContext } from "kizlo/react"
import { useCallback, useLayoutEffect } from "react"
import { cartQueryKey } from "../cart"
import { type CheckoutCallbacks, type CheckoutSuccessEvent, checkoutQueryKey, resolveCheckoutRedirect } from "../checkout"
import { checkoutSession } from "../checkout-errors"
import type { Checkout, CheckoutError, ConfirmCheckoutInput } from "../types"
import { useCheckoutErrorState, useCheckoutErrorStore } from "./checkout-error-store"
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
	/** Places the order and returns the acknowledged checkout; rejects with the original SDK error. */
	confirmAsync: (input: ConfirmCheckoutInput) => Promise<Checkout>
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
 * coupons, and send the browser to the `redirectUrl` the success event carries. `confirm` returns immediately;
 * `confirmAsync` awaits the same mutation and returns the checkout. Its callbacks run in the four phases
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
	const errors = useCheckoutErrorStore()
	const errorState = useCheckoutErrorState(errors)
	const session = checkoutSession(checkoutQuery.data)
	useLayoutEffect(() => errors.syncSession(session), [errors, session])

	// React Query runs the confirmation and callback phases; the store shares its submission lifecycle across observers.
	const mutation = useMutation<Checkout, CheckoutError, ConfirmCheckoutInput, number>({
		mutationFn: (input) => client.woocommerce.checkout.confirm.call({ body: input }),
		mutationKey: checkoutMutationKey,
		// Pinned rather than inherited: query-core's own default is `this.options.retry ?? 0`, and `this.options` carries the app's
		// `defaultOptions.mutations`. Placing an order twice is not a retry.
		retry: 0,
		onMutate: (input) => {
			const attempt = errors.start(checkoutSession(queryClient.getQueryData<Checkout>(checkoutQueryKey)))
			notify(() => options?.onStart?.({ input, status: "start", type: "confirm_checkout" }))
			return attempt
		},
		onSuccess: (checkout, input, attempt) => {
			// Cache sessions can change while every checkout observer is unmounted.
			errors.syncSession(checkoutSession(queryClient.getQueryData<Checkout>(checkoutQueryKey)))
			if (attempt !== undefined && errors.isCurrent(attempt)) {
				errors.succeed(attempt, checkoutSession(checkout))
				queryClient.setQueryData(checkoutQueryKey, checkout)
				queryClient.setQueryData(cartQueryKey, checkout.cart)
			}
			notify(() => options?.onSuccess?.(checkoutSuccessEvent(checkout, input)))
		},
		onError: (error, input, attempt) => {
			errors.syncSession(checkoutSession(queryClient.getQueryData<Checkout>(checkoutQueryKey)))
			if (attempt !== undefined) errors.fail(attempt, error)
			notify(() => options?.onError?.({ error, input, status: "error", type: "confirm_checkout" }))
		},
		// A narrowing rather than a branch: query-core passes `(checkout, null, …)` on success and `(undefined, error, …)` on
		// failure, never neither.
		onSettled: (checkout, error, input, attempt) => {
			if (attempt !== undefined) errors.settle(attempt)
			if (error) notify(() => options?.onSettled?.({ error, input, status: "error", type: "confirm_checkout" }))
			else if (checkout) notify(() => options?.onSettled?.(checkoutSuccessEvent(checkout, input)))
		},
	})

	// Every observer of this checkout/client sees the same confirmations in flight.
	const isPending = errorState.pending > 0
	const { reset } = mutation

	// `reset` detaches the observer from the mutation it is watching, so resetting a confirmation that is still in flight would
	// leave the refusal it is about to report with nowhere to land. A settled failure is the only one cleared.
	const clearSettled = useCallback(() => {
		if (errors.state.get().pending === 0) {
			errors.reset()
			reset()
		}
	}, [errors, reset])

	const refresh = useCallback(async () => {
		clearSettled()
		await queryClient.refetchQueries({ queryKey: checkoutQueryKey })
	}, [clearSettled, queryClient])

	return {
		checkout: checkoutQuery.data ?? null,
		confirm: mutation.mutate,
		confirmAsync: mutation.mutateAsync,
		error: errorState.error ?? checkoutQuery.error,
		isLoading: checkoutQuery.isPending,
		isPending,
		refresh,
		reset: clearSettled,
	}
}
