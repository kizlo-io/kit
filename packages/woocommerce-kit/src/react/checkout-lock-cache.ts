"use client"

import { CancelledError, type Mutation, matchMutation, matchQuery, type QueryClient } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { hasSelectedShippingRates } from "../cart"
import { checkoutSession } from "../checkout-errors"
import { type CheckoutConfirmationToken, CheckoutLockedError, type CheckoutLockStore } from "../checkout-locks"
import { createCheckoutReadiness } from "../checkout-readiness"
import {
	addressQueueKey,
	type CheckoutQueueOwner,
	cartMutationKey,
	cartQueryKey,
	checkoutMutationKey,
	checkoutQueryKey,
	noQueuedWork,
	quantityQueueKey,
} from "../session-keys"
import type { Cart, Checkout } from "../types"
import { createCheckoutWatch } from "./checkout-watch"

export type CheckoutRequestToken = Readonly<{
	scope: object
	generation: number
	epoch: number
	session: string | null
	revision: number
	cartVersion: number
	checkoutVersion: number
}>
export type CheckoutRequest<T> = { payload: T; token: CheckoutRequestToken; reservation?: CheckoutConfirmationToken }
const roots = [cartQueryKey, checkoutQueryKey] as const
const mutationRoots = [cartMutationKey, checkoutMutationKey] as const
function featureOf(mutation: Mutation) {
	const root = mutationRoots.find((mutationKey) => matchMutation({ mutationKey, exact: false }, mutation))
	return root
		? `${root[2]}.${mutation.options.meta?.kitCheckoutRole === "confirmation" ? "confirmation" : String(mutation.options.mutationKey?.[root.length] ?? "action")}`
		: null
}
function requestOf(mutation: Mutation): CheckoutRequest<unknown> | undefined {
	const variables = mutation.state.variables
	return variables && typeof variables === "object" && "token" in variables ? (variables as CheckoutRequest<unknown>) : undefined
}
function localRefusal(error: unknown) {
	return error instanceof CheckoutLockedError || error instanceof CancelledError
}

