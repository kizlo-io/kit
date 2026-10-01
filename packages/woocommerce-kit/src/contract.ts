/**
 * The collection's URL contract and the vocabulary both ends share. No framework, no URL-state library, no React.
 *
 * The parameters below are public API in the strongest sense available to a storefront: they end up in shared links,
 * sitemaps and ad campaigns, so a change to one breaks pages that this package will never see. Treat renaming or
 * re-encoding a parameter as breaking regardless of the version it lands in.
 */

import type { ProductOrderBy } from "./types"

export const collectionStockValues = ["instock", "outofstock", "onbackorder"] as const

export type CollectionStockStatus = (typeof collectionStockValues)[number]

/**
 * A named way to order a collection.
 *
 * `orderBy` is typed against the store's own sort columns, so an unsupported one is a compile
 * error rather than a silently ignored query parameter.
 */
export type CollectionSortPreset = {
	/** Shown in the sort control. */
	label: string
	order: "asc" | "desc"
	/** The store column to sort on. */
	orderBy: ProductOrderBy
	/** The URL token, e.g. `"price-asc"`. Keep these stable — they end up in shared links. */
	value: string
}

/** The built-in presets. Pass your own to `<ProductCollection sortPresets={...}>`. */
export const defaultCollectionSortPresets = [
	{ label: "Featured", order: "asc", orderBy: "menu_order", value: "featured" },
	{ label: "Newest", order: "desc", orderBy: "date", value: "newest" },
	{
		label: "Most popular",
		order: "desc",
		orderBy: "popularity",
		value: "popular",
	},
	{
		label: "Price: low to high",
		order: "asc",
		orderBy: "price",
		value: "price-asc",
	},
	{
		label: "Price: high to low",
		order: "desc",
		orderBy: "price",
		value: "price-desc",
	},
	{ label: "Best rated", order: "desc", orderBy: "rating", value: "rating" },
] as const satisfies readonly CollectionSortPreset[]

/**
 * The preset a URL token names.
 *
 * Falls back to the first preset, which is therefore the collection's default order. An unknown
 * token — a stale link, a hand-edited URL, a preset that has since been removed — resolves there
 * too rather than producing an unsorted listing.
 */
export function resolveSortPreset(presets: readonly CollectionSortPreset[], value: string): CollectionSortPreset {
	return presets.find((preset) => preset.value === value) ?? presets[0] ?? defaultCollectionSortPresets[0]
}

/**
 * A classification the collection is scoped by — one taxonomy term, e.g.
 * `{ taxonomy: "product_cat", term: "bags" }` or `{ taxonomy: "product_brand", term: "nike" }`.
 *
 * Scope is navigation, never a facet. The page *is* the term: you move between terms by following
 * links, not by ticking boxes, so the scope never appears in the URL contract below.
 *
 * Which taxonomy belongs here is a data question, not a structural one. WordPress taxonomies are
 * uniform under the hood; what matters is how many terms a product carries. A single-valued
 * classification (one brand per product) renders badly as checkboxes — pick one and every sibling
 * count is legitimately zero — so it belongs here. A multi-valued one can be a real facet.
 */
export type CollectionScope = {
	/** The term slug. */
	term: string
	/** The WordPress taxonomy, e.g. `"product_cat"`. */
	taxonomy: string
}

/** The taxonomy whose tree is shown when a page has no scope of its own. */
export const defaultNavigationTaxonomy = "product_cat"

/** The collection's URL state, parsed. */
export type CollectionQuery = {
	/** Selected attribute terms as `taxonomy:slug`, e.g. `["pa_color:blue"]`. */
	attribute: string[]
	maxPrice: number | null
	minPrice: number | null
	/** 1-based. Never below 1. */
	page: number
	/** Free-text search. */
	q: string
	/** A sort preset's URL token. Validated against the offered presets by `resolveSortPreset`, not here. */
	sort: string
	stock: CollectionStockStatus[]
}

/** A write to the collection's URL state. `null` clears a parameter. */
export type CollectionQueryPatch = {
	[K in keyof CollectionQuery]?: CollectionQuery[K] | null
}

