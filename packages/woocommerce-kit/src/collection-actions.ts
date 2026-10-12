import {
	type CollectionQuery,
	type CollectionQueryPatch,
	type CollectionSortPreset,
	type CollectionStockStatus,
	defaultCollectionSortPresets,
} from "./contract"
import type { CollectionModel } from "./model"
import { formatStoreMoney } from "./money"

export type CollectionActions = {
	setPage: (page: number) => void
	setSort: (sort: string) => void
	setSearch: (search: string) => void
	setPriceRange: (minimum: number | null, maximum: number | null) => void
	toggleAttribute: (value: string, selected?: boolean) => void
	toggleStock: (status: CollectionStockStatus, selected?: boolean) => void
	/** Omit taxonomy to clear every refinement; pass stock, price, search or an attribute taxonomy to clear one. */
	clearFilters: (taxonomy?: string) => void
	/** Formats a major-unit price, such as the values in filters.price. */
	formatPrice: (price: number) => string
}

export function createCollectionActions({
	query,
	model,
	write,
	sortPresets = defaultCollectionSortPresets,
	locale,
}: {
	query: CollectionQuery
	model: CollectionModel
	write: (patch: CollectionQueryPatch) => void
	sortPresets?: readonly CollectionSortPreset[]
	locale?: string
}): CollectionActions {
	const commit = (patch: CollectionQueryPatch) => write({ page: null, ...patch })
	function toggle<T extends string>(current: T[], value: T, selected = !current.includes(value)) {
		const next = selected ? [...new Set([...current, value])] : current.filter((item) => item !== value)
		return next.length ? next : null
	}
	return {
		setPage: (page) => write({ page: page > 1 ? page : null }),
		setSort: (sort) => commit({ sort: sort === sortPresets[0]?.value ? null : sort }),
		setSearch: (search) => commit({ q: search.trim() || null }),
		setPriceRange: (minimum, maximum) =>
			commit({
				minPrice: minimum === null || minimum <= model.filters.price.minimum ? null : minimum,
				maxPrice: maximum === null || maximum >= model.filters.price.maximum ? null : maximum,
			}),
		toggleAttribute: (value, selected) => commit({ attribute: toggle(query.attribute, value, selected) }),
		toggleStock: (status, selected) => commit({ stock: toggle(query.stock, status, selected) }),
		clearFilters: (taxonomy) => {
			if (taxonomy === "stock") commit({ stock: null })
			else if (taxonomy === "price") commit({ minPrice: null, maxPrice: null })
			else if (taxonomy === "search") commit({ q: null })
			else if (taxonomy) {
				const kept = query.attribute.filter((value) => !value.startsWith(`${taxonomy}:`))
				commit({ attribute: kept.length ? kept : null })
			} else commit({ attribute: null, minPrice: null, maxPrice: null, q: null, stock: null })
		},
		formatPrice: (price) => {
			const currency = model.filters.price.currencyFormat
			return currency ? formatStoreMoney(Math.round(price * 10 ** currency.currencyMinorUnit), currency, locale) : String(price)
		},
	}
}
