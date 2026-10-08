// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { ActiveKizloClient } from "kizlo"
import { KizloProvider } from "kizlo/react"
import { createElement, type ReactNode, StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { CheckoutLockedError, checkoutLockStore } from "../checkout-locks"
import { fixtures } from "../test/checkout-fields-fixture"
import type { Cart, Checkout } from "../types"
import { useCartAddress, useCartCoupon, useCartItem, useCartShippingRates } from "./cart"
import { useCheckout } from "./checkout"
import { WooCommerceProvider } from "./provider"
import { storefrontQueryKey } from "./storefront"

const caches: QueryClient[] = []
function setup(seed = true) {
	const source = fixtures([])
	const procedure = () => ({ call: vi.fn() })
	const procedures = {
		checkout: { get: procedure(), confirm: procedure() },
		cart: {
			items: { add: procedure(), update: procedure(), remove: procedure() },
			get: procedure(),
			update: procedure(),
			selectShippingRate: procedure(),
			coupons: { apply: procedure(), remove: procedure() },
		},
		storefront: { get: procedure() },
	}
	procedures.checkout.get.call.mockResolvedValue(source.checkout)
	procedures.cart.get.call.mockResolvedValue(source.cart)
	procedures.storefront.get.call.mockResolvedValue(source.storefront)
	const client = { woocommerce: procedures } as unknown as ActiveKizloClient
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
	caches.push(cache)
	if (seed) cache.setQueryData(checkoutQueryKey, source.checkout)
	cache.setQueryData(cartQueryKey, source.cart)
	cache.setQueryData(storefrontQueryKey, source.storefront)
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(
			QueryClientProvider,
			{ client: cache },
			// biome-ignore lint/correctness/noChildrenProp: createElement requires the provider's required children prop in this .ts test.
			createElement(KizloProvider, { client, children: createElement(WooCommerceProvider, { cartEnabled: false, children }) }),
		)
	const store = checkoutLockStore(client, cache)
	return { source, procedures, cache, client, wrapper, store }
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const input = { paymentMethod: "bacs", billingAddress: fixtures([]).checkout.billingAddress }
async function tick(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms)
	})
}
afterEach(() => {
	cleanup()
	caches.splice(0).forEach((cache) => {
		cache.clear()
	})
	vi.useRealTimers()
})

