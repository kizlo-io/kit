// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import { type CheckoutCallbacks, checkoutQueryKey } from "../checkout"
import { checkoutFormEncode } from "../checkout-form"
import { fixtures } from "../test/checkout-fields-fixture"
import type { Checkout, CheckoutError, ConfirmCheckoutInput } from "../types"
import { useCheckout } from "./checkout"
import { useCheckoutFields } from "./checkout-fields"
import { WooCommerceProvider } from "./provider"

/** React Query stays real: the confirmation's lifecycle is what these tests are about. Only `.call` is a stub. */
const { procedures } = vi.hoisted(() => ({
	procedures: { confirm: { call: vi.fn() }, get: { call: vi.fn() }, cartGet: { call: vi.fn() }, storefrontGet: { call: vi.fn() } },
}))

vi.mock("kizlo/react", () => {
	const client = { woocommerce: { checkout: procedures, cart: { get: procedures.cartGet }, storefront: { get: procedures.storefrontGet } } }
	return { useKizloContext: () => ({ client }) }
})

/** Only the fields the hook and `resolveCheckoutRedirect` read. */
function storeCheckout(orderId: number | null, itemCount: number) {
	return { cart: { coupons: [], itemCount, items: [] }, orderId, orderKey: "wc_order_abc", paymentResult: null } as unknown as Checkout
}

function storeError(code: string) {
	return Object.assign(new Error("Your card was declined."), { code }) as unknown as CheckoutError
}

/** `successPath` is all the test needs; the rest of a confirmation body says nothing about the lifecycle. */
const input = { successPath: "/checkout/order-received" } as ConfirmCheckoutInput

function mount(options?: CheckoutCallbacks, mutations?: { retry: number }) {
	const queryClient = new QueryClient({ defaultOptions: { mutations, queries: { retry: false } } })
	// JSX is avoided because the suite only collects `src/**/*.test.ts`.
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { children }))

	return { queryClient, ...renderHook(() => useCheckout(options), { wrapper }) }
}

afterEach(() => {
	vi.clearAllMocks()
})

describe("useCheckout confirmation", () => {
	it("seeds the checkout and the cart, and reports where the browser goes next", async () => {
		const fetched = storeCheckout(null, 2)
		const confirmed = storeCheckout(42, 0)
		procedures.get.call.mockResolvedValue(fetched)
		procedures.confirm.call.mockResolvedValue(confirmed)
		const redirects: (string | null)[] = []

		const { result, queryClient } = mount({ onSuccess: (event) => redirects.push(event.redirectUrl) })
		await waitFor(() => expect(result.current.checkout).not.toBeNull())

		await waitFor(() => expect(result.current.isLocked).toBe(false))
		act(() => result.current.confirm(input))

		await waitFor(() => expect(queryClient.getQueryData(checkoutQueryKey)).toStrictEqual(confirmed))
		expect(procedures.confirm.call).toHaveBeenCalledWith({ body: input })
		expect(queryClient.getQueryData(cartQueryKey)).toStrictEqual(confirmed.cart)
		expect(redirects).toEqual(["/checkout/order-received?order_id=42&key=wc_order_abc"])
	})

	it("reports a refused confirmation as start, error and settled, and clears it on reset", async () => {
		procedures.get.call.mockResolvedValue(storeCheckout(null, 2))
		procedures.confirm.call.mockRejectedValue(storeError("CHECKOUT_PAYMENT_FAILED"))
		const phases: string[] = []

		const { result } = mount({
			onError: () => phases.push("error"),
			onSettled: () => phases.push("settled"),
			onStart: () => phases.push("start"),
			onSuccess: () => phases.push("success"),
		})

		await waitFor(() => expect(result.current.isLocked).toBe(false))
		act(() => result.current.confirm(input))

		await waitFor(() => expect(phases).toEqual(["start", "error", "settled"]))
		await waitFor(() => expect(result.current.error?.code).toBe("CHECKOUT_PAYMENT_FAILED"))

		act(() => result.current.reset())
		// `reset` reaches the component through react-query's notify batch, which lands in a microtask rather than inside `act`.
		await waitFor(() => expect(result.current.error).toBeNull())
	})

	it("places the order once, whatever the app sets as its mutation retry", async () => {
		procedures.get.call.mockResolvedValue(storeCheckout(null, 2))
		procedures.confirm.call.mockRejectedValue(storeError("CHECKOUT_PAYMENT_FAILED"))

		const { result } = mount(undefined, { retry: 2 })
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		act(() => result.current.confirm(input))

		await waitFor(() => expect(result.current.error?.code).toBe("CHECKOUT_PAYMENT_FAILED"))
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
	})

	it("still reports a refusal that lands after reset", async () => {
		let refuse: (error: unknown) => void = () => {}
		procedures.get.call.mockResolvedValue(storeCheckout(null, 2))
		procedures.confirm.call.mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)))

		const { result } = mount()
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		act(() => result.current.confirm(input))
		await waitFor(() => expect(result.current.isPending).toBe(true))

		// Resetting mid-flight must not detach the hook from the confirmation it is still running.
		act(() => result.current.reset())
		await act(async () => refuse(storeError("CHECKOUT_PAYMENT_FAILED")))

		await waitFor(() => expect(result.current.error?.code).toBe("CHECKOUT_PAYMENT_FAILED"))
	})
})

