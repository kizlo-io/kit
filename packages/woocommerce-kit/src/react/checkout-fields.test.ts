// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode, useLayoutEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { field, fixtures } from "../test/checkout-fields-fixture"
import type { Cart, Checkout, CheckoutFieldValues } from "../types"
import { useCart, useCartAddress, useCartShippingRates } from "./cart"
import { useCheckout } from "./checkout"
import { useCheckoutFields } from "./checkout-fields"
import { WooCommerceProvider } from "./provider"
import { addressQueueKey } from "./session-queries"
import { storefrontQueryKey } from "./storefront"

const { procedures } = vi.hoisted(() => {
	const procedure = () => ({ call: vi.fn() })
	return {
		procedures: {
			checkout: { get: procedure(), confirm: procedure() },
			cart: { get: procedure(), update: procedure(), selectShippingRate: procedure() },
			storefront: { get: procedure() },
		},
	}
})
vi.mock("kizlo/react", () => ({ useKizloContext: () => ({ client: { woocommerce: procedures } }) }))
const clients: QueryClient[] = []
function mount<T>(hook: () => T, options: { cartEnabled?: boolean; client?: QueryClient } = {}) {
	const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
	clients.push(client)
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client }, createElement(WooCommerceProvider, { cartEnabled: options.cartEnabled, children }))
	return { client, ...renderHook(hook, { wrapper }) }
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
beforeEach(() => {
	const source = fixtures()
	procedures.checkout.get.call.mockResolvedValue(source.checkout)
	procedures.cart.get.call.mockResolvedValue(source.cart)
	procedures.storefront.get.call.mockResolvedValue(source.storefront)
})
afterEach(() => {
	cleanup()
	clients.forEach((client) => {
		client.clear()
	})
	clients.length = 0
	vi.resetAllMocks()
})

