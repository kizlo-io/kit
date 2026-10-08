// @vitest-environment happy-dom
import { MutationObserver, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { afterEach, describe, expect, it, vi } from "vitest"
import { checkoutLockStore } from "../checkout-locks"
import { addressMutationKey, cartMutationKey, cartQueryKey, checkoutMutationKey, checkoutQueryKey, itemMutationKey } from "../session-keys"
import { fixtures } from "../test/checkout-fields-fixture"
import type { Cart, Checkout } from "../types"
import { bindCheckoutLocks, type CheckoutRequest } from "./checkout-lock-cache"

const caches: QueryClient[] = []
function setup(cartEnabled = true, attach = true) {
	const source = fixtures([])
	const procedures = {
		cart: { get: { call: vi.fn().mockResolvedValue(source.cart) } },
		checkout: { get: { call: vi.fn().mockResolvedValue(source.checkout) } },
	}
	const client = { woocommerce: procedures } as unknown as ActiveKizloClient
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
	caches.push(cache)
	cache.setQueryData(cartQueryKey, source.cart)
	cache.setQueryData(checkoutQueryKey, source.checkout)
	const store = checkoutLockStore(client, cache)
	const bind = () => bindCheckoutLocks(store, cache, client, cartEnabled)
	return { source, procedures, client, cache, store, binding: attach ? bind() : undefined, bind }
}
function deferred<T = Cart>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
afterEach(() => {
	onlineManager.setOnline(true)
	caches.splice(0).forEach((cache) => {
		cache.unmount()
		cache.clear()
	})
})

describe("cache-derived readiness", () => {
	it.each([true, false])(
		"uses the latest completed feature outcome, retaining all pending identities (late error: %s)",
		async (lateError) => {
			const env = setup(),
				binding = env.bind(),
				a = deferred(),
				b = deferred(),
				authoritative = deferred()
			env.procedures.cart.get.call.mockReturnValue(authoritative.promise)
			const failure = new Error("late address failure")
			const run = (gate: ReturnType<typeof deferred<Cart>>, suffix: string) => {
				const mutation = env.cache.getMutationCache().build(env.cache, {
					mutationKey: [...addressMutationKey, { package: suffix }],
					mutationFn: () => gate.promise,
					onMutate: async () => ({ extra: true }),
					retry: 0,
				})
				return mutation.execute(binding.admit(suffix)).catch(() => {})
			}
			const first = run(a, "a"),
				second = run(b, "b")
			await drain()
			expect(binding.readiness.state.get().pending).toHaveLength(2)
			expect(env.store.state.get().entries.filter(({ name }) => name === "cart.address")).toHaveLength(1)
			if (lateError) b.resolve(env.source.cart)
			else b.reject(failure)
			await second
			expect(env.store.state.get().isLocked).toBe(true)
			if (lateError) a.reject(failure)
			else a.resolve(env.source.cart)
			await first
			expect(binding.readiness.failure("cart.address")?.error).toBe(lateError ? failure : undefined)
			expect(env.store.state.get().entries.some(({ name }) => name === "cart.reconciliation")).toBe(true)
			authoritative.resolve(env.source.cart)
			await drain()
			expect(env.store.state.get().isLocked).toBe(lateError)
		},
	)
	it("retains removed pending requests until terminal notification and GC'd failures until recovery", async () => {
		const env = setup(),
			binding = env.bind(),
			gate = deferred(),
			error = new Error("failed")
		const mutation = env.cache
			.getMutationCache()
			.build(env.cache, { mutationKey: [...itemMutationKey, "sku"], mutationFn: () => gate.promise, gcTime: 0, retry: 0 })
		const request = mutation.execute(binding.admit({ quantity: 2 })).catch(() => {})
		await drain()
		env.cache.getMutationCache().remove(mutation)
		expect(env.cache.isMutating()).toBe(0)
		expect(binding.pending(itemMutationKey)).toBe(true)
		gate.reject(error)
		await request
		await drain()
		expect(binding.pending(itemMutationKey)).toBe(false)
		expect(binding.readiness.failure("cart.item")?.error).toBe(error)
		const retry = env.cache
			.getMutationCache()
			.build(env.cache, { mutationKey: [...itemMutationKey, "different-sku"], mutationFn: async () => env.source.cart })
		await retry.execute(binding.admit({ quantity: 3 }))
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("cold attachment conservatively retains ambiguous historical errors until future recovery", async () => {
		const env = setup(true, false),
			failure = new Error("history")
		for (const fails of [true, false]) {
			const mutation = env.cache.getMutationCache().build(env.cache, {
				mutationKey: [...itemMutationKey, "old"],
				mutationFn: async () => {
					if (fails) throw failure
					return env.source.cart
				},
				retry: 0,
			})
			await mutation.execute("old").catch(() => {})
		}
		const binding = env.bind()
		expect(env.store.state.get().isLocked).toBe(true)
		const mutation = env.cache
			.getMutationCache()
			.build(env.cache, { mutationKey: [...itemMutationKey, "new"], mutationFn: async () => env.source.cart })
		await mutation.execute(binding.admit("new"))
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("counts offline/scoped work while paused without HTTP", async () => {
		const env = setup(),
			binding = env.bind(),
			call = vi.fn().mockResolvedValue(env.source.cart)
		env.cache.mount()
		onlineManager.setOnline(false)
		const observer = new MutationObserver(env.cache, {
			mutationKey: [...addressMutationKey, "paused"],
			mutationFn: call,
			scope: { id: "address" },
			retry: 0,
		})
		const request = observer.mutate(binding.admit("address"))
		await drain()
		expect(call).not.toHaveBeenCalled()
		expect(observer.getCurrentResult().isPaused).toBe(true)
		expect(env.store.state.get().isLocked).toBe(true)
		onlineManager.setOnline(true)
		await request
		expect(call).toHaveBeenCalledTimes(1)
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("locks through async callbacks without double-counting onMutate context", async () => {
		const env = setup(),
			binding = env.bind(),
			callback = deferred<void>(),
			phases: boolean[] = []
		const mutation = env.cache.getMutationCache().build(env.cache, {
			mutationKey: addressMutationKey,
			mutationFn: async () => env.source.cart,
			onMutate: async () => "context",
			onSuccess: async () => {
				phases.push(env.store.state.get().isLocked)
				await callback.promise
			},
			onSettled: () => {
				phases.push(env.store.state.get().isLocked)
			},
		})
		const promise = mutation.execute(binding.admit("address"))
		await drain()
		expect(binding.readiness.state.get().pending).toHaveLength(1)
		callback.resolve()
		await promise
		expect(phases).toEqual([true, true])
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("discovers checkout descendants without applying confirmation's retry exception", async () => {
		const env = setup(),
			binding = env.bind(),
			error = new Error("payment task")
		const mutation = env.cache.getMutationCache().build(env.cache, {
			mutationKey: [...checkoutMutationKey, "paymentSetup", { method: "card" }],
			mutationFn: async () => {
				throw error
			},
			retry: 0,
		})
		await mutation.execute(binding.admit("card")).catch(() => {})
		expect(binding.readiness.failure("checkout.paymentSetup")?.error).toBe(error)
		expect(() => binding.reserve("confirm")).toThrow()
	})
	it("reserves before a cache-added callback can reenter confirmation", async () => {
		const env = setup(),
			binding = env.bind(),
			call = vi.fn().mockResolvedValue(env.source.checkout),
			rejected = vi.fn()
		binding.enableCheckout()
		const observer = new MutationObserver<Checkout, Error, CheckoutRequest<string>>(env.cache, {
			mutationKey: checkoutMutationKey,
			meta: { kitCheckoutRole: "confirmation" },
			mutationFn: call,
		})
		const stop = env.cache.getMutationCache().subscribe((event) => {
			if (event.type === "added") {
				try {
					binding.reserve("again")
				} catch {
					rejected()
				}
			}
		})
		await observer.mutate(binding.reserve("order"))
		expect(call).toHaveBeenCalledTimes(1)
		expect(rejected).toHaveBeenCalledTimes(1)
		expect(binding.isPending).toBe(false)
		stop()
	})
	it("discards only an unused reservation after dispatch failure", () => {
		const env = setup(),
			binding = env.bind(),
			request = binding.reserve("order")
		expect(binding.isPending).toBe(true)
		binding.discard(request)
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("retains pending protection after eviction while rejecting obsolete publication", async () => {
		const env = setup(),
			binding = env.bind(),
			gate = deferred(),
			variables = binding.admit("write")
		const mutation = env.cache.getMutationCache().build(env.cache, {
			mutationKey: addressMutationKey,
			mutationFn: () => gate.promise,
			onSuccess: (cart) => binding.publishCart(variables.token, cart),
		})
		const request = mutation.execute(variables)
		await drain()
		env.cache.removeQueries({ queryKey: cartQueryKey })
		expect(env.store.state.get().isLocked).toBe(true)
		gate.resolve({ ...env.source.cart, itemCount: 99 })
		await request
		expect(env.cache.getQueryData(cartQueryKey)).toBeUndefined()
	})
	it("retains old-session pending work but discards its late failure", async () => {
		const env = setup(),
			binding = env.bind(),
			gate = deferred()
		const mutation = env.cache.getMutationCache().build(env.cache, { mutationKey: addressMutationKey, mutationFn: () => gate.promise })
		const request = mutation.execute(binding.admit("old")).catch(() => {})
		await drain()
		env.cache.setQueryData(checkoutQueryKey, { ...env.source.checkout, orderKey: "new" })
		expect(binding.pending(addressMutationKey)).toBe(true)
		gate.reject(new Error("old"))
		await request
		expect(binding.readiness.failure("cart.address")).toBeUndefined()
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("rejects old runtime tokens after reconstruction", () => {
		const env = setup(),
			old = env.bind(),
			request = old.admit("old")
		old.dispose()
		expect(() => env.bind().assertCurrent(request.token)).toThrow()
	})
	it("binds once and disposes listeners on idle scope replacement", async () => {
		const env = setup(),
			binding = env.bind(),
			subscriptions = vi.spyOn(env.cache.getMutationCache(), "subscribe")
		expect(env.bind()).toBe(binding)
		expect(subscriptions).not.toHaveBeenCalled()
		const detach = binding.attach(),
			client = { woocommerce: env.procedures } as unknown as ActiveKizloClient,
			store = checkoutLockStore(client, env.cache)
		expect(() => bindCheckoutLocks(store, env.cache, client, true)).toThrow("separate QueryClients")
		detach()
		env.cache.clear()
		const next = bindCheckoutLocks(store, env.cache, client, true)
		const mutation = env.cache.getMutationCache().build(env.cache, {
			mutationKey: [...cartMutationKey, "newFeature"],
			mutationFn: async () => {
				throw new Error("new scope")
			},
		})
		await mutation.execute(next.admit("new")).catch(() => {})
		expect(binding.readiness.state.get().failures).toHaveLength(0)
		expect(next.readiness.failure("cart.newFeature")).toBeDefined()
	})
})

describe("query readiness and publication", () => {
	it("blocks background fetches, manual publication during fetch, and errors until successful retry", async () => {
		const env = setup(),
			binding = env.bind(),
			gate = deferred<Checkout>(),
			error = new Error("refresh failed")
		binding.enableCheckout()
		const request = env.cache.fetchQuery({ queryKey: checkoutQueryKey, staleTime: 0, queryFn: () => gate.promise }).catch(() => {})
		expect(env.store.state.get().isLocked).toBe(true)
		env.cache.setQueryData(checkoutQueryKey, env.source.checkout)
		expect(env.store.state.get().isLocked).toBe(true)
		gate.reject(error)
		await request
		expect(env.store.state.get().isLocked).toBe(true)
		expect(env.cache.getQueryData(checkoutQueryKey)).toBeTruthy()
		await env.cache.fetchQuery({ queryKey: checkoutQueryKey, staleTime: 0, queryFn: async () => env.source.checkout })
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("blocks paused reads with cached data", async () => {
		const env = setup()
		env.cache.mount()
		onlineManager.setOnline(false)
		const request = env.cache.fetchQuery({ queryKey: cartQueryKey, staleTime: 0, queryFn: async () => env.source.cart })
		expect(env.cache.getQueryState(cartQueryKey)?.fetchStatus).toBe("paused")
		expect(env.store.state.get().isLocked).toBe(true)
		onlineManager.setOnline(true)
		await request
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it("ignores disabled/historical optional entries and watches active structural descendants", async () => {
		const env = setup(),
			key = [...cartQueryKey, "quote", { package: 1 }],
			other = [...cartQueryKey, "quote", { package: 2 }]
		await env.cache
			.fetchQuery({
				queryKey: other,
				queryFn: async () => {
					throw new Error("unused")
				},
			})
			.catch(() => {})
		const disabled = new QueryObserver(env.cache, { queryKey: key, enabled: false }),
			unsubscribe = disabled.subscribe(() => {})
		expect(env.store.state.get().isLocked).toBe(false)
		const gate = deferred<number>()
		disabled.setOptions({ queryKey: key, enabled: true, queryFn: () => gate.promise })
		expect(env.store.state.get().entries.some(({ name }) => name === "cart.read")).toBe(true)
		gate.resolve(1)
		await drain()
		expect(env.store.state.get().isLocked).toBe(false)
		unsubscribe()
	})
	it("retains required read failures through eviction and safely bootstraps cold hydrated checkout", async () => {
		const env = setup(false),
			binding = env.bind()
		binding.enableCheckout()
		await env.cache
			.fetchQuery({
				queryKey: cartQueryKey,
				staleTime: 0,
				queryFn: async () => {
					throw new Error("cart failed")
				},
			})
			.catch(() => {})
		env.cache.removeQueries({ queryKey: cartQueryKey })
		binding.enableCheckout()
		expect(env.store.state.get().isLocked).toBe(true)
		expect(env.cache.getQueryData(cartQueryKey)).toBeUndefined()
		await env.cache.fetchQuery({ queryKey: cartQueryKey, queryFn: async () => env.source.cart })
		expect(env.store.state.get().isLocked).toBe(false)
		const cold = setup(false, false)
		cold.cache.removeQueries({ queryKey: cartQueryKey })
		cold.bind().enableCheckout()
		expect(cold.cache.getQueryData(cartQueryKey)).toBe(cold.source.cart)
	})
	it("checks cancellation before a late read can repopulate removed caches", async () => {
		const env = setup(),
			binding = env.bind(),
			gate = deferred<Checkout>()
		env.procedures.checkout.get.call.mockReturnValue(gate.promise)
		const request = env.cache
			.fetchQuery({ queryKey: checkoutQueryKey, staleTime: 0, queryFn: ({ signal }) => binding.readCheckout(signal) })
			.catch(() => {})
		env.cache.removeQueries({ queryKey: checkoutQueryKey })
		env.cache.setQueryData(cartQueryKey, { ...env.source.cart, itemCount: 9 })
		gate.resolve(env.source.checkout)
		await request
		await drain()
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(9)
		expect(env.cache.getQueryData(checkoutQueryKey)).toBeUndefined()
	})
	it("prevents a same-session late GET from overwriting an acknowledged write", async () => {
		const env = setup(),
			binding = env.bind(),
			gate = deferred<Checkout>()
		env.procedures.checkout.get.call.mockReturnValue(gate.promise)
		const read = env.cache
			.fetchQuery({ queryKey: checkoutQueryKey, staleTime: 0, queryFn: ({ signal }) => binding.readCheckout(signal) })
			.catch(() => {})
		const write = binding.admit("update")
		binding.publishCart(write.token, { ...env.source.cart, itemCount: 9 })
		gate.resolve(env.source.checkout)
		await read
		await drain()
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(9)
		expect(env.store.state.get().isLocked).toBe(false)
	})
})

describe("authoritative cart reconciliation", () => {
	it.each([true, false])("reconciles overlapping full-cart responses without an unlock gap (B finishes first: %s)", async (bFirst) => {
		const env = setup(),
			binding = env.bind(),
			a = deferred(),
			b = deferred(),
			read = deferred(),
			snapshots: boolean[] = []
		env.procedures.cart.get.call.mockReturnValue(read.promise)
		const stop = env.store.state.listen(({ isLocked }) => snapshots.push(isLocked))
		const run = (gate: ReturnType<typeof deferred<Cart>>, suffix: string) => {
			const variables = binding.admit(suffix)
			return env.cache
				.getMutationCache()
				.build(env.cache, {
					mutationKey: [...itemMutationKey, suffix],
					mutationFn: () => gate.promise,
					onSuccess: (cart) => binding.publishCart(variables.token, cart),
				})
				.execute(variables)
		}
		const first = run(a, "a"),
			second = run(b, "b")
		if (bFirst) {
			b.resolve({ ...env.source.cart, itemCount: 2 })
			await second
			a.resolve({ ...env.source.cart, itemCount: 1 })
			await first
		} else {
			a.resolve({ ...env.source.cart, itemCount: 1 })
			await first
			b.resolve({ ...env.source.cart, itemCount: 2 })
			await second
		}
		expect(env.procedures.cart.get.call).toHaveBeenCalledTimes(1)
		expect(snapshots).not.toContain(false)
		expect(() => binding.reserve("confirm")).toThrow()
		read.resolve({ ...env.source.cart, itemCount: 3 })
		await drain()
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(3)
		expect(env.store.state.get().isLocked).toBe(false)
		stop()
	})
	it("invalidates and coalesces reconciliation when another write starts during the GET", async () => {
		const env = setup(),
			binding = env.bind(),
			oldRead = deferred(),
			freshRead = deferred(),
			a = deferred(),
			b = deferred(),
			c = deferred()
		env.procedures.cart.get.call.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise)
		const run = (gate: ReturnType<typeof deferred<Cart>>) => {
			const variables = binding.admit("write")
			return env.cache
				.getMutationCache()
				.build(env.cache, {
					mutationKey: itemMutationKey,
					mutationFn: () => gate.promise,
					onSuccess: (cart) => binding.publishCart(variables.token, cart),
				})
				.execute(variables)
		}
		const first = run(a),
			second = run(b)
		a.resolve(env.source.cart)
		b.resolve(env.source.cart)
		await Promise.all([first, second])
		await drain()
		const third = run(c)
		await drain()
		oldRead.resolve({ ...env.source.cart, itemCount: 100 })
		await drain()
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).not.toBe(100)
		expect(env.store.state.get().isLocked).toBe(true)
		c.resolve({ ...env.source.cart, itemCount: 4 })
		await third
		await drain()
		expect(env.procedures.cart.get.call).toHaveBeenCalledTimes(2)
		freshRead.resolve({ ...env.source.cart, itemCount: 5 })
		await drain()
		expect(env.cache.getQueryData<Cart>(cartQueryKey)?.itemCount).toBe(5)
		expect(env.store.state.get().isLocked).toBe(false)
	})
	it.each([true, false])("retains a failed reconciliation until explicit read retry (cartEnabled: %s)", async (cartEnabled) => {
		const env = setup(cartEnabled),
			binding = env.bind(),
			a = deferred(),
			b = deferred(),
			error = new Error("reconciliation failed")
		binding.enableCheckout()
		const procedure = cartEnabled ? env.procedures.cart.get : env.procedures.checkout.get
		procedure.call.mockRejectedValueOnce(error)
		const run = (gate: ReturnType<typeof deferred<Cart>>) =>
			env.cache
				.getMutationCache()
				.build(env.cache, { mutationKey: itemMutationKey, mutationFn: () => gate.promise })
				.execute(binding.admit("write"))
		const first = run(a),
			second = run(b)
		a.resolve(env.source.cart)
		b.resolve(env.source.cart)
		await Promise.all([first, second])
		await drain()
		expect(env.store.state.get().isLocked).toBe(true)
		expect(procedure.call).toHaveBeenCalledTimes(1)
		if (cartEnabled) await env.cache.fetchQuery({ queryKey: cartQueryKey, staleTime: 0, queryFn: ({ signal }) => binding.readCart(signal) })
		else await env.cache.fetchQuery({ queryKey: checkoutQueryKey, staleTime: 0, queryFn: ({ signal }) => binding.readCheckout(signal) })
		expect(env.store.state.get().isLocked).toBe(false)
	})
})

it("resumes missing checkout bootstrap after a write cancelled the initial read", async () => {
	const env = setup(),
		binding = env.bind(),
		firstRead = deferred<Checkout>(),
		freshRead = deferred<Checkout>(),
		write = deferred()
	env.cache.removeQueries({ queryKey: checkoutQueryKey })
	env.procedures.checkout.get.call.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(freshRead.promise)
	binding.enableCheckout()
	const read = env.cache.fetchQuery({ queryKey: checkoutQueryKey, queryFn: ({ signal }) => binding.readCheckout(signal) }).catch(() => {})
	const variables = binding.admit("cart write")
	const mutation = env.cache.getMutationCache().build(env.cache, {
		mutationKey: addressMutationKey,
		mutationFn: () => write.promise,
		onSuccess: (cart) => binding.publishCart(variables.token, cart),
	})
	const request = mutation.execute(variables)
	write.resolve(env.source.cart)
	await request
	await drain()
	expect(env.procedures.checkout.get.call).toHaveBeenCalledTimes(2)
	expect(env.procedures.cart.get.call).not.toHaveBeenCalled()
	expect(env.store.state.get().isLocked).toBe(true)
	firstRead.resolve({ ...env.source.checkout, orderKey: "obsolete" })
	await read
	freshRead.resolve(env.source.checkout)
	await drain()
	expect(env.cache.getQueryData<Checkout>(checkoutQueryKey)?.orderKey).toBe(env.source.checkout.orderKey)
	expect(env.store.state.get().isLocked).toBe(false)
})

it("counts both pending scoped mutations while only the first has started HTTP", async () => {
	const env = setup(),
		binding = env.bind(),
		first = deferred(),
		second = deferred(),
		calls = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
	const run = () =>
		env.cache
			.getMutationCache()
			.build(env.cache, { mutationKey: addressMutationKey, scope: { id: "same-address" }, mutationFn: calls })
			.execute(binding.admit("address"))
	const a = run(),
		b = run()
	await drain()
	expect(calls).toHaveBeenCalledTimes(1)
	expect(binding.readiness.state.get().pending).toHaveLength(2)
	expect(
		env.cache
			.getMutationCache()
			.getAll()
			.some((mutation) => mutation.state.isPaused),
	).toBe(true)
	first.resolve(env.source.cart)
	await a
	await drain()
	expect(env.store.state.get().isLocked).toBe(true)
	expect(calls).toHaveBeenCalledTimes(2)
	second.resolve(env.source.cart)
	await b
	await drain()
	expect(env.store.state.get().isLocked).toBe(false)
})
