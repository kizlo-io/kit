"use client"

/**
 * React adapter for the cart: three hooks, one of which carries a whole quantity control. No provider of its own.
 *
 * Its own entry point rather than an addition to `./client`, because the cart needs a query library and the collection needs a
 * URL-state library; sharing one chunk would make a collection-only consumer resolve a dependency it never installed.
 *
 * The client comes from `KizloProvider`, the configuration from `WooCommerceProvider`, and the cart itself from the app's
 * `QueryClient` — so a consumer mounts nothing per feature. React Query is an implementation detail: no hook returns one of its
 * result objects, no consumer imports it, and the kit never creates a client or sets a global default. What it does use is the
 * shared mutation cache, which is how one saving line is visible to every component that shows that line without a provider
 * holding the state.
 *
 * Renders nothing. Every class name, icon, label and route stays in the consumer.
 */

import { isServer, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ActiveKizloClient, toKizloError } from "kizlo"
import { useKizloContext } from "kizlo/react"
import { type ChangeEvent, type FocusEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useDebouncedCallback } from "use-debounce"
import {
	type CartActionPayload,
	type CartCallbacks,
	type CartErrorEvent,
	type CartItemLimits,
	type CartStartEvent,
	type CartSuccessEvent,
	cartItemLimits,
	cartQueryKey,
	cartStaleTime,
	draftQuantityLimits,
	resolveQuantity,
	stepQuantity,
} from "../cart"
import { formatStoreMoney } from "../money"
import type { AddCartItemInput, Cart, CartError, UpdateCartInput } from "../types"
import { useWooCommerceContext } from "./context"

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
export type { CartError } from "../types"

type CartProcedures = ActiveKizloClient["woocommerce"]["cart"]

export type CartHookOptions = CartCallbacks

/** Everything the cart mutations are keyed under, so one lookup answers "is any cart action in flight". */
const cartMutationKey = [...cartQueryKey, "mutation"] as const

/** Stable empties, so a consumer reading `items` on an unfetched cart does not see a new array every render. */
const noItems: Cart["items"] = []
const noCoupons: Cart["coupons"] = []

function useLatest<T>(value: T) {
	const ref = useRef(value)
	useEffect(() => {
		ref.current = value
	}, [value])
	return ref
}

/**
 * Calls one listener without letting it break the phase: the hook's callback and the provider's both run, whichever throws.
 * The failure is re-raised on its own so it still reaches the app's error handling instead of disappearing.
 */
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

/** The app's query client, or a message that names what is missing rather than react-query's own. */
function useCartQueryClient() {
	try {
		// biome-ignore lint/correctness/useHookAtTopLevel: called once per render, never conditionally; the try only rewrites the error.
		return useQueryClient()
	} catch {
		throw new Error(
			"the cart needs a <QueryClientProvider> above it: the kit uses the app's own QueryClient so one cart lives in one cache.",
		)
	}
}

/**
 * What one cart action resolves to. Every cart procedure answers the new cart, and every failure it can report is a member of
 * {@link CartError}, so one envelope describes them all and a caller narrows on `success`.
 */
type CartActionResult = { data: Cart; error: null; success: true } | { data: undefined; error: CartError; success: false }

type CartAction = {
	payload: CartActionPayload
	request: (procedures: CartProcedures) => Promise<CartActionResult>
}

/**
 * What every cart hook is made of: the shared cart query, one mutation keyed to this hook's scope, and the runner that turns an
 * action into the four callback phases without ever rejecting.
 */
