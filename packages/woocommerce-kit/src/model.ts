/**
 * The collection's derived model: the facet groups, the scope tree, the sort options and the paging, built from one pair of
 * store responses plus the current query.
 *
 * Framework-agnostic and pure. Every control the model hands back is a closure over `write`, which the framework adapter
 * supplies, so this file knows how the collection behaves without knowing what renders it or how a URL gets written.
 */

import { decodeHtmlEntities } from "@kizlo/kit"
import {
	type CollectionQuery,
	type CollectionQueryPatch,
	type CollectionScope,
	type CollectionSortPreset,
	type CollectionStockStatus,
	defaultCollectionSortPresets,
	defaultNavigationTaxonomy,
	resolveSortPreset,
} from "./contract"
import type { Product, ProductFilters, ProductList } from "./types"

/** The store's own product type, passed through unmapped. */
export type CollectionProduct = Product

/** The store's product listing, exactly as the server received it. */
export type CollectionProductsPayload = ProductList

/** The store's filters response. The provider takes `null` for a failed request. */
export type CollectionFiltersPayload = ProductFilters

const defaultStockLabels = {
	instock: "In stock",
	onbackorder: "On backorder",
	outofstock: "Out of stock",
} as const satisfies Record<CollectionStockStatus, string>

export type CollectionFilterTerm = {
	count: number
	/** Decoded, ready to render. */
	label: string
	selected: boolean
	/** The WordPress term slug, or the stock status. */
	slug: string
	/** A colour, or an image URL when `type` is `"image"`. */
	swatch?: string | null
	/** Flip this term. No argument inverts; pass a boolean to set it outright. */
	toggle: (selected?: boolean) => void
	type?: "color" | "image" | "text"
	/** Unique within the collection. Use it as the React key. */
	value: string
}

export type CollectionFilterGroupKind = "attribute" | "stock"

export type CollectionFilterGroup = {
	activeCount: number
	/** Deselect every term in this group. */
	clear: () => void
	/** Whether any term carries a colour or image swatch. */
	hasSwatches: boolean
	id: string
	kind: CollectionFilterGroupKind
	/** Decoded, ready to render. */
	label: string
	/** The WordPress taxonomy, or `"stock"`. */
	taxonomy: string
	terms: readonly CollectionFilterTerm[]
}

export type CollectionPriceFilter = {
	currencySymbol: string
	/** True once the range is narrower than the collection's bounds. */
	isActive: boolean
	maximum: number
	minimum: number
	reset: () => void
	/** Writes the range, clearing it when it spans the full bounds. */
	set: (minimum: number, maximum: number) => void
	/** Selected range, clamped to the bounds. Equals them when unfiltered. */
	value: readonly [number, number]
}

export type CollectionFiltersApi = {
	/** Selected terms across every group, plus one for an active price range. */
	activeCount: number
	clearAll: () => void
	groups: readonly CollectionFilterGroup[]
	/** True while the server is producing the next result set. */
	isPending: boolean
	price: CollectionPriceFilter
	search: { clear: () => void; set: (value: string) => void; value: string }
}

export type CollectionScopeTerm = {
	/** Products carrying this term within the current scope and filters. */
	count: number
	id: number
	/** Decoded, ready to render. */
	label: string
	parentId: number | null
	slug: string
	taxonomy: string
}

/**
 * The classification tree around the current scope — navigation, not filters.
 *
 * Render these as links. The page *is* its scope term, so moving between terms is a page change,
 * which is what keeps the store requests down to two; see `server.tsx`.
 */
export type CollectionScopeApi = {
	/** Direct children of the current term, or the top level on an unscoped page. */
	children: readonly CollectionScopeTerm[]
	/** The scope's own term, when the store returned it. */
	current: CollectionScopeTerm | null
	/** The taxonomy these terms belong to — the scope's own, or the default when unscoped. */
	taxonomy: string
	/** Every term of that taxonomy the in-scope products carry, for building breadcrumbs. */
	terms: readonly CollectionScopeTerm[]
}

export type CollectionSortOption = {
	label: string
	selected: boolean
	/** The preset's URL token. */
	value: string
}

