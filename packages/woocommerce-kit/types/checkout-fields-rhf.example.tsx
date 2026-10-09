"use client"

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
import { type CheckoutFieldsApi, type CheckoutFormFieldName, useCheckoutFields } from "@kizlo/woocommerce-kit/react/checkout-fields"
import {
	type CheckoutFieldValues,
	type CheckoutFormValues,
	checkoutErrorMessages,
	reactHookFormAdapter,
} from "@kizlo/woocommerce-kit/react/checkout-fields/react-hook-form"
import { Controller, type UseFormReturn, useForm } from "react-hook-form"
import { CheckoutFieldControl } from "./checkout-field-control.example"
import { useReactHookFormCheckoutDefaults } from "./checkout-form-rhf.example"

export function ReactHookFormCheckout({ onSubmit }: { onSubmit: (values: CheckoutFieldValues) => Promise<void> }) {
	const checkout = useCheckout()
	const form: UseFormReturn<CheckoutFormValues> = useForm<CheckoutFormValues>({
		mode: "onSubmit",
		reValidateMode: "onBlur",
		defaultValues: {},
		resolver: (values, context, options) =>
			adapter.withResolver(async (input, ctx, native) =>
				fields.schema
					? standardSchemaResolver(fields.schema)(input, ctx, native)
					: { values: {}, errors: { root: { type: "kitSchema", message: "Checkout fields are not ready" } } },
			)(values, context, options),
	})
	const adapter = reactHookFormAdapter(form)
	const fields: CheckoutFieldsApi = useCheckoutFields(adapter)
	useReactHookFormCheckoutDefaults(form, fields)
	const register = (name: CheckoutFormFieldName) =>
		form.register(name, {
			onChange: () => fields.handleFieldChange(name, adapter.getFieldValue(name)),
			onBlur: () => fields.handleFieldBlur(name),
		})
	if (!fields.schema) return <p>{fields.error?.message ?? "Loading checkout…"}</p>
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault()
				if (checkout.isLocked || fields.unsupported.length) return
				checkout.reset()
				void form.handleSubmit(async (values) => {
					if (!checkout.isLocked && fields.schema && !fields.unsupported.length) await onSubmit(fields.decode(values))
				})(event)
			}}
		>
			{(["contact", "shipping", "billing", "order"] as const).map((group) => (
				<fieldset key={group}>
					<legend>{group}</legend>
					{fields[group].errors.map((issue) => (
						<p key={issue.id} role="alert">
							{issue.message}
						</p>
					))}
					{fields[group].fields.map((definition) => (
						<Controller
							key={definition.name}
							name={definition.name}
							control={form.control}
							render={({ field, fieldState }) => (
								<CheckoutFieldControl
									definition={definition}
									binding={{
										value: field.value,
										onValueChange: (value) => {
											field.onChange(value)
											fields.handleFieldChange(definition.name, value)
										},
										onBlur: () => {
											field.onBlur()
											fields.handleFieldBlur(definition.name)
										},
										invalid: fieldState.invalid,
									}}
									error={
										fieldState.isTouched || form.formState.isSubmitted || fieldState.error?.types?.kitServer
											? checkoutErrorMessages(fieldState.error)
											: undefined
									}
								/>
							)}
						/>
					))}
				</fieldset>
			))}
			<label>
				Payment method
				<input
					aria-invalid={!!form.formState.errors.paymentMethod}
					aria-describedby={form.formState.errors.paymentMethod ? "paymentMethod-error" : undefined}
					{...register("paymentMethod")}
				/>
			</label>
			{form.formState.errors.paymentMethod ? (
				<p id="paymentMethod-error" role="alert">
					{checkoutErrorMessages(form.formState.errors.paymentMethod)}
				</p>
			) : null}
			<label>
				Order note
				<textarea
					aria-invalid={!!form.formState.errors.customerNote}
					aria-describedby={form.formState.errors.customerNote ? "customerNote-error" : undefined}
					{...register("customerNote")}
				/>
			</label>
			{form.formState.errors.customerNote ? (
				<p id="customerNote-error" role="alert">
					{checkoutErrorMessages(form.formState.errors.customerNote)}
				</p>
			) : null}
			<label>
				<input
					aria-invalid={!!form.formState.errors.createAccount}
					aria-describedby={form.formState.errors.createAccount ? "createAccount-error" : undefined}
					type="checkbox"
					{...register("createAccount")}
				/>
				Create account
			</label>
			{form.formState.errors.createAccount ? (
				<p id="createAccount-error" role="alert">
					{checkoutErrorMessages(form.formState.errors.createAccount)}
				</p>
			) : null}
			{fields.canUseShippingAsBilling ? (
				<>
					<label>
						<input
							aria-invalid={!!form.formState.errors.useShippingAsBilling}
							aria-describedby={form.formState.errors.useShippingAsBilling ? "useShippingAsBilling-error" : undefined}
							type="checkbox"
							{...register("useShippingAsBilling")}
						/>
						Use shipping address for billing
					</label>
					{form.watch("useShippingAsBilling") === false ? (
						<button type="button" onClick={() => fields.copyShippingToBilling()}>
							Copy shipping address to billing
						</button>
					) : null}
					{form.formState.errors.useShippingAsBilling ? (
						<p id="useShippingAsBilling-error" role="alert">
							{checkoutErrorMessages(form.formState.errors.useShippingAsBilling)}
						</p>
					) : null}
				</>
			) : null}
			{fields.errors.map((issue) => (
				<p key={issue.id} role="alert">
					{issue.message}
				</p>
			))}
			{fields.error ? <p role="alert">{fields.error.message}</p> : null}
			{fields.unsupported.length ? <p>Some fields require application integration.</p> : null}
			<button type="submit" disabled={checkout.isLocked || fields.unsupported.length > 0}>
				Place order
			</button>
		</form>
	)
}
