import type { ActiveKizloClient } from "kizlo"
import { describe, expect, it, vi } from "vitest"
import { defaultCollectionSortPresets, emptyCollectionQuery } from "./contract"
import { loadProductCollection, loadProductCollectionPage, productCollectionQueryKey } from "./request"

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

describe("collection currency resolution", () => {
	it.each([0, 2, 3])("discovers %i-decimal prices before parallel matching requests", async (minorUnit) => {
		const currencyFormat = { currencyMinorUnit: minorUnit }
		let resolve!: (result: unknown) => void
		const metadata = new Promise((done) => {
			resolve = done
		})
		const filters = vi.fn().mockReturnValueOnce(metadata).mockResolvedValue({ success: true, data: { currencyFormat } })
		const list = vi.fn().mockResolvedValue({ success: true, data: { items: [], meta: {} } })
		const client = { woocommerce: { products: { list, filters } } } as unknown as ActiveKizloClient
		const result = loadProductCollection({
			...input,
			client,
			currencyMinorUnit: "auto",
			query: { ...input.query, minPrice: 1.25, maxPrice: 20 },
		})
		expect(list).not.toHaveBeenCalled()
		expect(filters.mock.calls[0]?.[0].query.minPrice).toBeUndefined()
		resolve({ success: true, data: { currencyFormat } })
		await result
		expect(list).toHaveBeenCalledTimes(1)
		expect(filters).toHaveBeenCalledTimes(2)
		const prices = { minPrice: String(Math.round(1.25 * 10 ** minorUnit)), maxPrice: String(20 * 10 ** minorUnit) }
		expect(list.mock.calls[0]?.[0].query).toMatchObject(prices)
		expect(filters.mock.calls[1]?.[0].query).toMatchObject(prices)
	})
	it("does not serialize ordinary product requests behind filter metadata", async () => {
		const list = vi.fn(() => new Promise(() => {})),
			filters = vi.fn(() => new Promise(() => {}))
		const client = { woocommerce: { products: { list, filters } } } as unknown as ActiveKizloClient
		void loadProductCollection({ ...input, client, currencyMinorUnit: "auto" })
		expect(list).toHaveBeenCalledTimes(1)
		expect(filters).toHaveBeenCalledTimes(1)
	})
	it("fails discovery without assuming two decimals or requesting incorrectly scaled products", async () => {
		const filters = vi.fn().mockResolvedValue({ success: false }),
			list = vi.fn()
		const client = { woocommerce: { products: { list, filters } } } as unknown as ActiveKizloClient
		const result = await loadProductCollection({ ...input, client, currencyMinorUnit: "auto", query: { ...input.query, minPrice: 2 } })
		expect(result.unavailable).toBe(true)
		expect(result.products.items).toEqual([])
		expect(list).not.toHaveBeenCalled()
	})
	it("retains the legacy two-decimal default and supports explicit precision for product-only pages", async () => {
		const filters = vi.fn().mockResolvedValue({ success: false }),
			list = vi.fn().mockResolvedValue({ success: true, data: { items: [] } })
		const client = { woocommerce: { products: { list, filters } } } as unknown as ActiveKizloClient
		await loadProductCollection({ ...input, client, query: { ...input.query, minPrice: 2 } })
		expect(list.mock.lastCall?.[0].query.minPrice).toBe("200")
		filters.mockClear()
		await loadProductCollectionPage({ ...input, client, currencyMinorUnit: 3, query: { ...input.query, page: 3, minPrice: 2 } })
		expect(list.mock.lastCall?.[0].query).toMatchObject({ page: 3, minPrice: "2000" })
		expect(filters).not.toHaveBeenCalled()
		await expect(
			loadProductCollectionPage({ ...input, client, currencyMinorUnit: "auto", query: { ...input.query, minPrice: 2 } }),
		).rejects.toThrow("Resolve collection currency")
	})
	it("separates automatic and explicit currency and navigation cache identities", () => {
		expect(productCollectionQueryKey({ ...input, currencyMinorUnit: "auto" })).not.toEqual(productCollectionQueryKey(input))
		expect(productCollectionQueryKey({ ...input, navigationTaxonomy: "product_brand" })).not.toEqual(productCollectionQueryKey(input))
	})
})

it("keeps fractional major-unit links distinct before automatic precision is known", () => {
	expect(productCollectionQueryKey({ ...input, currencyMinorUnit: "auto", query: { ...input.query, minPrice: 1.25 } })).not.toEqual(
		productCollectionQueryKey({ ...input, currencyMinorUnit: "auto", query: { ...input.query, minPrice: 1.49 } }),
	)
})
