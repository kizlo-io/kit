// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import type { Cart, CartError } from "../types"
import { type CartHookOptions, useCart, useCartAddress, useCartCoupon, useCartItem, useCartShippingRates } from "./cart"
import { WooCommerceProvider } from "./provider"

/**
 * React Query is deliberately real here: it owns the mutation lifecycle these tests are about. Only the Kizlo client is a stub,
 * and only its `.call` — the one thing the kit asks of a procedure.
 */
const { procedures } = vi.hoisted(() => {
	const procedure = () => ({ call: vi.fn() })

	return {
		procedures: {
			coupons: { apply: procedure(), remove: procedure() },
			get: procedure(),
			items: { add: procedure(), remove: procedure(), update: procedure() },
			selectShippingRate: procedure(),
			update: procedure(),
		},
	}
})

vi.mock("kizlo/react", () => ({
	useKizloContext: () => ({ client: { woocommerce: { cart: procedures } } }),
}))

/** Only the fields the hooks read. The rest of a cart says nothing about an action's lifecycle. */
function storeCart(items: { key: string; quantity: number }[], shipping?: { rates: boolean[] }[]) {
	return {
		coupons: [],
		itemCount: items.length,
		items: items.map(({ key, quantity }) => ({
			isSoldIndividually: false,
			key,
			quantity,
			quantityLimits: { editable: true, maximum: 10, minimum: 1, multipleOf: 1 },
		})),
		// A cart needs shipping exactly when the test gave it packages; each boolean is one rate, true for the selected one.
		needsShipping: shipping !== undefined,
		shippingPackages: (shipping ?? []).map((shippingPackage, index) => ({
			id: index,
			rates: shippingPackage.rates.map((selected, rateIndex) => ({ id: `rate-${index}-${rateIndex}`, selected })),
		})),
	} as unknown as Cart
}

/** A refusal shaped like one of the store's: a `code` a call site can branch on. */
function storeError(code: string) {
	return Object.assign(new Error("Already in your cart."), { code }) as unknown as CartError
}

function mount<T>(hook: () => T, cart?: Cart, options?: { cartEnabled?: boolean; mutations?: { retry: number } }) {
	const { cartEnabled = false, mutations } = options ?? {}
	const queryClient = new QueryClient({ defaultOptions: { mutations, queries: { retry: false } } })
	if (cart) queryClient.setQueryData(cartQueryKey, cart)

	// `cartEnabled: false` by default so the cart query makes no request: every cart these tests read is either seeded or
	// answered by an action. The one case that needs the fetch itself to fail opts in. JSX is avoided because the suite only
	// collects `src/**/*.test.ts`.
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { cartEnabled, children }))

	return { queryClient, ...renderHook(hook, { wrapper }) }
}

type Phase = "error" | "settled" | "start" | "success"

/** Records what each phase was told, so one assertion covers the order and another the payload. */
function recorder() {
	const seen: { cart?: Cart; error?: CartError; input?: unknown; phase: Phase; type: string }[] = []
	const options: CartHookOptions = {
		onError: (event) =>
			seen.push({ error: event.error, phase: "error", type: event.type, ...("input" in event && { input: event.input }) }),
		onSettled: (event) =>
			seen.push({
				phase: "settled",
				type: event.type,
				...(event.status === "success" ? { cart: event.cart } : { error: event.error }),
				...("input" in event && { input: event.input }),
			}),
		onStart: (event) => seen.push({ phase: "start", type: event.type, ...("input" in event && { input: event.input }) }),
		onSuccess: (event) =>
			seen.push({ cart: event.cart, phase: "success", type: event.type, ...("input" in event && { input: event.input }) }),
	}

	return { options, phases: () => seen.map((entry) => entry.phase), seen }
}

/**
 * Takes Node's uncaught exceptions for the duration of one test and hands back what they were.
 *
 * `notify` re-raises a consumer's failure in a microtask, which Node surfaces as an uncaught exception and Vitest would fail the
 * run on. Only the test that provokes one swaps the handler, so an unexpected throw anywhere else still fails the run.
 */
function captureUncaught() {
	const uncaught: unknown[] = []
	const hostListeners = process.listeners("uncaughtException")
	process.removeAllListeners("uncaughtException")
	process.on("uncaughtException", (error) => uncaught.push(error))

	return {
		restore: () => {
			process.removeAllListeners("uncaughtException")
			for (const listener of hostListeners) process.on("uncaughtException", listener)
		},
		uncaught,
	}
}

afterEach(() => {
	vi.clearAllMocks()
})

