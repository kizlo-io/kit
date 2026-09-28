import { describe, expect, it } from "vitest"
import {
	type CollectionQuery,
	type CollectionSortPreset,
	defaultCollectionSortPresets,
	emptyCollectionQuery,
	parseCollectionQuery,
	resolveSortPreset,
	serializeCollectionQuery,
} from "./contract"

const presets = [
	{ label: "Newest", order: "desc", orderBy: "date", value: "newest" },
	{ label: "Price: low to high", order: "asc", orderBy: "price", value: "price-asc" },
] as const satisfies readonly CollectionSortPreset[]

describe("resolveSortPreset", () => {
	it("resolves a known token", () => {
		expect(resolveSortPreset(presets, "price-asc")).toBe(presets[1])
	})

	it("falls back to the first preset, which is the collection's default order", () => {
		expect(resolveSortPreset(presets, "")).toBe(presets[0])
		expect(resolveSortPreset(presets, "popularity")).toBe(presets[0])
	})

	it("falls back to the built-in presets when none are offered", () => {
		expect(resolveSortPreset([], "newest")).toBe(defaultCollectionSortPresets[0])
	})
})

describe("parseCollectionQuery", () => {
	it("reads an empty query string as the unrefined collection", () => {
		expect(parseCollectionQuery(new URLSearchParams())).toEqual(emptyCollectionQuery)
	})

	it("reads repeated entries into arrays", () => {
		const query = parseCollectionQuery(new URLSearchParams("attribute=pa_color:blue&attribute=pa_size:l&stock=instock"))
		expect(query.attribute).toEqual(["pa_color:blue", "pa_size:l"])
		expect(query.stock).toEqual(["instock"])
	})

	it("accepts the record shape a framework hands to a page", () => {
		const query = parseCollectionQuery({ attribute: ["pa_color:blue"], page: "3", q: "bag" })
		expect(query).toMatchObject({ attribute: ["pa_color:blue"], page: 3, q: "bag" })
	})

	it("drops malformed attribute pairs rather than querying an empty taxonomy", () => {
		const query = parseCollectionQuery(
			new URLSearchParams("attribute=pa_color:blue&attribute=broken&attribute=:orphan&attribute=trailing:"),
		)
		expect(query.attribute).toEqual(["pa_color:blue"])
	})

	it("ignores stock statuses the store does not have", () => {
		expect(parseCollectionQuery(new URLSearchParams("stock=instock&stock=lost")).stock).toEqual(["instock"])
	})

	it("falls back rather than throwing on values from a stale or hand-edited link", () => {
		const query = parseCollectionQuery(new URLSearchParams("page=0&minPrice=cheap&maxPrice="))
		expect(query.page).toBe(1)
		expect(query.minPrice).toBeNull()
		expect(query.maxPrice).toBeNull()
	})
})

describe("serializeCollectionQuery", () => {
	it("serializes the unrefined collection to nothing, so every state has one URL", () => {
		expect(serializeCollectionQuery(emptyCollectionQuery)).toBe("")
		expect(serializeCollectionQuery({ page: 1 })).toBe("")
	})

	it("leaves the colon in an attribute pair raw, as the browser URL will have it", () => {
		expect(serializeCollectionQuery({ attribute: ["pa_color:blue"] })).toBe("attribute=pa_color:blue")
	})

	it("round-trips a refined collection", () => {
		const query: CollectionQuery = {
			...emptyCollectionQuery,
			attribute: ["pa_color:blue", "pa_size:l"],
			maxPrice: 80,
			minPrice: 10.5,
			page: 3,
			q: "leather bag",
			sort: "price-asc",
			stock: ["instock"],
		}

		expect(parseCollectionQuery(new URLSearchParams(serializeCollectionQuery(query)))).toEqual(query)
	})
})
