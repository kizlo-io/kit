import { describe, expect, it } from "vitest"
import { toStandardSchema } from "./field-schema"
import { resolveBillingAddressFields, resolveContactFields, resolveOrderFields, resolveShippingAddressFields } from "./fields"
import type { FieldSchema, Storefront, StorefrontField } from "./types"

function field(id: string, overrides: Partial<StorefrontField> = {}): StorefrontField {
	return {
		id,
		location: "address",
		label: id,
		optionalLabel: id,
		required: false,
		hidden: false,
		type: "text",
		autocomplete: null,
		index: null,
		placeholder: null,
		options: [],
		attributes: {},
		schema: { type: "string" },
		bindings: { billing: ["additionalFields", id], shipping: ["additionalFields", id] },
		...overrides,
	}
}
const emailCondition = { type: "object", properties: { customer: { properties: { address: { required: ["email"] } } } } }
const fields: StorefrontField[] = [
	field("first_name", { required: true, index: 10, bindings: { billing: ["firstName"], shipping: ["firstName"] } }),
	field("last_name", { index: 20, bindings: { billing: ["lastName"], shipping: ["lastName"] } }),
	field("country", { required: true, index: 40, bindings: { billing: ["country"], shipping: ["country"] } }),
	field("state", { required: true, index: 80, bindings: { billing: ["state"], shipping: ["state"] } }),
	field("postcode", { required: true, index: 90, bindings: { billing: ["postcode"], shipping: ["postcode"] } }),
	field("email", { location: "contact", schema: { type: "string", format: "email" }, bindings: { other: ["billingAddress", "email"] } }),
	field("kizlo/tax-id", {
		required: emailCondition,
		hidden: { type: "object", properties: { customer: { properties: { address: { not: { required: ["email"] } } } } } },
		bindings: { billing: ["taxId"] },
	}),
	field("plug/a.b[0]", { schema: { type: "string", maxLength: 3 } }),
	field("plug/consent", {
		location: "contact",
		type: "checkbox",
		required: true,
		schema: { type: "boolean" },
		bindings: { other: ["additionalFields", "plug/consent"] },
	}),
	field("plug/order", { location: "order", bindings: { other: ["additionalFields", "plug/order"] } }),
]
const countries: Storefront["address"]["countries"] = [
	{
		code: "IN",
		name: "India",
		allowBilling: true,
		allowShipping: true,
		states: [{ code: "KA", name: "Karnataka" }],
		locale: { postcode: { label: "PIN code", index: 65 } },
		format: "",
	},
	{
		code: "GB",
		name: "United Kingdom",
		allowBilling: true,
		allowShipping: false,
		states: [],
		locale: { state: { label: "County", required: false } },
		format: "",
	},
	{
		code: "AE",
		name: "UAE",
		allowBilling: true,
		allowShipping: true,
		states: [],
		locale: { postcode: { hidden: true, required: false }, state: { required: false } },
		format: "",
	},
]
const values = {
	firstName: "Ada",
	lastName: "Lovelace",
	country: "IN",
	state: "KA",
	postcode: "560001",
	email: "",
	taxId: "ABC",
	additionalFields: { "plug/a.b[0]": "XYZ" },
}
function billing(extra: Parameters<typeof resolveBillingAddressFields>[0] extends infer T ? Partial<T> : never = {}) {
	return resolveBillingAddressFields({ fields, countries, values, ...extra })
}
function valid(schema: FieldSchema, value: unknown) {
	return toStandardSchema(schema)["~standard"].validate(value)
}

