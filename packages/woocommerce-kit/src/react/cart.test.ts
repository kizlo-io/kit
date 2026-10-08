// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import { defaultShouldUpdateAddress } from "../cart-address-policy"
import { fixtures } from "../test/checkout-fields-fixture"
import type { Cart, CartAddressSnapshotInput, CartError, Storefront, UpdateCartInput } from "../types"
import {
	type CartAddressApi,
	type CartHookOptions,
	useCart,
	useCartAddress,
	useCartCoupon,
	useCartItem,
	useCartShippingRates,
} from "./cart"
import { WooCommerceProvider } from "./provider"
import { storefrontQueryKey } from "./storefront"

/**
 * React Query is deliberately real here: it owns the mutation lifecycle these tests are about. Only the Kizlo client is a stub,
 * and only its `.call` — the one thing the kit asks of a procedure.
 */
const { procedures, storefront } = vi.hoisted(() => {
	const procedure = () => ({ call: vi.fn() })

	return {
		storefront: { get: { call: vi.fn(() => new Promise(() => {})) } },
		procedures: {
			coupons: { apply: procedure(), remove: procedure() },
			get: procedure(),
			items: { add: procedure(), remove: procedure(), update: procedure() },
			selectShippingRate: procedure(),
			update: procedure(),
		},
	}
})

vi.mock("kizlo/react", () => {
	const client = { woocommerce: { cart: procedures, storefront } }
	return { useKizloContext: () => ({ client }) }
})

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

function mount<T>(hook: () => T, cart?: Cart, options?: { cartEnabled?: boolean; mutations?: { retry: number }; storefront?: Storefront }) {
	const { cartEnabled = false, mutations } = options ?? {}
	const queryClient = new QueryClient({ defaultOptions: { mutations, queries: { retry: false } } })
	if (cart) queryClient.setQueryData(cartQueryKey, cart)
	if (options?.storefront) queryClient.setQueryData(storefrontQueryKey, options.storefront)

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
	vi.useRealTimers()
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

/** Address fields are partial here so each case shows exactly what is changing. */
function quoteCart(input: UpdateCartInput = {}) {
	return {
		...storeCart([]),
		shippingAddress: { country: "GB", state: "", city: "London", postcode: "SW1A 1AA", ...input.shippingAddress },
		billingAddress: { country: "GB", state: "", city: "London", postcode: "SW1A 1AA", ...input.billingAddress },
	} as Cart
}

async function settleAddress(ms = 1500) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms)
	})
}

function addressSnapshot(input: UpdateCartInput = {}): CartAddressSnapshotInput {
	const cart = quoteCart(input)
	return {
		...(input.shippingAddress && { shippingAddress: cart.shippingAddress }),
		...(input.billingAddress && { billingAddress: cart.billingAddress }),
	}
}

