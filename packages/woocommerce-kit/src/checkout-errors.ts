import { atom } from "nanostores"
import { checkoutAddressPath } from "./checkout-address"
import { type CheckoutFieldSources, fieldPaths } from "./checkout-field-document"
import { type CheckoutFormState, checkoutFormName } from "./checkout-form"
import type {
	Checkout,
	CheckoutError,
	CheckoutFieldGroup,
	CheckoutFormFieldName,
	CheckoutFormValues,
	CheckoutServerFieldError,
	CheckoutServerIssue,
} from "./types"

export function checkoutSession(checkout: Checkout | null | undefined): string | null {
	return checkout ? JSON.stringify([checkout.orderId, checkout.orderKey]) : null
}

export function createCheckoutErrorStore() {
	const state = atom<{ error: CheckoutError | null; issues: readonly CheckoutServerIssue[]; pending: number }>({
		error: null,
		issues: [],
		pending: 0,
	})
	let sequence = 0
	let current = 0
	let session: string | null = null
	let hasSession = false
	const pending = new Set<number>()
	const clear = () => state.set({ ...state.get(), error: null, issues: [] })
	return {
		state,
		syncSession(next: string | null) {
			if (session === next) return
			// Bootstrap may finish after an initial confirmation; it is not a revived checkout.
			if (!hasSession && next !== null) {
				session = next
				hasSession = true
				return
			}
			session = next
			current = ++sequence
			clear()
		},
		start(next: string | null) {
			session = next
			if (next !== null) hasSession = true
			current = ++sequence
			pending.add(current)
			state.set({ error: null, issues: [], pending: pending.size })
			return current
		},
		isCurrent(attempt: number) {
			return current === attempt
		},
		fail(attempt: number, error: CheckoutError) {
			if (current !== attempt) return
			const issues =
				error.code === "CHECKOUT_VALIDATION_FAILED"
					? error.data.issues
					: [
							{
								scope: "unresolved" as const,
								target: null,
								message: error.message,
								code: error.code,
								source: null,
								sourcePath: [],
								registeredFields: [],
							},
						]
			state.set({
				...state.get(),
				error,
				issues: issues.map((issue, index) => ({ ...issue, id: `${attempt}:${index}`, submissionId: attempt, errorCode: error.code })),
			})
		},
		succeed(attempt: number, next: string | null) {
			if (current !== attempt) return
			session = next
			if (next !== null) hasSession = true
			clear()
		},
		settle(attempt: number) {
			pending.delete(attempt)
			state.set({ ...state.get(), pending: pending.size })
		},
		reset() {
			if (pending.size) return
			current = ++sequence
			clear()
		},
		clearIssues(ids: ReadonlySet<string>) {
			const previous = state.get()
			const issues = previous.issues.filter((issue) => !ids.has(issue.id))
			if (issues.length !== previous.issues.length) state.set({ ...previous, issues })
		},
	}
}
export type CheckoutErrorStore = ReturnType<typeof createCheckoutErrorStore>
const stores = new WeakMap<object, WeakMap<object, CheckoutErrorStore>>()
/** Both the SDK checkout instance and app cache bound the browser session; neither is retained globally. */
export function checkoutErrorStore(checkoutClient: object, cache: object): CheckoutErrorStore {
	let caches = stores.get(checkoutClient)
	if (!caches) {
		caches = new WeakMap()
		stores.set(checkoutClient, caches)
	}
	let store = caches.get(cache)
	if (!store) {
		store = createCheckoutErrorStore()
		caches.set(cache, store)
	}
	return store
}

const groups = ["billing", "shipping", "contact", "order"] as const
const samePath = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b)
function section(path: readonly string[]): CheckoutFieldGroup | null {
	if (path[0] === "billingAddress") return path[1] === "email" ? "contact" : "billing"
	if (path[0] === "shippingAddress") return "shipping"
	return null
}

