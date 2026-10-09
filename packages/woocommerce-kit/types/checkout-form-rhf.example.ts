// Application-owned initialization for the React Hook Form example.
import type { CheckoutFieldsApi, CheckoutFormValues } from "@kizlo/woocommerce-kit/react/checkout-fields"
import { useLayoutEffect, useRef } from "react"
import type { UseFormReturn } from "react-hook-form"

export function useReactHookFormCheckoutDefaults(form: UseFormReturn<CheckoutFormValues>, fields: CheckoutFieldsApi) {
	const snapshot = useRef<CheckoutFormValues | null>(null)
	// RHF requires a dirtyFields subscription to preserve early edits with keepDirtyValues.
	void form.formState.dirtyFields
	useLayoutEffect(() => {
		if (!fields.defaultValues || snapshot.current === fields.defaultValues) return
		const first = !snapshot.current
		snapshot.current = fields.defaultValues
		form.reset(fields.defaultValues, first ? { keepDirtyValues: true, keepTouched: true, keepErrors: true } : undefined)
		fields.reevaluate()
	}, [form, fields.defaultValues, fields.reevaluate])
}