export type CollectionSortApi = {
	options: readonly CollectionSortOption[]
	set: (sort: string) => void
	/** The active preset's URL token. Always one of `options`, even on a stale link. */
	value: string
}

export type CollectionProductsApi = {
	hasNextPage: boolean
	hasPreviousPage: boolean
	/** True while the server is producing the next result set. */
	isPending: boolean
	items: readonly CollectionProduct[]
	page: number
	setPage: (page: number) => void
	totalItems: number
	totalPages: number
	/** The store request failed. `items` is empty and the facets are degraded. */
	unavailable: boolean
}

export type CollectionModel = {
	filters: CollectionFiltersApi
	products: CollectionProductsApi
	scope: CollectionScopeApi
	sort: CollectionSortApi
}

function clamp(value: number, minimum: number, maximum: number) {
	return Math.min(maximum, Math.max(minimum, value))
}

type SourceFacetTerm = {
	count: number
	id: number
	name: string
	slug: string
	swatch?: string | null
	taxonomy: string
	type?: "color" | "image" | "text"
}

/** Collapses repeated slugs onto their highest count, then sorts by decoded label. */
function dedupeTerms(terms: readonly SourceFacetTerm[]) {
	const found = new Map<string, SourceFacetTerm>()

	for (const term of terms) {
		const existing = found.get(term.slug)
		found.set(term.slug, {
			...term,
			count: Math.max(existing?.count ?? 0, term.count),
		})
	}

	return Array.from(found.values()).sort((a, b) => decodeHtmlEntities(a.name).localeCompare(decodeHtmlEntities(b.name)))
}

function humanizeTaxonomy(taxonomy: string) {
	const words = taxonomy.replace(/^pa_/, "").replaceAll("_", " ").trim()
	return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : taxonomy
}

/**
 * Attribute and taxonomy counts from the current page of products.
 *
 * Only used when the filters request failed: these count what this page shows rather than the whole
 * collection, which is narrower than the truth but better than an empty sidebar.
 */
function attributeTermsFromProducts(products: readonly CollectionProduct[]) {
	const terms = new Map<string, SourceFacetTerm>()

	for (const product of products) {
		for (const attribute of product.attributes) {
			if (!attribute.taxonomy) continue
			for (const term of attribute.terms) {
				const key = `${attribute.taxonomy}:${term.id}`
				const existing = terms.get(key)
				terms.set(key, {
					count: (existing?.count ?? 0) + 1,
					id: term.id,
					name: term.name,
					slug: term.slug,
					taxonomy: attribute.taxonomy,
					type: "text",
				})
			}
		}
	}

	return Array.from(terms.values())
}

export type CollectionModelInput = {
	/** The store's filters response, or `null` when that request failed. */
	filters: ProductFilters | null
	/** True while the next result set is on its way. Surfaced on `filters` and `products`. */
	isPending?: boolean
	/** The taxonomy whose tree the store counted. */
	navigationTaxonomy?: string
	/** The store's product listing for the current query. */
	products: ProductList
	/** The current URL state, parsed. */
	query: CollectionQuery
	/** The page's classification scope. `null` on a "shop all" page. */
	scope?: CollectionScope | null
	/** The orderings offered in the sort control. The first is the default. */
	sortPresets?: readonly CollectionSortPreset[]
	/** Heading for the availability group. */
	stockLabel?: string
	/** Override any availability label. */
	stockLabels?: Partial<Record<CollectionStockStatus, string>>
	/** The product request failed. */
	unavailable?: boolean
	/**
	 * Writes the collection's query parameters, clearing any set to `null`.
	 *
	 * The adapter decides how: a router push, a history entry, a nuqs transition. The model only decides what, including the
	 * rule that any refinement resets paging.
	 */
	write: (patch: CollectionQueryPatch) => void
}

/**
 * Builds the collection's model: the facet groups, the scope tree, the sort options and the paging, each control wired to
 * `write`.
 *
 * The React adapter calls this inside a memo. Any other framework calls it wherever its state lives; nothing here is
 * React-specific.
 *
 * @example
 * ```ts
 * const model = buildCollectionModel({
 * 	...collection, // what loadProductCollection returned
 * 	query,
 * 	scope,
 * 	write: (patch) => router.push(`?${serializeCollectionQuery({ ...query, ...patch })}`),
 * })
 *
 * model.filters.groups[0].terms[0].toggle()
 * model.sort.set("price-asc")
 * model.products.setPage(2)
 * ```
 */
