import { atom } from "nanostores"

declare const checkoutConfirmationToken: unique symbol
/** Private identity for one synchronous confirmation reservation. */
export type CheckoutConfirmationToken = { readonly [checkoutConfirmationToken]: true }
export type CheckoutLockEntry = Readonly<{ id: string; name: string; message: string }>
export type CheckoutLockState = Readonly<{ isLocked: boolean; entries: readonly CheckoutLockEntry[] }>

/** A local readiness/session refusal, distinct from an SDK request error. */
export class CheckoutLockedError extends Error {
	readonly code: "CHECKOUT_LOCKED" | "CHECKOUT_CONFIRMING" | "CHECKOUT_SESSION_CHANGED"
	readonly data: { locks: readonly CheckoutLockEntry[] }
	constructor(code: CheckoutLockedError["code"], locks: readonly CheckoutLockEntry[]) {
		super(code === "CHECKOUT_SESSION_CHANGED" ? "The checkout session changed." : "Checkout is locked.")
		this.name = "CheckoutLockedError"
		this.code = code
		this.data = { locks }
	}
}

export function createCheckoutLockStore() {
	const state = atom<CheckoutLockState>(Object.freeze({ isLocked: false, entries: Object.freeze([]) }))
	const automatic = new Map<string, CheckoutLockEntry>()
	let confirmationEntry: CheckoutLockEntry | null = null
	let sequence = 0
	let generation = 0
	let revision = 0
	let session: string | null = null
	let initialized = false
	let confirmation: CheckoutConfirmationToken | null = null
	const publish = () => {
		const entries = Object.freeze([...automatic.values(), ...(confirmationEntry ? [confirmationEntry] : [])])
		state.set(Object.freeze({ isLocked: entries.length > 0, entries }))
	}
	return {
		setAutomatic(reasons: ReadonlyMap<string, string>) {
			let changed = automatic.size !== reasons.size
			for (const name of automatic.keys()) if (!reasons.has(name)) automatic.delete(name)
			for (const [name, message] of reasons) {
				if (automatic.get(name)?.message === message) continue
				automatic.set(name, Object.freeze({ id: `feature:${name}`, name, message }))
				changed = true
			}
			if (changed) publish()
		},
		invalidateReads() {
			revision++
		},
		get isConfirming() {
			return confirmation !== null
		},
		// A readonly facade, including at runtime: consumers cannot write readiness directly.
		state: Object.freeze({ get: state.get, listen: state.listen }),
		get session() {
			return session
		},
		get generation() {
			return generation
		},
		get revision() {
			return revision
		},
		syncSession(next: string | null) {
			// Cache absence is not an acknowledged replacement session.
			if (next === null || session === next) return
			revision++
			if (!initialized && next !== null) {
				initialized = true
				session = next
				return
			}
			session = next
			generation++
			// Queue owners observe generation changes even when the visible readiness reasons stay the same.
			publish()
		},
		/** A successful confirmation advances its own session without abandoning its reservation before settlement. */
		acceptSession(next: string | null) {
			// Earlier reads cannot republish a pre-confirmation snapshot, even when the order identity is unchanged.
			revision++
			session = next
			if (next !== null) initialized = true
		},
		resetSession() {
			revision++
			session = null
			initialized = false
			generation++
			confirmationEntry = null
			confirmation = null
			publish()
		},
		reserveConfirmation() {
			if (state.get().isLocked) throw new CheckoutLockedError("CHECKOUT_LOCKED", state.get().entries)
			confirmation = Object.freeze({}) as CheckoutConfirmationToken
			confirmationEntry = Object.freeze({ id: String(++sequence), name: "checkout.confirmation", message: "Placing the order." })
			publish()
			return confirmation
		},
		isConfirmation(handle: CheckoutConfirmationToken) {
			return confirmation === handle
		},
		releaseConfirmation(handle: CheckoutConfirmationToken) {
			if (confirmation !== handle) return
			confirmationEntry = null
			confirmation = null
			publish()
		},
	}
}
export type CheckoutLockStore = ReturnType<typeof createCheckoutLockStore>
const stores = new WeakMap<object, WeakMap<object, CheckoutLockStore>>()
/** Both the SDK client and the app cache bound the checkout; neither is retained globally. */
export function checkoutLockStore(client: object, cache: object): CheckoutLockStore {
	let caches = stores.get(client)
	if (!caches) {
		caches = new WeakMap()
		stores.set(client, caches)
	}
	let store = caches.get(cache)
	if (!store) {
		store = createCheckoutLockStore()
		caches.set(cache, store)
	}
	return store
}
