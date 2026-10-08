import { describe, expect, it } from "vitest"
import { projectCheckoutAddresses } from "./checkout-address"
import { checkoutFieldProps } from "./checkout-field-bindings"
import {
	canShareCheckoutAddress,
	checkoutFormDecode,
	checkoutFormEncode,
	checkoutFormName,
	checkoutFormSchema,
	checkoutShippingToBillingUpdates,
	resolveCheckoutForm,
} from "./checkout-form"
import { field, fixtures } from "./test/checkout-fields-fixture"
import type { CheckoutFieldValues, CheckoutFormValues } from "./types"

const native = (id: string, input: string, overrides: Parameters<typeof field>[1] = {}) =>
	field(id, {
		location: "address",
		bindings: { billing: [input], shipping: [input] },
		...overrides,
	})
function schema(source: ReturnType<typeof fixtures>) {
	return checkoutFormSchema(() => source)["~standard"]
}

function projectedAddresses(source: ReturnType<typeof fixtures>, values: CheckoutFormValues) {
	return projectCheckoutAddresses(source, checkoutFormDecode(values), values.useShippingAsBilling)
}

describe("checkout form representation", () => {
	it("round-trips opaque IDs at every additional-fields root while preserving native paths and extensions", () => {
		const ids = ["plugin/a.b[0]'%", 'plugin/"quoted"', "a.b", "a%2Eb", "a/b", "a%2Fb", "percent%25", "unicode/नमस्ते"]
		const extra = Object.fromEntries(ids.map((id, index) => [id, String(index)]))
		const source = fixtures(ids.map((id) => field(id)))
		const raw = {
			...source.values,
			additionalFields: extra,
			billingAddress: { ...source.checkout.billingAddress, additionalFields: extra },
			shippingAddress: { ...source.checkout.shippingAddress, additionalFields: extra },
			extensions: { plugin: { "a.b": [false, 0] } },
		} as CheckoutFieldValues
		const input = checkoutFormEncode(Object.freeze(raw))
		expect(input.additionalFields).toHaveProperty("plugin%2Fa%2Eb%5B0%5D%27%25", "0")
		expect(Object.keys(input.additionalFields ?? {})).toHaveLength(ids.length)
		expect(checkoutFormDecode(input)).toEqual(raw)
		expect(checkoutFormName(["billingAddress", "country"])).toBe("billingAddress.country")
		expect(checkoutFormName(["shippingAddress", "additionalFields", ids[0] ?? ""])).toBe(
			"shippingAddress.additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25",
		)
		expect(input.extensions).toEqual(raw.extensions)
		expect(raw.additionalFields).toEqual(extra)
	})
	it("maps validation errors to the same safe paths and returns the supplied form representation", () => {
		const id = "plugin/a.b[0]'%"
		const source = fixtures([field(id, { required: true })])
		const input = checkoutFormEncode({ ...source.values, additionalFields: { [id]: "" } })
		expect(schema(source).validate(input)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["additionalFields", "plugin%2Fa%2Eb%5B0%5D%27%25"] })]),
		)
		const candidate = checkoutFormEncode({ ...source.values, additionalFields: { [id]: "complete" } })
		expect(schema(source).validate(candidate)).toEqual({ value: candidate })
		expect((schema(source).validate(candidate) as { value: unknown }).value).toBe(candidate)
	})
	it("decodes registered bindings for conditions and keeps hidden values in output", () => {
		const id = "plugin/a.b"
		const source = fixtures([
			field(id),
			field("dependent", {
				hidden: {
					properties: { checkout: { properties: { additional_fields: { properties: { [id]: { const: "hide" } }, required: [id] } } } },
				},
			}),
		])
		const values = checkoutFormEncode({ ...source.values, additionalFields: { [id]: "hide", dependent: "stored" } })
		expect(resolveCheckoutForm(source, values).fields.order[1]).toMatchObject({ hidden: true })
		expect(projectedAddresses(source, values).additionalFields).toEqual({ [id]: "hide", dependent: "stored" })
	})
	it("preserves form controls, unrelated members and custom root bindings when decoding", () => {
		const source = fixtures([field("note", { bindings: { other: ["customRoot", "note"] } })])
		const values = { ...checkoutFormEncode(source.values), useShippingAsBilling: false, unrelated: "ignore", customRoot: { note: "bound" } }
		const output = checkoutFormDecode(values)
		expect(output).toHaveProperty("useShippingAsBilling", false)
		expect(output).toHaveProperty("unrelated", "ignore")
		expect(output).toHaveProperty("customRoot.note", "bound")
	})
	it("rejects collisions and invalid controls without modifying a candidate", () => {
		const source = fixtures()
		const values = { additionalFields: { "a.b": "one", "a%2Eb": "two" } }
		expect(schema(source).validate(values)).toHaveProperty("issues")
		expect(() => checkoutFormDecode(values)).toThrow("Colliding")
		expect(schema(source).validate({ useShippingAsBilling: "yes" })).toHaveProperty("issues.0.path", ["useShippingAsBilling"])
		expect(schema(source).validate(null)).toHaveProperty("issues")
		expect(schema(source).validate({ billingAddress: [], useShippingAsBilling: true })).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["billingAddress"] })]),
		)
		expect(schema(source).validate({ billingAddress: { additionalFields: [] } })).toHaveProperty("issues.0.path", [
			"billingAddress",
			"additionalFields",
		])
	})
})