describe("useCartAddress snapshots", () => {
	it("requires complete pricing fields on each included automatic address", () => {
		expectTypeOf<CartAddressApi["onAddressChange"]>().parameter(0).toEqualTypeOf<CartAddressSnapshotInput>()
		expectTypeOf<{ shippingAddress: { postcode: string } }>().not.toMatchTypeOf<CartAddressSnapshotInput>()
		expectTypeOf<{
			shippingAddress: { country: string; state: string; city: string; postcode: string }
		}>().toMatchTypeOf<CartAddressSnapshotInput>()
	})

	it("sends only the latest snapshot 1500ms after the last edit, with the existing callback phases", async () => {
		vi.useFakeTimers()
		const input = addressSnapshot({ shippingAddress: { city: "Oxford", postcode: "OX1 1AA" } })
		const saved = quoteCart(input)
		procedures.update.call.mockResolvedValue(saved)
		const { options, phases, seen } = recorder()
		const { result, queryClient, unmount } = mount(() => useCartAddress(options), quoteCart())
		act(() => result.current.onAddressChange(addressSnapshot({ shippingAddress: { city: "Oxford" } })))
		await settleAddress(1000)
		act(() => result.current.onAddressChange(input))
		await settleAddress(1499)
		expect(procedures.update.call).not.toHaveBeenCalled()
		expect(phases()).toEqual([])
		expect(result.current.isPending).toBe(false)
		await settleAddress(1)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(procedures.update.call).toHaveBeenCalledWith({ body: input })
		expect(phases()).toEqual(["start", "success", "settled"])
		expect(seen.every((event) => event.type === "update_customer")).toBe(true)
		expect(seen.map((event) => event.input)).toEqual([input, input, input])
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(saved)
		unmount()
	})

	it.each([undefined, {}, { shouldUpdateAddress: undefined }])("uses the default policy with options %j", async (options) => {
		vi.useFakeTimers()
		const input = addressSnapshot({ shippingAddress: { city: "Oxford" } })
		procedures.update.call.mockResolvedValue(quoteCart(input))
		const { result, unmount } = mount(() => useCartAddress(options), quoteCart())
		act(() => result.current.onAddressChange(addressSnapshot({ shippingAddress: { postcode: "sw1a\t1aa", firstName: "Ada" } })))
		await settleAddress()
		expect(procedures.update.call).not.toHaveBeenCalled()
		act(() => result.current.onAddressChange(input))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(procedures.update.call).toHaveBeenCalledWith({ body: input })
		unmount()
	})

	it("does not lose pricing changes when a later snapshot edits the name", async () => {
		vi.useFakeTimers()
		const input = addressSnapshot({ shippingAddress: { city: "Oxford", postcode: "OX1 1AA", firstName: "Ada" } })
		procedures.update.call.mockResolvedValue(quoteCart(input))
		const { result, unmount } = mount(() => useCartAddress(), quoteCart())
		act(() => result.current.onAddressChange(addressSnapshot({ shippingAddress: { city: "Oxford", postcode: "OX1 1AA" } })))
		await settleAddress(500)
		act(() => result.current.onAddressChange(input))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(procedures.update.call).toHaveBeenCalledWith({ body: input })
		unmount()
	})

	it("sends nothing on mount, for equivalent postcodes or for personal details", async () => {
		vi.useFakeTimers()
		const { result, unmount } = mount(() => useCartAddress(), quoteCart())
		await settleAddress()
		for (const shippingAddress of [{ postcode: "sw1a\t1aa" }, { firstName: "Ada", phone: "123", company: "One" }]) {
			act(() => result.current.onAddressChange(addressSnapshot({ shippingAddress })))
			await settleAddress()
		}
		expect(procedures.update.call).not.toHaveBeenCalled()
		unmount()
	})

	it.each([{ billingAddress: { city: "Oxford" } }, { shippingAddress: { country: "AE", state: "", city: "Dubai", postcode: "" } }])(
		"pushes billing and countries without postcodes: %j",
		async (values) => {
			vi.useFakeTimers()
			const input = addressSnapshot(values)
			procedures.update.call.mockResolvedValue(quoteCart(input))
			const { result, unmount } = mount(() => useCartAddress(), quoteCart())
			act(() => result.current.onAddressChange(input))
			await settleAddress()
			expect(procedures.update.call).toHaveBeenCalledWith({ body: input })
			unmount()
		},
	)

	it("cancels a pending edit that returns to the saved address before a request starts", async () => {
		vi.useFakeTimers()
		const { result, unmount } = mount(() => ({ address: useCartAddress(), cart: useCart() }), quoteCart())
		act(() => result.current.address.onAddressChange(addressSnapshot({ shippingAddress: { city: "Oxford" } })))
		await settleAddress(500)
		expect(result.current.cart.isRepricing).toBe(true)
		act(() => result.current.address.onAddressChange(addressSnapshot({ shippingAddress: { city: "London" } })))
		await settleAddress()
		expect(procedures.update.call).not.toHaveBeenCalled()
		expect(result.current.cart.isRepricing).toBe(false)
		unmount()
	})

	it("fully replaces the default check and uses the configured delay", async () => {
		vi.useFakeTimers()
		const shouldUpdateAddress = vi.fn((input: CartAddressSnapshotInput) => (input.shippingAddress?.address1?.length ?? 0) > 3)
		const input = addressSnapshot({ shippingAddress: { address1: "Street 1" } })
		procedures.update.call.mockResolvedValue(quoteCart(input))
		const { result, unmount } = mount(
			() => ({ address: useCartAddress({ addressDebounceMs: 100, shouldUpdateAddress }), cart: useCart() }),
			quoteCart(),
		)
		act(() => result.current.address.onAddressChange(input))
		await settleAddress(99)
		expect(procedures.update.call).not.toHaveBeenCalled()
		await settleAddress(1)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(procedures.update.call).toHaveBeenCalledWith({ body: input })
		act(() => result.current.address.onAddressChange(input))
		await settleAddress(1)
		expect(result.current.cart.isRepricing).toBe(true)
		act(() => result.current.address.onAddressChange(addressSnapshot({ shippingAddress: { city: "Oxford" } })))
		await settleAddress(100)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(result.current.cart.isRepricing).toBe(false)
		unmount()
	})

	it("cancels a trailing push on unmount", async () => {
		vi.useFakeTimers()
		const writer = mount(() => useCartAddress(), quoteCart())
		act(() => writer.result.current.onAddressChange(addressSnapshot({ shippingAddress: { city: "Oxford" } })))
		writer.unmount()
		await settleAddress()
		expect(procedures.update.call).not.toHaveBeenCalled()
	})

	it("rechecks the cached cart before sending and clears the updating flag on convergence", async () => {
		vi.useFakeTimers()
		const input = addressSnapshot({ shippingAddress: { city: "Oxford" } })
		const { result, queryClient, unmount } = mount(() => ({ address: useCartAddress(), cart: useCart() }), quoteCart())
		act(() => result.current.address.onAddressChange(input))
		queryClient.setQueryData(cartQueryKey, quoteCart(input))
		await settleAddress()
		await settleAddress(1)
		expect(procedures.update.call).not.toHaveBeenCalled()
		expect(result.current.cart.isRepricing).toBe(false)
		unmount()
	})

	it("reports a refusal without automatically retrying and sends a correction without reset", async () => {
		vi.useFakeTimers()
		const failure = storeError("CART_INVALID_ADDRESS")
		procedures.update.call.mockRejectedValueOnce(failure)
		const { options, phases } = recorder()
		const original = quoteCart()
		const { result, queryClient, unmount } = mount(() => ({ address: useCartAddress(options), cart: useCart() }), original)
		act(() => result.current.address.onAddressChange(addressSnapshot({ shippingAddress: { postcode: "bad" } })))
		await settleAddress()
		await settleAddress(1)
		expect(result.current.address.error).toBe(failure)
		expect(phases()).toEqual(["start", "error", "settled"])
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(original)
		expect(result.current.cart.isRepricing).toBe(false)
		await settleAddress(6000)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		const correction = addressSnapshot({ shippingAddress: { postcode: "SW1A 2AA" } })
		procedures.update.call.mockResolvedValueOnce(quoteCart(correction))
		act(() => result.current.address.onAddressChange(correction))
		await settleAddress()
		await settleAddress(1)
		expect(procedures.update.call).toHaveBeenCalledTimes(2)
		expect(result.current.address.error).toBeNull()
		expect(result.current.cart.isRepricing).toBe(false)
		unmount()
	})

	it.each(["shippingAddress", "billingAddress"] as const)("clears a rejected %s edit when reverting to the saved address", async (key) => {
		vi.useFakeTimers()
		const failure = storeError("CART_INVALID_ADDRESS")
		procedures.update.call.mockRejectedValueOnce(failure)
		const original = quoteCart()
		const { result, queryClient, unmount } = mount(() => ({ address: useCartAddress(), cart: useCart() }), original)
		act(() => result.current.address.onAddressChange(addressSnapshot({ [key]: { postcode: "bad" } })))
		await settleAddress()
		await settleAddress(1)
		expect(result.current.address.error).toBe(failure)
		// Normalized pricing values still represent the valid saved address.
		act(() => result.current.address.onAddressChange(addressSnapshot({ [key]: { country: " GB ", postcode: "sw1a1aa" } })))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(original)
		expect(result.current.address.error).toBeNull()
		expect(result.current.cart.isRepricing).toBe(false)
		const canSubmit = !result.current.cart.isRepricing && !result.current.address.error
		expect(canSubmit).toBe(true)
		unmount()
	})

	it("clears the stale failure after a revert queued during a rejected save", async () => {
		vi.useFakeTimers()
		let refuse: (error: CartError) => void = () => {}
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((_, reject) => {
				refuse = reject
			}),
		)
		const { result, unmount } = mount(() => ({ address: useCartAddress(), cart: useCart() }), quoteCart())
		act(() => result.current.address.onAddressChange(addressSnapshot({ shippingAddress: { postcode: "bad" } })))
		await settleAddress()
		act(() => result.current.address.onAddressChange(addressSnapshot({ shippingAddress: {} })))
		await settleAddress()
		expect(result.current.cart.isRepricing).toBe(true)
		await act(async () => refuse(storeError("CART_INVALID_ADDRESS")))
		await settleAddress(1)
		expect(result.current.address.error).not.toBeNull()
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(result.current.address.error).toBeNull()
		expect(result.current.cart.isRepricing).toBe(false)
		unmount()
	})

	it.each([
		{ label: "empty input", input: {} },
		{ label: "invalid country", input: { shippingAddress: { country: "" } } },
		{ label: "unsaved street", input: { shippingAddress: { address1: "New street" } } },
		{ label: "unsaved name", input: { shippingAddress: { firstName: "Grace" } } },
		{ label: "missing cart", input: { shippingAddress: {} }, missingCart: true },
	])("retains the failure for $label instead of dismissing it on a false predicate", async ({ input, missingCart }) => {
		vi.useFakeTimers()
		const failure = storeError("CART_INVALID_ADDRESS")
		procedures.update.call.mockRejectedValueOnce(failure)
		const { result, queryClient, unmount } = mount(
			() => ({ address: useCartAddress({ shouldUpdateAddress: () => false }), cart: useCart() }),
			quoteCart(),
		)
		act(() => result.current.address.update({ shippingAddress: { postcode: "bad" } }))
		await settleAddress(1)
		expect(result.current.address.error).toBe(failure)
		if (missingCart) queryClient.setQueryData(cartQueryKey, null)
		act(() => result.current.address.onAddressChange(addressSnapshot(input)))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(result.current.address.error).toBe(failure)
		expect(result.current.cart.isRepricing).toBe(false)
		unmount()
	})

	it.each([false, true])("waits for another hook's immediate save and skips a converged snapshot: %s", async (converged) => {
		vi.useFakeTimers()
		let answer: (cart: Cart) => void = () => {}
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((resolve) => {
				answer = resolve
			}),
		)
		const input = addressSnapshot({ shippingAddress: { postcode: "SW1A 2AA" } })
		if (!converged) procedures.update.call.mockResolvedValueOnce(quoteCart(input))
		const { result, unmount } = mount(() => ({ first: useCartAddress(), second: useCartAddress() }), quoteCart())
		act(() => {
			result.current.first.update({ shippingAddress: { city: "Oxford" } })
			result.current.second.onAddressChange(input)
		})
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		await act(async () => answer(quoteCart(converged ? input : { shippingAddress: { city: "Oxford" } })))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(converged ? 1 : 2)
		if (!converged) expect(procedures.update.call).toHaveBeenLastCalledWith({ body: input })
		unmount()
	})

	it("saves a revert made while the previous snapshot is in flight", async () => {
		vi.useFakeTimers()
		let answer: (cart: Cart) => void = () => {}
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((resolve) => {
				answer = resolve
			}),
		)
		const changed = addressSnapshot({ shippingAddress: { postcode: "SW1A 2AA" } })
		const reverted = addressSnapshot({ shippingAddress: { postcode: "SW1A 1AA" } })
		procedures.update.call.mockResolvedValueOnce(quoteCart(reverted))
		const { result, queryClient, unmount } = mount(() => useCartAddress(), quoteCart())
		act(() => result.current.onAddressChange(changed))
		await settleAddress()
		act(() => result.current.onAddressChange(reverted))
		await act(async () => answer(quoteCart(changed)))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(2)
		expect(procedures.update.call).toHaveBeenLastCalledWith({ body: reverted })
		expect(queryClient.getQueryData<Cart>(cartQueryKey)?.shippingAddress.postcode).toBe("SW1A 1AA")
		unmount()
	})

	it("retains only the latest snapshot during an in-flight save, without overlap", async () => {
		vi.useFakeTimers()
		let answer: (cart: Cart) => void = () => {}
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((resolve) => {
				answer = resolve
			}),
		)
		const first = addressSnapshot({ shippingAddress: { postcode: "SW1A 2AA" } })
		const latest = addressSnapshot({ shippingAddress: { postcode: "SW1A 3AA" } })
		procedures.update.call.mockResolvedValueOnce(quoteCart(latest))
		const { result, unmount } = mount(() => useCartAddress(), quoteCart())
		act(() => result.current.onAddressChange(first))
		await settleAddress()
		act(() => result.current.onAddressChange(addressSnapshot({ shippingAddress: { postcode: "SW1A 2AB" } })))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		act(() => result.current.onAddressChange(latest))
		await act(async () => answer(quoteCart(first)))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(2)
		expect(procedures.update.call).toHaveBeenLastCalledWith({ body: latest })
		unmount()
	})

	it("keeps isRepricing shared through debounce, request and follow-up while isMutating only covers requests", async () => {
		vi.useFakeTimers()
		let answerFirst: (cart: Cart) => void = () => {}
		let answerSecond: (cart: Cart) => void = () => {}
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((resolve) => {
				answerFirst = resolve
			}),
		)
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((resolve) => {
				answerSecond = resolve
			}),
		)
		const first = addressSnapshot({ shippingAddress: { city: "Oxford" } })
		const second = addressSnapshot({ shippingAddress: { city: "Cambridge" } })
		const { result, unmount } = mount(() => ({ address: useCartAddress(), summary: useCart(), button: useCart() }), quoteCart())
		act(() => result.current.address.onAddressChange(first))
		await settleAddress(1)
		expect(result.current.summary.isRepricing).toBe(true)
		expect(result.current.button.isRepricing).toBe(true)
		expect(result.current.summary.isMutating).toBe(false)
		await settleAddress(1499)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		await settleAddress(1)
		expect(result.current.summary.isRepricing).toBe(true)
		expect(result.current.summary.isMutating).toBe(true)
		act(() => result.current.address.onAddressChange(second))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		await act(async () => answerFirst(quoteCart(first)))
		await settleAddress(1)
		expect(result.current.summary.isRepricing).toBe(true)
		expect(result.current.summary.isMutating).toBe(false)
		await settleAddress(1499)
		expect(procedures.update.call).toHaveBeenCalledTimes(2)
		expect(result.current.summary.isRepricing).toBe(true)
		await act(async () => answerSecond(quoteCart(second)))
		await settleAddress(1)
		expect(result.current.summary.isRepricing).toBe(false)
		expect(result.current.button.isRepricing).toBe(false)
		unmount()
	})

	it("clears only the unmounted writer's marker and still shows its in-flight save", async () => {
		vi.useFakeTimers()
		let answer: (cart: Cart) => void = () => {}
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((resolve) => {
				answer = resolve
			}),
		)
		const first = addressSnapshot({ shippingAddress: { city: "Oxford" } })
		const second = addressSnapshot({ shippingAddress: { city: "Cambridge" } })
		procedures.update.call.mockResolvedValueOnce(quoteCart(second))
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		queryClient.setQueryData(cartQueryKey, quoteCart())
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { cartEnabled: false, children }))
		const reader = renderHook(() => useCart(), { wrapper })
		const one = renderHook(() => useCartAddress(), { wrapper })
		const two = renderHook(() => useCartAddress(), { wrapper })
		act(() => {
			one.result.current.onAddressChange(first)
			two.result.current.onAddressChange(second)
		})
		one.unmount()
		await settleAddress(1)
		expect(reader.result.current.isRepricing).toBe(true)
		await settleAddress(1499)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(procedures.update.call).toHaveBeenCalledWith({ body: second })
		two.unmount()
		await settleAddress(1)
		expect(reader.result.current.isRepricing).toBe(true)
		await act(async () => answer(quoteCart(second)))
		await settleAddress(1)
		// No second request should consume the queued fallback response.
		procedures.update.call.mockReset()
	})

	it("waits for an in-flight save before rejecting a queued snapshot and clears repricing", async () => {
		vi.useFakeTimers()
		let answer: (cart: Cart) => void = () => {}
		procedures.update.call.mockReturnValueOnce(
			new Promise<Cart>((resolve) => {
				answer = resolve
			}),
		)
		const shouldUpdateAddress = vi.fn((input: CartAddressSnapshotInput) => input.shippingAddress?.country === "GB")
		const { result, unmount } = mount(() => ({ address: useCartAddress({ shouldUpdateAddress }), cart: useCart() }), quoteCart())
		act(() => result.current.address.update({ shippingAddress: { city: "Oxford" } }))
		await settleAddress(1)
		act(() => result.current.address.onAddressChange(addressSnapshot({ shippingAddress: { country: "", city: "Cambridge" } })))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(shouldUpdateAddress).not.toHaveBeenCalled()
		expect(result.current.cart.isRepricing).toBe(true)
		await act(async () => answer(quoteCart({ shippingAddress: { city: "Oxford" } })))
		await settleAddress()
		await settleAddress(1)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(shouldUpdateAddress).toHaveBeenCalledTimes(1)
		expect(result.current.cart.isRepricing).toBe(false)
		unmount()
	})

	it("clones the supplied snapshot so later in-place form changes cannot alter the queued request", async () => {
		vi.useFakeTimers()
		const input = addressSnapshot({ shippingAddress: { city: "Oxford", additionalFields: { "consumer/reference": "Original" } } })
		procedures.update.call.mockResolvedValue(quoteCart(input))
		const { result, unmount } = mount(() => useCartAddress(), quoteCart())
		act(() => result.current.onAddressChange(input))
		if (input.shippingAddress) {
			input.shippingAddress.city = "Cambridge"
			if (input.shippingAddress.additionalFields) input.shippingAddress.additionalFields["consumer/reference"] = "Later"
		}
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledWith({
			body: addressSnapshot({ shippingAddress: { city: "Oxford", additionalFields: { "consumer/reference": "Original" } } }),
		})
		unmount()
	})
	it("flushes promptly and cancellation resolves queued async waiters without a request", async () => {
		vi.useFakeTimers()
		procedures.update.call.mockResolvedValue(quoteCart())
		const { result, unmount } = mount(() => useCartAddress(), quoteCart())
		let cancelled: Promise<Cart | undefined> | undefined
		act(() => {
			cancelled = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: { city: "Cancelled" } }))
			result.current.cancel()
		})
		await expect(cancelled).resolves.toBeUndefined()
		await settleAddress()
		expect(procedures.update.call).not.toHaveBeenCalled()
		act(() => {
			result.current.onAddressChange(addressSnapshot({ shippingAddress: { city: "Flush" } }))
			result.current.flush()
		})
		await settleAddress(1)
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		unmount()
	})
})

