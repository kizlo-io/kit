/**
 * The collection's store access: one filter context, two requests, no framework.
 *
 * `products.filters` is not a "list the store's facets" endpoint. It is an aggregation over the *same query* as
 * `products.list`: it accepts every filter parameter the listing does and returns counts instead of items. So both are built
 * from one shared filter context and dispatched together. Paging and sort go only to the listing, since the store discards
 * them on the filters request and counts the whole matching set regardless.
 *
 * Most aggregates drop their own filter before counting, so a facet does not collapse onto whatever is already selected: the
 * store does this for the price range, the stock counts and, given `operator: "or"`, the attribute counts.
 *
 * Classification counts are the exception. They are plain membership counts over the filtered set, so a selected term
 * narrows the set and the remaining terms report their overlap with it. That is AND faceting, and it is perfectly usable
 * multi-select: the selected term keeps a non-zero count, so it always stays visible and untickable. Recovering OR faceting,
 * meaning what the count *would* be without this facet, is the only thing that would need a second filters request per
 * taxonomy, and it is not worth one.
 *
 * Where AND faceting reads badly is single-valued classifications, since no product carries two: pick one brand and every
 * sibling count is legitimately zero, so the group collapses to the one already chosen. That is why classifications are the
 * page's `scope` rather than sidebar facets. Their counts come back as the tree around the current scope, for rendering as
 * links. See `CollectionModel["scope"]`.
 *
 * Both requests fail soft. A dead listing yields an empty result with `unavailable` set; a dead filters request degrades the
 * facets to counts derived from the current page rather than emptying the sidebar.
 */

import type { ProductFilters, ProductList } from "@kizlo/woocommerce"
import type { ActiveKizloClient } from "kizlo"
import {
	type CollectionQuery,
	type CollectionScope,
	type CollectionSortPreset,
	defaultCollectionSortPresets,
	defaultNavigationTaxonomy,
	resolveSortPreset,
} from "./contract"

type SelectedTermGroup = { taxonomy: string; terms: string[] }

/** Splits `"pa_color:blue"` values into one entry per taxonomy, dropping malformed ones. */
function groupSelectedTerms(values: readonly string[]): SelectedTermGroup[] {
	const groups = new Map<string, string[]>()

	for (const value of values) {
		const separator = value.indexOf(":")
		if (separator <= 0 || separator === value.length - 1) continue
		const taxonomy = value.slice(0, separator)
		const term = value.slice(separator + 1)
		const terms = groups.get(taxonomy) ?? []
		if (!terms.includes(term)) terms.push(term)
		groups.set(taxonomy, terms)
	}

	return Array.from(groups, ([taxonomy, terms]) => ({ taxonomy, terms }))
}

const emptyListing = (page: number): ProductList =>
	({
		items: [],
		meta: {
			hasNextPage: false,
			hasPrevPage: false,
			nextPage: null,
			page,
			prevPage: null,
			totalItems: 0,
			totalPages: 0,
		},
	}) as unknown as ProductList

/** Everything that narrows the collection. Sent verbatim to both endpoints. */
type CollectionFilterRequest = {
	attributes: readonly SelectedTermGroup[]
	maxPrice?: string
	minPrice?: string
	/** The page's classification scope. WordPress matches descendants of a hierarchical term. */
	scope?: CollectionScope
	search?: string
	stock: readonly ("instock" | "outofstock" | "onbackorder")[]
}

/** The filter context plus the parts only the listing accepts. */
type ProductRequest = CollectionFilterRequest & {
	page: number
	perPage: number
	sort: CollectionSortPreset
}

/** Classifications the store takes as a named parameter rather than a generic taxonomy clause. */
const namedTaxonomyParams: Record<string, "brand" | "category" | "tag"> = {
	product_brand: "brand",
	product_cat: "category",
	product_tag: "tag",
}

/**
 * The shared filter context, in the store's query shape.
 *
 * The scope goes through the store's own parameter for its taxonomy where one exists, and through
 * the generic `_unstable_tax_*` clause otherwise. That distinction matters: WooCommerce overwrites
 * the generic entries for `product_cat`, `product_tag` and `product_brand`, so sending those the
 * generic way is silently ignored rather than rejected.
 */
function filterQuery(request: CollectionFilterRequest) {
	const scope = request.scope
	const namedScope = scope ? namedTaxonomyParams[scope.taxonomy] : undefined

	return {
		attributeRelation: request.attributes.length > 1 ? ("and" as const) : undefined,
		attributes:
			request.attributes.length > 0
				? request.attributes.map((group) => ({
						operator: "in" as const,
						slug: group.terms,
						taxonomy: group.taxonomy,
					}))
				: undefined,
		brand: namedScope === "brand" ? scope?.term : undefined,
		category: namedScope === "category" ? scope?.term : undefined,
		maxPrice: request.maxPrice,
		minPrice: request.minPrice,
		search: request.search,
		stockStatus: request.stock.length > 0 ? [...request.stock] : undefined,
		tag: namedScope === "tag" ? scope?.term : undefined,
		taxonomies:
			scope && !namedScope
				? [
						{
							operator: "in" as const,
							slugs: [scope.term],
							taxonomy: scope.taxonomy,
						},
					]
				: undefined,
	}
}

