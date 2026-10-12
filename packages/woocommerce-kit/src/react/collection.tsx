"use client"

import { isServer, useQuery } from "@tanstack/react-query"
import { useKizloContext } from "kizlo/react"
import { useQueryStates } from "nuqs"
import { type CollectionQuery, defaultNavigationTaxonomy } from "../contract"
import { buildCollectionModel } from "../model"
import { emptyListing, type LoadProductCollectionInput, loadProductCollection, productCollectionQueryKey } from "../request"
import type { ProductCollectionProviderProps } from "./client"
import { ProductCollectionContext } from "./collection-context"
import { useWooCommerceContext } from "./context"
import { collectionSearchParams } from "./params"

export { useProductCollection } from "./client"
export { collectionSearchParams } from "./params"

export type BrowserProductCollectionProps = Omit<
	ProductCollectionProviderProps,
	"filters" | "navigationTaxonomy" | "products" | "unavailable"
> &
	Omit<LoadProductCollectionInput, "client" | "query" | "scope"> & {
		/** The parsed URL that the server loaded. */
		initialQuery: CollectionQuery
	}

/**
 * Server-seeded collection whose subsequent URL changes fetch in the browser.
 * Reads the server-prefetched cache hydrated by the app's HydrationBoundary.
 * Needs the app's nuqs adapter, KizloProvider, QueryClientProvider and WooCommerceProvider.
 */
export function BrowserProductCollection({
	attributeTaxonomies,
	children,
	currencyMinorUnit,
	initialQuery,
	perPage,
	scope,
	sortPresets,
	stockLabel,
	stockLabels,
}: BrowserProductCollectionProps) {
	const { client } = useKizloContext()
	const { queryClient } = useWooCommerceContext()
	const [urlQuery, setQuery] = useQueryStates(collectionSearchParams, { history: "push", shallow: true })
	const query = isServer ? initialQuery : urlQuery
	const input = { attributeTaxonomies, currencyMinorUnit, perPage, query, scope: scope ?? undefined, sortPresets }
	const queryKey = productCollectionQueryKey(input)
	const { data, isError, isFetching, isPending } = useQuery(
		{
			enabled: !isServer,
			// A new selection must never display another selection's products or counts.
			placeholderData: () => undefined,
			queryFn: () => loadProductCollection({ ...input, client }),
			queryKey,
			refetchOnMount: false,
			refetchOnReconnect: false,
			refetchOnWindowFocus: false,
			retry: false,
			// Hydration restores failed entries without racing a browser mount retry.
			retryOnMount: false,
			// Revisit a cached URL by fetching again, while preserving the first server render on mount.
			staleTime: 0,
		},
		queryClient,
	)
	const model = buildCollectionModel({
		filters: data?.filters ?? null,
		isPending: isPending || isFetching,
		navigationTaxonomy: data?.navigationTaxonomy ?? scope?.taxonomy ?? defaultNavigationTaxonomy,
		products: data?.products ?? emptyListing(Math.max(1, query.page)),
		query,
		scope,
		sortPresets,
		stockLabel,
		stockLabels,
		unavailable: isError || data?.unavailable === true,
		write: (patch) => void setQuery(patch),
	})

	return <ProductCollectionContext.Provider value={model}>{children}</ProductCollectionContext.Provider>
}