describe("awaitable checkout", () => {
	it.each([false, true])("awaits submission settlement (failure: %s) and retries", async (fails) => {
		const fetched = storeCheckout(null, 2)
		const confirmed = storeCheckout(42, 0)
		const error = storeError("PAYMENT_DECLINED")
		procedures.get.call.mockResolvedValue(fetched)
		let answer!: (checkout: Checkout) => void
		let refuse!: (error: unknown) => void
		procedures.confirm.call.mockReturnValueOnce(
			new Promise<Checkout>((resolve, reject) => {
				answer = resolve
				refuse = reject
			}),
		)
		const phases: string[] = []
		const { result, queryClient } = mount(
			{
				onStart: () => phases.push("start"),
				onSuccess: (event) => {
					expect(event.redirectUrl).toContain("/checkout/order-received")
					phases.push("success")
				},
				onError: () => phases.push("error"),
				onSettled: () => phases.push("settled"),
			},
			{ retry: 2 },
		)
		await waitFor(() => expect(result.current.checkout).not.toBeNull())
		// A form library's submission contract without adding a dependency to the package.
		const submission = { pending: false, error: null as unknown }
		const submit = async () => {
			submission.pending = true
			try {
				return await result.current.confirmAsync(input)
			} catch (cause) {
				submission.error = cause
				throw cause
			} finally {
				submission.pending = false
			}
		}
		let pending!: Promise<Checkout>
		act(() => {
			pending = submit()
			void pending.catch(() => {})
		})
		await waitFor(() => expect(result.current.isPending).toBe(true))
		expect(submission.pending).toBe(true)
		expect(phases).toEqual(["start"])
		await act(async () => {
			if (fails) {
				refuse(error)
				await expect(pending).rejects.toBe(error)
			} else {
				answer(confirmed)
				expect(await pending).toBe(confirmed)
			}
		})
		expect(submission.pending).toBe(false)
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
		expect(procedures.confirm.call).toHaveBeenCalledWith({ body: input })
		expect(phases).toEqual(["start", fails ? "error" : "success", "settled"])
		if (fails) {
			expect(submission.error).toBe(error)
			await waitFor(() => expect(result.current.error).toBe(error))
			procedures.confirm.call.mockResolvedValueOnce(confirmed)
			await act(async () => expect(await result.current.confirmAsync(input)).toBe(confirmed))
		}
		expect(queryClient.getQueryData(checkoutQueryKey)).toEqual(confirmed)
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(confirmed.cart)
	})

	it("returns immediately from the legacy handler", async () => {
		procedures.get.call.mockResolvedValue(storeCheckout(null, 2))
		procedures.confirm.call.mockResolvedValue(storeCheckout(42, 0))
		const { result } = mount()
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		act(() => expect(result.current.confirm(input)).toBeUndefined())
		await waitFor(() => expect(result.current.isPending).toBe(false))
	})
})

