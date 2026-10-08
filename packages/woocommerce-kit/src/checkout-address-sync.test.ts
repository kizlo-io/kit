import { describe, expect, it, vi } from "vitest"
import { checkoutAddressChanges, createCheckoutAddressSync } from "./checkout-address-sync"
import { checkoutFieldUpdates, checkoutFormEncode } from "./checkout-form"
import { field, fixtures } from "./test/checkout-fields-fixture"
import type { CheckoutFormFieldName } from "./types"

function setup() {
	const source = fixtures([
		...(["country", "state", "postcode", "city", "address1", "firstName"] as const).map((name) =>
			field(name, {
				location: "address",
				bindings: { billing: [name], shipping: [name] },
				required: name === "postcode",
			}),
		),
		field("plugin/a.b", {
			location: "address",
			bindings: { billing: ["additionalFields", "plugin/a.b"], shipping: ["additionalFields", "plugin/a.b"] },
		}),
		field("unrelated", { required: true }),
	])
	const uk = source.storefront.address.countries.find((country) => country.code === "GB")
	if (!uk) throw new Error("Missing UK fixture")
	uk.allowShipping = true
	if (!source.values.shippingAddress) throw new Error("Missing shipping fixture")
	source.values.shippingAddress.postcode = "SW1A 1AA"
	const encoded = checkoutFormEncode(source.values)
	const values = {
		...encoded,
		billingAddress: encoded.billingAddress ?? {},
		shippingAddress: encoded.shippingAddress ?? {},
		useShippingAsBilling: false,
	}
	return { source, values }
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}

