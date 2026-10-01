/**
 * Checkout bones: the cache identity and the confirmation event vocabulary.
 *
 * No React, query library, form state or navigation. Checkout is browser-session state, so the React adapter owns the
 * request while this module keeps the integration contract and events available to every framework. The return route the
 * store sends the shopper back to is a page, not a session, so everything it needs is a pure derivation here.
 */

import type { Checkout, CheckoutError, ConfirmCheckoutInput, Order } from "./types"

/** The one checkout snapshot shared by every checkout consumer in the app's query client. */
export const checkoutQueryKey = ["kizlo", "woocommerce", "checkout"] as const

/** Everything a confirmation reports about itself in every callback phase. */
export type CheckoutActionPayload = { type: "confirm_checkout"; input: ConfirmCheckoutInput }

/** Checkout confirmation is about to leave. */
export type CheckoutStartEvent = CheckoutActionPayload & { status: "start" }

/** Checkout confirmation succeeded. */
export type CheckoutSuccessEvent = CheckoutActionPayload & {
	status: "success"
	checkout: Checkout
	/** Where the store wants the browser next, if anywhere. */
	redirectUrl: string | null
}

/** Checkout confirmation failed. */
export type CheckoutErrorEvent = CheckoutActionPayload & { status: "error"; error: CheckoutError }

/** Either confirmation outcome, narrowed on `status`. */
export type CheckoutSettledEvent = CheckoutSuccessEvent | CheckoutErrorEvent

/**
 * Where to send the browser after a confirmation, or `null` when the store named nowhere.
 *
 * The gateway's own `redirectUrl` wins. When it is empty — which WooCommerce's client treats as "stay here", stranding the
 * shopper on the form with a placed order behind them — the store's own return contract is rebuilt from the `successPath`
 * the app passed to `confirm`, in the format the Kizlo plugin redirects to. Null when no `successPath` was given: a
 * destination nobody configured is worse than none.
 */
export function resolveCheckoutRedirect(checkout: Checkout, successPath?: string): string | null {
	const gatewayUrl = checkout.paymentResult?.redirectUrl
	if (gatewayUrl) return gatewayUrl

	const { orderId, orderKey } = checkout
	if (!successPath || orderId === null || orderKey === null) return null

	// Merged the way the plugin's own `add_query_arg` merges them. A `successPath` only has to start with a single `/`, so it
	// may already carry a query or a fragment, and appending `?…` to either would strand the shopper on an unreadable URL.
	const hashAt = successPath.indexOf("#")
	const hash = hashAt === -1 ? "" : successPath.slice(hashAt)
	const pathAndQuery = hashAt === -1 ? successPath : successPath.slice(0, hashAt)
	const queryAt = pathAndQuery.indexOf("?")
	const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt)

	const search = new URLSearchParams(queryAt === -1 ? "" : pathAndQuery.slice(queryAt + 1))
	search.set("order_id", String(orderId))
	search.set("key", orderKey)
	return `${path}?${search}${hash}`
}

/** Listeners for one checkout confirmation. */
export type CheckoutCallbacks = {
	/** Synchronous, before the request leaves. A notification, not a veto. */
	onStart?: (event: CheckoutStartEvent) => void
	onSuccess?: (event: CheckoutSuccessEvent) => void
	onError?: (event: CheckoutErrorEvent) => void
	onSettled?: (event: CheckoutSettledEvent) => void
}

/** The order the store handed back on the return route. */
export type CheckoutReturn = { key: string; orderId: number }

/**
 * Reads the order out of the return route's query string, or `null` when it did not carry one.
 *
 * Takes the raw `location.search` or a `URLSearchParams` a router already parsed, and accepts a leading `?`. A malformed
 * `order_id` is rejected here rather than passed on to become a failed request: only plain digits are an order, above zero
 * and inside the range that survives being a JavaScript number.
 */
export function parseCheckoutReturn(search: string | URLSearchParams): CheckoutReturn | null {
	const params = typeof search === "string" ? new URLSearchParams(search) : search
	const key = params.get("key")
	const rawOrderId = params.get("order_id")
	if (!key || !rawOrderId || !/^\d+$/.test(rawOrderId)) return null

	const orderId = Number(rawOrderId)
	return orderId > 0 && Number.isSafeInteger(orderId) ? { key, orderId } : null
}

/** What the shopper should be told on the return route. */
export type OrderOutcome = { orderId: number; state: "awaiting_payment" | "failed" | "paid" }

/**
 * Derives the one thing a return route has to decide: has this order been paid for, is it still owed, or did it fail.
 *
 * `isPaid` is the store's own answer, filterable through `woocommerce_order_is_paid_statuses` and
 * `woocommerce_order_is_paid`, so matching a hardcoded status set here would be right on a stock store and silently wrong
 * on a filtered one. Only `failed` is read as a raw status, because nothing else reports a decline. Anything else — a
 * gateway abandoned mid-flow, a status a plugin invented — is money still owed rather than a finished order.
 */
export function orderOutcome(order: Order): OrderOutcome {
	if (order.isPaid) return { orderId: order.id, state: "paid" }
	if (order.status === "failed") return { orderId: order.id, state: "failed" }
	return { orderId: order.id, state: "awaiting_payment" }
}
