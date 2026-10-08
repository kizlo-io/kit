"use client"

import { useMutation } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { useKizloContext } from "kizlo/react"
import { useCallback, useState } from "react"
import { type CartActionPayload, cartQueryKey } from "../cart"
import { CheckoutLockedError } from "../checkout-locks"
import { formatStoreMoney } from "../money"
import type { Cart, CartError } from "../types"
import type { CartHookOptions } from "./cart"
import type { CheckoutRequest } from "./checkout-lock-cache"
import { useCheckoutLockStore, useCheckoutReadiness } from "./checkout-lock-store"
import { useWooCommerceContext } from "./context"
import { notify } from "./notify"
import { useCartActivity, useCartQuery } from "./session-queries"

type CartProcedures = ActiveKizloClient["woocommerce"]["cart"]

function cartRequest(procedures: CartProcedures, variables: CartActionPayload): Promise<Cart> {
	switch (variables.type) {
		case "add_to_cart":
			return procedures.items.add.call({ body: variables.input })
		case "update_cart_item":
			return procedures.items.update.call({ body: { quantity: variables.quantity }, params: { key: variables.key } })
		case "remove_from_cart":
			return procedures.items.remove.call({ params: { key: variables.key } })
		case "apply_coupon":
			return procedures.coupons.apply.call({ body: { code: variables.code } })
		case "remove_coupon":
			return procedures.coupons.remove.call({ params: { code: variables.code } })
		case "update_customer":
			return procedures.update.call({ body: variables.input })
		case "select_shipping_rate":
			return procedures.selectShippingRate.call({ body: { packageId: variables.packageId, rateId: variables.rateId } })
	}
}

export function useCartData(bootstrapped = true) {
	const { locale, queryClient } = useWooCommerceContext()
	const cartQuery = useCartQuery(bootstrapped)
	const { isMutating, isRepricing } = useCartActivity()

	const cart = cartQuery.data ?? null
	const format = useCallback((amount: number) => (cart ? formatStoreMoney(amount, cart.currencyFormat, locale) : ""), [cart, locale])

	const refresh = useCallback(async () => {
		await queryClient.refetchQueries({ queryKey: cartQueryKey })
	}, [queryClient])

	return { cart, format, isLoading: cartQuery.isPending, isMutating, isRepricing, queryError: cartQuery.error, refresh }
}

/**
 * One keyed action observer. Item/coupon errors stay local; address/shipping failures are shared per feature.
 * The cache controller owns checkout readiness across observers, while React Query runs the callback phases.
 *
 * Composes {@link useCartData} rather than sitting beside it, so a hook that only acts is still subscribed to the shared cart
 * query: an address form on a page of its own is what fetches the cart for it.
 */
