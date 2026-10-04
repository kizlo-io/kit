import { resolveCheckoutFieldTarget } from "@kizlo/woocommerce"
import type { AddressField, StorefrontAddress } from "./address"
import { checkoutFieldDocument, resolveFieldRules } from "./field-rules"
import type { CheckoutFieldContext, CheckoutFieldLocation, ResolvedCheckoutField } from "./types"

/** Resolve contact/order controls without applying any country locale or address-copy policy. */
export function resolveCheckoutFields(
	address: StorefrontAddress,
	location: "contact" | "order",
	context: CheckoutFieldContext = {},
): ResolvedCheckoutField[] {
	return resolveFields(
		address,
		address.fieldLocations[location].flatMap((key) => (address.fields[key] ? [{ ...address.fields[key], key }] : [])),
		location,
		context,
	)
}

export function resolveFields(
	address: StorefrontAddress,
	fields: AddressField[],
	location: CheckoutFieldLocation,
	context: CheckoutFieldContext = {},
	group?: "billing" | "shipping",
): ResolvedCheckoutField[] {
	const document = checkoutFieldDocument(address, context, group)
	return fields
		.map((field): ResolvedCheckoutField => {
			const target = resolveCheckoutFieldTarget(address.fieldLocations, field.key, group)
			return {
				...field,
				location,
				group: location === "address" ? (group ?? null) : "other",
				valuePath: (target?.path as ResolvedCheckoutField["valuePath"]) ?? null,
				resolved: resolveFieldRules(field.required, field.hidden, document),
			}
		})
		.sort((a, b) => (a.index ?? Number.POSITIVE_INFINITY) - (b.index ?? Number.POSITIVE_INFINITY))
}
