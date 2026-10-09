"use client"

import type { AnyFormApi } from "@tanstack/react-form"
import { applyCheckoutFormUpdates } from "../checkout-form-adapter"
import { readPath } from "../field-metadata"
import type {
	CheckoutFieldUpdate,
	CheckoutFormFieldName,
	CheckoutFormFieldValue,
	CheckoutFormValues,
	CheckoutServerErrorCallbacks,
} from "../types"

export { checkoutFormErrorMessages } from "../checkout-form-adapter"
export type { CheckoutFieldValues, CheckoutFormFieldName, CheckoutFormFieldValue, CheckoutFormValues } from "../types"

export type CheckoutForm = Pick<
	AnyFormApi,
	"getFieldMeta" | "setFieldMeta" | "getFieldInfo" | "validateField" | "setFieldValue" | "store"
> & {
	state: { values: CheckoutFormValues }
}
export interface CheckoutFormAdapter extends CheckoutServerErrorCallbacks {
	getValues: () => CheckoutFormValues
	setValues: (updates: readonly CheckoutFieldUpdate[]) => Promise<void>
	validateField: (name: CheckoutFormFieldName) => Promise<boolean>
	getFieldValue: <Name extends CheckoutFormFieldName>(name: Name) => CheckoutFormFieldValue<Name>
	setFieldValue: <Name extends CheckoutFormFieldName>(
		name: Name,
		value: CheckoutFormFieldValue<NoInfer<Name>>,
		options?: CheckoutFieldUpdate["options"],
	) => Promise<void>
}
const adapters = new WeakMap<CheckoutForm, CheckoutFormAdapter>()

/** Supply the generic fields hook's callbacks for an existing, application-configured form. */
export function tanstackFormAdapter(form: CheckoutForm): CheckoutFormAdapter {
	const cached = adapters.get(form)
	if (cached) return cached
	let subscription: ReturnType<CheckoutForm["store"]["subscribe"]> | undefined
	const server = new Map<CheckoutFormFieldName, { kitServer: readonly string[] }>()
	let restoring = false
	const remove = (value: unknown, token: unknown): unknown => {
		if (value === token) return undefined
		if (!Array.isArray(value) || !value.includes(token)) return value
		const remaining = value.filter((error) => error !== token)
		return remaining.length === 1 ? remaining[0] : remaining.length ? remaining : undefined
	}
	const restoreErrors = () => {
		if (restoring) return
		restoring = true
		try {
			for (const [name, token] of server) {
				const current = form.getFieldMeta(name)?.errorMap.onServer
				if (current === token || (Array.isArray(current) && current.includes(token))) continue
				form.setFieldMeta(name, (meta) => ({
					...meta,
					errorMap: { ...meta.errorMap, onServer: current === undefined ? token : [current, token].flat() },
				}))
			}
		} finally {
			restoring = false
		}
	}
	const clearErrors = (names: readonly CheckoutFormFieldName[]) => {
		for (const name of names) {
			const token = server.get(name)
			server.delete(name)
			if (!token) continue
			form.setFieldMeta(name, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: remove(meta.errorMap.onServer, token) } }))
		}
		if (!server.size) {
			subscription?.unsubscribe()
			subscription = undefined
		}
	}
	const validateField = (name: CheckoutFormFieldName) =>
		// A native change listener runs before TanStack starts its own validation, which would cancel ours.
		Promise.resolve().then(() => {
			const touched = form.getFieldMeta(name)?.isTouched ?? false
			const result = form.validateField(name, "change")
			// TanStack touches synchronously. Do not restore after await and erase a later user blur.
			if (!touched) form.setFieldMeta(name, (meta) => ({ ...meta, isTouched: false }))
			return Promise.resolve(result).then((errors) => {
				restoreErrors()
				// Form-level async validation can populate field metadata while returning no field errors.
				return errors.length === 0 && (form.getFieldMeta(name)?.errors.length ?? 0) === 0 && !server.has(name)
			})
		})
	const binding = {
		getValues: (): CheckoutFormValues => form.state.values,
		setValues: (updates: readonly CheckoutFieldUpdate[]) =>
			applyCheckoutFormUpdates(updates, {
				write: ({ name, value, options }) =>
					form.setFieldValue(name, value, { dontRunListeners: true, dontUpdateMeta: options.meta === "preserve", dontValidate: true }),
				listen: ({ name }) => form.getFieldInfo(name).instance?.triggerOnChangeListener(),
				validate: ({ name }) => validateField(name),
			}),
		validateField,
		setErrors: (patches: readonly { name: CheckoutFormFieldName; messages: readonly string[] }[]) => {
			clearErrors(patches.map(({ name }) => name))
			for (const { name, messages } of patches) server.set(name, { kitServer: [...messages] })
			restoreErrors()
			if (server.size && !subscription) subscription = form.store.subscribe(restoreErrors)
		},
		clearErrors,
	}
	const adapter: CheckoutFormAdapter = {
		...binding,
		getFieldValue: <Name extends CheckoutFormFieldName>(name: Name): CheckoutFormFieldValue<Name> =>
			readPath(binding.getValues(), name.split(".")) as CheckoutFormFieldValue<Name>,
		setFieldValue: (name, value, options = { runListeners: true, meta: "update", validate: true }) =>
			binding.setValues([{ name, value: value as CheckoutFieldUpdate["value"], options }]),
	}
	adapters.set(form, adapter)
	return adapter
}
