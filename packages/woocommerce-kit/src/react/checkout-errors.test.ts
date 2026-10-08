// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { useKizloContext } from "kizlo/react"
import { createElement, memo, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { checkoutErrorStore } from "../checkout-errors"
import { checkoutFormInput } from "../checkout-form"
import { validationFailure, validationIssue } from "../test/checkout-errors-fixture"
import { field, fixtures } from "../test/checkout-fields-fixture"
import type { Checkout, CheckoutFieldsOptions, CheckoutFieldUpdate, CheckoutFormValues } from "../types"
import { useCheckout } from "./checkout"
import { useCheckoutFields } from "./checkout-fields"
import { useWooCommerceContext } from "./context"
import { WooCommerceProvider } from "./provider"
import { storefrontQueryKey } from "./storefront"

const { procedures } = vi.hoisted(() => {
	const procedure = () => ({ call: vi.fn() })
	return {
		procedures: { checkout: { get: procedure(), confirm: procedure() }, cart: { get: procedure() }, storefront: { get: procedure() } },
	}
})
vi.mock("kizlo/react", () => {
	const client = { woocommerce: procedures }
	return { useKizloContext: () => ({ client }) }
})
const clients: QueryClient[] = []
const id = "plugin/a.b[0]'%"
const native = field("postcode", { location: "address", bindings: { billing: ["postcode"], shipping: ["postcode"] } })
function setup() {
	const sources = fixtures([native, field(id)])
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
	clients.push(client)
	client.setQueryData(checkoutQueryKey, sources.checkout)
	client.setQueryData(cartQueryKey, sources.cart)
	client.setQueryData(storefrontQueryKey, sources.storefront)
	let contextRenders = 0
	const ContextConsumer = memo(() => {
		useWooCommerceContext()
		contextRenders++
		return null
	})
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client }, createElement(WooCommerceProvider, null, createElement(ContextConsumer), children))
	return { sources, client, wrapper, contextRenders: () => contextRenders }
}
function batch() {
	return validationFailure([
		validationIssue({ scope: "field", target: ["billingAddress", "postcode"], message: "postcode one" }),
		validationIssue({ scope: "field", target: ["billingAddress", "postcode"], message: "postcode two" }),
		validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "custom" }),
		validationIssue({ scope: "group", target: ["billingAddress"], message: "billing section" }),
		validationIssue({ scope: "group", target: ["shippingAddress"], message: "shipping section" }),
		validationIssue({ message: "summary" }),
	])
}
function deferred() {
	let resolve!: (value: Checkout) => void, reject!: (error: unknown) => void
	const promise = new Promise<Checkout>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
afterEach(() => {
	cleanup()
	clients.forEach((client) => {
		client.clear()
	})
	clients.length = 0
	vi.resetAllMocks()
})

describe("automatic checkout error integration", () => {
	it("a one-time copy clears only server issues on changed billing controls", async () => {
		const env = setup(),
			set = vi.fn(),
			clear = vi.fn()
		let values: CheckoutFormValues = {
			...checkoutFormInput(env.sources.values),
			useShippingAsBilling: false,
			shippingAddress: { ...env.sources.checkout.shippingAddress, postcode: "NEW" },
		}
		procedures.checkout.confirm.call.mockRejectedValue(batch())
		const { result } = renderHook(
			() => ({
				fields: useCheckoutFields({
					getValues: () => values,
					setErrors: set,
					clearErrors: clear,
					setValues: (updates: readonly CheckoutFieldUpdate[]) => {
						values = {
							...values,
							billingAddress: {
								...env.sources.checkout.billingAddress,
								...values.billingAddress,
								...Object.fromEntries(updates.map(({ name, value }) => [name.slice("billingAddress.".length), value])),
							},
						}
					},
				}),
				checkout: useCheckout(),
			}),
			{ wrapper: env.wrapper },
		)
		await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
		await act(async () => {
			await result.current.checkout
				.confirmAsync({ billingAddress: env.sources.checkout.billingAddress, paymentMethod: "bacs" })
				.catch(() => {})
		})
		expect(set).toHaveBeenCalledWith(
			expect.arrayContaining([{ name: "billingAddress.postcode", messages: ["postcode one", "postcode two"] }]),
		)
		clear.mockClear()
		act(() => result.current.fields.copyShippingToBilling())
		expect(clear).toHaveBeenCalledWith(["billingAddress.postcode"])
		expect(result.current.fields.billing.errors[0]?.message).toBe("billing section")
		expect(result.current.fields.shipping.errors[0]?.message).toBe("shipping section")
		expect(result.current.fields.errors[0]?.message).toBe("summary")
		// Removing one control does not replay the still-active custom-field patch.
		expect(set).toHaveBeenCalledTimes(1)
		expect(
			checkoutErrorStore(useKizloContext().client, env.client)
				.state.get()
				.issues.map(({ message }) => message),
		).toEqual(["custom", "billing section", "shipping section", "summary"])
		clear.mockClear()
		act(() => result.current.fields.copyShippingToBilling())
		expect(clear).not.toHaveBeenCalled()
		expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1)
	})
	it("shares batches, writes once outside render, preserves source errors and context, and clears exact copied controls only", async () => {
		const env = setup(),
			set = vi.fn(),
			clear = vi.fn(),
			latest = vi.fn(),
			failure = batch()
		let values: CheckoutFormValues = { ...checkoutFormInput(env.sources.values), useShippingAsBilling: true }
		let setter = set
		procedures.checkout.confirm.call.mockRejectedValue(failure)
		const { result, rerender, unmount } = renderHook(
			() => ({
				fields: useCheckoutFields({ getValues: () => values, setErrors: (patches) => setter(patches), clearErrors: clear }),
				readOnly: useCheckoutFields(),
				checkout: useCheckout(),
				otherCheckout: useCheckout(),
			}),
			{ wrapper: env.wrapper },
		)
		await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
		const contextRenders = env.contextRenders()
		await act(async () => {
			await expect(
				result.current.checkout.confirmAsync({ billingAddress: env.sources.checkout.billingAddress, paymentMethod: "bacs" }),
			).rejects.toBe(failure)
		})
		expect(result.current.otherCheckout.error).toBe(failure)
		expect(result.current.fields.error).toBeNull()
		expect(result.current.fields.billing.errors[0]?.message).toBe("billing section")
		expect(result.current.fields.shipping.errors[0]?.message).toBe("shipping section")
		expect(result.current.fields.errors[0]?.message).toBe("summary")
		expect(set).toHaveBeenCalledTimes(1)
		expect(set.mock.calls[0]?.[0]).toEqual([
			{ name: "shippingAddress.postcode", messages: ["postcode one", "postcode two"] },
			{ name: "additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25", messages: ["custom"] },
		])
		setter = latest
		rerender()
		expect(latest).not.toHaveBeenCalled()
		values = { ...values, shippingAddress: { ...env.sources.checkout.shippingAddress, postcode: "edited" } }
		act(() => result.current.fields.handleFieldChange("shippingAddress.postcode", "edited"))
		expect(clear).toHaveBeenCalledWith(["shippingAddress.postcode"])
		expect(result.current.fields.billing.errors).toHaveLength(1)
		expect(result.current.fields.shipping.errors).toHaveLength(1)
		expect(result.current.fields.errors).toHaveLength(1)
		rerender()
		expect(latest).not.toHaveBeenCalled()
		expect(env.contextRenders()).toBe(contextRenders)
		const store = checkoutErrorStore(useKizloContext().client, env.client)
		unmount()
		expect(store.state.lc).toBe(0)
		const remounted = renderHook(() => useCheckoutFields({ getValues: () => values, setErrors: latest, clearErrors: clear }), {
			wrapper: env.wrapper,
		})
		await waitFor(() => expect(latest).toHaveBeenCalledTimes(1))
		expect(latest.mock.calls[0]?.[0]).toEqual([{ name: "additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25", messages: ["custom"] }])
		expect(remounted.result.current.billing.errors).toHaveLength(1)
	})
	it("hydrates a copied-address bridge once using current form values", async () => {
		const env = setup(),
			set = vi.fn()
		const store = checkoutErrorStore(useKizloContext().client, env.client)
		const attempt = store.start(JSON.stringify([env.sources.checkout.orderId, env.sources.checkout.orderKey]))
		store.fail(attempt, batch())
		store.settle(attempt)
		const values = { ...checkoutFormInput(env.sources.values), useShippingAsBilling: true }
		renderHook(() => useCheckoutFields({ getValues: () => values, setErrors: set, clearErrors: vi.fn() }), { wrapper: env.wrapper })
		await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
		expect(set.mock.calls[0]?.[0][0].name).toBe("shippingAddress.postcode")
	})

	it("reprojects sharing/hidden fields and registry changes with targeted patches; cleared issues never return", async () => {
		const env = setup(),
			set = vi.fn(),
			clear = vi.fn()
		let values = { ...checkoutFormInput(env.sources.values), useShippingAsBilling: false }
		procedures.checkout.confirm.call.mockRejectedValue(batch())
		const { result } = renderHook(
			() => ({ fields: useCheckoutFields({ getValues: () => values, setErrors: set, clearErrors: clear }), checkout: useCheckout() }),
			{ wrapper: env.wrapper },
		)
		await act(async () => {
			await result.current.checkout
				.confirmAsync({ billingAddress: env.sources.checkout.billingAddress, paymentMethod: "bacs" })
				.catch(() => {})
		})
		expect(set.mock.calls[0]?.[0][0].name).toBe("billingAddress.postcode")
		values = { ...values, useShippingAsBilling: true }
		act(() => result.current.fields.handleFieldChange("useShippingAsBilling", true))
		expect(clear).toHaveBeenCalledWith(["billingAddress.postcode"])
		expect(set).toHaveBeenLastCalledWith([{ name: "shippingAddress.postcode", messages: ["postcode one", "postcode two"] }])
		act(() =>
			env.client.setQueryData(storefrontQueryKey, {
				...env.sources.storefront,
				address: { ...env.sources.storefront.address, fields: [native, field(id, { hidden: true })] },
			}),
		)
		await waitFor(() => expect(result.current.fields.order.errors[0]?.message).toBe("custom"))
		expect(clear).toHaveBeenCalledWith(["additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25"])
		act(() => result.current.fields.handleFieldChange("shippingAddress.postcode", "new"))
		values = { ...values, useShippingAsBilling: false }
		act(() => result.current.fields.reevaluate())
		act(() => env.client.setQueryData(storefrontQueryKey, env.sources.storefront))
		await waitFor(() => expect(result.current.fields.order.errors).toEqual([]))
		expect(set).toHaveBeenLastCalledWith([{ name: "additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25", messages: ["custom"] }])
		act(() => result.current.checkout.reset())
		expect(result.current.fields.errors).toEqual([])
		expect(result.current.fields.billing.errors).toEqual([])
	})
	it("clears on new attempts/success/reset across observers, rejects old completions and revived sessions", async () => {
		const env = setup(),
			first = deferred(),
			second = deferred(),
			third = deferred(),
			fourth = deferred(),
			failure = batch()
		procedures.checkout.confirm.call
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise)
			.mockReturnValueOnce(third.promise)
			.mockReturnValueOnce(fourth.promise)
		const set = vi.fn(),
			clear = vi.fn()
		const { result } = renderHook(
			() => ({ a: useCheckout(), b: useCheckout(), fields: useCheckoutFields({ setErrors: set, clearErrors: clear }) }),
			{ wrapper: env.wrapper },
		)
		const input = { billingAddress: env.sources.checkout.billingAddress, paymentMethod: "bacs" }
		let old!: Promise<Checkout>, next!: Promise<Checkout>
		act(() => {
			old = result.current.a.confirmAsync(input)
			void old.catch(() => {})
		})
		await waitFor(() => expect(result.current.b.isPending).toBe(true))
		act(() => {
			next = result.current.b.confirmAsync(input)
			void next.catch(() => {})
		})
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(2))
		await act(async () => {
			second.reject(failure)
			await next.catch(() => {})
		})
		expect(result.current.a.error).toBe(failure)
		act(() => result.current.a.reset())
		expect(result.current.a.error).toBe(failure)
		await act(async () => {
			first.resolve({ ...env.sources.checkout, orderKey: "old" })
			await old
		})
		expect(env.client.getQueryData<Checkout>(checkoutQueryKey)?.orderKey).toBe(env.sources.checkout.orderKey)
		expect(result.current.b.error).toBe(failure)
		act(() => {
			next = result.current.a.confirmAsync(input)
			void next.catch(() => {})
		})
		await waitFor(() => expect(result.current.fields.errors).toEqual([]))
		await act(async () => {
			third.resolve(env.sources.checkout)
			await next
		})
		expect(result.current.b.error).toBeNull()
		act(() => {
			next = result.current.a.confirmAsync(input)
			void next.catch(() => {})
		})
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(4))
		act(() => env.client.setQueryData(checkoutQueryKey, { ...env.sources.checkout, orderKey: "revived" }))
		await act(async () => {
			fourth.reject(failure)
			await next.catch(() => {})
		})
		expect(result.current.fields.errors).toEqual([])
		expect(result.current.a.error).toBeNull()
	})
	it.each(["success", "error"] as const)("rejects an unmounted %s completion after the cached session revives", async (outcome) => {
		const env = setup(),
			request = deferred(),
			failure = batch()
		procedures.checkout.confirm.call.mockReturnValue(request.promise)
		const onSuccess = vi.fn(),
			onError = vi.fn()
		const { result, unmount } = renderHook(() => useCheckout({ onSuccess, onError }), { wrapper: env.wrapper })
		let promise!: Promise<Checkout>
		act(() => {
			promise = result.current.confirmAsync({ billingAddress: env.sources.checkout.billingAddress, paymentMethod: "bacs" })
			void promise.catch(() => {})
		})
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
		unmount()
		const revived = { ...env.sources.checkout, orderKey: "revived", cart: { ...env.sources.cart, itemCount: 9 } }
		env.client.setQueryData(checkoutQueryKey, revived)
		env.client.setQueryData(cartQueryKey, revived.cart)
		await act(async () => {
			if (outcome === "success") {
				request.resolve({ ...env.sources.checkout, orderKey: "old" })
				await expect(promise).resolves.toMatchObject({ orderKey: "old" })
			} else {
				request.reject(failure)
				await expect(promise).rejects.toBe(failure)
			}
		})
		expect(env.client.getQueryData<Checkout>(checkoutQueryKey)?.orderKey).toBe("revived")
		expect(env.client.getQueryData<Checkout["cart"]>(cartQueryKey)?.itemCount).toBe(9)
		const store = checkoutErrorStore(useKizloContext().client, env.client)
		expect(store.state.get()).toMatchObject({ error: null, issues: [], pending: 0 })
		expect(outcome === "success" ? onSuccess : onError).toHaveBeenCalledTimes(1)
		const remounted = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		expect(remounted.result.current.error).toBeNull()
	})
	it("retains an unmounted failure for the unchanged session", async () => {
		const env = setup(),
			request = deferred(),
			failure = batch()
		procedures.checkout.confirm.call.mockReturnValue(request.promise)
		const { result, unmount } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		let promise!: Promise<Checkout>
		act(() => {
			promise = result.current.confirmAsync({ billingAddress: env.sources.checkout.billingAddress, paymentMethod: "bacs" })
			void promise.catch(() => {})
		})
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
		unmount()
		await act(async () => {
			request.reject(failure)
			await expect(promise).rejects.toBe(failure)
		})
		const set = vi.fn()
		renderHook(() => useCheckoutFields({ setErrors: set, clearErrors: vi.fn() }), { wrapper: env.wrapper })
		await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
		expect(checkoutErrorStore(useKizloContext().client, env.client).state.get().pending).toBe(0)
	})
	it("isolates separate checkout caches and keeps query failures distinct", async () => {
		const first = setup(),
			second = setup(),
			failure = batch()
		procedures.checkout.confirm.call.mockRejectedValue(failure)
		const a = renderHook(() => ({ checkout: useCheckout(), fields: useCheckoutFields() }), { wrapper: first.wrapper })
		const b = renderHook(() => ({ checkout: useCheckout(), fields: useCheckoutFields() }), { wrapper: second.wrapper })
		await act(async () => {
			await a.result.current.checkout
				.confirmAsync({ billingAddress: first.sources.checkout.billingAddress, paymentMethod: "bacs" })
				.catch(() => {})
		})
		expect(a.result.current.fields.errors).toHaveLength(1)
		expect(b.result.current.fields.errors).toEqual([])
		expect(b.result.current.checkout.error).toBeNull()
		const error = Object.assign(new Error("bootstrap refused"), { code: "FETCH_FAILED" })
		procedures.storefront.get.call.mockRejectedValue(error)
		await act(async () => {
			await second.client.refetchQueries({ queryKey: storefrontQueryKey })
		})
		await waitFor(() => expect(b.result.current.fields.error).toBe(error))
		expect(b.result.current.fields.errors).toEqual([])
	})
	it("permits read-only consumers and requires paired form callbacks", () => {
		const env = setup()
		// @ts-expect-error The bridge callbacks must be configured together.
		const options: CheckoutFieldsOptions = { setErrors: vi.fn() }
		expect(() => renderHook(() => useCheckoutFields(options), { wrapper: env.wrapper })).toThrow("both setErrors and clearErrors")
	})
})