/** The query state of a collection with nothing selected. */
export const emptyCollectionQuery: CollectionQuery = {
	attribute: [],
	maxPrice: null,
	minPrice: null,
	page: 1,
	q: "",
	sort: "",
	stock: [],
}

/** Anything a framework hands you for the current URL's query string. */
export type CollectionSearchParams = URLSearchParams | Record<string, string | string[] | undefined>

function readAll(searchParams: CollectionSearchParams, key: string): string[] {
	if (searchParams instanceof URLSearchParams) return searchParams.getAll(key)
	const value = searchParams[key]
	if (value === undefined) return []
	return Array.isArray(value) ? value : [value]
}

function readOne(searchParams: CollectionSearchParams, key: string): string | undefined {
	return readAll(searchParams, key)[0]
}

function readNumber(searchParams: CollectionSearchParams, key: string): number | null {
	const raw = readOne(searchParams, key)
	if (raw === undefined || raw.trim() === "") return null
	const value = Number(raw)
	return Number.isFinite(value) ? value : null
}

/**
 * Reads the collection's state out of a query string.
 *
 * Total: anything unparseable falls back to its default rather than throwing, because these values arrive from stale links,
 * hand-edited URLs and crawlers as often as from the UI.
 *
 * @example
 * ```ts
 * const query = parseCollectionQuery("?attribute=pa_color:blue&page=2")
 * // { attribute: ["pa_color:blue"], maxPrice: null, minPrice: null, page: 2, q: "", sort: "", stock: [] }
 *
 * // Whatever your framework hands a page works too:
 * parseCollectionQuery(await searchParams)
 * parseCollectionQuery(new URL(request.url).searchParams)
 * ```
 */
export function parseCollectionQuery(searchParams: CollectionSearchParams): CollectionQuery {
	const page = readNumber(searchParams, "page")
	const stock = readAll(searchParams, "stock").filter((value): value is CollectionStockStatus =>
		(collectionStockValues as readonly string[]).includes(value),
	)

	return {
		// A malformed pair is dropped rather than carried through to the store as an empty taxonomy or term.
		attribute: readAll(searchParams, "attribute").filter((value) => {
			const separator = value.indexOf(":")
			return separator > 0 && separator < value.length - 1
		}),
		maxPrice: readNumber(searchParams, "maxPrice"),
		minPrice: readNumber(searchParams, "minPrice"),
		page: page !== null && page >= 1 ? Math.floor(page) : 1,
		q: readOne(searchParams, "q") ?? "",
		sort: readOne(searchParams, "sort") ?? "",
		stock: [...new Set(stock)],
	}
}

/**
 * Writes the collection's state back to a query string, for pagination links, canonical URLs or a sitemap.
 *
 * Defaults are omitted, so an unrefined collection serializes to nothing and every state has exactly one URL.
 *
 * @example
 * ```ts
 * const next = serializeCollectionQuery({ ...query, page: query.page + 1 })
 * const href = next === "" ? pathname : `${pathname}?${next}`
 * ```
 */
export function serializeCollectionQuery(query: Partial<CollectionQuery>): string {
	const searchParams = new URLSearchParams()

	for (const value of query.attribute ?? []) searchParams.append("attribute", value)
	if (query.maxPrice !== null && query.maxPrice !== undefined) searchParams.set("maxPrice", String(query.maxPrice))
	if (query.minPrice !== null && query.minPrice !== undefined) searchParams.set("minPrice", String(query.minPrice))
	if (query.page !== null && query.page !== undefined && query.page > 1) searchParams.set("page", String(query.page))
	if (query.q) searchParams.set("q", query.q)
	if (query.sort) searchParams.set("sort", query.sort)
	for (const value of query.stock ?? []) searchParams.append("stock", value)

	// `URLSearchParams` percent-encodes the colon in `pa_color:blue`; nuqs, which writes the URL in the browser, does not, and
	// RFC 3986 allows it raw in a query string. Match the browser, or a server-built pagination link and the client's own URL
	// for the same collection would be two different strings.
	return searchParams.toString().replaceAll("%3A", ":")
}
