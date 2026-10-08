"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { checkoutAddressSource } from "../checkout-address"
import { checkoutSession, createCheckoutErrorBridge, projectCheckoutErrors } from "../checkout-errors"
import { type CheckoutFieldSources, checkoutDefaults } from "../checkout-field-document"
import {
	checkoutFieldUpdates,
	checkoutFormDecode,
	checkoutFormEncode,
	checkoutFormSchema,
	checkoutShippingToBillingUpdates,
	isCheckoutFormName,
	resolveCheckoutFormState,
} from "../checkout-form"
import type { CheckoutFieldsApi, CheckoutFieldsOptions, CheckoutFormValues } from "../types"
import { useCheckoutErrorState, useCheckoutErrorStore } from "./checkout-error-store"
import { useCartActivity, useCartQuery, useCheckoutQuery } from "./session-queries"
import { useStorefront } from "./storefront"

export type {
	CheckoutFieldBinding,
	CheckoutFieldDiagnostic,
	CheckoutFieldGroup,
	CheckoutFieldsApi,
	CheckoutFieldsOptions,
	CheckoutFieldsSection,
	CheckoutFieldUpdate,
	CheckoutFieldValue,
	CheckoutFieldValues,
	CheckoutFormField,
	CheckoutFormFieldName,
	CheckoutFormId,
	CheckoutFormValues,
	CheckoutNativeControl,
	CheckoutRegisteredFieldReference,
	CheckoutServerErrorCallbacks,
	CheckoutServerFieldError,
	CheckoutServerIssue,
	CheckoutValidationIssue,
} from "../types"

/** The form owns editable values; only field metadata and the initial snapshot are retained here. */
export function useCheckoutFields(options: CheckoutFieldsOptions = {}): CheckoutFieldsApi {
	const { storefront, error: storefrontError, isLoading: storefrontLoading } = useStorefront()
	const checkoutQuery = useCheckoutQuery()
	const cartQuery = useCartQuery(checkoutQuery.data !== undefined)
	const activity = useCartActivity()
	const errors = useCheckoutErrorStore()
	const errorState = useCheckoutErrorState(errors)
	const session = checkoutSession(checkoutQuery.data)
	useLayoutEffect(() => errors.syncSession(session), [errors, session])
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
		if (initial.current?.session !== session)
			initial.current = {
				session,
				values: { ...checkoutFormEncode(raw), useShippingAsBilling: checkoutAddressSource(source) === "shippingAddress" },
			}
		return initial.current.values
	}, [])
	const bridge = useMemo(() => createCheckoutErrorBridge(), [])
	const [state, setState] = useState(() => resolveCheckoutFormState(sources, undefined, defaults(sources)))
	const committedState = useRef(state)
	useLayoutEffect(() => {
		accessors.current = options
	})
	useLayoutEffect(() => {
		committed.current = sources
		const defaultValues = defaults(sources)
		const values = accessors.current.getValues?.()
		const next = resolveCheckoutFormState(sources, values, defaultValues, committedState.current)
		committedState.current = next
		setState(next)
	}, [sources, defaults])
	const reevaluate = useCallback(() => {
		const source = committed.current
		const defaultValues = defaults(source)
		const values = accessors.current.getValues?.()
		const next = resolveCheckoutFormState(source, values, defaultValues, committedState.current)
		committedState.current = next
		setState(next)
	}, [defaults])
	const projection = useMemo(
		() => projectCheckoutErrors(errorState.issues, sources, state.fields, { useShippingAsBilling: state.useShippingAsBilling }),
		[errorState.issues, sources, state],
	)
	const associated = useRef(projection.associations)
	const hasBridge = !!options.setErrors && !!options.clearErrors
	if (!!options.setErrors !== !!options.clearErrors) throw new Error("Checkout server errors require both setErrors and clearErrors")
	useLayoutEffect(() => {
		const model = committedState.current
		const next =
			model === state && committed.current === sources
				? projection
				: projectCheckoutErrors(errors.state.get().issues, committed.current, model.fields, {
						useShippingAsBilling: model.useShippingAsBilling,
					})
		associated.current = next.associations
		if (hasBridge)
			bridge.update(
				next.fields,
				(patches) => accessors.current.setErrors?.(patches),
				(names) => accessors.current.clearErrors?.(names),
			)
	}, [projection, sources, state, errors, bridge, hasBridge])
	useLayoutEffect(() => {
		if (!hasBridge) return
		const stop = errors.state.listen(({ issues }) => {
			const model = committedState.current
			const next = projectCheckoutErrors(issues, committed.current, model.fields, { useShippingAsBilling: model.useShippingAsBilling })
			associated.current = next.associations
			bridge.update(
				next.fields,
				(patches) => accessors.current.setErrors?.(patches),
				(names) => accessors.current.clearErrors?.(names),
			)
		})
		return () => {
			stop()
			bridge.cleanup((names) => accessors.current.clearErrors?.(names))
		}
	}, [errors, bridge, hasBridge])
	const changing = useRef(false)
	const handleFieldChange = useCallback<CheckoutFieldsApi["handleFieldChange"]>(
		(name, _value) => {
			if (changing.current || !isCheckoutFormName(committed.current, name)) return
			const { getValues, setValues } = accessors.current
			if (!getValues) throw new Error("Checkout field events require getValues")
			changing.current = true
			try {
				getValues()
				errors.clearIssues(new Set([...associated.current].filter(([, control]) => control === name).map(([id]) => id)))
				const updates = checkoutFieldUpdates(name)
				if (updates.length) {
					if (!setValues) throw new Error("Country field dependencies require setValues")
					setValues(updates)
				}
				const values = getValues()
				const source = committed.current
				const defaultValues = defaults(source)
				const next = resolveCheckoutFormState(source, values, defaultValues, committedState.current)
				committedState.current = next
				setState(next)
			} finally {
				changing.current = false
			}
		},
		[defaults, errors],
	)
	const copyShippingToBilling = useCallback(() => {
		if (changing.current) return
		const { getValues, setValues } = accessors.current
		if (!getValues || !setValues) throw new Error("Copying shipping to billing requires getValues and setValues")
		const updates = checkoutShippingToBillingUpdates(getValues())
		if (!updates.length) return
		changing.current = true
		try {
			setValues(updates)
			const changed = new Set(updates.map(({ name }) => name))
			errors.clearIssues(new Set([...associated.current].filter(([, control]) => changed.has(control)).map(([id]) => id)))
			reevaluate()
		} finally {
			changing.current = false
		}
	}, [errors, reevaluate])
	const validator = useMemo(() => checkoutFormSchema(() => committed.current), [])
	return {
		billing: { fields: state.fields.billing, errors: projection.sections.billing },
		shipping: { fields: state.fields.shipping, errors: projection.sections.shipping },
		contact: { fields: state.fields.contact, errors: projection.sections.contact },
		order: { fields: state.fields.order, errors: projection.sections.order },
		errors: projection.errors,
		defaultValues: state.defaultValues,
		unsupported: state.unsupported,
		canUseShippingAsBilling: state.canUseShippingAsBilling,
		schema: storefront && state.defaultValues && sources.checkout && !sources.checkout.isPaid && sources.cart ? validator : null,
		handleFieldChange,
		copyShippingToBilling,
		reevaluate,
		encode: checkoutFormEncode,
		decode: checkoutFormDecode,
		isLoading: storefrontLoading || checkoutQuery.isPending || (!sources.cart && cartQuery.isFetching),
		isRepricing: activity.isRepricing || activity.isSelectingRate,
		error: storefrontError ?? checkoutQuery.error ?? cartQuery.error,
	}
}
