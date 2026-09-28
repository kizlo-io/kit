import { describe, expect, it } from "vitest"
import { formatStoreMoney, type StoreCurrencyFormat } from "./money"

const usd = {
	currencyCode: "USD",
	currencyMinorUnit: 2,
	currencyPrefix: "$",
	currencySuffix: "",
} as const satisfies StoreCurrencyFormat

describe("formatStoreMoney", () => {
	it("scales a minor-unit amount and formats it as the store's currency", () => {
		expect(formatStoreMoney(1999, usd, "en-US")).toBe("$19.99")
	})

	it("formats without decimals when the currency has no minor unit", () => {
		expect(formatStoreMoney(1999, { ...usd, currencyMinorUnit: 0 }, "en-US")).toBe("$1,999")
	})

	it("falls back to the store's affixes when Intl rejects the currency code", () => {
		const rupees = { ...usd, currencyCode: "XX", currencyPrefix: "₹" }
		expect(formatStoreMoney(1999, rupees, "en-US")).toBe("₹19.99")
	})

	it("falls back to the store's affixes when the store sent no currency code", () => {
		expect(formatStoreMoney(1999, { ...usd, currencyCode: "", currencySuffix: " INR" }, "en-US")).toBe("$19.99 INR")
	})

	it("falls back to the store's affixes for an amount that is not a number", () => {
		expect(formatStoreMoney(Number.NaN, usd, "en-US")).toBe("$NaN")
	})
})
