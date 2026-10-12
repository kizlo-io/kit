import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { type CollectionSearchParams, parseCollectionQuery, resolveCollectionScope } from "../contract"
import { emptyListing, loadProductCollection, productCollectionQueryKey } from "../request"
import { BrowserProductCollection, type BrowserProductCollectionProps } from "./collection"

export type ProductCollectionProps = Omit<BrowserProductCollectionProps, "initialQuery" | "initialSearchParams"> & {
	client: ActiveKizloClient
	searchParams: CollectionSearchParams | Promise<CollectionSearchParams>
}

/** Initializes a browser collection once; only native dehydrated data crosses the client boundary. */
export async function ProductCollection({
	client,
	searchParams,
	currencyMinorUnit = "auto",
	scopeQuery,
	scope,
	children,
	...config
}: ProductCollectionProps) {
	const params = await searchParams
	const initialSearchParams =
		params instanceof URLSearchParams
			? params.toString()
			: new URLSearchParams(
					Object.entries(params).flatMap(([name, value]) =>
						value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((item) => [name, item]),
					),
				).toString()
	const query = parseCollectionQuery(params)
	const initialScope = scopeQuery ? resolveCollectionScope(params, scopeQuery) : (scope ?? undefined)
	const input = {
		...config,
		currencyMinorUnit,
		query,
		scope: initialScope,
		navigationTaxonomy: scopeQuery?.taxonomy ?? config.navigationTaxonomy,
	}
	const key = productCollectionQueryKey(input)
	const cache = new QueryClient()
	try {
		await cache.prefetchQuery({
			queryKey: key,
			queryFn: async () => {
				try {
					return await loadProductCollection({ ...input, client })
				} catch {
					return {
						filters: null,
						products: emptyListing(query.page),
						navigationTaxonomy: initialScope?.taxonomy ?? input.navigationTaxonomy ?? "product_cat",
						unavailable: true,
					}
				}
			},
		})
		return (
			<HydrationBoundary state={dehydrate(cache)}>
				<BrowserProductCollection
					{...config}
					currencyMinorUnit={currencyMinorUnit}
					scope={initialScope}
					scopeQuery={scopeQuery}
					initialQuery={query}
					initialSearchParams={initialSearchParams}
					key={JSON.stringify(key)}
				>
					{children}
				</BrowserProductCollection>
			</HydrationBoundary>
		)
	} finally {
		cache.clear()
	}
}