describe("useCartItem callbacks", () => {
	it("reports a successful add as start, success and settled, with the payload on every phase", async () => {
		const cart = storeCart([{ key: "a", quantity: 1 }])
		procedures.items.add.call.mockResolvedValue(cart)
		const { options, phases, seen } = recorder()

		const { result } = mount(() => useCartItem(options))
		act(() => result.current.addItem({ productId: 7 }))

		await waitFor(() => expect(phases()).toEqual(["start", "success", "settled"]))
		expect(seen.every((entry) => entry.type === "add_to_cart")).toBe(true)
		expect(seen.map((entry) => entry.input)).toEqual([
			{ productId: 7, quantity: 1 },
			{ productId: 7, quantity: 1 },
			{ productId: 7, quantity: 1 },
		])
		expect(seen[1]?.cart).toBe(cart)
		expect(seen[2]?.cart).toBe(cart)
		expect(result.current.error).toBeNull()
	})

	it("delivers the options of a hook whose key is explicitly undefined", async () => {
		procedures.items.add.call.mockResolvedValue(storeCart([{ key: "a", quantity: 3 }]))
		const { options, phases, seen } = recorder()
		const key: string | undefined = undefined

		const { result } = mount(() => useCartItem(key, { ...options, defaultQuantity: 3 }))
		expect(result.current.quantity.value).toBe(3)
		act(() => result.current.addItem({ productId: 7 }))

		// The overload takes `string | undefined`, so an absent key must not be mistaken for the options object.
		await waitFor(() => expect(phases()).toEqual(["start", "success", "settled"]))
		expect(seen[0]?.input).toEqual({ productId: 7, quantity: 3 })
	})

	it("reports a refused add as start, error and settled, with the store's own code on error", async () => {
		procedures.items.add.call.mockRejectedValue(storeError("CART_ITEM_EXISTS"))
		const { options, phases, seen } = recorder()

		const { result } = mount(() => useCartItem(options))
		act(() => result.current.addItem({ productId: 7 }))

		await waitFor(() => expect(phases()).toEqual(["start", "error", "settled"]))
		expect(seen[1]?.error?.code).toBe("CART_ITEM_EXISTS")
		await waitFor(() => expect(result.current.error?.code).toBe("CART_ITEM_EXISTS"))
	})

	it("clears that failure on reset, and on the next success", async () => {
		procedures.items.add.call.mockRejectedValueOnce(storeError("CART_ITEM_EXISTS"))

		const { result } = mount(() => useCartItem())
		act(() => result.current.addItem({ productId: 7 }))
		await waitFor(() => expect(result.current.error).not.toBeNull())

		act(() => result.current.reset())
		// `reset` reaches the component through react-query's notify batch, which lands in a microtask rather than inside `act`.
		await waitFor(() => expect(result.current.error).toBeNull())

		procedures.items.add.call.mockRejectedValueOnce(storeError("CART_ITEM_EXISTS"))
		act(() => result.current.addItem({ productId: 7 }))
		await waitFor(() => expect(result.current.error).not.toBeNull())

		procedures.items.add.call.mockResolvedValue(storeCart([{ key: "a", quantity: 1 }]))
		act(() => result.current.addItem({ productId: 7 }))
		await waitFor(() => expect(result.current.error).toBeNull())
	})

	it("does not let a throwing listener turn a successful add into a failure", async () => {
		const cart = storeCart([{ key: "a", quantity: 1 }])
		procedures.items.add.call.mockResolvedValue(cart)
		const listenerFailure = new Error("the drawer blew up")
		const { restore, uncaught } = captureUncaught()

		try {
			const { result, queryClient } = mount(() =>
				useCartItem({
					onSuccess: () => {
						throw listenerFailure
					},
				}),
			)
			act(() => result.current.addItem({ productId: 7 }))

			await waitFor(() => expect(queryClient.getQueryData(cartQueryKey)).toBe(cart))
			expect(result.current.error).toBeNull()
			await waitFor(() => expect(uncaught).toContain(listenerFailure))
		} finally {
			restore()
		}
	})

	it("sends one request for one click, whatever the app sets as its mutation retry", async () => {
		procedures.items.add.call.mockRejectedValue(storeError("CART_ITEM_EXISTS"))

		const { result } = mount(() => useCartItem(), undefined, { mutations: { retry: 2 } })
		act(() => result.current.addItem({ productId: 7 }))

		await waitFor(() => expect(result.current.error?.code).toBe("CART_ITEM_EXISTS"))
		expect(procedures.items.add.call).toHaveBeenCalledTimes(1)
	})

	it("still reports a refusal that lands after reset", async () => {
		let refuse: (error: unknown) => void = () => {}
		procedures.items.add.call.mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)))

		const { result } = mount(() => useCartItem())
		act(() => result.current.addItem({ productId: 7 }))
		await waitFor(() => expect(result.current.isPending).toBe(true))

		// Resetting mid-flight must not detach the hook from the action it is still running.
		act(() => result.current.reset())
		await act(async () => refuse(storeError("CART_ITEM_EXISTS")))

		await waitFor(() => expect(result.current.error?.code).toBe("CART_ITEM_EXISTS"))
	})
})

