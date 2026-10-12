import { createLoader, createSerializer } from "nuqs/server"
import { describe, expect, it } from "vitest"
import {
	type CollectionQuery,
	collectionScopeHref,
	emptyCollectionQuery,
	parseCollectionQuery,
	resolveCollectionScope,
	serializeCollectionQuery,
} from "../contract"
import { collectionSearchParams } from "./params"

/**
 * The URL grammar has two implementations: plain functions in `contract.ts` for any framework, and the nuqs parsers the
 * React client writes through. They have to agree on every URL a shopper can produce, so this is the test that keeps the
 * second one honest.
 */

const load = createLoader(collectionSearchParams)
const serialize = createSerializer(collectionSearchParams)

const cases: Record<string, CollectionQuery> = {
	unrefined: emptyCollectionQuery,
	"one facet": { ...emptyCollectionQuery, attribute: ["pa_color:blue"] },
	"several facets": { ...emptyCollectionQuery, attribute: ["pa_color:blue", "pa_size:l"], stock: ["instock", "onbackorder"] },
	"price range": { ...emptyCollectionQuery, maxPrice: 80, minPrice: 10.5 },
	"page and sort": { ...emptyCollectionQuery, page: 4, sort: "price-asc" },
	search: { ...emptyCollectionQuery, q: "leather bag" },
	everything: {
		attribute: ["pa_color:blue"],
		maxPrice: 80,
		minPrice: 10.5,
		page: 2,
		q: "bag",
		sort: "newest",
		stock: ["instock"],
	},
}

describe.each(Object.entries(cases))("%s", (_name, query) => {
	it("serializes identically through both implementations", () => {
		const core = serializeCollectionQuery(query)
		expect(serialize(query)).toBe(core === "" ? "" : `?${core}`)
	})

	it("parses identically through both implementations", () => {
		const searchParams = new URLSearchParams(serializeCollectionQuery(query))
		expect(load(searchParams)).toEqual(parseCollectionQuery(searchParams))
	})
})

describe("scope links", () => {
	it("preserves both URL encodings, repeated attributes, refinements and unrelated parameters", () => {
		const scopeQuery = { taxonomy: "product_brand", parameter: "brand" }
		const original = new URLSearchParams(
			"attribute=pa_color:blue&attribute=pa_size:l&stock=instock&minPrice=10.5&q=bag&sort=newest&page=4&brand=old&campaign=summer",
		)
		const href = collectionScopeHref(original, scopeQuery, "new")
		const next = new URLSearchParams(href)
		expect(resolveCollectionScope(next, scopeQuery)).toEqual({ taxonomy: "product_brand", term: "new" })
		expect(next.get("page")).toBeNull()
		expect(next.get("campaign")).toBe("summer")
		expect(next.getAll("attribute")).toEqual(["pa_color:blue", "pa_size:l"])
		expect(load(next)).toEqual(parseCollectionQuery(next))
		expect(original.get("page")).toBe("4")
		expect(new URLSearchParams(collectionScopeHref(next, scopeQuery, null)).get("brand")).toBeNull()
		expect(resolveCollectionScope({ brand: ["new", "old"] }, scopeQuery)?.term).toBe("new")
	})
})
