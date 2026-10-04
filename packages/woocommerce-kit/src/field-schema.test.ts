import { describe, expect, it } from "vitest"
import { evaluateFieldRule } from "./field-rules"
import { compileFieldSchema, toStandardSchema } from "./field-schema"
import type { FieldSchema } from "./types"

function validate(schema: FieldSchema, value: unknown) {
	return toStandardSchema(schema)["~standard"].validate(value)
}

describe("draft-07 validation", () => {
	for (const [name, schema, accepted, refused] of [
		["email", { type: "string", format: "email" }, "john@example.com", "bad"],
		["string length", { type: "string", minLength: 2, maxLength: 3 }, "AB", "ABCD"],
		["Unicode length", { type: "string", minLength: 2 }, "😀😀", "😀"],
		["Unicode pattern", { type: "string", pattern: "^.$" }, "😀", "AB"],
		["number", { type: "number", minimum: 0, multipleOf: 2 }, 4, 3],
		["nonblank string", { type: "string", pattern: "\\S" }, "A", "  "],
		["enum", { enum: ["A", "B"] }, "A", "C"],
		["checkbox const", { const: true }, true, false],
		// biome-ignore lint/suspicious/noThenProperty: JSON Schema uses then as a conditional keyword.
		["conditional", { if: { const: "IN" }, then: { pattern: "^I" }, else: { pattern: "^G" } }, "GB", "US"],
		["not", { not: { const: "IN" } }, "GB", "IN"],
		["oneOf", { oneOf: [{ const: "IN" }, { const: "GB" }] }, "IN", "US"],
		["allOf", { allOf: [{ minLength: 2 }, { pattern: "^A" }] }, "AB", "A"],
		["anyOf", { anyOf: [{ const: "" }, { format: "email" }] }, "", "bad"],
		["array", { type: "array", items: { type: "string" }, minItems: 1 }, ["A"], [1]],
	] as const)
		it(`validates ${name}`, () => {
			expect(validate(schema, accepted)).toEqual({ value: accepted })
			expect(validate(schema, refused)).toHaveProperty("issues")
		})
})

describe("unsupported schema configuration", () => {
	for (const [name, schema] of [
		["unknown keyword", { madeUp: true }],
		["nested unknown keyword", { allOf: [{ madeUp: true }] }],
		["negative length", { minLength: -1 }],
		["invalid required", { required: "email" }],
		["nested invalid pattern", { properties: { tax: { pattern: "[" } } }],
		["invalid pattern property", { patternProperties: { "[": { type: "string" } } }],
		["empty composition", { anyOf: [] }],
		["unknown format", { type: "string", format: "plugin-format" }],
		["async schema", { $async: true, type: "string" }],
		["missing local reference", { $ref: "#/definitions/missing" }],
		["remote reference", { $ref: "https://example.com/schema" }],
		["unsupported draft", { $schema: "https://json-schema.org/draft/2020-12/schema" }],
		["invalid definition", { $defs: { value: { minLength: -1 } } }],
	] as const)
		it(`degrades safely for ${name}`, () => {
			expect(compileFieldSchema(schema)).toBeUndefined()
			const values = { firstName: "John" }
			expect(validate(schema, values)).toEqual({ value: values })
		})
})

it("preserves frozen schema snapshots including non-enumerable own properties", () => {
	const schema = Object.freeze({ type: "object", properties: Object.freeze({ value: Object.freeze({ type: "string" }) }) })
	expect(validate(schema, { value: "A" })).toHaveProperty("value")
	expect(validate(schema, { value: false })).toHaveProperty("issues")
	expect(Reflect.ownKeys(schema)).toEqual(["type", "properties"])
	expect(Reflect.ownKeys(schema.properties.value)).toEqual(["type"])
})

it("treats undefined object values as missing without changing submitted values", () => {
	const input = { firstName: undefined, additionalFields: { "plug/a.b[0]": "A" } }
	const schema = { type: "object", properties: { firstName: { type: "string" } } }
	const optional = validate(schema, input)
	expect("value" in optional && optional.value).toBe(input)
	const required = validate({ ...schema, required: ["firstName"] }, input)
	expect("issues" in required && required.issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(["firstName"]))).toBe(true)
	expect(Object.hasOwn(input, "firstName")).toBe(true)
	expect(input.additionalFields["plug/a.b[0]"]).toBe("A")
})

