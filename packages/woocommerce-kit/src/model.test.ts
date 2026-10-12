import { describe, expect, it } from "vitest"
import { createCollectionActions } from "./collection-actions"
import { emptyCollectionQuery } from "./contract"
import { buildCollectionModel } from "./model"
import { emptyListing } from "./request"
import type { ProductFilters, ProductList } from "./types"

function model(minorUnit: number) {
	const currencyFormat = { currencyCode: "USD", currencyMinorUnit: minorUnit, currencyPrefix: "$", currencySuffix: "", currencySymbol: "$" }
	const factor = 10 ** minorUnit
	return buildCollectionModel({
		products: {
			...emptyListing(1),
			items: [{ id: 1, attributes: [], currencyFormat, isInStock: true, prices: { price: 12 * factor } }],
		} as unknown as ProductList,
		filters: {
			currencyFormat,
			priceRange: { minPrice: 10 * factor, maxPrice: 100 * factor },
			attributeTerms: [{ id: 2, name: "Blue &amp; green", slug: "blue", taxonomy: "pa_color", count: 5 }],
			stockStatuses: [{ status: "instock", count: 5 }],
			taxonomyTerms: [],
		} as unknown as ProductFilters,
		query: { ...emptyCollectionQuery, attribute: ["pa_color:blue"], stock: ["instock"], minPrice: 20, sort: "newest", q: "bag" },
	})
}
describe("collection data and actions", () => {
	it.each([0, 2, 3])("derives data-only records and formats major-unit prices with %i decimals", (minorUnit) => {
		const data = model(minorUnit)
		expect(data.filters.price).toMatchObject({ minimum: 10, maximum: 100, value: [20, 100] })
		expect(data.filters.groups.find((group) => group.taxonomy === "pa_color")?.terms[0]).toMatchObject({
			label: "Blue & green",
			selected: true,
		})
		expect(
			JSON.stringify(data, (_key, value) => {
				expect(typeof value).not.toBe("function")
				return value
			}),
		).toBeTruthy()
		const actions = createCollectionActions({ model: data, query: emptyCollectionQuery, write: () => {}, locale: "en-US" })
		expect(actions.formatPrice(12)).toBe(
			new Intl.NumberFormat("en-US", {
				style: "currency",
				currency: "USD",
				minimumFractionDigits: minorUnit,
				maximumFractionDigits: minorUnit,
			}).format(12),
		)
	})
	it("preserves clearing, toggling and pagination reset semantics", () => {
		const patches: unknown[] = []
		const actions = createCollectionActions({
			model: model(2),
			query: { ...emptyCollectionQuery, page: 3, attribute: ["pa_color:blue", "pa_size:l"], stock: ["instock"] },
			write: (patch) => patches.push(patch),
		})
		actions.setPage(4)
		actions.setSort("featured")
		actions.setSearch(" bag ")
		actions.toggleAttribute("pa_color:blue")
		actions.toggleStock("instock", false)
		actions.clearFilters("pa_color")
		actions.setPriceRange(10, 100)
		actions.clearFilters()
		expect(patches).toEqual([
			{ page: 4 },
			{ page: null, sort: null },
			{ page: null, q: "bag" },
			{ page: null, attribute: ["pa_size:l"] },
			{ page: null, stock: null },
			{ page: null, attribute: ["pa_size:l"] },
			{ page: null, minPrice: null, maxPrice: null },
			{ page: null, attribute: null, minPrice: null, maxPrice: null, q: null, stock: null },
		])
	})
})
