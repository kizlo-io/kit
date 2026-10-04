/**
 * Address bones: the store's countries, states and per-country field rules, and whether an address is complete enough to price.
 *
 * No React, query library or markup. Everything here is a derivation over `storefront.address`, which the store builds from the
 * same WooCommerce Blocks helpers its own Checkout block reads, so a storefront gets the merchant's selling countries and each
 * country's field rules without carrying any of them. The kit holds no country, state or postcode rule of its own.
 *
 * A field's rules for a country are the store's default definition overlaid with that country's locale, exactly as the Checkout
 * block's `getFieldsForCountry` builds them.
 */

import { resolveFields } from "./fields"
import type { CheckoutFieldContext, ResolvedCheckoutField, Storefront } from "./types"

/** The store's address data: its countries, their states and locale overrides, and the default field definitions. */
export type StorefrontAddress = Storefront["address"]

/** One country the store knows, with its states, its locale overrides and its address format. */
export type StorefrontCountry = StorefrontAddress["countries"][number]

/** One state of a country, in the store's order. */
export type StorefrontState = StorefrontCountry["states"][number]

/**
 * One address field as it applies to a country.
 *
 * `required` and `hidden` stay as the store sent them: a boolean, or a JSON Schema rule object for a plugin-registered field.
 * Resolved fields expose evaluated rules separately; {@link isAddressComplete} reads raw rules as required and visible.
 */
export type AddressField = StorefrontAddress["fields"][string] & { key: string }

/** Everything an address form needs to know about one country. */
export type AddressCountryModel = {
	/** The code asked for. */
	code: string
	/** The store's country, or `null` for a code it does not know. */
	country: StorefrontCountry | null
	/** The country's address fields in display order, hidden ones included. The default fields for an unknown country. */
	fields: ResolvedCheckoutField[]
	/** The country's states in the store's order, or `[]` when it has none and the state is free text or absent. */
	states: readonly StorefrontState[]
	/** What the country calls its state field — "Province", "County", "Prefecture" — or the default label. */
	stateLabel: string
}

/** The customer-entered values {@link isAddressComplete} reads. Any address shape with these keys fits, the cart's included. */
export type AddressCompletenessInput = {
	city?: string | null
	country?: string | null
	postcode?: string | null
	state?: string | null
}

/** The fields WooCommerce checks for completeness before it quotes shipping. */
const completenessFieldKeys = ["country", "state", "postcode", "city"] as const

/** The countries the store bills to, in the store's order. */
export function billingCountries(address: StorefrontAddress): StorefrontCountry[] {
	return address.countries.filter((country) => country.allowBilling)
}

/** The countries the store ships to, in the store's order. */
export function shippingCountries(address: StorefrontAddress): StorefrontCountry[] {
	return address.countries.filter((country) => country.allowShipping)
}

/**
 * The address fields for a country: each default field overlaid with the country's locale, sorted by its effective `index`.
 *
 * Limited to the fields the store places in an address, so contact and order fields stay out of an address form. An unknown or
 * missing code answers the default fields rather than throwing: a form keeps rendering while the shopper corrects it.
 */
export function addressFields(address: StorefrontAddress, countryCode: string | null | undefined): AddressField[] {
	const locale = findCountry(address, countryCode)?.locale ?? {}

	const fields: AddressField[] = []
	for (const key of address.fieldLocations.address) {
		const field = address.fields[key]
		if (!field) continue
		fields.push({ ...field, ...locale[key], key })
	}

	// `sort` is stable, so fields without an index keep the store's own order after those that have one.
	return fields.sort((a, b) => (a.index ?? Number.POSITIVE_INFINITY) - (b.index ?? Number.POSITIVE_INFINITY))
}

/**
 * Country metadata with effective options and rules. Supply `group` to resolve SDK targets and scope Woo's customer.address.
 * Existing two-argument calls retain country/locale behavior; address value paths remain null until the group is supplied.
 */
export function resolveAddressCountry(
	address: StorefrontAddress,
	countryCode: string | null | undefined,
	context: CheckoutFieldContext & { group?: "billing" | "shipping" } = {},
): AddressCountryModel {
	const country = findCountry(address, countryCode) ?? null
	const fields = resolveFields(address, addressFields(address, countryCode), "address", context, context.group).map((field) => {
		if (field.key !== "state" || !country) return field
		return {
			...field,
			type: country.states.length ? "select" : "text",
			options: country.states.map((state) => ({ value: state.code, label: state.name })),
		}
	})

	return {
		code: countryCode ?? "",
		country,
		fields,
		states: country?.states ?? [],
		stateLabel: fields.find((field) => field.key === "state")?.label ?? address.fields.state?.label ?? "",
	}
}

/**
 * Whether the shopper has filled in every address field the store needs to quote shipping, by the store's rules for the
 * chosen country.
 *
 * Mirrors the Checkout block's check: there must be a country, and each of country, state, postcode and city must be hidden,
 * optional or filled for that country. A country without postcodes is complete without one; a country that requires one is
 * not. A rule object in `required` or `hidden` reads as required and visible, so an unevaluated plugin rule fails closed. A
 * value of only whitespace counts as empty.
 *
 * Completeness, not validity, as in WooCommerce. It does not check that the store ships to the country — offer only
 * {@link shippingCountries} — or that the state is one of the country's own — clear the state when the country changes.
 */
export function isAddressComplete(address: StorefrontAddress, input: AddressCompletenessInput): boolean {
	if (!input.country?.trim()) return false

	return addressFields(address, input.country)
		.filter((field) => (completenessFieldKeys as readonly string[]).includes(field.key))
		.every(
			(field) => field.hidden === true || field.required === false || Boolean(input[field.key as keyof AddressCompletenessInput]?.trim()),
		)
}

function findCountry(address: StorefrontAddress, countryCode: string | null | undefined) {
	return countryCode ? address.countries.find((country) => country.code === countryCode) : undefined
}