async function fetchProducts(client: ActiveKizloClient, request: ProductRequest) {
	try {
		return await client.woocommerce.products.list.call({
			query: {
				...filterQuery(request),
				order: request.sort.order,
				orderBy: request.sort.orderBy,
				page: request.page,
				perPage: request.perPage,
			},
		})
	} catch {
		return null
	}
}

async function fetchFilters(
	client: ActiveKizloClient,
	request: CollectionFilterRequest,
	attributeTaxonomies: readonly string[],
	navigationTaxonomy: string,
): Promise<ProductFilters | null> {
	try {
		return await client.woocommerce.products.filters.call({
			query: {
				...filterQuery(request),
				attributeCounts: attributeTaxonomies.map((taxonomy) => ({
					// Drops this attribute's own clause before counting, so its unselected terms survive.
					operator: "or" as const,
					taxonomy,
				})),
				stockStatusCounts: true,
				// Navigation, not a facet: the terms of the scope's own taxonomy.
				taxonomyCounts: [navigationTaxonomy],
			},
		})
	} catch {
		return null
	}
}

export type LoadProductCollectionInput = {
	/**
	 * Attribute taxonomies to offer as facets, e.g. `["pa_color", "pa_size"]`. `[]` for none.
	 *
	 * Required, and deliberately so. This is a property of the store, not of any one result set: deriving it from the
	 * products on screen would rebuild the sidebar on every page and drop any attribute the current page happens not to use.
	 * Knowing it up front is also what lets both requests go out together.
	 */
	attributeTaxonomies: readonly string[]
	/** A Kizlo server client with the WooCommerce integration installed. */
	client: ActiveKizloClient
	/**
	 * The store's currency minor unit, the number of decimal places, 2 for most currencies.
	 *
	 * URL prices are major units and the store wants minor units. This is a store constant, so taking it as configuration
	 * keeps the conversion from depending on a response.
	 */
	currencyMinorUnit?: number
	/** Products per page. */
	perPage?: number
	/** The current URL state. */
	query: CollectionQuery
	/** The page's classification scope, or `undefined` for a "shop all" page. */
	scope?: CollectionScope
	/** The orderings offered. The first is the collection's default order. */
	sortPresets?: readonly CollectionSortPreset[]
}

export type LoadedProductCollection = {
	/** The store's filters response, or `null` when that request failed. */
	filters: ProductFilters | null
	/** The taxonomy whose tree the store counted. */
	navigationTaxonomy: string
	/** The store's product listing, or an empty one when the request failed. */
	products: ProductList
	/** The product request failed. */
	unavailable: boolean
}

/**
 * Runs both store requests for one collection view.
 *
 * The whole server half of the component, minus the rendering. A framework adapter parses the URL, calls this, and hands the
 * result to `buildCollectionModel`.
 *
 * @example
 * ```ts
 * const query = parseCollectionQuery(searchParams)
 * const collection = await loadProductCollection({
 * 	attributeTaxonomies: ["pa_color", "pa_size"],
 * 	client,
 * 	query,
 * 	scope: { taxonomy: "product_cat", term: "bags" },
 * })
 * // { filters, navigationTaxonomy, products, unavailable }
 * ```
 */
export async function loadProductCollection({
	attributeTaxonomies,
	client,
	currencyMinorUnit = 2,
	perPage = 12,
	query,
	scope,
	sortPresets = defaultCollectionSortPresets,
}: LoadProductCollectionInput): Promise<LoadedProductCollection> {
	const page = Math.max(1, query.page)
	const search = query.q.trim()
	const factor = 10 ** currencyMinorUnit

	const request: ProductRequest = {
		attributes: groupSelectedTerms(query.attribute),
		maxPrice: query.maxPrice === null ? undefined : Math.round(query.maxPrice * factor).toString(),
		minPrice: query.minPrice === null ? undefined : Math.round(query.minPrice * factor).toString(),
		page,
		perPage,
		search: search || undefined,
		scope,
		sort: resolveSortPreset(sortPresets, query.sort),
		stock: query.stock,
	}

	// A scoped page shows its own taxonomy's tree; an unscoped one falls back to categories.
	const navigationTaxonomy = scope?.taxonomy ?? defaultNavigationTaxonomy

	const [listing, filters] = await Promise.all([
		fetchProducts(client, request),
		fetchFilters(client, request, attributeTaxonomies, navigationTaxonomy),
	])

	return {
		filters,
		navigationTaxonomy,
		products: listing ?? emptyListing(page),
		unavailable: listing === null,
	}
}
