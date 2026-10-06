import { describe, expect, it } from "vitest"
import { checkoutDefaults, checkoutDocument, scopeAddressDocument } from "./checkout-field-document"
import { compileCheckoutSchema, valueSchema } from "./checkout-field-schema"
import { checkoutFieldsSchema, resolveCheckoutFields } from "./checkout-fields"
import { field, fixtures } from "./test/checkout-fields-fixture"
import evidence from "./test/fixtures/checkout-conditions.json"
import type { CheckoutFieldValues, FieldSchema, StorefrontField } from "./types"

const condition = (properties: object): FieldSchema => ({ properties })
const countryIs = (country: string) => condition({ customer: { properties: { address: { properties: { country: { const: country } } } } } })
function validate(source: ReturnType<typeof fixtures>, candidate: CheckoutFieldValues = source.values) {
	return checkoutFieldsSchema(() => source)["~standard"].validate(candidate)
}
function firstField(source: ReturnType<typeof fixtures>) {
	const field = source.storefront.address.fields[0]
	if (!field) throw new Error("Missing test field")
	return field
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value)
		Object.values(value).forEach(freeze)
	}
	return value
}

describe("checkout document mapping", () => {
	it("maps acknowledged multi-package cart facts, guest identity and opaque extension data", () => {
		const source = fixtures()
		expect(checkoutDocument(source, source.values).value).toMatchObject({
			cart: {
				coupons: ["SAVE"],
				shipping_rates: [evidence.rateId],
				items: [42, 42, 91, 43],
				items_type: ["simple", "variation"],
				items_count: 2.25,
				items_weight: 1.7,
				needs_shipping: true,
				prefers_collection: true,
				totals: { total_price: 12345, total_tax: 321 },
				extensions: evidence.cartExtensions,
			},
			customer: { id: 0 },
			checkout: { payment_method: "bacs", customer_note: "saved", create_account: false },
		})
		source.checkout.customerId = 15
		expect(checkoutDocument(source, source.values).value.customer).toHaveProperty("id", 15)
		expect(checkoutDocument({ ...source, checkout: null }, source.values).value.customer).not.toHaveProperty("id")
	})
	it("uses any classified acknowledged method; known empty and missing classification differ", () => {
		const source = fixtures()
		const pickup = source.storefront.checkout.localPickup as unknown as { methodIds: unknown }
		pickup.methodIds = []
		expect(checkoutDocument(source, source.values).value.cart).toHaveProperty("prefers_collection", false)
		for (const missing of [null, undefined, [false]]) {
			pickup.methodIds = missing
			expect(checkoutDocument(source, source.values).value.cart).not.toHaveProperty("prefers_collection")
			expect(resolveCheckoutFields(source, source.values).unsupported).toContainEqual(
				expect.objectContaining({ reason: "unavailable-data" }),
			)
			expect(validate(source)).toHaveProperty("issues")
		}
		pickup.methodIds = ["qa_pickup"]
		source.cart.shippingPackages = []
		expect(checkoutDocument(source, source.values).value.cart).toHaveProperty("prefers_collection", false)
	})
	it("recognizes built-in pickup alongside custom classification", () => {
		const source = fixtures()
		source.cart.shippingPackages = [
			{
				...source.cart.shippingPackages[0],
				rates: [{ ...source.cart.shippingPackages[0]?.rates[0], id: "local_pickup:1", methodId: "local_pickup", selected: true }],
			},
		] as typeof source.cart.shippingPackages
		expect(checkoutDocument(source, source.values).value.cart).toHaveProperty("prefers_collection", true)
		expect(resolveCheckoutFields(source, source.values).fields.order[0]?.required).toBe(true)
	})
	it("partitions groups, restores native Tax ID and keeps address aliases independent", () => {
		const fields = [
			field("country", { location: "address", bindings: { billing: ["country"], shipping: ["country"] } }),
			field("kizlo/tax-id", { location: "address", bindings: { billing: ["taxId"] } }),
			field("email", { location: "contact", bindings: { other: ["billingAddress", "email"] } }),
			field("plug/a.b[0]", { location: "contact" }),
			field("plug/order"),
		]
		const source = fixtures(fields)
		const values = { ...source.values, additionalFields: { "plug/a.b[0]": "contact", "plug/order": "order" } }
		const global = checkoutDocument(source, values)
		expect(global.value.customer).toMatchObject({
			billing_address: { country: "IN", email: "ada@example.com", "kizlo/tax-id": "TAX" },
			shipping_address: { country: "GB" },
			additional_fields: { "plug/a.b[0]": "contact" },
		})
		expect(global.value.checkout).toHaveProperty("additional_fields", { "plug/order": "order" })
		expect(global.value.customer).not.toHaveProperty("address")
		expect(scopeAddressDocument(global, "billing").value.customer).toHaveProperty(
			"address",
			expect.objectContaining({ country: "IN", email: "ada@example.com", "kizlo/tax-id": "TAX" }),
		)
		expect(scopeAddressDocument(global, "shipping").value.customer).toHaveProperty("address", expect.objectContaining({ country: "GB" }))
		expect(global.value.customer).not.toHaveProperty("address")
	})
	it("requires coherent initialization and preserves controlled empty/false/omitted values", () => {
		const source = fixtures([field("saved"), field("flag", { type: "checkbox", schema: { type: "boolean" } })])
		expect(checkoutDefaults({ ...source, cart: null })).toBeNull()
		expect(checkoutDefaults({ ...source, checkout: null })).toBeNull()
		expect(checkoutDefaults({ ...source, checkout: { ...source.checkout, isPaid: true } })).toBeNull()
		expect(checkoutDocument({ ...source, cart: null }, undefined).value.customer).not.toHaveProperty("billing_address")
		const values = { ...source.values, paymentMethod: "", customerNote: "", createAccount: false, additionalFields: { flag: false } }
		expect(checkoutDocument(source, values).value.checkout).toEqual({
			payment_method: "",
			customer_note: "",
			create_account: false,
			additional_fields: { flag: false },
		})
		expect(checkoutDocument(source, {}).value.checkout).toMatchObject({
			payment_method: "",
			customer_note: "",
			create_account: false,
			additional_fields: {},
		})
	})
	it("never mutates frozen sources or controlled values and leaks no shopper documents", () => {
		const source = freeze(fixtures())
		expect(validate(source)).toHaveProperty("value", source.values)
		expect("value" in validate(source) && (validate(source) as { value: unknown }).value).toBe(source.values)
		const other = fixtures()
		other.cart.extensions = { qaConditions: { "reference.required": false } }
		const empty = { ...other.values, additionalFields: {} }
		expect(validate(other, empty)).toHaveProperty("value", empty)
		expect(validate(source, empty)).toHaveProperty("issues")
	})
})

