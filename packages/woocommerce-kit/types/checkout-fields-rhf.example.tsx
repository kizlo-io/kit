"use client"

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import type { ConfirmCheckoutInput } from "@kizlo/woocommerce-kit"
import { useCart } from "@kizlo/woocommerce-kit/react/cart"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
import {
	type CheckoutFieldsApi,
	type CheckoutFormFieldName,
	type ReadyCheckoutFieldsApi,
	useCheckoutFields,
} from "@kizlo/woocommerce-kit/react/checkout-fields"
import {
	type CheckoutFormValues,
	checkoutErrorMessages,
	reactHookFormAdapter,
} from "@kizlo/woocommerce-kit/react/checkout-fields/react-hook-form"
import { Controller, type UseFormReturn, useForm } from "react-hook-form"
import { CheckoutFieldControl } from "./checkout-field-control.example"

export function ReactHookFormCheckout({ input }: { input?: Partial<ConfirmCheckoutInput> }) {
	const fields = useCheckoutFields()
	if (!fields.isReady)
		return (
			<p>
				{fields.reason === "paid" ? "This checkout is already paid." : (fields.error?.message ?? "Loading checkout…")}
				{fields.error ? (
					<button type="button" onClick={() => void fields.refresh()}>
						Try again
					</button>
				) : null}
			</p>
		)
	return <ReactHookFormCheckoutSession key={fields.session} ready={fields} input={input} />
}

function ReactHookFormCheckoutSession({ ready, input }: { ready: ReadyCheckoutFieldsApi; input?: Partial<ConfirmCheckoutInput> }) {
	const checkout = useCheckout()
	const cart = useCart()
	const form: UseFormReturn<CheckoutFormValues> = useForm<CheckoutFormValues>({
		mode: "onSubmit",
		reValidateMode: "onBlur",
		defaultValues: ready.defaultValues,
		resolver: (values, context, options) => adapter.withResolver(standardSchemaResolver(ready.schema))(values, context, options),
	})
	const adapter = reactHookFormAdapter(form)
	const fields: CheckoutFieldsApi = useCheckoutFields(reactHookFormAdapter(form))
	const register = (name: CheckoutFormFieldName) =>
		form.register(name, {
			onChange: () => fields.handleFieldChange(name, adapter.getFieldValue(name)),
			onBlur: () => fields.handleFieldBlur(name),
		})
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault()
				if (checkout.isLocked || fields.unsupported.length) return
				checkout.reset()
				void form.handleSubmit(async (values) => {
					if (checkout.isLocked || fields.unsupported.length) return
					try {
						await checkout.confirmAsync(fields.toCheckout({ values, input }))
					} catch {
						// Kit publishes local and server failures through the form and checkout error channels.
					}
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
			{cart.cart ? <p>Total: {cart.format(cart.cart.totals.total)}</p> : null}
			{fields.isFetching ? <p role="status">Refreshing checkout…</p> : null}
			{fields.error ? (
				<p role="alert">
					{fields.error.message}
					<button type="button" onClick={() => void fields.refresh()}>
						Refresh checkout
					</button>
				</p>
			) : null}
			{fields.syncError ? <p role="alert">{fields.syncError.message}</p> : null}
			{fields.unsupported.length ? <p>Some fields require application integration.</p> : null}
			<button type="submit" disabled={checkout.isLocked || fields.unsupported.length > 0}>
				Place order
			</button>
		</form>
	)
}