describe("private checkout address eligibility", () => {
	it.each(["firstName", "lastName", "company", "address1", "address2", "city", "state", "postcode", "country", "phone"] as const)(
		"saves a valid %s edit in either address without requiring a four-field location change",
		(key) => {
			for (const root of ["billingAddress", "shippingAddress"] as const) {
				const { source, values } = setup()
				source.storefront.address.countries.find((country) => country.code === "IN")?.states.push({ code: "MH", name: "Maharashtra" })
				const address = values[root]
				const value =
					key === "postcode"
						? root === "billingAddress"
							? "560002"
							: "SW1A 2AA"
						: key === "state"
							? root === "billingAddress"
								? "MH"
								: "London"
							: key === "country"
								? root === "billingAddress"
									? "GB"
									: "IN"
								: "New value"
				Object.assign(address, { [key]: value })
				if (key === "country") Object.assign(address, { state: "", postcode: "" })
				const pending = checkoutAddressChanges(source, values)
				expect(pending).toMatchObject({ valid: true, changed: true, fields: [`${root}.${key}`] })
				expect(Object.keys(pending.input)).toEqual([root])
			}
		},
	)
	it("rejects country and state values outside the merchant's choices", () => {
		const { source, values } = setup()
		values.billingAddress.country = "ZZ"
		expect(checkoutAddressChanges(source, values).valid).toBe(false)
		values.billingAddress.country = "IN"
		values.billingAddress.state = "INVALID"
		expect(checkoutAddressChanges(source, values).valid).toBe(false)
	})
	it("saves a street change despite unrelated required and unchanged address errors", () => {
		const { source, values } = setup()
		values.shippingAddress.postcode = (source.cart.shippingAddress ?? {}).postcode = "INVALID"
		values.billingAddress.address1 = "New road"
		const pending = checkoutAddressChanges(source, values)
		expect(pending).toMatchObject({ valid: true, changed: true, fields: ["billingAddress.address1"] })
		expect(Object.keys(pending.input)).toEqual(["billingAddress"])
	})
	it("does not treat omitted partial-draft members as changes that cannot be acknowledged", () => {
		const { source, values } = setup()
		values.billingAddress = { address1: "New road" }
		expect(checkoutAddressChanges(source, values)).toMatchObject({
			valid: true,
			fields: ["billingAddress.address1"],
			input: { billingAddress: { address1: "New road" } },
		})
	})
	it("holds an invalid changed postcode, including hidden fields", () => {
		const { source, values } = setup()
		const postcode = source.storefront.address.fields.find((field) => field.id === "postcode")
		if (!postcode) throw new Error("Missing postcode fixture")
		postcode.hidden = true
		values.billingAddress.postcode = "BAD"
		expect(checkoutAddressChanges(source, values).valid).toBe(false)
	})
	it("blocks relevant unsupported rules without making unrelated unsupported fields a gate", () => {
		const { source, values } = setup()
		source.storefront.address.fields.push(field("unbound/order", { bindings: {} }))
		values.billingAddress.address1 = "New road"
		expect(checkoutAddressChanges(source, values).valid).toBe(true)
		const street = source.storefront.address.fields.find((field) => field.id === "address1")
		if (!street) throw new Error("Missing street fixture")
		street.schema = { type: "missing-type" }
		expect(checkoutAddressChanges(source, values).valid).toBe(false)
	})
	it("saves address-bound contact values without including order fields", () => {
		const { source, values } = setup()
		source.storefront.address.fields.push(
			field("email", {
				location: "contact",
				type: "email",
				schema: { type: "string", format: "email" },
				bindings: { other: ["billingAddress", "email"] },
			}),
		)
		values.billingAddress.email = "new@example.com"
		values.customerNote = "New note"
		expect(checkoutAddressChanges(source, values)).toMatchObject({ valid: true, fields: ["billingAddress.email"] })
		expect(checkoutAddressChanges(source, values).input).not.toHaveProperty("customerNote")
		values.billingAddress.email = "invalid"
		expect(checkoutAddressChanges(source, values).valid).toBe(false)
	})
	it("exempts only empty country-dependent resets, not other pending invalid values", () => {
		const { source, values } = setup()
		values.billingAddress = { ...values.billingAddress, country: "GB", state: "", postcode: "" }
		expect(checkoutAddressChanges(source, values)).toMatchObject({ valid: true, countryChanged: true, fields: ["billingAddress.country"] })
		values.shippingAddress.postcode = "BAD"
		expect(checkoutAddressChanges(source, values).valid).toBe(false)
		values.shippingAddress.postcode = "SW1A 1AA"
		values.billingAddress.postcode = "BAD"
		expect(checkoutAddressChanges(source, values).valid).toBe(false)
	})
	it("does not exempt a required postcode cleared without a country change", () => {
		const { source, values } = setup()
		values.billingAddress.postcode = ""
		expect(checkoutAddressChanges(source, values)).toMatchObject({
			valid: false,
			countryChanged: false,
			fields: ["billingAddress.postcode"],
		})
	})
	it("maps shared native validation back to shipping while keeping registered buckets independent", () => {
		const { source, values } = setup()
		values.useShippingAsBilling = true
		values.shippingAddress.firstName = "Grace"
		values.billingAddress.additionalFields = { "plugin%2Fa%2Eb": "billing" }
		values.shippingAddress.additionalFields = { "plugin%2Fa%2Eb": "shipping" }
		const pending = checkoutAddressChanges(source, values)
		expect(pending.fields).toContain("shippingAddress.firstName")
		expect(pending.fields).not.toContain("billingAddress.firstName")
		expect(pending.fields).toContain("billingAddress.additionalFields.plugin%2Fa%2Eb")
		expect(pending.input.billingAddress?.additionalFields).toEqual({ "plugin/a.b": "billing" })
		expect(pending.input.shippingAddress?.additionalFields).toEqual({ "plugin/a.b": "shipping" })
	})
	it("skips shipping on digital carts and ignores equivalent normalization", () => {
		const { source, values } = setup()
		source.cart.needsShipping = false
		values.shippingAddress.postcode = "BAD"
		values.billingAddress.postcode = "560 001"
		values.billingAddress.city = " Bengaluru "
		expect(checkoutAddressChanges(source, values).changed).toBe(false)
	})
	it("keeps the forced-billing projection and clears only stale country dependencies", () => {
		const { source, values } = setup()
		source.storefront.checkout.forcedBillingAddress = true
		values.billingAddress.address1 = "Billing road"
		const pending = checkoutAddressChanges(source, values)
		expect(pending.input.shippingAddress?.address1).toBe("Billing road")
		expect(pending.fields).toContain("billingAddress.address1")
		const previous = { billingAddress: { country: "IN", state: "KA", postcode: "560001" } }
		values.billingAddress = { ...values.billingAddress, country: "GB", postcode: "SW1A 1AA" }
		expect(checkoutFieldUpdates("billingAddress.country", values, previous).map(({ name }) => name)).toEqual(["billingAddress.state"])
	})
})