describe("useCartItem quantity", () => {
	it("seeds the cart from a committed quantity rather than refetching", async () => {
		const saved = storeCart([{ key: "a", quantity: 2 }])
		procedures.items.update.call.mockResolvedValue(saved)

		const { result } = mount(() => ({ cart: useCart(), line: useCartItem("a") }), storeCart([{ key: "a", quantity: 1 }]))

		await act(async () => {
			result.current.line.quantity.set(2)
			await result.current.line.quantity.commit()
		})

		expect(procedures.items.update.call).toHaveBeenCalledWith({ body: { quantity: 2 }, params: { key: "a" } })
		// Structurally equal rather than the same object: react-query shares the unchanged parts of the previous cart.
		expect(result.current.cart.cart).toStrictEqual(saved)
		expect(procedures.get.call).not.toHaveBeenCalled()
	})

	it("discards a pending edit the store refused, and reports the refusal", async () => {
		procedures.items.update.call.mockRejectedValue(storeError("CART_INVALID_QUANTITY"))

		const { result } = mount(() => useCartItem("a"), storeCart([{ key: "a", quantity: 1 }]))

		await act(async () => {
			result.current.quantity.set(3)
			await result.current.quantity.commit()
		})

		await waitFor(() => expect(result.current.quantity.value).toBe(1))
		expect(result.current.quantity.isDirty).toBe(false)
		expect(result.current.error?.code).toBe("CART_INVALID_QUANTITY")
	})
})

describe("cart pending state", () => {
	it("keeps isPending to the acting line while isMutating covers the cart", async () => {
		let answer: (cart: Cart) => void = () => {}
		procedures.items.remove.call.mockReturnValue(new Promise<Cart>((resolve) => (answer = resolve)))

		const { result } = mount(
			() => ({ a: useCartItem("a"), b: useCartItem("b"), cart: useCart() }),
			storeCart([
				{ key: "a", quantity: 1 },
				{ key: "b", quantity: 1 },
			]),
		)

		act(() => result.current.a.remove())

		await waitFor(() => expect(result.current.a.isPending).toBe(true))
		expect(result.current.b.isPending).toBe(false)
		expect(result.current.cart.isMutating).toBe(true)

		await act(async () => answer(storeCart([{ key: "b", quantity: 1 }])))

		await waitFor(() => expect(result.current.cart.isMutating).toBe(false))
		expect(result.current.a.isPending).toBe(false)
	})
})

describe("cart address and shipping rates", () => {
	it("keeps isPending to the acting hook while isMutating covers the cart", async () => {
		let answer: (cart: Cart) => void = () => {}
		procedures.update.call.mockReturnValue(new Promise<Cart>((resolve) => (answer = resolve)))

		const { result } = mount(
			() => ({ address: useCartAddress(), cart: useCart(), rates: useCartShippingRates() }),
			storeCart([], [{ rates: [false] }]),
		)

		act(() => result.current.address.update({ shippingAddress: { postcode: "560001" } }))

		await waitFor(() => expect(result.current.address.isPending).toBe(true))
		// The defect this split fixes: saving an address used to be indistinguishable from choosing a rate.
		expect(result.current.rates.isPending).toBe(false)
		expect(result.current.cart.isMutating).toBe(true)

		await act(async () => answer(storeCart([], [{ rates: [true] }])))

		await waitFor(() => expect(result.current.cart.isMutating).toBe(false))
		expect(result.current.address.isPending).toBe(false)
	})

	it("reports an address failure on the address hook alone", async () => {
		procedures.update.call.mockRejectedValue(storeError("CART_INVALID_ADDRESS"))

		const { result } = mount(() => ({ address: useCartAddress(), rates: useCartShippingRates() }), storeCart([]))
		act(() => result.current.address.update({ shippingAddress: { postcode: "560001" } }))

		await waitFor(() => expect(result.current.address.error?.code).toBe("CART_INVALID_ADDRESS"))
		expect(result.current.rates.error).toBeNull()
	})

	it("answers hasSelectedShippingRates and shippingPackages from the cart it holds", async () => {
		const { result, queryClient } = mount(() => useCartShippingRates(), storeCart([], [{ rates: [false, true] }]))

		expect(result.current.shippingPackages).toHaveLength(1)
		expect(result.current.hasSelectedShippingRates).toBe(true)

		await act(async () => {
			queryClient.setQueryData(cartQueryKey, storeCart([], [{ rates: [false, false] }]))
		})

		await waitFor(() => expect(result.current.hasSelectedShippingRates).toBe(false))
	})
})