describe("useCheckoutFields shared sources", () => {
	it("waits for checkout-seeded cart with nullable initialization and no competing cart fetch", async () => {
		const checkout = deferred<Checkout>()
		procedures.checkout.get.call.mockReturnValue(checkout.promise)
		const source = fixtures()
		const { result, client } = mount(() => useCheckoutFields())
		expect(result.current.isLoading).toBe(true)
		expect(result.current.defaultValues).toBeNull()
		expect(result.current.schema).toBeNull()
		await waitFor(() => expect(procedures.storefront.get.call).toHaveBeenCalledTimes(1))
		expect(procedures.cart.get.call).not.toHaveBeenCalled()
		await act(async () => checkout.resolve(source.checkout))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		expect(result.current.defaultValues).toMatchObject(source.values)
		expect(result.current.fields.order[0]?.required).toBe(true)
		expect(client.getQueryData(cartQueryKey)).toEqual(source.cart)
		expect(procedures.cart.get.call).not.toHaveBeenCalled()
		expect(result.current.isLoading).toBe(false)
	})
	it("shares queries with mounted checkout/cart hooks and preserves confirmation behavior", async () => {
		const source = fixtures()
		procedures.checkout.confirm.call.mockResolvedValue(source.checkout)
		const { result } = mount(() => ({ fields: useCheckoutFields(), checkout: useCheckout(), cart: useCart() }))
		await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
		expect(procedures.checkout.get.call).toHaveBeenCalledTimes(1)
		expect(procedures.cart.get.call).toHaveBeenCalledTimes(1)
		expect(result.current.cart.cart).toEqual(source.cart)
		act(() => result.current.checkout.confirm({ ...source.values, billingAddress: source.checkout.billingAddress, paymentMethod: "bacs" }))
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
	})
	it("reads an existing cart while checkout bootstrap remains pending", async () => {
		const source = fixtures()
		const checkout = deferred<Checkout>()
		procedures.checkout.get.call.mockReturnValue(checkout.promise)
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		client.setQueryData(cartQueryKey, source.cart)
		const { result } = mount(() => useCheckoutFields({ values: source.values }), { client })
		await waitFor(() => expect(result.current.fields.order[0]?.required).toBe(true))
		expect(result.current.defaultValues).toBeNull()
		expect(result.current.schema).toBeNull()
		expect(procedures.cart.get.call).not.toHaveBeenCalled()
		await act(async () => checkout.resolve(source.checkout))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
	})
	it("respects cartEnabled false and still subscribes to later cart data", async () => {
		const source = fixtures()
		const { result, client } = mount(() => useCheckoutFields({ values: source.values }), { cartEnabled: false })
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		const captured = result.current.schema
		if (!captured) throw new Error("Expected checkout schema")
		const empty = { ...source.values, additionalFields: {} }
		expect(captured["~standard"].validate(empty)).toHaveProperty("issues")
		act(() => client.setQueryData(cartQueryKey, { ...source.cart, extensions: { qaConditions: { "reference.required": false } } }))
		await waitFor(() => expect(result.current.fields.order[0]?.required).toBe(false))
		expect(captured["~standard"].validate(empty)).toHaveProperty("value", empty)
		expect(procedures.cart.get.call).not.toHaveBeenCalled()
	})
	it("reacts to cart mutations/refetch and exposes acknowledged facts during rate selection", async () => {
		const source = fixtures()
		const selected = deferred<Cart>()
		procedures.cart.selectShippingRate.call.mockReturnValue(selected.promise)
		const { result } = mount(() => ({ fields: useCheckoutFields({ values: source.values }), shipping: useCartShippingRates() }), {
			cartEnabled: false,
		})
		await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
		const captured = result.current.fields.schema
		if (!captured) throw new Error("Expected checkout schema")
		act(() => result.current.shipping.selectShippingRate("flat_rate:1", 0))
		await waitFor(() => expect(result.current.fields.isRepricing).toBe(true))
		expect(result.current.fields.fields.order[0]?.required).toBe(true)
		const changed = { ...source.cart, shippingPackages: [] }
		await act(async () => selected.resolve(changed))
		await waitFor(() => expect(result.current.fields.fields.order[0]?.required).toBe(false))
		expect(result.current.fields.isRepricing).toBe(false)
		expect(captured["~standard"].validate({ ...source.values, additionalFields: {} })).toHaveProperty("value")
	})
	it("reports queued/address repricing without saving controlled values", async () => {
		const source = fixtures()
		const pending = deferred<Cart>()
		procedures.cart.update.call.mockReturnValue(pending.promise)
		const { result, client } = mount(() => ({ fields: useCheckoutFields({ values: source.values }), address: useCartAddress() }), {
			cartEnabled: false,
		})
		await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
		act(() => client.setQueryData(addressQueueKey, ["pending-owner"]))
		await waitFor(() => expect(result.current.fields.isRepricing).toBe(true))
		act(() => client.setQueryData(addressQueueKey, []))
		await waitFor(() => expect(result.current.fields.isRepricing).toBe(false))
		act(() => result.current.address.update({ billingAddress: { country: "GB" } }))
		await waitFor(() => expect(result.current.fields.isRepricing).toBe(true))
		await act(async () => pending.resolve(source.cart))
		await waitFor(() => expect(result.current.fields.isRepricing).toBe(false))
	})
	it("validates different candidates before rendering and never resets a controlled snapshot", async () => {
		const source = fixtures()
		let values: CheckoutFieldValues = { ...source.values, customerNote: "", additionalFields: {} }
		const { result, client, rerender } = mount(() => useCheckoutFields({ values }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		const captured = result.current.schema
		if (!captured) throw new Error("Expected checkout schema")
		expect(captured["~standard"].validate(values)).toHaveProperty("issues")
		expect(captured["~standard"].validate(source.values)).toHaveProperty("value", source.values)
		act(() => client.setQueryData(checkoutQueryKey, { ...source.checkout, customerNote: "refreshed" }))
		await waitFor(() => expect(result.current.defaultValues?.customerNote).toBe("refreshed"))
		expect(values.customerNote).toBe("")
		values = source.values
		rerender()
		expect(result.current.schema).toBe(captured)
		expect(procedures.cart.update.call).not.toHaveBeenCalled()
		expect(procedures.cart.selectShippingRate.call).not.toHaveBeenCalled()
		expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
	})
	it.each(["storefront", "checkout"] as const)("reports %s failure and recovers through the same cache", async (subject) => {
		const source = fixtures()
		const error = Object.assign(new Error("Fetch refused"), { code: "FETCH_FAILED" })
		procedures[subject].get.call.mockRejectedValue(error)
		const { result, client } = mount(() => useCheckoutFields())
		await waitFor(() => expect(result.current.error).toBe(error))
		expect(result.current.schema).toBeNull()
		expect(result.current.isLoading).toBe(false)
		procedures[subject].get.call.mockResolvedValue(subject === "checkout" ? source.checkout : source.storefront)
		await act(async () => client.refetchQueries({ queryKey: subject === "checkout" ? checkoutQueryKey : storefrontQueryKey }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		expect(result.current.error).toBeNull()
	})
	it("fetches cart only after completed bootstrap when checkout cannot seed it; reports cart failure", async () => {
		const source = fixtures()
		const checkout = deferred<Checkout>()
		procedures.checkout.get.call.mockReturnValue(checkout.promise)
		const error = Object.assign(new Error("Cart failed"), { code: "FETCH_FAILED" })
		procedures.cart.get.call.mockRejectedValue(error)
		const { result, client } = mount(() => useCheckoutFields())
		expect(procedures.cart.get.call).not.toHaveBeenCalled()
		await act(async () => checkout.resolve({ ...source.checkout, cart: null }))
		await waitFor(() => expect(result.current.error).toBe(error))
		expect(result.current.schema).toBeNull()
		expect(result.current.defaultValues).toBeNull()
		procedures.cart.get.call.mockResolvedValue(source.cart)
		await act(async () => client.refetchQueries({ queryKey: cartQueryKey }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		expect(result.current.error).toBeNull()
	})
	it("commits refreshed sources before a consumer layout effect validates", async () => {
		const source = fixtures()
		const empty = { ...source.values, additionalFields: {} }
		const checks: boolean[] = []
		const { result, client } = mount(
			() => {
				const fields = useCheckoutFields({ values: empty })
				const required = fields.fields.order[0]?.required
				useLayoutEffect(() => {
					if (required !== undefined && fields.schema) checks.push("issues" in fields.schema["~standard"].validate(empty))
				}, [fields.schema, required])
				return fields
			},
			{ cartEnabled: false },
		)
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		expect(checks.at(-1)).toBe(true)
		act(() => client.setQueryData(cartQueryKey, { ...source.cart, shippingPackages: [] }))
		await waitFor(() => expect(result.current.fields.order[0]?.required).toBe(false))
		expect(checks.at(-1)).toBe(false)
	})
	it("updates a captured validator from refreshed customer identity and closes paid checkout initialization", async () => {
		const source = fixtures([field("guest", { required: { properties: { customer: { properties: { id: { const: 0 } } } } } })])
		procedures.storefront.get.call.mockResolvedValue(source.storefront)
		const { result, client } = mount(() => useCheckoutFields({ values: source.values }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		const captured = result.current.schema
		if (!captured) throw new Error("Expected checkout schema")
		expect(captured["~standard"].validate(source.values)).toHaveProperty("issues")
		act(() => client.setQueryData(checkoutQueryKey, { ...source.checkout, customerId: 42 }))
		await waitFor(() => expect(result.current.fields.order[0]?.required).toBe(false))
		expect(captured["~standard"].validate(source.values)).toHaveProperty("value")
		act(() => client.setQueryData(checkoutQueryKey, { ...source.checkout, isPaid: true }))
		await waitFor(() => expect(result.current.schema).toBeNull())
		expect(result.current.defaultValues).toBeNull()
		expect(captured["~standard"].validate(source.values)).toHaveProperty("issues")
	})
	it("follows shipping eligibility and hidden widget requirements after cart refresh without changing values", async () => {
		const source = fixtures([
			field("first_name", { location: "address", required: true, bindings: { billing: ["firstName"], shipping: ["firstName"] } }),
			field("custom", {
				type: "date",
				required: true,
				hidden: { properties: { cart: { properties: { needs_shipping: { const: false } } } } },
			}),
		])
		source.cart.needsShipping = false
		const { shippingAddress: _shipping, ...remaining } = source.values
		const values = Object.freeze({ ...remaining, additionalFields: { custom: "retained" } })
		procedures.storefront.get.call.mockResolvedValue(source.storefront)
		procedures.checkout.get.call.mockResolvedValue(source.checkout)
		const { result, client } = mount(() => useCheckoutFields({ values }), { cartEnabled: false })
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		const captured = result.current.schema
		if (!captured) throw new Error("Expected checkout schema")
		expect(result.current.fields.shipping).toEqual([])
		expect(result.current.fields.order[0]).toMatchObject({ hidden: true, required: false, type: "date" })
		expect(result.current.unsupported).toEqual([])
		expect((captured["~standard"].validate(values) as { value: unknown }).value).toBe(values)
		act(() => client.setQueryData(cartQueryKey, { ...source.cart, needsShipping: true }))
		await waitFor(() => expect(result.current.fields.shipping).toHaveLength(1))
		expect(result.current.unsupported[0]?.reason).toBe("unsupported-widget")
		expect(captured["~standard"].validate(values)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["shippingAddress", "firstName"] })]),
		)
		act(() => client.setQueryData(cartQueryKey, { ...source.cart, needsShipping: false }))
		await waitFor(() => expect(result.current.fields.shipping).toEqual([]))
		expect(result.current.unsupported).toEqual([])
		expect((captured["~standard"].validate(values) as { value: unknown }).value).toBe(values)
	})
	it("remounts from the shared cache without a separate cart copy or bootstrap request", async () => {
		const first = mount(() => useCheckoutFields())
		await waitFor(() => expect(first.result.current.schema).not.toBeNull())
		first.unmount()
		const second = mount(() => useCheckoutFields(), { client: first.client })
		expect(second.result.current.defaultValues).not.toBeNull()
		await waitFor(() => expect(procedures.checkout.get.call).toHaveBeenCalledTimes(2))
		expect(procedures.storefront.get.call).toHaveBeenCalledTimes(1)
		expect(procedures.cart.get.call).not.toHaveBeenCalled()
	})
})
