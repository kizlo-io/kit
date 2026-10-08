// @vitest-environment happy-dom
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cartMutationKey, cartQueryKey } from "../session-keys"
import { type CheckoutDependency, checkoutWatchSignature, createCheckoutWatch } from "./checkout-watch"

const disposers: (() => void)[] = []
function setup() {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } },
	})
	let generation = 0
	const changed = vi.fn(),
		watch = createCheckoutWatch(cache, changed, () => generation),
		owner = {}
	disposers.push(() => {
		watch.dispose()
		cache.unmount()
		cache.clear()
	})
	const mutation = (key: readonly unknown[], fn: () => Promise<number>, extra = {}) =>
		cache.getMutationCache().build(cache, { mutationKey: key, mutationFn: fn, ...extra })
	return {
		cache,
		watch,
		owner,
		changed,
		mutation,
		replace: () => {
			generation++
			watch.replaceSession()
		},
	}
}
function deferred() {
	let resolve!: (value: number) => void, reject!: (error: unknown) => void
	const promise = new Promise<number>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
afterEach(() => {
	onlineManager.setOnline(true)
	disposers.splice(0).forEach((dispose) => {
		dispose()
	})
})

describe("application checkout registrations", () => {
	const policies: CheckoutDependency["block"][] = [
		undefined,
		{},
		{ onError: false },
		{ onPending: false },
		{ onPending: true, onError: false },
		{ onPending: false, onError: true },
		{ onPending: false, onError: false },
	]
	it.each((["query", "mutation"] as const).flatMap((type) => policies.map((block) => ({ type, block }))))(
		"applies independent pending/error defaults for $type ($block)",
		async ({ type, block }) => {
			const env = setup(),
				gate = deferred(),
				error = new Error("application error")
			env.watch.register(env.owner, [{ keys: ["optional"], type, block }])
			const mutation = env.mutation(["optional", "a"], () => gate.promise)
			const request = (
				type === "query" ? env.cache.fetchQuery({ queryKey: ["optional", "a"], queryFn: () => gate.promise }) : mutation.execute(undefined)
			).catch(() => {})
			expect(env.watch.pending).toBe(true)
			expect(env.watch.reasons().size).toBe((block?.onPending ?? true) ? 1 : 0)
			gate.reject(error)
			await request
			expect(env.watch.pending).toBe(false)
			expect(env.watch.reasons().size).toBe((block?.onError ?? true) ? 1 : 0)
			expect(type === "query" ? env.cache.getQueryState(["optional", "a"])?.error : mutation.state.error).toBe(error)
		},
	)
	it.each(["query", "mutation"] as const)(
		"keeps all pending-only %s requests protected after withdrawal, then retires on failure",
		async (type) => {
			const env = setup(),
				a = deferred(),
				b = deferred()
			env.watch.register(env.owner, [{ keys: ["optional"], type, block: { onError: false } }])
			const start = (suffix: string, gate: ReturnType<typeof deferred>) =>
				(type === "query"
					? env.cache.fetchQuery({ queryKey: ["optional", suffix], queryFn: () => gate.promise })
					: env.mutation(["optional", suffix], () => gate.promise).execute(undefined)
				).catch(() => {})
			const first = start("a", a),
				second = start("b", b)
			env.watch.unregister(env.owner)
			b.resolve(1)
			await second
			expect(env.watch.reasons().size).toBe(1)
			a.reject(new Error("late optional failure"))
			await first
			expect(env.watch.reasons().size).toBe(0)
			const later = deferred(),
				ignored = start("c", later)
			expect(env.watch.pending).toBe(false)
			expect(env.watch.reasons().size).toBe(0)
			later.resolve(1)
			await ignored
		},
	)
	it.each(["query", "mutation"] as const)("commits live %s policy changes without clearing request or error state", async (type) => {
		const env = setup(),
			gate = deferred(),
			error = new Error("retained")
		const register = (onPending: boolean, onError: boolean) =>
			env.watch.register(env.owner, [{ keys: ["optional"], type, block: { onPending, onError } }])
		register(true, true)
		const request = (
			type === "query"
				? env.cache.fetchQuery({ queryKey: ["optional"], queryFn: () => gate.promise })
				: env.mutation(["optional"], () => gate.promise).execute(undefined)
		).catch(() => {})
		register(false, true)
		expect(env.watch.reasons().size).toBe(0)
		register(true, true)
		expect(env.watch.reasons().size).toBe(1)
		gate.reject(error)
		await request
		register(true, false)
		expect(env.watch.reasons().size).toBe(0)
		register(false, true)
		expect([...env.watch.reasons().values()]).toEqual(["retained"])
		env.watch.unregister(env.owner)
		expect(env.watch.reasons().size).toBe(1)
		register(false, false)
		expect(env.watch.reasons().size).toBe(0)
	})
	it("combines duplicate and conflicting consumer policies into one feature entry", async () => {
		const env = setup(),
			gate = deferred(),
			second = {}
		env.watch.register(env.owner, [
			{ keys: ["optional"], type: "mutation", block: { onPending: true, onError: false } },
			{ keys: ["optional"], type: "mutation", block: { onPending: false, onError: true } },
		])
		env.watch.register(second, [{ keys: ["optional"], type: "mutation", block: { onPending: false, onError: false } }])
		const request = env
			.mutation(["optional"], () => gate.promise)
			.execute(undefined)
			.catch(() => {})
		expect(env.watch.reasons().size).toBe(1)
		gate.reject(new Error("required by first"))
		await request
		expect([...env.watch.reasons().values()]).toEqual(["required by first"])
		env.watch.unregister(env.owner)
		expect(env.watch.reasons().size).toBe(1)
		await env.mutation(["optional"], async () => 1).execute(undefined)
		expect(env.watch.reasons().size).toBe(0)
	})
	it.each(["query", "mutation"] as const)("applies pending-only policy to paused %s work", async (type) => {
		const env = setup()
		env.cache.mount()
		onlineManager.setOnline(false)
		env.watch.register(env.owner, [{ keys: ["optional"], type, block: { onError: false } }])
		const request = (
			type === "query"
				? env.cache.fetchQuery({
						queryKey: ["optional"],
						queryFn: async () => {
							throw new Error("offline retry")
						},
					})
				: env
						.mutation(["optional"], async () => {
							throw new Error("offline retry")
						})
						.execute(undefined)
		).catch(() => {})
		await drain()
		expect(env.watch.reasons().size).toBe(1)
		onlineManager.setOnline(true)
		await request
		expect(env.watch.reasons().size).toBe(0)
	})
	it("normalizes default policies and duplicates while including flag changes in the signature", () => {
		const required: CheckoutDependency = { keys: ["optional"], type: "mutation" }
		expect(checkoutWatchSignature([required])).toBe(checkoutWatchSignature([{ ...required, block: { onPending: true, onError: true } }]))
		expect(checkoutWatchSignature([required])).toBe(
			checkoutWatchSignature([
				{ ...required, block: { onPending: true, onError: false } },
				{ ...required, block: { onPending: false, onError: true } },
			]),
		)
		expect(checkoutWatchSignature([required])).not.toBe(checkoutWatchSignature([{ ...required, block: { onError: false } }]))
	})
	it.each([false, true])("seeds an error-only query during background retry with session isolation (replaced: %s)", async (replaced) => {
		const env = setup(),
			gate = deferred(),
			queryKey = ["optional"]
		env.cache.setQueryData(queryKey, 1)
		await env.cache
			.fetchQuery({
				queryKey,
				staleTime: 0,
				queryFn: async () => {
					throw new Error("previous failure")
				},
			})
			.catch(() => {})
		if (replaced) env.replace()
		const request = env.cache.fetchQuery({ queryKey, staleTime: 0, queryFn: () => gate.promise }).catch(() => {})
		expect(env.cache.getQueryState(queryKey)).toMatchObject({ status: "error", fetchStatus: "fetching" })
		env.watch.register(env.owner, [{ keys: queryKey, type: "query", block: { onPending: false } }])
		expect([...env.watch.reasons().values()]).toEqual(replaced ? [] : ["previous failure"])
		gate.resolve(2)
		await request
		expect(env.watch.reasons().size).toBe(0)
	})
	it.each([true, false])(
		"counts every pending call and uses completion order for mutation failures (late error: %s)",
		async (lateError) => {
			const env = setup(),
				a = deferred(),
				b = deferred()
			env.watch.register(env.owner, [{ keys: ["inventory", { store: 1 }], type: "mutation" }])
			const first = env
				.mutation(["inventory", { store: 1, sku: "a" }], () => a.promise)
				.execute(undefined)
				.catch(() => {})
			const second = env
				.mutation(["inventory", { sku: "b", store: 1 }], () => b.promise)
				.execute(undefined)
				.catch(() => {})
			await drain()
			expect(env.watch.reasons().size).toBe(1)
			if (lateError) b.resolve(1)
			else b.reject(new Error("early"))
			await second
			expect(env.watch.pending).toBe(true)
			if (lateError) a.reject(new Error("late"))
			else a.resolve(1)
			await first
			expect(env.watch.pending).toBe(false)
			expect(env.watch.reasons().size).toBe(lateError ? 1 : 0)
		},
	)
	it("retains failure through retry, removal, GC, and withdrawal until matching success", async () => {
		const env = setup(),
			gate = deferred()
		env.watch.register(env.owner, [
			{ keys: ["inventory"], type: "mutation" },
			{ keys: ["other"], type: "mutation" },
		])
		const failed = env.mutation(
			["inventory", "a"],
			async () => {
				throw new Error("inventory failed")
			},
			{ gcTime: 0 },
		)
		await failed.execute(undefined).catch(() => {})
		env.cache.getMutationCache().remove(failed)
		env.watch.unregister(env.owner)
		await env.mutation(["other"], async () => 1).execute(undefined)
		expect([...env.watch.reasons().values()]).toContain("inventory failed")
		const retry = env.mutation(["inventory", "b"], () => gate.promise)
		const request = retry.execute(undefined)
		env.cache.getMutationCache().remove(retry)
		expect(env.watch.pending).toBe(true)
		expect([...env.watch.reasons().values()]).toContain("inventory failed")
		gate.resolve(1)
		await request
		expect(env.watch.reasons().size).toBe(0)
	})
	it("keeps work pending through asynchronous app callbacks without changing variables", async () => {
		const env = setup(),
			callback = deferred(),
			variables = { token: "application-owned", sku: "a" },
			success = vi.fn(() => callback.promise)
		env.watch.register(env.owner, [{ keys: ["inventory"], type: "mutation" }])
		const mutation = env.cache.getMutationCache().build(env.cache, {
			mutationKey: ["inventory"],
			mutationFn: async (input: typeof variables) => {
				expect(input).toBe(variables)
				return 1
			},
			onSuccess: success,
		})
		const request = mutation.execute(variables)
		await drain()
		expect(success).toHaveBeenCalledOnce()
		expect(env.watch.pending).toBe(true)
		callback.resolve(1)
		await request
		expect(env.watch.pending).toBe(false)
	})
	it("counts offline and scoped paused mutations", async () => {
		const env = setup(),
			gate = deferred()
		env.cache.mount()
		onlineManager.setOnline(false)
		env.watch.register(env.owner, [{ keys: ["inventory"], type: "mutation" }])
		const first = env.mutation(["inventory"], () => gate.promise, { scope: { id: "inventory" } }).execute(undefined)
		const second = env.mutation(["inventory"], async () => 1, { scope: { id: "inventory" } }).execute(undefined)
		await drain()
		expect(
			env.cache
				.getMutationCache()
				.getAll()
				.every((mutation) => mutation.state.isPaused),
		).toBe(true)
		expect(env.watch.pending).toBe(true)
		onlineManager.setOnline(true)
		await drain()
		gate.resolve(1)
		await Promise.all([first, second])
		expect(env.watch.reasons().size).toBe(0)
	})
	it("seeds ambiguous cold mutation history conservatively without resetting on duplicate registration", async () => {
		const env = setup()
		await env
			.mutation(["inventory"], async () => {
				throw new Error("history")
			})
			.execute(undefined)
			.catch(() => {})
		await env.mutation(["inventory"], async () => 1).execute(undefined)
		env.watch.register(env.owner, [{ keys: ["inventory"], type: "mutation" }])
		expect([...env.watch.reasons().values()]).toEqual(["history"])
		await env.mutation(["inventory", "retry"], async () => 1).execute(undefined)
		env.watch.register(env.owner, [
			{ keys: ["inventory"], type: "mutation" },
			{ keys: ["inventory"], type: "mutation" },
		])
		expect(env.watch.reasons().size).toBe(0)
	})
	it("unions consumer registrations, deduplicates prefixes and retires idle selectors on update", async () => {
		const env = setup(),
			second = {},
			gate = deferred()
		env.watch.register(env.owner, [
			{ keys: ["a"], type: "mutation" },
			{ keys: ["a"], type: "mutation" },
		])
		env.watch.register(second, [
			{ keys: ["a"], type: "mutation" },
			{ keys: ["b"], type: "mutation" },
		])
		env.watch.register(env.owner, [{ keys: ["c"], type: "mutation" }])
		const request = env.mutation(["a"], () => gate.promise).execute(undefined)
		expect(env.watch.reasons().size).toBe(1)
		env.watch.unregister(second)
		expect(env.watch.pending).toBe(true)
		gate.resolve(1)
		await request
		const ignored = deferred(),
			unobserved = env.mutation(["b"], () => ignored.promise).execute(undefined)
		expect(env.watch.reasons().size).toBe(0)
		ignored.resolve(1)
		await unobserved
	})
	it("keeps overlapping families independent of unrelated success", async () => {
		const env = setup()
		env.watch.register(env.owner, [
			{ keys: ["inventory"], type: "mutation" },
			{ keys: ["inventory", "reserve"], type: "mutation" },
		])
		await env
			.mutation(["inventory", "reserve", "a"], async () => {
				throw new Error("failed")
			})
			.execute(undefined)
			.catch(() => {})
		expect(env.watch.reasons().size).toBe(2)
		await env.mutation(["inventory", "check"], async () => 1).execute(undefined)
		expect(env.watch.reasons().size).toBe(1)
		await env.mutation(["inventory", "reserve", "b"], async () => 1).execute(undefined)
		expect(env.watch.reasons().size).toBe(0)
	})
	it("watches optional query fetches and preserves each concrete failure across eviction and other-variant success", async () => {
		const env = setup(),
			gate = deferred(),
			a = ["inventory", { sku: "a", store: 1 }],
			b = ["inventory", { store: 1, sku: "b" }]
		env.watch.register(env.owner, [{ keys: ["inventory", { store: 1 }], type: "query" }])
		expect(env.watch.reasons().size).toBe(0)
		env.cache.setQueryData(a, 1)
		const request = env.cache.fetchQuery({ queryKey: a, queryFn: () => gate.promise, staleTime: 0 }).catch(() => {})
		expect(env.watch.pending).toBe(true)
		env.cache.setQueryData(a, 2)
		expect(env.watch.pending).toBe(true)
		gate.reject(new Error("a failed"))
		await request
		env.cache.removeQueries({ queryKey: a, exact: true })
		env.watch.unregister(env.owner)
		await env.cache.fetchQuery({ queryKey: b, queryFn: async () => 1 })
		expect([...env.watch.reasons().values()]).toEqual(["a failed"])
		await env.cache.fetchQuery({ queryKey: a, queryFn: async () => 3 })
		expect(env.watch.reasons().size).toBe(0)
	})
	it("ignores inactive historical and idle disabled queries, but reads active errors on registration", async () => {
		const env = setup()
		await env.cache
			.fetchQuery({
				queryKey: ["inventory", "old"],
				queryFn: async () => {
					throw new Error("history")
				},
			})
			.catch(() => {})
		const disabled = new QueryObserver(env.cache, { queryKey: ["inventory", "disabled"], enabled: false, queryFn: async () => 1 })
		const unsubscribe = disabled.subscribe(() => {})
		env.watch.register(env.owner, [{ keys: ["inventory"], type: "query" }])
		expect(env.watch.reasons().size).toBe(0)
		const active = new QueryObserver(env.cache, { queryKey: ["inventory", "old"], retryOnMount: false })
		const off = active.subscribe(() => {})
		expect([...env.watch.reasons().values()]).toEqual(["history"])
		off()
		unsubscribe()
		expect(env.watch.reasons().size).toBe(1)
	})
	it("includes paused queries with cached data", async () => {
		const env = setup()
		env.cache.mount()
		env.watch.register(env.owner, [{ keys: ["inventory"], type: "query" }])
		env.cache.setQueryData(["inventory"], 1)
		onlineManager.setOnline(false)
		const request = env.cache.fetchQuery({ queryKey: ["inventory"], queryFn: async () => 2, staleTime: 0 })
		expect(env.cache.getQueryState(["inventory"])?.fetchStatus).toBe("paused")
		expect(env.watch.pending).toBe(true)
		onlineManager.setOnline(true)
		await request
		expect(env.watch.reasons().size).toBe(0)
	})
	it.each([false, true])("handles silent query cancellation without forgetting a retained failure (remove: %s)", async (remove) => {
		const env = setup(),
			gate = deferred(),
			queryKey = ["inventory"]
		env.watch.register(env.owner, [{ keys: queryKey, type: "query" }])
		await env.cache
			.fetchQuery({
				queryKey,
				queryFn: async () => {
					throw new Error("failed")
				},
			})
			.catch(() => {})
		const request = env.cache.fetchQuery({ queryKey, queryFn: () => gate.promise, staleTime: 0 }).catch(() => {})
		await drain()
		if (remove) env.cache.removeQueries({ queryKey })
		else await env.cache.cancelQueries({ queryKey }, { silent: true })
		await drain()
		expect(env.watch.pending).toBe(false)
		expect([...env.watch.reasons().values()]).toEqual(["failed"])
		gate.resolve(1)
		await request
	})
	it("does not clear a newer fetch when its predecessor is silently canceled", async () => {
		const env = setup(),
			first = deferred(),
			second = deferred(),
			queryKey = ["inventory"]
		env.watch.register(env.owner, [{ keys: queryKey, type: "query" }])
		env.cache.setQueryData(queryKey, 1)
		const observer = new QueryObserver(env.cache, { queryKey, queryFn: () => first.promise, staleTime: 0 })
		const off = observer.subscribe(() => {})
		await drain()
		observer.setOptions({ queryKey, queryFn: () => second.promise, staleTime: 0 })
		const request = observer.refetch()
		await drain()
		expect(env.watch.pending).toBe(true)
		second.resolve(2)
		await request
		expect(env.watch.pending).toBe(false)
		first.resolve(1)
		off()
	})
	it("clears old failures at session replacement but keeps old dispatched mutation/query work until settlement", async () => {
		const env = setup(),
			mutation = deferred(),
			query = deferred()
		env.watch.register(env.owner, [
			{ keys: ["inventory"], type: "mutation" },
			{ keys: ["inventory"], type: "query" },
		])
		await env
			.mutation(["inventory"], async () => {
				throw new Error("old")
			})
			.execute(undefined)
			.catch(() => {})
		const write = env
			.mutation(["inventory"], () => mutation.promise)
			.execute(undefined)
			.catch(() => {})
		const read = env.cache.fetchQuery({ queryKey: ["inventory"], queryFn: () => query.promise }).catch(() => {})
		env.replace()
		expect(env.watch.pending).toBe(true)
		mutation.reject(new Error("old write"))
		query.reject(new Error("old read"))
		await Promise.all([write, read])
		expect(env.watch.reasons().size).toBe(0)
		env.watch.register(env.owner, [
			{ keys: ["inventory"], type: "query" },
			{ keys: ["inventory"], type: "mutation" },
		])
		expect(env.watch.reasons().size).toBe(0)
	})
	it("does not adopt old-session failures when prefixes are first registered after replacement", async () => {
		const env = setup(),
			write = deferred(),
			read = deferred()
		await env
			.mutation(["inventory", "settled"], async () => {
				throw new Error("old settled")
			})
			.execute(undefined)
			.catch(() => {})
		await env.cache
			.fetchQuery({
				queryKey: ["inventory", "settled"],
				queryFn: async () => {
					throw new Error("old read")
				},
			})
			.catch(() => {})
		const observer = new QueryObserver(env.cache, { queryKey: ["inventory", "settled"], retryOnMount: false })
		const off = observer.subscribe(() => {})
		const writing = env
			.mutation(["inventory", "pending"], () => write.promise)
			.execute(undefined)
			.catch(() => {})
		const reading = env.cache.fetchQuery({ queryKey: ["inventory", "pending"], queryFn: () => read.promise }).catch(() => {})
		env.replace()
		env.watch.register(env.owner, [
			{ keys: ["inventory"], type: "mutation" },
			{ keys: ["inventory"], type: "query" },
		])
		expect(env.watch.reasons().size).toBe(2)
		expect([...env.watch.reasons().values()].every((message) => message.startsWith("Waiting"))).toBe(true)
		write.reject(new Error("late old write"))
		read.reject(new Error("late old read"))
		await Promise.all([writing, reading])
		expect(env.watch.reasons().size).toBe(0)
		await env
			.mutation(["inventory", "fresh"], async () => {
				throw new Error("fresh failure")
			})
			.execute(undefined)
			.catch(() => {})
		expect([...env.watch.reasons().values()]).toEqual(["fresh failure"])
		off()
	})
	it("does not duplicate built-in Kit roots or overwrite application cache defaults", async () => {
		const env = setup(),
			defaults = env.cache.getDefaultOptions(),
			gate = deferred()
		env.watch.register(env.owner, [
			{ keys: ["kizlo"], type: "query" },
			{ keys: ["kizlo"], type: "mutation" },
		])
		const write = env.mutation(cartMutationKey, () => gate.promise).execute(undefined)
		const read = env.cache.fetchQuery({ queryKey: cartQueryKey, queryFn: async () => 1 })
		expect(env.watch.reasons().size).toBe(0)
		expect(env.cache.getDefaultOptions()).toBe(defaults)
		gate.resolve(1)
		await Promise.all([write, read])
	})
	it("distinguishes undefined prefix fields/slots from empty objects and null despite equal JSON hashes", async () => {
		const env = setup(),
			other = {},
			gate = deferred()
		env.watch.register(env.owner, [{ keys: ["inventory", { warehouse: undefined }], type: "mutation" }])
		env.watch.register(other, [{ keys: ["inventory", {}], type: "mutation" }])
		const request = env.mutation(["inventory", { warehouse: 1 }], () => gate.promise).execute(undefined)
		expect(env.watch.reasons().size).toBe(1)
		env.watch.unregister(other)
		gate.resolve(1)
		await request
		expect(checkoutWatchSignature([{ keys: ["inventory", undefined], type: "query" }])).not.toBe(
			checkoutWatchSignature([{ keys: ["inventory", null], type: "query" }]),
		)
		expect(checkoutWatchSignature([{ keys: ["inventory", {}], type: "mutation" }])).not.toBe(
			checkoutWatchSignature([{ keys: ["inventory", { warehouse: undefined }], type: "mutation" }]),
		)
	})
	it("validates nonempty prefixes and canonicalizes repeated/order-independent option keys", () => {
		expect(() => checkoutWatchSignature([{ keys: [], type: "query" }])).toThrow("nonempty")
		expect(() => checkoutWatchSignature([{ keys: [], type: "mutation" }])).toThrow("nonempty")
		expect(
			checkoutWatchSignature([
				{ keys: ["b"], type: "mutation" },
				{ keys: ["a"], type: "mutation" },
				{ keys: ["b"], type: "mutation" },
			]),
		).toBe(
			checkoutWatchSignature([
				{ keys: ["a"], type: "mutation" },
				{ keys: ["b"], type: "mutation" },
			]),
		)
	})
})
