/**
 * Search bones: the cache identity, the request shape and the results href.
 *
 * No React and no query library. Search has no URL grammar of its own — it writes the collection's `q`, so `contract.ts` stays
 * the only place that knows the grammar — and no server half, which is why unlike the collection it gets no
 * `contract`/`request`/`model` triple. What is framework-agnostic here is what a typeahead sends for a given input, the
 * identity of the cache entry one search state occupies, and where the full results live.
 *
 * A typeahead is browser state: it lives in the app shell and fetches per keystroke, so there is nothing for an RSC to load.
 * The results *page* is the existing product collection, reading `q` from its own search params.
 */

import { type CollectionSortPreset, serializeCollectionQuery } from "./contract"
import type { ListProductInput } from "./types"

/**
 * How to order an empty field, for a panel that shows products before anything is typed.
 *
 * The ordering half of a collection sort preset, without the label and URL token a search panel has no use for: a typeahead
 * offers no sort control, so this is configuration rather than shopper state.
 *
 * There is deliberately no default. Whether an empty panel shows the best sellers, the newest arrivals or nothing at all is a
 * storefront's decision, and a kit that picked one would be making it for every storefront after it.
 */
export type ProductSearchSort = Pick<CollectionSortPreset, "order" | "orderBy">

/** How many results a panel asks for. Enough to fill a dropdown, few enough to keep a keystroke cheap. */
export const defaultProductSearchPerPage = 10

/**
 * How long results for one term stay fresh. Long enough that going back to a term the shopper just tried costs no request,
 * short enough that a price or stock change shows up in the same session.
 */
export const productSearchStaleTime = 60_000

/** One search state: what was typed, how an empty field is ordered, how many results it wants, and whatever else narrows it. */
export type ProductSearchState = {
	/** How to order an empty field. Omitted, an empty field has no request at all. */
	browseSort?: ProductSearchSort
	/**
	 * Extra listing parameters merged into the request, e.g. `{ category: "bags" }` for a scope control. Part of the identity,
	 * so narrowed results do not land in the unnarrowed entry.
	 */
	filters?: Partial<ListProductInput>
	perPage?: number
	query: string
}

/**
 * The cache entry a search state occupies.
 *
 * Every input that shapes the request belongs here, `browseSort` included: two panels on one page that order an empty field
 * differently are two different results, and sharing an entry would let whichever fetched first decide for both. The query is
 * trimmed, because `"tote"` and `"tote "` are one search.
 *
 * Exported so an app can seed a panel from a page it has already loaded, or drop the entries after a store change.
 *
 * @example Seeding the panel a header will open, from a page that already has the products
 * ```ts
 * import { productSearchQueryKey } from "@kizlo/woocommerce-kit"
 *
 * const browseSort = { order: "desc", orderBy: "popularity" } as const
 * queryClient.setQueryData(productSearchQueryKey({ browseSort, query: "" }), popular)
 * ```
 */
export function productSearchQueryKey({ browseSort, filters, perPage = defaultProductSearchPerPage, query }: ProductSearchState) {
	return [
		"kizlo",
		"woocommerce",
		"product-search",
		{ browseSort: browseSort ?? null, filters: filters ?? null, perPage, query: query.trim() },
	] as const
}

/**
 * What one search state sends to the store, or `null` when it has nothing to ask for.
 *
 * An empty field is the interesting case. Without `browseSort` there is no request: a panel that shows nothing until the shopper
 * types is the storefront's business, and inventing a listing for it would spend a request on a decision the kit does not own.
 * With `browseSort`, the empty field browses in that order and sends no `search`.
 *
 * A real term sends the trimmed `search` and no ordering at all: relevance is the store's own default, and only an empty field
 * has nothing to rank against. Sorting a search by popularity is what makes a typeahead answer the wrong question.
 *
 * `filters` merges last, so an app can override anything here — including the ordering — for one panel.
 *
 * @example
 * ```ts
 * resolveProductSearchRequest({ query: "  " })
 * // null — nothing typed, and no browse ordering asked for
 *
 * resolveProductSearchRequest({ browseSort: { order: "desc", orderBy: "popularity" }, query: "" })
 * // { order: "desc", orderBy: "popularity", perPage: 10 }
 *
 * resolveProductSearchRequest({ filters: { category: "bags" }, query: " tote " })
 * // { category: "bags", perPage: 10, search: "tote" }
 * ```
 */
export function resolveProductSearchRequest({
	browseSort,
	filters,
	perPage = defaultProductSearchPerPage,
	query,
}: ProductSearchState): ListProductInput | null {
	const search = query.trim()
	if (!search && !browseSort) return null

	return {
		perPage,
		...(search ? { search } : browseSort),
		...filters,
	}
}

export type ProductSearchHrefInput = {
	/**
	 * Where the results live, as the app resolved it for its current scope: `"/collections"`, or `"/collections/bags"` when a
	 * scope control has a category. No default — a route belongs to the app, never to this package.
	 */
	collectionPath: string
	query: string
}

/**
 * The results page for a term, or `null` when there is no term.
 *
 * The query string comes from `serializeCollectionQuery`, so the link a panel builds and the URL the collection writes for the
 * same search are the same string. A classification stays a path segment rather than becoming a parameter, which is the rule
 * `contract.ts` documents: a category is the page, not a facet.
 *
 * @example
 * ```ts
 * productSearchHref({ collectionPath: "/collections", query: "tote" }) // "/collections?q=tote"
 * productSearchHref({ collectionPath: "/collections/bags", query: "tote" }) // "/collections/bags?q=tote"
 * productSearchHref({ collectionPath: "/collections", query: " " }) // null
 * ```
 */
export function productSearchHref({ collectionPath, query }: ProductSearchHrefInput): string | null {
	const q = query.trim()
	if (!q) return null

	return `${collectionPath}?${serializeCollectionQuery({ q })}`
}
