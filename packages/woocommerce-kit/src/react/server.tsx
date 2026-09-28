/**
 * Server half of the product collection: reads the URL, talks to the store, wraps the provider.
 *
 * Because the client half writes the URL with `shallow: false`, every filter change re-runs this component: the listing is
 * server-rendered on first load *and* on every subsequent change, so there is no client-side product fetching and nothing to
 * hydrate.
 *
 * Both requests and the query parsing live in the package root, which knows nothing about React. What is left here is the
 * RSC shape.
 */

import { type CollectionScope, type CollectionSearchParams, type CollectionSortPreset, parseCollectionQuery } from "../contract"
import { loadProductCollection } from "../request"
import type { ProductStoreClient } from "../store"
import { ProductCollectionProvider, type ProductCollectionProviderProps } from "./client"

export type ProductCollectionProps = Omit<ProductCollectionProviderProps, "filters" | "navigationTaxonomy" | "products" | "unavailable"> & {
	/**
	 * Attribute taxonomies to offer as facets, e.g. `["pa_color", "pa_size"]`. `[]` for none.
	 *
	 * Required, and deliberately so. This is a property of the store, not of any one result set: deriving it from the
	 * products on screen would rebuild the sidebar on every page and drop any attribute the current page happens not to use.
	 * Knowing it up front is also what lets both requests go out together.
	 */
	attributeTaxonomies: readonly string[]
	/**
	 * Your app's Kizlo server client, the one `createKizlo` returned, with the WooCommerce integration installed.
	 *
	 * Passed in rather than imported: the client is generated per app from its own WordPress introspection, so this package
	 * cannot reach it. A server component also cannot read React context, which is why this is a prop and not a provider.
	 */
	client: ProductStoreClient
	/**
	 * The store's currency minor unit, the number of decimal places, 2 for most currencies.
	 *
	 * URL prices are major units and the store wants minor units. This is a store constant, so taking it as configuration
	 * keeps the conversion from depending on a response.
	 */
	currencyMinorUnit?: number
	/** Products per page. */
	perPage?: number
	/**
	 * The classification this page is scoped to, e.g. `{ taxonomy: "product_cat", term: slug }`. Omit for a "shop all" page.
	 *
	 * Scope, not a filter: the shopper changes it by navigating, never by unticking a box. Any product taxonomy works, so the
	 * same component backs `/collections/bags`, `/brands/nike` and anything custom.
	 */
	scope?: CollectionScope
	/**
	 * Forward the page's own search params. Next's `searchParams` promise, a resolved record, or a `URLSearchParams`.
	 *
	 * Loose on purpose: every RSC framework hands these over in a slightly different shape, and none of that is worth a
	 * separate entry point.
	 */
	searchParams: CollectionSearchParams | Promise<CollectionSearchParams>
	/**
	 * The orderings offered in the sort control. Defaults to `defaultCollectionSortPresets`.
	 *
	 * The first entry is the collection's default order, so a seasonal page can lead with `"newest"` and a clearance page
	 * with `"price-asc"` without touching this component. Pass a subset to offer fewer, or your own `orderBy`/`order` pairs
	 * to offer something else entirely.
	 */
	sortPresets?: readonly CollectionSortPreset[]
}

/**
 * A filterable, sortable, paginated product listing, server-rendered on every change.
 *
 * The only piece a page mounts. It parses the URL, runs both store requests and provides the model to everything below, so
 * the children are yours: each one reads the slice it needs from `useProductCollection()` and renders whatever you like.
 *
 * @example
 * ```tsx
 * // app/collections/[slug]/page.tsx
 * import { ProductCollection } from "@kizlo/woocommerce-kit/react/server"
 * import { client } from "@/lib/kizlo/server"
 *
 * export default async function CollectionPage({ params, searchParams }) {
 * 	const { slug } = await params
 *
 * 	return (
 * 		<ProductCollection
 * 			attributeTaxonomies={["pa_color", "pa_size"]}
 * 			client={client}
 * 			scope={{ taxonomy: "product_cat", term: slug }}
 * 			searchParams={searchParams}
 * 		>
 * 			<Filters />
 * 			<ScopeNav />
 * 			<Sort />
 * 			<Grid />
 * 		</ProductCollection>
 * 	)
 * }
 * ```
 */
export async function ProductCollection({
	attributeTaxonomies,
	children,
	client,
	currencyMinorUnit = 2,
	perPage = 12,
	searchParams,
	scope,
	sortPresets,
	...providerProps
}: ProductCollectionProps) {
	const query = parseCollectionQuery(await searchParams)
	const collection = await loadProductCollection({
		attributeTaxonomies,
		client,
		currencyMinorUnit,
		perPage,
		query,
		scope,
		sortPresets,
	})

	return (
		<ProductCollectionProvider
			{...providerProps}
			filters={collection.filters}
			navigationTaxonomy={collection.navigationTaxonomy}
			products={collection.products}
			scope={scope ?? null}
			sortPresets={sortPresets}
			unavailable={collection.unavailable}
		>
			{children}
		</ProductCollectionProvider>
	)
}
