import { describe, expect, it } from "vitest"
import { createCheckoutReadiness } from "./checkout-readiness"

describe("feature readiness", () => {
	it("reports optional errors independently of blocking and keeps unrelated required work", () => {
		const store = createCheckoutReadiness(),
			required = {},
			optional = {},
			error = new Error("refused")
		store.start({ identity: optional, feature: "cart.item", generation: 0, confirmation: false })
		expect(store.reasons().has("cart.item")).toBe(true)
		store.finish(required, "cart.item", 0, 0, error, false, { tasks: ["item:a"] })
		store.finish(optional, "cart.item", 0, 0, error, false, { tasks: ["item:add"], blocking: false })
		expect(store.failure("cart.item")?.identity).toBe(optional)
		store.finish({}, "cart.item", 0, 0, null, false, { tasks: ["item:b"] })
		store.dismiss("cart.item", required)
		expect(store.reasons().has("cart.item")).toBe(true)
		store.resolve("item:a", optional)
		expect(store.reasons().has("cart.item")).toBe(true)
		store.resolve("item:a", required)
		expect(store.reasons().size).toBe(0)
		expect(store.failure("cart.item")?.error).toBe(error)
	})
	it.each([true, false])("counts all requests and uses completion order (late failure: %s)", (lateFails) => {
		const store = createCheckoutReadiness(),
			a = {},
			b = {},
			error = new Error("failed")
		for (const identity of [a, b, a]) store.start({ identity, feature: "cart.address", generation: 0, confirmation: false })
		expect(store.state.get().pending).toHaveLength(2)
		store.finish(b, "cart.address", 0, 0, lateFails ? null : error)
		expect(store.reasons().has("cart.address")).toBe(true)
		store.finish(a, "cart.address", 0, 0, lateFails ? error : null)
		expect(store.reasons().has("cart.address")).toBe(lateFails)
		expect(store.state.get().pending).toHaveLength(0)
	})
	it("keeps a failure until same-feature completion or scoped dismissal, and does not clear it at retry start", () => {
		const store = createCheckoutReadiness(),
			a = {},
			b = {}
		store.seedFailure(a, "cart.item", new Error("item failed"))
		store.finish(b, "cart.coupon", 0, 0, null)
		store.start({ identity: b, feature: "cart.item", generation: 0, confirmation: false })
		expect(store.failure("cart.item")?.identity).toBe(a)
		store.dismiss("cart.item", b)
		expect(store.failure("cart.item")).toBeDefined()
		store.dismiss("cart.item", a)
		expect(store.reasons().has("cart.item")).toBe(true)
		store.finish(b, "cart.item", 0, 0, null)
		expect(store.reasons().size).toBe(0)
	})
	it("isolates session outcomes while retaining dispatched work, and allows settled confirmation retry", () => {
		const store = createCheckoutReadiness(),
			identity = {}
		store.seedFailure({}, "cart.address", new Error("old"))
		store.start({ identity, feature: "cart.address", generation: 0, confirmation: false })
		store.replaceSession()
		expect(store.state.get().failures).toHaveLength(0)
		expect(store.reasons().has("cart.address")).toBe(true)
		store.finish(identity, "cart.address", 0, 1, new Error("late"))
		store.finish({}, "checkout.confirmation", 1, 1, new Error("declined"), true)
		expect(store.reasons().size).toBe(0)
	})
})
