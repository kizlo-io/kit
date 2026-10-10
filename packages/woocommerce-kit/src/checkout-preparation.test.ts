import { ConfirmCheckoutInput as sdkConfirmation } from "@kizlo/woocommerce"
import { describe, expect, it } from "vitest"
import { checkoutFormEncode } from "./checkout-form"
import { CheckoutPreparationError, prepareCheckout } from "./checkout-preparation"
import { field, fixtures } from "./test/checkout-fields-fixture"
import type { CheckoutPreparationOptions } from "./types"

function preparation(fields = fixtures()) {
	const values = checkoutFormEncode(fields.values)
	return { sources: fields, values, prepare: (options: CheckoutPreparationOptions = {}) => prepareCheckout(fields, { values, ...options }) }
}
function issues(run: () => unknown) {
	try {
		run()
	} catch (error) {
		expect(error).toBeInstanceOf(CheckoutPreparationError)
		if (error instanceof CheckoutPreparationError) return error.data.issues
	}
	throw new Error("Expected a preparation failure")
}

describe("validated checkout preparation", () => {
	it("produces a request accepted by the SDK, decodes opaque IDs and preserves independent extras", () => {
		const id = "plugin/a.b[0]'%"
		const env = preparation(fixtures([field(id, { required: true })]))
		env.values.additionalFields = { "plugin%2Fa%2Eb%5B0%5D%27%25": "answer", "removed%2Ffield": false }
		if (!env.values.billingAddress || !env.values.shippingAddress) throw new Error("Expected fixture addresses")
		env.values.billingAddress.additionalFields = { billing: "private" }
		env.values.shippingAddress.additionalFields = { shipping: true }
		const before = structuredClone(env.values)
		const result = env.prepare()
		expect(sdkConfirmation.parse(result).expectedTotal).toBe("12345")
		expect(result.additionalFields).toEqual({ [id]: "answer", "removed/field": false })
		expect(result.billingAddress).toMatchObject({
			country: "GB",
			email: "ada@example.com",
			taxId: "TAX",
			additionalFields: { billing: "private" },
		})
		expect(result.shippingAddress?.additionalFields).toEqual({ shipping: true })
		expect(result).not.toHaveProperty("useShippingAsBilling")
		expect(result.shippingAddress).not.toHaveProperty("email")
		expect(result.expectedTotal).toBe("12345")
		expect(env.values).toEqual(before)
	})
	it("keeps separate billing and derives forced shipping from a billing-only draft", () => {
		const env = preparation(fixtures([]))
		env.values.useShippingAsBilling = false
		expect(env.prepare().billingAddress.country).toBe("IN")
		env.sources.storefront.checkout.forcedBillingAddress = true
		delete env.values.shippingAddress
		const result = env.prepare()
		expect(result.shippingAddress).toMatchObject({ country: "IN", firstName: "Ada", additionalFields: {} })
		expect(sdkConfirmation.safeParse(result).success).toBe(true)
	})
	it("omits shipping on a digital cart and permits an empty method for a free cart", () => {
		const env = preparation(fixtures([]))
		env.sources.cart.needsShipping = false
		env.sources.cart.needsPayment = false
		env.sources.cart.totals.total = 0
		const result = env.prepare({ input: { paymentMethod: "" } })
		expect(result).not.toHaveProperty("shippingAddress")
		expect(result.billingAddress.country).toBe("IN")
		expect(result.paymentMethod).toBe("")
		expect(result.expectedTotal).toBe("0")
		expect(sdkConfirmation.safeParse(result).success).toBe(true)
	})
	it("replaces top-level input, reevaluates merchant rules and keeps caller provider data isolated", () => {
		const env = preparation(
			fixtures([
				field("answer", { required: { checkout: { properties: { payment_method: { const: "bacs" } }, required: ["payment_method"] } } }),
			]),
		)
		env.values.additionalFields = {}
		expect(issues(() => env.prepare())).toContainEqual({ path: ["additionalFields", "answer"], message: expect.any(String) })
		env.sources.cart.paymentMethods.push({ id: "card", title: "Card", description: "", enabled: true, order: 1 })
		const input = {
			paymentMethod: "card",
			paymentData: [{ key: "token", value: "current" }],
			extensions: { gateway: { opaque: ["token"] } },
			successPath: "/thanks",
			cancelPath: "/checkout",
		}
		env.values.paymentData = [{ key: "old", value: "old" }]
		env.values.extensions = { old: true }
		const result = env.prepare({ input })
		expect(result).toMatchObject(input)
		input.extensions.gateway.opaque.push("changed")
		expect(result.extensions).toEqual({ gateway: { opaque: ["token"] } })
		expect(result.paymentData).toEqual([{ key: "token", value: "current" }])
		expect(result.extensions).not.toHaveProperty("old")
	})
	it("treats supplied address objects as replacements and maps shared missing members to visible controls", () => {
		const env = preparation(fixtures([]))
		const result = issues(() => env.prepare({ input: { shippingAddress: { country: "IN" } as never } }))
		expect(result).toContainEqual({ path: ["shippingAddress", "firstName"], message: expect.any(String) })
		expect(result.some(({ path }) => path[0] === "billingAddress" && path[1] === "firstName")).toBe(false)
	})
	it.each(["missing", "disabled"])("rejects a %s selected payment method after overrides", (kind) => {
		const env = preparation(fixtures([]))
		if (kind === "disabled")
			env.sources.cart.paymentMethods.forEach((method) => {
				method.enabled = false
			})
		const result = issues(() => env.prepare({ input: { paymentMethod: kind === "missing" ? "unknown" : "bacs" } }))
		expect(result).toContainEqual({ message: "Choose an available payment method", path: ["paymentMethod"] })
	})
	it.each([
		{ paymentData: [{ key: "token", value: 1 }] },
		{ paymentData: { token: "bad" } },
		{ extensions: [] },
		{ successPath: "https://shop.test/thanks" },
		{ cancelPath: "//shop.test/thanks" },
		{ customerPassword: 5 },
	])("rejects malformed request properties: %j", (input) => {
		const env = preparation(fixtures([]))
		expect(issues(() => env.prepare({ input: input as never }))[0]?.path[0]).toBe(Object.keys(input)[0])
	})
	it("never echoes checkout/cart response extensions", () => {
		const env = preparation(fixtures([]))
		env.sources.checkout.extensions = { responseOnly: true }
		expect(env.prepare()).not.toHaveProperty("extensions")
	})
	it.each(["billingAddress", "paymentMethod"] as const)("rejects a draft without structural %s", (member) => {
		const env = preparation(fixtures([]))
		delete env.values[member]
		if (member === "billingAddress") env.values.useShippingAsBilling = false
		expect(issues(() => env.prepare()).some(({ path }) => path[0] === member)).toBe(true)
	})
	it("rejects required and enumerated answers after raw replacements, including hidden constraints", () => {
		const env = preparation(
			fixtures([field("select", { required: true, hidden: true, type: "select", options: [{ value: "A", label: "A" }] })]),
		)
		expect(
			issues(() => env.prepare({ input: { additionalFields: { select: "B" } } })).some(
				({ path }) => path.join(".") === "additionalFields.select",
			),
		).toBe(true)
		expect(sdkConfirmation.safeParse(env.prepare({ input: { additionalFields: { select: "A" } } })).success).toBe(true)
	})
	it("requires an explicit candidate and usable sources instead of falling back to defaults", () => {
		const env = preparation()
		expect(issues(() => prepareCheckout(env.sources))[0]?.path).toEqual([])
		for (const source of ["storefront", "checkout", "cart"] as const)
			expect(issues(() => prepareCheckout({ ...env.sources, [source]: null }, { values: env.values }))[0]?.path).toEqual([])
		env.sources.checkout.isPaid = true
		expect(issues(() => env.prepare())[0]?.message).toContain("unavailable")
	})
	it("rejects colliding form IDs and an invalid sharing control", () => {
		const env = preparation(fixtures([]))
		env.values.additionalFields = { "plug%2Fx": "first", "plug/x": "second" }
		expect(issues(() => env.prepare())[0]?.path).toEqual([])
		env.values.additionalFields = {}
		env.values.useShippingAsBilling = "yes" as never
		expect(issues(() => env.prepare()).some(({ path }) => path[0] === "useShippingAsBilling")).toBe(true)
	})
})

