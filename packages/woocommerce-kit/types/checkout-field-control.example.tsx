import type { CheckoutFieldBinding, CheckoutFormField } from "@kizlo/woocommerce-kit/react/checkout-fields"

/** The application's markup uses Kit's native bindings without reconstructing control behavior. */
export function CheckoutFieldControl({
	definition,
	binding,
	error,
}: {
	definition: CheckoutFormField
	binding: CheckoutFieldBinding
	error?: string
}) {
	const control = definition.getProps(binding)
	return (
		<label htmlFor={control.props.id} hidden={definition.hidden}>
			{definition.label}
			{control.kind === "select" ? (
				<select {...control.props}>
					<option value="">Select…</option>
					{definition.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			) : control.kind === "textarea" ? (
				<textarea {...control.props} />
			) : (
				<input {...control.props} />
			)}
			{error ? (
				<span id={control.errorId} role="alert">
					{error}
				</span>
			) : null}
		</label>
	)
}
