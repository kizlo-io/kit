import { createLoader, createSerializer } from "nuqs/server"
import { describe, expect, it } from "vitest"
import { type CollectionQuery, emptyCollectionQuery, parseCollectionQuery, serializeCollectionQuery } from "../contract"
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