describe("reviewed total preparation", () => {
	it.each([0, 1, 12345])("captures minor-unit total %i without rescaling or later mutation", (total) => {
		const env = preparation(fixtures([]))
		env.sources.cart.totals.total = total
		const request = env.prepare()
		env.sources.cart.totals.total = total + 100
		expect(request.expectedTotal).toBe(String(total))
	})
	it("permits an explicit reviewed total and explicit undefined opt-out", () => {
		const env = preparation(fixtures([]))
		expect(env.prepare({ input: { expectedTotal: "000" } }).expectedTotal).toBe("000")
		expect(env.prepare({ input: { expectedTotal: undefined } })).not.toHaveProperty("expectedTotal")
	})
	it.each(["", "-1", "1.5", "1e3", " 123", 123])("rejects invalid supplied total %j", (expectedTotal) => {
		const env = preparation(fixtures([]))
		expect(issues(() => env.prepare({ input: { expectedTotal } as never }))).toContainEqual({
			message: expect.any(String),
			path: ["expectedTotal"],
		})
	})
	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid source total %j", (total) => {
		const env = preparation(fixtures([]))
		env.sources.cart.totals.total = total
		expect(issues(() => env.prepare())).toEqual([{ message: "The reviewed cart total is invalid", path: ["expectedTotal"] }])
	})
})