export function useCartAction(scope: readonly string[], options: CartHookOptions | undefined, sharedError = false, bootstrapped = true) {
	const { client } = useKizloContext()
	const data = useCartData(bootstrapped)
	const binding = useCheckoutLockStore()
	useCheckoutReadiness(binding)
	const feature = binding.feature(scope)
	const [dismissed, setDismissed] = useState<number | null>(null)
	const [admissionError, setAdmissionError] = useState<CheckoutLockedError | null>(null)

	// Each hook owns one mutation, keyed to its scope: the caller already memoised `scope`, so the key is stable. The options
	// below are read from the last committed render, which is what a callback ref used to buy.
	const mutation = useMutation<Cart, CartError, CheckoutRequest<CartActionPayload>>({
		mutationFn: (operation) => {
			binding.sync()
			binding.assertCurrent(operation.token)
			return cartRequest(client.woocommerce.cart, operation.payload)
		},
		mutationKey: scope,
		// Pinned rather than inherited: query-core's own default is `this.options.retry ?? 0`, and `this.options` carries the app's
		// `defaultOptions.mutations`. A cart write is not idempotent, so a retry is a second line rather than a second attempt.
		retry: 0,
		onMutate: ({ payload: variables }) => {
			notify(() => options?.onStart?.({ ...variables, status: "start" }))
		},
		onSuccess: (cart, operation) => {
			binding.sync()
			const variables = operation.payload
			binding.publishCart(operation.token, cart)
			notify(() => options?.onSuccess?.({ ...variables, cart, status: "success" }))
		},
		onError: (error, operation) => {
			const variables = operation.payload
			notify(() => options?.onError?.({ ...variables, error, status: "error" }))
		},
		// A narrowing rather than a branch: query-core passes `(cart, null, …)` on success and `(undefined, error, …)` on
		// failure, never neither, so this avoids asserting `cart` is there.
		onSettled: (cart, error, operation) => {
			const variables = operation.payload
			if (error) notify(() => options?.onSettled?.({ ...variables, error, status: "error" }))
			else if (cart) notify(() => options?.onSettled?.({ ...variables, cart, status: "success" }))
		},
	})

	// Read from the mutation cache rather than from local state: two components showing the same line both see it saving.
	const isPending = binding.pending(scope)

	const { reset } = mutation
	const rejectAdmission = useCallback(
		(error: CheckoutLockedError, variables: CartActionPayload) => {
			setAdmissionError(error)
			notify(() => options?.onError?.({ ...variables, error, status: "error" }))
			notify(() => options?.onSettled?.({ ...variables, error, status: "error" }))
		},
		[options],
	)
	const begin = useCallback(
		(variables: CartActionPayload) => {
			binding.sync()
			setAdmissionError(null)
			return binding.admit(variables)
		},
		[binding],
	)
	const mutate = useCallback(
		(variables: CartActionPayload) => {
			try {
				binding.dispatch(scope, () => mutation.mutate(begin(variables)))
			} catch (error) {
				if (!(error instanceof CheckoutLockedError)) throw error
				rejectAdmission(error, variables)
			}
		},
		[begin, binding, scope, mutation.mutate, rejectAdmission],
	)
	const mutateAsync = useCallback(
		async (variables: CartActionPayload) => {
			let request: Promise<Cart>
			try {
				request = binding.dispatch(scope, () => mutation.mutateAsync(begin(variables)))
			} catch (error) {
				if (error instanceof CheckoutLockedError) rejectAdmission(error, variables)
				throw error
			}
			return request
		},
		[begin, binding, scope, mutation.mutateAsync, rejectAdmission],
	)

	// `reset` detaches the observer from the mutation it is watching, so resetting an action that is still in flight would leave
	// the refusal it is about to report with nowhere to land. A settled failure is the only one cleared.
	const clearSettled = useCallback(() => {
		if (!isPending) {
			setAdmissionError(null)
			const failure = binding.readiness.failure(feature)
			if (sharedError) setDismissed(failure?.sequence ?? null)
			else if (failure && binding.failureMatches(feature, mutation.variables)) binding.readiness.dismiss(feature, failure.identity)
			binding.sync()
			reset()
		}
	}, [binding, feature, isPending, mutation.variables, sharedError, reset])

	const failure = binding.readiness.failure(feature)
	const failedVariables = (
		failure?.identity as { state: { variables?: CheckoutRequest<CartActionPayload> | CartActionPayload } } | undefined
	)?.state.variables
	const failedPayload = failedVariables && "payload" in failedVariables ? failedVariables.payload : failedVariables

	return {
		...data,
		failedAddressInput: failedPayload?.type === "update_customer" ? failedPayload.input : null,
		error:
			admissionError ??
			(sharedError
				? binding.readiness.failure(feature)?.sequence === dismissed
					? null
					: ((binding.readiness.failure(feature)?.error as CartError) ?? null)
				: mutation.error),
		isPending,
		mutate,
		mutateAsync,
		reset: clearSettled,
		cancelFailures: useCallback(() => {
			binding.readiness.dismiss(feature)
			binding.sync()
		}, [binding, feature]),
		rejectAdmission,
	}
}
