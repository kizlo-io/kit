import { readPath, safeFieldPath } from "./field-metadata"
import type { Cart, Checkout, CheckoutFieldGroup, CheckoutFieldValues, Storefront, StorefrontField } from "./types"

export type CheckoutFieldSources = { storefront: Storefront | null; checkout: Checkout | null; cart: Cart | null }
export type ConditionDocument = {
	value: Record<string, unknown>
	complete: Set<string>
	unavailable: Set<string>
}
const pathKey = (path: readonly string[]) => JSON.stringify(path)
const addressRoots = { billing: "billingAddress", shipping: "shippingAddress" } as const

export function checkoutDefaults({ checkout, cart }: CheckoutFieldSources): CheckoutFieldValues | null {
	if (!checkout || checkout.isPaid || !cart) return null
	return structuredClone({
		billingAddress: checkout.billingAddress,
		shippingAddress: checkout.shippingAddress,
		additionalFields: checkout.additionalFields,
		paymentMethod: checkout.paymentMethod ?? "",
		customerNote: checkout.customerNote,
		createAccount: false,
	})
}

export function fieldPaths(field: StorefrontField, group: CheckoutFieldGroup) {
	const address = group === "billing" || group === "shipping"
	const binding = field.bindings?.[address ? group : "other"]
	if (!safeFieldPath(binding)) return undefined
	return {
		input: address ? [addressRoots[group], ...binding] : binding,
		document: address
			? ["customer", `${group}_address`, field.id]
			: field.id === "email" && binding[0] === "billingAddress"
				? ["customer", "billing_address", "email"]
				: [group === "contact" ? "customer" : "checkout", "additional_fields", field.id],
	}
}

/** Restore structural Woo keys through bindings; plugin IDs and extension payloads stay opaque. */
export function checkoutDocument(sources: CheckoutFieldSources, values: CheckoutFieldValues | undefined): ConditionDocument {
	const complete = new Set<string>()
	const unavailable = new Set<string>([pathKey(["cart", "extensions", "kizlo"])])
	const customer: Record<string, unknown> = {}
	const checkout: Record<string, unknown> = {}
	const value: Record<string, unknown> = { customer, checkout }
	const current = values ?? checkoutDefaults(sources)
	if (sources.checkout) customer.id = sources.checkout.customerId ?? 0
	if (current) {
		for (const group of ["billing", "shipping"] as const) {
			const address: Record<string, unknown> = Object.create(null)
			const native = {
				firstName: "first_name",
				lastName: "last_name",
				company: "company",
				address1: "address_1",
				address2: "address_2",
				city: "city",
				state: "state",
				postcode: "postcode",
				country: "country",
				phone: "phone",
				...(group === "billing" ? { email: "email", taxId: "kizlo/tax-id" } : {}),
			}
			for (const [input, wire] of Object.entries(native)) address[wire] = readPath(current, [addressRoots[group], input]) ?? ""
			// A controlled snapshot is complete even when an optional group is omitted.
			if (values !== undefined || readPath(current, [addressRoots[group]]) !== undefined) {
				customer[`${group}_address`] = address
				complete.add(pathKey(["customer", `${group}_address`]))
			}
		}
		customer.additional_fields = Object.create(null)
		checkout.additional_fields = Object.create(null)
		complete.add(pathKey(["customer", "additional_fields"]))
		complete.add(pathKey(["checkout", "additional_fields"]))
		checkout.payment_method = current.paymentMethod ?? ""
		checkout.customer_note = current.customerNote ?? ""
		checkout.create_account = current.createAccount ?? false
		for (const field of sources.storefront?.address.fields ?? []) {
			const groups: CheckoutFieldGroup[] = field.location === "address" ? ["billing", "shipping"] : [field.location]
			for (const group of groups) {
				const paths = fieldPaths(field, group)
				if (!paths) continue
				const target = readPath(value, paths.document.slice(0, -1))
				if (!target || typeof target !== "object") continue
				const child = readPath(current, paths.input)
				if (child !== undefined) (target as Record<string, unknown>)[field.id] = structuredClone(child)
				// Native address properties exist as empty strings in Woo's evaluation document.
				else if (paths.document[1]?.endsWith("_address") && !field.id.includes("/")) (target as Record<string, unknown>)[field.id] = ""
			}
		}
	}
	const cart = sources.cart
	if (cart) {
		const selected = cart.shippingPackages
			.map((shippingPackage) => shippingPackage.rates.find((rate) => rate.selected))
			.filter((rate): rate is NonNullable<typeof rate> => rate !== undefined)
		const classification = readPath(sources.storefront, ["checkout", "localPickup", "methodIds"])
		const knownClassification = Array.isArray(classification) && classification.every((id) => typeof id === "string")
		value.cart = {
			coupons: cart.coupons.map((coupon) => coupon.code),
			shipping_rates: [...new Set(selected.map((rate) => rate.id))],
			items: cart.items.flatMap((item) => Array(Math.ceil(item.quantity)).fill(item.variationId ?? item.productId)),
			items_type: [...new Set(cart.items.map((item) => item.type))],
			items_count: cart.itemCount,
			items_weight: cart.itemsWeight,
			needs_shipping: cart.needsShipping,
			...(knownClassification ? { prefers_collection: selected.some((rate) => classification.includes(rate.methodId)) } : {}),
			totals: { total_price: cart.totals.total, total_tax: cart.totals.taxTotal },
			extensions: structuredClone(cart.extensions),
		}
		if (!knownClassification) unavailable.add(pathKey(["cart", "prefers_collection"]))
		for (const namespace of Object.keys(cart.extensions)) complete.add(pathKey(["cart", "extensions", namespace]))
		for (const name of ["coupons", "shipping_rates", "items", "items_type", "totals"]) complete.add(pathKey(["cart", name]))
	}
	return { value, complete, unavailable }
}

export function scopeAddressDocument(document: ConditionDocument, group: CheckoutFieldGroup): ConditionDocument {
	if (group !== "billing" && group !== "shipping") return document
	const customer = document.value.customer as Record<string, unknown>
	const complete = new Set(document.complete)
	if (complete.has(pathKey(["customer", `${group}_address`]))) complete.add(pathKey(["customer", "address"]))
	return {
		...document,
		complete,
		value: { ...document.value, customer: { ...customer, address: customer[`${group}_address`] } },
	}
}
