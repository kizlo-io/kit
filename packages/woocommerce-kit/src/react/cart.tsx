"use client"

/**
 * React adapter for the cart: three hooks and a headless quantity control. No provider of its own.
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

import type { AddCartItemInput, Cart, CartError, UpdateCartInput } from "@kizlo/woocommerce"
import { isServer, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { useKizloContext } from "kizlo/react"
import { type ChangeEvent, type FocusEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
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
	resolveQuantity,
} from "../cart"
import { formatStoreMoney } from "../money"
import { useWooCommerceContext } from "./context"

/**
 * The core's cart types, re-exported so a component reads its hook and the types it returns from one specifier. Type-only, so
 * nothing reaches the bundle.
 */
export type {
	CartActionPayload,
	CartCallbacks,
	CartError,
	CartErrorEvent,
	CartItemLimits,
	CartSettledEvent,
	CartStartEvent,
	CartSuccessEvent,
} from "../cart"

type CartProcedures = ActiveKizloClient["woocommerce"]["cart"]

export type CartHookOptions = CartCallbacks

/** Everything the cart mutations are keyed under, so one lookup answers "is any cart action in flight". */
const cartMutationKey = [...cartQueryKey, "mutation"] as const

/** Stable empties, so a consumer reading `items` on an unfetched cart does not see a new array every render. */
const noItems: Cart["items"] = []
const noCoupons: Cart["coupons"] = []

/** What a line reports when there is no line: nothing to edit. */
const missingItemLimits: CartItemLimits = { editable: false, maximum: 0, minimum: 0, step: 1 }

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

