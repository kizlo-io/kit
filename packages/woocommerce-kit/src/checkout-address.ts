import type { CheckoutFieldSources } from "./checkout-field-document"
import { readPath } from "./field-metadata"

type AddressSources = Pick<CheckoutFieldSources, "storefront" | "cart">
type AddressRoot = "billingAddress" | "shippingAddress"
type AddressValues = { billingAddress?: object | null; shippingAddress?: object | null }
export const checkoutAddressKeys = [
	"firstName",
	"lastName",
	"company",
	"address1",
	"address2",
	"city",
	"state",
	"postcode",
	"country",
	"phone",
] as const
const nativeAddress = new Set<string>(checkoutAddressKeys)

export function checkoutAddressSource(sources: AddressSources, useShippingAsBilling?: boolean): AddressRoot | null {
	if (!sources.storefront || !sources.cart?.needsShipping) return null
	if (sources.storefront.checkout.forcedBillingAddress) return "billingAddress"
	return useShippingAsBilling === false ? null : "shippingAddress"
}

export function checkoutAddressTarget(sources: AddressSources, useShippingAsBilling?: boolean): AddressRoot | null {
	const source = checkoutAddressSource(sources, useShippingAsBilling)
	return source === "billingAddress" ? "shippingAddress" : source === "shippingAddress" ? "billingAddress" : null
}

/** Only native address members have a shared meaning; registered buckets remain independent. */
export function checkoutAddressPath(sources: AddressSources, useShippingAsBilling: boolean | undefined, path: readonly string[]): string[] {
	const source = checkoutAddressSource(sources, useShippingAsBilling)
	return source && path.length === 2 && path[0] === checkoutAddressTarget(sources, useShippingAsBilling) && nativeAddress.has(path[1] ?? "")
		? [source, ...path.slice(1)]
		: [...path]
}

/** Omitted authoritative members stay omitted, rather than retaining stale destination values or inventing defaults. */
export function projectCheckoutAddresses<T extends AddressValues>(sources: AddressSources, values: T, useShippingAsBilling?: boolean): T {
	const output = { ...values }
	const source = checkoutAddressSource(sources, useShippingAsBilling)
	const target = checkoutAddressTarget(sources, useShippingAsBilling)
	if (source && target) {
		const independent = Object.fromEntries(
			Object.entries(values[target] ?? {}).filter(
				([key]) => !nativeAddress.has(key) && !(target === "shippingAddress" && (key === "email" || key === "taxId")),
			),
		)
		const shared = Object.fromEntries(
			[...nativeAddress].flatMap((key) => {
				const value = readPath(values[source], [key])
				return value === undefined ? [] : [[key, value]]
			}),
		)
		output[target] = { ...independent, ...shared }
	}
	if (sources.cart?.needsShipping === false) delete output.shippingAddress
	return output
}