describe("useCartAddress checkout policy", () => {
	function forcedSource() {
		const source = fixtures([])
		source.storefront.checkout.forcedBillingAddress = true
		return source
	}
	it("saves a billing-only snapshot as both physical addresses and compares the derived shipping destination", async () => {
		vi.useFakeTimers()
		const source = forcedSource()
		const billingAddress = source.cart.billingAddress
		const { email: _email, taxId: _taxId, ...shippingAddress } = billingAddress
		const saved = { ...source.cart, billingAddress, shippingAddress }
		procedures.update.call.mockResolvedValue(saved)
		const guard = vi.fn((input: CartAddressSnapshotInput, cart: Cart | null) => defaultShouldUpdateAddress(input, cart))
		const { result, queryClient, unmount } = mount(() => useCartAddress({ shouldUpdateAddress: guard }), source.cart, {
			storefront: source.storefront,
		})
		const input = Object.freeze({ billingAddress })
		act(() => result.current.onAddressChange(input))
		expect(guard.mock.calls[0]?.[0]).toMatchObject({ shippingAddress: { country: "IN", postcode: "560001" } })
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledWith({ body: { billingAddress, shippingAddress } })
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(saved)
		act(() => result.current.onAddressChange(input))
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(input).toEqual({ billingAddress })
		unmount()
	})
	it("resolves partial billing edits against the acknowledged billing address and overrides stale shipping", async () => {
		const source = forcedSource()
		const saved = { ...source.cart, shippingAddress: { ...source.cart.shippingAddress, country: "IN", postcode: "570001" } }
		procedures.update.call.mockResolvedValue(saved)
		const { result, queryClient } = mount(() => useCartAddress(), source.cart, { storefront: source.storefront })
		let acknowledged!: Cart
		await act(async () => {
			acknowledged = await result.current.updateAsync({ billingAddress: { postcode: "570001" } })
		})
		const body = procedures.update.call.mock.calls[0]?.[0].body
		expect(body.billingAddress).toEqual({ postcode: "570001" })
		expect(body.shippingAddress).toMatchObject({ firstName: "Ada", country: "IN", state: "KA", postcode: "570001" })
		expect(body.shippingAddress).not.toHaveProperty("email")
		expect(body.shippingAddress).not.toHaveProperty("taxId")
		expect(acknowledged).toBe(saved)
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(saved)
	})
	it("derives billing for shipping-first patches while honoring explicit separate billing and stripping the control", async () => {
		const source = fixtures([])
		source.storefront.checkout.forcedBillingAddress = false
		procedures.update.call.mockResolvedValue(source.cart)
		const { result } = mount(() => useCartAddress(), source.cart, { storefront: source.storefront })
		await act(async () => {
			await result.current.updateAsync({ shippingAddress: { postcode: "NEW" } })
		})
		expect(procedures.update.call.mock.calls[0]?.[0].body).toMatchObject({
			shippingAddress: { postcode: "NEW" },
			billingAddress: { country: "GB", state: "", postcode: "NEW", email: "ada@example.com", taxId: "TAX" },
		})
		await act(async () => {
			await result.current.updateAsync({
				shippingAddress: { postcode: "SHIP" },
				billingAddress: { postcode: "BILL" },
				useShippingAsBilling: false,
			})
		})
		expect(procedures.update.call.mock.calls[1]?.[0].body).toEqual({
			shippingAddress: { postcode: "SHIP" },
			billingAddress: { postcode: "BILL" },
		})
		await act(async () => {
			await result.current.updateAsync({
				shippingAddress: { postcode: "SHARED" },
				billingAddress: { postcode: "STALE" },
				useShippingAsBilling: true,
			})
		})
		expect(procedures.update.call.mock.calls[2]?.[0].body.billingAddress.postcode).toBe("SHARED")
		expect(procedures.update.call.mock.calls[2]?.[0].body).not.toHaveProperty("useShippingAsBilling")
	})
	it("reprojects a queued snapshot using refreshed settings and acknowledges the normalized request", async () => {
		vi.useFakeTimers()
		const source = fixtures([])
		source.storefront.checkout.forcedBillingAddress = false
		const saved = { ...source.cart, shippingAddress: { ...source.cart.shippingAddress, country: "IN", postcode: "NEW" } }
		procedures.update.call.mockResolvedValue(saved)
		const { result, queryClient, unmount } = mount(() => useCartAddress(), source.cart, { storefront: source.storefront })
		const input = { billingAddress: { ...source.cart.billingAddress, postcode: "NEW" }, useShippingAsBilling: false }
		let promise!: Promise<Cart | undefined>
		act(() => {
			promise = result.current.onAddressChangeAsync(input)
		})
		act(() =>
			queryClient.setQueryData(storefrontQueryKey, {
				...source.storefront,
				checkout: { ...source.storefront.checkout, forcedBillingAddress: true },
			}),
		)
		await settleAddress()
		expect(await promise).toBe(saved)
		expect(procedures.update.call.mock.calls[0]?.[0].body.shippingAddress).toMatchObject({ country: "IN", postcode: "NEW" })
		unmount()
	})
	it("derives a queued address from the latest acknowledgement after an in-flight save", async () => {
		vi.useFakeTimers()
		const source = forcedSource()
		let acknowledge!: (cart: Cart) => void
		const request = new Promise<Cart>((resolve) => {
			acknowledge = resolve
		})
		const first = {
			...source.cart,
			billingAddress: { ...source.cart.billingAddress, firstName: "Acknowledged", postcode: "570001" },
			shippingAddress: { ...source.cart.shippingAddress, country: "IN", postcode: "570001" },
		}
		const second = { ...first, shippingAddress: { ...first.shippingAddress, firstName: "Acknowledged", postcode: "580001" } }
		procedures.update.call.mockReturnValueOnce(request).mockResolvedValueOnce(second)
		const { result, unmount } = mount(() => useCartAddress(), source.cart, { storefront: source.storefront })
		let pending!: Promise<Cart>, queued!: Promise<Cart | undefined>
		act(() => {
			pending = result.current.updateAsync({ billingAddress: { postcode: "570001" } })
		})
		await act(async () => {})
		act(() => {
			queued = result.current.onAddressChangeAsync({
				billingAddress: { country: "IN", state: "KA", city: "Bengaluru", postcode: "580001" },
			})
		})
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		await act(async () => {
			acknowledge(first)
			await pending
		})
		await settleAddress()
		expect(await queued).toBe(second)
		expect(procedures.update.call.mock.calls[1]?.[0].body.shippingAddress).toMatchObject({
			firstName: "Acknowledged",
			country: "IN",
			postcode: "580001",
		})
		unmount()
	})
})

