import type { ActiveKizloClient } from "kizlo"
import { describe, expect, it, vi } from "vitest"
import { defaultCollectionSortPresets, emptyCollectionQuery } from "./contract"
import { loadProductCollection, productCollectionQueryKey } from "./request"

const input = { attributeTaxonomies: ["pa_color"], query: emptyCollectionQuery }

describe("productCollectionQueryKey", () => {
	it("normalizes defaults, search whitespace and unordered selections without mutating them", () => {
		const query = {
			...emptyCollectionQuery,
			attribute: ["pa_size:l", "pa_color:red", "pa_color:blue", "pa_color:red"],
			q: " bag ",
			stock: ["outofstock", "instock"] as const,
		}
		const first = { ...input, query: { ...query, stock: [...query.stock] } }
		expect(productCollectionQueryKey(first)).toEqual(
			productCollectionQueryKey({
				...input,
				currencyMinorUnit: 2,
				perPage: 12,
				sortPresets: defaultCollectionSortPresets,
				query: {
					...emptyCollectionQuery,
					attribute: ["pa_color:blue", "pa_color:red", "pa_size:l"],
					q: "bag",
					stock: ["instock", "outofstock"],
				},
			}),
		)
		expect(first.query.attribute).toEqual(query.attribute)
		expect(first.query.stock).toEqual(query.stock)
	})

	it.each([
		{ query: { ...emptyCollectionQuery, page: 2 } },
		{ query: { ...emptyCollectionQuery, q: "bag" } },
		{ query: { ...emptyCollectionQuery, sort: "newest" } },
		{ query: { ...emptyCollectionQuery, minPrice: 10, maxPrice: 30 } },
		{ query: { ...emptyCollectionQuery, stock: ["instock"] as const } },
		{ query: { ...emptyCollectionQuery, attribute: ["pa_color:blue"] } },
		{ scope: { taxonomy: "product_cat", term: "bags" } },
		{ scope: { taxonomy: "product_brand", term: "bags" } },
		{ perPage: 24 },
		{ currencyMinorUnit: 0 },
		{ attributeTaxonomies: ["pa_size"] },
		{ sortPresets: [defaultCollectionSortPresets[1]] },
	])("separates request-affecting inputs: %j", (patch) => {
		const updated = { ...input, ...patch, query: patch.query ? { ...patch.query, stock: [...patch.query.stock] } : input.query }
		expect(productCollectionQueryKey(updated)).not.toEqual(productCollectionQueryKey(input))
	})
})

describe("loadProductCollection", () => {
	it("sends matching filters to both endpoints while keeping page/sort on the listing", async () => {
		const list = vi.fn().mockResolvedValue({ success: false }),
			filters = vi.fn().mockResolvedValue({ success: false })
		const client = { woocommerce: { products: { list, filters } } } as unknown as ActiveKizloClient
		const collection = await loadProductCollection({
			...input,
			client,
			scope: { taxonomy: "product_cat", term: "bags" },
			query: { ...emptyCollectionQuery, q: " tote ", minPrice: 10.5, page: 3, sort: "price-asc", attribute: ["pa_color:blue"] },
		})
		expect(list.mock.calls[0]?.[0].query).toMatchObject({
			category: "bags",
			search: "tote",
			minPrice: "1050",
			page: 3,
			perPage: 12,
			orderBy: "price",
			order: "asc",
			attributes: [{ taxonomy: "pa_color", slug: ["blue"], operator: "in" }],
		})
		expect(filters.mock.calls[0]?.[0].query).toMatchObject({
			category: "bags",
			search: "tote",
			minPrice: "1050",
			attributes: [{ taxonomy: "pa_color", slug: ["blue"], operator: "in" }],
			attributeCounts: [{ taxonomy: "pa_color", operator: "or" }],
			taxonomyCounts: ["product_cat"],
		})
		expect(filters.mock.calls[0]?.[0].query).not.toHaveProperty("page")
		expect(filters.mock.calls[0]?.[0].query).not.toHaveProperty("orderBy")
		expect(collection).toMatchObject({ unavailable: true, filters: null, products: { items: [], meta: { page: 3 } } })
	})
})