it("binds core, projected and literal IDs directly to the API shape", () => {
	const result = billing()
	expect(result.fields.find((field) => field.id === "first_name")?.key).toEqual(["firstName"])
	expect(result.fields.find((field) => field.id === "kizlo/tax-id")).toMatchObject({ key: ["taxId"], required: true, hidden: false })
	expect(result.fields.find((field) => field.id === "plug/a.b[0]")?.key).toEqual(["additionalFields", "plug/a.b[0]"])
	expect(valid(result.schema, values)).toEqual({ value: values })
})
it("applies country labels, order, state choices and billing/shipping choices", () => {
	expect(billing().fields.find((field) => field.id === "postcode")).toMatchObject({ label: "PIN code", index: 65 })
	expect(billing().fields.find((field) => field.id === "state")).toMatchObject({
		type: "select",
		options: [{ value: "KA", label: "Karnataka" }],
	})
	const shipping = resolveShippingAddressFields({ fields, countries, values })
	expect(shipping.fields.find((field) => field.id === "country")?.options.map((option) => option.value)).toEqual(["IN", "AE"])
	expect(shipping.fields.some((field) => field.id === "kizlo/tax-id")).toBe(false)
	expect(billing({ values: { ...values, country: "GB" } }).fields.find((field) => field.id === "state")).toMatchObject({
		label: "County",
		required: false,
		type: "text",
		options: [],
	})
	expect(billing({ values: { ...values, country: "ZZ" } }).fields.find((field) => field.id === "postcode")?.label).toBe("postcode")
})
it("presentation and prefixes change bindings and schema without mutating snapshots", () => {
	const before = JSON.stringify({ fields, countries, values })
	const result = billing({ prefix: ["billingAddress"], presentation: { first_name: { row: "name", order: 100 } } })
	expect(result.fields.findIndex((field) => field.id === "first_name")).toBeGreaterThan(
		result.fields.findIndex((field) => field.id === "last_name"),
	)
	expect(result.fields.find((field) => field.id === "first_name")?.presentation).toEqual({ row: "name", order: 100 })
	expect(valid(result.schema, { billingAddress: values })).toEqual({ value: { billingAddress: values } })
	expect(JSON.stringify({ fields, countries, values })).toBe(before)
})
it("Tax ID tests email-property presence, not a filled email", () => {
	expect(billing().fields.find((field) => field.id === "kizlo/tax-id")?.required).toBe(true)
	const { email: _email, ...withoutEmail } = values
	expect(billing({ values: withoutEmail }).fields.find((field) => field.id === "kizlo/tax-id")).toMatchObject({
		hidden: false,
		required: true,
	})
	expect(valid(billing({ values: withoutEmail }).schema, { ...withoutEmail, taxId: "" })).toHaveProperty("issues")
	const shippingTax = fields.map((field) =>
		field.id === "kizlo/tax-id" ? { ...field, bindings: { ...field.bindings, shipping: ["additionalFields", field.id] } } : field,
	)
	expect(
		resolveShippingAddressFields({ fields: shippingTax, countries, values }).fields.find((field) => field.id === "kizlo/tax-id"),
	).toMatchObject({ hidden: true, required: false })
})
it("contact and order use distinct definitions and the existing checkout bucket", () => {
	const contact = resolveContactFields({
		fields,
		values: { billingAddress: { email: "a@example.com" }, additionalFields: { "plug/consent": true } },
	})
	expect(contact.fields.map((field) => field.key)).toEqual([
		["billingAddress", "email"],
		["additionalFields", "plug/consent"],
	])
	expect(valid(contact.schema, { billingAddress: { email: "bad" }, additionalFields: { "plug/consent": false } })).toHaveProperty("issues")
	expect(resolveOrderFields({ fields, values: { additionalFields: {} } }).fields.map((field) => field.key)).toEqual([
		["additionalFields", "plug/order"],
	])
})
describe("individual plugin failures", () => {
	for (const [name, overrides] of [
		["unknown cart data", { required: { properties: { cart: { properties: { needs_shipping: { const: true } } } } } }],
		["nested required", { required: { properties: { customer: { required: ["id"] } } } }],
		["dependency", { required: { dependencies: { customer: ["cart"] } } }],
		["unsupported keyword", { schema: { madeUpKeyword: true } }],
		["invalid pattern", { schema: { type: "string", pattern: "[" } }],
		["bad binding", { bindings: { billing: ["__proto__", "polluted"] } }],
		["malformed path", { bindings: { billing: "bad" } }],
		["empty path", { bindings: { billing: [] } }],
		["unknown document count", { required: { minProperties: 3 } }],
		[
			"unknown dynamic document property",
			{ hidden: { patternProperties: { "^cart$": { properties: { needs_shipping: { const: true } } } } } },
		],
		["reference condition", { hidden: { $ref: "missing" } }],
	] as const)
		it(`skips ${name} and preserves the other fields and values`, () => {
			const plugin = field("plug/broken", overrides as Partial<StorefrontField>)
			const result = billing({ fields: [...fields, plugin] })
			expect(result.fields.some((field) => field.id === plugin.id)).toBe(false)
			expect(result.fields.some((field) => field.id === "first_name")).toBe(true)
			const supplied = { ...values, additionalFields: { ...values.additionalFields, [plugin.id]: "retained" } }
			expect(valid(result.schema, supplied)).toEqual({ value: supplied })
		})
	it("missing form values are validated rather than skipping the field", () => {
		const result = billing({ values: {} })
		expect(result.fields.some((field) => field.id === "first_name")).toBe(true)
		expect(valid(result.schema, {})).toHaveProperty("issues")
	})
	it("unfamiliar string controls fall back to text", () => {
		const result = billing({ fields: [field("plug/custom", { type: "plugin-widget" })] })
		expect(result.fields[0]?.type).toBe("text")
	})
	it("malformed binding metadata and overlapping paths cannot crash schema construction", () => {
		expect(() =>
			billing({
				fields: [
					...fields,
					field("bad", { bindings: undefined as never }),
					field("overlap", { bindings: { billing: ["additionalFields"] } }),
				],
			}),
		).not.toThrow()
	})
})
it("required strings reject blanks; optional strings accept empty select and email values", () => {
	expect(valid(billing().schema, { ...values, firstName: "   " })).toHaveProperty("issues")
	const contact = resolveContactFields({ fields, values: { billingAddress: { email: "" }, additionalFields: {} } })
	expect(valid(contact.schema, { billingAddress: { email: "" }, additionalFields: { "plug/consent": true } })).toHaveProperty("value")
	const optional = billing({ fields: [field("plug/select", { type: "select", options: [{ value: "A", label: "A" }] })] })
	expect(valid(optional.schema, { additionalFields: { "plug/select": "" } })).toHaveProperty("value")
	expect(valid(optional.schema, { additionalFields: { "plug/select": "B" } })).toHaveProperty("issues")
})
it("hidden fields impose no validation and declared patterns remain supported", () => {
	const result = billing({
		fields: [
			field("plug/hidden", { hidden: true, required: true }),
			field("plug/pattern", { schema: { type: "string", pattern: "^[A-Z]+$" } }),
		],
	})
	expect(valid(result.schema, { additionalFields: { "plug/hidden": false, "plug/pattern": "ABC" } })).toHaveProperty("value")
	expect(valid(result.schema, { additionalFields: { "plug/pattern": "123" } })).toHaveProperty("issues")
})
it("Standard Schema preserves literal issue paths including missing required values", () => {
	const result = billing({ prefix: ["billingAddress"] })
	const invalid = { billingAddress: { ...values, additionalFields: { "plug/a.b[0]": "LONG" } } }
	const errors = valid(result.schema, invalid)
	expect(
		"issues" in errors &&
			errors.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(["billingAddress", "additionalFields", "plug/a.b[0]"])),
	).toBe(true)
	const missing = valid(result.schema, { billingAddress: { ...values, firstName: undefined } })
	expect(
		"issues" in missing && missing.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(["billingAddress", "firstName"])),
	).toBe(true)
})
it("a schema factory evaluates conditions against each candidate value", () => {
	const conditional = field("plug/conditional", {
		required: {
			properties: { customer: { properties: { address: { properties: { country: { const: "IN" } }, required: ["country"] } } } },
		},
	})
	const validator = toStandardSchema<typeof values>((current) => billing({ fields: [...fields, conditional], values: current }).schema)[
		"~standard"
	]
	expect(validator.validate(values)).toHaveProperty("issues")
	expect(validator.validate({ ...values, country: "GB", state: "", taxId: "ABC" })).toHaveProperty("value")
})
it("invalid external adapter schemas also fail soft", () => {
	expect(valid({ type: "string", pattern: "[" }, "anything")).toEqual({ value: "anything" })
	expect(
		toStandardSchema(() => {
			throw new Error("bad definition")
		})["~standard"].validate(values),
	).toEqual({ value: values })
})

