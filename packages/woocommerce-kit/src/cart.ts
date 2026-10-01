/**
 * Cart bones: the cache identity, the event vocabulary and the two derivations that are worth testing.
 *
 * No React and no query library. The cart has no URL grammar and no response derivation, so unlike the collection it gets no
 * `contract`/`request`/`model` triple — what is framework-agnostic here is the identity of the cache entry every consumer
 * shares, the vocabulary its actions report themselves in, and the arithmetic behind a quantity control.
 */

import type { AddCartItemInput, Cart, CartError, CartItem, UpdateCartInput } from "./types"

/**
 * The one cache entry the whole cart shares. Exported because an app that obtains a cart by another route — a checkout
 * snapshot does exactly this — has to be able to seed the same entry instead of racing a second fetch.
 *
 * @example Seeding the cart from a checkout response, so the badge does not refetch
 * ```ts
 * import { cartQueryKey } from "@kizlo/woocommerce-kit"
 *
 * const snapshot = await client.woocommerce.checkout.get.call()
 * queryClient.setQueryData(cartQueryKey, snapshot.cart)
 * ```
 */
export const cartQueryKey = ["kizlo", "woocommerce", "cart"] as const

/** How long a fetched cart stays fresh. Long enough to survive a navigation, short enough that a second tab is noticed. */
export const cartStaleTime = 30_000

/** Everything an action reports about itself, declared once so every phase of that action carries the same fields. */
export type CartActionPayload =
	| { type: "add_to_cart"; input: AddCartItemInput }
	| { type: "update_cart_item"; key: string; quantity: number; previousQuantity: number }
	| { type: "remove_from_cart"; key: string; item: CartItem }
	| { type: "apply_coupon"; code: string }
	| { type: "remove_coupon"; code: string }
	| { type: "update_customer"; input: UpdateCartInput }
	| { type: "select_shipping_rate"; rateId: string; packageId?: string | number | null }

/** The action is about to leave. Nothing has changed in the store yet. */
export type CartStartEvent = CartActionPayload & { status: "start" }

/** The action succeeded, and `cart` is the store's new state. */
export type CartSuccessEvent = CartActionPayload & { status: "success"; cart: Cart }

/** The action failed and the cart is unchanged. */
export type CartErrorEvent = CartActionPayload & { status: "error"; error: CartError }

/** Either outcome, narrowed on `status`. */
export type CartSettledEvent = CartSuccessEvent | CartErrorEvent

/**
 * Listeners for one cart action, in the order `onStart` → request → `onSuccess` | `onError` → `onSettled`.
 *
 * Every event carries the action's own payload rather than only the resulting cart, which is what makes them usable: an
 * `add_to_cart` reports what was added, and `remove_from_cart` carries the item that is already gone from `cart` by the time
 * the listener runs. The item tokens match GA4's vocabulary, since analytics is the main reason to want these.
 *
 * Pass them to `WooCommerceProvider` to hear every action in the tree, or to a hook to hear only its own. Both fire, the hook's
 * first.
 *
 * @example
 * ```tsx
 * <WooCommerceProvider
 * 	onStart={(event) => {
 * 		if (event.type === "add_to_cart") openCartDrawer()
 * 	}}
 * 	onSuccess={(event) => {
 * 		if (event.type === "remove_from_cart") track("remove_from_cart", { item: event.item.name })
 * 	}}
 * 	onError={(event) => report(event.type, event.error.code)}
 * >
 * ```
 */
export type CartCallbacks = {
	/** Synchronous, before the request leaves. A notification, not a veto — it cannot cancel the action. */
	onStart?: (event: CartStartEvent) => void
	onSuccess?: (event: CartSuccessEvent) => void
	onError?: (event: CartErrorEvent) => void
	onSettled?: (event: CartSettledEvent) => void
}

/** What a quantity control may offer for one line. */
export type CartItemLimits = {
	editable: boolean
	maximum: number
	minimum: number
	step: number
}

/**
 * The quantity range for one line.
 *
 * A sold-individually line is the interesting case: the store reports a maximum as usual, but the line cannot grow past what
 * is already in the cart, so its maximum collapses to the current quantity and the increment stops being offered.
 *
 * Inside React, `useCartItem(key).limits` is this function already applied to that line.
 *
 * @example
 * ```ts
 * cartItemLimits(item)
 * // { editable: true, maximum: 12, minimum: 1, step: 1 }
 * ```
 */
export function cartItemLimits(item: CartItem): CartItemLimits {
	const { editable, maximum, minimum, multipleOf } = item.quantityLimits

	return {
		editable,
		maximum: item.isSoldIndividually ? item.quantity : maximum,
		minimum,
		step: multipleOf,
	}
}

/** A typed quantity and the range it has to land in. */
export type ResolveQuantityOptions = {
	/** What the shopper typed. */
	input: string
	maximum: number
	minimum: number
	/** The store's `multipleOf`. Ignored when it is not positive, so a bad value cannot divide by zero. */
	step: number
	/** The quantity currently in the cart, used when the input says nothing usable. */
	value: number
}

/**
 * Turns what a shopper typed into a quantity the store will accept: rounded to the nearest step, clamped into range, and
 * falling back to the current quantity when the field holds nothing numeric. Pure, so the control's behaviour is testable
 * without a DOM.
 *
 * `useQuantityInput` calls this on blur and Enter; call it directly when building a control for another framework.
 *
 * @example
 * ```ts
 * const limits = { maximum: 10, minimum: 2, step: 2 }
 *
 * resolveQuantity({ ...limits, input: "7", value: 4 }) // 8, rounded to the step
 * resolveQuantity({ ...limits, input: "99", value: 4 }) // 10, clamped
 * resolveQuantity({ ...limits, input: "", value: 4 }) // 4, nothing typed
 * ```
 */
export function resolveQuantity({ input, maximum, minimum, step, value }: ResolveQuantityOptions): number {
	const parsed = Number(input)
	if (input.trim() === "" || !Number.isFinite(parsed)) return value

	const stepped = step > 0 ? Math.round(parsed / step) * step : parsed
	return Math.min(maximum, Math.max(minimum, stepped))
}
