import { describe, expect, it } from "vitest"
import { defaultShouldUpdateAddress } from "./cart-address-policy"
import type { Cart } from "./types"

const quoteAddress = { country: "GB", state: "London", city: "London", postcode: "SW1A 1AA" }

function addressCart(shippingAddress = quoteAddress, billingAddress = quoteAddress) {
	return { shippingAddress, billingAddress } as Cart
}

describe("defaultShouldUpdateAddress", () => {
	it("uses the saved country for a partial pricing change", () => {
		expect(defaultShouldUpdateAddress({ shippingAddress: { postcode: "SW1A 2AA" } }, addressCart())).toBe(true)
	})

	it("ignores omitted fields, equivalent postcodes, and personal details", () => {
		const cart = addressCart()
		expect(defaultShouldUpdateAddress({}, cart)).toBe(false)
		expect(defaultShouldUpdateAddress({ shippingAddress: {} }, cart)).toBe(false)
		expect(defaultShouldUpdateAddress({ shippingAddress: { postcode: "sw1a\t1aa" } }, cart)).toBe(false)
		expect(defaultShouldUpdateAddress({ shippingAddress: { firstName: "Ada", phone: "123", company: "One" } }, cart)).toBe(false)
	})

	it("checks billing independently of shipping", () => {
		expect(defaultShouldUpdateAddress({ shippingAddress: quoteAddress, billingAddress: { city: "Oxford" } }, addressCart())).toBe(true)
	})

	it.each(["", "   "])("rejects a changed address whose country is %j", (country) => {
		expect(defaultShouldUpdateAddress({ shippingAddress: { country, city: "Oxford" } }, addressCart())).toBe(false)
	})

	it("allows a valid billing change even when shipping has no country", () => {
		expect(
			defaultShouldUpdateAddress({ shippingAddress: { country: "", city: "Oxford" }, billingAddress: { city: "Oxford" } }, addressCart()),
		).toBe(true)
	})

	it("does not require postcode, state or city for a new country", () => {
		expect(defaultShouldUpdateAddress({ shippingAddress: { country: "AE" } }, null)).toBe(true)
		const address = { country: "AE", state: "", city: "Dubai", postcode: "" }
		expect(defaultShouldUpdateAddress({ shippingAddress: { city: "Abu Dhabi" } }, addressCart(address))).toBe(true)
	})

	it("requires a country when the cart has not loaded", () => {
		expect(defaultShouldUpdateAddress({ shippingAddress: { postcode: "123" } }, null)).toBe(false)
	})
})
