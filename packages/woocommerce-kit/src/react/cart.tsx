"use client"

/**
 * React adapter for the cart: five hooks, one of which carries a whole quantity control. No provider of its own.
 *
 * Its own entry point rather than an addition to `./client`, because the cart needs a query library and the collection needs a
 * URL-state library; sharing one chunk would make a collection-only consumer resolve a dependency it never installed.
 *
 * The client comes from `KizloProvider`, and the configuration and the app's `QueryClient` from `WooCommerceProvider` — so a
 * consumer mounts nothing per feature. React Query is an implementation detail: no hook returns one of its
 * result objects, no consumer imports it, and the kit never creates a client or sets a global default. What it does use is the
 * shared mutation cache, which is how one saving line is visible to every component that shows that line without a provider
 * holding the state.
 *
 * Renders nothing. Every class name, icon, label and route stays in the consumer.
 */

import { type ChangeEvent, type FocusEvent, type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { useDebouncedCallback } from "use-debounce"
import {
	type CartCallbacks,
	type CartItemLimits,
	cartItemLimits,
	draftQuantityLimits,
	hasSelectedShippingRates,
	resolveQuantity,
	stepQuantity,
} from "../cart"
import { CheckoutLockedError } from "../checkout-locks"
import { quantityQueueKey } from "../session-keys"
import type { AddCartItemInput, Cart, CartAddressInput, CartAddressSnapshotInput, CartError } from "../types"
import { useCartAction, useCartData } from "./cart-action"
import { useCartAddressTransport } from "./cart-address"
import { useCheckoutLockStore } from "./checkout-lock-store"
import { cartMutationKey } from "./session-queries"

/**
 * The core's cart types, re-exported so a component reads its hook and the types it returns from one specifier. Type-only, so
 * nothing reaches the bundle.
 */
export type {
	CartActionPayload,
	CartCallbacks,
	CartErrorEvent,
	CartItemLimits,
	CartSettledEvent,
	CartStartEvent,
	CartSuccessEvent,
} from "../cart"
export type { CartAddressInput, CartAddressSnapshotInput, CartError } from "../types"

export type CartHookOptions = CartCallbacks

export type CartAddressHookOptions = CartHookOptions & {
	/** How long `onAddressChange` waits after typing pauses. Defaults to 1500ms. */
	addressDebounceMs?: number
	/** Replaces the default pricing-field check. Returning false cancels any scheduled push. The form owns validation. */
	shouldUpdateAddress?: (input: CartAddressSnapshotInput, cart: Cart | null) => boolean
}

/** Stable empties, so a consumer reading `items` on an unfetched cart does not see a new array every render. */
const noItems: Cart["items"] = []
const noCoupons: Cart["coupons"] = []
const noShippingPackages: Cart["shippingPackages"] = []

function useLatest<T>(value: T) {
	const ref = useRef(value)
	useEffect(() => {
		ref.current = value
	}, [value])
	return ref
}

/** Legacy quantity saves report failures on the hook instead of rejecting. */
const noop = () => {}

export type CartApi = {
	/** The store's payload, so totals, addresses and shipping are read from it directly rather than mirrored here. */
	cart: Cart | null
	/**
	 * The cart failed to load, and nothing else. An action's own failure is on the hook that performs it:
	 * {@link useCartAddress}, {@link useCartShippingRates}, {@link useCartItem} or {@link useCartCoupon}.
	 *
	 * Distinct again from `cart.errors`, which is the store's own list of problems *with* the cart — a line that went out of
	 * stock, a coupon that stopped applying — read straight off `cart`.
	 */
	error: CartError | null
	/** This cart's currency and the configured locale, already applied. Empty while there is no cart. */
	format: (amount: number) => string
	isLoading: boolean
	/** Any cart action anywhere in the tree is in flight — what a consumer disables a whole page on. */
	isMutating: boolean
	/** Address edits are queued or an address save is running. Shared across components, including the debounce window. */
	isRepricing: boolean
	itemCount: number
	items: Cart["items"]
	/** Refetches the cart, which is how a consumer retries after `error`. */
	refresh: () => Promise<void>
}

/**
 * The cart as a whole, read-only: the store's payload, what it costs, and whether anything is being saved.
 *
 * It performs no action, so it takes no callbacks. Each action lives on the hook for its own subject — the addresses on
 * {@link useCartAddress}, the shipping choice on {@link useCartShippingRates}, a line on {@link useCartItem}, coupons on
 * {@link useCartCoupon} — and each carries its own `isPending` and `error`, so saving an address does not grey the rate list.
 *
 * `isMutating` stays here because "anything, anywhere" is a cart-wide question, and `error` is unambiguously the fetch failing.
 *
 * Needs `KizloProvider`, `WooCommerceProvider` and the app's `QueryClientProvider` above it. It takes no client.
 *
 * @example Summary totals, and the store's own complaints about the cart
 * ```tsx
 * "use client"
 * import { useCart } from "@kizlo/woocommerce-kit/react/cart"
 *
 * export function CartSummary() {
 * 	const { cart, error, format, isLoading, isMutating, refresh } = useCart()
 *
 * 	if (isLoading) return <Spinner />
 * 	if (error) return <button onClick={() => void refresh()} type="button">Try again</button>
 * 	if (!cart) return <EmptyCart />
 *
 * 	return (
 * 		<section aria-busy={isMutating}>
 * 			<p>{cart.itemCount} items · {format(cart.totals.total)}</p>
 * 			{cart.errors.map((problem) => (
 * 				<p key={problem.code} role="alert">{problem.message}</p>
 * 			))}
 * 		</section>
 * 	)
 * }
 * ```
 */
export function useCart(): CartApi {
	const { cart, format, isLoading, isMutating, isRepricing, queryError, refresh } = useCartData()

	return {
		cart,
		error: queryError,
		format,
		isLoading,
		isMutating,
		isRepricing,
		itemCount: cart?.itemCount ?? 0,
		items: cart?.items ?? noItems,
		refresh,
	}
}

export type CartAddressApi = {
	/** Abandons queued edits and settled failed saves. Restore the form from the cart; dispatched requests still settle. */
	cancel: () => void
	/** The shared address feature's last completed failure. */
	error: CartError | null
	/** This hook's own save is in flight. A rate selection or a line saving elsewhere does not set it. */
	isPending: boolean
	/** Debounces the current form snapshot, retaining the latest values while an address save runs. */
	onAddressChange: (input: CartAddressSnapshotInput) => void
	/** Awaits the latest coalesced snapshot; skipped or cancelled queued edits resolve undefined. */
	onAddressChangeAsync: (input: CartAddressSnapshotInput) => Promise<Cart | undefined>
	/** Flush queued edits immediately; an in-flight save retains the queue. */
	flush: () => void
	/** Dismisses the displayed settled error. Use cancel() to abandon the failed draft. */
	reset: () => void
	/** Saves the customer's addresses. The email is a field inside `billingAddress` rather than a sibling of it. */
	update: (input: CartAddressInput) => void
	/** Saves the same address patch and returns the acknowledged cart; rejects on failure. */
	updateAsync: (input: CartAddressInput) => Promise<Cart>
}

/**
 * The customer's addresses, and saving them.
 *
 * Its own hook rather than a method on {@link useCart}, because an `isPending` shared with the shipping choice is what greys a
 * rate list while an email is being saved. WooCommerce's own cart store splits along the same line.
 *
 * `update` takes whatever subset of the addresses changed, so a postcode on its own is a valid save — which is also what makes
 * the store re-quote shipping. The action reports itself as `update_customer`, after the Store API route behind it.
 *
 * `onAddressChange` takes the whole current form snapshot for each address being edited, not a field patch. It waits 1500ms
 * after typing pauses, compares country, state, city and postcode with the cart, and retains the latest snapshot while another
 * address save runs. A correction back to the pre-request address is checked after that request settles, not discarded early.
 * Either shipping or billing can qualify; postcode whitespace and case are ignored. Pass `shouldUpdateAddress` for validation
 * or carrier-specific fields. Returning to the saved address clears a settled failure without another request.
 * Read `useCart().isRepricing` for progress and `useCheckout().isLocked` for readiness while keeping fields editable.
 *
 * @example Recalculate from the whole current shipping form, without disabling its fields
 * ```tsx
 * const { onAddressChange } = useCartAddress()
 * <ShippingAddressForm onValuesChange={(shippingAddress) => onAddressChange({ shippingAddress })} />
 * ```
 *
 * @example A postcode that re-quotes shipping, with only this form disabled while it saves
 * ```tsx
 * "use client"
 * import { useCartAddress } from "@kizlo/woocommerce-kit/react/cart"
 * import { useState } from "react"
 *
 * export function ShippingPostcode() {
 * 	const { error, isPending, update } = useCartAddress()
 * 	const [postcode, setPostcode] = useState("")
 *
 * 	return (
 * 		<form
 * 			onSubmit={(event) => {
 * 				event.preventDefault()
 * 				update({ shippingAddress: { postcode } })
 * 			}}
 * 		>
 * 			<input onChange={(event) => setPostcode(event.target.value)} value={postcode} />
 * 			<button disabled={isPending} type="submit">{isPending ? "Saving…" : "Update"}</button>
 * 			{error ? <p role="alert">{error.message}</p> : null}
 * 		</form>
 * 	)
 * }
 * ```
 */
export function useCartAddress(options?: CartAddressHookOptions): CartAddressApi {
	return useCartAddressTransport(options)
}

export type CartShippingRatesApi = {
	/** Abandons a settled failed choice. The acknowledged selection and in-flight requests remain authoritative. */
	cancel: () => void
	/** The shared shipping feature's last completed failure. */
	error: CartError | null
	/** A rate is in effect for every package that needs shipping — the store's default counts. `false` while there is no cart. */
	hasSelectedShippingRates: boolean
	/** A selection is in flight. Not per package: the store re-quotes the whole cart, so one boolean matches every list. */
	isPending: boolean
	/** Dismisses the displayed settled error. Use cancel() to abandon the failed choice. */
	reset: () => void
	/** Chooses one of a package's rates. Pass the package's own `id`; omit it for a cart with a single package. */
	selectShippingRate: (rateId: string, packageId?: string | number | null) => void
	/** Chooses the same rate and returns the acknowledged cart; rejects on failure. */
	selectShippingRateAsync: (rateId: string, packageId?: string | number | null) => Promise<Cart>
	/** The store's packages, each with its rates and which of them is selected. Empty while there is no cart. */
	shippingPackages: Cart["shippingPackages"]
}

/**
 * The shipping packages the store quoted, and choosing a rate for them.
 *
 * `hasSelectedShippingRates` answers what `cart.hasCalculatedShipping` does not: that one says shipping has been costed, this
 * one says a rate is in effect for every package. Not that the shopper chose it — the store marks a default rate `selected` as
 * soon as it can quote, so a completed-shipping-step indicator gated on it lights up before any interaction. It is
 * {@link hasSelectedShippingRates} applied to the current cart, so the same answer is
 * available outside React.
 *
 * `isPending` is deliberately not per package — the store re-quotes the whole cart from one selection, so one boolean covers
 * every list at once. It also says nothing about an address being saved, which is {@link useCartAddress}.
 *
 * @example A rate list that stays interactive while an address is saving
 * ```tsx
 * "use client"
 * import { useCartShippingRates } from "@kizlo/woocommerce-kit/react/cart"
 *
 * export function ShippingRates() {
 * 	const { error, isPending, selectShippingRate, shippingPackages } = useCartShippingRates()
 *
 * 	return (
 * 		<fieldset aria-busy={isPending}>
 * 			{shippingPackages.map((shippingPackage) =>
 * 				shippingPackage.rates.map((rate) => (
 * 					<label key={rate.id}>
 * 						<input
 * 							checked={rate.selected}
 * 							disabled={isPending}
 * 							name={String(shippingPackage.id)}
 * 							onChange={() => selectShippingRate(rate.id, shippingPackage.id)}
 * 							type="radio"
 * 						/>
 * 						{rate.name}
 * 					</label>
 * 				)),
 * 			)}
 * 			{error ? <p role="alert">{error.message}</p> : null}
 * 		</fieldset>
 * 	)
 * }
 * ```
 *
 * @example Hearing only this hook's action
 * ```tsx
 * const { selectShippingRate } = useCartShippingRates({
 * 	onSuccess: (event) => {
 * 		if (event.type === "select_shipping_rate") track("shipping_selected", { rateId: event.rateId })
 * 	},
 * })
 * ```
 */
export function useCartShippingRates(options?: CartHookOptions): CartShippingRatesApi {
	const scope = useMemo(() => [...cartMutationKey, "shippingRate"], [])
	const { cart, error, isPending, mutate, mutateAsync, reset, cancelFailures } = useCartAction(scope, options, true)
	const cancel = useCallback(() => {
		cancelFailures()
		reset()
	}, [cancelFailures, reset])

	const selectShippingRate = useCallback(
		(rateId: string, packageId?: string | number | null) => mutate({ packageId, rateId, type: "select_shipping_rate" }),
		[mutate],
	)

	const selectShippingRateAsync = useCallback(
		(rateId: string, packageId?: string | number | null) => mutateAsync({ packageId, rateId, type: "select_shipping_rate" }),
		[mutateAsync],
	)

	return {
		cancel,
		error,
		hasSelectedShippingRates: hasSelectedShippingRates(cart),
		isPending,
		reset,
		selectShippingRate,
		selectShippingRateAsync,
		shippingPackages: cart?.shippingPackages ?? noShippingPackages,
	}
}

export type CartItemOptions = CartHookOptions & {
	/** Whether an edit saves itself. `false` leaves that to `quantity.commit()`, which is what an explicit "Update" button needs. */
	autoCommit?: boolean
	/** How long an edit waits before it is saved. Defaults to 400 — about the gap between two `+` clicks. */
	debounceMs?: number
	/** Where a keyless control starts. Defaults to 1. Ignored with a key, where the line's own quantity is the value. */
	defaultQuantity?: number
	/** The draft range, for a product that constrains it. Ignored with a key, where the store's limits are authoritative. */
	limits?: Partial<CartItemLimits>
}

/** Spread onto a `button`. Behaviour only: no label, no class name, no markup. */
type QuantityButtonProps = {
	disabled: boolean
	onClick: () => void
	type: "button"
}

/**
 * A whole quantity control: the value it shows, the range it has to stay in, and the props that drive the three elements.
 *
 * Each prop bag is also reachable on its own — `quantity.incrementProps.onClick` — for a consumer driving an element of its own
 * shape. What the bags deliberately leave out is anything user-visible: the `aria-label` and the `−`/`+` glyphs are text, and text
 * stays in the consumer.
 */
export type CartItemQuantity = {
	/** Saves a pending edit now instead of waiting out the debounce. Resolves immediately when keyless or clean. */
	commit: () => Promise<void>
	/** Saves the pending edit and returns the acknowledged cart; rejects on failure, or resolves undefined when nothing can be saved. */
	commitAsync: () => Promise<Cart | undefined>
	/** The quantity the store holds. Without a key there is no store value, so this is `value`. */
	committed: number
	decrementProps: QuantityButtonProps
	incrementProps: QuantityButtonProps
	/** What is in the field right now, which is not a quantity until it is committed. */
	input: string
	/** Spread onto an `input`. Behaviour only: no label, no class name, no markup. */
	inputProps: {
		disabled: boolean
		inputMode: "numeric"
		max: number
		min: number
		onBlur: () => void
		onChange: (event: ChangeEvent<HTMLInputElement>) => void
		onFocus: (event: FocusEvent<HTMLInputElement>) => void
		onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
		step: number
		type: "number"
		value: string
	}
	/** A save is owed. Always `false` without a key, where `addItem` is the commit. */
	isDirty: boolean
	limits: CartItemLimits
	/** Discards a pending edit, back to `committed`. */
	revert: () => void
	/** Sets the quantity and, with a key and `autoCommit`, schedules the save. `set(5); await commit()` is the awaitable form. */
	set: (quantity: number) => void
	/** What the control shows: the pending edit while one is owed, otherwise `committed`. */
	value: number
}

type QuantityFieldOptions = {
	autoCommit: boolean
	/** The quantity behind the control: the line's, or where a draft starts. */
	committed: number
	debounceMs: number
	/** The line to save to. Without one the control is a draft and commits nothing. */
	itemKey: string | undefined
	limits: CartItemLimits
	/** Writes one quantity to the store, or skips a missing line. */
	write: (quantity: number) => Promise<Cart | undefined>
}

/**
 * The behaviour of a quantity control, without its appearance: the uncommitted string, the clamped buttons, and — with a line
 * behind it — a debounced save.
 *
 * Module-private on purpose. This was a second exported hook, which left every consumer wiring the two together by hand and
 * getting the clamping wrong; `useCartItem` is the whole control now.
 */
function useQuantityField({ autoCommit, committed, debounceMs, itemKey, limits, write }: QuantityFieldOptions): CartItemQuantity {
	const keyed = itemKey !== undefined
	const keyedRef = useRef(keyed)
	keyedRef.current = keyed
	const binding = useCheckoutLockStore()
	const owner = useId()
	const queuedGeneration = useRef<number | null>(null)
	const markQueued = useCallback(
		(queued: boolean) => {
			if (!queued) queuedGeneration.current = null
			binding.queue(quantityQueueKey, owner, queued && keyedRef.current)
			if (queued && keyedRef.current) queuedGeneration.current = binding.store.generation
		},
		[binding, owner],
	)
	// One piece of state for the whole edit: the quantity the shopper chose that the store does not hold yet. Mirrored in a ref
	// because the commit paths — `commit()`, the unmount flush — read it in the same tick it is set.
	const [pending, setPending] = useState<number | null>(null)
	const pendingRef = useRef<number | null>(null)
	const [input, setInput] = useState(String(committed))
	// Escape blurs the field to leave it, and that blur would otherwise commit the very text Escape is abandoning.
	const abandonedRef = useRef(false)
	// The quantity last handed to the store, so the unmount flush does not send a second copy of a save already in flight.
	const sentRef = useRef<number | null>(null)
	const writeLatest = useLatest(write)
	const autoCommitLatest = useLatest(autoCommit)

	const setPendingQuantity = useCallback(
		(quantity: number | null) => {
			if (quantity === null) markQueued(false)
			pendingRef.current = quantity
			setPending(quantity)
		},
		[markQueued],
	)

	const saveAsync = useCallback(
		async (quantity: number) => {
			sentRef.current = quantity
			try {
				const request = writeLatest.current(quantity)
				markQueued(false)
				return await request
			} finally {
				// Both APIs drop a refused edit and fall back to the acknowledged line quantity.
				if (pendingRef.current === quantity) setPendingQuantity(null)
			}
		},
		[setPendingQuantity, writeLatest, markQueued],
	)

	const save = useCallback((quantity: number) => saveAsync(quantity).then(noop, noop), [saveAsync])
	const schedule = useDebouncedCallback((quantity: number) => void save(quantity), debounceMs)
	useEffect(
		() =>
			binding.store.state.listen(() => {
				if (queuedGeneration.current === null || queuedGeneration.current === binding.store.generation) return
				schedule.cancel()
				setPendingQuantity(null)
				sentRef.current = null
			}),
		[binding, schedule, setPendingQuantity],
	)

	// The store caught up — through this hook's save, or a cart changed in another tab — so nothing is owed any more, and a save
	// still waiting out its window would only re-send what the store already holds. Done on the store's value rather than when the
	// save resolves, so the control never flickers between the two.
	useEffect(() => {
		if (pendingRef.current !== committed) return

		schedule.cancel()
		setPendingQuantity(null)
	}, [committed, schedule, setPendingQuantity])

	const value = pending ?? committed

	// The field follows the value it is showing. A background refetch cannot move it while an edit is pending, because `value` is
	// the edit then rather than the store's quantity.
	useEffect(() => {
		setInput(String(value))
	}, [value])

	// Pointed at another line, which is another control: the edit does not travel to it. Dropping it is the safe half of the
	// choice — by the time this runs, the writer below belongs to the new line, so saving it would charge the wrong one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `itemKey` is this hook's argument, so it does change between renders.
	useEffect(() => {
		schedule.cancel()
		sentRef.current = null
		setPendingQuantity(null)
	}, [itemKey, schedule, setPendingQuantity])

	// A drawer closing a moment after a click would otherwise discard the edit. React Query mutations outlive the component, so
	// the request survives the unmount. `use-debounce` cancels its own timer here, which is why this writes directly instead of
	// flushing it. A keyless draft has nothing to write, and `write` says so.
	//
	// Nothing is flushed under `autoCommit: false`: an edit there is written when the consumer says so and not before, and an
	// unmount is not the consumer saying so.
	useEffect(
		() => () => {
			const quantity = pendingRef.current
			if (quantity !== null && quantity !== sentRef.current && autoCommitLatest.current) void writeLatest.current(quantity).then(noop, noop)
			markQueued(false)
		},
		[autoCommitLatest, writeLatest, markQueued],
	)

	const apply = useCallback(
		(next: number | string, immediate: boolean) => {
			// Everything lands in the store's range and on its step, whether it came from a button, the field or the consumer's own
			// `set`. Text that says nothing numeric — an emptied field — keeps the quantity the control is already showing.
			const quantity = resolveQuantity({
				input: String(next),
				maximum: limits.maximum,
				minimum: limits.minimum,
				step: limits.step,
				value,
			})

			setInput(String(quantity))

			if (!keyed) {
				setPendingQuantity(quantity)
				return
			}

			// Back to the quantity the store already holds — an edit undone inside the window — so nothing is owed and nothing is sent.
			if (quantity === committed) {
				schedule.cancel()
				setPendingQuantity(null)
				return
			}

			try {
				markQueued(true)
			} catch (error) {
				if (!(error instanceof CheckoutLockedError)) throw error
				setInput(String(value))
				void writeLatest.current(quantity).then(noop, noop)
				return
			}
			setPendingQuantity(quantity)
			sentRef.current = null
			if (!autoCommit) return

			if (immediate) {
				schedule.cancel()
				void save(quantity)
				return
			}

			schedule(quantity)
		},
		[autoCommit, committed, keyed, limits, save, schedule, setPendingQuantity, value, markQueued, writeLatest],
	)

	const commit = useCallback(async () => {
		const quantity = pendingRef.current
		if (!keyed || quantity === null) return

		// Not `schedule.flush()`: with `autoCommit: false` nothing was ever scheduled, and this path still has to save.
		schedule.cancel()
		await save(quantity)
	}, [keyed, save, schedule])

	const commitAsync = useCallback(async () => {
		const quantity = pendingRef.current
		if (!keyed || quantity === null) return
		schedule.cancel()
		return saveAsync(quantity)
	}, [keyed, saveAsync, schedule])

	const revert = useCallback(() => {
		schedule.cancel()
		setPendingQuantity(null)
		setInput(String(committed))
	}, [committed, schedule, setPendingQuantity])

	const step = useCallback(
		(direction: "decrement" | "increment") => apply(stepQuantity({ direction, limits, value }), false),
		[apply, limits, value],
	)

	const blur = useCallback(() => {
		if (abandonedRef.current) {
			abandonedRef.current = false
			return
		}

		apply(input, true)
	}, [apply, input])

	return {
		commit,
		commitAsync,
		committed: keyed ? committed : value,
		decrementProps: {
			disabled: !limits.editable || value <= limits.minimum,
			onClick: () => step("decrement"),
			type: "button",
		},
		incrementProps: {
			disabled: !limits.editable || value >= limits.maximum,
			onClick: () => step("increment"),
			type: "button",
		},
		input,
		inputProps: {
			disabled: !limits.editable,
			inputMode: "numeric",
			max: limits.maximum,
			min: limits.minimum,
			// Blur and Enter are the shopper saying they are done, so the typed value skips the wait.
			onBlur: blur,
			onChange: (event) => setInput(event.target.value),
			onFocus: (event) => {
				abandonedRef.current = false
				event.currentTarget.select()
			},
			onKeyDown: (event) => {
				if (event.key === "Enter") {
					event.preventDefault()
					event.currentTarget.blur()
				}
				if (event.key === "Escape") {
					// The blur below runs before this handler returns, so it is told to let the typed value go rather than commit it.
					abandonedRef.current = true
					setInput(String(value))
					event.currentTarget.blur()
				}
			},
			step: limits.step,
			type: "number",
			value: input,
		},
		isDirty: keyed && pending !== null,
		limits,
		revert,
		set: (quantity: number) => apply(quantity, false),

		value,
	}
}

/** What a key the cart no longer holds reports: nothing to edit. */
const lockedQuantityLimits = draftQuantityLimits({ editable: false, maximum: 0, minimum: 0 })

/**
 * The range a control offers: the store's for a line, the draft range before one exists, and nothing editable for a key the cart
 * no longer holds.
 */
function quantityLimits(
	item: Cart["items"][number] | null,
	keyed: boolean,
	overrides: Partial<CartItemLimits> | undefined,
): CartItemLimits {
	if (item) return cartItemLimits(item)
	if (!keyed) return draftQuantityLimits(overrides)

	return lockedQuantityLimits
}

export type CartItemApi = {
	/** Puts a product in the cart. Available with or without a key, because a product page has no line yet. */
	addItem: (input: AddCartItemInput) => void
	/** Adds with the same draft quantity default and returns the acknowledged cart; rejects on failure. */
	addItemAsync: (input: AddCartItemInput) => Promise<Cart>
	error: CartError | null
	format: (amount: number) => string
	/** This hook's own action is in flight. Another saving line does not set it. */
	isPending: boolean
	/** `null` without a key, and once the key is no longer in the cart — after a successful removal, for instance. */
	item: Cart["items"][number] | null
	/** The whole quantity control: what it shows, the range it stays in, and the props that drive it. */
	quantity: CartItemQuantity
	remove: () => void
	/** Returns the acknowledged cart, or undefined when there is nothing to remove; rejects on failure. */
	removeAsync: () => Promise<Cart | undefined>
	/** Clears the last failure once it has settled. An uncommitted edit is discarded with `quantity.revert()`. */
	reset: () => void
}

/**
 * Everything item-shaped: adding a product, and editing or removing one line.
 *
 * `quantity` is a whole control rather than a number. Spreading `decrementProps`, `inputProps` and `incrementProps` is enough for
 * a working −/input/+: the range, the step and the line's editability are folded into each `disabled`, and the typed value is
 * committed on blur and Enter and abandoned on Escape. A save in flight deliberately disables nothing, because the debounce is
 * what collapses a burst of clicks into one request.
 *
 * The key decides where the value lives. With one it is the line's: an edit shows at once and is saved `debounceMs` later, and a
 * cart refetch does not overwrite an edit that is still owed. Pass `autoCommit: false` and call `quantity.commit()` yourself
 * for an explicit "Update" button. Without a key there is no line to save to, so the value is a draft starting at
 * `defaultQuantity` that `addItem` sends for you, `item` is `null` and `remove` does nothing.
 *
 * `isPending` and `error` describe this line alone, so one saving row does not disable or blame the others.
 *
 * @example A product page, where the control is a draft `addItem` consumes
 * ```tsx
 * "use client"
 * import { useCartItem } from "@kizlo/woocommerce-kit/react/cart"
 *
 * export function AddToCart({ productId }: { productId: number }) {
 * 	const { addItem, error, isPending, quantity } = useCartItem()
 *
 * 	return (
 * 		<>
 * 			<button aria-label="One fewer" {...quantity.decrementProps}>−</button>
 * 			<input aria-label="Quantity" {...quantity.inputProps} />
 * 			<button aria-label="One more" {...quantity.incrementProps}>+</button>
 * 			<button disabled={isPending} onClick={() => addItem({ productId })} type="button">
 * 				{isPending ? "Adding…" : "Add to cart"}
 * 			</button>
 * 			{error ? <p role="alert">{error.code === "CART_ITEM_EXISTS" ? "Already in your cart." : error.message}</p> : null}
 * 		</>
 * 	)
 * }
 * ```
 *
 * @example One line of the cart, where an edit saves itself
 * ```tsx
 * export function CartLine({ itemKey }: { itemKey: string }) {
 * 	const { format, isPending, item, quantity, remove } = useCartItem(itemKey)
 * 	if (!item) return null
 *
 * 	return (
 * 		<article aria-busy={isPending}>
 * 			<h3>{item.name}</h3>
 * 			<button aria-label="One fewer" {...quantity.decrementProps}>−</button>
 * 			<input aria-label="Quantity" {...quantity.inputProps} />
 * 			<button aria-label="One more" {...quantity.incrementProps}>+</button>
 * 			<p>{format(item.totals.total)}</p>
 * 			<button onClick={() => remove()} type="button">Remove</button>
 * 		</article>
 * 	)
 * }
 * ```
 */
export function useCartItem(options?: CartItemOptions): CartItemApi
export function useCartItem(key: string | undefined, options?: CartItemOptions): CartItemApi
export function useCartItem(first?: string | CartItemOptions, second?: CartItemOptions): CartItemApi {
	const key = typeof first === "string" ? first : undefined
	// Decided on the shape of the first argument rather than on whether it is a key, so a draft whose variant is not chosen yet —
	// `useCartItem(undefined, options)`, or a `null` read off a URL or a map — keeps the options it was passed.
	const options = typeof first === "object" && first !== null ? first : second
	const { autoCommit = true, debounceMs = 400, defaultQuantity = 1, limits: draftLimits } = options ?? {}

	const scope = useMemo(() => [...cartMutationKey, "item", key ?? "add"], [key])
	const { cart, error, format, isPending, mutate, mutateAsync, reset } = useCartAction(scope, options)
	const item = key === undefined ? null : (cart?.items.find((candidate) => candidate.key === key) ?? null)

	const writeQuantity = useCallback(
		(quantity: number) => {
			if (!item || key === undefined) return Promise.resolve(undefined)

			return mutateAsync({ key, previousQuantity: item.quantity, quantity, type: "update_cart_item" })
		},
		[item, key, mutateAsync],
	)

	const limits = quantityLimits(item, key !== undefined, draftLimits)
	const draftStart = resolveQuantity({
		input: String(defaultQuantity),
		maximum: limits.maximum,
		minimum: limits.minimum,
		step: limits.step,
		value: limits.minimum,
	})

	const quantity = useQuantityField({
		autoCommit,
		committed: key === undefined ? draftStart : (item?.quantity ?? 0),
		debounceMs,
		itemKey: key,
		limits,
		write: writeQuantity,
	})

	const draft = quantity.value

	const addItem = useCallback(
		(input: AddCartItemInput) => {
			// Without a key the control is the quantity the shopper picked before any line existed, so it fills the input in. An
			// explicit quantity wins.
			const body = key === undefined && input.quantity === undefined ? { ...input, quantity: draft } : input

			mutate({ input: body, type: "add_to_cart" })
		},
		[draft, key, mutate],
	)

	const addItemAsync = useCallback(
		(input: AddCartItemInput) => {
			const body = key === undefined && input.quantity === undefined ? { ...input, quantity: draft } : input
			return mutateAsync({ input: body, type: "add_to_cart" })
		},
		[draft, key, mutateAsync],
	)

	const remove = useCallback(() => {
		if (!item || key === undefined) return

		// The removed item travels with the event: by the time a listener runs it is already gone from `cart`.
		mutate({ item, key, type: "remove_from_cart" })
	}, [item, key, mutate])

	const removeAsync = useCallback(async () => {
		if (!item || key === undefined) return
		return mutateAsync({ item, key, type: "remove_from_cart" })
	}, [item, key, mutateAsync])

	return {
		addItem,
		addItemAsync,
		error,
		format,
		isPending,
		item,
		quantity,
		remove,
		removeAsync,
		reset,
	}
}

export type CartCouponApi = {
	/**
	 * Applies a code. Available with or without a code on the hook, because a field has nothing applied yet.
	 *
	 * On a code-bound hook it reports against *that* hook's code: `useCartCoupon("SAVE10").apply("WELCOME10")` marks the `SAVE10`
	 * chip pending. Apply from the field, or from a hook bound to the code being applied.
	 */
	apply: (code: string) => void
	/** Applies the same code and returns the acknowledged cart; rejects on failure. */
	applyAsync: (code: string) => Promise<Cart>
	coupons: Cart["coupons"]
	/** The last failure of this hook's code — or of the apply field, without one. */
	error: CartError | null
	/** This hook's own code is saving. Another chip, and the apply field, are unaffected. */
	isPending: boolean
	/** Removes this hook's code. Without one — no code, or an empty one — there is nothing to remove, so it does nothing. */
	remove: () => void
	/** Returns the acknowledged cart, or undefined when there is nothing to remove; rejects on failure. */
	removeAsync: () => Promise<Cart | undefined>
	/** Clears the last failure once it has settled. */
	reset: () => void
}

/**
 * The coupons on the cart, and applying or removing one.
 *
 * The code decides what `isPending` and `error` describe, the same way a key does on {@link useCartItem}. Without one the hook is
 * the apply field: `error` is the rejection of the code just typed, and `reset` clears it as soon as the input changes —
 * otherwise the rejection of the last code sits under a field the shopper has already corrected. With one it is that chip alone,
 * so removing a coupon leaves every other chip's button and the apply button enabled.
 *
 * `coupons` is the whole list on both forms, because a chip still needs to know what it is rendering.
 *
 * @example The apply field, which has no code of its own yet
 * ```tsx
 * "use client"
 * import { useCartCoupon } from "@kizlo/woocommerce-kit/react/cart"
 * import { useState } from "react"
 *
 * export function CouponField() {
 * 	const { apply, coupons, error, isPending, reset } = useCartCoupon()
 * 	const [code, setCode] = useState("")
 *
 * 	return (
 * 		<form
 * 			onSubmit={(event) => {
 * 				event.preventDefault()
 * 				apply(code)
 * 			}}
 * 		>
 * 			<input
 * 				onChange={(event) => {
 * 					setCode(event.target.value)
 * 					reset()
 * 				}}
 * 				value={code}
 * 			/>
 * 			<button disabled={isPending || !code.trim()} type="submit">Apply</button>
 * 			{error ? <p role="alert">{error.message}</p> : null}
 * 			{coupons.map((coupon) => (
 * 				<CouponChip code={coupon.code} key={coupon.code} />
 * 			))}
 * 		</form>
 * 	)
 * }
 * ```
 *
 * @example One chip, which reports only its own removal
 * ```tsx
 * export function CouponChip({ code }: { code: string }) {
 * 	const { error, isPending, remove } = useCartCoupon(code)
 *
 * 	return (
 * 		<button disabled={isPending} onClick={() => remove()} type="button">
 * 			{code} {isPending ? "…" : "×"}
 * 			{error ? <span role="alert">{error.message}</span> : null}
 * 		</button>
 * 	)
 * }
 * ```
 */
export function useCartCoupon(options?: CartHookOptions): CartCouponApi
export function useCartCoupon(code: string | undefined, options?: CartHookOptions): CartCouponApi
export function useCartCoupon(first?: string | CartHookOptions, second?: CartHookOptions): CartCouponApi {
	// A code the shopper has not chosen yet arrives as `""` as often as `undefined` — `useState("")` is the obvious way to hold
	// one — and an empty code is no code: it must select the field's scope rather than a `coupon/code/""` of its own.
	const code = typeof first === "string" && first.trim() !== "" ? first : undefined
	// Decided on the shape of the first argument rather than on its absence, so `undefined`, `""` and a `null` read off a URL or
	// a map all leave the options where they were passed. Testing only for a string would drop them silently.
	const options = typeof first === "object" && first !== null ? first : second

	// The sentinel sits in its own slot rather than where a code goes: a store running a promotion actually coded `apply` would
	// otherwise share a key with the field, so removing that chip would disable the apply button.
	const scope = useMemo(
		() => (code === undefined ? [...cartMutationKey, "coupon", "field"] : [...cartMutationKey, "coupon", "code", code]),
		[code],
	)
	const { cart, error, isPending, mutate, mutateAsync, reset } = useCartAction(scope, options)

	// Deliberately the argument's code rather than this hook's, because the field form has no code of its own — the same latitude
	// `addItem` has on a keyed `useCartItem`. The pending state and the failure still belong to this hook's scope, which is what
	// the `apply` doc on `CartCouponApi` says.
	const apply = useCallback((applied: string) => mutate({ code: applied, type: "apply_coupon" }), [mutate])
	const applyAsync = useCallback((applied: string) => mutateAsync({ code: applied, type: "apply_coupon" }), [mutateAsync])

	const remove = useCallback(() => {
		if (code === undefined) return

		mutate({ code, type: "remove_coupon" })
	}, [code, mutate])

	const removeAsync = useCallback(async () => {
		if (code === undefined) return
		return mutateAsync({ code, type: "remove_coupon" })
	}, [code, mutateAsync])

	return {
		apply,
		applyAsync,
		coupons: cart?.coupons ?? noCoupons,
		error,
		isPending,
		remove,
		removeAsync,
		reset,
	}
}