describe("validation authorization", () => {
	function bind(validate = vi.fn<(name: CheckoutFormFieldName) => boolean | Promise<boolean>>(() => true)) {
		const { source, values } = setup()
		let current = { sources: source, values, session: "one" }
		const queue = vi.fn()
		const cancel = vi.fn()
		const flush = vi.fn()
		const activity = vi.fn()
		const sync = createCheckoutAddressSync({ read: () => current, validate, queue, cancel, flush, activity })
		return {
			...current,
			queue,
			cancel,
			flush,
			activity,
			sync,
			validate,
			set: (next: typeof current) => {
				current = next
			},
		}
	}
	it("is passive on hydration, refresh and blur before an edit", async () => {
		const env = bind()
		env.sync.refresh()
		env.sync.blur()
		await Promise.resolve()
		expect(env.validate).not.toHaveBeenCalled()
		expect(env.queue).not.toHaveBeenCalled()
	})
	it("runs application validation and holds both addresses when one changed field fails", async () => {
		const env = bind(vi.fn((name) => name !== "billingAddress.address1"))
		env.values.billingAddress.address1 = "Rejected"
		env.values.shippingAddress.city = "London"
		env.sync.change()
		await vi.waitFor(() => expect(env.validate).toHaveBeenCalledTimes(2))
		expect(env.queue).not.toHaveBeenCalled()
		expect(env.activity).toHaveBeenLastCalledWith(false)
	})
	it("ignores stale asynchronous success and authorizes only the newer isolated snapshot", async () => {
		const pending = deferred<boolean>()
		const env = bind(vi.fn().mockReturnValueOnce(pending.promise).mockReturnValue(true))
		env.values.billingAddress.address1 = "Old"
		env.sync.change()
		expect(env.activity).toHaveBeenLastCalledWith(true)
		env.values.billingAddress.address1 = "New"
		env.sync.change()
		await vi.waitFor(() => expect(env.queue).toHaveBeenCalledTimes(1))
		pending.resolve(true)
		await Promise.resolve()
		expect(env.queue).toHaveBeenCalledTimes(1)
		const input = env.queue.mock.calls[0]?.[0]
		expect(input.billingAddress.address1).toBe("New")
		expect(env.sync.allows(input, env.sources.cart)).toBe(true)
		env.values.billingAddress.address1 = "Later"
		expect(input.billingAddress.address1).toBe("New")
		expect(env.sync.allows(input, env.sources.cart)).toBe(false)
	})
	it.each(["values", "sources", "session", "reset"])("rejects validation made stale by %s", async (change) => {
		const pending = deferred<boolean>()
		const env = bind(vi.fn(() => pending.promise))
		env.values.billingAddress.address1 = "New"
		env.sync.change()
		if (change === "values") env.values.customerNote = "Different context"
		if (change === "sources") env.set({ sources: { ...env.sources }, values: env.values, session: "one" })
		if (change === "session") env.set({ sources: env.sources, values: env.values, session: "two" })
		if (change === "reset") env.sync.reset()
		pending.resolve(true)
		await vi.waitFor(() => expect(env.activity).toHaveBeenLastCalledWith(false))
		expect(env.queue).not.toHaveBeenCalled()
	})
	it("holds rejected validation without turning it into a request error", async () => {
		const env = bind(vi.fn(() => Promise.reject(new Error("Validation failed"))))
		env.values.billingAddress.address1 = "New"
		env.sync.change()
		await vi.waitFor(() => expect(env.activity).toHaveBeenLastCalledWith(false))
		expect(env.queue).not.toHaveBeenCalled()
	})
	it("flushes country resets immediately, then allows explicit blur flushing", async () => {
		const env = bind()
		env.values.billingAddress = { ...env.values.billingAddress, country: "GB", state: "", postcode: "" }
		env.sync.change()
		await vi.waitFor(() => expect(env.flush).toHaveBeenCalledTimes(1))
		expect(env.validate.mock.calls).toEqual([["billingAddress.country"]])
		env.sync.blur()
		await vi.waitFor(() => expect(env.flush).toHaveBeenCalledTimes(2))
	})
})