describe("reviewed checkout total conflicts", () => {
	function setup(cartEnabled = true, callbacks?: CheckoutCallbacks) {
		const source = fixtures()
		const values = { ...checkoutFormEncode(source.values), customerNote: "keep my edits" }
		procedures.get.call.mockResolvedValue(source.checkout)
		procedures.cartGet.call.mockResolvedValue(source.cart)
		procedures.storefrontGet.call.mockResolvedValue(source.storefront)
		const client = new QueryClient({ defaultOptions: { mutations: { retry: 3 }, queries: { retry: false, gcTime: Infinity } } })
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client }, createElement(WooCommerceProvider, { cartEnabled, children }))
		return {
			source,
			values,
			client,
			...renderHook(() => ({ checkout: useCheckout(callbacks), fields: useCheckoutFields({ getValues: () => values }) }), { wrapper }),
		}
	}
	function mismatch(cart: ReturnType<typeof fixtures>["cart"] | null) {
		return Object.assign(new Error("The order total increased. Please review the updated total."), {
			code: "CHECKOUT_TOTAL_MISMATCH" as const,
			status: 409,
			data: { cart, expectedTotal: "12345", actualTotal: "54321" },
		})
	}
	it("publishes current evidence, retains the draft and callbacks, and submits the reviewed total only on explicit retry", async () => {
		const onError = vi.fn(),
			onSettled = vi.fn()
		const env = setup(false, { onError, onSettled })
		await waitFor(() => expect(env.result.current.fields.isReady && !env.result.current.checkout.isLocked).toBe(true))
		const defaults = env.result.current.fields.defaultValues
		const cart = { ...env.source.cart, totals: { ...env.source.cart.totals, total: 54321 } }
		const error = mismatch(cart)
		procedures.confirm.call.mockRejectedValueOnce(error)
		const request = env.result.current.fields.toCheckout()
		await act(async () => {
			await expect(env.result.current.checkout.confirmAsync(request)).rejects.toBe(error)
		})
		await waitFor(() => expect(env.result.current.fields.toCheckout().expectedTotal).toBe("54321"))
		expect(request.expectedTotal).toBe("12345")
		expect(env.result.current.fields.defaultValues).toBe(defaults)
		expect(env.values.customerNote).toBe("keep my edits")
		expect(env.result.current.fields.errors[0]?.message).toContain("Review the updated checkout total")
		expect(env.result.current.checkout.error).toBe(error)
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error, input: request }))
		expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ error }))
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
		expect(procedures.cartGet.call).not.toHaveBeenCalled()
		procedures.confirm.call.mockResolvedValueOnce({ ...env.source.checkout, cart })
		await act(async () => {
			await env.result.current.checkout.confirmAsync(env.result.current.fields.toCheckout())
		})
		expect(procedures.confirm.call.mock.calls[1]?.[0].body.expectedTotal).toBe("54321")
		expect(env.result.current.checkout.error).toBeNull()
	})
	it.each([true, false])("reconciles absent evidence after settlement (standalone cart enabled: %s)", async (cartEnabled) => {
		const env = setup(cartEnabled)
		await waitFor(() => expect(env.result.current.fields.isReady && !env.result.current.checkout.isLocked).toBe(true))
		const cart = { ...env.source.cart, totals: { ...env.source.cart.totals, total: 54321 } }
		procedures.cartGet.call.mockResolvedValueOnce(cart)
		procedures.get.call.mockResolvedValueOnce({ ...env.source.checkout, cart })
		const error = mismatch(null)
		procedures.confirm.call.mockRejectedValueOnce(error)
		await act(async () => {
			await expect(env.result.current.checkout.confirmAsync(env.result.current.fields.toCheckout())).rejects.toBe(error)
		})
		await waitFor(() => expect(env.result.current.fields.toCheckout().expectedTotal).toBe("54321"))
		expect(env.result.current.fields.isReady).toBe(true)
		expect(env.values.customerNote).toBe("keep my edits")
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
		if (cartEnabled) expect(procedures.cartGet.call).toHaveBeenCalledTimes(1)
		else expect(procedures.cartGet.call).not.toHaveBeenCalled()
	})
	it.each(["session", "cart", "refresh"] as const)("refuses old conflict evidence after a newer %s", async (change) => {
		const env = setup(false)
		await waitFor(() => expect(env.result.current.fields.isReady && !env.result.current.checkout.isLocked).toBe(true))
		let reject!: (error: unknown) => void
		procedures.confirm.call.mockReturnValueOnce(
			new Promise((_yes, no) => {
				reject = no
			}),
		)
		let pending!: Promise<Checkout>
		act(() => {
			pending = env.result.current.checkout.confirmAsync(env.result.current.fields.toCheckout())
			void pending.catch(() => {})
		})
		await waitFor(() => expect(env.result.current.checkout.isPending).toBe(true))
		const newest = { ...env.source.cart, totals: { ...env.source.cart.totals, total: 99999 } }
		if (change === "session")
			act(() => env.client.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderId: 99, orderKey: "new-session", cart: newest }))
		if (change === "refresh") {
			procedures.get.call.mockResolvedValueOnce({ ...env.source.checkout, cart: newest })
			await act(async () => env.result.current.fields.refresh())
		} else act(() => env.client.setQueryData(cartQueryKey, newest))
		const reads = procedures.get.call.mock.calls.length
		let resolveRead!: (checkout: Checkout) => void
		if (change !== "session")
			procedures.get.call.mockReturnValueOnce(
				new Promise((yes) => {
					resolveRead = yes
				}),
			)
		await act(async () => reject(mismatch({ ...env.source.cart, totals: { ...env.source.cart.totals, total: 54321 } })))
		await pending.catch(() => {})
		await waitFor(() => expect(env.result.current.checkout.isPending).toBe(false))
		expect(env.client.getQueryData(cartQueryKey)).toEqual(newest)
		expect(env.values.customerNote).toBe("keep my edits")
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
		if (change === "session") {
			expect(env.result.current.checkout.error).toBeNull()
			expect(procedures.get.call).toHaveBeenCalledTimes(reads)
		} else {
			expect(procedures.get.call).toHaveBeenCalledTimes(reads + 1)
			expect(env.result.current.checkout.isLocked).toBe(true)
			const current = { ...newest, totals: { ...newest.totals, total: 11111 } }
			await act(async () => resolveRead({ ...env.source.checkout, cart: current }))
			await waitFor(() => expect(env.result.current.checkout.isLocked).toBe(false))
			expect(env.result.current.fields.toCheckout().expectedTotal).toBe("11111")
		}
	})
})
