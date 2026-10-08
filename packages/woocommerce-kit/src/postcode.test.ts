import { describe, expect, it } from "vitest"
import { validPostcode } from "./postcode"

describe("WooCommerce postcode rules", () => {
	it.each([
		["IN", "560001", true],
		["IN", "560 001", true],
		["IN", "000001", false],
		["IN", "abc", false],
		["GB", "sw1a 1aa", true],
		["GB", "SW1A1AA", true],
		["GB", "560001", false],
		["US", "90210", true],
		["US", "90210-1234", true],
		["US", "902101234", false],
		["IE", "D02-X285", true],
		["IE", " D02 X285 ", true],
		["CA", "K1A 0B1", true],
		["AU", "2000", true],
		["AU", "ABC", false],
		["ZZ", "custom-123", true],
		["ZZ", "123💌", false],
		["ZZ", "123_456", false],
		["ZZ", "１２３４", false],
	] as const)("%s postcode %s: %s", (country, postcode, valid) => {
		expect(validPostcode(postcode, country)).toBe(valid)
	})
})
