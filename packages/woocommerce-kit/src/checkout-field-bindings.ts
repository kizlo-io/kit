import { checkoutSchemaKind } from "./checkout-field-schema"
import type {
	CheckoutControlProps,
	CheckoutFieldBinding,
	CheckoutFieldValue,
	CheckoutFormFieldName,
	CheckoutNativeControl,
	ResolvedField,
} from "./types"

/** A small allowlist keeps merchant metadata from replacing controlled values or handlers. */
function merchantProps(attributes: ResolvedField["attributes"]): Partial<CheckoutControlProps> {
	const props: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(attributes)) {
		if (["disabled", "readOnly", "readonly"].includes(key) && typeof value === "boolean") {
			props[key === "readonly" ? "readOnly" : key] = value
		} else if (["min", "max", "step"].includes(key) && (typeof value === "string" || typeof value === "number")) props[key] = value
		else if (["pattern", "title"].includes(key) && typeof value === "string") props[key] = value
		else if (["minLength", "maxLength", "minlength", "maxlength"].includes(key) && typeof value === "number")
			props[key.toLowerCase() === "minlength" ? "minLength" : "maxLength"] = value
	}
	return props
}
export function checkoutFieldProps(
	field: ResolvedField,
	name: CheckoutFormFieldName,
	binding: CheckoutFieldBinding,
): CheckoutNativeControl {
	const id = `checkout-${name}`
	const errorId = `${id}-error`
	const props: CheckoutControlProps = {
		...merchantProps(field.attributes),
		id,
		name,
		required: field.required,
		autoComplete: field.autocomplete ?? undefined,
		placeholder: field.placeholder ?? undefined,
		"aria-invalid": binding.invalid ?? false,
		"aria-describedby": binding.invalid ? errorId : undefined,
		onBlur: binding.onBlur,
	}
	const text = binding.value === undefined ? "" : String(binding.value)
	if (field.type === "select")
		return {
			kind: "select",
			errorId,
			props: { ...props, value: text, onChange: (event) => binding.onValueChange(event.currentTarget.value) },
		}
	if (field.type === "textarea")
		return {
			kind: "textarea",
			errorId,
			props: { ...props, value: text, onChange: (event) => binding.onValueChange(event.currentTarget.value) },
		}
	const number = field.type === "number" && checkoutSchemaKind(field.schema) !== "string"
	return {
		kind: "input",
		errorId,
		props: {
			...props,
			type: field.type ?? "text",
			...(field.type === "checkbox" ? { checked: binding.value === true } : { value: text }),
			onChange: (event) =>
				binding.onValueChange(
					field.type === "checkbox"
						? event.currentTarget.checked
						: number
							? ((event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber) as CheckoutFieldValue | undefined)
							: event.currentTarget.value,
				),
		},
	}
}
