import { describe, expect, expectTypeOf, it } from "vitest"
import { resolveAddressCountry, type StorefrontAddress } from "./address"
import { checkoutFieldDocument, resolveFieldRules } from "./field-rules"
import fixtures from "./field-rules.fixtures.json"
import { resolveCheckoutFields } from "./fields"
import type { Checkout, CheckoutFieldContext, CheckoutFieldValuePath } from "./types"

const field = (required: boolean | Record<string, unknown> = false, hidden: boolean | Record<string, unknown> = false) => ({
	label: "Field",
	optionalLabel: "Optional field",
	required,
	hidden,
	type: "text",
	index: null,
	autocomplete: null,
	placeholder: null,
	options: [],
})
const taxRequired = { customer: { properties: { address: { required: ["email"] } } } }
const taxHidden = { customer: { properties: { address: { not: { required: ["email"] } } } } }
const address: StorefrontAddress = {
	baseCountry: "GB",
	defaultCountry: "GB",
	defaultAddressFormat: "",
	countries: [
		{
			code: "IN",
			name: "India",
			allowBilling: true,
			allowShipping: true,
			locale: { state: { label: "Region", index: 1 }, city: { hidden: true } },
			format: "",
			states: [
				{ code: "MH", name: "Maharashtra" },
				{ code: "KA", name: "Karnataka" },
			],
		},
		{ code: "GB", name: "UK", allowBilling: true, allowShipping: true, locale: {}, format: "", states: [] },
	],
	fieldLocations: {
		address: ["first_name", "state", "city", "kizlo/tax-id", "plug/a.b[0]"],
		contact: ["email", "plug/contact"],
		order: ["plug/order", "plug/select"],
	},
	fields: {
		first_name: field(true),
		state: field(true),
		city: field(true),
		"kizlo/tax-id": field(taxRequired, taxHidden),
		"plug/a.b[0]": field(),
		email: field(true),
		"plug/contact": field(),
		"plug/order": field(),
		"plug/select": { ...field(), type: "select", options: [{ value: "express", label: "Express" }] },
	},
}
const billing: Checkout["billingAddress"] = {
	firstName: "Ada",
	lastName: "Buyer",
	company: "",
	address1: "1 Road",
	address2: "",
	city: "London",
	postcode: "SW1",
	country: "GB",
	state: "",
	phone: "",
	email: "",
	taxId: "GB-42",
	additionalFields: { "plug/a.b[0]": false },
}
const { email: _email, taxId: _tax, ...shipping } = billing
const context: CheckoutFieldContext = {
	checkout: {
		billingAddress: billing,
		shippingAddress: shipping,
		additionalFields: { "plug/contact": false, "plug/order": "gift" },
		customerId: 0,
		paymentMethod: "bacs",
		customerNote: "",
		createAccount: false,
	},
}

it("country fields expose distinct SDK paths, literal extras, raw rules and effective state options", () => {
	const before = structuredClone({ address, context })
	for (const group of ["billing", "shipping"] as const) {
		const model = resolveAddressCountry(address, "IN", { ...context, group })
		expect(model.fields[0]).toMatchObject({
			key: "state",
			label: "Region",
			type: "select",
			options: [
				{ value: "MH", label: "Maharashtra" },
				{ value: "KA", label: "Karnataka" },
			],
		})
		expect(model.fields.find((entry) => entry.key === "first_name")?.valuePath).toEqual([`${group}Address`, "firstName"])
		expect(model.fields.find((entry) => entry.key === "plug/a.b[0]")?.valuePath).toEqual([
			`${group}Address`,
			"additionalFields",
			"plug/a.b[0]",
		])
		const tax = model.fields.find((entry) => entry.key === "kizlo/tax-id")
		expect(tax?.required).toEqual(taxRequired)
		expect(tax?.hidden).toEqual(taxHidden)
		expect(tax?.resolved).toEqual({ status: "resolved", required: group === "billing", hidden: group === "shipping" })
		expect(tax?.valuePath).toEqual(
			group === "billing" ? ["billingAddress", "taxId"] : ["shippingAddress", "additionalFields", "kizlo/tax-id"],
		)
		expect(model.fields.find((entry) => entry.key === "city")?.resolved).toEqual({ status: "resolved", required: false, hidden: true })
	}
	expect({ address, context }).toEqual(before)
	expect(resolveAddressCountry(address, "GB").fields.find((entry) => entry.key === "state")).toMatchObject({ type: "text", options: [] })
	expect(resolveAddressCountry(address, "ZZ").fields.find((entry) => entry.key === "state")).toMatchObject({ type: "text", options: [] })
	const hiddenState = { ...address, countries: address.countries.map((country) => ({ ...country, locale: { state: { hidden: true } } })) }
	expect(resolveAddressCountry(hiddenState, "IN").fields.find((entry) => entry.key === "state")?.resolved.hidden).toBe(true)
})

it("the two-argument helper preserves country behavior and marks unscoped address paths unavailable", () => {
	const model = resolveAddressCountry(address, "IN")
	expect(model.states).toEqual(address.countries[0]?.states)
	expect(model.stateLabel).toBe("Region")
	expect(model.fields.every((entry) => entry.valuePath === null)).toBe(true)
	expect(model.fields.find((entry) => entry.key === "kizlo/tax-id")?.resolved).toMatchObject({
		status: "unresolved",
		hidden: null,
		required: null,
	})
})

