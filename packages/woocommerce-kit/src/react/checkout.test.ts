// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import { type CheckoutCallbacks, checkoutQueryKey } from "../checkout"
import { checkoutFormEncode } from "../checkout-form"
import { fixtures } from "../test/checkout-fields-fixture"
import type { Checkout, CheckoutError, ConfirmCheckoutInput } from "../types"
import { useCart } from "./cart"
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

beforeEach(() => {
	procedures.cartGet.call.mockResolvedValue(fixtures([]).cart)
})
afterEach(() => {
	cleanup()
	vi.resetAllMocks()
})

describe("independent checkout and cart reads", () => {
	it("replaces a pending cart read when checkout establishes the session", async () => {
		const source = fixtures([]),
			queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		let resolve!: (cart: typeof source.cart) => void
		procedures.get.call.mockResolvedValue(source.checkout)
		procedures.cartGet.call
			.mockReturnValueOnce(
				new Promise((yes) => {
					resolve = yes
				}),
			)
			.mockResolvedValue(source.cart)
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { children }))
		const { result, unmount } = renderHook(() => ({ cart: useCart(), checkout: useCheckout() }), { wrapper })
		await waitFor(() => expect(result.current.checkout.checkout).toEqual(source.checkout))
		await waitFor(() => expect(result.current.checkout.isLocked).toBe(false))
		await act(async () => resolve({ ...source.cart, itemCount: 99 }))
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(source.cart)
		expect(procedures.cartGet.call).toHaveBeenCalledTimes(2)
		unmount()
		queryClient.clear()
	})
	it("loads cart from its API, ignoring the embedded snapshot", async () => {
		const source = fixtures([]),
			cart = { ...source.cart, itemCount: 9 },
			checkout = { ...source.checkout, cart: null },
			queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		let resolve!: (cart: typeof source.cart) => void
		procedures.get.call.mockResolvedValue(checkout)
		procedures.cartGet.call.mockReturnValue(
			new Promise((yes) => {
				resolve = yes
			}),
		)
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { children }))
		const { result, unmount } = renderHook(() => useCheckout(), { wrapper })
		await waitFor(() => expect(procedures.cartGet.call).toHaveBeenCalledTimes(1))
		expect(result.current.checkout).toEqual(checkout)
		expect(result.current.isLocked).toBe(true)
		expect(queryClient.getQueryData(cartQueryKey)).toBeUndefined()
		await act(async () => resolve(cart))
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(cart)
		unmount()
		queryClient.clear()
	})

	it("keeps a cart refresh failure visible and locked until explicit retry", async () => {
		const source = fixtures([]),
			error = Object.assign(new Error("Cart unavailable"), { code: "INTERNAL_SERVER_ERROR" })
		procedures.get.call.mockResolvedValue(source.checkout)
		procedures.cartGet.call.mockRejectedValue(error)
		const { result, queryClient, unmount } = mount()
		await waitFor(() => expect(result.current.error).toBe(error))
		expect(result.current.checkout).toEqual(source.checkout)
		expect(result.current.isLocked).toBe(true)
		procedures.cartGet.call.mockResolvedValue(source.cart)
		await act(async () => result.current.refresh())
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		expect(result.current.error).toBeNull()
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(source.cart)
		expect(procedures.confirm.call).not.toHaveBeenCalled()
		unmount()
		queryClient.clear()
	})

	it("refreshes cart after a hydrated checkout without publishing its embedded cart", async () => {
		const source = fixtures([]),
			cart = { ...source.cart, itemCount: 9 },
			queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
		queryClient.setQueryData(checkoutQueryKey, source.checkout)
		procedures.cartGet.call.mockResolvedValue(cart)
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { children }))
		const { result, unmount } = renderHook(() => useCheckout(), { wrapper })
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(cart)
		expect(procedures.cartGet.call).toHaveBeenCalledTimes(1)
		expect(procedures.get.call).not.toHaveBeenCalled()
		unmount()
		queryClient.clear()
	})

	it("overlapping checkout refreshes cannot overwrite the cart API snapshot", async () => {
		const source = fixtures([]),
			cart = { ...source.cart, itemCount: 9 },
			newer = { ...source.checkout, customerNote: "newer", cart: { ...source.cart, itemCount: 5 } }
		procedures.get.call.mockResolvedValue(source.checkout)
		procedures.cartGet.call.mockResolvedValue(cart)
		const { result, queryClient, unmount } = mount()
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		let resolveOld!: (checkout: Checkout) => void
		procedures.get.call
			.mockReturnValueOnce(
				new Promise((yes) => {
					resolveOld = yes
				}),
			)
			.mockResolvedValueOnce(newer)
		let older!: Promise<void>
		act(() => {
			older = result.current.refresh()
		})
		await waitFor(() => expect(procedures.get.call).toHaveBeenCalledTimes(2))
		await act(async () => result.current.refresh())
		await act(async () => {
			resolveOld({ ...source.checkout, cart: { ...source.cart, itemCount: 3 } })
			await older
		})
		expect(queryClient.getQueryData(checkoutQueryKey)).toEqual(newer)
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(cart)
		expect(procedures.cartGet.call).toHaveBeenCalled()
		unmount()
		queryClient.clear()
	})
})