describe("live resolution and validation", () => {
	it("validates the seeded persistence evidence and keeps server group targeting distinct", () => {
		const source = fixtures()
		expect(resolveCheckoutFields(source, source.values).fields.order[0]).toMatchObject({ required: true, key: evidence.targetPath })
		expect(validate(source)).toHaveProperty("value")
		const invalid = validate(source, { ...source.values, additionalFields: {} })
		expect(invalid).toHaveProperty("issues", expect.arrayContaining([expect.objectContaining({ path: evidence.targetPath })]))
		expect(evidence.persistedValue).toBe(evidence.submittedValue)
		expect(evidence.serverErrorTargetPath).toEqual(["additionalFields"])
	})
	it("evaluates candidate cross-group edits before rendering changes and follows current sources", () => {
		const source = fixtures([
			field("ref", {
				required: condition({ customer: { properties: { billing_address: { properties: { country: { const: "IN" } } } } } }),
			}),
		])
		const adapter = checkoutFieldsSchema(() => source)
		const missing = { ...source.values, additionalFields: {} }
		expect(adapter["~standard"].validate(missing)).toHaveProperty("issues")
		expect(adapter["~standard"].validate({ ...missing, billingAddress: { ...missing.billingAddress, country: "GB" } })).toHaveProperty(
			"value",
		)
		firstField(source).required = false
		expect(adapter["~standard"].validate(missing)).toHaveProperty("value")
	})
	it("resolves independent aliases and preserves billing-only Tax ID", () => {
		const source = fixtures([
			field("country", { location: "address", bindings: { billing: ["country"], shipping: ["country"] } }),
			field("plug/ref", {
				location: "address",
				required: countryIs("IN"),
				bindings: { billing: ["additionalFields", "plug/ref"], shipping: ["additionalFields", "plug/ref"] },
			}),
			field("kizlo/tax-id", { location: "address", required: true, bindings: { billing: ["taxId"] } }),
		])
		const result = resolveCheckoutFields(source, source.values)
		expect(result.unsupported).toEqual([])
		expect(result.fields.billing.find((f) => f.id === "plug/ref")?.required).toBe(true)
		expect(result.fields.shipping.find((f) => f.id === "plug/ref")?.required).toBe(false)
		expect(result.fields.shipping.some((f) => f.id === "kizlo/tax-id")).toBe(false)
		expect(validate(source)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["billingAddress", "additionalFields", "plug/ref"] })]),
		)
	})
	it.each(["plug/a.b[0]", "plug/a/b", "plug/~ref"])("maps %s as one literal submission segment", (id) => {
		const source = fixtures([field(id, { required: true })])
		expect(validate(source, { ...source.values, additionalFields: { [id]: "" } })).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["additionalFields", id] })]),
		)
	})
	it("supports absolute and relative $data value rules and custom messages", () => {
		const source = fixtures([
			field("confirm", { schema: { type: "string", const: { $data: "/checkout/payment_method" }, errorMessage: "Match payment" } }),
			field("relative", { schema: { type: "string", const: { $data: "1/confirm" } } }),
		])
		expect(resolveCheckoutFields(source, source.values).unsupported).toEqual([])
		const candidate = { ...source.values, additionalFields: { confirm: "bacs", relative: "bacs" } }
		expect(validate(source, candidate)).toHaveProperty("value")
		expect(validate(source, { ...candidate, paymentMethod: "card" })).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ message: "Match payment", path: ["additionalFields", "confirm"] })]),
		)
	})
	it("supports $data inside conditions and diagnoses unavailable dynamic dependencies", () => {
		const source = fixtures([
			field("ref", { required: condition({ customer: { properties: { id: { const: { $data: "/cart/items_count" } } } } }) }),
		])
		source.checkout.customerId = source.cart.itemCount
		expect(resolveCheckoutFields(source, source.values).fields.order[0]?.required).toBe(true)
		firstField(source).schema = { type: "string", maxLength: { $data: "/cart/not_available" } }
		expect(resolveCheckoutFields(source, source.values).unsupported[0]?.reason).toBe("unavailable-data")
		expect(validate(source)).toHaveProperty("issues")
	})
	it("isolates local references and duplicate field resource IDs", () => {
		const make = (id: string, length: number) =>
			field(id, {
				schema: { $id: "https://plugin.test/schema", $defs: { value: { type: "string", minLength: length } }, $ref: "#/$defs/value" },
			})
		const source = fixtures([make("short", 2), make("long", 5)])
		expect(resolveCheckoutFields(source, source.values).unsupported).toEqual([])
		expect(validate(source, { ...source.values, additionalFields: { short: "ok", long: "no" } })).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["additionalFields", "long"] })]),
		)
		expect(validate(source, { ...source.values, additionalFields: { short: "ok", long: "valid" } })).toHaveProperty("value")
	})
	it("combines reference-scoped constraints with required and optional wrappers", () => {
		const schema = { definitions: { value: { type: "string", maxLength: 3 } }, $ref: "#/definitions/value" }
		const source = fixtures([field("ref", { schema, required: true })])
		expect(resolveCheckoutFields(source, source.values).unsupported).toEqual([])
		expect(validate(source, { ...source.values, additionalFields: { ref: "ok" } })).toHaveProperty("value")
		expect(validate(source, { ...source.values, additionalFields: { ref: "" } })).toHaveProperty("issues")
		firstField(source).required = false
		expect(validate(source, { ...source.values, additionalFields: { ref: "" } })).toHaveProperty("value")
	})
	it("preserves locale choices, eligibility, ordering and hidden values", () => {
		const binding = (id: string) => ({ billing: [id], shipping: [id] })
		const source = fixtures([
			field("country", { location: "address", bindings: binding("country"), index: 10 }),
			field("state", { location: "address", required: true, bindings: binding("state"), index: 20 }),
		])
		let model = resolveCheckoutFields(source, source.values)
		expect(model.fields.billing.map((field) => field.id)).toEqual(["country", "state"])
		expect(model.fields.shipping[0]?.options.map((o) => o.value)).toEqual(["IN", "AE"])
		expect(model.fields.billing[1]).toMatchObject({ type: "select", options: [{ value: "KA", label: "Karnataka" }] })
		expect(model.fields.shipping[1]).toMatchObject({ required: false, type: "text", label: "County" })
		const values = { ...source.values, shippingAddress: { ...source.checkout.shippingAddress, country: "AE", state: "retained" } }
		model = resolveCheckoutFields(source, values)
		expect(model.fields.shipping[1]?.hidden).toBe(true)
		expect(validate(source, values)).toHaveProperty("value", values)
	})
	it("handles checkbox/select requirements and optional empty strings", () => {
		const source = fixtures([
			field("agree", { type: "checkbox", required: true, schema: { type: "boolean" } }),
			field("choice", { type: "select", options: [{ value: "one", label: "One" }] }),
			field("email", { schema: { type: "string", format: "email" } }),
		])
		expect(validate(source, { ...source.values, additionalFields: { agree: false, choice: "two", email: "" } })).toHaveProperty("issues")
		expect(validate(source, { ...source.values, additionalFields: { agree: true, choice: "one", email: "" } })).toHaveProperty("value")
	})
	it.each([
		{ unknownKeyword: true },
		{ type: "bogus" },
		{ format: "unknown" },
		{ $ref: "https://missing.test/schema" },
		{ $schema: "https://json-schema.org/draft/2020-12/schema" },
		{ $async: true },
		{ minLength: "invalid" },
	])("diagnoses malformed/unsupported schemas without successful validation: %j", (schema) => {
		const source = fixtures([field("ref", { schema: schema as FieldSchema })])
		expect(resolveCheckoutFields(source, source.values).unsupported[0]?.reason).toBe("invalid-schema")
		expect(validate(source)).toHaveProperty("issues")
	})
	it("diagnoses missing namespaces and reserved data while retaining other usable fields", () => {
		const source = fixtures([
			field("supported"),
			field("reserved", { required: condition({ cart: { properties: { extensions: { properties: { kizlo: { type: "object" } } } } } }) }),
			field("missing", {
				required: condition({ cart: { properties: { extensions: { properties: { absentPlugin: { required: ["flag"] } } } } } }),
			}),
		])
		expect(resolveCheckoutFields(source, source.values).fields.order.map((field) => field.id)).toEqual(["supported"])
		expect(resolveCheckoutFields(source, source.values).unsupported).toHaveLength(2)
		expect(validate(source)).toHaveProperty("issues")
	})
	it("reports unsupported widgets, unsafe bindings and cross-group collisions", () => {
		const fields: StorefrontField[] = [
			field("custom", { type: "custom-calendar" }),
			field("unsafe", { bindings: { other: ["__proto__", "value"] } }),
			field("first", { location: "contact", bindings: { other: ["additionalFields", "same"] } }),
			field("second", { bindings: { other: ["additionalFields", "same"] } }),
		]
		const source = fixtures(fields)
		expect(resolveCheckoutFields(source, source.values).unsupported.map((d) => d.reason)).toEqual([
			"unsupported-widget",
			"invalid-binding",
			"binding-collision",
		])
		expect(validate(source)).toHaveProperty("issues")
	})
	it("excludes hidden required fields without erasing submission values", () => {
		const source = fixtures([field("hidden", { hidden: true, required: true, schema: { const: "different" } })])
		const candidate = { ...source.values, additionalFields: { hidden: "retained" } }
		expect(validate(source, candidate)).toHaveProperty("value", candidate)
		expect(resolveCheckoutFields(source, candidate).fields.order[0]).toMatchObject({ hidden: true, required: false })
	})
	it.each(["omitted", "retained"] as const)("skips non-shipping checkout fields with %s shipping values", (mode) => {
		const source = fixtures([
			field("first_name", { location: "address", required: true, bindings: { billing: ["firstName"], shipping: ["firstName"] } }),
			field("plug/ref", {
				location: "address",
				required: true,
				bindings: { billing: ["additionalFields", "plug/ref"], shipping: ["additionalFields", "plug/ref"] },
			}),
		])
		source.cart.needsShipping = false
		const { shippingAddress, ...remaining } = source.values
		if (!shippingAddress) throw new Error("Expected fixture shipping address")
		const candidate = {
			...remaining,
			billingAddress: { ...source.checkout.billingAddress, additionalFields: { "plug/ref": "billing reference" } },
			...(mode === "retained" ? { shippingAddress: { ...shippingAddress, firstName: "", additionalFields: { "plug/ref": "" } } } : {}),
		}
		const adapter = checkoutFieldsSchema(() => source)
		expect(resolveCheckoutFields(source, candidate).fields.shipping).toEqual([])
		expect(adapter["~standard"].validate(candidate)).toEqual({ value: candidate })
		expect((adapter["~standard"].validate(candidate) as { value: unknown }).value).toBe(candidate)
		expect(
			validate(source, { ...candidate, billingAddress: { ...candidate.billingAddress, firstName: "", additionalFields: {} } }),
		).toHaveProperty("issues", expect.arrayContaining([expect.objectContaining({ path: ["billingAddress", "firstName"] })]))
		source.cart.needsShipping = true
		expect(resolveCheckoutFields(source, candidate).fields.shipping).toHaveLength(2)
		expect(adapter["~standard"].validate(candidate)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["shippingAddress", "additionalFields", "plug/ref"] })]),
		)
	})
	it.each([
		{ type: "date" },
		{ schema: { type: "string", format: "plugin-custom" } },
		{ schema: { $ref: "https://missing.test/schema" } },
		{ schema: { type: "bogus" } },
	] as Partial<StorefrontField>[])("excludes hidden widget/schema requirements until visible: %j", (overrides) => {
		const source = fixtures([
			field("hidden", {
				...overrides,
				required: true,
				hidden: condition({ customer: { properties: { billing_address: { properties: { country: { const: "IN" } } } } } }),
			}),
		])
		const candidate = { ...source.values, additionalFields: { hidden: "retained" } }
		const model = resolveCheckoutFields(source, candidate)
		expect(model.unsupported).toEqual([])
		expect(model.fields.order[0]).toMatchObject({ hidden: true, required: false, key: ["additionalFields", "hidden"], ...overrides })
		expect((validate(source, candidate) as { value: unknown }).value).toBe(candidate)
		const visible = { ...candidate, billingAddress: { ...source.checkout.billingAddress, country: "GB" } }
		expect(resolveCheckoutFields(source, visible).unsupported).toHaveLength(1)
		expect(validate(source, visible)).toHaveProperty("issues")
	})
	it("rejects a supplied optional value under a false schema while allowing omission", () => {
		const source = fixtures([field("forbidden", { schema: false })])
		expect(validate(source, { ...source.values, additionalFields: { forbidden: "" } })).toHaveProperty("issues")
		expect(validate(source, { ...source.values, additionalFields: {} })).toHaveProperty("value")
	})
	it("reports aggregate-only oneOf failures rather than accepting the candidate", () => {
		const source = fixtures([field("overlap", { schema: { oneOf: [{ type: "string" }, { type: "string" }] } })])
		expect(validate(source, { ...source.values, additionalFields: { overlap: "match" } })).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["additionalFields", "overlap"] })]),
		)
	})
	it("enforces required strings and checkboxes for array-form, referenced and composed schemas", () => {
		const source = fixtures([
			field("array", { required: true, schema: { type: ["string"] } }),
			field("composed", { required: true, schema: { allOf: [{ type: "string" }, { maxLength: 10 }] } }),
			field("check", { required: true, type: "checkbox", schema: { type: ["boolean"] } }),
		])
		expect(validate(source, { ...source.values, additionalFields: { array: " ", composed: "", check: false } })).toHaveProperty("issues")
		expect(validate(source, { ...source.values, additionalFields: { array: "ok", composed: "ok", check: true } })).toHaveProperty("value")
	})
	it("diagnoses unavailable data through references, composition and pattern-property rules", () => {
		const unknown = condition({ cart: { properties: { extensions: { properties: { absentPlugin: { required: ["flag"] } } } } } })
		const source = fixtures([
			field("ref", { required: { definitions: { rule: unknown }, $ref: "#/definitions/rule" } }),
			field("composed", { required: { allOf: [unknown] } }),
			field("pattern", { schema: { type: "object", patternProperties: { ".*": { maxLength: { $data: "/cart/missing" } } } } }),
		])
		const candidate = { ...source.values, additionalFields: { pattern: { key: "value" } } } as unknown as CheckoutFieldValues
		expect(resolveCheckoutFields(source, candidate).unsupported).toHaveLength(3)
		expect(validate(source, candidate)).toHaveProperty("issues")
	})
	it("supports condition references and shorthand with current payment/account controls", () => {
		const source = fixtures([
			field("ref", {
				required: {
					definitions: {
						rule: { properties: { checkout: { properties: { create_account: { const: true }, payment_method: { const: "card" } } } } },
					},
					$ref: "#/definitions/rule",
				},
			}),
			field("shorthand", { required: { checkout: { properties: { create_account: { const: true } } } } }),
		])
		expect(resolveCheckoutFields(source, source.values).fields.order.every((field) => !field.required)).toBe(true)
		const candidate = { ...source.values, createAccount: true, paymentMethod: "card", additionalFields: {} }
		expect(resolveCheckoutFields(source, candidate).fields.order.every((field) => field.required)).toBe(true)
		expect(validate(source, candidate)).toHaveProperty("issues")
	})
	it("rejects invalid group/control shapes and unbound field requirements", () => {
		const source = fixtures([field("unbound", { bindings: {}, required: true })])
		expect(resolveCheckoutFields(source, source.values).unsupported[0]?.reason).toBe("invalid-binding")
		expect(validate(source)).toHaveProperty("issues")
		for (const candidate of [{ additionalFields: [] }, { billingAddress: null }, { createAccount: "false" }, { paymentMethod: 42 }])
			expect(checkoutFieldsSchema(() => fixtures([]))["~standard"].validate(candidate)).toHaveProperty("issues")
	})
	it("rejects unavailable sources and invalid candidates", () => {
		const source = fixtures()
		expect(checkoutFieldsSchema(() => ({ ...source, cart: null }))["~standard"].validate(source.values)).toHaveProperty("issues")
		for (const candidate of [null, [], "text"])
			expect(checkoutFieldsSchema(() => source)["~standard"].validate(candidate)).toHaveProperty("issues")
	})
	it("keeps formats and schema compilation separate from frozen document values", () => {
		const schema = freeze(valueSchema({ type: "string", format: "email" }, ["customer", "billing_address", "email"], true))
		expect(compileCheckoutSchema(schema)({ customer: { billing_address: { email: "ada@example.com" } } })).toBe(true)
		expect(compileCheckoutSchema(schema)({ customer: { billing_address: { email: "a..b@example.com" } } })).toBe(false)
	})
})
