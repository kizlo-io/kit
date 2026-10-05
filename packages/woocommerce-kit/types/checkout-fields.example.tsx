"use client"
import type { ResolvedField } from "@kizlo/woocommerce-kit"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"
import { type CheckoutFieldValues, useCheckoutFields } from "@kizlo/woocommerce-kit/react/checkout-fields"
import { useEffect, useState } from "react"

function readAt(value: unknown, path: readonly string[]): unknown {
	for (const key of path) {
		if (!value || typeof value !== "object") return undefined
		value = (value as Record<string, unknown>)[key]
	}
	return value
}

function writeAt(value: object, path: readonly string[], next: unknown): object {
	const [key, ...rest] = path
	if (!key) return value
	const current = readAt(value, [key])
	return { ...value, [key]: rest.length ? writeAt(current && typeof current === "object" ? current : {}, rest, next) : next }
}

function CheckoutFieldControl({ field, value, onChange }: { field: ResolvedField; value: unknown; onChange: (value: unknown) => void }) {
	const id = JSON.stringify(field.key)
	const text = typeof value === "string" || typeof value === "number" ? String(value) : ""
	const props = { ...field.attributes, id, required: field.required, autoComplete: field.autocomplete ?? undefined }
	const control =
		field.type === "select" ? (
			<select {...props} value={text} onChange={(event) => onChange(event.currentTarget.value)}>
				<option value="">Select…</option>
				{field.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		) : field.type === "textarea" ? (
			<textarea {...props} value={text} onChange={(event) => onChange(event.currentTarget.value)} />
		) : (
			<input
				{...props}
				type={field.type ?? "text"}
				checked={field.type === "checkbox" ? value === true : undefined}
				value={field.type === "checkbox" ? undefined : text}
				onChange={(event) =>
					onChange(
						field.type === "checkbox"
							? event.currentTarget.checked
							: field.type === "number"
								? event.currentTarget.value === ""
									? undefined
									: event.currentTarget.valueAsNumber
								: event.currentTarget.value,
					)
				}
			/>
		)
	return (
		<label htmlFor={id}>
			{field.label}
			{control}
		</label>
	)
}

export function CheckoutForm() {
	const [values, setValues] = useState<CheckoutFieldValues>()
	const [issues, setIssues] = useState<readonly { message: string; path?: readonly (string | number)[] }[]>([])
	const { fields, defaultValues, schema, unsupported, isLoading, isRepricing, error } = useCheckoutFields({ values })
	const { confirm, isPending } = useCheckout({
		onSuccess: ({ redirectUrl }) => {
			if (redirectUrl) window.location.assign(redirectUrl)
		},
	})

	// This application chooses one-time initialization; refreshed defaults do not reset an edited form.
	useEffect(() => {
		if (values === undefined && defaultValues) setValues(defaultValues)
	}, [values, defaultValues])

	if (isLoading) return <p>Loading checkout…</p>
	if (!values || !schema) return <p>{error?.message ?? "Checkout is unavailable"}</p>

	return (
		<form
			onSubmit={async (event) => {
				event.preventDefault()
				if (isRepricing || isPending || unsupported.length) return
				const result = await schema["~standard"].validate(values)
				if ("issues" in result) {
					setIssues(result.issues)
					return
				}
				setIssues([])
				if (values.billingAddress && values.paymentMethod) {
					confirm({ ...values, billingAddress: values.billingAddress, paymentMethod: values.paymentMethod })
				}
			}}
		>
			{(["billing", "shipping", "contact", "order"] as const).map((group) => (
				<section key={group}>
					<h2>{group}</h2>
					{fields[group]
						.filter((field) => !field.hidden)
						.map((field) => (
							<CheckoutFieldControl
								key={JSON.stringify(field.key)}
								field={field}
								value={readAt(values, field.key)}
								onChange={(next) => setValues((current) => writeAt(current ?? {}, field.key, next) as CheckoutFieldValues)}
							/>
						))}
				</section>
			))}
			{/* Payment-method selection and other checkout controls also update this same full snapshot. */}
			{issues.map((issue) => (
				<p key={JSON.stringify(issue)}>{issue.message}</p>
			))}
			{error ? <p role="alert">{error.message}</p> : null}
			{unsupported.length ? <p>Some checkout fields require application integration.</p> : null}
			{isRepricing ? <p>Updating totals…</p> : null}
			<button type="submit" disabled={isPending || isRepricing || unsupported.length > 0}>
				Place order
			</button>
		</form>
	)
}
