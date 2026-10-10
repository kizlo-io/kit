"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { checkoutAddressSource } from "../checkout-address"
import { createCheckoutAddressSync } from "../checkout-address-sync"
import { checkoutSession, createCheckoutErrorBridge, projectCheckoutErrors } from "../checkout-errors"
import { type CheckoutFieldSources, checkoutDefaults } from "../checkout-field-document"
import { CheckoutFieldsAcquisitionError } from "../checkout-fields-availability"
import {
	checkoutFieldUpdates,
	checkoutFormDecode,
	checkoutFormEncode,
	checkoutFormSchema,
	checkoutShippingToBillingUpdates,
	isCheckoutFormName,
	projectedFormValues,
	resolveCheckoutFormState,
} from "../checkout-form"
import { CheckoutPreparationError, prepareCheckout } from "../checkout-preparation"
import type {
	CartAddressInput,
	CartAddressSnapshotInput,
	CheckoutFieldsApi,
	CheckoutFieldsFetchFailure,
	CheckoutFieldsOptions,
	CheckoutFormValues,
	UpdateCartInput,
} from "../types"
import { useCartAddressTransport } from "./cart-address"
import { useCheckoutErrorState, useCheckoutErrorStore } from "./checkout-error-store"
import { useCheckoutLockStore } from "./checkout-lock-store"
import { useWooCommerceContext } from "./context"
import { useAddressQueueActivity, useCartActivity, useCartQuery, useCheckoutQuery } from "./session-queries"
import { useStorefront } from "./storefront"

export { CheckoutFieldsAcquisitionError } from "../checkout-fields-availability"
export { CheckoutPreparationError } from "../checkout-preparation"
export type {
	CheckoutFieldBinding,
	CheckoutFieldDiagnostic,
	CheckoutFieldGroup,
	CheckoutFieldsApi,
	CheckoutFieldsFetchFailure,
	CheckoutFieldsOptions,
	CheckoutFieldsSection,
	CheckoutFieldsUnavailableReason,
	CheckoutFieldUpdate,
	CheckoutFieldValue,
	CheckoutFieldValues,
	CheckoutFormField,
	CheckoutFormFieldName,
	CheckoutFormId,
	CheckoutFormValues,
	CheckoutNativeControl,
	CheckoutPreparationOptions,
	CheckoutRegisteredFieldReference,
	CheckoutServerErrorCallbacks,
	CheckoutServerFieldError,
	CheckoutServerIssue,
	CheckoutValidationIssue,
	ReadyCheckoutFieldsApi,
	UnavailableCheckoutFieldsApi,
} from "../types"

