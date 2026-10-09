"use client"

import { type FieldError, type FieldErrors, type FieldPathValue, get, type Resolver, set, type UseFormReturn } from "react-hook-form"
import { applyCheckoutFormUpdates, checkoutFormErrorMessages } from "../checkout-form-adapter"
import { readPath } from "../field-metadata"
import type {
	CheckoutFieldsApi,
	CheckoutFieldUpdate,
	CheckoutFormFieldName,
	CheckoutFormFieldValue,
	CheckoutFormValues,
	CheckoutServerErrorCallbacks,
} from "../types"

export type { CheckoutFieldValues, CheckoutFormFieldName, CheckoutFormFieldValue, CheckoutFormValues } from "../types"
export type CheckoutForm = Pick<
	UseFormReturn<CheckoutFormValues>,
	"getValues" | "setValue" | "trigger" | "setError" | "getFieldState" | "clearErrors"
>
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
	/** Explicitly compose native validation with the currently active Kit server errors. */
	withResolver: (resolver: Resolver<CheckoutFormValues>) => Resolver<CheckoutFormValues>
}
export type ReactHookFormAdapterOptions = { onChange?: CheckoutFieldsApi["handleFieldChange"] }
const adapters = new WeakMap<
	CheckoutForm,
	{
		adapter: CheckoutFormAdapter
		setValues: (updates: readonly CheckoutFieldUpdate[], onChange?: CheckoutFieldsApi["handleFieldChange"]) => Promise<void>
	}
>()

export function checkoutErrorMessages(error: FieldError | undefined): string {
	return [
		...new Set(
			[error?.type !== "kitServer" ? error?.message : undefined, ...[error?.types?.kitSchema, error?.types?.kitServer].flat(2)].filter(
				Boolean,
			),
		),
	]
		.map(checkoutFormErrorMessages)
		.filter(Boolean)
		.join(", ")
}

function withoutKit(error: FieldError | undefined): FieldError | undefined {
	if (!error?.types?.kitServer) return error
	const { kitServer: _kit, ...types } = error.types
	if (error.type !== "kitServer") return { ...error, types }
	const other = Object.entries(types).find(([, value]) => value)
	return other ? { ...error, type: other[0], message: checkoutFormErrorMessages(other[1]), types } : undefined
}
function withKit(client: FieldError | undefined, messages: readonly string[]): FieldError {
	return {
		...client,
		type: client?.type ?? "kitServer",
		message: client ? client.message : messages.join(", "),
		types: { ...client?.types, kitServer: [...messages] },
	}
}
export function mergeCheckoutFormErrors(
	kit: FieldErrors<CheckoutFormValues>,
	application: FieldErrors<CheckoutFormValues>,
): FieldErrors<CheckoutFormValues> {
	const merge = (first: unknown, second: unknown): unknown => {
		if (!first) return second
		if (!second) return first
		if (typeof first !== "object" || typeof second !== "object") return second
		if ("type" in first && "type" in second) {
			const a = first as FieldError
			const b = second as FieldError
			return { ...a, ...b, types: { ...a.types, ...b.types, kitSchema: a.message } }
		}
		const result = { ...first } as Record<string, unknown>
		for (const [key, value] of Object.entries(second)) result[key] = merge(result[key], value)
		return result
	}
	return merge(kit, application) as FieldErrors<CheckoutFormValues>
}

/** Supply callbacks without configuring, initializing or subscribing to the native form. */
export function reactHookFormAdapter(form: CheckoutForm, options: ReactHookFormAdapterOptions = {}): CheckoutFormAdapter {
	const cached = adapters.get(form)
	if (cached) return withListeners(cached.adapter, cached.setValues, options.onChange)
	const server = new Map<CheckoutFormFieldName, readonly string[]>()
	const binding = {
		getValues: (): CheckoutFormValues => form.getValues(),
		setValues: (updates: readonly CheckoutFieldUpdate[], onChange?: CheckoutFieldsApi["handleFieldChange"]) =>
			applyCheckoutFormUpdates(updates, {
				write: ({ name, value, options }) =>
					form.setValue(name, value as FieldPathValue<CheckoutFormValues, typeof name>, {
						shouldDirty: options.meta === "update",
						shouldTouch: options.meta === "update",
						shouldValidate: false,
					}),
				listen: ({ name, value }) => onChange?.(name, value),
				validate: ({ name }) => form.trigger(name),
			}),
		validateField: (name: CheckoutFormFieldName) => form.trigger(name),
		setErrors: (patches: readonly { name: CheckoutFormFieldName; messages: readonly string[] }[]) => {
			for (const { name, messages } of patches) {
				server.set(name, [...messages])
				form.setError(name, withKit(withoutKit(form.getFieldState(name).error), messages))
			}
		},
		clearErrors: (names: readonly CheckoutFormFieldName[]) => {
			for (const name of names) {
				server.delete(name)
				const current = form.getFieldState(name).error
				if (!current?.types?.kitServer) continue
				const client = withoutKit(current)
				if (client) form.setError(name, client)
				else form.clearErrors(name)
			}
		},
		withResolver:
			(resolver: Resolver<CheckoutFormValues>): Resolver<CheckoutFormValues> =>
			async (values, context, options) => {
				const result = await resolver(values, context, options)
				const errors = { ...result.errors }
				// Read active errors after await: clearing/reset must not resurrect an earlier Kit batch.
				for (const [name, messages] of server) {
					for (let index = 1; index < name.split(".").length; index++) {
						const path = name.split(".").slice(0, index).join(".")
						const branch = get(errors, path)
						set(errors, path, Array.isArray(branch) ? [...branch] : { ...branch })
					}
					set(errors, name, withKit(get(result.errors, name), messages))
				}
				return Object.keys(errors).length ? { values: {}, errors } : result
			},
	}
	const adapter: CheckoutFormAdapter = {
		...binding,
		getFieldValue: <Name extends CheckoutFormFieldName>(name: Name): CheckoutFormFieldValue<Name> =>
			readPath(binding.getValues(), name.split(".")) as CheckoutFormFieldValue<Name>,
		setFieldValue: (name, value, options = { runListeners: true, meta: "update", validate: true }) =>
			binding.setValues([{ name, value: value as CheckoutFieldUpdate["value"], options }]),
	}
	adapters.set(form, { adapter, setValues: binding.setValues })
	return withListeners(adapter, binding.setValues, options.onChange)
}

function withListeners(
	adapter: CheckoutFormAdapter,
	setValues: (updates: readonly CheckoutFieldUpdate[], onChange?: CheckoutFieldsApi["handleFieldChange"]) => Promise<void>,
	onChange?: CheckoutFieldsApi["handleFieldChange"],
): CheckoutFormAdapter {
	if (!onChange) return adapter
	return {
		...adapter,
		setValues: (updates) => setValues(updates, onChange),
		setFieldValue: (name, value, options = { runListeners: true, meta: "update", validate: true }) =>
			setValues([{ name, value: value as CheckoutFieldUpdate["value"], options }], onChange),
	}
}
