import { describe, expect, it } from "vitest"
import {
	cartItemLimits,
	defaultShouldUpdateAddress,
	draftQuantityLimits,
	hasSelectedShippingRates,
	resolveQuantity,
	shippingQuoteSignature,
	stepQuantity,
} from "./cart"
import type { Cart, CartItem, CartShippingAddress } from "./types"

/** Only the fields `cartItemLimits` reads. The rest of a cart item says nothing about its quantity range. */
function lineItem(item: { isSoldIndividually: boolean; quantity: number; quantityLimits: CartItem["quantityLimits"] }) {
	return item as CartItem
}

const quantityLimits = { editable: true, maximum: 10, minimum: 2, multipleOf: 2 } as const satisfies CartItem["quantityLimits"]

describe("cartItemLimits", () => {
	it("reports the store's range, step and editability", () => {
		const limits = cartItemLimits(lineItem({ isSoldIndividually: false, quantity: 4, quantityLimits }))
		expect(limits).toEqual({ editable: true, maximum: 10, minimum: 2, step: 2 })
	})

	it("collapses the maximum to the current quantity for an item sold individually", () => {
		const limits = cartItemLimits(lineItem({ isSoldIndividually: true, quantity: 1, quantityLimits }))
		expect(limits.maximum).toBe(1)
	})

	it("passes a locked line's editability through", () => {
		const locked = { ...quantityLimits, editable: false }
		const limits = cartItemLimits(lineItem({ isSoldIndividually: false, quantity: 4, quantityLimits: locked }))
		expect(limits.editable).toBe(false)
	})
})

describe("draftQuantityLimits", () => {
	it("stands in for the store with an editable 1-99 range", () => {
		expect(draftQuantityLimits()).toEqual({ editable: true, maximum: 99, minimum: 1, step: 1 })
	})

	it("replaces only the fields an override names", () => {
		expect(draftQuantityLimits({ maximum: 5 })).toEqual({ editable: true, maximum: 5, minimum: 1, step: 1 })
		expect(draftQuantityLimits({ minimum: 2, step: 2 })).toEqual({ editable: true, maximum: 99, minimum: 2, step: 2 })
	})

	it("stays editable, so a draft control is never disabled by its own range", () => {
		expect(draftQuantityLimits({ maximum: 1 }).editable).toBe(true)
	})
})

describe("stepQuantity", () => {
	const limits = { editable: true, maximum: 10, minimum: 2, step: 1 }

	it("moves one step in either direction", () => {
		expect(stepQuantity({ direction: "increment", limits, value: 5 })).toBe(6)
		expect(stepQuantity({ direction: "decrement", limits, value: 5 })).toBe(4)
	})

	it("steps by the store's multiple", () => {
		expect(stepQuantity({ direction: "increment", limits: { ...limits, step: 3 }, value: 4 })).toBe(7)
		expect(stepQuantity({ direction: "decrement", limits: { ...limits, step: 3 }, value: 8 })).toBe(5)
	})

	it("stops at the edge of the range rather than passing it", () => {
		expect(stepQuantity({ direction: "increment", limits, value: 10 })).toBe(10)
		expect(stepQuantity({ direction: "decrement", limits, value: 2 })).toBe(2)
	})

	it("lands exactly on the boundary when a step would overshoot it", () => {
		expect(stepQuantity({ direction: "increment", limits: { ...limits, step: 4 }, value: 9 })).toBe(10)
		expect(stepQuantity({ direction: "decrement", limits: { ...limits, step: 4 }, value: 3 })).toBe(2)
	})

	it("falls back to a step of 1 rather than leaving a button dead", () => {
		expect(stepQuantity({ direction: "increment", limits: { ...limits, step: 0 }, value: 5 })).toBe(6)
		expect(stepQuantity({ direction: "decrement", limits: { ...limits, step: -2 }, value: 5 })).toBe(4)
	})
})