export function buildCollectionModel({
	filters,
	isPending = false,
	navigationTaxonomy = defaultNavigationTaxonomy,
	products,
	query,
	scope = null,
	sortPresets = defaultCollectionSortPresets,
	stockLabel = "Availability",
	stockLabels,
	unavailable = false,
	write,
}: CollectionModelInput): CollectionModel {
	function commit(next: CollectionQueryPatch) {
		// Page 3 of the old result set means nothing in the new one.
		write({ page: null, ...next })
	}

	function toggleAttribute(value: string, selected: boolean) {
		const current = query.attribute
		const next = selected ? (current.includes(value) ? current : [...current, value]) : current.filter((item) => item !== value)
		commit({ attribute: next.length > 0 ? next : null })
	}

	const items = products.items
	// Resolved rather than read raw: an unknown token must still highlight a real option.
	const activeSort = resolveSortPreset(sortPresets, query.sort)
	const minorUnit = filters?.currencyFormat.currencyMinorUnit ?? items[0]?.currencyFormat.currencyMinorUnit ?? 2
	const divisor = 10 ** minorUnit
	const prices = items.map((product) => product.prices.price / divisor)
	const boundsMinimum = filters ? Math.floor(filters.priceRange.minPrice / divisor) : Math.floor(Math.min(...prices, 0))
	const boundsMaximum = Math.max(
		filters ? Math.ceil(filters.priceRange.maxPrice / divisor) : Math.ceil(Math.max(...prices, 100)),
		boundsMinimum + 1,
	)

	const attributeLabels = new Map(
		items
			.flatMap((product) => product.attributes)
			.flatMap((attribute) => (attribute.taxonomy ? [[attribute.taxonomy, decodeHtmlEntities(attribute.name)] as const] : [])),
	)

	function attributeGroups(source: readonly SourceFacetTerm[]): CollectionFilterGroup[] {
		const byTaxonomy = new Map<string, SourceFacetTerm[]>()
		for (const term of source) {
			if (term.count <= 0) continue
			const list = byTaxonomy.get(term.taxonomy) ?? []
			list.push(term)
			byTaxonomy.set(term.taxonomy, list)
		}

		const selectedValues = query.attribute

		return Array.from(byTaxonomy, ([taxonomy, groupTerms]) => {
			const terms = dedupeTerms(groupTerms).map((term) => {
				const value = `${taxonomy}:${term.slug}`
				const selected = selectedValues.includes(value)
				return {
					count: term.count,
					label: decodeHtmlEntities(term.name),
					selected,
					slug: term.slug,
					swatch: term.swatch,
					toggle: (next?: boolean) => toggleAttribute(value, next ?? !selected),
					type: term.type,
					value,
				}
			})

			return {
				activeCount: terms.filter((term) => term.selected).length,
				clear: () => {
					const kept = selectedValues.filter((item) => !item.startsWith(`${taxonomy}:`))
					commit({ attribute: kept.length > 0 ? kept : null })
				},
				hasSwatches: terms.some((term) => term.type === "color" || term.type === "image"),
				id: `attribute:${taxonomy}`,
				kind: "attribute" as const,
				label: attributeLabels.get(taxonomy) ?? humanizeTaxonomy(taxonomy),
				taxonomy,
				terms,
			}
		}).sort((a, b) => a.label.localeCompare(b.label))
	}

	/**
	 * The scope tree. Counts are taken over the page's own scope and never narrowed by a child,
	 * so a child term cannot drop to zero and vanish the way a sidebar facet would.
	 */
	const scopeTerms: CollectionScopeTerm[] = (filters?.taxonomyTerms ?? [])
		.filter((term) => term.taxonomy === navigationTaxonomy)
		.map((term) => ({
			count: term.count,
			id: term.id,
			label: decodeHtmlEntities(term.name),
			// WordPress reports a root term's parent as 0.
			parentId: term.parentId ? term.parentId : null,
			slug: term.slug,
			taxonomy: term.taxonomy,
		}))
		.sort((a, b) => a.label.localeCompare(b.label))

	const currentTerm = scopeTerms.find((term) => term.slug === scope?.term) ?? null

	// Scoped to a term the store didn't return: show nothing rather than the wrong branch.
	const childTerms = scope && !currentTerm ? [] : scopeTerms.filter((term) => term.parentId === (currentTerm?.id ?? null))

	const stockCounts = filters?.stockStatuses.length
		? filters.stockStatuses
		: [
				{
					count: items.filter((product) => product.isInStock).length,
					status: "instock" as const,
				},
				{
					count: items.filter((product) => !product.isInStock).length,
					status: "outofstock" as const,
				},
			]

	const stockTerms = stockCounts
		.filter((item) => item.count > 0)
		.map((item) => {
			const selected = query.stock.includes(item.status)
			return {
				count: item.count,
				label: stockLabels?.[item.status] ?? defaultStockLabels[item.status],
				selected,
				slug: item.status,
				toggle: (next?: boolean) => {
					const wanted = next ?? !selected
					const nextStock = wanted
						? query.stock.includes(item.status)
							? query.stock
							: [...query.stock, item.status]
						: query.stock.filter((status) => status !== item.status)
					commit({ stock: nextStock.length > 0 ? nextStock : null })
				},
				value: item.status,
			}
		})

	const groups: CollectionFilterGroup[] = [
		{
			activeCount: stockTerms.filter((term) => term.selected).length,
			clear: () => commit({ stock: null }),
			hasSwatches: false,
			id: "stock",
			kind: "stock" as const,
			label: stockLabel,
			taxonomy: "stock",
			terms: stockTerms,
		},
		...attributeGroups(filters?.attributeTerms ?? attributeTermsFromProducts(items)),
	].filter((group) => group.terms.length > 0)

	const hasPriceFilter = query.minPrice !== null || query.maxPrice !== null
	const selectedMinimum = clamp(query.minPrice ?? boundsMinimum, boundsMinimum, boundsMaximum)
	const selectedMaximum = clamp(query.maxPrice ?? boundsMaximum, selectedMinimum, boundsMaximum)

	return {
		scope: {
			children: childTerms,
			current: currentTerm,
			taxonomy: navigationTaxonomy,
			terms: scopeTerms,
		},
		filters: {
			activeCount: groups.reduce((total, group) => total + group.activeCount, 0) + (hasPriceFilter ? 1 : 0),
			clearAll: () =>
				commit({
					attribute: null,
					maxPrice: null,
					minPrice: null,
					q: null,
					stock: null,
				}),
			groups,
			isPending,
			price: {
				currencySymbol: filters?.currencyFormat.currencySymbol ?? "$",
				isActive: hasPriceFilter,
				maximum: boundsMaximum,
				minimum: boundsMinimum,
				reset: () => commit({ maxPrice: null, minPrice: null }),
				set: (nextMinimum, nextMaximum) =>
					commit({
						maxPrice: nextMaximum >= boundsMaximum ? null : nextMaximum,
						minPrice: nextMinimum <= boundsMinimum ? null : nextMinimum,
					}),
				value: [selectedMinimum, selectedMaximum],
			},
			search: {
				clear: () => commit({ q: null }),
				set: (next) => commit({ q: next.trim() || null }),
				value: query.q,
			},
		},
		products: {
			hasNextPage: products.meta.hasNextPage,
			hasPreviousPage: products.meta.hasPrevPage,
			isPending,
			items,
			page: products.meta.page,
			// Paging is the one write that must not reset the page.
			setPage: (page) => write({ page: page > 1 ? page : null }),
			totalItems: products.meta.totalItems,
			totalPages: products.meta.totalPages,
			unavailable,
		},
		sort: {
			options: sortPresets.map((preset) => ({
				label: preset.label,
				selected: preset.value === activeSort.value,
				value: preset.value,
			})),
			// The first preset is the default order, so it stays out of the URL.
			set: (next) => commit({ sort: next === sortPresets[0]?.value ? null : next }),
			value: activeSort.value,
		},
	}
}