function useCartRuntime(scope: readonly string[], options: CartHookOptions | undefined) {
	const { callbacks: providerCallbacks, cartEnabled, locale } = useWooCommerceContext()
	const { client } = useKizloContext()
	const queryClient = useCartQueryClient()
	const hookCallbacks = useLatest<CartCallbacks | undefined>(options)
	const [error, setError] = useState<CartError | null>(null)

	const cartQuery = useQuery<Cart, CartError>({
		// The cart is session state behind a cookie, so it is fetched in the browser and never server-rendered.
		enabled: cartEnabled && !isServer,
		// React Query reports a failure by rejection, so the envelope is unwrapped here rather than carried into the cache.
		queryFn: async () => {
			const result = await client.woocommerce.cart.get()
			if (!result.success) throw result.error
			return result.data
		},
		queryKey: cartQueryKey,
		staleTime: cartStaleTime,
	})

	// Each hook owns one mutation, keyed to its scope: the caller already memoised `scope`, so the key is stable.
	const mutation = useMutation({
		// The client answers failures rather than throwing them, so the only way here is something outside the contract — a
		// cancelled mutation, a broken proxy. It is folded into the same envelope so an action still never rejects.
		mutationFn: async (action: CartAction): Promise<CartActionResult> => {
			try {
				return await action.request(client.woocommerce.cart)
			} catch (cause) {
				return { data: undefined, error: toKizloError(cause) as CartError, success: false }
			}
		},
		mutationKey: scope,
	})
	const mutateAsync = useLatest(mutation.mutateAsync)

	// Read from the mutation cache rather than from local state: two components showing the same line both see it saving.
	const isPending = useIsMutating({ mutationKey: scope }) > 0
	const isMutating = useIsMutating({ mutationKey: cartMutationKey }) > 0

	const run = useCallback(
		async (action: CartAction) => {
			const hook = hookCallbacks.current
			const provider = providerCallbacks.current

			const start: CartStartEvent = { ...action.payload, status: "start" }
			notify(hook?.onStart, start)
			notify(provider.onStart, start)

			const result = await mutateAsync.current(action)

			if (result.success) {
				queryClient.setQueryData(cartQueryKey, result.data)
				setError(null)

				const success: CartSuccessEvent = { ...action.payload, cart: result.data, status: "success" }
				notify(hook?.onSuccess, success)
				notify(provider.onSuccess, success)
				notify(hook?.onSettled, success)
				notify(provider.onSettled, success)
			} else {
				setError(result.error)

				const failure: CartErrorEvent = { ...action.payload, error: result.error, status: "error" }
				notify(hook?.onError, failure)
				notify(provider.onError, failure)
				notify(hook?.onSettled, failure)
				notify(provider.onSettled, failure)
			}
		},
		[hookCallbacks, mutateAsync, providerCallbacks, queryClient],
	)

	const cart = cartQuery.data ?? null
	const queryError = cartQuery.error
	const format = useCallback((amount: number) => (cart ? formatStoreMoney(amount, cart.currencyFormat, locale) : ""), [cart, locale])

	const refresh = useCallback(async () => {
		setError(null)
		await queryClient.refetchQueries({ queryKey: cartQueryKey })
	}, [queryClient])

	const reset = useCallback(() => setError(null), [])

	return {
		cart,
		error,
		format,
		isLoading: cartQuery.isPending,
		isMutating,
		isPending,
		queryError,
		refresh,
		reset,
		run,
	}
}

export type CartApi = {
	/** The store's payload, so totals, addresses and shipping are read from it directly rather than mirrored here. */
	cart: Cart | null
	/** The last failure of the cart itself: one of these actions, or the fetch. A line's own failure is on `useCartItem`. */
	error: CartError | null
	/** This cart's currency and the configured locale, already applied. Empty while there is no cart. */
	format: (amount: number) => string
	isLoading: boolean
	/** Any cart action anywhere in the tree is in flight — what a consumer disables its controls on. */
	isMutating: boolean
	itemCount: number
	items: Cart["items"]
	refresh: () => Promise<void>
	reset: () => void
	selectShippingRate: (rateId: string, packageId?: string | number | null) => Promise<void>
	updateCustomer: (input: UpdateCartInput) => Promise<void>
}

/**
 * The cart and the actions that are about the cart as a whole: the customer's details and the shipping choice.
 *
 * Adding, editing and removing a line are item-shaped work and live on {@link useCartItem}; coupons live on
 * {@link useCartCoupon}. Every action here resolves and never rejects — the outcome arrives through the callbacks, and the last
 * failure stays on `error` until `reset` or the next success, which is what removes try/catch from the call sites.
 *
 * Needs `KizloProvider`, `WooCommerceProvider` and the app's `QueryClientProvider` above it. It takes no client.
 *
 * @example Summary totals, and a postcode that re-quotes shipping
 * ```tsx
 * "use client"
 * import { useCart } from "@kizlo/woocommerce-kit/react/cart"
 *
 * export function CartSummary() {
 * 	const { cart, error, format, isLoading, isMutating, updateCustomer } = useCart()
 *
 * 	if (isLoading) return <Spinner />
 * 	if (!cart) return <EmptyCart />
 *
 * 	return (
 * 		<section aria-busy={isMutating}>
 * 			{error ? <p role="alert">{error.message}</p> : null}
 * 			<p>{cart.itemCount} items · {format(cart.totals.total)}</p>
 * 			<button
 * 				disabled={isMutating}
 * 				onClick={() => void updateCustomer({ shippingAddress: { postcode: "560001" } })}
 * 				type="button"
 * 			>
 * 				Estimate shipping
 * 			</button>
 * 		</section>
 * 	)
 * }
 * ```
 *
 * @example Hearing only this hook's actions
 * ```tsx
 * const { selectShippingRate } = useCart({
 * 	onSuccess: (event) => {
 * 		if (event.type === "select_shipping_rate") track("shipping_selected", { rateId: event.rateId })
 * 	},
 * })
 * ```
 */
