/**
 * Address bones: the store's countries, states and per-country field metadata.
 *
 * No React, query library or markup. Everything here is a derivation over `storefront.address`, which the store builds from the
 * same WooCommerce Blocks helpers its own Checkout block reads, so a storefront gets the merchant's selling countries and each
 * country's field rules without carrying any of them. Postcode validation is supplied separately by the checkout schema.
 *
 * A field's rules for a country are the store's default definition overlaid with that country's locale, exactly as the Checkout
 * block's `getFieldsForCountry` builds them.
 */

import type { Storefront } from "./types"

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
 * Group-specific field resolvers evaluate these rules in checkout context.
 */
export type AddressField = StorefrontAddress["fields"][number] & { key: string }

/** Everything an address form needs to know about one country. */
export type AddressCountryModel = {
	/** The code asked for. */
	code: string
	/** The store's country, or `null` for a code it does not know. */
	country: StorefrontCountry | null
	/** The country's address fields in display order, hidden ones included. The default fields for an unknown country. */
	fields: AddressField[]
	/** The country's states in the store's order, or `[]` when it has none and the state is free text or absent. */
	states: readonly StorefrontState[]
	/** What the country calls its state field — "Province", "County", "Prefecture" — or the default label. */
	stateLabel: string
}

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
	for (const field of address.fields) {
		if (field.location !== "address") continue
		fields.push({ ...field, ...locale[field.id], key: field.id })
	}

	// `sort` is stable, so fields without an index keep the store's own order after those that have one.
	return fields.sort((a, b) => (a.index ?? Number.POSITIVE_INFINITY) - (b.index ?? Number.POSITIVE_INFINITY))
}

/** Country metadata and locale fields, retained for address display consumers. */
export function resolveAddressCountry(address: StorefrontAddress, countryCode: string | null | undefined): AddressCountryModel {
	const country = findCountry(address, countryCode) ?? null
	const fields = addressFields(address, countryCode)

	return {
		code: countryCode ?? "",
		country,
		fields,
		states: country?.states ?? [],
		stateLabel: fields.find((field) => field.key === "state")?.label ?? address.fields.find((field) => field.id === "state")?.label ?? "",
	}
}

function findCountry(address: StorefrontAddress, countryCode: string | null | undefined) {
	return countryCode ? address.countries.find((country) => country.code === countryCode) : undefined
}