function deferredCart() {
	let resolve!: (cart: Cart) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<Cart>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

const directActions = ["address", "shipping", "add", "itemRemove", "apply", "couponRemove"] as const
function useActionHook(action: (typeof directActions)[number], options: CartHookOptions) {
	const address = useCartAddress(options)
	const shipping = useCartShippingRates(options)
	const item = useCartItem("a", options)
	const coupon = useCartCoupon("SAVE", options)
	const other = useCartItem("b")
	const cart = useCart()
	switch (action) {
		case "address":
			return {
				...address,
				cart,
				other,
				call: () => address.update({ shippingAddress: { postcode: "OX1" } }),
				callAsync: () => address.updateAsync({ shippingAddress: { postcode: "OX1" } }),
			}
		case "shipping":
			return {
				...shipping,
				cart,
				other,
				call: () => shipping.selectShippingRate("rate", 2),
				callAsync: () => shipping.selectShippingRateAsync("rate", 2),
			}
		case "add":
			return { ...item, cart, other, call: () => item.addItem({ productId: 7 }), callAsync: () => item.addItemAsync({ productId: 7 }) }
		case "itemRemove":
			return { ...item, cart, other, call: item.remove, callAsync: item.removeAsync }
		case "apply":
			return { ...coupon, cart, other, call: () => coupon.apply("WELCOME"), callAsync: () => coupon.applyAsync("WELCOME") }
		case "couponRemove":
			return { ...coupon, cart, other, call: coupon.remove, callAsync: coupon.removeAsync }
	}
}
const actionProcedures = {
	address: procedures.update,
	shipping: procedures.selectShippingRate,
	add: procedures.items.add,
	itemRemove: procedures.items.remove,
	apply: procedures.coupons.apply,
	couponRemove: procedures.coupons.remove,
}

describe("paired cart actions", () => {
	it.each(directActions)("%s preserves inputs, cache, lifecycle and immediate return", async (action) => {
		const saved = storeCart([{ key: "a", quantity: 2 }])
		const procedure = actionProcedures[action].call
		procedure.mockResolvedValue(saved)
		const { options, phases } = recorder()
		const { result, queryClient } = mount(() => useActionHook(action, options), storeCart([{ key: "a", quantity: 1 }]))
		act(() => expect(result.current.call()).toBeUndefined())
		await waitFor(() => expect(phases()).toHaveLength(3))
		const firstInput = procedure.mock.calls[0]
		await act(async () => expect(await result.current.callAsync()).toBe(saved))
		expect(procedure).toHaveBeenCalledTimes(2)
		expect(procedure.mock.calls[1]).toEqual(firstInput)
		expect(phases()).toEqual(["start", "success", "settled", "start", "success", "settled"])
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(saved)
	})

	it.each(directActions)("%s awaits rejection, preserves scope and permits retry", async (action) => {
		const request = deferredCart()
		const error = storeError("CART_UNAVAILABLE")
		const procedure = actionProcedures[action].call
		procedure.mockReturnValueOnce(request.promise)
		const { options, phases } = recorder()
		const { result } = mount(() => useActionHook(action, options), storeCart([{ key: "a", quantity: 1 }]), { mutations: { retry: 2 } })
		let settled = false
		let promise!: Promise<Cart | undefined>
		act(() => {
			promise = result.current.callAsync()
			void promise.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)
		})
		await waitFor(() => expect(result.current.isPending).toBe(true))
		expect(result.current.other.isPending).toBe(false)
		expect(result.current.cart.isMutating).toBe(true)
		expect(settled).toBe(false)
		await act(async () => {
			request.reject(error)
			await expect(promise).rejects.toBe(error)
		})
		expect(procedure).toHaveBeenCalledTimes(1)
		expect(phases()).toEqual(["start", "error", "settled"])
		await waitFor(() => expect(result.current.error).toBe(error))
		const saved = storeCart([{ key: "a", quantity: 2 }])
		procedure.mockResolvedValueOnce(saved)
		await act(async () => expect(await result.current.callAsync()).toBe(saved))
		await waitFor(() => expect(result.current.error).toBeNull())
	})

	it("skips missing removals and preserves draft quantity defaults", async () => {
		const { options, phases } = recorder()
		const { result } = mount(
			() => ({
				draft: useCartItem({ ...options, defaultQuantity: 4 }),
				missing: useCartItem("missing", options),
				coupon: useCartCoupon("", options),
			}),
			storeCart([]),
		)
		await act(async () => {
			expect(await result.current.draft.removeAsync()).toBeUndefined()
			expect(await result.current.missing.removeAsync()).toBeUndefined()
			expect(await result.current.coupon.removeAsync()).toBeUndefined()
		})
		expect(phases()).toEqual([])
		expect(procedures.items.remove.call).not.toHaveBeenCalled()
		expect(procedures.coupons.remove.call).not.toHaveBeenCalled()
		procedures.items.add.call.mockResolvedValue(storeCart([]))
		await act(async () => {
			await result.current.draft.addItemAsync({ productId: 7 })
		})
		expect(procedures.items.add.call).toHaveBeenLastCalledWith({ body: { productId: 7, quantity: 4 } })
		await act(async () => {
			await result.current.draft.addItemAsync({ productId: 7, quantity: 2 })
		})
		expect(procedures.items.add.call).toHaveBeenLastCalledWith({ body: { productId: 7, quantity: 2 } })
	})

	it("keeps a listener failure separate from the async request outcome", async () => {
		const saved = storeCart([])
		procedures.items.add.call.mockResolvedValueOnce(saved)
		const listenerFailure = new Error("listener failed")
		const { restore, uncaught } = captureUncaught()
		const settled = vi.fn()
		try {
			const { result } = mount(() =>
				useCartItem({
					onSuccess: () => {
						throw listenerFailure
					},
					onSettled: settled,
				}),
			)
			await act(async () => expect(await result.current.addItemAsync({ productId: 7 })).toBe(saved))
			expect(settled).toHaveBeenCalledTimes(1)
			expect(result.current.error).toBeNull()
			await waitFor(() => expect(uncaught).toContain(listenerFailure))
		} finally {
			restore()
		}
	})

	it("does not deduplicate concurrent direct calls", async () => {
		const first = deferredCart()
		const second = deferredCart()
		procedures.coupons.apply.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
		const { options, phases } = recorder()
		const { result } = mount(() => useCartCoupon(options), storeCart([]))
		let a!: Promise<Cart>
		let b!: Promise<Cart>
		act(() => {
			a = result.current.applyAsync("SAVE")
			b = result.current.applyAsync("SAVE")
		})
		await waitFor(() => expect(procedures.coupons.apply.call).toHaveBeenCalledTimes(2))
		const saved = storeCart([])
		await act(async () => {
			second.resolve(saved)
			await b
		})
		expect(result.current.isPending).toBe(true)
		await act(async () => {
			first.resolve(saved)
			await a
		})
		expect(phases().filter((phase) => phase === "settled")).toHaveLength(2)
	})
})

