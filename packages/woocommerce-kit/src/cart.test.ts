import { describe, expect, it } from "vitest"
import { cartItemLimits, draftQuantityLimits, resolveQuantity, stepQuantity } from "./cart"
import type { CartItem } from "./types"

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
