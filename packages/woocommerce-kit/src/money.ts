/**
 * Money formatting for store amounts.
 *
 * WooCommerce sends every amount as a minor-unit integer next to the store's own currency format, so an amount cannot be
 * formatted without one: `1999` with `currencyMinorUnit: 2` is `19.99`. Getting that scaling wrong is silent — the number
 * still renders, a hundred times too large — which is why this lives in the core rather than in each consumer.
 */

/**
 * The currency half of a store response. Structural on purpose: a cart's `currencyFormat` and a product's both satisfy it,
 * so one function formats a line total and a price range alike.
 */
export type StoreCurrencyFormat = {
	currencyCode: string
	currencyMinorUnit: number
	currencyPrefix: string
	currencySuffix: string
}

function formatWithIntl(value: number, currencyCode: string, currencyMinorUnit: number, locale: string | undefined) {
	try {
		return new Intl.NumberFormat(locale, {
			style: "currency",
			currency: currencyCode,
			minimumFractionDigits: currencyMinorUnit,
			maximumFractionDigits: currencyMinorUnit,
		}).format(value)
	} catch {
		return null
	}
}

/**
 * Formats a minor-unit amount using the store's currency.
 *
 * Always returns something printable. When the amount is not finite, the store sent no currency code, or `Intl` rejects the
 * code it did send, the store's own prefix and suffix go around the scaled value instead — a storefront should show a price
 * the store can explain, not an empty slot.
 *
 * `locale` is the consumer's: it decides grouping and symbol placement, never the currency, which always comes from the
 * store. Left undefined it follows the runtime's default.
 *
 * @example A product price, outside any cart
 * ```ts
 * formatStoreMoney(product.prices.price, product.currencyFormat, "en-IN")
 * // "₹1,299.00"
 * ```
 *
 * @example The affix fallback, when the store's currency is one `Intl` will not take
 * ```ts
 * formatStoreMoney(1999, { currencyCode: "XX", currencyMinorUnit: 2, currencyPrefix: "₹", currencySuffix: "" })
 * // "₹19.99"
 * ```
 *
 * Inside a cart, prefer `useCart().format`, which has this cart's currency and the provider's locale already applied.
 */
export function formatStoreMoney(amount: number, currencyFormat: StoreCurrencyFormat, locale?: string): string {
	const { currencyCode, currencyMinorUnit, currencyPrefix, currencySuffix } = currencyFormat
	const value = amount / 10 ** currencyMinorUnit

	if (Number.isFinite(value) && currencyCode) {
		const formatted = formatWithIntl(value, currencyCode, currencyMinorUnit, locale)
		if (formatted !== null) return formatted
	}

	const affixed = Number.isFinite(value) ? value.toFixed(currencyMinorUnit) : String(value)
	return `${currencyPrefix}${affixed}${currencySuffix}`
}