function createBinding(store: CheckoutLockStore, cache: QueryClient, client: ActiveKizloClient, cartEnabled: boolean) {
	const scope = {}
	const dispatching = new Map<string, number>()
	const readiness = createCheckoutReadiness()
	const watch = createCheckoutWatch(
		cache,
		() => sync(),
		() => {
			syncGeneration()
			return store.generation
		},
	)
	const seen = new WeakMap<
		Mutation,
		{ feature: string; generation: number; confirmation: boolean; reservation?: CheckoutConfirmationToken }
	>()
	const relevantReads = new WeakSet<object>()
	const queryFailures = new Map<string, { feature: string; error: unknown }>()
	let consumers = 0
	let checkoutEnabled = false
	let generation = store.generation
	let epoch = 0
	let needsReconciliation = false
	let reconciling = false
	let disposed = false
	let publishing = false
	const queueKeys = [addressQueueKey, quantityQueueKey] as const
	const queued = () =>
		queueKeys.some((key) =>
			(cache.getQueryData<readonly CheckoutQueueOwner[]>(key) ?? noQueuedWork).some((entry) => entry.generation === store.generation),
		)
	const current = (token: CheckoutRequestToken) =>
		!disposed &&
		token?.scope === scope &&
		token.generation === store.generation &&
		token.epoch === epoch &&
		(token.session === store.session || token.session === null)
	const requestToken = (): CheckoutRequestToken =>
		Object.freeze({
			scope,
			generation,
			epoch,
			session: store.session,
			revision: store.revision,
			cartVersion: cache.getQueryState(cartQueryKey)?.dataUpdateCount ?? 0,
			checkoutVersion: cache.getQueryState(checkoutQueryKey)?.dataUpdateCount ?? 0,
		})
	const syncGeneration = () => {
		store.syncSession(checkoutSession(cache.getQueryData<Checkout>(checkoutQueryKey)))
		if (generation !== store.generation) {
			generation = store.generation
			epoch++
			readiness.replaceSession()
			watch.replaceSession()
			queryFailures.clear()
			cancelReads()
			for (const key of queueKeys) if (cache.getQueryData(key)) cache.setQueryData(key, noQueuedWork)
		}
	}
	const sync = () => {
		if (disposed || publishing) return
		publishing = true
		syncGeneration()
		watch.refresh()
		const reasons = new Map([...readiness.reasons(), ...watch.reasons()])
		for (const feature of dispatching.keys()) reasons.set(feature, "Starting the checkout task.")
		if (store.isConfirming) reasons.delete("checkout.confirmation")
		for (const [index, key] of queueKeys.entries()) {
			if ((cache.getQueryData<readonly CheckoutQueueOwner[]>(key) ?? noQueuedWork).some((entry) => entry.generation === generation))
				reasons.set(index === 0 ? "cart.address" : "cart.item", "Waiting to save the cart.")
		}
		for (const query of cache.getQueryCache().getAll()) {
			const root = roots.find((queryKey) => matchQuery({ queryKey, exact: false }, query))
			if (!root || queueKeys.some((queryKey) => matchQuery({ queryKey, exact: false }, query))) continue
			const required = query.queryKey.length === root.length
			const applicable = required
				? checkoutEnabled || query.isActive() || query.state.fetchStatus !== "idle"
				: query.isActive() || query.state.fetchStatus !== "idle"
			if (!applicable) {
				if (!required) queryFailures.delete(query.queryHash)
				continue
			}
			relevantReads.add(query)
			const feature = `${root[2]}.read`
			if (query.state.fetchStatus !== "idle" || query.state.status === "pending") reasons.set(feature, "Loading the checkout data.")
			if (query.state.status === "error" && !localRefusal(query.state.error))
				queryFailures.set(query.queryHash, { feature, error: query.state.error })
		}
		for (const { feature, error } of queryFailures.values())
			reasons.set(feature, (error as { message?: string })?.message ?? "Reload the checkout data.")
		if (checkoutEnabled) {
			if (!cache.getQueryData(cartQueryKey)) reasons.set("cart.read", "Loading the cart.")
			if (!cache.getQueryData(checkoutQueryKey)) reasons.set("checkout.read", "Loading the checkout.")
			if (!hasSelectedShippingRates(cache.getQueryData<Cart>(cartQueryKey) ?? null))
				reasons.set("cart.shipping", "Choose a shipping rate for every package.")
		}
		if (needsReconciliation) reasons.set("cart.reconciliation", "Refreshing the acknowledged cart.")
		store.setAutomatic(reasons)
		publishing = false
	}
	const cancelReads = () => {
		store.invalidateReads()
		for (const queryKey of roots) void cache.cancelQueries({ queryKey, exact: false })
	}
	const assertWritable = () => {
		sync()
		if (store.isConfirming || readiness.state.get().pending.some((entry) => entry.confirmation))
			throw new CheckoutLockedError("CHECKOUT_CONFIRMING", store.state.get().entries)
	}
	const dispatch = <T>(feature: string, action: () => T): T => {
		assertWritable()
		dispatching.set(feature, (dispatching.get(feature) ?? 0) + 1)
		sync()
		try {
			return action()
		} finally {
			const remaining = (dispatching.get(feature) ?? 1) - 1
			if (remaining) dispatching.set(feature, remaining)
			else dispatching.delete(feature)
			sync()
		}
	}
	const readCart = async (signal: AbortSignal) => {
		const revision = store.revision,
			readEpoch = epoch
		const cart = await client.woocommerce.cart.get.call()
		if (signal.aborted || revision !== store.revision || readEpoch !== epoch) throw new CancelledError({ revert: true })
		return cart
	}
	const readCheckout = async (signal: AbortSignal) => {
		const revision = store.revision,
			readEpoch = epoch
		const checkout = await client.woocommerce.checkout.get.call()
		if (signal.aborted || revision !== store.revision || readEpoch !== epoch) throw new CancelledError({ revert: true })
		cache.setQueryData(cartQueryKey, checkout.cart)
		return checkout
	}
	const reconcile = () => {
		if (!needsReconciliation || reconciling || readiness.state.get().pending.length || queued() || dispatching.size || disposed) return
		reconciling = true
		const revision = store.revision,
			readEpoch = epoch
		const useCart = cartEnabled && !(checkoutEnabled && !cache.getQueryData(checkoutQueryKey))
		const queryKey = useCart ? cartQueryKey : checkoutQueryKey
		void cache
			.fetchQuery<Cart | Checkout>({
				queryKey,
				queryFn: ({ signal }) => (useCart ? readCart(signal) : readCheckout(signal)),
				staleTime: 0,
				retry: false,
			})
			.then(
				() => {
					if (revision === store.revision && readEpoch === epoch) needsReconciliation = false
				},
				(error: unknown) => {
					// Cancellation coalesces into a later read; a real failure remains visible until an explicit refresh.
					if (!localRefusal(error)) needsReconciliation = false
				},
			)
			.finally(() => {
				reconciling = false
				sync()
				if (needsReconciliation) reconcile()
			})
	}
	const observeMutation = (mutation: Mutation, cold = false) => {
		const feature = featureOf(mutation)
		if (!feature) return
		const request = requestOf(mutation)
		let info = seen.get(mutation)
		if (mutation.state.status === "pending") {
			if (!info) {
				info = {
					feature,
					generation: request ? (request.token.scope === scope ? request.token.generation : -1) : generation,
					confirmation: request?.token.scope === scope && !!request.reservation,
					reservation: request?.reservation,
				}
				seen.set(mutation, info)
				if (feature.startsWith("cart.") && readiness.state.get().pending.some((entry) => entry.feature.startsWith("cart.")))
					needsReconciliation = true
			}
			readiness.start({ identity: mutation, ...info })
		} else if (mutation.state.status === "error" || mutation.state.status === "success") {
			if (info) {
				const error = localRefusal(mutation.state.error) ? null : mutation.state.error
				readiness.finish(
					mutation,
					feature,
					info.generation,
					store.generation,
					error,
					info.confirmation || localRefusal(mutation.state.error),
				)
				if (info.confirmation && info.reservation) store.releaseConfirmation(info.reservation)
				seen.delete(mutation)
			} else if (
				cold &&
				mutation.options.meta?.kitCheckoutRole !== "confirmation" &&
				mutation.state.status === "error" &&
				!localRefusal(mutation.state.error)
			)
				readiness.seedFailure(mutation, feature, mutation.state.error)
		}
		sync()
		reconcile()
	}
	for (const key of queueKeys) if (cache.getQueryData(key)) cache.setQueryData(key, noQueuedWork)
	const unsubscribeQueries = cache.getQueryCache().subscribe((event) => {
		if (!roots.some((queryKey) => matchQuery({ queryKey, exact: false }, event.query))) return
		if (event.type === "removed" && roots.some((key) => matchQuery({ queryKey: key, exact: true }, event.query))) {
			epoch++
			store.invalidateReads()
		}
		if (
			event.type === "updated" &&
			event.action.type === "error" &&
			relevantReads.has(event.query) &&
			!localRefusal(event.query.state.error)
		) {
			const root = roots.find((queryKey) => matchQuery({ queryKey, exact: false }, event.query))
			if (root) queryFailures.set(event.query.queryHash, { feature: `${root[2]}.read`, error: event.query.state.error })
		}
		if (event.type === "updated" && event.action.type === "success" && event.query.state.fetchStatus === "idle")
			queryFailures.delete(event.query.queryHash)
		sync()
		if (
			event.type === "updated" &&
			event.action.type === "success" &&
			!event.action.manual &&
			!readiness.state.get().pending.length &&
			!queued()
		)
			needsReconciliation = false
		sync()
		reconcile()
	})
	const unsubscribeMutations = cache.getMutationCache().subscribe((event) => {
		if (event.type === "updated") observeMutation(event.mutation)
	})
	for (const mutation of cache.getMutationCache().getAll()) observeMutation(mutation, true)
	sync()
	return {
		store,
		readiness,
		watch,
		sync,
		readCart,
		readCheckout,
		async refreshFields() {
			cancelReads()
			// Checkout owns bootstrap and seeds the acknowledged cart before any cart retry can run.
			await cache.refetchQueries({ queryKey: checkoutQueryKey, exact: true, type: "active" })
			if (cartEnabled && cache.getQueryData(checkoutQueryKey) && !cache.getQueryData(cartQueryKey))
				await cache.refetchQueries({ queryKey: cartQueryKey, exact: true, type: "active" })
		},
		dispatch<T>(scopeKey: readonly unknown[], action: () => T) {
			return dispatch(`${scopeKey[2]}.${String(scopeKey[4] ?? "action")}`, action)
		},
		configure(enabled: boolean) {
			cartEnabled = enabled
		},
		get active() {
			return consumers > 0 || readiness.state.get().pending.length > 0 || watch.pending
		},
		attach() {
			consumers++
			return () => {
				consumers--
			}
		},
		get isPending() {
			return store.isConfirming || readiness.state.get().pending.some((entry) => entry.confirmation)
		},
		isCurrent: current,
		failureMatches(feature: string, request: unknown) {
			return (readiness.failure(feature)?.identity as Mutation | undefined)?.state.variables === request
		},
		feature(scopeKey: readonly unknown[]) {
			return `${scopeKey[2]}.${String(scopeKey[4] ?? "action")}`
		},
		pending(scopeKey: readonly unknown[]) {
			return readiness.state
				.get()
				.pending.some(({ identity }) => matchMutation({ mutationKey: scopeKey, exact: false }, identity as Mutation))
		},
		admit<T>(payload: T): CheckoutRequest<T> {
			assertWritable()
			const bootstrap = checkoutEnabled && !cache.getQueryData(checkoutQueryKey)
			cancelReads()
			if (bootstrap) needsReconciliation = true
			return { payload, token: requestToken() }
		},
		assertCurrent(token: CheckoutRequestToken) {
			sync()
			if (!current(token)) throw new CheckoutLockedError("CHECKOUT_SESSION_CHANGED", store.state.get().entries)
		},
		publishCart(token: CheckoutRequestToken, cart: Cart) {
			sync()
			if (!current(token)) return
			cancelReads()
			cache.setQueryData(cartQueryKey, cart)
		},
		publishCheckout(request: CheckoutRequest<unknown>, checkout: Checkout) {
			if (!current(request.token) || !request.reservation || !store.isConfirmation(request.reservation)) return
			cancelReads()
			store.acceptSession(checkoutSession(checkout))
			cache.setQueryData(checkoutQueryKey, checkout)
			cache.setQueryData(cartQueryKey, checkout.cart)
		},
		reviewTotal(request: CheckoutRequest<unknown>, cart: Cart | null | undefined) {
			sync()
			const { token, reservation } = request
			if (!current(token) || !reservation || !store.isConfirmation(reservation)) return
			// A newer read/write in this same session must not be replaced by evidence from the old POST.
			if (
				token.revision === store.revision &&
				token.cartVersion === (cache.getQueryState(cartQueryKey)?.dataUpdateCount ?? 0) &&
				token.checkoutVersion === (cache.getQueryState(checkoutQueryKey)?.dataUpdateCount ?? 0) &&
				cart &&
				Number.isSafeInteger(cart.totals?.total) &&
				cart.totals.total >= 0 &&
				Array.isArray(cart.items) &&
				Array.isArray(cart.coupons) &&
				Array.isArray(cart.shippingPackages)
			) {
				cancelReads()
				cache.setQueryData(cartQueryKey, cart)
			} else {
				cancelReads()
				needsReconciliation = true
				sync()
				// Reconciliation waits until confirmation settles, and uses checkout when standalone cart reads are disabled.
				reconcile()
			}
		},
		reserve<T>(payload: T): CheckoutRequest<T> {
			checkoutEnabled = true
			sync()
			const reservation = store.reserveConfirmation()
			cancelReads()
			return { payload, token: requestToken(), reservation }
		},
		discard(request: CheckoutRequest<unknown>) {
			if (
				request.reservation &&
				!readiness.state.get().pending.some(({ identity }) => requestOf(identity as Mutation)?.reservation === request.reservation)
			)
				store.releaseConfirmation(request.reservation)
		},
		queue(key: typeof addressQueueKey | typeof quantityQueueKey, owner: string, active: boolean) {
			const update = () =>
				cache.setQueryData<readonly CheckoutQueueOwner[]>(key, (owners = noQueuedWork) => {
					const others = owners.filter((entry) => entry.owner !== owner && entry.generation === store.generation)
					return Object.freeze(active ? [...others, Object.freeze({ owner, generation: store.generation })] : others)
				})
			if (active) dispatch(key === addressQueueKey ? "cart.address" : "cart.item", update)
			else update()
		},
		enableCheckout() {
			checkoutEnabled = true
			// A hydrated checkout can be the initial cart snapshot, but cannot replace a newer acknowledged cart.
			const checkout = cache.getQueryData<Checkout>(checkoutQueryKey)
			if (checkout && !cache.getQueryData(cartQueryKey) && epoch === 0) cache.setQueryData(cartQueryKey, checkout.cart)
			sync()
		},
		dispose() {
			disposed = true
			watch.dispose()
			unsubscribeQueries()
			unsubscribeMutations()
			bindings.delete(store)
		},
	}
}
const bindings = new WeakMap<CheckoutLockStore, ReturnType<typeof createBinding>>()
const owners = new WeakMap<QueryClient, { client: object; binding: ReturnType<typeof createBinding> }>()
export function bindCheckoutLocks(store: CheckoutLockStore, cache: QueryClient, client: ActiveKizloClient, cartEnabled: boolean) {
	const owner = owners.get(cache)
	if (owner && owner.client !== client) {
		if (owner.binding.active || roots.some((queryKey) => cache.getQueryData(queryKey)))
			throw new Error("WooCommerce clients must use separate QueryClients.")
		owner.binding.dispose()
		owner.binding.store.resetSession()
		owner.binding.store.setAutomatic(new Map())
	}
	let binding = bindings.get(store)
	if (!binding) {
		binding = createBinding(store, cache, client, cartEnabled)
		owners.set(cache, { client, binding })
		bindings.set(store, binding)
	}
	binding.configure(cartEnabled)
	return binding
}
