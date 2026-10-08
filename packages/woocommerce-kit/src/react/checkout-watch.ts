"use client"

import { CancelledError, hashKey, type Mutation, matchMutation, matchQuery, type Query, type QueryClient } from "@tanstack/react-query"
import { CheckoutLockedError } from "../checkout-locks"
import { cartMutationKey, cartQueryKey, checkoutMutationKey, checkoutQueryKey } from "../session-keys"

export type CheckoutDependency = {
	/** One nonempty inclusive structural prefix, such as ["inventory"]. */
	readonly keys: readonly unknown[]
	readonly type: "query" | "mutation"
	/** Each omitted flag defaults to true. These policies apply only to application-owned work. */
	readonly block?: { readonly onPending?: boolean; readonly onError?: boolean }
}
type Policy = { onPending: boolean; onError: boolean }
type Selector = {
	id: string
	kind: "query" | "mutation"
	key: readonly unknown[]
	owners: Map<object, Policy>
	retired: Map<object, Policy>
	pending: Map<object, { generation: number; promise?: Promise<unknown> }>
	failures: Map<string, unknown>
	seen: WeakSet<object>
}
const queryRoots = [cartQueryKey, checkoutQueryKey]
const mutationRoots = [cartMutationKey, checkoutMutationKey]
const refusal = (error: unknown) => error instanceof CancelledError || error instanceof CheckoutLockedError

// TanStack's JSON hash merges undefined with missing object fields/null array slots; prefix matching distinguishes them.
function selectorIdentity(key: readonly unknown[]) {
	const undefinedPaths: string[][] = []
	const visit = (value: unknown, path: string[]) => {
		if (value === undefined) undefinedPaths.push(path)
		else if (value !== null && typeof value === "object")
			for (const segment of Object.keys(value).sort()) visit((value as Record<string, unknown>)[segment], [...path, segment])
	}
	visit(key, [])
	return hashKey([key, undefinedPaths])
}

function normalizeDependencies(dependencies: readonly CheckoutDependency[] = []) {
	const normalized = new Map<string, { id: string; kind: Selector["kind"]; key: readonly unknown[]; policy: Policy }>()
	for (const dependency of dependencies) {
		if (dependency.keys.length === 0) throw new Error("Checkout dependencies must use nonempty key prefixes.")
		const id = `application.${dependency.type}:${selectorIdentity(dependency.keys)}`
		const policy = { onPending: dependency.block?.onPending ?? true, onError: dependency.block?.onError ?? true }
		const existing = normalized.get(id)
		if (existing) {
			existing.policy.onPending ||= policy.onPending
			existing.policy.onError ||= policy.onError
		} else normalized.set(id, { id, kind: dependency.type, key: dependency.keys, policy })
	}
	return normalized
}
const policyOf = (selector: Selector): Policy => {
	const policies = [...selector.owners.values(), ...selector.retired.values()]
	return { onPending: policies.some((policy) => policy.onPending), onError: policies.some((policy) => policy.onError) }
}
const retire = (selector: Selector, owner: object) => {
	const policy = selector.owners.get(owner)
	if (policy && (selector.pending.size || (policy.onError && selector.failures.size))) selector.retired.set(owner, policy)
	selector.owners.delete(owner)
}
const pruneRetired = (selector: Selector) => {
	for (const [owner, policy] of selector.retired)
		if (!selector.pending.size && (!policy.onError || !selector.failures.size)) selector.retired.delete(owner)
	if (!selector.owners.size && !policyOf(selector).onError) selector.failures.clear()
}

/** The stable signature validates prefixes and includes effective policies before React commits their registration. */
export function checkoutWatchSignature(dependencies?: readonly CheckoutDependency[]) {
	return hashKey([...normalizeDependencies(dependencies).values()].map(({ id, policy }) => [id, policy.onPending, policy.onError]).sort())
}

