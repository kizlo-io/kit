import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { checkoutFormDecode, checkoutFormEncode, checkoutFormSchema } from "./checkout-form"
import { field, fixtures } from "./test/checkout-fields-fixture"
import type { CheckoutFieldValues, CheckoutFormValues } from "./types"

describe("checkout field key conversion", () => {
	it.each([
		{},
		{ paymentMethod: undefined, billingAddress: undefined },
		{ billingAddress: { country: "", additionalFields: undefined }, useShippingAsBilling: true },
		{ billingAddress: null, shippingAddress: { country: "GB" }, additionalFields: { "plugin/choice": "" } },
	])("round-trips unfinished values without inserting defaults or validating: %j", (candidate) => {
		const raw = candidate as unknown as CheckoutFieldValues
		const before = structuredClone(raw)
		expect(checkoutFormDecode(checkoutFormEncode(raw))).toEqual(before)
		expect(raw).toEqual(before)
	})
	it("preserves every member and independently entered address while changing only field keys", () => {
		const raw: CheckoutFieldValues = {
			billingAddress: { country: "IN", additionalFields: { "plugin/a.b": "billing" } },
			shippingAddress: { country: "GB", additionalFields: { "plugin/a.b": "shipping" } },
			additionalFields: { "plugin/a.b": "", "plugin/check": false },
			useShippingAsBilling: true,
			paymentMethod: "",
			paymentData: [{ key: "token", value: false }],
			extensions: { plugin: { "opaque/key.name": [false, 0] } },
			successPath: "/paid",
			cancelPath: "/cancel",
		}
		const before = structuredClone(raw)
		const encoded = checkoutFormEncode(Object.freeze(raw))
		expect(encoded.billingAddress?.additionalFields).toEqual({ "plugin%2Fa%2Eb": "billing" })
		expect(encoded.shippingAddress?.additionalFields).toEqual({ "plugin%2Fa%2Eb": "shipping" })
		expect(encoded.additionalFields).toEqual({ "plugin%2Fa%2Eb": "", "plugin%2Fcheck": false })
		expect(checkoutFormDecode(encoded)).toEqual(before)
		if (encoded.billingAddress) encoded.billingAddress.country = "US"
		expect(raw).toEqual(before)
	})
	it("leaves registered answers unchanged while the form schema reports invalid selections", () => {
		const sources = fixtures([
			field("plugin/choice", {
				required: true,
				type: "select",
				schema: { type: "string", enum: ["red", "blue"] },
				options: [
					{ value: "red", label: "Red" },
					{ value: "blue", label: "Blue" },
				],
			}),
		])
		const schema = checkoutFormSchema(() => sources)["~standard"]
		for (const selection of ["", "green"]) {
			const candidate = checkoutFormEncode({ ...sources.values, additionalFields: { "plugin/choice": selection } })
			expect(checkoutFormDecode(candidate).additionalFields).toEqual({ "plugin/choice": selection })
			expect(schema.validate(candidate)).toHaveProperty(
				"issues",
				expect.arrayContaining([expect.objectContaining({ path: ["additionalFields", "plugin%2Fchoice"] })]),
			)
		}
	})
	it("keeps optional empty selections and rejects ambiguous decoded keys without mutating the form", () => {
		const encoded: CheckoutFormValues = { additionalFields: { "plugin%2Fchoice": "" } }
		expect(checkoutFormDecode(encoded)).toEqual({ additionalFields: { "plugin/choice": "" } })
		const collision = { additionalFields: { "a.b": "one", "a%2Eb": "two" } }
		const before = structuredClone(collision)
		expect(() => checkoutFormDecode(collision)).toThrow("Colliding checkout form IDs")
		expect(collision).toEqual(before)
	})
})

it("preserves introspection-registered field types across schema key conversion", () => {
	const packagePath = fileURLToPath(new URL("../", import.meta.url))
	const configPath = path.join(packagePath, "tsconfig.json")
	const config = ts.readConfigFile(configPath, ts.sys.readFile)
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packagePath, undefined, configPath)
	const program = ts.createProgram([path.join(packagePath, "test-fixtures/checkout-fields-consumer.ts")], {
		...parsed.options,
		incremental: false,
		tsBuildInfoFile: undefined,
		noEmit: true,
	})
	expect(
		[...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		),
	).toEqual([])
})
