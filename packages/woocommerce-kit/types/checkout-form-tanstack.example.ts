// Application-owned lifecycle support shared by the complete examples.
import type { CheckoutFieldsApi, CheckoutFormValues } from "@kizlo/woocommerce-kit/react/checkout-fields"
import { type AnyFormApi, getBy, setBy, standardSchemaValidators } from "@tanstack/react-form"
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react"

/** Preserve edits made while the first server snapshot was still loading. */
export function checkoutFormInitialValues(
	defaults: CheckoutFormValues,
	values: CheckoutFormValues,
	dirty: readonly string[],
): CheckoutFormValues {
	let initial = structuredClone(defaults)
	for (const name of dirty) {
		if (name.split(".").some((key) => !key || ["__proto__", "prototype", "constructor"].includes(key))) continue
		initial = setBy(initial, name, getBy(values, name))
	}
	return initial
}

/** Form-level validators can report a summary, named errors, or both. */
export function mergeCheckoutFormValidation(first: unknown, second: unknown): unknown {
	if (!first) return second
	if (!second) return first
	const normalize = (value: unknown): { form?: unknown; fields: Record<string, unknown> } =>
		value && typeof value === "object" && "fields" in value
			? { form: "form" in value ? value.form : undefined, fields: (value.fields ?? {}) as Record<string, unknown> }
			: { form: value, fields: {} }
	const a = normalize(first)
	const b = normalize(second)
	const fields = { ...a.fields }
	for (const [name, error] of Object.entries(b.fields))
		fields[name] = fields[name] && error ? [fields[name], error].flat() : (error ?? fields[name])
	const form = [a.form, b.form].filter(Boolean).flat()
	return { form: form.length ? form : undefined, fields }
}

export function validateCheckoutForm(fields: CheckoutFieldsApi, value: CheckoutFormValues, application?: unknown): unknown {
	const kit = fields.schema
		? standardSchemaValidators.validate({ value, validationSource: "form" }, fields.schema)
		: { form: "Checkout fields are not ready", fields: {} }
	return mergeCheckoutFormValidation(kit, application)
}

export function useTanStackCheckoutDefaults(
	form: Pick<AnyFormApi, "reset" | "getFieldMeta" | "setFieldMeta"> & {
		state: { values: CheckoutFormValues; fieldMeta: AnyFormApi["state"]["fieldMeta"] }
	},
	fields: CheckoutFieldsApi,
	setDefaults: Dispatch<SetStateAction<CheckoutFormValues>>,
) {
	const snapshot = useRef<CheckoutFormValues | null>(null)
	useEffect(() => {
		if (!fields.defaultValues || snapshot.current === fields.defaultValues) return
		const dirty = snapshot.current ? [] : Object.keys(form.state.fieldMeta).filter((name) => form.getFieldMeta(name)?.isDirty)
		const values = checkoutFormInitialValues(fields.defaultValues, form.state.values, dirty)
		const metadata = dirty.map((name) => [name, form.getFieldMeta(name)] as const)
		snapshot.current = fields.defaultValues
		// Keep the native defaultValues option aligned so a later options update cannot replay old defaults.
		setDefaults(values)
		form.reset(values)
		for (const [name, meta] of metadata) if (meta) form.setFieldMeta(name, () => meta)
		fields.reevaluate()
	}, [form, fields.defaultValues, fields.reevaluate, setDefaults])
}
