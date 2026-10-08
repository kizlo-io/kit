import { describe, expect, it } from "vitest"
import { addressFields, billingCountries, resolveAddressCountry, type StorefrontAddress, shippingCountries } from "./address"

function field(label: string, index: number, rules: { hidden?: boolean; required?: boolean } = {}) {
	return {
		autocomplete: null,
		hidden: rules.hidden ?? false,
		index,
		label,
		optionalLabel: `${label} (optional)`,
		options: [],
		placeholder: null,
		required: rules.required ?? true,
		type: "text",
	}
}

/** A store selling to three countries, in the `storefront.get` shape, with the locale rules WooCommerce itself ships for them. */
const address: StorefrontAddress = {
	baseCountry: "IN",
	countries: [
		{
			// No postcode, and a state list under its own name.
			allowBilling: true,
			allowShipping: true,
			code: "AE",
			format: "{name}\n{address_1}\n{city}\n{state}\n{country}",
			locale: { postcode: { hidden: true, required: false }, state: { label: "Emirate" } },
			name: "United Arab Emirates",
			states: [
				{ code: "AZ", name: "Abu Dhabi" },
				{ code: "DU", name: "Dubai" },
			],
		},
		{
			// Billing only, with a free-text optional county.
			allowBilling: true,
			allowShipping: false,
			code: "GB",
			format: "{name}\n{address_1}\n{city}\n{state}\n{postcode}\n{country}",
			locale: { postcode: { label: "Postcode" }, state: { label: "County", required: false } },
			name: "United Kingdom",
			states: [],
		},
		{
			// A state list with no label of its own, and the postcode moved ahead of the city.
			allowBilling: true,
			allowShipping: true,
			code: "IN",
			format: "{name}\n{address_1}\n{city} {postcode}\n{state}\n{country}",
			locale: { postcode: { index: 65, label: "PIN Code" } },
			name: "India",
			states: [
				{ code: "KA", name: "Karnataka" },
				{ code: "MH", name: "Maharashtra" },
			],
		},
	],
	defaultAddressFormat: "{name}\n{address_1}\n{city}\n{state}\n{postcode}\n{country}",
	defaultCountry: "IN",

	fields: Object.entries({
		address_1: field("Address", 50),
		city: field("City", 70),
		company: field("Company", 30, { hidden: true, required: false }),
		country: field("Country/Region", 40),
		email: field("Email address", 0),
		first_name: field("First name", 10),
		postcode: field("Postal code", 90),
		state: field("State/County", 80),
	}).map(([id, field]) => ({
		...field,
		id,
		location: id === "email" ? ("contact" as const) : ("address" as const),
		attributes: {},
		schema: { type: "string" },
		bindings: {},
	})),
}

const keys = (fields: { key: string }[]) => fields.map((entry) => entry.key)

describe("billingCountries and shippingCountries", () => {
	it("list only the countries the store allows, in its order", () => {
		expect(billingCountries(address).map((country) => country.code)).toEqual(["AE", "GB", "IN"])
		expect(shippingCountries(address).map((country) => country.code)).toEqual(["AE", "IN"])
	})
})

describe("addressFields", () => {
	it("overlays the country's locale on the default fields", () => {
		const postcode = addressFields(address, "AE").find((entry) => entry.key === "postcode")
		expect(postcode).toMatchObject({ hidden: true, label: "Postal code", required: false })
	})

	it("keeps only address fields and orders them by their effective index", () => {
		expect(keys(addressFields(address, "IN"))).toEqual(["first_name", "company", "country", "address_1", "postcode", "city", "state"])
	})

	it("answers the default fields for an unknown or missing country rather than throwing", () => {
		const defaults = addressFields(address, "ZZ")
		expect(defaults.find((entry) => entry.key === "postcode")).toMatchObject({ hidden: false, required: true })
		expect(addressFields(address, null)).toEqual(defaults)
	})
})

describe("resolveAddressCountry", () => {
	it("resolves a country without a postcode as not requiring one", () => {
		const postcode = resolveAddressCountry(address, "AE").fields.find((entry) => entry.key === "postcode")
		expect(postcode?.required).toBe(false)
		expect(postcode?.hidden).toBe(true)
	})

	it("resolves a country's states and its own name for the field", () => {
		const model = resolveAddressCountry(address, "AE")
		expect(model.states.map((state) => state.code)).toEqual(["AZ", "DU"])
		expect(model.stateLabel).toBe("Emirate")
	})

	it("falls back to the default state label when the country has none", () => {
		const model = resolveAddressCountry(address, "IN")
		expect(model.states).toHaveLength(2)
		expect(model.stateLabel).toBe("State/County")
	})

	it("reports no state list for a country with none", () => {
		const model = resolveAddressCountry(address, "GB")
		expect(model.states).toEqual([])
		expect(model.stateLabel).toBe("County")
	})

	it("falls back for an unknown country code rather than throwing", () => {
		const model = resolveAddressCountry(address, "ZZ")
		expect(model).toMatchObject({ code: "ZZ", country: null, stateLabel: "State/County", states: [] })
		expect(model.fields).toEqual(addressFields(address, undefined))
	})
})