describe("awaitable address queue", () => {
	it("coalesces mixed handlers into the latest snapshot and awaits acknowledgement", async () => {
		vi.useFakeTimers()
		const request = deferredCart()
		procedures.update.call.mockReturnValueOnce(request.promise)
		const { options, phases } = recorder()
		const { result, unmount } = mount(() => useCartAddress(options), quoteCart())
		let a!: Promise<Cart | undefined>
		let b!: Promise<Cart | undefined>
		act(() => {
			a = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: { city: "Oxford" } }))
		})
		await settleAddress(500)
		const input = addressSnapshot({ shippingAddress: { city: "Cambridge", postcode: "CB1" } })
		act(() => {
			b = result.current.onAddressChangeAsync(input)
			result.current.onAddressChange(input)
		})
		let settled = false
		void a.then(() => {
			settled = true
		})
		await settleAddress(1499)
		expect(procedures.update.call).not.toHaveBeenCalled()
		await settleAddress(1)
		expect(settled).toBe(false)
		expect(procedures.update.call).toHaveBeenCalledWith({ body: input })
		const saved = quoteCart(input)
		await act(async () => {
			request.resolve(saved)
			expect(await a).toBe(saved)
			expect(await b).toBe(saved)
		})
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		expect(phases()).toEqual(["start", "success", "settled"])
		unmount()
	})

	it("settles skipped, reverted and unmounted queued batches without a request", async () => {
		vi.useFakeTimers()
		const { options, phases } = recorder()
		const { result, unmount } = mount(() => useCartAddress(options), quoteCart())
		await act(async () =>
			expect(await result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: { country: "" } }))).toBeUndefined(),
		)
		let pending!: Promise<Cart | undefined>
		act(() => {
			pending = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: { city: "Oxford" } }))
			result.current.onAddressChange(addressSnapshot({ shippingAddress: {} }))
		})
		await expect(pending).resolves.toBeUndefined()
		act(() => {
			pending = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: { city: "Oxford" } }))
		})
		unmount()
		await expect(pending).resolves.toBeUndefined()
		await settleAddress()
		expect(procedures.update.call).not.toHaveBeenCalled()
		expect(phases()).toEqual([])
	})

	it("rechecks a queued batch against the acknowledged cart and custom guard", async () => {
		vi.useFakeTimers()
		let allow = true
		const { result, unmount } = mount(() => useCartAddress({ shouldUpdateAddress: () => allow }), quoteCart())
		let pending!: Promise<Cart | undefined>
		act(() => {
			pending = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: { city: "Oxford" } }))
		})
		allow = false
		await settleAddress()
		await expect(pending).resolves.toBeUndefined()
		expect(procedures.update.call).not.toHaveBeenCalled()
		unmount()
	})

	it("keeps edits during a request in a separate batch, preserving rejection and retry", async () => {
		vi.useFakeTimers()
		const first = deferredCart()
		const second = deferredCart()
		procedures.update.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
		const { result, unmount } = mount(() => useCartAddress(), quoteCart())
		let a!: Promise<Cart | undefined>
		let b!: Promise<Cart | undefined>
		const oxford = addressSnapshot({ shippingAddress: { city: "Oxford" } })
		act(() => {
			a = result.current.onAddressChangeAsync(oxford)
		})
		await settleAddress()
		act(() => {
			b = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: {} }))
		})
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(1)
		await act(async () => {
			first.resolve(quoteCart(oxford))
			await a
		})
		await settleAddress()
		expect(procedures.update.call).toHaveBeenCalledTimes(2)
		const error = storeError("CART_UNAVAILABLE")
		await act(async () => {
			second.reject(error)
			await expect(b).rejects.toBe(error)
		})
		const saved = quoteCart()
		procedures.update.call.mockResolvedValueOnce(saved)
		act(() => {
			b = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: {} }))
		})
		await settleAddress()
		await expect(b).resolves.toBe(saved)
		unmount()
	})

	it("allows dispatched requests to settle after unmount", async () => {
		vi.useFakeTimers()
		const request = deferredCart()
		procedures.update.call.mockReturnValueOnce(request.promise)
		const { options, phases } = recorder()
		const { result, unmount } = mount(() => useCartAddress(options), quoteCart())
		let pending!: Promise<Cart | undefined>
		act(() => {
			pending = result.current.onAddressChangeAsync(addressSnapshot({ shippingAddress: { city: "Oxford" } }))
		})
		await settleAddress()
		unmount()
		const saved = quoteCart({ shippingAddress: { city: "Oxford" } })
		request.resolve(saved)
		await expect(pending).resolves.toBe(saved)
		expect(phases()).toEqual(["start", "success", "settled"])
	})
})

