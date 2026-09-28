import type { ListProductInput, ProductFilters, ProductList, RetrieveProductFiltersInput } from "@kizlo/woocommerce"

/**
 * The slice of a Kizlo server client the collection calls: the two WooCommerce product endpoints and nothing else.
 *
 * Structural on purpose. The real client is generated per app from its own WordPress introspection, so it carries every
 * integration that app installs; typing the prop against that would tie this package to one app's contract. Anything that
 * answers these two calls satisfies it, which also makes the component testable with a stub.
 */
export type ProductStoreClient = {
	woocommerce: {
		products: {
			list: { call(input: { query: ListProductInput }): Promise<ProductList> }
			filters: { call(input: { query: RetrieveProductFiltersInput }): Promise<ProductFilters | null> }
		}
	}
}
