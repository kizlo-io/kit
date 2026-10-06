"use client"

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
import { type CheckoutFieldsApi, type CheckoutFormValues, useCheckoutFields } from "@kizlo/woocommerce-kit/react/checkout-fields"
import { useEffect, useRef } from "react"
import { Controller, useForm } from "react-hook-form"
import { CheckoutFieldControl } from "./checkout-field-control.example"

export function ReactHookFormCheckout() {
	const initialized = useRef(false)
	const checkout = useCheckout({
		onSuccess: ({ redirectUrl }) => {
			if (redirectUrl) window.location.assign(redirectUrl)
		},
	})
	const fields: CheckoutFieldsApi = useCheckoutFields({
		getValues: (): CheckoutFormValues => form.getValues(),
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
	const form = useForm<CheckoutFormValues>({
		defaultValues: {},
		mode: "onSubmit",
		reValidateMode: "onBlur",
		resolver: fields.schema ? standardSchemaResolver(fields.schema) : undefined,
	})
	useEffect(() => {
		if (!initialized.current && fields.defaultValues) {
			initialized.current = true
			form.reset(fields.defaultValues)
			fields.reevaluate()
		}
	}, [fields.defaultValues, fields.reevaluate, form])
	if (!fields.schema) return <p>{fields.error?.message ?? "Loading checkout…"}</p>
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				if (fields.isRepricing || checkout.isPending || fields.unsupported.length) return
				void form.handleSubmit((values) => {
					const output = fields.getOutput(values)
					if (output.billingAddress && output.paymentMethod)
						checkout.confirm({ ...output, billingAddress: output.billingAddress, paymentMethod: output.paymentMethod })
				})(event)
			}}
		>
			{(["contact", "shipping", "billing", "order"] as const).map((group) => (
				<fieldset key={group}>
					<legend>{group}</legend>
					{fields.fields[group]
						.filter((definition) => !definition.hidden)
						.map((definition) => (
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
											onBlur: field.onBlur,
											invalid: fieldState.invalid,
										}}
										error={fieldState.error?.message}
									/>
								)}
							/>
						))}
				</fieldset>
			))}
			<label>
				Payment method
				<input
					{...form.register("paymentMethod", {
						onChange: () => fields.handleFieldChange("paymentMethod", form.getValues("paymentMethod")),
					})}
				/>
			</label>
			<label>
				Order note
				<textarea
					{...form.register("customerNote", { onChange: () => fields.handleFieldChange("customerNote", form.getValues("customerNote")) })}
				/>
			</label>
			<label>
				<input
					type="checkbox"
					{...form.register("createAccount", {
						onChange: () => fields.handleFieldChange("createAccount", form.getValues("createAccount")),
					})}
				/>
				Create account
			</label>
			{fields.canUseShippingAsBilling ? (
				<label>
					<input
						type="checkbox"
						{...form.register("useShippingAsBilling", {
							onChange: () => fields.handleFieldChange("useShippingAsBilling", form.getValues("useShippingAsBilling")),
						})}
					/>
					Use shipping address for billing
				</label>
			) : null}
			{fields.error ? <p role="alert">{fields.error.message}</p> : null}
			{fields.unsupported.length ? <p>Some fields require application integration.</p> : null}
			<button type="submit" disabled={checkout.isPending || fields.isRepricing || fields.unsupported.length > 0}>
				Place order
			</button>
		</form>
	)
}
