"use client"

import type { ConfirmCheckoutInput } from "@kizlo/woocommerce-kit"
import { useCart } from "@kizlo/woocommerce-kit/react/cart"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
import { type CheckoutFieldsApi, type ReadyCheckoutFieldsApi, useCheckoutFields } from "@kizlo/woocommerce-kit/react/checkout-fields"
import { checkoutFormErrorMessages, tanstackFormAdapter } from "@kizlo/woocommerce-kit/react/checkout-fields/tanstack-form"
import { useForm } from "@tanstack/react-form"
import { CheckoutFieldControl } from "./checkout-field-control.example"

export function TanStackCheckoutForm({ input }: { input?: Partial<ConfirmCheckoutInput> }) {
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
	return <TanStackCheckoutSession key={fields.session} ready={fields} input={input} />
}

function TanStackCheckoutSession({ ready, input }: { ready: ReadyCheckoutFieldsApi; input?: Partial<ConfirmCheckoutInput> }) {
	const checkout = useCheckout()
	const cart = useCart()
	const form = useForm({
		defaultValues: ready.defaultValues,
		validators: { onChange: ready.schema, onSubmit: ready.schema },
		onSubmit: async () => {
			if (fields.unsupported.length || checkout.isLocked) return
			try {
				await checkout.confirmAsync(fields.toCheckout({ input }))
			} catch {
				// Kit publishes local and server failures through the form and checkout error channels.
			}
		},
	})
	const fields: CheckoutFieldsApi = useCheckoutFields(tanstackFormAdapter(form))
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault()
				if (!checkout.isLocked && !fields.unsupported.length) {
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
										onValueChange: (value) => {
											field.handleChange(value)
											fields.handleFieldChange(definition.name, value)
										},
										onBlur: () => {
											field.handleBlur()
											fields.handleFieldBlur(definition.name)
										},
										invalid: field.state.meta.errors.length > 0,
									}}
									error={
										field.state.meta.isBlurred || form.state.submissionAttempts > 0 || field.state.meta.errorMap.onServer
											? checkoutFormErrorMessages(field.state.meta.errors)
											: undefined
									}
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
								onChange={(event) => {
									field.handleChange(event.currentTarget.value)
									fields.handleFieldChange(field.name, event.currentTarget.value)
								}}
								onBlur={() => {
									field.handleBlur()
									fields.handleFieldBlur(field.name)
								}}
							/>
						</label>
						{field.state.meta.errors.length ? (
							<p id="paymentMethod-error" role="alert">
								{checkoutFormErrorMessages(field.state.meta.errors)}
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
								onChange={(event) => {
									field.handleChange(event.currentTarget.value)
									fields.handleFieldChange(field.name, event.currentTarget.value)
								}}
								onBlur={() => {
									field.handleBlur()
									fields.handleFieldBlur(field.name)
								}}
							/>
						</label>
						{field.state.meta.errors.length ? (
							<p id="customerNote-error" role="alert">
								{checkoutFormErrorMessages(field.state.meta.errors)}
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
								onChange={(event) => {
									field.handleChange(event.currentTarget.checked)
									fields.handleFieldChange(field.name, event.currentTarget.checked)
								}}
								onBlur={() => {
									field.handleBlur()
									fields.handleFieldBlur(field.name)
								}}
							/>
							Create account
						</label>
						{field.state.meta.errors.length ? (
							<p id="createAccount-error" role="alert">
								{checkoutFormErrorMessages(field.state.meta.errors)}
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
									onChange={(event) => {
										field.handleChange(event.currentTarget.checked)
										fields.handleFieldChange(field.name, event.currentTarget.checked)
									}}
									onBlur={() => {
										field.handleBlur()
										fields.handleFieldBlur(field.name)
									}}
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
									{checkoutFormErrorMessages(field.state.meta.errors)}
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
