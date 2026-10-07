import type { CheckoutError, CheckoutValidationIssue } from "../types"

export function validationIssue(overrides: Partial<CheckoutValidationIssue> = {}): CheckoutValidationIssue {
	return {
		scope: "unresolved",
		target: null,
		source: "diagnostic_only",
		sourcePath: ["never", "parse"],
		code: "invalid_field",
		message: "Server refusal",
		registeredFields: [],
		...overrides,
	} as CheckoutValidationIssue
}
export function validationFailure(issues: CheckoutValidationIssue[]): CheckoutError {
	return Object.assign(new Error("Checkout validation failed"), {
		code: "CHECKOUT_VALIDATION_FAILED" as const,
		data: { issues },
	}) as CheckoutError
}
