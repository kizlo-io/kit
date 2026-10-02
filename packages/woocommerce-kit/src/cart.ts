/**
 * Cart bones: the cache identity, the event vocabulary and the derivations that are worth testing.
 *
 * No React and no query library. The cart has no URL grammar and no response derivation, so unlike the collection it gets no
 * `contract`/`request`/`model` triple — what is framework-agnostic here is the identity of the cache entry every consumer
 * shares, the vocabulary its actions report themselves in, whether its shipping has been chosen, and the arithmetic behind a
 * quantity control.
 */

import type { AddCartItemInput, Cart, CartError, CartItem, CartShippingAddress, UpdateCartInput } from "./types"

/**
 * The four fields WooCommerce uses to decide whether an address needs new shipping rates or tax. Postcode spacing and case
 * are insignificant; personal details and street are deliberately excluded. Missing fields compare as empty strings.
 *
 * @example
 * ```ts
 * shippingQuoteSignature({ country: "GB", postcode: "sw1a 1aa" })
 * // The same signature as { country: "GB", postcode: "SW1A1AA" }.
 * ```
 */
export function shippingQuoteSignature(address: Partial<CartShippingAddress>): string {
	return JSON.stringify([
		(address.country ?? "").trim(),
		(address.state ?? "").trim(),
		(address.city ?? "").trim(),
		(address.postcode ?? "").replace(/\s+/g, "").toUpperCase(),
	])
}

/**
 * Whether either supplied address changes the cart's pricing fields and has a country. Partial input leaves omitted fields
 * unchanged. Country-specific requirements and validation belong to the form, so a country without postcodes still qualifies.
 *
 * @example
 * ```ts
 * defaultShouldUpdateAddress({ shippingAddress: { postcode: "560001" } }, cart)
 * // Uses the country already on the cart; true only when the pricing fields differ.
 * ```
 */
export function defaultShouldUpdateAddress(input: UpdateCartInput, cart: Cart | null): boolean {
	return (["shippingAddress", "billingAddress"] as const).some((key) => {
		if (!input[key]) return false
		const current = cart?.[key] ?? {}
		const next = { ...current, ...input[key] }
		return !!next.country?.trim() && shippingQuoteSignature(next) !== shippingQuoteSignature(current)
	})
}

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
 * Pass them to the hook that performs the action: `useCartAddress`, `useCartShippingRates`, `useCartItem` and `useCartCoupon`
 * each take their own, and a concern that spans the storefront wires the same listener on each hook it cares about. `useCart`
 * takes none, because it performs no action.
 *
 * @example
 * ```tsx
 * const { addItem, remove } = useCartItem(itemKey, {
 * 	onStart: (event) => {
 * 		if (event.type === "add_to_cart") openCartDrawer()
 * 	},
 * 	onSuccess: (event) => {
 * 		if (event.type === "remove_from_cart") track("remove_from_cart", { item: event.item.name })
 * 	},
 * 	onError: (event) => report(event.type, event.error.code),
 * })
 * ```
 */
export type CartCallbacks = {
	/** Synchronous, before the request leaves. A notification, not a veto — it cannot cancel the action. */
	onStart?: (event: CartStartEvent) => void
	onSuccess?: (event: CartSuccessEvent) => void
	onError?: (event: CartErrorEvent) => void
	onSettled?: (event: CartSettledEvent) => void
}

/**
 * Whether every package that needs shipping has a rate chosen.
 *
 * The question `cart.hasCalculatedShipping` does not answer: that one says the store has costed shipping, not that the shopper
 * picked one of the quotes. Without this, every storefront re-derives it to decide whether its shipping step is done.
 *
 * `false` for a cart that has not loaded, so a consumer needs no null guard, and `true` for a cart that needs no shipping at all.
 * Otherwise every package must carry exactly one rate marked `selected` — which also means at least one rate. Deliberately
 * stricter than WooCommerce's own storefront, which treats a package with no rates as satisfied: a package nothing can be
 * shipped by is not a chosen rate. A cart that needs shipping and reports no packages is `false` for the same reason.
 *
 * `checkout.confirm` rejects a missing rate anyway (`CHECKOUT_SHIPPING_OPTION_INVALID`), so this is for showing the shopper
 * which step is incomplete rather than for guarding the order.
 *
 * Inside React, `useCartShippingRates().hasSelectedShippingRates` is this function already applied to the current cart.
 *
 * @example
 * ```ts
 * hasSelectedShippingRates(null) // false, nothing fetched yet
 * hasSelectedShippingRates(digitalCart) // true, needsShipping is false
 * ```
 */
export function hasSelectedShippingRates(cart: Cart | null): boolean {
	if (!cart) return false
	if (!cart.needsShipping) return true

	return (
		cart.shippingPackages.length > 0 &&
		cart.shippingPackages.every((shippingPackage) => shippingPackage.rates.filter((rate) => rate.selected).length === 1)
	)
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
 * Inside React, `useCartItem(key).quantity.limits` is this function already applied to that line.
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

/**
 * The quantity range for a control with no line behind it: a product page choosing a quantity before anything is in the cart.
 *
 * The store says nothing about a product that is not a line yet, so these defaults stand in for it — 99 is WooCommerce's own
 * fallback ceiling — and `editable` is `true`, because a draft is always editable. Pass whatever the product itself constrains.
 *
 * Inside React, `useCartItem({ limits }).quantity.limits` is this function already applied.
 *
 * @example
 * ```ts
 * draftQuantityLimits()
 * // { editable: true, maximum: 99, minimum: 1, step: 1 }
 *
 * draftQuantityLimits({ maximum: 5 })
 * // { editable: true, maximum: 5, minimum: 1, step: 1 }
 * ```
 */
export function draftQuantityLimits({
	editable = true,
	maximum = 99,
	minimum = 1,
	step = 1,
}: Partial<CartItemLimits> = {}): CartItemLimits {
	return { editable, maximum, minimum, step }
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
 * `useCartItem`'s quantity field calls this on blur and Enter; call it directly when building a control for another framework.
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

/** One press of a quantity control's `−` or `+`. */
export type StepQuantityOptions = {
	direction: "decrement" | "increment"
	limits: CartItemLimits
	/** What the control is showing, which is the pending edit rather than the store's quantity while one is owed. */
	value: number
}

/**
 * Moves a quantity one step and stops at the edge of its range, which is the arithmetic behind a control's `−` and `+`.
 *
 * A step that would overshoot lands exactly on the boundary instead of past it, so a shopper holding `+` ends on the maximum. The
 * boundary wins over the step: a maximum the store did not place on a multiple is still what it accepts, so the result is not
 * necessarily one. Pass it through `resolveQuantity` — which is what `useCartItem` does — for a quantity aligned to both.
 *
 * A step of zero or less cannot move anything, so it falls back to 1 rather than leaving the button dead; `resolveQuantity`
 * disregards such a step the same way.
 *
 * @example
 * ```ts
 * const limits = { editable: true, maximum: 10, minimum: 1, step: 3 }
 *
 * stepQuantity({ direction: "increment", limits, value: 4 }) // 7
 * stepQuantity({ direction: "increment", limits, value: 9 }) // 10, clamped
 * stepQuantity({ direction: "decrement", limits, value: 2 }) // 1, clamped
 * ```
 */
export function stepQuantity({ direction, limits, value }: StepQuantityOptions): number {
	const step = limits.step > 0 ? limits.step : 1

	return direction === "increment" ? Math.min(limits.maximum, value + step) : Math.max(limits.minimum, value - step)
}