it("returns all missing literal field paths without parsing error messages", () => {
	const ids = ["plug/a.b[0]", 'plug/a"quote', "plug/%C3%A9", "plug/ü~[]", "plug/a\nline"]
	const schema = { type: "object", properties: { additionalFields: { type: "object", required: ids } } }
	const result = validate(schema, { additionalFields: {} })
	expect("issues" in result && result.issues.map((issue) => issue.path)).toEqual(ids.map((id) => ["additionalFields", id]))
})

it("preserves URI-looking text and Unicode in literal issue paths", () => {
	const id = "plug/a%2Fb é~[]"
	const schema = { type: "object", properties: { additionalFields: { type: "object", properties: { [id]: { maxLength: 1 } } } } }
	const result = validate(schema, { additionalFields: { [id]: "long" } })
	expect("issues" in result && result.issues.map((issue) => issue.path)).toEqual([["additionalFields", id]])
})

it("returns literal missing paths through local schema references", () => {
	for (const definitions of ["definitions", "$defs"]) {
		const id = 'plug/a"b.c[0]'
		const schema = {
			[definitions]: { address: { type: "object", required: [id], properties: { [id]: { type: "string" } } } },
			type: "object",
			properties: { additionalFields: { $ref: `#/${definitions}/address` } },
		}
		const result = validate(schema, { additionalFields: {} })
		expect("issues" in result && result.issues.map((issue) => issue.path)).toEqual([["additionalFields", id]])
		expect(validate(schema, { additionalFields: { [id]: "A" } })).toHaveProperty("value")
	}
})

it("keeps a literal $ref property distinct from a schema reference", () => {
	const schema = { type: "object", properties: { $ref: { type: "object", required: ["value"] } } }
	const result = validate(schema, { $ref: {} })
	expect("issues" in result && result.issues.map((issue) => issue.path)).toEqual([["$ref", "value"]])
})

it("returns dependency failures at the required field path", () => {
	for (const dependency of [["plug/tax"], { required: ["plug/tax"] }]) {
		const schema = { type: "object", dependencies: { email: dependency } }
		const result = validate(schema, { email: "a@example.com" })
		expect("issues" in result && result.issues.map((issue) => issue.path)).toEqual([["plug/tax"]])
		expect(validate(schema, {})).toHaveProperty("value")
		expect(validate(schema, { email: "a@example.com", "plug/tax": "A" })).toHaveProperty("value")
	}
})

it("evaluates only the selected branch using available condition data", () => {
	const rule = {
		if: { properties: { customer: { properties: { address: { properties: { country: { const: "IN" } } } } } } },
		// biome-ignore lint/suspicious/noThenProperty: JSON Schema uses then as a conditional keyword.
		then: { properties: { customer: { properties: { address: { required: ["email"] } } } } },
		else: { properties: { cart: { properties: { needs_shipping: { const: true } } } } },
	}
	expect(
		evaluateFieldRule(rule, {
			value: { customer: { address: { country: "IN", email: "" } } },
			complete: new Set([JSON.stringify(["customer", "address"])]),
		}),
	).toBe(true)
	expect(
		evaluateFieldRule(rule, {
			value: { customer: { address: { country: "GB" } } },
			complete: new Set([JSON.stringify(["customer", "address"])]),
		}),
	).toBeUndefined()
})

it("rejects invalid non-JSON values without throwing or silently accepting them", () => {
	for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol("value"), [undefined]])
		expect(validate({ type: "string" }, value)).toHaveProperty("issues")
	const cycle: Record<string, unknown> = {}
	cycle.self = cycle
	expect(() => validate({ type: "object" }, cycle)).not.toThrow()
	expect(validate({ type: "object" }, cycle)).toHaveProperty("issues")
})

it("returns the original object and applies no defaults or coercion", () => {
	const input = { flag: "true" }
	expect(validate({ type: "object", properties: { flag: { type: "boolean" } } }, input)).toHaveProperty("issues")
	expect(input.flag).toBe("true")
	const empty = {}
	const result = validate({ type: "object", properties: { flag: { type: "boolean", default: true } } }, empty)
	expect("value" in result && result.value).toBe(empty)
	expect(empty).toEqual({})
})
