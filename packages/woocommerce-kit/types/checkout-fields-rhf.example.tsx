"use client"

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
import {
	type CheckoutFieldsApi,
	type CheckoutFieldValues,
	type CheckoutFormValues,
	useCheckoutFields,
} from "@kizlo/woocommerce-kit/react/checkout-fields"
import { useEffect, useState } from "react"
import { Controller, type UseFormReturn, useForm } from "react-hook-form"
import { CheckoutFieldControl } from "./checkout-field-control.example"
import { reactHookFormErrorMessages, reactHookFormServerErrors } from "./checkout-server-errors.example"

export function ReactHookFormCheckout({ onSubmit }: { onSubmit: (values: CheckoutFieldValues) => Promise<void> }) {
	const [initialized, setInitialized] = useState(false)
	const [serverErrors] = useState<ReturnType<typeof reactHookFormServerErrors>>(() => reactHookFormServerErrors(() => form))
	const checkout = useCheckout()
	const fields: CheckoutFieldsApi = useCheckoutFields({
		getValues: (): CheckoutFormValues => form.getValues(),
		validateField: (name) => form.trigger(name),
		...(initialized ? serverErrors : { setErrors: undefined, clearErrors: undefined }),
		setValues: (updates) => {
			for (const { name, value, options } of updates) {
				form.setValue(name, value, {
					shouldDirty: options.meta === "update",
					shouldTouch: options.meta === "update",
					shouldValidate: false,
				})
				if (options.runListeners) fields.handleFieldChange(name, value)
			}
			// trigger does not change interaction metadata; all patches have already been applied.
			const names = updates.filter((update) => update.options.validate).map((update) => update.name)
			if (names.length) void form.trigger(names)
		},
	})
	const form: UseFormReturn<CheckoutFormValues> = useForm<CheckoutFormValues>({
		defaultValues: {},
		mode: "onSubmit",
		reValidateMode: "onBlur",
		resolver: fields.schema ? serverErrors.withResolver(standardSchemaResolver(fields.schema)) : undefined,
	})
	useEffect(() => {
		if (!initialized && fields.defaultValues) {
			setInitialized(true)
			form.reset(fields.defaultValues)
			fields.reevaluate()
		}
	}, [fields.defaultValues, fields.reevaluate, form, initialized])
	if (!fields.schema) return <p>{fields.error?.message ?? "Loading checkout…"}</p>
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault()
				if (fields.isRepricing || checkout.isPending || fields.unsupported.length) return
				checkout.reset()
				void form.handleSubmit(async (values) => {
					await onSubmit(fields.decode(values))
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
											? reactHookFormErrorMessages(fieldState.error)
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
					{...form.register("paymentMethod", {
						onChange: () => fields.handleFieldChange("paymentMethod", form.getValues("paymentMethod")),
					})}
				/>
			</label>
			{form.formState.errors.paymentMethod ? (
				<p id="paymentMethod-error" role="alert">
					{reactHookFormErrorMessages(form.formState.errors.paymentMethod)}
				</p>
			) : null}
			<label>
				Order note
				<textarea
					aria-invalid={!!form.formState.errors.customerNote}
					aria-describedby={form.formState.errors.customerNote ? "customerNote-error" : undefined}
					{...form.register("customerNote", { onChange: () => fields.handleFieldChange("customerNote", form.getValues("customerNote")) })}
				/>
			</label>
			{form.formState.errors.customerNote ? (
				<p id="customerNote-error" role="alert">
					{reactHookFormErrorMessages(form.formState.errors.customerNote)}
				</p>
			) : null}
			<label>
				<input
					aria-invalid={!!form.formState.errors.createAccount}
					aria-describedby={form.formState.errors.createAccount ? "createAccount-error" : undefined}
					type="checkbox"
					{...form.register("createAccount", {
						onChange: () => fields.handleFieldChange("createAccount", form.getValues("createAccount")),
					})}
				/>
				Create account
			</label>
			{form.formState.errors.createAccount ? (
				<p id="createAccount-error" role="alert">
					{reactHookFormErrorMessages(form.formState.errors.createAccount)}
				</p>
			) : null}
			{fields.canUseShippingAsBilling ? (
				<>
					<label>
						<input
							aria-invalid={!!form.formState.errors.useShippingAsBilling}
							aria-describedby={form.formState.errors.useShippingAsBilling ? "useShippingAsBilling-error" : undefined}
							type="checkbox"
							{...form.register("useShippingAsBilling", {
								onChange: () => fields.handleFieldChange("useShippingAsBilling", form.getValues("useShippingAsBilling")),
							})}
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
							{reactHookFormErrorMessages(form.formState.errors.useShippingAsBilling)}
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
			<button type="submit" disabled={checkout.isPending || fields.isRepricing || fields.unsupported.length > 0}>
				Place order
			</button>
		</form>
	)
}
