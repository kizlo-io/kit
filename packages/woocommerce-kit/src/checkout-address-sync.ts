import { checkoutAddressKeys, checkoutAddressPath } from "./checkout-address"
import type { CheckoutFieldSources } from "./checkout-field-document"
import { checkoutFormName, projectedFormValues, resolveCheckoutForm } from "./checkout-form"
import { readPath } from "./field-metadata"
import { validPostcode } from "./postcode"
import type { Cart, CartAddressSnapshotInput, CheckoutFormFieldName, CheckoutFormValues } from "./types"

const roots = ["billingAddress", "shippingAddress"] as const
function comparison(value: unknown, postcode = false): string {
	if (value == null) return '""'
	if (typeof value === "string") return JSON.stringify(postcode ? value.replace(/\s+/g, "").toUpperCase() : value.trim())
	if (Array.isArray(value)) return `[${value.map((child) => comparison(child)).join(",")}]`
	if (typeof value === "object")
		return JSON.stringify(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, comparison(child)]),
		)
	return JSON.stringify(value)
}
function overlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}
export function checkoutAddressChanges(sources: CheckoutFieldSources, values: CheckoutFormValues) {
	const output = projectedFormValues(sources, values)
	const paths = new Map<string, string[]>()
	for (const root of roots) {
		for (const key of [...checkoutAddressKeys, ...(root === "billingAddress" ? ["email", "taxId"] : [])])
			paths.set(JSON.stringify([root, key]), [root, key])
	}
	for (const definition of sources.storefront?.address.fields ?? []) {
		const other = definition.bindings?.other
		if (definition.location !== "address" && other && roots.some((root) => root === other[0])) paths.set(JSON.stringify(other), [...other])
		for (const root of roots) {
			const binding = definition.bindings?.[root === "billingAddress" ? "billing" : "shipping"]
			if (definition.location === "address" && binding) paths.set(JSON.stringify([root, ...binding]), [root, ...binding])
		}
	}
	const input: Record<string, unknown> = {}
	const names = new Set<CheckoutFormFieldName>()
	let countryChanged = false
	for (const root of roots) {
		if (!output[root]) continue
		const countryDirty = comparison(output[root]?.country) !== comparison(sources.cart?.[root]?.country)
		for (const path of paths.values()) {
			if (path[0] !== root) continue
			const value = readPath(output, path)
			// Omitted draft members are not clears in the cart's partial-update contract.
			if (value === undefined) continue
			if (comparison(value, path[1] === "postcode") === comparison(readPath(sources.cart, path), path[1] === "postcode")) continue
			input[root] = structuredClone(output[root])
			countryChanged ||= countryDirty
			if (countryDirty && path.length === 2 && (path[1] === "state" || path[1] === "postcode") && comparison(value) === '""') continue
			names.add(checkoutFormName(checkoutAddressPath(sources, values.useShippingAsBilling, path)))
		}
	}
	const fields = [...names]
	const model = resolveCheckoutForm(sources, values, true)
	const relevant = (path: readonly string[]) => {
		const name = checkoutFormName(checkoutAddressPath(sources, values.useShippingAsBilling, path))
		return fields.some((field) => overlaps(name, field))
	}
	let valid =
		!model.issues.some((issue) => relevant(issue.path.map(String))) &&
		!model.unsupported.some((issue) => {
			const path = issue.path.length
				? issue.path
				: issue.group === "billing"
					? ["billingAddress"]
					: issue.group === "shipping"
						? ["shippingAddress"]
						: []
			return path.length > 0 && relevant(path)
		})
	for (const root of roots) {
		if (output[root] && (typeof output[root] !== "object" || Array.isArray(output[root]))) valid = false
		const postcode = output[root]?.postcode
		const name = checkoutFormName(checkoutAddressPath(sources, values.useShippingAsBilling, [root, "postcode"]))
		if (fields.includes(name) && typeof postcode === "string" && postcode !== "" && !validPostcode(postcode, output[root]?.country ?? ""))
			valid = false
	}
	return { input: input as CartAddressSnapshotInput, fields, countryChanged, valid, changed: Object.keys(input).length > 0 }
}

type Binding = {
	read: () => { sources: CheckoutFieldSources; values: CheckoutFormValues | undefined; session: string | null }
	validate: (name: CheckoutFormFieldName) => boolean | Promise<boolean>
	queue: (input: CartAddressSnapshotInput) => void
	cancel: () => void
	flush: () => void
	activity: (active: boolean) => void
	blocked?: (names: readonly CheckoutFormFieldName[]) => boolean
	unchanged?: () => void
}
/** Owns only transient validation/queue authorization; editable values always remain in the form. */
export function createCheckoutAddressSync(binding: Binding) {
	let revision = 0
	let edited = false
	let approved: { signature: string; sources: CheckoutFieldSources; session: string | null } | null = null
	const stop = () => {
		revision++
		approved = null
		binding.cancel()
		binding.activity(false)
	}
	const synchronize = async (immediate = false) => {
		stop()
		const current = revision
		try {
			const read = binding.read()
			if (!read.values || !read.sources.storefront || !read.sources.cart || !read.sources.checkout || read.sources.checkout.isPaid) return
			const values = structuredClone(read.values)
			const signature = JSON.stringify(values)
			const pending = checkoutAddressChanges(read.sources, values)
			if (!pending.changed) {
				binding.unchanged?.()
				return
			}
			binding.activity(true)
			let valid = pending.valid
			for (const name of pending.fields) {
				valid = (await binding.validate(name)) && valid
				if (revision !== current) return
			}
			const latest = binding.read()
			if (revision !== current) return
			if (
				!valid ||
				binding.blocked?.(pending.fields) ||
				latest.sources !== read.sources ||
				latest.session !== read.session ||
				JSON.stringify(latest.values) !== signature
			)
				return
			approved = { signature, sources: read.sources, session: read.session }
			binding.queue(pending.input)
			if (immediate || pending.countryChanged) binding.flush()
		} catch {
			// Validation failure cannot authorize a save and is not a cart request failure.
		} finally {
			if (revision === current) binding.activity(false)
		}
	}
	return {
		change: (immediate = false) => {
			edited = true
			void synchronize(immediate)
		},
		refresh: () => {
			if (edited) void synchronize()
		},
		blur: () => {
			if (edited) void synchronize(true)
		},
		reset: () => {
			edited = false
			stop()
		},
		allows: (input: CartAddressSnapshotInput, cart: Cart | null) => {
			try {
				const current = binding.read()
				if (
					!approved ||
					approved.sources !== current.sources ||
					approved.session !== current.session ||
					current.sources.cart !== cart ||
					JSON.stringify(current.values) !== approved.signature ||
					!current.values
				)
					return false
				const pending = checkoutAddressChanges(current.sources, current.values)
				return pending.valid && pending.changed && !binding.blocked?.(pending.fields) && comparison(input) === comparison(pending.input)
			} catch {
				return false
			}
		},
	}
}
