"use client"

import { useLayoutEffect, useMemo, useRef } from "react"
import type { CheckoutFieldSources } from "../checkout-field-document"
import { checkoutFieldsSchema, resolveCheckoutFields } from "../checkout-fields"
import type { CheckoutFieldsApi, CheckoutFieldValues } from "../types"
import { useCartActivity, useCartQuery, useCheckoutQuery } from "./session-queries"
import { useStorefront } from "./storefront"

export type { CheckoutFieldDiagnostic, CheckoutFieldGroup, CheckoutFieldsApi, CheckoutFieldValues } from "../types"
export type CheckoutFieldsOptions = { values?: CheckoutFieldValues }

/** Four-group checkout metadata and candidate validation; the application owns values and submission. */
export function useCheckoutFields({ values }: CheckoutFieldsOptions = {}): CheckoutFieldsApi {
	const { storefront, error: storefrontError, isLoading: storefrontLoading } = useStorefront()
	const checkoutQuery = useCheckoutQuery()
	const cartQuery = useCartQuery(checkoutQuery.data !== undefined)
	const activity = useCartActivity()
	const sources = useMemo<CheckoutFieldSources>(
		() => ({ storefront, checkout: checkoutQuery.data ?? null, cart: cartQuery.data ?? null }),
		[storefront, checkoutQuery.data, cartQuery.data],
	)
	const committed = useRef(sources)
	useLayoutEffect(() => {
		committed.current = sources
	}, [sources])
	const validator = useMemo(() => checkoutFieldsSchema(() => committed.current), [])
	const { fields, defaultValues, unsupported } = useMemo(() => resolveCheckoutFields(sources, values), [sources, values])
	return {
		fields,
		defaultValues,
		schema: storefront && defaultValues ? validator : null,
		unsupported,
		isLoading: storefrontLoading || checkoutQuery.isPending || (!sources.cart && cartQuery.isFetching),
		isRepricing: activity.isRepricing || activity.isSelectingRate,
		error: storefrontError ?? checkoutQuery.error ?? cartQuery.error,
	}
}
