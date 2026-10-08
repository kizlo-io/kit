"use client"

import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
import {
	type CheckoutFieldsApi,
	type CheckoutFormValues,
	type CheckoutServerErrorCallbacks,
	useCheckoutFields,
} from "@kizlo/woocommerce-kit/react/checkout-fields"
import { useForm } from "@tanstack/react-form"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { CheckoutFieldControl } from "./checkout-field-control.example"

const emptyValues: CheckoutFormValues = {}

export function TanStackCheckoutForm() {
	const formRef = useRef<{ options: { defaultValues?: CheckoutFormValues } } | null>(null)
	const [initialized, setInitialized] = useState(false)
	const checkout = useCheckout({
		onSuccess: ({ redirectUrl }) => {
			if (redirectUrl) window.location.assign(redirectUrl)
		},
	})
	const serverErrors: CheckoutServerErrorCallbacks = {
		setErrors: (patches) => {
			for (const { name, messages } of patches)
				form.setFieldMeta(name, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: [...messages] } }))
		},
		clearErrors: (names) => {
			for (const name of names) form.setFieldMeta(name, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: undefined } }))
		},
	}

	const fields: CheckoutFieldsApi = useCheckoutFields({
		getValues: (): CheckoutFormValues => form.state.values,
		...(initialized ? serverErrors : { setErrors: undefined, clearErrors: undefined }),
		setValues: (updates) => {
			const metadata = updates.map(({ name }) => form.getFieldMeta(name))
			for (const { name, value, options } of updates)
				form.setFieldValue(name, value, {
					dontRunListeners: !options.runListeners,
					dontUpdateMeta: options.meta === "preserve",
					dontValidate: true,
				})
			// All patches are visible before validation. validateField itself can mark a field touched.
			updates.forEach(({ name, options }, index) => {
				if (!options.validate) return
				const restore = () => {
					if (options.meta === "preserve")
						form.setFieldMeta(name, (meta) => ({
							...meta,
							isDirty: metadata[index]?.isDirty ?? false,
							isTouched: metadata[index]?.isTouched ?? false,
						}))
				}
				const validation = form.validateField(name, "change")
				restore()
				void Promise.resolve(validation).finally(restore)
			})
		},
	})
	const form = useForm({
		// Keep the form library's reset defaults when hook metadata causes a render.
		defaultValues: formRef.current?.options.defaultValues ?? fields.defaultValues ?? emptyValues,
		validators: { onSubmit: fields.schema ?? undefined },
		listeners: { onChange: ({ fieldApi }) => fields.handleFieldChange(fieldApi.name, fieldApi.state.value) },
		onSubmit: async ({ value }) => {
			const output = fields.getOutput(value)
			if (output.billingAddress && output.paymentMethod)
				await checkout
					.confirmAsync({ ...output, billingAddress: output.billingAddress, paymentMethod: output.paymentMethod })
					.catch(() => {})
		},
	})
	useLayoutEffect(() => {
		formRef.current = form
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
				if (!fields.isRepricing && !checkout.isPending && !fields.unsupported.length) {
					checkout.reset()
					void form.handleSubmit()
				}
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
						<form.Field key={definition.name} name={definition.name}>
							{(field) => (
								<CheckoutFieldControl
									definition={definition}
									binding={{
										value: field.state.value,
										onValueChange: field.handleChange,
										onBlur: field.handleBlur,
										invalid: field.state.meta.errors.length > 0,
									}}
									error={field.state.meta.errors.map((error) => (typeof error === "string" ? error : error?.message)).join(", ")}
								/>
							)}
						</form.Field>
					))}
				</fieldset>
			))}
			<form.Field name="paymentMethod">
				{(field) => (
					<>
						<label>
							Payment method
							<input
								name={field.name}
								aria-invalid={field.state.meta.errors.length > 0}
								aria-describedby={field.state.meta.errors.length ? "paymentMethod-error" : undefined}
								value={field.state.value ?? ""}
								onChange={(event) => field.handleChange(event.currentTarget.value)}
								onBlur={field.handleBlur}
							/>
						</label>
						{field.state.meta.errors.length ? (
							<p id="paymentMethod-error" role="alert">
								{field.state.meta.errors.map((error) => (typeof error === "string" ? error : error?.message)).join(", ")}
							</p>
						) : null}
					</>
				)}
			</form.Field>
			<form.Field name="customerNote">
				{(field) => (
					<>
						<label>
							Order note
							<textarea
								name={field.name}
								aria-invalid={field.state.meta.errors.length > 0}
								aria-describedby={field.state.meta.errors.length ? "customerNote-error" : undefined}
								value={field.state.value ?? ""}
								onChange={(event) => field.handleChange(event.currentTarget.value)}
								onBlur={field.handleBlur}
							/>
						</label>
						{field.state.meta.errors.length ? (
							<p id="customerNote-error" role="alert">
								{field.state.meta.errors.map((error) => (typeof error === "string" ? error : error?.message)).join(", ")}
							</p>
						) : null}
					</>
				)}
			</form.Field>
			<form.Field name="createAccount">
				{(field) => (
					<>
						<label>
							<input
								type="checkbox"
								aria-invalid={field.state.meta.errors.length > 0}
								aria-describedby={field.state.meta.errors.length ? "createAccount-error" : undefined}
								checked={field.state.value ?? false}
								onChange={(event) => field.handleChange(event.currentTarget.checked)}
								onBlur={field.handleBlur}
							/>
							Create account
						</label>
						{field.state.meta.errors.length ? (
							<p id="createAccount-error" role="alert">
								{field.state.meta.errors.map((error) => (typeof error === "string" ? error : error?.message)).join(", ")}
							</p>
						) : null}
					</>
				)}
			</form.Field>
			{fields.canUseShippingAsBilling ? (
				<form.Field name="useShippingAsBilling">
					{(field) => (
						<>
							<label>
								<input
									type="checkbox"
									aria-invalid={field.state.meta.errors.length > 0}
									aria-describedby={field.state.meta.errors.length ? "useShippingAsBilling-error" : undefined}
									checked={field.state.value ?? true}
									onChange={(event) => field.handleChange(event.currentTarget.checked)}
									onBlur={field.handleBlur}
								/>
								Use shipping address for billing
							</label>
							{field.state.value === false ? (
								<button type="button" onClick={() => fields.copyShippingToBilling()}>
									Copy shipping address to billing
								</button>
							) : null}
							{field.state.meta.errors.length ? (
								<p id="useShippingAsBilling-error" role="alert">
									{field.state.meta.errors.map((error) => (typeof error === "string" ? error : error?.message)).join(", ")}
								</p>
							) : null}
						</>
					)}
				</form.Field>
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