it("boolean JSON Schemas keep their standard validation meaning", () => {
	expect(valid(true, values)).toEqual({ value: values })
	expect(valid(false, values)).toHaveProperty("issues")
})

it("required checkbox validation rejects unchecked and missing values independently", () => {
	const contact = resolveContactFields({ fields: fields.filter((field) => field.id === "plug/consent"), values: { additionalFields: {} } })
	expect(valid(contact.schema, { additionalFields: { "plug/consent": false } })).toHaveProperty("issues")
	expect(valid(contact.schema, { additionalFields: {} })).toHaveProperty("issues")
	expect(valid(contact.schema, { additionalFields: { "plug/consent": true } })).toHaveProperty("value")
})

describe("standalone field schema composition", () => {
	it.each(["definitions", "$defs"])("preserves %s references across optional and required wrappers", (definitions) => {
		for (const required of [false, true]) {
			const schema = {
				$id: "https://example.test/shared",
				[definitions]: { value: { type: "string", minLength: 3 } },
				$ref: `#/${definitions}/value`,
			}
			const result = billing({
				fields: [
					field("first_name", { required: true, bindings: { billing: ["firstName"] } }),
					field("plug/ref", { schema, required }),
					field("plug/other", { schema, required }),
				],
				prefix: ["billingAddress"],
			})
			expect(result.fields).toHaveLength(3)
			const bad = { billingAddress: { firstName: "", additionalFields: { "plug/ref": "x", "plug/other": "x" } } }
			expect(valid(result.schema, bad)).toMatchObject({
				issues: expect.arrayContaining([
					{ message: expect.any(String), path: ["billingAddress", "firstName"] },
					{ message: expect.any(String), path: ["billingAddress", "additionalFields", "plug/ref"] },
					{ message: expect.any(String), path: ["billingAddress", "additionalFields", "plug/other"] },
				]),
			})
			expect(
				valid(result.schema, {
					billingAddress: { firstName: "Ada", additionalFields: { "plug/ref": required ? "abc" : "", "plug/other": "abc" } },
				}),
			).toHaveProperty("value")
			expect(schema.$ref).toBe(`#/${definitions}/value`)
		}
	})
	it("retains valid fields when another has a broken reference or dynamic validation", () => {
		const result = billing({
			fields: [
				field("first_name", { required: true, bindings: { billing: ["firstName"] } }),
				field("plug/broken", { schema: { $ref: "#/missing" } }),
				field("plug/dynamic", { schema: { type: "string", not: { const: { $data: "/customer/billing_address/email" } } } }),
				field("plug/rule", {
					required: {
						properties: {
							customer: { properties: { address: { properties: { country: { const: { $data: "/customer/billing_address/country" } } } } } },
						},
					},
				}),
			],
		})
		expect(result.fields.map((field) => field.id)).toEqual(["first_name"])
		expect(valid(result.schema, { firstName: "" })).toHaveProperty("issues")
	})
	it.each([
		{ type: ["string"] },
		{ allOf: [{ type: ["string"] }, { minLength: 1 }] },
		{
			anyOf: [
				{ type: "string", minLength: 1 },
				{ type: "string", format: "email" },
			],
		},
		{ definitions: { text: { type: "string" } }, $ref: "#/definitions/text" },
	] satisfies FieldSchema[])("rejects whitespace for inferred required strings: %j", (schema) => {
		const result = billing({ fields: [field("plug/text", { schema, required: true })] })
		expect(result.fields).toHaveLength(1)
		expect(valid(result.schema, { additionalFields: { "plug/text": "   " } })).toHaveProperty("issues")
	})
	it.each([{ type: ["boolean"] }, { definitions: { flag: { type: "boolean" } }, $ref: "#/definitions/flag" }] satisfies FieldSchema[])(
		"requires consent for inferred booleans: %j",
		(schema) => {
			const result = billing({ fields: [field("plug/consent", { schema, required: true, type: "checkbox" })] })
			expect(valid(result.schema, { additionalFields: { "plug/consent": false } })).toHaveProperty("issues")
			expect(valid(result.schema, { additionalFields: { "plug/consent": true } })).toHaveProperty("value")
		},
	)
	it("allows empty optional formatted array types", () => {
		const result = billing({ fields: [field("plug/email", { schema: { type: ["string"], format: "email" } })] })
		expect(valid(result.schema, { additionalFields: { "plug/email": "" } })).toHaveProperty("value")
	})
	it("reports required descendants when generated containers are missing, including serialized schemas", () => {
		const result = billing({
			prefix: ["billingAddress"],
			fields: [
				field("plug/a.b[0]", { required: true }),
				field("plug/second", { required: true }),
				field("plug/object", {
					required: true,
					schema: { type: "object", required: ["inside"], properties: { inside: { type: "string" } } },
				}),
			],
		})
		for (const values of [{}, { billingAddress: {} }]) {
			const checked = valid(JSON.parse(JSON.stringify(result.schema)), values)
			expect(checked).toHaveProperty("issues")
			if ("issues" in checked)
				expect(checked.issues?.map((issue) => issue.path)).toEqual([
					["billingAddress", "additionalFields", "plug/a.b[0]"],
					["billingAddress", "additionalFields", "plug/second"],
					["billingAddress", "additionalFields", "plug/object"],
				])
		}
		expect(
			valid(result.schema, { billingAddress: { additionalFields: { "plug/a.b[0]": "a", "plug/second": "b", "plug/object": {} } } }),
		).toMatchObject({ issues: [{ path: ["billingAddress", "additionalFields", "plug/object", "inside"] }] })
	})
})

