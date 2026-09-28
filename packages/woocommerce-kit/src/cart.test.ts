import type { CartItem } from "@kizlo/woocommerce"
import { describe, expect, it } from "vitest"
import { cartItemLimits, resolveQuantity } from "./cart"

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
})