/** Match literal SDK identities to published bindings; diagnostic source names never participate. */
function targetFor(
	issue: CheckoutServerIssue,
	sources: CheckoutFieldSources,
): { path: readonly string[]; group: CheckoutFieldGroup | null } | null {
	if (issue.scope === "field" && issue.target) {
		const path = issue.target
		const candidates = (sources.storefront?.address.fields ?? []).flatMap((field) =>
			(field.location === "address" ? (["billing", "shipping"] as const) : [field.location]).flatMap((group) => {
				const binding = fieldPaths(field, group)?.input
				return binding && samePath(binding, path) ? [{ path, group }] : []
			}),
		)
		return { path, group: candidates.length === 1 ? (candidates[0]?.group ?? null) : section(path) }
	}
	const definitions = sources.storefront?.address.fields ?? []
	if (
		definitions.some(
			(field) =>
				field.location === "address" && issue.registeredFields.some((reference) => reference.id === field.id && reference.bucket === null),
		)
	)
		return null
	const matches = definitions.flatMap((field) => {
		const locations = field.location === "address" ? (["billing", "shipping"] as const) : [field.location]
		return locations.flatMap((group) => {
			const path = fieldPaths(field, group)?.input
			if (!path) return []
			return issue.registeredFields.some(
				(reference) => reference.id === field.id && (reference.bucket === null || reference.bucket === path[0]),
			)
				? [{ path, group }]
				: []
		})
	})
	return matches.length === 1 ? (matches[0] ?? null) : null
}
export type CheckoutErrorProjection = {
	sections: Record<CheckoutFieldGroup, CheckoutServerIssue[]>
	errors: CheckoutServerIssue[]
	fields: CheckoutServerFieldError[]
	associations: Map<string, CheckoutFormFieldName>
}
export function projectCheckoutErrors(
	issues: readonly CheckoutServerIssue[],
	sources: CheckoutFieldSources,
	fields: CheckoutFormState["fields"],
	values?: CheckoutFormValues,
): CheckoutErrorProjection {
	const result: CheckoutErrorProjection = {
		sections: { billing: [], shipping: [], contact: [], order: [] },
		errors: [],
		fields: [],
		associations: new Map(),
	}
	const inputs = new Map<CheckoutFormFieldName, string[]>()
	for (const issue of issues) {
		if (issue.scope === "group") {
			const group = issue.target?.length === 1 ? section(issue.target) : null
			if (group) result.sections[group].push(issue)
			else result.errors.push(issue)
			continue
		}
		const target = targetFor(issue, sources)
		let group = target?.group ?? null
		if (target) {
			const path = checkoutAddressPath(sources, values?.useShippingAsBilling, target.path)
			const name = checkoutFormName(path)
			const editable =
				groups.some((key) => fields[key].some((field) => field.name === name && !field.hidden)) ||
				(path.length === 1 && ["paymentMethod", "customerNote", "createAccount"].includes(path[0] ?? ""))
			if (editable) {
				result.associations.set(issue.id, name)
				const messages = inputs.get(name) ?? []
				messages.push(issue.message)
				inputs.set(name, messages)
				continue
			}
		} else if (issue.registeredFields.length) {
			const buckets = new Set(issue.registeredFields.map((reference) => reference.bucket))
			if (buckets.size === 1) group = section([issue.registeredFields[0]?.bucket ?? ""])
		}
		if (group) result.sections[group].push(issue)
		else result.errors.push(issue)
	}
	result.fields = [...inputs].map(([name, messages]) => ({ name, messages }))
	return result
}

/** One bridge owns its applied patches; projection changes update only affected server channels. */
export function createCheckoutErrorBridge() {
	let applied = new Map<CheckoutFormFieldName, readonly string[]>()
	return {
		update(
			patches: readonly CheckoutServerFieldError[],
			setErrors: (patches: readonly CheckoutServerFieldError[]) => void,
			clearErrors: (names: readonly CheckoutFormFieldName[]) => void,
		) {
			const next = new Map(patches.map(({ name, messages }) => [name, messages]))
			const removed = [...applied.keys()].filter((name) => !next.has(name))
			const changed = patches.filter(({ name, messages }) => JSON.stringify(applied.get(name)) !== JSON.stringify(messages))
			applied = next
			if (removed.length) clearErrors(removed)
			if (changed.length) setErrors(changed)
		},
		cleanup(clearErrors: (names: readonly CheckoutFormFieldName[]) => void) {
			const names = [...applied.keys()]
			applied = new Map()
			if (names.length) clearErrors(names)
		},
	}
}
