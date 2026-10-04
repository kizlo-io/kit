import { checkoutFieldAddress } from "@kizlo/woocommerce"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import type { StorefrontAddress } from "./address"
import type { CheckoutFieldContext, CheckoutFieldDocument, CheckoutFieldResolution, StorefrontFieldRule } from "./types"

const evaluator = new Ajv({ strict: true, strictTypes: false, strictRequired: false, strictTuples: false, validateFormats: true })
addFormats(evaluator)

/** Supplied snapshots are complete for the values they represent; unavailable Woo data stays absent. */
export function checkoutFieldDocument(
	address: StorefrontAddress,
	context: CheckoutFieldContext = {},
	group?: "billing" | "shipping",
): CheckoutFieldDocument {
	const { checkout, cart, customer } = context
	const document: CheckoutFieldDocument = {}
	const billing = checkout?.billingAddress ?? cart?.billingAddress ?? customer?.billing
	const shipping = checkout?.shippingAddress ?? cart?.shippingAddress ?? customer?.shipping
	const additional = checkout?.additionalFields ?? customer?.additionalFields
	if (checkout || customer || billing || shipping) {
		document.customer = {
			...(checkout?.customerId !== undefined ? { id: checkout.customerId ?? 0 } : customer?.id !== undefined ? { id: customer.id } : {}),
			...(billing && { billing_address: checkoutFieldAddress(billing, "billing") }),
			...(shipping && { shipping_address: checkoutFieldAddress(shipping, "shipping") }),
			...(additional && { additional_fields: locationValues(additional, address.fieldLocations.contact) }),
		}
	}
	if (checkout) {
		document.checkout = {
			...(checkout.paymentMethod !== undefined && { payment_method: checkout.paymentMethod ?? "" }),
			...(checkout.customerNote !== undefined && { customer_note: checkout.customerNote }),
			...(checkout.createAccount !== undefined && { create_account: checkout.createAccount }),
			...(checkout.additionalFields && { additional_fields: locationValues(checkout.additionalFields, address.fieldLocations.order) }),
		}
	}
	const currentCart = cart ?? checkout?.cart
	if (currentCart) {
		const selected = currentCart.shippingPackages?.flatMap((entry) => entry.rates.filter((rate) => rate.selected).map((rate) => rate.id))
		document.cart = {
			...(currentCart.items && {
				items: currentCart.items.flatMap((item) =>
					Array.from({ length: Math.ceil(item.quantity) }, () => item.variationId ?? item.productId),
				),
				items_type: [...new Set(currentCart.items.map((item) => item.type))],
			}),
			...(currentCart.coupons && { coupons: currentCart.coupons.map((coupon) => coupon.code) }),
			...(selected && { shipping_rates: selected }),
			...(currentCart.itemCount !== undefined && { items_count: currentCart.itemCount }),
			...(currentCart.itemsWeight !== undefined && { items_weight: currentCart.itemsWeight }),
			...(currentCart.needsShipping !== undefined && { needs_shipping: currentCart.needsShipping }),
			...(currentCart.totals && { totals: { total_price: currentCart.totals.total, total_tax: currentCart.totals.taxTotal } }),
			...(currentCart.extensions && { extensions: currentCart.extensions }),
		}
	}
	for (const key of ["customer", "checkout", "cart"] as const) {
		if (context.document?.[key]) document[key] = { ...document[key], ...context.document[key] }
	}
	if (group && document.customer) {
		const scoped = document.customer[`${group}_address`]
		if (scoped !== undefined) document.customer = { ...document.customer, address: scoped }
	}
	return document
}

function locationValues(values: object, ids: readonly string[]) {
	return Object.fromEntries(Object.entries(values).filter(([id]) => ids.includes(id)))
}

export function resolveFieldRules(
	required: StorefrontFieldRule,
	hidden: StorefrontFieldRule,
	document: CheckoutFieldDocument,
): CheckoutFieldResolution {
	const visibility = evaluate(hidden, document)
	if (visibility.value === true) return { status: "resolved", required: false, hidden: true }
	const requirement = evaluate(required, document)
	const issues = [visibility.issue, requirement.issue].filter((issue) => issue !== undefined)
	if (issues.length) return { status: "unresolved", required: requirement.value === false ? false : null, hidden: visibility.value, issues }
	return { status: "resolved", required: requirement.value as boolean, hidden: false }
}

