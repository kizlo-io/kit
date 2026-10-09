import { useField, useForm as useTanStackForm } from "@tanstack/react-form"
import { useForm as useReactHookForm } from "react-hook-form"
import { expectTypeOf } from "vitest"
import type { CheckoutFieldsOptions, CheckoutFieldValues, CheckoutFormId, CheckoutFormValues, ConfirmCheckoutInput } from "../types"
import { useCheckoutFields } from "./checkout-fields"
import { reactHookFormAdapter } from "./checkout-fields-react-hook-form"
import { tanstackFormAdapter } from "./checkout-fields-tanstack-form"

expectTypeOf<ReturnType<typeof tanstackFormAdapter>>().toExtend<CheckoutFieldsOptions>()
expectTypeOf<ReturnType<typeof reactHookFormAdapter>>().toExtend<CheckoutFieldsOptions>()
expectTypeOf<CheckoutFormId<"consumer/quantity.a[0]'%%">>().toEqualTypeOf<"consumer%2Fquantity%2Ea%5B0%5D%27%25%25">()

export function TanStackConsumer() {
	const form = useTanStackForm({
		defaultValues: {} as CheckoutFormValues,
		onSubmit: ({ value }) => {
			const values = fields.decode(value)
			expectTypeOf(values).toEqualTypeOf<CheckoutFieldValues>()
			expectTypeOf(values.additionalFields?.["consumer/quantity.a[0]'%%"]).toEqualTypeOf<number | undefined>()
			// @ts-expect-error Form validation does not assemble a complete confirmation input.
			const confirmation: ConfirmCheckoutInput = values
			void confirmation
		},
	})
	const fields = useCheckoutFields(tanstackFormAdapter(form))
	const adapter = tanstackFormAdapter(form)
	expectTypeOf(form.state.values).toEqualTypeOf<CheckoutFormValues>()
	const quantity = useField({ form, name: "additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25" })
	expectTypeOf(adapter.getFieldValue("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25")).toEqualTypeOf<number | undefined>()
	// @ts-expect-error The introspection-registered number field does not accept a string.
	void adapter.setFieldValue("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25", "two")
	void adapter.setFieldValue("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25", 2)
	void quantity
	return fields.decode({ additionalFields: { "consumer%2Fquantity%2Ea%5B0%5D%27%25%25": undefined }, paymentMethod: "" })
}

export function ReactHookFormConsumer() {
	const form = useReactHookForm<CheckoutFormValues>()
	const fields = useCheckoutFields(reactHookFormAdapter(form))
	const adapter = reactHookFormAdapter(form)
	expectTypeOf(form.getValues()).toEqualTypeOf<CheckoutFormValues>()
	expectTypeOf(adapter.getFieldValue("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25")).toEqualTypeOf<number | undefined>()
	form.register("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25", { valueAsNumber: true })
	// @ts-expect-error Register defaults retain the introspection-registered number field type.
	form.register("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25", { value: "two" })
	// @ts-expect-error The introspection-registered number field does not accept a string.
	form.setValue("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25", "two")
	// @ts-expect-error The adapter preserves registered scalar types too.
	void adapter.setFieldValue("additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25", "two")
	return form.handleSubmit((value) => {
		const values = fields.decode(value)
		expectTypeOf(values).toEqualTypeOf<CheckoutFieldValues>()
		// @ts-expect-error Decoding retains drafts and does not establish request completeness.
		const confirmation: ConfirmCheckoutInput = values
		void confirmation
	})
}
