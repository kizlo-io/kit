// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import type { Cart, CartError } from "../types"
import { type CartHookOptions, useCart, useCartItem } from "./cart"
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
function storeCart(items: { key: string; quantity: number }[]) {
	return {
		coupons: [],
		itemCount: items.length,
		items: items.map(({ key, quantity }) => ({
			isSoldIndividually: false,
			key,
			quantity,
			quantityLimits: { editable: true, maximum: 10, minimum: 1, multipleOf: 1 },
		})),
	} as unknown as Cart
}

/** A refusal shaped like one of the store's: a `code` a call site can branch on. */
function storeError(code: string) {
	return Object.assign(new Error("Already in your cart."), { code }) as unknown as CartError
}

function mount<T>(hook: () => T, cart?: Cart, mutations?: { retry: number }) {
	const queryClient = new QueryClient({ defaultOptions: { mutations, queries: { retry: false } } })
	if (cart) queryClient.setQueryData(cartQueryKey, cart)

	// `cartEnabled: false` so the cart query makes no request: every cart these tests read is either seeded or answered by an
	// action. JSX is avoided because the suite only collects `src/**/*.test.ts`.
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { cartEnabled: false, children }))

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

		const { result } = mount(() => useCartItem(), undefined, { retry: 2 })
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