describe("shipping-to-billing form copy", () => {
	it("copies all native leaves without changing the draft, sharing or independent billing data", () => {
		const values: CheckoutFormValues = {
			shippingAddress: {
				firstName: "Grace",
				lastName: "Hopper",
				company: "Navy",
				address1: "1 Road",
				address2: "Suite 2",
				city: "London",
				state: "County",
				postcode: "SW1A 1AA",
				country: "GB",
				phone: "123",
				additionalFields: { shipping: "private" },
			},
			billingAddress: {
				...fixtures([]).checkout.billingAddress,
				email: "billing@example.com",
				taxId: "TAX",
				additionalFields: { billing: "retain" },
			},
			useShippingAsBilling: false,
		}
		const before = structuredClone(values)
		const updates = checkoutShippingToBillingUpdates(values)
		expect(Object.fromEntries(updates.map(({ name, value }) => [name, value]))).toEqual({
			"billingAddress.firstName": "Grace",
			"billingAddress.lastName": "Hopper",
			"billingAddress.company": "Navy",
			"billingAddress.address1": "1 Road",
			"billingAddress.address2": "Suite 2",
			"billingAddress.city": "London",
			"billingAddress.state": "County",
			"billingAddress.postcode": "SW1A 1AA",
			"billingAddress.country": "GB",
			"billingAddress.phone": "123",
		})
		expect(updates.every(({ options }) => !options.runListeners && options.meta === "update" && !options.validate)).toBe(true)
		expect(values).toEqual(before)
	})
	it("clears stale target members missing from shipping and skips unchanged values", () => {
		expect(
			checkoutShippingToBillingUpdates({
				shippingAddress: { country: "IN", state: "KA" },
				billingAddress: { country: "GB", state: "KA", postcode: "STALE" },
			} as CheckoutFormValues).map(({ name, value }) => ({ name, value })),
		).toEqual([
			{ name: "billingAddress.postcode", value: undefined },
			{ name: "billingAddress.country", value: "IN" },
		])
		expect(
			checkoutShippingToBillingUpdates({ shippingAddress: { country: "IN" }, billingAddress: { country: "IN" } } as CheckoutFormValues),
		).toEqual([])
	})
	it.each([undefined, {}, { shippingAddress: null }])("requires source data instead of manufacturing an address: %j", (values) => {
		expect(() => checkoutShippingToBillingUpdates(values as CheckoutFormValues | undefined)).toThrow("requires a shipping address")
	})
})