/** Narrows whatever the client threw to the store's error shape, keeping the code a call site may branch on. */
function toCartError(cause: unknown): CartError {
	if (cause && typeof cause === "object") {
		const { code, message } = cause as { code?: unknown; message?: unknown }
		return { code: typeof code === "string" ? code : "", message: typeof message === "string" ? message : "" }
	}

	return { code: "", message: typeof cause === "string" ? cause : "" }
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

type CartAction = {
	payload: CartActionPayload
	request: (procedures: CartProcedures) => Promise<Cart>
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

	const cartQuery = useQuery({
		// The cart is session state behind a cookie, so it is fetched in the browser and never server-rendered.
		enabled: cartEnabled && !isServer,
		queryFn: (): Promise<Cart> => client.woocommerce.cart.get.call(),
		queryKey: cartQueryKey,
		staleTime: cartStaleTime,
	})

	// Each hook owns one mutation, keyed to its scope: the caller already memoised `scope`, so the key is stable.
	const mutation = useMutation({
		mutationFn: (action: CartAction) => action.request(client.woocommerce.cart),
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

			try {
				const cart = await mutateAsync.current(action)
				queryClient.setQueryData(cartQueryKey, cart)
				setError(null)

				const success: CartSuccessEvent = { ...action.payload, cart, status: "success" }
				notify(hook?.onSuccess, success)
				notify(provider.onSuccess, success)
				notify(hook?.onSettled, success)
				notify(provider.onSettled, success)
			} catch (cause) {
				const failed = toCartError(cause)
				setError(failed)

				const failure: CartErrorEvent = { ...action.payload, error: failed, status: "error" }
				notify(hook?.onError, failure)
				notify(provider.onError, failure)
				notify(hook?.onSettled, failure)
				notify(provider.onSettled, failure)
			}
		},
		[hookCallbacks, mutateAsync, providerCallbacks, queryClient],
	)

	const cart = cartQuery.data ?? null
	const queryError = useMemo(() => (cartQuery.error ? toCartError(cartQuery.error) : null), [cartQuery.error])
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
				request: (procedures) => procedures.update.call({ body: input }),
			}),
		[run],
	)

	const selectShippingRate = useCallback(
		(rateId: string, packageId?: string | number | null) =>
			run({
				payload: { packageId, rateId, type: "select_shipping_rate" },
				request: (procedures) => procedures.selectShippingRate.call({ body: { packageId, rateId } }),
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

export type CartItemApi = {
	/** Puts a product in the cart. Available with or without a key, because a product page has no line yet. */
	addItem: (input: AddCartItemInput) => Promise<void>
	error: CartError | null
	format: (amount: number) => string
	/** This hook's own action is in flight. Another saving line does not set it. */
	isPending: boolean
	/** `null` without a key, and once the key is no longer in the cart — after a successful removal, for instance. */
	item: Cart["items"][number] | null
	limits: CartItemLimits
	quantity: number
	remove: () => Promise<void>
	reset: () => void
	setQuantity: (quantity: number) => Promise<void>
}

/**
 * Everything item-shaped: adding a product, and editing or removing one line.
 *
 * The key is optional because adding happens before a line exists. Without one, `item` is `null`, `quantity` is `0`, `limits`
 * is the empty range, `setQuantity` and `remove` do nothing, and `addItem` is the action to use. With one, it is the full line
 * API, and `isPending` and `error` describe that line alone, so one saving row does not disable or blame the others.
 *
 * @example A product page, which has no line yet
 * ```tsx
 * "use client"
 * import { useCartItem } from "@kizlo/woocommerce-kit/react/cart"
 *
 * export function AddToCart({ productId }: { productId: number }) {
 * 	const { addItem, error, isPending } = useCartItem()
 *
 * 	return (
 * 		<>
 * 			<button disabled={isPending} onClick={() => void addItem({ productId, quantity: 1 })} type="button">
 * 				{isPending ? "Adding…" : "Add to cart"}
 * 			</button>
 * 			{error ? <p role="alert">{error.code === "CART_ITEM_EXISTS" ? "Already in your cart." : error.message}</p> : null}
 * 		</>
 * 	)
 * }
 * ```
 *
 * @example One line of the cart
 * ```tsx
 * export function CartLine({ itemKey }: { itemKey: string }) {
 * 	const { format, isPending, item, limits, quantity, remove, setQuantity } = useCartItem(itemKey)
 * 	if (!item) return null
 *
 * 	return (
 * 		<article aria-busy={isPending}>
 * 			<h3>{item.name}</h3>
 * 			<button disabled={!limits.editable} onClick={() => void setQuantity(quantity + limits.step)} type="button">
 * 				Add one
 * 			</button>
 * 			<p>{format(item.totals.total)}</p>
 * 			<button onClick={() => void remove()} type="button">Remove</button>
 * 		</article>
 * 	)
 * }
 * ```
 */
export function useCartItem(key?: string, options?: CartHookOptions): CartItemApi {
	const scope = useMemo(() => [...cartMutationKey, "item", key ?? "add"], [key])
	const { cart, error, format, isPending, reset, run } = useCartRuntime(scope, options)
	const item = key === undefined ? null : (cart?.items.find((candidate) => candidate.key === key) ?? null)

	const addItem = useCallback(
		(input: AddCartItemInput) =>
			run({
				payload: { input, type: "add_to_cart" },
				request: (procedures) => procedures.items.add.call({ body: input }),
			}),
		[run],
	)

	const setQuantity = useCallback(
		(quantity: number) => {
			if (!item || key === undefined) return Promise.resolve()

			return run({
				payload: { key, previousQuantity: item.quantity, quantity, type: "update_cart_item" },
				request: (procedures) => procedures.items.update.call({ body: { quantity }, params: { key } }),
			})
		},
		[item, key, run],
	)

	const remove = useCallback(() => {
		if (!item || key === undefined) return Promise.resolve()

		return run({
			// The removed item travels with the event: by the time a listener runs it is already gone from `cart`.
			payload: { item, key, type: "remove_from_cart" },
			request: (procedures) => procedures.items.remove.call({ params: { key } }),
		})
	}, [item, key, run])

	return {
		addItem,
		error,
		format,
		isPending,
		item,
		limits: item ? cartItemLimits(item) : missingItemLimits,
		quantity: item?.quantity ?? 0,
		remove,
		reset,
		setQuantity,
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
				request: (procedures) => procedures.coupons.apply.call({ body: { code } }),
			}),
		[run],
	)

	const remove = useCallback(
		(code: string) =>
			run({
				payload: { code, type: "remove_coupon" },
				request: (procedures) => procedures.coupons.remove.call({ params: { code } }),
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

export type QuantityInputOptions = {
	maximum?: number
	minimum?: number
	/** Called with the resolved quantity, only when it differs from `value`. */
	onValueChange: (value: number) => void
	step?: number
	/** The quantity the store currently holds. The field follows it whenever it changes. */
	value: number
}

export type QuantityInputApi = {
	canDecrement: boolean
	canIncrement: boolean
	decrement: () => void
	increment: () => void
	/** What is in the field right now, which is not a quantity until it is committed. */
	input: string
	/** Spread onto an `input`. Behaviour only: no class name, no styling, no markup. */
	inputProps: {
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
}

/**
 * The behaviour of a quantity control, without its appearance.
 *
 * A typed quantity is committed on blur and Enter and abandoned on Escape, because committing on every keystroke would send a
 * request per digit. The arithmetic is `resolveQuantity` in the core, so it is tested without a DOM. It reads no context, so it
 * works anywhere — including outside the cart.
 *
 * @example Pairing it with one cart line's limits
 * ```tsx
 * "use client"
 * import { useCartItem, useQuantityInput } from "@kizlo/woocommerce-kit/react/cart"
 *
 * export function QuantityField({ itemKey }: { itemKey: string }) {
 * 	const { limits, quantity, setQuantity } = useCartItem(itemKey)
 * 	const field = useQuantityInput({
 * 		maximum: limits.maximum,
 * 		minimum: limits.minimum,
 * 		onValueChange: setQuantity,
 * 		step: limits.step,
 * 		value: quantity,
 * 	})
 *
 * 	return (
 * 		<div>
 * 			<button disabled={!field.canDecrement} onClick={field.decrement} type="button">−</button>
 * 			<input aria-label="Quantity" disabled={!limits.editable} {...field.inputProps} />
 * 			<button disabled={!field.canIncrement} onClick={field.increment} type="button">+</button>
 * 		</div>
 * 	)
 * }
 * ```
 */
export function useQuantityInput({ maximum = 99, minimum = 1, onValueChange, step = 1, value }: QuantityInputOptions): QuantityInputApi {
	const [input, setInput] = useState(String(value))

	useEffect(() => {
		setInput(String(value))
	}, [value])

	const change = useCallback(
		(next: number) => {
			setInput(String(next))
			if (next !== value) onValueChange(next)
		},
		[onValueChange, value],
	)

	const commit = useCallback(() => {
		change(resolveQuantity({ input, maximum, minimum, step, value }))
	}, [change, input, maximum, minimum, step, value])

	return {
		canDecrement: value > minimum,
		canIncrement: value < maximum,
		decrement: () => change(Math.max(minimum, value - step)),
		increment: () => change(Math.min(maximum, value + step)),
		input,
		inputProps: {
			inputMode: "numeric",
			max: maximum,
			min: minimum,
			onBlur: commit,
			onChange: (event) => setInput(event.target.value),
			onFocus: (event) => event.currentTarget.select(),
			onKeyDown: (event) => {
				if (event.key === "Enter") {
					event.preventDefault()
					event.currentTarget.blur()
				}
				if (event.key === "Escape") {
					setInput(String(value))
					event.currentTarget.blur()
				}
			},
			step,
			type: "number",
			value: input,
		},
	}
}
