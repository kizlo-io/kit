import type { CollectionProduct, CollectionSearchParams } from "@kizlo/woocommerce-kit"
import { useProductCollection } from "@kizlo/woocommerce-kit/react/collection"
import { ProductCollection } from "@kizlo/woocommerce-kit/react/collection/server"
import { useInView } from "@kizlo/woocommerce-kit/react/in-view"
import type { ActiveKizloClient } from "kizlo"
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
	return (
		<ProductCollection
			attributeTaxonomies={["pa_color"]}
			client={client}
			searchParams={searchParams}
			scopeQuery={{ taxonomy: "product_cat", parameter: "category" }}
		>
			{children}
		</ProductCollection>
	)
}

export function Grid() {
	const { products, filters, ref, loadMore, setSort, toggleAttribute, setScope, getScopeLinkProps, formatPrice } = useProductCollection({
		infiniteScroll: { rootMargin: "200px 0px", onChange: (_visible, entry) => void entry.target },
	})
	const items: readonly CollectionProduct[] = products.items
	// @ts-expect-error actions are not embedded in data records
	products.setPage(2)
	// @ts-expect-error actions are not embedded in filter records
	filters.clearAll()
	// @ts-expect-error observer options belong inside infiniteScroll
	useProductCollection({ rootMargin: "200px" })
	const { ref: independentRef } = useInView({ threshold: [0, 0.5], skip: true })
	void [setSort, toggleAttribute, setScope, getScopeLinkProps, formatPrice, independentRef, loadMore]
	return (
		<output ref={ref} aria-busy={products.isPending}>
			{items.map(({ id }) => id).join(",")}
		</output>
	)
}