describe("address presentation and projection", () => {
	it("derives physical shipping from a billing-only forced form without copying contact or registered values", () => {
		const source = fixtures([native("first_name", "firstName", { required: true }), native("country", "country")])
		source.storefront.checkout.forcedBillingAddress = true
		const values = Object.freeze({
			billingAddress: { ...source.checkout.billingAddress, additionalFields: { billing: "private" } },
			paymentMethod: "",
		})
		const before = structuredClone(values)
		const output = projectedAddresses(source, values)
		expect(output.billingAddress).toEqual(values.billingAddress)
		expect(output.shippingAddress).toMatchObject({ firstName: "Ada", country: "IN", postcode: "560001" })
		expect(output.shippingAddress).not.toHaveProperty("additionalFields")
		for (const key of ["email", "taxId"]) expect(output.shippingAddress).not.toHaveProperty(key)
		expect(resolveCheckoutForm(source, values).fields.shipping.every((field) => field.hidden)).toBe(true)
		expect(resolveCheckoutForm(source, values).fields.billing.every((field) => !field.hidden)).toBe(true)
		expect(schema(source).validate(values)).toEqual({ value: values })
		expect(values).toEqual(before)
	})
	it("overrides stale hidden native values but keeps both additional-field buckets independent", () => {
		const source = fixtures([native("first_name", "firstName"), native("country", "country")])
		source.storefront.checkout.forcedBillingAddress = true
		const values = {
			paymentMethod: "",
			billingAddress: { ...source.checkout.billingAddress, additionalFields: { billing: "one" } },
			shippingAddress: { ...source.checkout.shippingAddress, firstName: "Stale", additionalFields: { shipping: "two" } },
			useShippingAsBilling: false,
		}
		const before = structuredClone(values)
		expect(projectedAddresses(source, values)).toMatchObject({
			billingAddress: { country: "IN", email: "ada@example.com", taxId: "TAX", additionalFields: { billing: "one" } },
			shippingAddress: { firstName: "Ada", country: "IN", additionalFields: { shipping: "two" } },
		})
		expect(values).toEqual(before)
	})
	it.each([undefined, null])("diagnoses an unavailable authoritative address (%s) rather than using stale shipping", (missing) => {
		const source = fixtures([native("first_name", "firstName", { required: true })])
		source.storefront.checkout.forcedBillingAddress = true
		const values = { billingAddress: missing, shippingAddress: source.checkout.shippingAddress } as unknown as CheckoutFormValues
		expect(schema(source).validate(values)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["billingAddress"] })]),
		)
		expect(checkoutFormDecode(values)).toEqual(values)
		expect(resolveCheckoutForm(source, values).unsupported).toContainEqual(expect.objectContaining({ path: ["billingAddress"] }))
	})
	it("keeps incomplete native drafts renderable and maps structural issues to the visible billing field", () => {
		const source = fixtures([native("first_name", "firstName", { required: true })])
		source.storefront.checkout.forcedBillingAddress = true
		const { firstName: _firstName, ...billingAddress } = source.checkout.billingAddress
		const values = { billingAddress, shippingAddress: source.checkout.shippingAddress, paymentMethod: "" }
		expect(resolveCheckoutForm(source, values).unsupported).toEqual([])
		expect(checkoutFormDecode(values)).toEqual(values)
		expect(schema(source).validate(values)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["billingAddress", "firstName"] })]),
		)
		const withNullTarget = {
			billingAddress: source.checkout.billingAddress,
			shippingAddress: null,
			paymentMethod: "",
		} as unknown as CheckoutFormValues
		expect(schema(source).validate(withNullTarget)).toEqual({ value: withNullTarget })
	})
	it("reports missing required hidden submission members without adding field metadata diagnostics", () => {
		const source = fixtures([
			native("first_name", "firstName"),
			field("custom/id", { location: "address", required: true, bindings: { shipping: ["additionalFields", "custom/id"] } }),
		])
		source.storefront.checkout.forcedBillingAddress = true
		const values = {
			billingAddress: { ...source.checkout.billingAddress, additionalFields: { "custom%2Fid": "billing" } },
			paymentMethod: "",
		}
		expect(resolveCheckoutForm(source, values).fields.shipping.every((field) => field.hidden)).toBe(true)
		expect(schema(source).validate(values)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["shippingAddress", "additionalFields", "custom%2Fid"] })]),
		)
		expect(resolveCheckoutForm(source, values).unsupported).toEqual([])
		expect(checkoutFormDecode(values)).not.toHaveProperty("shippingAddress")
		const complete = {
			...values,
			shippingAddress: { ...source.checkout.shippingAddress, additionalFields: { "custom%2Fid": "shipping" } },
		}
		expect(projectedAddresses(source, complete).shippingAddress?.additionalFields).toEqual({ "custom/id": "shipping" })
		expect(schema(source).validate(complete)).toEqual({ value: complete })
	})
	it.each([
		{ type: "text" as const, schema: { type: "string", pattern: "^OK$" }, value: "bad" },
		{ type: "checkbox" as const, schema: { type: "boolean" }, value: false },
	])("keeps invalid hidden $type values for the form's schema to reject", ({ type, schema: constraints, value }) => {
		const source = fixtures([
			field("custom/id", {
				location: "address",
				required: true,
				type,
				schema: constraints,
				bindings: { shipping: ["additionalFields", "custom/id"] },
			}),
		])
		source.storefront.checkout.forcedBillingAddress = true
		const values = {
			paymentMethod: "",
			billingAddress: source.checkout.billingAddress,
			shippingAddress: { ...source.checkout.shippingAddress, additionalFields: { "custom%2Fid": value } },
		}
		const model = resolveCheckoutForm(source, values)
		expect(model.fields.shipping[0]).toMatchObject({ hidden: true, required: true })
		expect(model.unsupported).toEqual([])
		expect(projectedAddresses(source, values).shippingAddress?.additionalFields).toEqual({ "custom/id": value })
		expect(schema(source).validate(values)).toHaveProperty(
			"issues",
			expect.arrayContaining([expect.objectContaining({ path: ["shippingAddress", "additionalFields", "custom%2Fid"] })]),
		)
	})
	it("defaults to shipping-first despite distinct saved billing values, and honors explicit separate billing", () => {
		const source = fixtures([native("country", "country"), native("first_name", "firstName")])
		source.storefront.checkout.forcedBillingAddress = false
		const values = checkoutFormEncode(source.values)
		expect(resolveCheckoutForm(source, values).fields.billing.every((field) => field.hidden)).toBe(true)
		expect(projectedAddresses(source, values).billingAddress?.country).toBe("GB")
		const separate = { ...values, useShippingAsBilling: false }
		expect(resolveCheckoutForm(source, separate).fields.billing.every((field) => !field.hidden)).toBe(true)
		expect(projectedAddresses(source, separate).billingAddress?.country).toBe("IN")
		expect(projectedAddresses(source, separate).shippingAddress?.country).toBe("GB")
	})
	it("shows billing and omits digital shipping even with forced billing and a sharing control", () => {
		const source = fixtures([native("country", "country")])
		source.storefront.checkout.forcedBillingAddress = true
		source.cart.needsShipping = false
		const values = { ...checkoutFormEncode(source.values), useShippingAsBilling: true }
		expect(resolveCheckoutForm(source, values).fields.shipping).toEqual([])
		expect(resolveCheckoutForm(source, values).fields.billing[0]?.hidden).toBe(false)
		expect(projectedAddresses(source, values)).not.toHaveProperty("shippingAddress")
		expect(projectedAddresses(source, values).billingAddress).toEqual(source.values.billingAddress)
	})
	it("copies only common native members and preserves independent fields, billing email and Tax ID", () => {
		const source = fixtures([
			native("first_name", "firstName", { required: true }),
			native("country", "country"),
			field("email", { location: "contact", bindings: { other: ["billingAddress", "email"] } }),
			field("kizlo/tax-id", { location: "address", bindings: { billing: ["taxId"] } }),
			native("custom/a.b", "additionalFields", {
				bindings: { billing: ["additionalFields", "custom/a.b"], shipping: ["additionalFields", "custom/a.b"] },
			}),
		])
		const values: CheckoutFormValues = {
			...checkoutFormEncode(source.values),
			useShippingAsBilling: true,
			billingAddress: { ...source.checkout.billingAddress, additionalFields: { "custom%2Fa%2Eb": "billing" } },
			shippingAddress: {
				...source.checkout.shippingAddress,
				firstName: "Grace",
				country: "IN",
				additionalFields: { "custom%2Fa%2Eb": "shipping" },
			},
		}
		const before = structuredClone(values)
		expect(canShareCheckoutAddress(source)).toBe(true)
		const model = resolveCheckoutForm(source, values)
		expect(model.fields.billing.find((f) => f.id === "first_name")?.hidden).toBe(true)
		expect(model.fields.billing.find((f) => f.id === "custom/a.b")?.hidden).toBe(false)
		expect(model.fields.billing.find((f) => f.id === "kizlo/tax-id")?.hidden).toBe(false)
		const output = projectedAddresses(source, values)
		expect(output.billingAddress).toMatchObject({
			firstName: "Grace",
			country: "IN",
			email: "ada@example.com",
			taxId: "TAX",
			additionalFields: { "custom/a.b": "billing" },
		})
		expect(output.shippingAddress?.additionalFields).toEqual({ "custom/a.b": "shipping" })
		expect(schema(source).validate(values)).toEqual({ value: values })
		expect(values).toEqual(before)
	})
	it("validates copied billing constraints and targets the editable shipping control", () => {
		const source = fixtures([native("first_name", "firstName", { required: true })])
		const values = {
			...checkoutFormEncode(source.values),
			useShippingAsBilling: true,
			shippingAddress: { ...source.checkout.shippingAddress, firstName: "" },
		}
		const result = schema(source).validate(values)
		expect(result).toHaveProperty("issues", expect.arrayContaining([expect.objectContaining({ path: ["shippingAddress", "firstName"] })]))
		expect(values.billingAddress?.firstName).toBe("Ada")
	})
	it.each(["shipping-free", "forced-billing"] as const)("disables sharing for %s while retaining editable billing values", (scenario) => {
		const source = fixtures([native("first_name", "firstName", { required: true })])
		if (scenario === "shipping-free") source.cart.needsShipping = false
		else source.storefront.checkout.forcedBillingAddress = true
		const values = {
			...checkoutFormEncode(source.values),
			useShippingAsBilling: true,
			shippingAddress: { ...source.checkout.shippingAddress, firstName: "Grace" },
		}
		expect(canShareCheckoutAddress(source)).toBe(false)
		expect(resolveCheckoutForm(source, values).fields.billing[0]?.hidden).toBe(false)
		expect(projectedAddresses(source, values).billingAddress?.firstName).toBe("Ada")
		if (scenario === "shipping-free") {
			expect(resolveCheckoutForm(source, values).fields.shipping).toEqual([])
			expect(projectedAddresses(source, values)).not.toHaveProperty("shippingAddress")
		}
	})
	it("resolves copied locale/options and independent candidate countries", () => {
		const source = fixtures([native("country", "country"), native("state", "state")])
		const values = {
			...checkoutFormEncode(source.values),
			useShippingAsBilling: true,
			shippingAddress: { ...source.checkout.shippingAddress, country: "IN", state: "KA" },
		}
		expect(resolveCheckoutForm(source, values).fields.billing[1]).toMatchObject({
			hidden: true,
			type: "select",
			options: [{ value: "KA", label: "Karnataka" }],
		})
		const prefilled = {
			...values,
			useShippingAsBilling: false,
			billingAddress: { ...source.checkout.billingAddress, country: "GB", state: "London" },
		}
		expect(resolveCheckoutForm(source, prefilled).fields.billing[1]).toMatchObject({ hidden: false, type: "text", label: "County" })
	})
})

