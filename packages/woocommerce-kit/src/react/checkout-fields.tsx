"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { type CheckoutFieldSources, checkoutDefaults } from "../checkout-field-document"
import {
	checkoutFieldUpdates,
	checkoutFormInput,
	checkoutFormOutput,
	checkoutFormSchema,
	isCheckoutFormName,
	resolveCheckoutFormState,
} from "../checkout-form"
import type { CheckoutFieldsApi, CheckoutFieldsOptions, CheckoutFormValues } from "../types"
import { useCartActivity, useCartQuery, useCheckoutQuery } from "./session-queries"
import { useStorefront } from "./storefront"

export type {
	CheckoutFieldBinding,
	CheckoutFieldDiagnostic,
	CheckoutFieldGroup,
	CheckoutFieldsApi,
	CheckoutFieldsOptions,
	CheckoutFieldUpdate,
	CheckoutFieldValue,
	CheckoutFieldValues,
	CheckoutFormField,
	CheckoutFormFieldName,
	CheckoutFormId,
	CheckoutFormValues,
	CheckoutNativeControl,
} from "../types"

/** The form owns editable values; only field metadata and the initial snapshot are retained here. */
export function useCheckoutFields(options: CheckoutFieldsOptions = {}): CheckoutFieldsApi {
	const { storefront, error: storefrontError, isLoading: storefrontLoading } = useStorefront()
	const checkoutQuery = useCheckoutQuery()
	const cartQuery = useCartQuery(checkoutQuery.data !== undefined)
	const activity = useCartActivity()
	const sources = useMemo<CheckoutFieldSources>(
		() => ({ storefront, checkout: checkoutQuery.data ?? null, cart: cartQuery.data ?? null }),
		[storefront, checkoutQuery.data, cartQuery.data],
	)
	const committed = useRef(sources)
	const accessors = useRef(options)
	const initial = useRef<{ session: string; values: CheckoutFormValues } | null>(null)
	const defaults = useCallback((source: CheckoutFieldSources) => {
		const raw = source.storefront ? checkoutDefaults(source) : null
		if (!raw || !source.checkout) return null
		const session = JSON.stringify([source.checkout.orderId, source.checkout.orderKey])
		if (initial.current?.session !== session) initial.current = { session, values: checkoutFormInput(raw) }
		return initial.current.values
	}, [])
	const [state, setState] = useState(() => resolveCheckoutFormState(sources, undefined, defaults(sources)))
	useLayoutEffect(() => {
		accessors.current = options
	})
	useLayoutEffect(() => {
		committed.current = sources
		const defaultValues = defaults(sources)
		const values = accessors.current.getValues?.()
		setState((previous) => resolveCheckoutFormState(sources, values, defaultValues, previous))
	}, [sources, defaults])
	const reevaluate = useCallback(() => {
		const source = committed.current
		const defaultValues = defaults(source)
		const values = accessors.current.getValues?.()
		setState((previous) => resolveCheckoutFormState(source, values, defaultValues, previous))
	}, [defaults])
	const changing = useRef(false)
	const handleFieldChange = useCallback<CheckoutFieldsApi["handleFieldChange"]>(
		(name, _value) => {
			if (changing.current || !isCheckoutFormName(committed.current, name)) return
			const { getValues, setValues } = accessors.current
			if (!getValues) throw new Error("Checkout field events require getValues")
			changing.current = true
			try {
				getValues()
				const updates = checkoutFieldUpdates(name)
				if (updates.length) {
					if (!setValues) throw new Error("Country field dependencies require setValues")
					setValues(updates)
				}
				const values = getValues()
				const source = committed.current
				const defaultValues = defaults(source)
				setState((previous) => resolveCheckoutFormState(source, values, defaultValues, previous))
			} finally {
				changing.current = false
			}
		},
		[defaults],
	)
	const validator = useMemo(() => checkoutFormSchema(() => committed.current), [])
	const getOutput = useCallback<CheckoutFieldsApi["getOutput"]>((values) => checkoutFormOutput(committed.current, values), [])
	return {
		fields: state.fields,
		defaultValues: state.defaultValues,
		unsupported: state.unsupported,
		canUseShippingAsBilling: state.canUseShippingAsBilling,
		schema: storefront && state.defaultValues && sources.checkout && !sources.checkout.isPaid && sources.cart ? validator : null,
		handleFieldChange,
		reevaluate,
		getInput: checkoutFormInput,
		getOutput,
		isLoading: storefrontLoading || checkoutQuery.isPending || (!sources.cart && cartQuery.isFetching),
		isRepricing: activity.isRepricing || activity.isSelectingRate,
		error: storefrontError ?? checkoutQuery.error ?? cartQuery.error,
	}
}