it("contact and order share the SDK bucket while rules see separately scoped Woo buckets", () => {
	const doc = checkoutFieldDocument(address, context, "billing")
	expect(doc.customer).toMatchObject({
		additional_fields: { "plug/contact": false },
		address: { "kizlo/tax-id": "GB-42", email: "", "plug/a.b[0]": false },
	})
	expect(doc.customer?.additional_fields).not.toHaveProperty("plug/order")
	expect(doc.checkout?.additional_fields).toEqual({ "plug/order": "gift" })
	const contact = resolveCheckoutFields(address, "contact", context)
	expect(contact[0]).toMatchObject({ key: "email", location: "contact", group: "other", valuePath: ["billingAddress", "email"] })
	expect(contact[1]?.valuePath).toEqual(["additionalFields", "plug/contact"])
	expect(resolveCheckoutFields(address, "order", context)[0]?.valuePath).toEqual(["additionalFields", "plug/order"])
	expect(resolveCheckoutFields(address, "order", context)[1]).toMatchObject({
		type: "select",
		options: [{ value: "express", label: "Express" }],
	})
	const rule = {
		allOf: [
			{ properties: { customer: { properties: { additional_fields: { properties: { "plug/contact": { const: false } } } } } } },
			{ properties: { checkout: { properties: { additional_fields: { properties: { "plug/order": { const: "gift" } } } } } } },
		],
	}
	const store = { ...address, fields: { ...address.fields, "plug/order": field(rule) } }
	expect(resolveCheckoutFields(store, "order", context)[0]?.resolved.required).toBe(true)
	expect(
		resolveCheckoutFields(store, "order", {
			checkout: { ...context.checkout, additionalFields: { "plug/order": "ordinary", "plug/contact": true } },
		})[0]?.resolved.required,
	).toBe(false)
})

it("builds customer and cart snapshots without inventing unavailable Woo context", () => {
	const document = checkoutFieldDocument(
		address,
		{
			customer: { id: 42, billing, shipping, additionalFields: { "plug/contact": false } },
			cart: {
				needsShipping: true,
				itemCount: 2,
				itemsWeight: 300,
				coupons: [],
				shippingPackages: [],
				items: [],
				totals: {
					itemsTotal: 0,
					itemsTaxTotal: 0,
					feesTotal: 0,
					feesTaxTotal: 0,
					discountTotal: 0,
					discountTaxTotal: 0,
					shippingTotal: 0,
					shippingTaxTotal: 0,
					total: 1234,
					taxTotal: 123,
					taxLines: [],
				},
				extensions: {},
			},
			document: { cart: { prefers_collection: false } },
		},
		"shipping",
	)
	expect(document.customer?.id).toBe(42)
	expect(document.customer?.address).not.toHaveProperty("email")
	expect(document.cart).toEqual({
		needs_shipping: true,
		items_count: 2,
		items_weight: 300,
		coupons: [],
		shipping_rates: [],
		items: [],
		items_type: [],
		totals: { total_price: 1234, total_tax: 123 },
		extensions: {},
		prefers_collection: false,
	})
	expect(document.checkout).toBeUndefined()
})

it("missing context and unsupported schemas are explicit, with raw rules untouched", () => {
	const raw = { cart: { properties: { needs_shipping: { const: true } } } }
	expect(resolveFieldRules(raw, false, {}).status).toBe("unresolved")
	expect(resolveFieldRules(raw, false, { cart: {} })).toMatchObject({
		status: "unresolved",
		required: null,
		issues: [{ reason: "missing-context", detail: "cart.needs_shipping" }],
	})
	for (const rule of [
		{ cart: { madeUp: true } },
		{ $ref: "https://example.com/rules" },
		{ customer: { properties: { id: { type: "unknown" } } } },
	]) {
		expect(resolveFieldRules(rule, false, {}).status).toBe("unresolved")
		expect(resolveFieldRules(rule, false, {})).toMatchObject({ issues: [{ reason: "unsupported-rule" }] })
	}
	expect(raw).toEqual({ cart: { properties: { needs_shipping: { const: true } } } })
	expect(resolveFieldRules(true, raw, {})).toMatchObject({ status: "unresolved", required: null, hidden: null })
	expect(resolveFieldRules(raw, true, {})).toEqual({ status: "resolved", required: false, hidden: true })
})

describe("Woo 11.0.1 shared schema parity fixtures", () => {
	for (const fixture of fixtures)
		it(fixture.name, () => {
			const before = structuredClone(fixture)
			expect(resolveFieldRules(fixture.required, fixture.hidden, fixture.document)).toEqual({ status: "resolved", ...fixture.expected })
			expect(fixture).toEqual(before)
		})
})

it("paths derive from the active client's normalized types", () => {
	expectTypeOf<readonly ["billingAddress", "taxId"]>().toExtend<CheckoutFieldValuePath>()
	expectTypeOf<readonly ["billingAddress", "first_name"]>().not.toExtend<CheckoutFieldValuePath>()
	expectTypeOf<readonly ["shippingAddress", "taxId"]>().not.toExtend<CheckoutFieldValuePath>()
})