/** The form owns editable values; only field metadata and the initial snapshot are retained here. */
export function useCheckoutFields(options: CheckoutFieldsOptions = {}): CheckoutFieldsApi {
	const {
		storefront,
		error: storefrontError,
		isLoading: storefrontLoading,
		isFetching: storefrontFetching,
		refresh: refreshStorefront,
	} = useStorefront()
	const { cartEnabled } = useWooCommerceContext()
	const binding = useCheckoutLockStore()
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
	const active = !!options.validateField
	if (active && (!options.getValues || !options.setValues)) throw new Error("Automatic address syncing requires getValues and setValues")
	const validationActivity = useAddressQueueActivity()
	const sessionRef = useRef(session)
	const syncRef = useRef<ReturnType<typeof createCheckoutAddressSync> | null>(null)
	const allows = useCallback(
		(input: CartAddressSnapshotInput, cart: CheckoutFieldSources["cart"]) => syncRef.current?.allows(input, cart) ?? false,
		[],
	)
	// The fields core has already projected sharing and removed unchanged addresses.
	const project = useCallback((input: CartAddressInput) => input as UpdateCartInput, [])
	const transport = useCartAddressTransport({ shouldUpdateAddress: allows }, project, checkoutQuery.data !== undefined)
	const transportRef = useRef(transport)
	const sync = useMemo(
		() =>
			createCheckoutAddressSync({
				read: () => ({ sources: committed.current, values: accessors.current.getValues?.(), session: sessionRef.current }),
				validate: (name) => accessors.current.validateField?.(name) ?? false,
				queue: (input) => transportRef.current.onAddressChange(input),
				cancel: () => transportRef.current.cancelQueued(),
				flush: () => transportRef.current.flush(),
				activity: validationActivity,
				unchanged: () => {
					const values = accessors.current.getValues?.()
					if (!values) return
					const { billingAddress, shippingAddress } = projectedFormValues(committed.current, values)
					transportRef.current.clearSavedFailure({ billingAddress, shippingAddress } as CartAddressSnapshotInput, committed.current.cart)
				},
				blocked: (names) => {
					const current = committedState.current
					const projection = projectCheckoutErrors(errors.state.get().issues, committed.current, current.fields, {
						useShippingAsBilling: current.useShippingAsBilling,
					})
					return [...projection.associations.values()].some((name) => names.includes(name))
				},
			}),
		[validationActivity, errors],
	)
	const dependencies = useRef<
		Partial<Record<"billingAddress" | "shippingAddress", { country?: unknown; state?: unknown; postcode?: unknown }>> | undefined
	>(undefined)
	const rememberDependencies = useCallback((values: CheckoutFormValues | undefined) => {
		dependencies.current = Object.fromEntries(
			(["billingAddress", "shippingAddress"] as const).map((root) => [
				root,
				{
					country: values?.[root]?.country,
					state: values?.[root]?.state,
					postcode: values?.[root]?.postcode,
				},
			]),
		)
	}, [])
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
	const renderedDefaults = defaults(sources)
	const [state, setState] = useState(() => resolveCheckoutFormState(sources, undefined, renderedDefaults))
	const committedState = useRef(state)
	useLayoutEffect(() => {
		accessors.current = options
		transportRef.current = transport
		syncRef.current = sync
	})
	useLayoutEffect(() => {
		committed.current = sources
		const defaultValues = defaults(sources)
		const values = accessors.current.getValues?.()
		const next = resolveCheckoutFormState(sources, values, defaultValues, committedState.current)
		committedState.current = next
		setState(next)
		rememberDependencies(values)
		if (active) sync.refresh()
	}, [sources, defaults, rememberDependencies, active, sync])
	useLayoutEffect(() => {
		sessionRef.current = session
		sync.reset()
		if (!active) return
		return () => sync.reset()
	}, [session, active, sync])
	const reevaluate = useCallback(() => {
		const source = committed.current
		const defaultValues = defaults(source)
		const values = accessors.current.getValues?.()
		const next = resolveCheckoutFormState(source, values, defaultValues, committedState.current)
		committedState.current = next
		setState(next)
		rememberDependencies(values)
		if (accessors.current.validateField) sync.refresh()
	}, [defaults, rememberDependencies, sync])
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
				const before = getValues()
				errors.clearIssues(new Set([...associated.current].filter(([, control]) => control === name).map(([id]) => id)))
				const updates = checkoutFieldUpdates(name, before, dependencies.current)
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
				rememberDependencies(values)
			} finally {
				changing.current = false
			}
			if (accessors.current.validateField) {
				if (name.startsWith("billingAddress.") || name.startsWith("shippingAddress.") || name === "useShippingAsBilling") sync.change()
				else sync.refresh()
			}
		},
		[defaults, errors, rememberDependencies, sync],
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
		if (accessors.current.validateField) sync.change()
	}, [errors, reevaluate, sync])
	const handleFieldBlur = useCallback<CheckoutFieldsApi["handleFieldBlur"]>(
		(name) => {
			if (accessors.current.validateField && isCheckoutFormName(committed.current, name)) sync.blur()
		},
		[sync],
	)
	const validator = useMemo(() => checkoutFormSchema(() => committed.current), [])
	const toCheckout = useCallback<CheckoutFieldsApi["toCheckout"]>(
		(options = {}) => {
			try {
				return prepareCheckout(committed.current, { ...options, values: options.values ?? accessors.current.getValues?.() })
			} catch (error) {
				if (error instanceof CheckoutPreparationError) {
					if (errors.state.get().pending) errors.reject(error)
					else {
						const attempt = errors.start(checkoutSession(committed.current.checkout))
						errors.fail(attempt, error)
						errors.settle(attempt)
					}
				}
				throw error
			}
		},
		[errors],
	)
	const error = useMemo(() => {
		const failures: CheckoutFieldsFetchFailure[] = []
		if (storefrontError) failures.push({ source: "storefront", error: storefrontError })
		if (checkoutQuery.error) failures.push({ source: "checkout", error: checkoutQuery.error })
		if (cartQuery.error) failures.push({ source: "cart", error: cartQuery.error })
		const first = failures[0]
		return first ? new CheckoutFieldsAcquisitionError([first, ...failures.slice(1)]) : null
	}, [storefrontError, checkoutQuery.error, cartQuery.error])
	const refresh = useCallback(async () => {
		await Promise.all([refreshStorefront(), binding.refreshFields()])
	}, [refreshStorefront, binding])
	const isLoading =
		(!storefront && storefrontLoading) ||
		(!sources.checkout && checkoutQuery.isPending) ||
		(!sources.cart && !!sources.checkout && cartEnabled && cartQuery.isPending)
	const ready = !!storefront && !!renderedDefaults && !!sources.checkout && !sources.checkout.isPaid && !!sources.cart && !!session
	const common = {
		billing: { fields: state.fields.billing, errors: projection.sections.billing },
		shipping: { fields: state.fields.shipping, errors: projection.sections.shipping },
		contact: { fields: state.fields.contact, errors: projection.sections.contact },
		order: { fields: state.fields.order, errors: projection.sections.order },
		errors: projection.errors,
		unsupported: state.unsupported,
		canUseShippingAsBilling: state.canUseShippingAsBilling,
		handleFieldChange,
		handleFieldBlur,
		copyShippingToBilling,
		reevaluate,
		encode: checkoutFormEncode,
		decode: checkoutFormDecode,
		toCheckout,
		isLoading,
		isFetching: storefrontFetching || checkoutQuery.isFetching || cartQuery.isFetching,
		isRepricing: activity.isRepricing || activity.isSelectingRate,
		error,
		syncError: transport.error,
		refresh,
	}
	if (ready && renderedDefaults && session)
		return { ...common, isReady: true, reason: null, session, defaultValues: renderedDefaults, schema: validator }
	return {
		...common,
		isReady: false,
		reason: sources.checkout?.isPaid ? "paid" : error ? "fetch-failed" : isLoading ? "loading" : "missing-data",
		session,
		defaultValues: renderedDefaults,
		schema: null,
	}
}