describe("checkout admission", () => {
	it("registers an application mutation prefix and guards stale confirmation callbacks", async () => {
		const env = setup(),
			error = vi.fn(),
			settled = vi.fn(),
			start = vi.fn(),
			gate = deferred<number>()
		const { result } = renderHook(
			() => useCheckout({ dependencies: [{ keys: ["inventory"], type: "mutation" }], onError: error, onSettled: settled, onStart: start }),
			{ wrapper: env.wrapper },
		)
		expect(result.current.locks).toEqual([])
		const staleConfirm = result.current.confirmAsync
		const mutation = env.cache
			.getMutationCache()
			.build(env.cache, { mutationKey: ["inventory", { sku: "a" }], mutationFn: () => gate.promise })
		let request!: Promise<number>
		act(() => {
			request = mutation.execute(undefined)
		})
		await act(async () => {
			await expect(staleConfirm(input)).rejects.toBeInstanceOf(CheckoutLockedError)
			result.current.confirm(input)
		})
		expect(env.procedures.checkout.confirm.call).not.toHaveBeenCalled()
		expect(start).not.toHaveBeenCalled()
		expect(error).toHaveBeenCalledTimes(2)
		expect(settled).toHaveBeenCalledTimes(2)
		expect(result.current.error).toMatchObject({ code: "CHECKOUT_LOCKED", data: { locks: result.current.locks } })
		await act(async () => {
			gate.resolve(1)
			await request
		})
		env.procedures.checkout.confirm.call.mockResolvedValue(env.source.checkout)
		await act(async () => expect(await staleConfirm(input)).toBe(env.source.checkout))
		expect(result.current.isLocked).toBe(false)
	})
	it.each([false, true])("reserves both variants synchronously and releases after settlement (failure: %s)", async (fails) => {
		const env = setup(),
			request = deferred<Checkout>(),
			phases: boolean[] = []
		env.procedures.checkout.confirm.call.mockReturnValue(request.promise)
		const { result } = renderHook(
			() => ({
				a: useCheckout({ onSettled: () => phases.push(env.store.state.get().isLocked) }),
				b: useCheckout(),
				address: useCartAddress(),
				rates: useCartShippingRates(),
				coupon: useCartCoupon(),
			}),
			{ wrapper: env.wrapper },
		)
		let promise!: Promise<Checkout>
		act(() => {
			promise = result.current.a.confirmAsync(input)
			void promise.catch(() => {})
			result.current.b.confirm(input)
		})
		expect(env.store.state.get().isLocked).toBe(true)
		await act(async () => {
			await expect(result.current.b.confirmAsync(input)).rejects.toMatchObject({ code: "CHECKOUT_LOCKED" })
			await expect(result.current.address.updateAsync({ shippingAddress: { postcode: "NEW" } })).rejects.toMatchObject({
				code: "CHECKOUT_CONFIRMING",
			})
			await expect(result.current.rates.selectShippingRateAsync("new", 0)).rejects.toMatchObject({ code: "CHECKOUT_CONFIRMING" })
			await expect(result.current.coupon.applyAsync("SAVE")).rejects.toMatchObject({ code: "CHECKOUT_CONFIRMING" })
			result.current.address.update({ shippingAddress: { postcode: "NEW" } })
			result.current.rates.selectShippingRate("new", 0)
		})
		expect(env.procedures.checkout.confirm.call).toHaveBeenCalledTimes(1)
		expect(env.procedures.cart.update.call).not.toHaveBeenCalled()
		expect(env.procedures.cart.selectShippingRate.call).not.toHaveBeenCalled()
		expect(env.procedures.cart.coupons.apply.call).not.toHaveBeenCalled()
		await act(async () => {
			if (fails) {
				request.reject(new Error("declined"))
				await promise.catch(() => {})
			} else {
				request.resolve(env.source.checkout)
				await promise
			}
		})
		expect(phases).toEqual([true])
		expect(result.current.a.isLocked).toBe(false)
		env.procedures.checkout.confirm.call.mockResolvedValue(env.source.checkout)
		await act(async () => result.current.a.confirmAsync(input))
		expect(env.procedures.checkout.confirm.call).toHaveBeenCalledTimes(2)
	})
	it("reserves the fire-and-forget variant before another async attempt", async () => {
		const env = setup(),
			request = deferred<Checkout>()
		env.procedures.checkout.confirm.call.mockReturnValue(request.promise)
		const { result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		act(() => result.current.confirm(input))
		await act(async () => expect(result.current.confirmAsync(input)).rejects.toMatchObject({ code: "CHECKOUT_LOCKED" }))
		expect(env.procedures.checkout.confirm.call).toHaveBeenCalledTimes(1)
		await act(async () => request.resolve(env.source.checkout))
		expect(result.current.isLocked).toBe(false)
	})
	it("locks unavailable/loading checkout and refreshes through a live cache subscription", async () => {
		const env = setup(false),
			request = deferred<Checkout>()
		env.procedures.checkout.get.call.mockReturnValue(request.promise)
		const { result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		expect(result.current.isLocked).toBe(true)
		await act(async () => expect(result.current.confirmAsync(input)).rejects.toMatchObject({ code: "CHECKOUT_LOCKED" }))
		expect(env.procedures.checkout.confirm.call).not.toHaveBeenCalled()
		await act(async () => request.resolve(env.source.checkout))
		await waitFor(() => expect(result.current.isLocked).toBe(false))
	})
})

describe("address and shipping holds", () => {
	it("releases a queued revert before any HTTP and leaves other writers protected", async () => {
		vi.useFakeTimers()
		const env = setup()
		const { result } = renderHook(() => ({ a: useCartAddress({ addressDebounceMs: 50 }), b: useCartAddress({ addressDebounceMs: 50 }) }), {
			wrapper: env.wrapper,
		})
		const saved = { shippingAddress: env.source.cart.shippingAddress, useShippingAsBilling: false }
		const changed = { ...saved, shippingAddress: { ...saved.shippingAddress, city: "new" } }
		act(() => {
			result.current.a.onAddressChange(changed)
			result.current.b.onAddressChange(changed)
		})
		expect(env.store.state.get().entries).toHaveLength(1)
		act(() => result.current.a.onAddressChange(saved))
		expect(env.store.state.get().entries).toHaveLength(1)
		act(() => result.current.b.cancel())
		await tick(100)
		expect(env.store.state.get().isLocked).toBe(false)
		expect(env.procedures.cart.update.call).not.toHaveBeenCalled()
	})
	it("acquires before debounce, coalesces, and keeps edits during save protected through latest publication", async () => {
		vi.useFakeTimers()
		const env = setup(),
			first = deferred<Cart>(),
			second = deferred<Cart>()
		env.procedures.cart.update.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
		const { result } = renderHook(() => ({ address: useCartAddress({ addressDebounceMs: 50 }), checkout: useCheckout() }), {
			wrapper: env.wrapper,
		})
		const snapshot = (city: string) => ({ shippingAddress: { ...env.source.cart.shippingAddress, city }, useShippingAsBilling: false })
		act(() => {
			result.current.address.onAddressChange(snapshot("one"))
			result.current.address.onAddressChange(snapshot("two"))
		})
		expect(env.store.state.get().isLocked).toBe(true)
		expect(env.procedures.cart.update.call).not.toHaveBeenCalled()
		await tick(50)
		expect(env.procedures.cart.update.call.mock.calls[0]?.[0].body.shippingAddress.city).toBe("two")
		act(() => result.current.address.onAddressChange(snapshot("three")))
		await tick(50)
		expect(env.procedures.cart.update.call).toHaveBeenCalledTimes(1)
		await act(async () => first.resolve({ ...env.source.cart, shippingAddress: { ...env.source.cart.shippingAddress, city: "two" } }))
		expect(env.store.state.get().isLocked).toBe(true)
		await tick(50)
		await act(async () => second.resolve({ ...env.source.cart, shippingAddress: { ...env.source.cart.shippingAddress, city: "three" } }))
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.shippingAddress.city).toBe("three")
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("retains required failure across reset, then releases on retry, revert or explicit cancellation", async () => {
		vi.useFakeTimers()
		const env = setup()
		env.procedures.cart.update.call.mockRejectedValue(new Error("address refused"))
		const { result } = renderHook(() => useCartAddress({ addressDebounceMs: 50 }), { wrapper: env.wrapper })
		const snapshot = (city: string) => ({ shippingAddress: { ...env.source.cart.shippingAddress, city }, useShippingAsBilling: false })
		act(() => result.current.onAddressChange(snapshot("new")))
		await tick(50)
		expect(env.store.state.get().isLocked).toBe(true)
		act(() => result.current.reset())
		expect(env.store.state.get().isLocked).toBe(true)
		const saved = { ...env.source.cart, shippingAddress: { ...env.source.cart.shippingAddress, city: "corrected" } }
		env.procedures.cart.update.call.mockResolvedValue(saved)
		act(() => result.current.onAddressChange(snapshot("corrected")))
		await tick(50)
		expect(env.store.state.get().isLocked).toBe(false)
		env.procedures.cart.update.call.mockRejectedValue(new Error("address refused"))
		act(() => result.current.onAddressChange(snapshot("another")))
		await tick(50)
		act(() => result.current.onAddressChange(snapshot("corrected")))
		expect(env.store.state.get().isLocked).toBe(false)
		act(() => result.current.onAddressChange(snapshot("another")))
		await tick(50)
		act(() => result.current.cancel())
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("cancels queued work on unmount while retaining dispatched failures after settlement", async () => {
		vi.useFakeTimers()
		const env = setup(),
			request = deferred<Cart>()
		env.procedures.cart.update.call.mockReturnValue(request.promise)
		const writer = renderHook(() => useCartAddress({ addressDebounceMs: 50 }), { wrapper: env.wrapper })
		const snapshot = { shippingAddress: { ...env.source.cart.shippingAddress, city: "new" } }
		act(() => writer.result.current.onAddressChange(snapshot))
		await tick(50)
		act(() => writer.result.current.onAddressChange({ ...snapshot, shippingAddress: { ...snapshot.shippingAddress, city: "latest" } }))
		writer.unmount()
		expect(env.store.state.get().isLocked).toBe(true)
		await act(async () => request.reject(new Error("failed draft")))
		expect(env.store.state.get().isLocked).toBe(true)
		await tick(100)
		expect(env.procedures.cart.update.call).toHaveBeenCalledTimes(1)
	})
	it("requires exactly one rate in every physical package, retains selection failure, and supports retry/cancel", async () => {
		const env = setup()
		const missing = {
			...env.source.cart,
			shippingPackages: env.source.cart.shippingPackages.map((pkg, i) => ({
				...pkg,
				rates: pkg.rates.map((rate) => ({ ...rate, selected: i === 0 })),
			})),
		}
		env.cache.setQueryData(cartQueryKey, missing)
		const { result } = renderHook(() => ({ rates: useCartShippingRates(), checkout: useCheckout() }), { wrapper: env.wrapper })
		expect(result.current.checkout.isLocked).toBe(true)
		env.procedures.cart.selectShippingRate.call.mockRejectedValue(new Error("choice refused"))
		await act(async () => {
			await result.current.rates.selectShippingRateAsync("new", 1).catch(() => {})
		})
		expect(env.store.state.get().entries).toHaveLength(2)
		env.procedures.cart.selectShippingRate.call.mockResolvedValue(env.source.cart)
		await act(async () => result.current.rates.selectShippingRateAsync("new", 1))
		expect(result.current.checkout.isLocked).toBe(false)
		env.procedures.cart.selectShippingRate.call.mockRejectedValue(new Error("choice refused"))
		await act(async () => {
			await result.current.rates.selectShippingRateAsync("another", 1).catch(() => {})
		})
		expect(result.current.checkout.isLocked).toBe(true)
		act(() => result.current.rates.cancel())
		expect(result.current.checkout.isLocked).toBe(false)
		act(() => env.cache.setQueryData(cartQueryKey, { ...missing, needsShipping: false }))
		expect(result.current.checkout.isLocked).toBe(false)
	})
	it("retains coupon failure until its explicit reset", async () => {
		const env = setup(),
			request = deferred<Cart>()
		env.procedures.cart.coupons.apply.call.mockReturnValue(request.promise)
		const { result } = renderHook(() => ({ coupon: useCartCoupon(), checkout: useCheckout() }), { wrapper: env.wrapper })
		let promise!: Promise<Cart>
		act(() => {
			promise = result.current.coupon.applyAsync("SAVE")
			void promise.catch(() => {})
		})
		expect(env.store.state.get().isLocked).toBe(true)
		await act(async () => {
			request.reject(new Error("coupon refused"))
			await promise.catch(() => {})
		})
		expect(result.current.checkout.isLocked).toBe(true)
		act(() => result.current.coupon.reset())
		expect(result.current.checkout.isLocked).toBe(false)
	})
})

describe("session ownership", () => {
	it("a refresh begun during confirmation cannot republish its earlier checkout after success", async () => {
		const env = setup(),
			request = deferred<Checkout>(),
			refresh = deferred<Checkout>()
		env.procedures.checkout.confirm.call.mockReturnValue(request.promise)
		env.procedures.checkout.get.call.mockReturnValue(refresh.promise)
		const { result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		let confirmation!: Promise<Checkout>, reloading!: Promise<void>
		act(() => {
			confirmation = result.current.confirmAsync(input)
			reloading = result.current.refresh()
		})
		const confirmed = { ...env.source.checkout, cart: { ...env.source.cart, itemCount: 0 } }
		await act(async () => {
			request.resolve(confirmed)
			await confirmation
		})
		await act(async () => {
			refresh.resolve(env.source.checkout)
			await reloading
		})
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(0)
		expect(result.current.checkout).toStrictEqual(confirmed)
		expect(result.current.isLocked).toBe(false)
	})
	it("rejects a reserved request if the session changes before HTTP starts", async () => {
		const env = setup()
		const { result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		let promise!: Promise<Checkout>
		act(() => {
			promise = result.current.confirmAsync(input)
			void promise.catch(() => {})
			env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderKey: "replacement" })
		})
		await act(async () => expect(promise).rejects.toMatchObject({ code: "CHECKOUT_SESSION_CHANGED" }))
		expect(env.procedures.checkout.confirm.call).not.toHaveBeenCalled()
		expect(result.current.isLocked).toBe(false)
	})
	it("keeps a replacement session locked until old confirmation settles, without publishing its cart", async () => {
		const env = setup(),
			first = deferred<Checkout>(),
			second = deferred<Checkout>()
		env.procedures.checkout.confirm.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
		const { result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		let old!: Promise<Checkout>, current!: Promise<Checkout>
		act(() => {
			old = result.current.confirmAsync(input)
		})
		await act(async () => {})
		const replacement = { ...env.source.checkout, orderKey: "replacement", cart: { ...env.source.cart, itemCount: 9 } }
		act(() => {
			env.cache.setQueryData(checkoutQueryKey, replacement)
			env.cache.setQueryData(cartQueryKey, replacement.cart)
		})
		await act(async () => expect(result.current.confirmAsync(input)).rejects.toMatchObject({ code: "CHECKOUT_LOCKED" }))
		await act(async () => {
			first.resolve(env.source.checkout)
			await old
		})
		expect(env.store.state.get().isLocked).toBe(false)
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(9)
		act(() => {
			current = result.current.confirmAsync(input)
		})
		await act(async () => {
			second.resolve(replacement)
			await current
		})
		expect(result.current.isLocked).toBe(false)
	})
	it("a checkout fetch cannot overwrite a replacement while its original request settles", async () => {
		const env = setup(false),
			fetch = deferred<Checkout>()
		env.procedures.checkout.get.call.mockReturnValue(fetch.promise)
		const { result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		await act(async () => {})
		// Initial bootstrap establishes identity without invalidating existing work; the next identity replaces it.
		const bootstrapped = { ...env.source.checkout, orderKey: "bootstrap" }
		act(() => env.cache.setQueryData(checkoutQueryKey, bootstrapped))
		const replacement = { ...env.source.checkout, orderKey: "replacement", cart: { ...env.source.cart, itemCount: 9 } }
		act(() => {
			env.cache.setQueryData(checkoutQueryKey, replacement)
			env.cache.setQueryData(cartQueryKey, replacement.cart)
		})
		await act(async () => fetch.resolve(env.source.checkout))
		await waitFor(() => expect(result.current.isLocked).toBe(false))
		expect(env.cache.getQueryData<Checkout>(checkoutQueryKey)?.orderKey).toBe("replacement")
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(9)
	})
	it("keeps registered pending work through consumer unmount and isolates provider/cache scopes", async () => {
		const first = setup(),
			second = setup(),
			gate = deferred<number>()
		const a = renderHook(() => useCheckout({ dependencies: [{ keys: ["custom"], type: "mutation" }] }), { wrapper: first.wrapper })
		const b = renderHook(() => useCheckout({ dependencies: [{ keys: ["custom"], type: "mutation" }] }), { wrapper: second.wrapper })
		const mutation = first.cache.getMutationCache().build(first.cache, { mutationKey: ["custom", "a"], mutationFn: () => gate.promise })
		let request!: Promise<number>
		act(() => {
			request = mutation.execute(undefined)
		})
		expect(b.result.current.isLocked).toBe(false)
		a.unmount()
		const remount = renderHook(() => useCheckout(), { wrapper: first.wrapper })
		expect(remount.result.current.isLocked).toBe(true)
		act(() => first.cache.setQueryData(checkoutQueryKey, { ...first.source.checkout, orderKey: "replacement" }))
		expect(remount.result.current.isLocked).toBe(true)
		await act(async () => {
			gate.reject(new Error("old session"))
			await request.catch(() => {})
		})
		expect(remount.result.current.isLocked).toBe(false)
	})
	it("drops old address publication and queued work after session replacement", async () => {
		vi.useFakeTimers()
		const env = setup(),
			request = deferred<Cart>()
		env.procedures.cart.update.call.mockReturnValue(request.promise)
		const { result } = renderHook(() => useCartAddress({ addressDebounceMs: 50 }), { wrapper: env.wrapper })
		act(() => result.current.onAddressChange({ shippingAddress: { ...env.source.cart.shippingAddress, city: "old" } }))
		await tick(50)
		act(() => result.current.onAddressChange({ shippingAddress: { ...env.source.cart.shippingAddress, city: "queued" } }))
		const replacement = { ...env.source.cart, itemCount: 9 }
		act(() => {
			env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderKey: "replacement", cart: replacement })
			env.cache.setQueryData(cartQueryKey, replacement)
		})
		await act(async () => request.resolve({ ...env.source.cart, itemCount: 1 }))
		await tick(100)
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(9)
		expect(env.procedures.cart.update.call).toHaveBeenCalledTimes(1)
		expect(env.store.state.get().isLocked).toBe(false)
	})
})

describe("automatic feature readiness", () => {
	function seedItem(env: ReturnType<typeof setup>) {
		const base = env.source.cart.items[0]
		if (!base) throw new Error("Missing item fixture")
		const cart: Cart = {
			...env.source.cart,
			items: [
				{
					...base,
					key: "sku",
					quantity: 1,
					quantityLimits: { minimum: 1, maximum: 10, multipleOf: 1, editable: true },
				},
			],
		}
		env.cache.setQueryData(cartQueryKey, cart)
		env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, cart })
		return cart
	}
	it.each([true, false])("locks quantity edits before HTTP (autoCommit: %s)", async (autoCommit) => {
		vi.useFakeTimers()
		const env = setup(),
			cart = seedItem(env),
			gate = deferred<Cart>()
		env.procedures.cart.items.update.call.mockReturnValue(gate.promise)
		const { result } = renderHook(() => ({ item: useCartItem("sku", { debounceMs: 50, autoCommit }), checkout: useCheckout() }), {
			wrapper: env.wrapper,
		})
		const snapshots: boolean[] = [],
			stop = env.store.state.listen(({ isLocked }) => snapshots.push(isLocked))
		act(() => result.current.item.quantity.set(2))
		expect(env.procedures.cart.items.update.call).not.toHaveBeenCalled()
		expect(result.current.checkout.isLocked).toBe(true)
		if (autoCommit) await tick(50)
		else
			act(() => {
				void result.current.item.quantity.commit()
			})
		await tick()
		expect(env.procedures.cart.items.update.call).toHaveBeenCalledTimes(1)
		expect(snapshots).not.toContain(false)
		await act(async () => gate.resolve({ ...cart, items: cart.items.map((item) => ({ ...item, quantity: 2 })) }))
		await tick()
		expect(result.current.checkout.isLocked).toBe(false)
		stop()
	})
	it("reverts queued quantity without HTTP, while keyless drafts do not block", () => {
		vi.useFakeTimers()
		const env = setup()
		seedItem(env)
		const { result } = renderHook(
			() => ({ item: useCartItem("sku", { autoCommit: false }), draft: useCartItem(), checkout: useCheckout() }),
			{ wrapper: env.wrapper },
		)
		act(() => result.current.draft.quantity.set(2))
		expect(result.current.checkout.isLocked).toBe(false)
		act(() => result.current.item.quantity.set(2))
		expect(result.current.checkout.isLocked).toBe(true)
		act(() => result.current.item.quantity.revert())
		expect(result.current.checkout.isLocked).toBe(false)
		expect(env.procedures.cart.items.update.call).not.toHaveBeenCalled()
	})
	it.each([true, false])("hands autosave to HTTP on unmount and cancels unsent manual edits (autoCommit: %s)", async (autoCommit) => {
		vi.useFakeTimers()
		const env = setup(),
			cart = seedItem(env),
			gate = deferred<Cart>()
		env.procedures.cart.items.update.call.mockReturnValue(gate.promise)
		const checkout = renderHook(() => useCheckout(), { wrapper: env.wrapper }),
			item = renderHook(() => useCartItem("sku", { autoCommit }), { wrapper: env.wrapper })
		act(() => item.result.current.quantity.set(2))
		item.unmount()
		await tick()
		expect(env.procedures.cart.items.update.call).toHaveBeenCalledTimes(autoCommit ? 1 : 0)
		expect(checkout.result.current.isLocked).toBe(autoCommit)
		if (autoCommit) {
			await act(async () => gate.resolve(cart))
			await tick()
			expect(checkout.result.current.isLocked).toBe(false)
		}
	})
	it("shows a late address failure even when the mutation observer remembers success", async () => {
		const env = setup(),
			a = deferred<Cart>(),
			b = deferred<Cart>(),
			error = new Error("late save failed")
		env.procedures.cart.update.call.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
		const { result } = renderHook(() => ({ address: useCartAddress(), checkout: useCheckout() }), { wrapper: env.wrapper })
		let first!: Promise<Cart>, second!: Promise<Cart>
		act(() => {
			first = result.current.address.updateAsync({ shippingAddress: { city: "a" } })
			void first.catch(() => {})
			second = result.current.address.updateAsync({ shippingAddress: { city: "b" } })
		})
		await act(async () => {
			b.resolve(env.source.cart)
			await second
		})
		expect(result.current.checkout.isLocked).toBe(true)
		await act(async () => {
			a.reject(error)
			await first.catch(() => {})
		})
		expect(result.current.address.error).toBe(error)
		expect(result.current.checkout.isLocked).toBe(true)
		act(() => result.current.address.reset())
		expect(result.current.address.error).toBeNull()
		expect(result.current.checkout.isLocked).toBe(true)
		act(() => result.current.address.cancel())
		expect(result.current.checkout.isLocked).toBe(false)
	})
	it("item reset cannot dismiss another entity's newer failure", async () => {
		const env = setup(),
			cart = seedItem(env),
			a = new Error("a failed"),
			b = new Error("b failed")
		env.cache.setQueryData(cartQueryKey, { ...cart, items: cart.items.flatMap((item) => [item, { ...item, key: "other" }]) })
		env.procedures.cart.items.remove.call.mockRejectedValueOnce(a).mockRejectedValueOnce(b)
		const { result } = renderHook(() => ({ a: useCartItem("sku"), b: useCartItem("other"), checkout: useCheckout() }), {
			wrapper: env.wrapper,
		})
		await act(async () => {
			await result.current.a.removeAsync().catch(() => {})
			await result.current.b.removeAsync().catch(() => {})
		})
		expect(result.current.a.error).toBe(a)
		expect(result.current.b.error).toBe(b)
		act(() => result.current.a.reset())
		expect(result.current.checkout.isLocked).toBe(true)
		act(() => result.current.b.reset())
		expect(result.current.checkout.isLocked).toBe(false)
	})
	it("blocks failed refetches with cached data until refresh succeeds", async () => {
		const env = setup(),
			{ result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		env.procedures.checkout.get.call.mockRejectedValueOnce(new Error("offline"))
		await act(async () => result.current.refresh())
		expect(result.current.checkout).not.toBeNull()
		expect(result.current.isLocked).toBe(true)
		await act(async () => result.current.refresh())
		expect(result.current.isLocked).toBe(false)
	})
	it("requires shipping for every physical package without a rates hook", () => {
		const env = setup(),
			{ result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		act(() =>
			env.cache.setQueryData(cartQueryKey, {
				...env.source.cart,
				shippingPackages: env.source.cart.shippingPackages.map((entry, index) =>
					index === 1 ? { ...entry, rates: entry.rates.map((rate) => ({ ...rate, selected: false })) } : entry,
				),
			}),
		)
		expect(result.current.isLocked).toBe(true)
		act(() => result.current.reset())
		expect(result.current.isLocked).toBe(true)
		act(() => env.cache.setQueryData(cartQueryKey, { ...env.source.cart, needsShipping: false, shippingPackages: [] }))
		expect(result.current.isLocked).toBe(false)
	})
	it("binds once under Strict Mode and retains failures after unmount", async () => {
		const env = setup(),
			failure = new Error("failed")
		env.procedures.cart.update.call.mockRejectedValue(failure)
		const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, createElement(env.wrapper, null, children))
		const first = renderHook(() => ({ address: useCartAddress(), checkout: useCheckout() }), { wrapper })
		await act(async () => first.result.current.address.updateAsync({ shippingAddress: { city: "new" } }).catch(() => {}))
		expect(env.store.state.get().entries.filter(({ name }) => name === "cart.address")).toHaveLength(1)
		first.unmount()
		const second = renderHook(() => ({ address: useCartAddress(), checkout: useCheckout() }), { wrapper })
		expect(second.result.current.address.error).toBe(failure)
		expect(second.result.current.checkout.isLocked).toBe(true)
	})
})

it("refuses confirmation from the cache-added callback of a cart dispatch", async () => {
	const env = setup(),
		request = deferred<Cart>()
	env.procedures.cart.update.call.mockReturnValue(request.promise)
	const { result } = renderHook(() => ({ address: useCartAddress(), checkout: useCheckout() }), { wrapper: env.wrapper })
	const stop = env.cache.getMutationCache().subscribe((event) => {
		if (event.type === "added") result.current.checkout.confirm(input)
	})
	let save!: Promise<Cart>
	act(() => {
		save = result.current.address.updateAsync({ shippingAddress: { city: "new" } })
	})
	await act(async () => {})
	expect(env.procedures.checkout.confirm.call).not.toHaveBeenCalled()
	expect(result.current.checkout.error).toMatchObject({ code: "CHECKOUT_LOCKED" })
	await act(async () => {
		request.resolve(env.source.cart)
		await save
	})
	expect(result.current.checkout.isLocked).toBe(false)
	stop()
})

it("cancels queued address and quantity drafts synchronously when the session changes", async () => {
	vi.useFakeTimers()
	const env = setup(),
		base = env.source.cart.items[0]
	if (!base) throw new Error("Missing item")
	const cart = {
		...env.source.cart,
		items: [{ ...base, key: "sku", quantity: 1, quantityLimits: { minimum: 1, maximum: 10, multipleOf: 1, editable: true } }],
	}
	env.cache.setQueryData(cartQueryKey, cart)
	const { result } = renderHook(
		() => ({ address: useCartAddress({ addressDebounceMs: 50 }), item: useCartItem("sku", { debounceMs: 50 }), checkout: useCheckout() }),
		{ wrapper: env.wrapper },
	)
	act(() => {
		result.current.address.onAddressChange({ shippingAddress: { ...env.source.cart.shippingAddress, city: "old draft" } })
		result.current.item.quantity.set(2)
		env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderKey: "replacement" })
	})
	await tick(100)
	expect(env.procedures.cart.update.call).not.toHaveBeenCalled()
	expect(env.procedures.cart.items.update.call).not.toHaveBeenCalled()
	expect(result.current.item.quantity.isDirty).toBe(false)
	expect(result.current.checkout.isLocked).toBe(false)
})

it("keeps confirmation protected atomically during session replacement", async () => {
	const env = setup(),
		gate = deferred<Checkout>()
	env.procedures.checkout.confirm.call.mockReturnValue(gate.promise)
	const { result } = renderHook(() => useCheckout(), { wrapper: env.wrapper })
	let promise!: Promise<Checkout>
	act(() => {
		promise = result.current.confirmAsync(input)
	})
	await act(async () => {})
	const snapshots: boolean[] = [],
		stop = env.store.state.listen(({ isLocked }) => snapshots.push(isLocked))
	act(() => env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderKey: "new" }))
	expect(snapshots).not.toContain(false)
	await act(async () => {
		gate.resolve(env.source.checkout)
		await promise
	})
	expect(env.cache.getQueryData<Checkout>(checkoutQueryKey)?.orderKey).toBe("new")
	expect(result.current.isLocked).toBe(false)
	stop()
})