type Evaluation = { value: boolean | null; issue?: { reason: "missing-context" | "unsupported-rule"; detail: string } }
function evaluate(rule: StorefrontFieldRule, document: CheckoutFieldDocument): Evaluation {
	if (typeof rule === "boolean") return { value: rule }
	// Woo treats an empty rule as a disabled condition, and wraps its shorthand in draft-07 properties.
	if (Object.keys(rule).length === 0) return { value: false }
	const schema = ["cart", "customer", "checkout"].some((key) => Object.hasOwn(rule, key))
		? { type: "object", properties: rule }
		: { type: "object", ...rule }
	try {
		const validate = compile(schema)
		const missing = missingContext(schema, document)
		if (missing) return { value: null, issue: { reason: "missing-context", detail: missing } }
		return { value: validate(document) }
	} catch (error) {
		return { value: null, issue: { reason: "unsupported-rule", detail: error instanceof Error ? error.message : "Invalid schema" } }
	}
}

function compile(schema: object | boolean) {
	const validate = evaluator.compile(schema)
	// Resolution is repeatedly recomputed from form snapshots. Do not retain each wrapped schema in AJV's cache.
	if (typeof schema === "object") evaluator.removeSchema(schema)
	return validate
}

/** Guard the data dependency, not the schema's truth value. AJV owns all JSON Schema evaluation. */
function missingContext(schema: unknown, value: unknown, path = ""): string | undefined {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined
	const node = schema as Record<string, unknown>
	if (node.$ref !== undefined) throw new Error("References are not supported by checkout rule context tracking")
	const object = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
	if (["", "cart", "customer", "checkout"].includes(path) && Array.isArray(node.required)) {
		for (const key of node.required) {
			if (typeof key === "string" && !Object.hasOwn(object ?? {}, key)) return path ? `${path}.${key}` : key
		}
	}
	const properties = node.properties && typeof node.properties === "object" ? (node.properties as Record<string, unknown>) : {}
	for (const [key, child] of Object.entries(properties)) {
		const nextPath = path ? `${path}.${key}` : key
		if (!object || !Object.hasOwn(object, key)) {
			// Absence in a supplied additional-fields bucket is a known value, as in Woo's document.
			if (path.endsWith("additional_fields") || (path.startsWith("customer.") && key.includes("/"))) continue
			return nextPath
		}
		const missing = missingContext(child, object[key], nextPath)
		if (missing) return missing
	}
	for (const keyword of ["allOf", "anyOf", "oneOf", "not"] as const) {
		const child = node[keyword]
		for (const branch of Array.isArray(child) ? child : [child]) {
			const missing = missingContext(branch, value, path)
			if (missing) return missing
		}
	}
	if (node.if !== undefined) {
		const missing = missingContext(node.if, value, path)
		if (missing) return missing
		const matches = compile(node.if as object | boolean)(value)
		const branchMissing = missingContext(matches ? node.then : node.else, value, path)
		if (branchMissing) return branchMissing
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const itemSchema = Array.isArray(node.items) ? (node.items[index] ?? node.additionalItems) : node.items
			const missing = missingContext(itemSchema, item, `${path}[${index}]`) ?? missingContext(node.contains, item, `${path}[${index}]`)
			if (missing) return missing
		}
	}
	if (object) {
		const patterns = Object.entries(node.patternProperties && typeof node.patternProperties === "object" ? node.patternProperties : {}).map(
			([pattern, child]) => [new RegExp(pattern), child] as const,
		)
		for (const [key, childValue] of Object.entries(object)) {
			const matches = patterns.filter(([pattern]) => pattern.test(key))
			for (const [, child] of matches) {
				const missing = missingContext(child, childValue, `${path}.${key}`)
				if (missing) return missing
			}
			if (!Object.hasOwn(properties, key) && !matches.length) {
				const missing = missingContext(node.additionalProperties, childValue, `${path}.${key}`)
				if (missing) return missing
			}
		}
		if (node.dependencies && typeof node.dependencies === "object") {
			for (const [key, dependency] of Object.entries(node.dependencies)) {
				if (!Object.hasOwn(object, key)) continue
				const missing = missingContext(dependency, value, path)
				if (missing) return missing
			}
		}
	}
	return undefined
}
