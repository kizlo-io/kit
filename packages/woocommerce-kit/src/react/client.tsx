"use client"

/**
 * Client half of the product collection: the context, the URL writers and the pending state.
 *
 * Renders no markup beyond `children`. Every filter control, the sort control and the grid are the consumer's: a sidebar, a
 * bar of dropdowns, a drawer, chips, all the same `groups.map(...)`.
 *
 * It never fetches. The server half does that and passes the store's responses in, and because every write here uses nuqs
 * with `shallow: false`, changing a filter re-runs that server component and the new data arrives as props. So the listing
 * is always server-rendered, never a client refetch, and `isPending` covers the round trip.
 *
 * The model itself is built in `../model`, which knows nothing about React. This file is the adapter: hooks in, one
 * `write` callback out.
 */

import type { ProductFilters, ProductList } from "@kizlo/woocommerce"
import { useQueryStates } from "nuqs"
import { createContext, type ReactNode, useContext, useMemo, useTransition } from "react"
import {
	type CollectionScope,
	type CollectionSortPreset,
	type CollectionStockStatus,
	defaultCollectionSortPresets,
	defaultNavigationTaxonomy,
} from "../contract"
import { buildCollectionModel, type CollectionModel } from "../model"
import { collectionSearchParams } from "./params"

/**
 * The model's types, re-exported so a component reads its hook and the types it returns from one specifier. Type-only, so
 * nothing reaches the bundle.
 */
export type {
	CollectionFilterGroup,
	CollectionFilterGroupKind,
	CollectionFiltersApi,
	CollectionFilterTerm,
	CollectionModel,
	CollectionPriceFilter,
	CollectionProduct,
	CollectionProductsApi,
	CollectionScopeApi,
	CollectionScopeTerm,
	CollectionSortApi,
	CollectionSortOption,
} from "../model"

/** @deprecated Use `CollectionModel`. */
export type ProductCollectionContextValue = CollectionModel

const ProductCollectionContext = createContext<CollectionModel | null>(null)

export type ProductCollectionProviderProps = {
	children: ReactNode
	/** The store's filters response, or `null` when that request failed. */
	filters: ProductFilters | null
	/** The taxonomy whose tree the store counted. Supplied by the server half. */
	navigationTaxonomy?: string
	/** The store's product listing for the current URL. */
	products: ProductList
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
}

/**
 * Provides the collection model to everything below it.
 *
 * `<ProductCollection>` mounts this for you. Reach for it directly only when you are running the store requests yourself,
 * for instance from a framework whose data loading is not an async component.
 *
 * @example
 * ```tsx
 * import { loadProductCollection, parseCollectionQuery } from "@kizlo/woocommerce-kit"
 * import { ProductCollectionProvider } from "@kizlo/woocommerce-kit/react"
 *
 * const query = parseCollectionQuery(searchParams)
 * const collection = await loadProductCollection({ attributeTaxonomies: ["pa_color"], client, query, scope })
 *
 * return (
 * 	<ProductCollectionProvider {...collection} scope={scope}>
 * 		<Filters />
 * 		<Grid />
 * 	</ProductCollectionProvider>
 * )
 * ```
 */
export function ProductCollectionProvider({
	children,
	filters,
	navigationTaxonomy = defaultNavigationTaxonomy,
	products,
	scope = null,
	sortPresets = defaultCollectionSortPresets,
	stockLabel = "Availability",
	stockLabels,
	unavailable = false,
}: ProductCollectionProviderProps) {
	const [isPending, startTransition] = useTransition()
	const [query, setQuery] = useQueryStates(collectionSearchParams, {
		history: "push",
		// Re-runs the server component so the next result set is fetched there, not here.
		shallow: false,
		startTransition,
	})

	const model = useMemo(
		() =>
			buildCollectionModel({
				filters,
				isPending,
				navigationTaxonomy,
				products,
				query,
				scope,
				sortPresets,
				stockLabel,
				stockLabels,
				unavailable,
				write: (patch) => void setQuery(patch),
			}),
		[filters, isPending, navigationTaxonomy, products, query, scope, setQuery, sortPresets, stockLabel, stockLabels, unavailable],
	)

	return <ProductCollectionContext.Provider value={model}>{children}</ProductCollectionContext.Provider>
}

/**
 * The whole collection API: `{ filters, products, scope, sort }`. Destructure what you need.
 *
 * One hook rather than one per slice, because per-slice hooks would only be naming sugar here: there is a single provider
 * value, so every consumer re-renders whenever any slice changes. Separate contexts would not help either, since one server
 * response produces all four slices at once and they never change independently.
 *
 * @example
 * ```tsx
 * "use client"
 * import { useProductCollection } from "@kizlo/woocommerce-kit/react"
 *
 * export function Filters() {
 * 	const { filters } = useProductCollection()
 *
 * 	return filters.groups.map((group) => (
 * 		<fieldset key={group.id}>
 * 			<legend>{group.label}</legend>
 * 			{group.terms.map((term) => (
 * 				<label key={term.value}>
 * 					<input checked={term.selected} onChange={() => term.toggle()} type="checkbox" />
 * 					{term.label} ({term.count})
 * 				</label>
 * 			))}
 * 		</fieldset>
 * 	))
 * }
 * ```
 */
export function useProductCollection(): CollectionModel {
	const value = useContext(ProductCollectionContext)
	if (!value) {
		throw new Error("useProductCollection must be used inside <ProductCollection>.")
	}
	return value
}
