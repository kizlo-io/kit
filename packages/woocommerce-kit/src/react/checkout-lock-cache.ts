"use client"

import { CancelledError, hashKey, type Mutation, matchMutation, matchQuery, type Query, type QueryClient } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { type CartActionPayload, hasSelectedShippingRates, shippingQuoteSignature } from "../cart"
import { checkoutSession } from "../checkout-errors"
import { type CheckoutConfirmationToken, CheckoutLockedError, type CheckoutLockStore } from "../checkout-locks"
import { createCheckoutReadiness } from "../checkout-readiness"
import { readPath } from "../field-metadata"
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
import type { Cart, Checkout, CheckoutError } from "../types"
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
export type CheckoutRequest<T> = { payload: T; token: CheckoutRequestToken; reservation?: CheckoutConfirmationToken; restored?: boolean }
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
	if (!variables || typeof variables !== "object" || !("token" in variables)) return
	const token = variables.token as Partial<CheckoutRequestToken> | null
	if (
		token &&
		typeof token === "object" &&
		token.scope &&
		typeof token.scope === "object" &&
		typeof token.generation === "number" &&
		typeof token.epoch === "number"
	)
		return variables as CheckoutRequest<unknown>
}
function localRefusal(error: unknown) {
	return error instanceof CheckoutLockedError || error instanceof CancelledError
}

const rejectedCartCodes = new Set([
	"CART_COUPON_INVALID",
	"CART_COUPON_DISABLED",
	"CART_COUPON_NOT_FOUND",
	"CART_ADDRESS_INVALID",
	"CART_SHIPPING_RATE_NOT_FOUND",
	"CART_SHIPPING_DISABLED",
	"CART_ITEM_OUT_OF_STOCK",
	"CART_ITEM_INSUFFICIENT_STOCK",
	"CART_ITEM_NOT_PURCHASABLE",
	"CART_ITEM_INVALID_QUANTITY",
	"CART_ITEM_EXISTS",
	"CART_PRODUCT_INVALID",
	"CART_VARIATION_INVALID",
	"CART_ITEM_NOT_FOUND",
])
const rejectedConfirmationCodes = new Set([
	"CHECKOUT_ADDRESS_COUNTRY_INVALID",
	"CHECKOUT_ADDRESS_INVALID",
	"CHECKOUT_COUPON_INVALID",
	"CHECKOUT_EMAIL_INVALID",
	"CHECKOUT_EMAIL_MISSING",
	"CHECKOUT_PAYMENT_FAILED",
	"CHECKOUT_PAYMENT_METHOD_DISABLED",
	"CHECKOUT_PAYMENT_METHOD_MISSING",
	"CHECKOUT_SHIPPING_OPTION_INVALID",
	"CHECKOUT_VALIDATION_FAILED",
	"CHECKOUT_ACCOUNT_CREATION_FAILED",
	"CHECKOUT_GUEST_DISABLED",
	"CHECKOUT_ORDER_NOT_FOUND",
	"CHECKOUT_CART_EMPTY",
	"CHECKOUT_TOTAL_MISMATCH",
	"CHECKOUT_CART_INVALID",
	"CHECKOUT_COUPONS_REMOVED",
	"CHECKOUT_COUPON_RESERVATION_FAILED",
	"CHECKOUT_PRODUCT_INSUFFICIENT_STOCK",
	"CHECKOUT_PRODUCT_NOT_PURCHASABLE",
	"CHECKOUT_PRODUCT_OUT_OF_STOCK",
])
function operationOf(mutation: Mutation): CartActionPayload | null {
	const payload = requestOf(mutation)?.payload
	if (!payload || typeof payload !== "object" || !("type" in payload)) return null
	const action = payload as CartActionPayload
	switch (action.type) {
		case "apply_coupon":
		case "remove_coupon":
			return typeof action.code === "string" ? action : null
		case "update_cart_item":
			return typeof action.key === "string" && Number.isFinite(action.quantity) ? action : null
		case "remove_from_cart":
			return typeof action.key === "string" ? action : null
		case "select_shipping_rate":
			return typeof action.rateId === "string" ? action : null
		case "add_to_cart":
			return action.input && typeof action.input === "object" && typeof action.input.productId === "number" ? action : null
		case "update_customer":
			return action.input &&
				typeof action.input === "object" &&
				!Array.isArray(action.input) &&
				[action.input.billingAddress, action.input.shippingAddress].every(
					(address) => address === undefined || (address !== null && typeof address === "object" && !Array.isArray(address)),
				)
				? action
				: null
		default:
			return null
	}
}
function addressPaths(payload: Extract<CartActionPayload, { type: "update_customer" }>) {
	return Object.entries(payload.input).flatMap(([root, address]) =>
		Object.entries(address ?? {}).flatMap(([field, value]) =>
			field === "additionalFields" && value && typeof value === "object"
				? Object.keys(value).map((id) => [root, field, id])
				: [[root, field]],
		),
	)
}
function tasksOf(feature: string, payload: CartActionPayload | null, cart?: Cart): string[] {
	if (!payload) return [feature]
	switch (payload.type) {
		case "apply_coupon":
		case "remove_coupon":
			return [hashKey([feature, payload.code])]
		case "update_cart_item":
		case "remove_from_cart":
			return [hashKey([feature, payload.key])]
		case "add_to_cart":
			return [hashKey([feature, "add", payload.input.productId, payload.input.variationId])]
		case "select_shipping_rate":
			return [hashKey([feature, String(payload.packageId ?? cart?.shippingPackages[0]?.id ?? "")])]
		case "update_customer":
			return addressPaths(payload).map((path) => hashKey([feature, ...path]))
		default:
			return [feature]
	}
}
function addressMatches(feature: string, task: string, payload: Extract<CartActionPayload, { type: "update_customer" }>, cart: Cart) {
	const path = addressPaths(payload).find((path) => hashKey([feature, ...path]) === task)
	if (!path) return false
	const value = readPath(payload.input, path),
		saved = readPath(cart, path)
	if (path.length === 2 && ["country", "state", "city", "postcode"].includes(path[1] ?? "")) {
		const address = cart[path[0] as "billingAddress" | "shippingAddress"]
		return (
			typeof value === "string" && shippingQuoteSignature({ ...address, [path[1] as string]: value }) === shippingQuoteSignature(address)
		)
	}
	return hashKey([value]) === hashKey([saved])
}