describe("resolveQuantity", () => {
	const range = { maximum: 10, minimum: 2, step: 1, value: 5 }

	it("clamps below the minimum and above the maximum", () => {
		expect(resolveQuantity({ ...range, input: "1" })).toBe(2)
		expect(resolveQuantity({ ...range, input: "40" })).toBe(10)
	})

	it("rounds to the nearest step", () => {
		expect(resolveQuantity({ ...range, input: "7", step: 2 })).toBe(8)
		expect(resolveQuantity({ ...range, input: "5", step: 3 })).toBe(6)
	})

	it("keeps the current quantity when the field says nothing numeric", () => {
		expect(resolveQuantity({ ...range, input: "two" })).toBe(5)
		expect(resolveQuantity({ ...range, input: "" })).toBe(5)
		expect(resolveQuantity({ ...range, input: "   " })).toBe(5)
	})

	it("ignores a step that would divide by zero", () => {
		expect(resolveQuantity({ ...range, input: "7", step: 0 })).toBe(7)
		expect(resolveQuantity({ ...range, input: "7", step: -2 })).toBe(7)
	})

	it("clamps into the draft range a keyless control uses", () => {
		const { maximum, minimum, step } = draftQuantityLimits()

		expect(resolveQuantity({ input: "0", maximum, minimum, step, value: 1 })).toBe(1)
		expect(resolveQuantity({ input: "150", maximum, minimum, step, value: 1 })).toBe(99)
	})
})

describe("hasSelectedShippingRates", () => {
	/** Only the shipping fields the derivation reads. `rates` is one boolean per rate: whether it is the selected one. */
	function shippingCart(packages: { rates: boolean[] }[], needsShipping = true) {
		return {
			needsShipping,
			shippingPackages: packages.map((shippingPackage, index) => ({
				id: index,
				rates: shippingPackage.rates.map((selected, rateIndex) => ({ id: `rate-${index}-${rateIndex}`, selected })),
			})),
		} as unknown as Cart
	}

	it("is false without a cart, so a consumer needs no guard", () => {
		expect(hasSelectedShippingRates(null)).toBe(false)
	})

	it("is true for a cart that needs no shipping at all", () => {
		expect(hasSelectedShippingRates(shippingCart([], false))).toBe(true)
	})

	it("is true once the one package has its rate", () => {
		expect(hasSelectedShippingRates(shippingCart([{ rates: [false, true] }]))).toBe(true)
	})

	it("is false while a package offers rates and none is selected", () => {
		expect(hasSelectedShippingRates(shippingCart([{ rates: [false, false] }]))).toBe(false)
	})

	it("is false for a package nothing can be shipped by", () => {
		expect(hasSelectedShippingRates(shippingCart([{ rates: [] }]))).toBe(false)
	})

	it("is false until every package has its own selection", () => {
		expect(hasSelectedShippingRates(shippingCart([{ rates: [true] }, { rates: [false] }]))).toBe(false)
		expect(hasSelectedShippingRates(shippingCart([{ rates: [true] }, { rates: [true] }]))).toBe(true)
	})

	it("is false for a cart that needs shipping and was quoted no packages", () => {
		expect(hasSelectedShippingRates(shippingCart([]))).toBe(false)
	})
})

const quoteAddress = { country: "GB", state: "London", city: "London", postcode: "SW1A 1AA" }

function addressCart(shippingAddress = quoteAddress, billingAddress = quoteAddress) {
	return { shippingAddress, billingAddress } as Cart
}

describe("shippingQuoteSignature", () => {
	it("ignores personal details and street", () => {
		const first: Partial<CartShippingAddress> = { ...quoteAddress, firstName: "Ada", phone: "111", company: "One", address1: "Street 1" }
		const second = { ...first, firstName: "Grace", phone: "222", company: "Two", address1: "Street 2" }
		expect(shippingQuoteSignature(first)).toBe(shippingQuoteSignature(second))
	})

	it("normalizes all postcode whitespace and case, and trims other fields", () => {
		expect(shippingQuoteSignature({ country: " GB ", state: " London ", city: " London ", postcode: " sw1a\t1\n aa " })).toBe(
			shippingQuoteSignature(quoteAddress),
		)
	})

	it.each(["country", "state", "city", "postcode"] as const)("detects a changed %s", (field) => {
		expect(shippingQuoteSignature({ ...quoteAddress, [field]: "different" })).not.toBe(shippingQuoteSignature(quoteAddress))
	})

	it("treats missing fields as empty strings", () => {
		expect(shippingQuoteSignature({})).toBe(shippingQuoteSignature({ country: "", state: "", city: "", postcode: "" }))
	})

	it("does not conflate fields containing separators", () => {
		expect(shippingQuoteSignature({ country: "GB", city: "a,b", state: "c" })).not.toBe(
			shippingQuoteSignature({ country: "GB", city: "b", state: "c,a" }),
		)
	})
})

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