it("refuses quantity edits during confirmation without changing the acknowledged control", async () => {
	const env = setup(),
		base = env.source.cart.items[0],
		gate = deferred<Checkout>()
	if (!base) throw new Error("Missing item")
	env.cache.setQueryData(cartQueryKey, {
		...env.source.cart,
		items: [{ ...base, key: "sku", quantity: 1, quantityLimits: { minimum: 1, maximum: 10, multipleOf: 1, editable: true } }],
	})
	env.procedures.checkout.confirm.call.mockReturnValue(gate.promise)
	const { result } = renderHook(() => ({ item: useCartItem("sku"), checkout: useCheckout() }), { wrapper: env.wrapper })
	let promise!: Promise<Checkout>
	act(() => {
		promise = result.current.checkout.confirmAsync(input)
		result.current.item.quantity.set(2)
	})
	await act(async () => {})
	expect(env.procedures.cart.items.update.call).not.toHaveBeenCalled()
	expect(result.current.item.error).toMatchObject({ code: "CHECKOUT_CONFIRMING" })
	expect(result.current.item.quantity.input).toBe("1")
	await act(async () => {
		gate.resolve(env.source.checkout)
		await promise
	})
})

describe("checkout dependencies", () => {
	it.each(
		(["query", "mutation"] as const).flatMap((type) =>
			[true, false].flatMap((onPending) => [true, false].map((onError) => ({ type, onPending, onError }))),
		),
	)(
		"uses $type policy onPending=$onPending/onError=$onError for state and confirmation admission",
		async ({ type, onPending, onError }) => {
			const env = setup(),
				gate = deferred<number>(),
				error = new Error("optional task failed")
			env.procedures.checkout.confirm.call.mockResolvedValue(env.source.checkout)
			const hook = renderHook(
				() => ({
					checkout: useCheckout({ dependencies: [{ keys: ["optional"], type, block: { onPending, onError } }] }),
					query: useQuery({ queryKey: ["optional", "cart-1"], queryFn: () => gate.promise, enabled: type === "query" }),
					mutation: useMutation({ mutationKey: ["optional", "cart-1"], mutationFn: () => gate.promise }),
				}),
				{ wrapper: env.wrapper },
			)
			let request: Promise<unknown> = gate.promise.catch(() => {})
			if (type === "mutation")
				act(() => {
					request = hook.result.current.mutation.mutateAsync().catch(() => {})
				})
			expect(hook.result.current.checkout.isLocked).toBe(onPending)
			if (onPending)
				await act(async () => {
					await expect(hook.result.current.checkout.confirmAsync(input)).rejects.toBeInstanceOf(CheckoutLockedError)
				})
			await act(async () => {
				gate.reject(error)
				await request
			})
			await waitFor(() => expect(type === "query" ? hook.result.current.query.error : hook.result.current.mutation.error).toBe(error))
			expect(hook.result.current.checkout.isLocked).toBe(onError)
			await act(async () => {
				if (onError) await expect(hook.result.current.checkout.confirmAsync(input)).rejects.toBeInstanceOf(CheckoutLockedError)
				else await hook.result.current.checkout.confirmAsync(input)
			})
			expect(env.procedures.checkout.confirm.call).toHaveBeenCalledTimes(onError ? 0 : 1)
			expect(type === "query" ? hook.result.current.query.error : hook.result.current.mutation.error).toBe(error)
		},
	)
	it("applies committed policy changes while preserving another consumer's stricter policy", async () => {
		const env = setup(),
			gate = deferred<number>()
		const optional = renderHook(
			({ onError }) => useCheckout({ dependencies: [{ keys: ["optional"], type: "mutation", block: { onError } }] }),
			{
				wrapper: env.wrapper,
				initialProps: { onError: true },
			},
		)
		const required = renderHook(() => useCheckout({ dependencies: [{ keys: ["optional"], type: "mutation" }] }), { wrapper: env.wrapper })
		const mutation = env.cache.getMutationCache().build(env.cache, { mutationKey: ["optional"], mutationFn: () => gate.promise })
		let request!: Promise<unknown>
		act(() => {
			request = mutation.execute(undefined).catch(() => {})
		})
		await act(async () => {
			gate.reject(new Error("required failure"))
			await request
		})
		optional.rerender({ onError: false })
		expect(optional.result.current.locks).toHaveLength(1)
		required.unmount()
		expect(optional.result.current.isLocked).toBe(true)
		await act(async () => {
			await env.cache
				.getMutationCache()
				.build(env.cache, { mutationKey: ["optional"], mutationFn: async () => 1 })
				.execute(undefined)
		})
		expect(optional.result.current.isLocked).toBe(false)
		await act(async () => {
			await env.cache
				.getMutationCache()
				.build(env.cache, {
					mutationKey: ["optional"],
					mutationFn: async () => {
						throw new Error("optional failure")
					},
				})
				.execute(undefined)
				.catch(() => {})
		})
		expect(optional.result.current.isLocked).toBe(false)
		optional.rerender({ onError: true })
		expect(optional.result.current.isLocked).toBe(true)
		optional.rerender({ onError: false })
		expect(optional.result.current.isLocked).toBe(false)
	})
	it.each(["query", "mutation"] as const)("retains pending-only %s protection after unmount without retaining its error", async (type) => {
		const env = setup(),
			gate = deferred<number>()
		const hook = renderHook(() => useCheckout({ dependencies: [{ keys: ["optional"], type, block: { onError: false } }] }), {
			wrapper: env.wrapper,
		})
		const plain = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		let request!: Promise<unknown>
		act(() => {
			request = (
				type === "query"
					? env.cache.fetchQuery({ queryKey: ["optional"], queryFn: () => gate.promise })
					: env.cache
							.getMutationCache()
							.build(env.cache, { mutationKey: ["optional"], mutationFn: () => gate.promise })
							.execute(undefined)
			).catch(() => {})
		})
		hook.unmount()
		expect(plain.result.current.isLocked).toBe(true)
		await act(async () => {
			gate.reject(new Error("optional failure"))
			await request
		})
		expect(plain.result.current.isLocked).toBe(false)
	})
	it("keeps Kit writes, read failures, missing data and shipping enforced when custom flags are false", async () => {
		const env = setup(),
			gate = deferred<Cart>(),
			error = new Error("cart write failed")
		env.procedures.cart.update.call.mockReturnValue(gate.promise)
		const hook = renderHook(
			() => ({
				checkout: useCheckout({
					dependencies: [
						{ keys: ["kizlo"], type: "query", block: { onPending: false, onError: false } },
						{ keys: ["kizlo"], type: "mutation", block: { onPending: false, onError: false } },
					],
				}),
				address: useCartAddress(),
			}),
			{ wrapper: env.wrapper },
		)
		let request!: Promise<unknown>
		act(() => {
			request = hook.result.current.address.updateAsync({ shippingAddress: { city: "new" } }).catch(() => {})
		})
		expect(hook.result.current.checkout.isLocked).toBe(true)
		await act(async () => {
			gate.reject(error)
			await request
		})
		expect(hook.result.current.checkout.isLocked).toBe(true)
		act(() => hook.result.current.address.cancel())
		expect(hook.result.current.checkout.isLocked).toBe(false)
		const cart: Cart = {
			...env.source.cart,
			shippingPackages: env.source.cart.shippingPackages.map((entry) => ({
				...entry,
				rates: entry.rates.map((rate) => ({ ...rate, selected: false })),
			})),
		}
		act(() => env.cache.setQueryData(cartQueryKey, cart))
		expect(hook.result.current.checkout.isLocked).toBe(true)
		act(() => env.cache.setQueryData(cartQueryKey, env.source.cart))
		env.procedures.checkout.get.call.mockRejectedValue(new Error("required read failed"))
		await act(async () => {
			await hook.result.current.checkout.refresh().catch(() => {})
		})
		expect(hook.result.current.checkout.isLocked).toBe(true)
		act(() => env.cache.removeQueries({ queryKey: checkoutQueryKey, exact: true }))
		expect(hook.result.current.checkout.isLocked).toBe(true)
	})
	it.each(["query", "mutation"] as const)(
		"reads live %s state before an earlier application cache subscriber can confirm",
		async (kind) => {
			const env = setup(),
				gate = deferred<number>()
			let confirm!: () => void
			let attempted = false
			const onChange = (event: { type: string; action?: { type: string } }) => {
				if (!attempted && event.type === "updated" && event.action?.type === (kind === "query" ? "fetch" : "pending")) {
					attempted = true
					confirm()
				}
			}
			const unsubscribe =
				kind === "query" ? env.cache.getQueryCache().subscribe(onChange) : env.cache.getMutationCache().subscribe(onChange)
			const hook = renderHook(
				() =>
					useCheckout({
						dependencies: [
							{ keys: ["inventory"], type: "query" },
							{ keys: ["inventory"], type: "mutation" },
						],
					}),
				{
					wrapper: env.wrapper,
				},
			)
			confirm = () => hook.result.current.confirm(input)
			let request!: Promise<unknown>
			act(() => {
				request =
					kind === "query"
						? env.cache.fetchQuery({ queryKey: ["inventory"], queryFn: () => gate.promise })
						: env.cache
								.getMutationCache()
								.build(env.cache, { mutationKey: ["inventory"], mutationFn: () => gate.promise })
								.execute(undefined)
			})
			expect(attempted).toBe(true)
			expect(env.procedures.checkout.confirm.call).not.toHaveBeenCalled()
			expect(hook.result.current.error).toMatchObject({ code: "CHECKOUT_LOCKED" })
			await act(async () => {
				gate.resolve(1)
				await request
			})
			expect(hook.result.current.isLocked).toBe(false)
			unsubscribe()
		},
	)
	it("uses the acknowledged session for custom work dispatched by an earlier cache subscriber", async () => {
		const env = setup(),
			gate = deferred<number>()
		let request!: Promise<unknown>,
			started = false
		const unsubscribe = env.cache.getQueryCache().subscribe((event) => {
			if (
				!started &&
				event.query.queryHash === JSON.stringify(checkoutQueryKey) &&
				event.type === "updated" &&
				event.action.type === "success"
			) {
				started = true
				request = env.cache
					.getMutationCache()
					.build(env.cache, { mutationKey: ["inventory"], mutationFn: () => gate.promise })
					.execute(undefined)
					.catch(() => {})
			}
		})
		const hook = renderHook(() => useCheckout({ dependencies: [{ keys: ["inventory"], type: "mutation" }] }), { wrapper: env.wrapper })
		act(() => env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderKey: "replacement" }))
		expect(started).toBe(true)
		await act(async () => {
			gate.reject(new Error("new-session error"))
			await request
		})
		expect(hook.result.current.locks[0]?.message).toBe("new-session error")
		unsubscribe()
	})

	it("observes app useQuery/useMutation activity and independent error recovery", async () => {
		const env = setup(),
			read = deferred<number>(),
			write = deferred<number>(),
			callback = deferred<number>(),
			success = vi.fn(() => callback.promise)
		const queryFn = vi.fn(() => read.promise),
			mutationFn = vi.fn(() => write.promise)
		const { result } = renderHook(
			() => ({
				checkout: useCheckout({
					dependencies: [
						{ keys: ["inventory"], type: "query" },
						{ keys: ["reserveInventory"], type: "mutation" },
					],
				}),
				inventory: useQuery({ queryKey: ["inventory", "cart-1"], queryFn }),
				reservation: useMutation({ mutationKey: ["reserveInventory", "cart-1"], mutationFn, onSuccess: success }),
			}),
			{ wrapper: env.wrapper },
		)
		expect(result.current.checkout.isLocked).toBe(true)
		await act(async () => {
			read.resolve(1)
			await read.promise
		})
		await waitFor(() => expect(result.current.checkout.isLocked).toBe(false))
		let request!: Promise<number>
		act(() => {
			request = result.current.reservation.mutateAsync()
			void request.catch(() => {})
		})
		await act(async () => {
			write.reject(new Error("reservation failed"))
			await request.catch(() => {})
		})
		await waitFor(() => expect(result.current.reservation.error?.message).toBe("reservation failed"))
		act(() => {
			result.current.reservation.reset()
			result.current.checkout.reset()
		})
		await act(async () => {
			await result.current.inventory.refetch()
		})
		expect(result.current.checkout.isLocked).toBe(true)
		mutationFn.mockResolvedValue(2)
		act(() => {
			request = result.current.reservation.mutateAsync()
		})
		await waitFor(() => expect(success).toHaveBeenCalledOnce())
		expect(result.current.checkout.isLocked).toBe(true)
		await act(async () => {
			callback.resolve(2)
			await request
		})
		await waitFor(() => expect(result.current.checkout.isLocked).toBe(false))
	})
	it("unions option changes across consumers and retires idle selectors", async () => {
		const env = setup(),
			gate = deferred<number>()
		const a = renderHook(({ key }) => useCheckout({ dependencies: [{ keys: [key], type: "mutation" }] }), {
			wrapper: env.wrapper,
			initialProps: { key: "a" },
		})
		const b = renderHook(() => useCheckout({ dependencies: [{ keys: ["b"], type: "mutation" }] }), { wrapper: env.wrapper })
		const stale = a.result.current.confirmAsync
		a.rerender({ key: "c" })
		const old = env.cache.getMutationCache().build(env.cache, { mutationKey: ["a"], mutationFn: async () => 1 })
		await act(async () => {
			await old.execute(undefined)
		})
		expect(a.result.current.isLocked).toBe(false)
		const mutation = env.cache.getMutationCache().build(env.cache, { mutationKey: ["b"], mutationFn: () => gate.promise })
		let request!: Promise<number>
		act(() => {
			request = mutation.execute(undefined)
		})
		b.unmount()
		await act(async () => {
			await expect(stale(input)).rejects.toBeInstanceOf(CheckoutLockedError)
		})
		expect(env.procedures.checkout.confirm.call).not.toHaveBeenCalled()
		await act(async () => {
			gate.resolve(1)
			await request
		})
		expect(a.result.current.isLocked).toBe(false)
	})
	it("deduplicates inline registrations in Strict Mode without resurrecting recovered history", async () => {
		const env = setup(),
			gate = deferred<number>()
		const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, createElement(env.wrapper, null, children))
		const hook = renderHook(
			() => ({
				a: useCheckout({
					dependencies: [
						{ keys: ["inventory"], type: "mutation" },
						{ keys: ["inventory"], type: "mutation" },
					],
				}),
				b: useCheckout({ dependencies: [{ keys: ["inventory"], type: "mutation" }] }),
			}),
			{ wrapper },
		)
		const mutation = env.cache.getMutationCache().build(env.cache, { mutationKey: ["inventory", "a"], mutationFn: () => gate.promise })
		let request!: Promise<number>
		act(() => {
			request = mutation.execute(undefined)
			void request.catch(() => {})
		})
		await act(async () => {
			gate.reject(new Error("failed"))
			await request.catch(() => {})
		})
		expect(hook.result.current.a.locks).toHaveLength(1)
		hook.rerender()
		expect(hook.result.current.b.locks).toHaveLength(1)
		const retry = env.cache.getMutationCache().build(env.cache, { mutationKey: ["inventory", "b"], mutationFn: async () => 1 })
		await act(async () => {
			await retry.execute(undefined)
		})
		hook.rerender()
		expect(hook.result.current.a.isLocked).toBe(false)
	})
	it("retains a custom failure after view unmount and recovers without re-registering", async () => {
		const env = setup()
		const hook = renderHook(() => useCheckout({ dependencies: [{ keys: ["inventory"], type: "mutation" }] }), { wrapper: env.wrapper })
		const failed = env.cache.getMutationCache().build(env.cache, {
			mutationKey: ["inventory"],
			mutationFn: async () => {
				throw new Error("failed")
			},
		})
		await act(async () => {
			await failed.execute(undefined).catch(() => {})
		})
		hook.unmount()
		const plain = renderHook(() => useCheckout(), { wrapper: env.wrapper })
		expect(plain.result.current.isLocked).toBe(true)
		const retry = env.cache.getMutationCache().build(env.cache, { mutationKey: ["inventory"], mutationFn: async () => 1 })
		await act(async () => {
			await retry.execute(undefined)
		})
		expect(plain.result.current.isLocked).toBe(false)
	})
	it("preserves old query protection on replacement and latches only a fresh fetch's failure", async () => {
		const env = setup(),
			old = deferred<number>(),
			fresh = deferred<number>(),
			queryKey = ["inventory"]
		const hook = renderHook(() => useCheckout({ dependencies: [{ keys: queryKey, type: "query" }] }), { wrapper: env.wrapper })
		let first!: Promise<unknown>
		act(() => {
			first = env.cache.fetchQuery({ queryKey, queryFn: () => old.promise }).catch(() => {})
		})
		act(() => env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderKey: "replacement" }))
		expect(hook.result.current.isLocked).toBe(true)
		await act(async () => {
			old.reject(new Error("old error"))
			await first
		})
		expect(hook.result.current.isLocked).toBe(false)
		let second!: Promise<unknown>
		act(() => {
			second = env.cache.fetchQuery({ queryKey, queryFn: () => fresh.promise }).catch(() => {})
		})
		await act(async () => {
			fresh.reject(new Error("new error"))
			await second
		})
		expect(hook.result.current.locks[0]?.message).toBe("new error")
	})
})