function createBinding(store: CheckoutLockStore, cache: QueryClient, client: ActiveKizloClient, cartEnabled: boolean) {
	const scope = {}
	const tasksFor = (feature: string, payload: CartActionPayload | null) => tasksOf(feature, payload, cache.getQueryData<Cart>(cartQueryKey))
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
	const trustedReads = new Map<string, { data: unknown; generation: number }>()
	let reconciliationFailed = false
	let uncertainConfirmation: { error: unknown; orderId: number | null; orderKey: string | null; placed: boolean } | null = null
	let checkingOrder = false
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
			trustedReads.clear()
			const checkout = cache.getQueryData<Checkout>(checkoutQueryKey)
			for (const key of roots) {
				const query = cache.getQueryCache().find({ queryKey: key, exact: true })
				if (query?.state.status === "success" && (key === checkoutQueryKey || hashKey([query.state.data]) === hashKey([checkout?.cart])))
					trustedReads.set(query.queryHash, { data: query.state.data, generation })
			}
			cancelReads()
			for (const key of queueKeys) if (cache.getQueryData(key)) cache.setQueryData(key, noQueuedWork)
		}
	}
	const trustworthy = (query: Query) => {
		const acknowledged = trustedReads.get(query.queryHash)
		return acknowledged?.generation === generation && acknowledged.data === query.state.data && query.state.data != null
	}
	const sync = (live = false) => {
		let queries: Query[] | undefined
		if (live) {
			syncGeneration()
			queries = cache.getQueryCache().getAll()
			const mutations = cache.getMutationCache().getAll()
			watch.refresh(queries, mutations)
			for (const mutation of mutations) if (mutation.state.status === "pending") observeMutation(mutation)
		}
		if (disposed || publishing) return
		publishing = true
		syncGeneration()
		const reasons = new Map([...readiness.reasons(), ...watch.reasons()])
		for (const feature of dispatching.keys()) reasons.set(feature, "Starting the checkout task.")
		if (store.isConfirming && !readiness.state.get().unresolved.some((entry) => entry.feature === "checkout.confirmation"))
			reasons.delete("checkout.confirmation")
		for (const [index, key] of queueKeys.entries()) {
			if ((cache.getQueryData<readonly CheckoutQueueOwner[]>(key) ?? noQueuedWork).some((entry) => entry.generation === generation))
				reasons.set(index === 0 ? "cart.address" : "cart.item", "Waiting to save the cart.")
		}
		for (const query of queries ?? cache.getQueryCache().getAll()) {
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
			if (!trustworthy(query) && (required || query.state.fetchStatus !== "idle" || query.state.status === "pending"))
				reasons.set(feature, "Loading the checkout data.")
			if (query.state.status === "error" && !localRefusal(query.state.error))
				queryFailures.set(query.queryHash, { feature, error: query.state.error })
		}
		for (const [hash, { feature, error }] of queryFailures) {
			const acknowledged = trustedReads.get(hash)
			if (acknowledged?.generation !== generation || needsReconciliation)
				reasons.set(feature, (error as { message?: string })?.message ?? "Reload the checkout data.")
		}
		if (checkoutEnabled) {
			if (!cache.getQueryData(cartQueryKey)) reasons.set("cart.read", "Loading the cart.")
			if (!cache.getQueryData(checkoutQueryKey)) reasons.set("checkout.read", "Loading the checkout.")
			if (!hasSelectedShippingRates(cache.getQueryData<Cart>(cartQueryKey) ?? null))
				reasons.set("cart.shipping", "Choose a shipping rate for every package.")
		}
		if (needsReconciliation) reasons.set("cart.reconciliation", "Refreshing the acknowledged cart.")
		if (uncertainConfirmation)
			reasons.set(
				"checkout.confirmation",
				uncertainConfirmation.placed
					? "The order was placed. Check its payment status before continuing."
					: "The order outcome is unknown. Refresh to check its status before submitting again.",
			)
		store.setAutomatic(reasons)
		publishing = false
	}
	const cancelReads = () => {
		store.invalidateReads()
		for (const queryKey of roots) void cache.cancelQueries({ queryKey, exact: false })
	}
	const assertWritable = () => {
		sync(true)
		if (uncertainConfirmation || store.isConfirming || readiness.state.get().pending.some((entry) => entry.confirmation))
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
		const query = cache.getQueryCache().find({ queryKey: cartQueryKey, exact: true })
		if (query) trustedReads.set(query.queryHash, { data: query.state.data, generation })
		return checkout
	}
	const reconcile = () => {
		if (
			!needsReconciliation ||
			reconciliationFailed ||
			reconciling ||
			readiness.state.get().pending.length ||
			queued() ||
			dispatching.size ||
			disposed
		)
			return
		reconciling = true
		const revision = store.revision,
			readEpoch = epoch
		const useCart = !uncertainConfirmation && cartEnabled && !(checkoutEnabled && !cache.getQueryData(checkoutQueryKey))
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
					if (!localRefusal(error)) reconciliationFailed = true
				},
			)
			.finally(() => {
				reconciling = false
				sync()
				if (needsReconciliation && !reconciliationFailed) reconcile()
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
				const payload = operationOf(mutation),
					tasks = tasksFor(feature, payload)
				const code = (error as { code?: string } | null)?.code ?? ""
				const uncertain = !!error && !(info.confirmation ? rejectedConfirmationCodes : rejectedCartCodes).has(code)
				if (error && info.generation === store.generation && uncertain && (payload || info.confirmation)) {
					needsReconciliation = true
					reconciliationFailed = false
					cancelReads()
					if (info.confirmation) {
						const checkout = cache.getQueryData<Checkout>(checkoutQueryKey)
						uncertainConfirmation = { error, orderId: checkout?.orderId ?? null, orderKey: checkout?.orderKey ?? null, placed: false }
					}
				}
				const optional =
					payload?.type === "apply_coupon" || payload?.type === "remove_coupon" || payload?.type === "add_to_cart" || request?.restored
				readiness.finish(
					mutation,
					feature,
					info.generation,
					store.generation,
					error,
					(info.confirmation && !uncertain) || localRefusal(mutation.state.error),
					{ tasks, blocking: uncertain || !optional, uncertain },
				)
				if (info.confirmation) sync()
				if (info.confirmation && info.reservation) store.releaseConfirmation(info.reservation)
				seen.delete(mutation)
			} else if (cold && mutation.state.status === "error" && !localRefusal(mutation.state.error)) {
				const confirmation = mutation.options.meta?.kitCheckoutRole === "confirmation"
				if (!confirmation || !rejectedConfirmationCodes.has((mutation.state.error as { code?: string })?.code ?? "")) {
					const payload = operationOf(mutation)
					if (payload && !confirmation) {
						const uncertain = !rejectedCartCodes.has((mutation.state.error as { code?: string })?.code ?? "")
						const optional =
							payload.type === "apply_coupon" || payload.type === "remove_coupon" || payload.type === "add_to_cart" || request?.restored
						readiness.finish(mutation, feature, generation, generation, mutation.state.error, false, {
							tasks: tasksFor(feature, payload),
							blocking: uncertain || !optional,
							uncertain,
						})
						if (uncertain) needsReconciliation = true
					} else readiness.seedFailure(mutation, feature, mutation.state.error)
					if (confirmation) {
						const checkout = cache.getQueryData<Checkout>(checkoutQueryKey)
						uncertainConfirmation = {
							error: mutation.state.error,
							orderId: checkout?.orderId ?? null,
							orderKey: checkout?.orderKey ?? null,
							placed: false,
						}
						needsReconciliation = true
					}
				}
			}
		}
		sync()
		reconcile()
	}
	const acknowledgeCart = (cart: Cart, authoritative: boolean) => {
		for (const failure of readiness.state.get().unresolved) {
			const mutation = failure.identity as Mutation,
				payload = operationOf(mutation)
			if (!payload || (failure.uncertain && !authoritative)) continue
			if (authoritative) readiness.acknowledge(failure.task)
			if (
				(authoritative &&
					(payload.type === "apply_coupon" ||
						payload.type === "remove_coupon" ||
						payload.type === "add_to_cart" ||
						requestOf(mutation)?.restored)) ||
				(payload.type === "update_customer" && addressMatches(failure.feature, failure.task, payload, cart)) ||
				(payload.type === "update_cart_item" &&
					cart.items.some((item) => item.key === payload.key && item.quantity === payload.quantity)) ||
				(payload.type === "remove_from_cart" && !cart.items.some((item) => item.key === payload.key)) ||
				(payload.type === "select_shipping_rate" &&
					cart.shippingPackages.some(
						(pkg) =>
							hashKey([failure.feature, String(pkg.id)]) === failure.task &&
							pkg.rates.some((rate) => rate.id === payload.rateId && rate.selected),
					))
			)
				readiness.resolve(failure.task, failure.identity)
		}
	}
	const checkOrder = (checkout: Checkout) => {
		const recovery = uncertainConfirmation
		if (!recovery || checkingOrder || recovery.placed) return
		if (
			checkout.orderId === recovery.orderId &&
			checkout.orderKey === recovery.orderKey &&
			(checkout.isPaid || checkout.paymentResult?.status === "success")
		) {
			recovery.placed = true
			return
		}
		if (recovery.orderId == null || !recovery.orderKey || !client.woocommerce.orders?.get) return
		checkingOrder = true
		void client.woocommerce.orders.get
			.call({ params: { orderId: recovery.orderId }, query: { key: recovery.orderKey } })
			.then(
				(order) => {
					if (uncertainConfirmation === recovery && order.isPaid) recovery.placed = true
				},
				() => {},
			)
			.finally(() => {
				checkingOrder = false
				sync()
			})
	}
	for (const query of cache.getQueryCache().getAll())
		if (query.state.status === "success" && query.state.data != null)
			trustedReads.set(query.queryHash, { data: query.state.data, generation })
	for (const key of queueKeys) if (cache.getQueryData(key)) cache.setQueryData(key, noQueuedWork)
	const unsubscribeQueries = cache.getQueryCache().subscribe((event) => {
		if (!roots.some((queryKey) => matchQuery({ queryKey, exact: false }, event.query))) return
		if (event.type === "removed" && roots.some((key) => matchQuery({ queryKey: key, exact: true }, event.query))) {
			epoch++
			store.invalidateReads()
			trustedReads.delete(event.query.queryHash)
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
		if (event.type === "updated" && event.action.type === "success") {
			syncGeneration()
			const authoritative =
				!event.action.manual &&
				event.query.state.fetchStatus === "idle" &&
				!readiness.state.get().pending.length &&
				!queued() &&
				!dispatching.size
			const failedUntrustedRead =
				queryFailures.has(event.query.queryHash) && trustedReads.get(event.query.queryHash)?.generation !== generation
			if (
				authoritative ||
				(!needsReconciliation && !failedUntrustedRead && (event.query.state.fetchStatus === "idle" || trustworthy(event.query)))
			) {
				trustedReads.set(event.query.queryHash, { data: event.query.state.data, generation })
				queryFailures.delete(event.query.queryHash)
			}
			const root = roots.find((key) => matchQuery({ queryKey: key, exact: true }, event.query))
			if (root) {
				if (authoritative) {
					needsReconciliation = false
					reconciliationFailed = false
				}
				const cart = root === cartQueryKey ? (event.query.state.data as Cart) : (event.query.state.data as Checkout).cart
				if (cart) acknowledgeCart(cart, authoritative)
				if (root === checkoutQueryKey && authoritative) checkOrder(event.query.state.data as Checkout)
			}
		}
		sync()
		reconcile()
	})
	const unsubscribeMutations = cache.getMutationCache().subscribe((event) => {
		if (event.type === "updated") observeMutation(event.mutation)
	})
	const mutations = cache.getMutationCache().getAll()
	for (const mutation of mutations) if (mutation.state.status === "pending") observeMutation(mutation, true)
	for (const mutation of mutations) if (mutation.state.status !== "pending") observeMutation(mutation, true)
	const cart = cache.getQueryData<Cart>(cartQueryKey)
	if (cart) acknowledgeCart(cart, false)
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
			return (
				consumers > 0 || readiness.state.get().pending.length > 0 || watch.pending || needsReconciliation || uncertainConfirmation !== null
			)
		},
		attach() {
			consumers++
			return () => {
				consumers--
			}
		},
		get confirmationError() {
			return uncertainConfirmation?.error as CheckoutError | undefined
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
		tasks: tasksFor,
		restore(feature: string, payload?: CartActionPayload) {
			let restored = false
			for (const failure of readiness.state.get().unresolved) {
				if (failure.feature !== feature || (payload && !tasksFor(feature, payload).includes(failure.task))) continue
				const mutation = failure.identity as Mutation,
					operation = operationOf(mutation)
				if (payload?.type === "update_cart_item" && operation?.type === "update_cart_item" && payload.quantity !== operation.quantity)
					continue
				const request = requestOf(mutation)
				if (request) request.restored = true
				if (failure.uncertain) continue
				readiness.resolve(failure.task, failure.identity)
				restored = true
			}
			sync()
			return restored
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
			reconciliationFailed = false
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
			queryFailures.delete(hashKey(cartQueryKey))
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
			sync(true)
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