describe("awaitable quantity commits", () => {
	it("cancels the timer and awaits the single save with the normal lifecycle", async () => {
		vi.useFakeTimers()
		const request = deferredCart()
		procedures.items.update.call.mockReturnValueOnce(request.promise)
		const { options, phases } = recorder()
		const { result, unmount } = mount(() => useCartItem("a", options), storeCart([{ key: "a", quantity: 1 }]))
		let pending!: Promise<Cart | undefined>
		let settled = false
		act(() => {
			result.current.quantity.set(3)
			pending = result.current.quantity.commitAsync()
			void pending.then(() => {
				settled = true
			})
		})
		await settleAddress(400)
		expect(settled).toBe(false)
		expect(procedures.items.update.call).toHaveBeenCalledTimes(1)
		const saved = storeCart([{ key: "a", quantity: 3 }])
		await act(async () => {
			request.resolve(saved)
			expect(await pending).toBe(saved)
		})
		expect(result.current.quantity.isDirty).toBe(false)
		expect(phases()).toEqual(["start", "success", "settled"])
		unmount()
	})

	it("rejects, discards the refused edit and allows a new explicit retry", async () => {
		const error = storeError("CART_INVALID_QUANTITY")
		procedures.items.update.call.mockRejectedValueOnce(error)
		const { result } = mount(() => useCartItem("a", { autoCommit: false }), storeCart([{ key: "a", quantity: 1 }]))
		await act(async () => {
			result.current.quantity.set(3)
			await expect(result.current.quantity.commitAsync()).rejects.toBe(error)
		})
		expect(result.current.quantity.value).toBe(1)
		expect(result.current.quantity.isDirty).toBe(false)
		await waitFor(() => expect(result.current.error).toBe(error))
		const saved = storeCart([{ key: "a", quantity: 3 }])
		procedures.items.update.call.mockResolvedValueOnce(saved)
		await act(async () => {
			result.current.quantity.set(3)
			expect(await result.current.quantity.commitAsync()).toBe(saved)
		})
		await waitFor(() => expect(result.current.error).toBeNull())
	})

	it("skips clean, keyless and missing-line controls", async () => {
		const { result } = mount(
			() => ({ clean: useCartItem("a"), draft: useCartItem(), missing: useCartItem("missing") }),
			storeCart([{ key: "a", quantity: 1 }]),
		)
		await act(async () => {
			expect(await result.current.clean.quantity.commitAsync()).toBeUndefined()
			result.current.draft.quantity.set(3)
			expect(await result.current.draft.quantity.commitAsync()).toBeUndefined()
			result.current.missing.quantity.set(3)
			expect(await result.current.missing.quantity.commitAsync()).toBeUndefined()
		})
		expect(procedures.items.update.call).not.toHaveBeenCalled()
	})
})
