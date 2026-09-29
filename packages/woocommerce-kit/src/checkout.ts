/**
 * Checkout bones: the cache identity and the confirmation event vocabulary.
 *
 * No React, query library, form state or navigation. Checkout is browser-session state, so the React adapter owns the
 * request while this module keeps the integration contract and events available to every framework.
 */

import type { Checkout, ConfirmCheckoutInput } from "@kizlo/woocommerce"
import type { CartErrorEvent, CartSettledEvent, CartStartEvent, CartSuccessEvent } from "./cart"

/** The one checkout snapshot shared by every checkout consumer in the app's query client. */
export const checkoutQueryKey = ["kizlo", "woocommerce", "checkout"] as const

/** A checkout failure consumers can render or map onto their own form fields. */
export type CheckoutError = {
	code: string
	/** Procedure-specific details, including validation fields when the store supplies them. */
	data?: unknown
	message: string
}

/** Everything a confirmation reports about itself in every callback phase. */
export type CheckoutActionPayload = { type: "confirm_checkout"; input: ConfirmCheckoutInput }

/** Checkout confirmation is about to leave. */
export type CheckoutStartEvent = CheckoutActionPayload & { status: "start" }

/** Checkout confirmation succeeded. */
export type CheckoutSuccessEvent = CheckoutActionPayload & { status: "success"; checkout: Checkout }

/** Checkout confirmation failed. */
export type CheckoutErrorEvent = CheckoutActionPayload & { status: "error"; error: CheckoutError }

/** Either confirmation outcome, narrowed on `status`. */
export type CheckoutSettledEvent = CheckoutSuccessEvent | CheckoutErrorEvent

/** Listeners for one checkout confirmation. */
export type CheckoutCallbacks = {
	/** Synchronous, before the request leaves. A notification, not a veto. */
	onStart?: (event: CheckoutStartEvent) => void
	onSuccess?: (event: CheckoutSuccessEvent) => void
	onError?: (event: CheckoutErrorEvent) => void
	onSettled?: (event: CheckoutSettledEvent) => void
}

/** Every action the kit-level provider can hear, narrowed by `type` and then `status`. */
export type WooCommerceStartEvent = CartStartEvent | CheckoutStartEvent
export type WooCommerceSuccessEvent = CartSuccessEvent | CheckoutSuccessEvent
export type WooCommerceErrorEvent = CartErrorEvent | CheckoutErrorEvent
export type WooCommerceSettledEvent = CartSettledEvent | CheckoutSettledEvent

/**
 * Kit-level listeners for cart and checkout actions.
 *
 * Feature hooks retain their narrower callback types; this union belongs to `WooCommerceProvider`, where an app wires a
 * cross-cutting concern such as analytics once and narrows each event by `type`.
 */
export type WooCommerceCallbacks = {
	onStart?: (event: WooCommerceStartEvent) => void
	onSuccess?: (event: WooCommerceSuccessEvent) => void
	onError?: (event: WooCommerceErrorEvent) => void
	onSettled?: (event: WooCommerceSettledEvent) => void
}
