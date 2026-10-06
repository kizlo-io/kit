// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode, useLayoutEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { field, fixtures } from "../test/checkout-fields-fixture"
import type { Cart, Checkout, CheckoutFieldValues, CheckoutFormValues } from "../types"
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
		expect(result.current.defaultValues).toMatchObject(result.current.getInput(source.values))
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
		const { result } = mount(() => useCheckoutFields({ getValues: () => source.values }), { client })
		await waitFor(() => expect(result.current.fields.order[0]?.required).toBe(true))
		expect(result.current.defaultValues).toBeNull()
		expect(result.current.schema).toBeNull()
		expect(procedures.cart.get.call).not.toHaveBeenCalled()
		await act(async () => checkout.resolve(source.checkout))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
	})
	it("respects cartEnabled false and still subscribes to later cart data", async () => {
		const source = fixtures()
		const { result, client } = mount(() => useCheckoutFields({ getValues: () => source.values }), { cartEnabled: false })
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
		const { result } = mount(() => ({ fields: useCheckoutFields({ getValues: () => source.values }), shipping: useCartShippingRates() }), {
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
		const { result, client } = mount(() => ({ fields: useCheckoutFields({ getValues: () => source.values }), address: useCartAddress() }), {
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
		const { result, client, rerender } = mount(() => useCheckoutFields({ getValues: () => values }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		const captured = result.current.schema
		if (!captured) throw new Error("Expected checkout schema")
		expect(captured["~standard"].validate(values)).toHaveProperty("issues")
		expect(captured["~standard"].validate(source.values)).toHaveProperty("value", source.values)
		act(() => client.setQueryData(checkoutQueryKey, { ...source.checkout, customerNote: "refreshed" }))
		await waitFor(() => expect(result.current.defaultValues?.customerNote).toBe("saved"))
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
				const fields = useCheckoutFields({ getValues: () => empty })
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
		const { result, client } = mount(() => useCheckoutFields({ getValues: () => source.values }))
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
		const { result, client } = mount(() => useCheckoutFields({ getValues: () => values }), { cartEnabled: false })
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

describe("checkout field events", () => {
	function addressSource() {
		const source = fixtures([
			field("country", { location: "address", bindings: { billing: ["country"], shipping: ["country"] } }),
			field("state", { location: "address", bindings: { billing: ["state"], shipping: ["state"] } }),
			field("needs-account", { required: { properties: { checkout: { properties: { create_account: { const: true } } } } } }),
		])
		source.checkout.shippingAddress.country = "IN"
		source.checkout.shippingAddress.state = "KA"
		procedures.storefront.get.call.mockResolvedValue(source.storefront)
		procedures.checkout.get.call.mockResolvedValue(source.checkout)
		return source
	}
	it("reads committed values, applies dependency options synchronously and resolves only the resulting snapshot", async () => {
		const source = addressSource()
		let values: CheckoutFormValues = { ...source.values }
		const steps: unknown[] = []
		const getter = vi.fn(() => {
			steps.push(["read", values.billingAddress?.state])
			return values
		})
		const setter = vi.fn((updates) => {
			steps.push(["write", updates])
			values = { ...values, billingAddress: { ...source.checkout.billingAddress, country: "GB", state: updates[0].value } }
			// Even a misconfigured consumer cannot recurse into the same dependency event.
			result.current.handleFieldChange("billingAddress.country", "GB")
		})
		const { result } = mount(() => useCheckoutFields({ getValues: getter, setValues: setter }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		steps.length = 0
		getter.mockClear()
		values = { ...values, billingAddress: { ...source.checkout.billingAddress, country: "GB" } }
		act(() => result.current.handleFieldChange("billingAddress.country", "GB"))
		expect(steps).toEqual([
			["read", "KA"],
			["write", [{ name: "billingAddress.state", value: "", options: { runListeners: false, meta: "preserve", validate: false } }]],
			["read", ""],
		])
		expect(setter).toHaveBeenCalledTimes(1)
		expect(getter).toHaveBeenCalledTimes(2)
		expect(result.current.fields.billing.find((field) => field.id === "state")).toMatchObject({ type: "text", label: "County" })
		expect(procedures.cart.update.call).not.toHaveBeenCalled()
		expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
	})
	it("ignores accessor identities/rerenders and uses the latest accessors on the next event", async () => {
		const source = addressSource()
		let values: CheckoutFormValues = source.values
		const oldGetter = vi.fn(() => values)
		const newGetter = vi.fn(() => values)
		let getter = oldGetter
		const { result, rerender } = mount(() => useCheckoutFields({ getValues: () => getter() }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		const fields = result.current.fields
		const billingCountry = fields.billing[0]
		oldGetter.mockClear()
		getter = newGetter
		values = { ...values, createAccount: true }
		rerender()
		expect(oldGetter).not.toHaveBeenCalled()
		expect(newGetter).not.toHaveBeenCalled()
		expect(result.current.fields).toBe(fields)
		act(() => result.current.handleFieldChange("createAccount", true))
		expect(newGetter).toHaveBeenCalledTimes(2)
		expect(result.current.fields.order[0]?.required).toBe(true)
		expect(result.current.fields.billing).toBe(fields.billing)
		expect(result.current.fields.billing[0]).toBe(billingCountry)
		const updated = result.current.fields
		values = { ...values, customerNote: "ordinary edit" }
		act(() => result.current.handleFieldChange("customerNote", "ordinary edit"))
		expect(result.current.fields).toBe(updated)
	})
	it("reevaluates silent coherent prefill without clears and ignores unrelated application events", async () => {
		const source = addressSource()
		let values: CheckoutFormValues = source.values
		const getter = vi.fn(() => values)
		const setter = vi.fn()
		const { result, rerender } = mount(() => useCheckoutFields({ getValues: getter, setValues: setter }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		values = {
			...result.current.getInput(source.values),
			billingAddress: { ...source.checkout.billingAddress, country: "GB", state: "London" },
		}
		getter.mockClear()
		rerender()
		expect(getter).not.toHaveBeenCalled()
		expect(result.current.fields.billing[1]?.type).toBe("select")
		act(() => result.current.reevaluate())
		expect(getter).toHaveBeenCalledTimes(1)
		expect(setter).not.toHaveBeenCalled()
		expect(values.billingAddress?.state).toBe("London")
		expect(result.current.fields.billing[1]).toMatchObject({ type: "text", label: "County" })
		getter.mockClear()
		// @ts-expect-error An application-only control is outside Kit's registered field contract.
		act(() => result.current.handleFieldChange("app-only", "value"))
		expect(getter).not.toHaveBeenCalled()
	})
	it("keeps defaults and drafts stable across refresh and validates a different supplied candidate without accessors", async () => {
		const source = addressSource()
		let values: CheckoutFormValues = { ...source.values, customerNote: "draft", createAccount: true }
		const getter = vi.fn(() => values)
		const setter = vi.fn()
		const { result, client } = mount(() => useCheckoutFields({ getValues: getter, setValues: setter }))
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		const defaults = result.current.defaultValues
		const schema = result.current.schema
		act(() => client.setQueryData(checkoutQueryKey, { ...source.checkout, customerNote: "server refresh" }))
		await waitFor(() => expect(getter.mock.calls.length).toBeGreaterThan(1))
		expect(result.current.defaultValues).toBe(defaults)
		expect(values.customerNote).toBe("draft")
		getter.mockClear()
		const fields = result.current.fields
		const candidate = result.current.getInput(source.values)
		expect(schema?.["~standard"].validate(candidate)).toHaveProperty("value", candidate)
		expect(schema?.["~standard"].validate(values)).toHaveProperty("issues")
		result.current.getOutput(candidate)
		expect(getter).not.toHaveBeenCalled()
		expect(setter).not.toHaveBeenCalled()
		expect(result.current.fields).toBe(fields)
		values = { ...values, createAccount: false }
		act(() => client.setQueryData(cartQueryKey, { ...source.cart, itemCount: 5 }))
		await waitFor(() => expect(result.current.fields.order[0]?.required).toBe(false))
		expect(result.current.defaultValues).toBe(defaults)
	})
	it("requires event accessors but permits metadata-only consumers and source reevaluation", async () => {
		addressSource()
		const { result } = mount(() => useCheckoutFields())
		await waitFor(() => expect(result.current.schema).not.toBeNull())
		expect(() => result.current.handleFieldChange("createAccount", true)).toThrow("getValues")
		act(() => result.current.reevaluate())
		expect(result.current.fields.billing).toHaveLength(2)
	})
})
