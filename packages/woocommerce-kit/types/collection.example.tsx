import { type CollectionSearchParams, loadProductCollection, parseCollectionQuery, productCollectionQueryKey } from "@kizlo/woocommerce-kit"
import {
	BrowserProductCollection,
	type BrowserProductCollectionProps,
	collectionSearchParams,
	useProductCollection,
} from "@kizlo/woocommerce-kit/react/collection"
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { parseAsString, useQueryState, useQueryStates } from "nuqs"
import type { ReactNode } from "react"

export async function ServerCollection({
	client,
	searchParams,
	children,
}: {
	client: ActiveKizloClient
	searchParams: CollectionSearchParams
	children: ReactNode
}) {
	const query = parseCollectionQuery(searchParams)
	const attributeTaxonomies = ["pa_color"]
	const queryClient = new QueryClient()
	await queryClient.prefetchQuery({
		queryKey: productCollectionQueryKey({ query, attributeTaxonomies }),
		queryFn: () => loadProductCollection({ client, query, attributeTaxonomies }),
	})
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<BrowserProductCollection attributeTaxonomies={attributeTaxonomies} initialQuery={query}>
				{children}
			</BrowserProductCollection>
		</HydrationBoundary>
	)
}

export function QueryScopeCollection(props: Omit<BrowserProductCollectionProps, "scope">) {
	const [category] = useQueryState("category", parseAsString)
	const [query] = useQueryStates(collectionSearchParams)
	const scope = category ? { taxonomy: "product_cat", term: category } : undefined
	const resetKey = JSON.stringify(productCollectionQueryKey({ ...props, scope, query: { ...query, page: 1 } }))
	return (
		<BrowserProductCollection {...props} scope={scope}>
			<Grid key={resetKey} />
		</BrowserProductCollection>
	)
}

function Grid() {
	const { products, filters } = useProductCollection()
	const ids: readonly number[] = products.items.map(({ id }) => id)
	return <output aria-busy={products.isPending || filters.isPending}>{ids.join(",")}</output>
}