describe("native field bindings", () => {
	it.each(["text", "select", "textarea", "checkbox", "number"])(
		"normalizes %s edits and protects controlled/accessibility props",
		(type) => {
			const source = fixtures([
				field("plugin/a.b", {
					type,
					schema: { type: type === "number" ? "number" : type === "checkbox" ? "boolean" : "string" },
					required: true,
					autocomplete: "name",
					attributes: {
						name: "wrong",
						id: "wrong",
						value: "wrong",
						checked: false,
						onChange: "wrong",
						required: false,
						min: 1,
						disabled: false,
					},
				}),
			])
			const resolved = resolveCheckoutForm(source).fields.order[0]
			if (!resolved) throw new Error("Missing field")
			const edits: unknown[] = []
			const control = checkoutFieldProps(resolved, checkoutFormName(resolved.key), {
				value: undefined,
				onValueChange: (value) => edits.push(value),
				invalid: true,
			})
			expect(control.props).toMatchObject({
				name: "additionalFields.plugin%2Fa%2Eb",
				id: "checkout-additionalFields.plugin%2Fa%2Eb",
				required: true,
				autoComplete: "name",
				"aria-invalid": true,
				"aria-describedby": control.errorId,
				min: 1,
			})
			// Model the native currentTarget without mounting a form library.
			control.props.onChange({ currentTarget: { value: "7", valueAsNumber: 7, checked: true } } as {
				currentTarget: HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement
			})
			expect(edits).toEqual([type === "number" ? 7 : type === "checkbox" ? true : "7"])
			if (control.kind === "input" && type === "checkbox") {
				expect(control.props.checked).toBe(false)
				expect(control.props).not.toHaveProperty("value")
			}
			if (control.kind === "input" && type === "number") {
				control.props.onChange({ currentTarget: { value: "" } } as {
					currentTarget: HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement
				})
				expect(edits[1]).toBeUndefined()
			}
		},
	)
	it("keeps number widgets with string contracts as strings and forwards blur once", () => {
		const resolved = resolveCheckoutForm(fixtures([field("number-text", { type: "number", schema: { type: "string" } })])).fields.order[0]
		if (!resolved) throw new Error("Missing field")
		const edits: unknown[] = []
		let blurs = 0
		const control = checkoutFieldProps(resolved, checkoutFormName(resolved.key), {
			value: "12",
			onValueChange: (value) => edits.push(value),
			onBlur: () => {
				blurs++
			},
		})
		control.props.onChange({ currentTarget: { value: "14", valueAsNumber: 14 } } as {
			currentTarget: HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement
		})
		control.props.onBlur?.()
		expect(edits).toEqual(["14"])
		expect(blurs).toBe(1)
		expect(control.props["aria-describedby"]).toBeUndefined()
	})
})