it("rebases nested resource identifiers and boolean reference targets", () => {
	const result = billing({
		fields: [
			field("plug/nested", {
				required: true,
				schema: {
					definitions: {
						resource: { $id: "nested", definitions: { value: { type: "string", minLength: 3 } }, $ref: "#/definitions/value" },
					},
					$ref: "nested",
				},
			}),
			field("plug/never", { required: true, schema: { definitions: { impossible: false }, $ref: "#/definitions/impossible" } }),
		],
	})
	expect(result.fields).toHaveLength(2)
	expect(valid(result.schema, { additionalFields: { "plug/nested": "x", "plug/never": "x" } })).toMatchObject({
		issues: expect.arrayContaining([
			{ path: ["additionalFields", "plug/nested"], message: expect.any(String) },
			{ path: ["additionalFields", "plug/never"], message: expect.any(String) },
		]),
	})
})

it("enforces portable HTML full-match patterns and numeric lengths without changing declarative patterns", () => {
	const result = billing({
		fields: [
			field("plug/html", {
				required: true,
				schema: { allOf: [{ type: "string", maxLength: 4, pattern: "^(?:[0-9]{4})$" }, { pattern: "[0-9]{2}" }] },
			}),
		],
	})
	for (const value of ["12345", "abc1234def", "123"])
		expect(valid(result.schema, { additionalFields: { "plug/html": value } })).toHaveProperty("issues")
	expect(valid(result.schema, { additionalFields: { "plug/html": "1234" } })).toHaveProperty("value")
})