describe("pending checkout reads", () => {
	it("reuses a pending checkout across Strict Mode remounts and refreshes cart after unmount", async () => {
		let resolve!: (checkout: Checkout) => void
		const request = new Promise<Checkout>((yes) => {
			resolve = yes
		})
		const checkout = storeCheckout(null, 2),
			queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
		procedures.get.call.mockReturnValueOnce(request)
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { children }))
		const first = renderHook(() => useCheckout(), { wrapper, reactStrictMode: true })
		expect(first.result.current.isLoading).toBe(true)
		expect(procedures.get.call).toHaveBeenCalledTimes(1)
		first.unmount()
		const second = renderHook(() => useCheckout(), { wrapper, reactStrictMode: true })
		expect(procedures.get.call).toHaveBeenCalledTimes(1)
		second.unmount()
		resolve(checkout)
		await waitFor(() => expect(queryClient.getQueryData(checkoutQueryKey)).toEqual(checkout))
		await waitFor(() => expect(queryClient.getQueryData(cartQueryKey)).toEqual(fixtures([]).cart))
		expect(procedures.cartGet.call).toHaveBeenCalledTimes(1)
		expect(procedures.get.call).toHaveBeenCalledTimes(1)
		queryClient.clear()
	})
})

describe("useCheckout confirmation", () => {
	it("keeps a successful confirmation successful when its cart refresh fails, without replaying the POST", async () => {
		const source = fixtures([]),
			confirmed = { ...source.checkout, cart: null },
			error = Object.assign(new Error("Cart unavailable"), { code: "INTERNAL_SERVER_ERROR" }),
			onSuccess = vi.fn(),
			onError = vi.fn(),
			onSettled = vi.fn()
		procedures.get.call.mockResolvedValue(source.checkout)
		procedures.confirm.call.mockResolvedValue(confirmed)
		const { result, queryClient, unmount } = mount({ onSuccess, onError, onSettled }, { retry: 3 })
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		procedures.cartGet.call.mockRejectedValue(error)
		await act(async () => expect(result.current.confirmAsync(input)).resolves.toBe(confirmed))
		await waitFor(() => expect(result.current.error).toBe(error))
		expect(result.current.isLocked).toBe(true)
		expect(queryClient.getQueryData(checkoutQueryKey)).toEqual(confirmed)
		expect(queryClient.getQueryData(cartQueryKey)).toEqual(source.cart)
		expect(onSuccess).toHaveBeenCalledTimes(1)
		expect(onSettled).toHaveBeenCalledTimes(1)
		expect(onError).not.toHaveBeenCalled()
		procedures.cartGet.call.mockResolvedValue(source.cart)
		procedures.get.call.mockResolvedValue(confirmed)
		await act(async () => result.current.refresh())
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		expect(result.current.error).toBeNull()
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
		unmount()
		queryClient.clear()
	})
	it("settles one confirmation and publishes its result after unmount", async () => {
		let resolve!: (checkout: Checkout) => void
		procedures.get.call.mockResolvedValue(storeCheckout(null, 2))
		procedures.confirm.call.mockReturnValueOnce(
			new Promise<Checkout>((yes) => {
				resolve = yes
			}),
		)
		const onSettled = vi.fn(),
			confirmed = storeCheckout(42, 0),
			cart = { ...fixtures([]).cart, items: [], itemCount: 0 }
		const { result, queryClient, unmount } = mount({ onSettled }, { retry: 3 })
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		procedures.cartGet.call.mockResolvedValue(cart)
		let pending!: Promise<Checkout>
		act(() => {
			pending = result.current.confirmAsync(input)
		})
		await waitFor(() => expect(procedures.confirm.call).toHaveBeenCalledTimes(1))
		unmount()
		resolve(confirmed)
		await expect(pending).resolves.toBe(confirmed)
		expect(queryClient.getQueryData(checkoutQueryKey)).toEqual(confirmed)
		await waitFor(() => expect(queryClient.getQueryData(cartQueryKey)).toEqual(cart))
		expect(procedures.cartGet.call).toHaveBeenCalledTimes(2)
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
		expect(onSettled).toHaveBeenCalledTimes(1)
		queryClient.clear()
	})

	it("publishes checkout, refreshes cart through its API, and reports where the browser goes next", async () => {
		const fetched = storeCheckout(null, 2)
		const confirmed = storeCheckout(42, 0)
		const cart = { ...fixtures([]).cart, items: [], itemCount: 0 }
		procedures.get.call.mockResolvedValue(fetched)
		procedures.confirm.call.mockResolvedValue(confirmed)
		const redirects: (string | null)[] = []

		const { result, queryClient } = mount({ onSuccess: (event) => redirects.push(event.redirectUrl) })
		await waitFor(() => expect(result.current.checkout).not.toBeNull())

		await waitFor(() => expect(result.current.isLocked).toBe(false))
		procedures.cartGet.call.mockResolvedValue(cart)
		act(() => result.current.confirm(input))

		await waitFor(() => expect(queryClient.getQueryData(checkoutQueryKey)).toStrictEqual(confirmed))
		expect(procedures.confirm.call).toHaveBeenCalledWith({ body: input })
		await waitFor(() => expect(queryClient.getQueryData(cartQueryKey)).toStrictEqual(cart))
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
		const cart = { ...fixtures([]).cart, items: [], itemCount: 0 }
		const error = storeError("CHECKOUT_PAYMENT_FAILED")
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
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		procedures.cartGet.call.mockResolvedValue(cart)
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
		await waitFor(() => expect(queryClient.getQueryData(cartQueryKey)).toEqual(cart))
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
	function setup(callbacks?: CheckoutCallbacks) {
		const source = fixtures()
		const values = { ...checkoutFormEncode(source.values), customerNote: "keep my edits" }
		procedures.get.call.mockResolvedValue(source.checkout)
		procedures.cartGet.call.mockResolvedValue(source.cart)
		procedures.storefrontGet.call.mockResolvedValue(source.storefront)
		const client = new QueryClient({ defaultOptions: { mutations: { retry: 3 }, queries: { retry: false, gcTime: Infinity } } })
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client }, createElement(WooCommerceProvider, { children }))
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
		const env = setup({ onError, onSettled })
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
		expect(procedures.cartGet.call).toHaveBeenCalledTimes(1)
		procedures.cartGet.call.mockResolvedValue(cart)
		procedures.confirm.call.mockResolvedValueOnce({ ...env.source.checkout, cart })
		await act(async () => {
			await env.result.current.checkout.confirmAsync(env.result.current.fields.toCheckout())
		})
		expect(procedures.confirm.call.mock.calls[1]?.[0].body.expectedTotal).toBe("54321")
		expect(env.result.current.checkout.error).toBeNull()
	})
	it("reconciles absent evidence after settlement", async () => {
		const env = setup()
		await waitFor(() => expect(env.result.current.fields.isReady && !env.result.current.checkout.isLocked).toBe(true))
		const cart = { ...env.source.cart, totals: { ...env.source.cart.totals, total: 54321 } }
		procedures.cartGet.call.mockResolvedValueOnce(cart)
		const error = mismatch(null)
		procedures.confirm.call.mockRejectedValueOnce(error)
		await act(async () => {
			await expect(env.result.current.checkout.confirmAsync(env.result.current.fields.toCheckout())).rejects.toBe(error)
		})
		await waitFor(() => expect(env.result.current.fields.toCheckout().expectedTotal).toBe("54321"))
		expect(env.result.current.fields.isReady).toBe(true)
		expect(env.values.customerNote).toBe("keep my edits")
		expect(procedures.confirm.call).toHaveBeenCalledTimes(1)
		expect(procedures.cartGet.call).toHaveBeenCalledTimes(2)
		expect(procedures.get.call).toHaveBeenCalledTimes(1)
	})
	it.each(["session", "cart", "refresh"] as const)("refuses old conflict evidence after a newer %s", async (change) => {
		const env = setup()
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
		if (change === "session") procedures.cartGet.call.mockResolvedValue(newest)
		if (change === "session")
			act(() => env.client.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderId: 99, orderKey: "new-session", cart: newest }))
		if (change === "refresh") {
			procedures.cartGet.call.mockResolvedValueOnce(newest)
			await act(async () => env.result.current.fields.refresh())
		} else act(() => env.client.setQueryData(cartQueryKey, newest))
		const reads = procedures.cartGet.call.mock.calls.length
		let resolveRead!: (cart: typeof newest) => void
		if (change !== "session")
			procedures.cartGet.call.mockReturnValueOnce(
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
			expect(procedures.cartGet.call).toHaveBeenCalledTimes(reads)
		} else {
			expect(procedures.cartGet.call).toHaveBeenCalledTimes(reads + 1)
			expect(env.result.current.checkout.isLocked).toBe(true)
			const current = { ...newest, totals: { ...newest.totals, total: 11111 } }
			await act(async () => resolveRead(current))
			await waitFor(() => expect(env.result.current.checkout.isLocked).toBe(false))
			expect(env.result.current.fields.toCheckout().expectedTotal).toBe("11111")
		}
	})
})
