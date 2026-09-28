import { describe, expect, it } from "vitest"
import { assertKizloClient } from "./client"

const client = { woocommerce: { cart: { get: { call: () => Promise.resolve(null) } } } }

describe("assertKizloClient", () => {
	it("returns a client that carries the procedures, unchanged", () => {
		expect(assertKizloClient(client, "woocommerce.cart")).toBe(client)
	})

	it("names the absent path when an intermediate object is missing", () => {
		expect(() => assertKizloClient({}, "woocommerce.cart")).toThrow("has no woocommerce.cart procedures")
	})

	it("names the absent path when the leaf is missing", () => {
		expect(() => assertKizloClient({ woocommerce: {} }, "woocommerce.cart")).toThrow("has no woocommerce.cart procedures")
	})

	it("rejects a leaf that is not the procedures object", () => {
		expect(() => assertKizloClient({ woocommerce: { cart: "cart" } }, "woocommerce.cart")).toThrow("has no woocommerce.cart procedures")
	})

	it("throws for a client that is not an object rather than returning it", () => {
		expect(() => assertKizloClient(undefined, "woocommerce.cart")).toThrow("has no woocommerce.cart procedures")
		expect(() => assertKizloClient("client", "woocommerce.cart")).toThrow("has no woocommerce.cart procedures")
	})
})