/** Registrations belong to consumers; observed work belongs to the cache until successful recovery. */
export function createCheckoutWatch(cache: QueryClient, changed: () => void, generation: () => number) {
	const selectors = new Map<string, Selector>()
	const canceledQueries = new WeakSet<Query>()
	const queryGenerations = new WeakMap<Query, number>()
	// A retry can retain a previous error with cached data; its start generation does not own that error.
	const queryOutcomes = new WeakMap<Query, number>()
	const mutationGenerations = new WeakMap<Mutation, number>()
	const runningMutations = new WeakSet<Mutation>()
	for (const mutation of cache.getMutationCache().getAll())
		if (mutation.state.status === "pending") {
			runningMutations.add(mutation)
		}
	const matchesQuery = (selector: Selector, query: Query) =>
		!queryRoots.some((queryKey) => matchQuery({ queryKey, exact: false }, query)) &&
		matchQuery({ queryKey: selector.key, exact: false }, query)
	const matchesMutation = (selector: Selector, mutation: Mutation) =>
		!mutationRoots.some((mutationKey) => matchMutation({ mutationKey, exact: false }, mutation)) &&
		matchMutation({ mutationKey: selector.key, exact: false }, mutation)
	const applicable = (selector: Selector) => selector.owners.size > 0 || selector.pending.size > 0 || selector.failures.size > 0
	const observeQuery = (selector: Selector, query: Query, terminal = false) => {
		if (!matchesQuery(selector, query) || !applicable(selector)) return
		const pending = selector.pending.get(query)
		const live =
			!canceledQueries.has(query) &&
			(query.state.fetchStatus !== "idle" || (query.isActive() && query.state.status === "pending" && !terminal))
		if (live) {
			if (pending === undefined) selector.pending.set(query, { generation: queryGenerations.get(query) ?? generation() })
			if (
				!selector.seen.has(query) &&
				query.state.status === "error" &&
				!refusal(query.state.error) &&
				(queryOutcomes.get(query) ?? queryGenerations.get(query) ?? generation()) === generation()
			)
				selector.failures.set(query.queryHash, query.state.error)
			selector.seen.add(query)
			// Silent cancellation (including removal) has no terminal cache event. Observe the public retryer promise too.
			void Promise.resolve().then(() => {
				const entry = selector.pending.get(query),
					promise = query.promise
				if (!entry || !promise || entry.promise === promise) return
				entry.promise = promise
				void promise.catch((error: unknown) => {
					if (error instanceof CancelledError && selector.pending.get(query) === entry && (!query.promise || query.promise === promise)) {
						selector.pending.delete(query)
						canceledQueries.add(query)
						pruneRetired(selector)
						changed()
					}
				})
			})
		} else if (terminal && (pending !== undefined || selector.owners.size || selector.failures.has(query.queryHash))) {
			selector.pending.delete(query)
			if ((pending?.generation ?? queryGenerations.get(query) ?? generation()) === generation()) {
				if (query.state.status === "error" && !refusal(query.state.error)) selector.failures.set(query.queryHash, query.state.error)
				else if (query.state.status === "success") selector.failures.delete(query.queryHash)
			}
			selector.seen.add(query)
		} else if (
			selector.owners.size &&
			query.isActive() &&
			!selector.seen.has(query) &&
			(queryOutcomes.get(query) ?? queryGenerations.get(query) ?? generation()) === generation()
		) {
			selector.seen.add(query)
			if (query.state.status === "error" && !refusal(query.state.error)) selector.failures.set(query.queryHash, query.state.error)
		}
		pruneRetired(selector)
	}
	const observeMutation = (selector: Selector, mutation: Mutation, cold = false) => {
		if (!matchesMutation(selector, mutation) || !applicable(selector)) return
		const pending = selector.pending.get(mutation)
		if (mutation.state.status === "pending") {
			if (pending === undefined) selector.pending.set(mutation, { generation: mutationGenerations.get(mutation) ?? generation() })
			selector.seen.add(mutation)
		} else if (pending !== undefined) {
			selector.pending.delete(mutation)
			if (pending?.generation === generation() && !refusal(mutation.state.error)) {
				if (mutation.state.status === "error") selector.failures.set(selector.id, mutation.state.error)
				else if (mutation.state.status === "success") selector.failures.clear()
			}
		} else if (cold && !selector.seen.has(mutation) && (mutationGenerations.get(mutation) ?? generation()) === generation()) {
			selector.seen.add(mutation)
			if (mutation.state.status === "error" && !refusal(mutation.state.error)) selector.failures.set(selector.id, mutation.state.error)
		}
		pruneRetired(selector)
	}
	const scan = (selector: Selector) => {
		if (selector.kind === "query") for (const query of cache.getQueryCache().getAll()) observeQuery(selector, query)
		else for (const mutation of cache.getMutationCache().getAll()) observeMutation(selector, mutation, true)
	}
	const unsubscribeQueries = cache.getQueryCache().subscribe((event) => {
		if (event.type === "updated" && event.action.type === "fetch") queryGenerations.set(event.query, generation())
		if (event.type === "updated" && ["success", "error"].includes(event.action.type) && !refusal(event.query.state.error))
			queryOutcomes.set(event.query, queryGenerations.get(event.query) ?? generation())
		let relevant = false
		for (const selector of selectors.values()) {
			if (selector.kind !== "query" || !matchesQuery(selector, event.query) || !applicable(selector)) continue
			relevant = true
			if (event.type === "updated" && event.action.type === "fetch") {
				canceledQueries.delete(event.query)
				selector.pending.delete(event.query)
			}
			observeQuery(selector, event.query, event.type === "updated" && ["success", "error"].includes(event.action.type))
		}
		if (relevant) changed()
	})
	const unsubscribeMutations = cache.getMutationCache().subscribe((event) => {
		if (event.type !== "updated") return
		if (event.mutation.state.status === "pending") {
			if (!runningMutations.has(event.mutation)) mutationGenerations.set(event.mutation, generation())
			runningMutations.add(event.mutation)
		} else runningMutations.delete(event.mutation)
		let relevant = false
		for (const selector of selectors.values()) {
			if (selector.kind !== "mutation" || !matchesMutation(selector, event.mutation) || !applicable(selector)) continue
			relevant = true
			observeMutation(selector, event.mutation)
		}
		if (relevant) changed()
	})
	return {
		refresh() {
			for (const selector of selectors.values()) {
				if (!applicable(selector)) continue
				if (selector.kind === "query") for (const query of cache.getQueryCache().getAll()) observeQuery(selector, query)
				else for (const mutation of cache.getMutationCache().getAll()) observeMutation(selector, mutation)
			}
		},
		register(owner: object, dependencies?: readonly CheckoutDependency[]) {
			const current = normalizeDependencies(dependencies)
			for (const { id, kind, key, policy } of current.values()) {
				let selector = selectors.get(id)
				if (!selector) {
					selector = { id, kind, key, owners: new Map(), retired: new Map(), pending: new Map(), failures: new Map(), seen: new WeakSet() }
					selectors.set(id, selector)
				}
				selector.retired.delete(owner)
				selector.owners.set(owner, policy)
				scan(selector)
			}
			for (const selector of selectors.values()) {
				if (!current.has(selector.id)) retire(selector, owner)
				pruneRetired(selector)
			}
			changed()
		},
		unregister(owner: object) {
			for (const selector of selectors.values()) {
				retire(selector, owner)
				pruneRetired(selector)
			}
			changed()
		},
		replaceSession() {
			// Tag even currently unregistered history so a later registration cannot adopt old-session errors/work.
			for (const query of cache.getQueryCache().getAll()) {
				if (!queryGenerations.has(query)) queryGenerations.set(query, generation() - 1)
				if (!queryOutcomes.has(query)) queryOutcomes.set(query, generation() - 1)
			}
			for (const mutation of cache.getMutationCache().getAll())
				if (!mutationGenerations.has(mutation)) mutationGenerations.set(mutation, generation() - 1)
			for (const selector of selectors.values()) {
				selector.failures.clear()
				pruneRetired(selector)
				// Settled cache history predates replacement; only new activity can latch a new-session failure.
				for (const query of cache.getQueryCache().getAll()) selector.seen.add(query)
				for (const mutation of cache.getMutationCache().getAll()) selector.seen.add(mutation)
			}
		},
		get pending() {
			return [...selectors.values()].some((selector) => selector.pending.size > 0)
		},
		reasons() {
			const reasons = new Map<string, string>()
			for (const selector of selectors.values()) {
				const policy = policyOf(selector)
				if (policy.onPending && selector.pending.size) reasons.set(selector.id, "Waiting for the registered checkout task.")
				if (policy.onError)
					for (const error of selector.failures.values())
						reasons.set(selector.id, (error as { message?: string })?.message ?? "Retry the registered checkout task.")
			}
			return reasons
		},
		dispose() {
			unsubscribeQueries()
			unsubscribeMutations()
		},
	}
}