export function useCart(options?: CartHookOptions): CartApi {
	const scope = useMemo(() => [...cartMutationKey, "cart"], [])
	const { cart, error, format, isLoading, isMutating, queryError, refresh, reset, run } = useCartRuntime(scope, options)

	const updateCustomer = useCallback(
		(input: UpdateCartInput) =>
			run({
				payload: { input, type: "update_customer" },
				request: (procedures) => procedures.update({ body: input }),
			}),
		[run],
	)

	const selectShippingRate = useCallback(
		(rateId: string, packageId?: string | number | null) =>
			run({
				payload: { packageId, rateId, type: "select_shipping_rate" },
				request: (procedures) => procedures.selectShippingRate({ body: { packageId, rateId } }),
			}),
		[run],
	)

	return {
		cart,
		error: error ?? queryError,
		format,
		isLoading,
		isMutating,
		itemCount: cart?.itemCount ?? 0,
		items: cart?.items ?? noItems,
		refresh,
		reset,
		selectShippingRate,
		updateCustomer,
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
	/** Writes one quantity to the store. Never rejects — a failure arrives on the hook's `error`. */
	write: (quantity: number) => Promise<void>
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

	const setPendingQuantity = useCallback((quantity: number | null) => {
		pendingRef.current = quantity
		setPending(quantity)
	}, [])

	const save = useCallback(
		async (quantity: number) => {
			sentRef.current = quantity
			await writeLatest.current(quantity)

			// A failed save leaves the store unchanged, so the edit is dropped here: the control falls back to the line's quantity
			// with the failure on `error`. A successful one has already been dropped by the effect below.
			if (pendingRef.current === quantity) setPendingQuantity(null)
		},
		[setPendingQuantity, writeLatest],
	)

	const schedule = useDebouncedCallback((quantity: number) => void save(quantity), debounceMs)

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
		setPendingQuantity(null)
	}, [itemKey, setPendingQuantity])

	// A drawer closing a moment after a click would otherwise discard the edit. React Query mutations outlive the component, so
	// the request survives the unmount. `use-debounce` cancels its own timer here, which is why this writes directly instead of
	// flushing it. A keyless draft has nothing to write, and `write` says so.
	//
	// Nothing is flushed under `autoCommit: false`: an edit there is written when the consumer says so and not before, and an
	// unmount is not the consumer saying so.
	useEffect(
		() => () => {
			const quantity = pendingRef.current
			if (quantity === null || quantity === sentRef.current || !autoCommitLatest.current) return

			void writeLatest.current(quantity)
		},
		[autoCommitLatest, writeLatest],
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
		[autoCommit, committed, keyed, limits, save, schedule, setPendingQuantity, value],
	)

	const commit = useCallback(async () => {
		const quantity = pendingRef.current
		if (!keyed || quantity === null) return

		// Not `schedule.flush()`: with `autoCommit: false` nothing was ever scheduled, and this path still has to save.
		schedule.cancel()
		await save(quantity)
	}, [keyed, save, schedule])

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
	addItem: (input: AddCartItemInput) => Promise<void>
	error: CartError | null
	format: (amount: number) => string
	/** This hook's own action is in flight. Another saving line does not set it. */
	isPending: boolean
	/** `null` without a key, and once the key is no longer in the cart — after a successful removal, for instance. */
	item: Cart["items"][number] | null
	/** The whole quantity control: what it shows, the range it stays in, and the props that drive it. */
	quantity: CartItemQuantity
	remove: () => Promise<void>
	/** Clears the last failure. An uncommitted edit is discarded with `quantity.revert()`. */
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
 * 			<button disabled={isPending} onClick={() => void addItem({ productId })} type="button">
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
 * 			<button onClick={() => void remove()} type="button">Remove</button>
 * 		</article>
 * 	)
 * }
 * ```
 */
export function useCartItem(options?: CartItemOptions): CartItemApi
export function useCartItem(key: string | undefined, options?: CartItemOptions): CartItemApi
export function useCartItem(first?: string | CartItemOptions, second?: CartItemOptions): CartItemApi {
	const key = typeof first === "string" ? first : undefined
	const options = typeof first === "string" ? second : first
	const { autoCommit = true, debounceMs = 400, defaultQuantity = 1, limits: draftLimits } = options ?? {}

	const scope = useMemo(() => [...cartMutationKey, "item", key ?? "add"], [key])
	const { cart, error, format, isPending, reset, run } = useCartRuntime(scope, options)
	const item = key === undefined ? null : (cart?.items.find((candidate) => candidate.key === key) ?? null)

	const write = useCallback(
		(quantity: number) => {
			if (!item || key === undefined) return Promise.resolve()

			return run({
				payload: { key, previousQuantity: item.quantity, quantity, type: "update_cart_item" },
				request: (procedures) => procedures.items.update({ body: { quantity }, params: { key } }),
			})
		},
		[item, key, run],
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
		write,
	})

	const draft = quantity.value

	const addItem = useCallback(
		(input: AddCartItemInput) => {
			// Without a key the control is the quantity the shopper picked before any line existed, so it fills the input in. An
			// explicit quantity wins.
			const body = key === undefined && input.quantity === undefined ? { ...input, quantity: draft } : input

			return run({
				payload: { input: body, type: "add_to_cart" },
				request: (procedures) => procedures.items.add({ body }),
			})
		},
		[draft, key, run],
	)

	const remove = useCallback(() => {
		if (!item || key === undefined) return Promise.resolve()

		return run({
			// The removed item travels with the event: by the time a listener runs it is already gone from `cart`.
			payload: { item, key, type: "remove_from_cart" },
			request: (procedures) => procedures.items.remove({ params: { key } }),
		})
	}, [item, key, run])

	return {
		addItem,
		error,
		format,
		isPending,
		item,
		quantity,
		remove,
		reset,
	}
}

export type CartCouponApi = {
	apply: (code: string) => Promise<void>
	coupons: Cart["coupons"]
	error: CartError | null
	isPending: boolean
	remove: (code: string) => Promise<void>
	reset: () => void
}

/**
 * The coupons on the cart, and applying or removing one.
 *
 * `reset` clears a rejected code, which a coupon field needs as soon as its input changes — otherwise the rejection of the last
 * code sits under a field the shopper has already corrected.
 *
 * @example
 * ```tsx
 * "use client"
 * import { useCartCoupon } from "@kizlo/woocommerce-kit/react/cart"
 * import { useState } from "react"
 *
 * export function CouponField() {
 * 	const { apply, coupons, error, isPending, remove, reset } = useCartCoupon()
 * 	const [code, setCode] = useState("")
 *
 * 	return (
 * 		<form
 * 			onSubmit={(event) => {
 * 				event.preventDefault()
 * 				void apply(code)
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
 * 				<button key={coupon.code} onClick={() => void remove(coupon.code)} type="button">
 * 					{coupon.code} ×
 * 				</button>
 * 			))}
 * 		</form>
 * 	)
 * }
 * ```
 */
export function useCartCoupon(options?: CartHookOptions): CartCouponApi {
	const scope = useMemo(() => [...cartMutationKey, "coupon"], [])
	const { cart, error, isPending, reset, run } = useCartRuntime(scope, options)

	const apply = useCallback(
		(code: string) =>
			run({
				payload: { code, type: "apply_coupon" },
				request: (procedures) => procedures.coupons.apply({ body: { code } }),
			}),
		[run],
	)

	const remove = useCallback(
		(code: string) =>
			run({
				payload: { code, type: "remove_coupon" },
				request: (procedures) => procedures.coupons.remove({ params: { code } }),
			}),
		[run],
	)

	return {
		apply,
		coupons: cart?.coupons ?? noCoupons,
		error,
		isPending,
		remove,
		reset,
	}
}