describe("cart coupons", () => {
	it("keeps isPending to the code being removed", async () => {
		let answer: (cart: Cart) => void = () => {}
		procedures.coupons.remove.call.mockReturnValue(new Promise<Cart>((resolve) => (answer = resolve)))

		const { result } = mount(() => ({
			field: useCartCoupon(),
			other: useCartCoupon("OTHER"),
			save10: useCartCoupon("SAVE10"),
		}))

		act(() => result.current.save10.remove())

		await waitFor(() => expect(result.current.save10.isPending).toBe(true))
		// Removing one coupon used to disable the apply button and every other chip.
		expect(result.current.field.isPending).toBe(false)
		expect(result.current.other.isPending).toBe(false)

		await act(async () => answer(storeCart([])))

		await waitFor(() => expect(result.current.save10.isPending).toBe(false))
	})

	it("reports a removal failure on that code alone", async () => {
		procedures.coupons.remove.call.mockRejectedValue(storeError("CART_COUPON_ERROR"))

		const { result } = mount(() => ({
			field: useCartCoupon(),
			other: useCartCoupon("OTHER"),
			save10: useCartCoupon("SAVE10"),
		}))

		act(() => result.current.save10.remove())

		await waitFor(() => expect(result.current.save10.error?.code).toBe("CART_COUPON_ERROR"))
		expect(result.current.field.error).toBeNull()
		expect(result.current.other.error).toBeNull()
	})
	it("keeps a coupon coded apply off the apply field's own scope", async () => {
		let answer: (cart: Cart) => void = () => {}
		procedures.coupons.remove.call.mockReturnValue(new Promise<Cart>((resolve) => (answer = resolve)))

		const { result } = mount(() => ({ chip: useCartCoupon("apply"), field: useCartCoupon() }))

		act(() => result.current.chip.remove())

		await waitFor(() => expect(result.current.chip.isPending).toBe(true))
		// The sentinel shares no slot with a code, so a promotion actually coded `apply` cannot disable the apply button.
		expect(result.current.field.isPending).toBe(false)

		await act(async () => answer(storeCart([])))

		await waitFor(() => expect(result.current.chip.isPending).toBe(false))
	})

	it("delivers the callbacks of a hook whose code is explicitly undefined", async () => {
		procedures.coupons.apply.call.mockResolvedValue(storeCart([]))
		const { options, phases } = recorder()
		const code: string | undefined = undefined

		const { result } = mount(() => useCartCoupon(code, options))
		act(() => result.current.apply("WELCOME10"))

		// The overload takes `string | undefined`, so an absent code must not be mistaken for the options object.
		await waitFor(() => expect(phases()).toEqual(["start", "success", "settled"]))
	})

	it("does nothing when the apply field's remove is called", async () => {
		const { result } = mount(() => useCartCoupon())

		act(() => result.current.remove())

		expect(procedures.coupons.remove.call).not.toHaveBeenCalled()
		expect(result.current.isPending).toBe(false)
	})
	it("treats an empty code as no code, so a not-yet-chosen coupon sends nothing", async () => {
		// `useState("")` is the obvious way to hold a selected code, so `""` must behave as the apply field rather than scope a
		// hook to `coupon/code/""` whose remove() would ask the store to remove an empty code.
		const { result } = mount(() => ({ chosen: useCartCoupon("SAVE10"), empty: useCartCoupon("") }))

		act(() => result.current.empty.remove())

		expect(procedures.coupons.remove.call).not.toHaveBeenCalled()
		expect(result.current.empty.isPending).toBe(false)
		expect(result.current.chosen.isPending).toBe(false)
	})
})

describe("useCart", () => {
	it("reports the fetch failure on error, and no action's", async () => {
		procedures.get.call.mockRejectedValue(storeError("CART_UNAVAILABLE"))
		procedures.items.add.call.mockRejectedValue(storeError("CART_ITEM_EXISTS"))

		const { result } = mount(() => ({ cart: useCart(), line: useCartItem() }), undefined, { cartEnabled: true })

		await waitFor(() => expect(result.current.cart.error?.code).toBe("CART_UNAVAILABLE"))

		act(() => result.current.line.addItem({ productId: 7 }))

		await waitFor(() => expect(result.current.line.error?.code).toBe("CART_ITEM_EXISTS"))
		expect(result.current.cart.error?.code).toBe("CART_UNAVAILABLE")
	})
})
