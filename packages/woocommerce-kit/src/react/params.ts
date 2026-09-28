/**
 * The URL contract expressed as nuqs parsers: React's implementation of `../contract`.
 *
 * Two encodings of one grammar, which is a drift risk and is covered by a conformance test. It buys the client half
 * `shallow: false` writes, transitions and nuqs's router adapters, none of which a hand-rolled writer would give us.
 *
 * `sort` is a plain string rather than a literal union: the presets are a runtime prop, so the parser cannot know them.
 * `resolveSortPreset` does the validating instead, which keeps this object a module constant, as `useQueryStates` requires.
 */

import { parseAsFloat, parseAsInteger, parseAsNativeArrayOf, parseAsString, parseAsStringLiteral } from "nuqs/server"
import { collectionStockValues } from "../contract"

export const collectionSearchParams = {
	attribute: parseAsNativeArrayOf(parseAsString),
	maxPrice: parseAsFloat,
	minPrice: parseAsFloat,
	page: parseAsInteger.withDefault(1),
	q: parseAsString.withDefault(""),
	sort: parseAsString.withDefault(""),
	stock: parseAsNativeArrayOf(parseAsStringLiteral(collectionStockValues)),
}
