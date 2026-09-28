import { describe, expect, it } from "vitest"
import { type ProductSearchSort, productSearchHref, productSearchQueryKey, resolveProductSearchRequest } from "./search"

const popularity = { order: "desc", orderBy: "popularity" } as const satisfies ProductSearchSort

describe("resolveProductSearchRequest", () => {
	it("has nothing to ask for while the field is empty and no browse ordering was given", () => {
		expect(resolveProductSearchRequest({ query: "" })).toBeNull()
		expect(resolveProductSearchRequest({ query: "   " })).toBeNull()
	})

	it("browses an empty field in the ordering the caller asked for", () => {
		expect(resolveProductSearchRequest({ browseSort: popularity, query: "" })).toEqual({
			order: "desc",
			orderBy: "popularity",
			perPage: 10,
		})
		expect(resolveProductSearchRequest({ browseSort: { order: "asc", orderBy: "menu_order" }, query: "  " })).toEqual({
			order: "asc",
			orderBy: "menu_order",
			perPage: 10,
		})
	})

	it("sends no search term while browsing", () => {
		expect(resolveProductSearchRequest({ browseSort: popularity, query: " " })?.search).toBeUndefined()
	})

	it("searches the trimmed term by relevance, which means sending no ordering at all", () => {
		expect(resolveProductSearchRequest({ query: "  tote  " })).toEqual({ perPage: 10, search: "tote" })
	})

	it("ignores the browse ordering once there is a term to rank", () => {
		expect(resolveProductSearchRequest({ browseSort: popularity, query: "tote" })).toEqual({ perPage: 10, search: "tote" })
	})

	it("passes perPage through", () => {
		expect(resolveProductSearchRequest({ perPage: 4, query: "tote" })?.perPage).toBe(4)
	})

	it("merges filters into the request", () => {
		expect(resolveProductSearchRequest({ filters: { category: "bags" }, query: "tote" })).toEqual({
			category: "bags",
			perPage: 10,
			search: "tote",
		})
	})

	it("lets a filter override a colliding key", () => {
		const request = resolveProductSearchRequest({ browseSort: popularity, filters: { orderBy: "price", perPage: 3 }, query: "" })
		expect(request?.orderBy).toBe("price")
		expect(request?.perPage).toBe(3)
	})
})

describe("productSearchHref", () => {
	it("has no results page without a term", () => {
		expect(productSearchHref({ collectionPath: "/collections", query: "" })).toBeNull()
		expect(productSearchHref({ collectionPath: "/collections", query: "   " })).toBeNull()
	})

	it("writes the trimmed term as the collection's own q parameter", () => {
		expect(productSearchHref({ collectionPath: "/collections", query: "  tote bag " })).toBe("/collections?q=tote+bag")
	})

	it("keeps a scoped path intact, because a category is the page and not a facet", () => {
		expect(productSearchHref({ collectionPath: "/collections/bags", query: "tote" })).toBe("/collections/bags?q=tote")
	})
})

describe("productSearchQueryKey", () => {
	it("gives one search state one identity", () => {
		const state = { browseSort: popularity, filters: { category: "bags" }, perPage: 10, query: "tote" }
		expect(productSearchQueryKey(state)).toEqual(productSearchQueryKey({ ...state }))
	})

	it("ignores whitespace around the term, as the request does", () => {
		expect(productSearchQueryKey({ query: " tote " })).toEqual(productSearchQueryKey({ query: "tote" }))
	})

	it("separates a different term, page size or filter", () => {
		const key = productSearchQueryKey({ query: "tote" })
		expect(key).not.toEqual(productSearchQueryKey({ query: "bag" }))
		expect(key).not.toEqual(productSearchQueryKey({ perPage: 4, query: "tote" }))
		expect(key).not.toEqual(productSearchQueryKey({ filters: { category: "bags" }, query: "tote" }))
	})

	it("separates two panels that order an empty field differently", () => {
		const browsing = productSearchQueryKey({ browseSort: popularity, query: "" })
		expect(browsing).not.toEqual(productSearchQueryKey({ browseSort: { order: "desc", orderBy: "date" }, query: "" }))
		expect(browsing).not.toEqual(productSearchQueryKey({ query: "" }))
	})
})
