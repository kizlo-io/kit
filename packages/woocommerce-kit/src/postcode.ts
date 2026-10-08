import { postcodeValidator, postcodeValidatorExistsForCountry } from "postcode-validator"
import data from "./postcode-rules.json"

type Rule = { pattern: string; flags?: string; normalization?: string }
// WooCommerce 4ed122dbd46d7c3fbe069cf1797391f7d4c7e049, i18n/postcode-validation-rules.json.
// The shared overrides and fallback must move together when updating postcode-validator.
const rules: Record<string, Rule> = data.rules
const patterns = new Map(Object.entries(rules).map(([country, rule]) => [country, new RegExp(`^(?:${rule.pattern})$`, rule.flags)]))

export function validPostcode(postcode: string, country: string): boolean {
	if (/[^ \t\n\r\f\vA-Za-z0-9-]/.test(postcode)) return false
	const rule = rules[country]
	if (rule) {
		const value =
			rule.normalization === "removeSpaces"
				? postcode.replace(/ /g, "")
				: rule.normalization === "removeSpacesAndHyphens"
					? postcode.trim().replace(/[\s-]/g, "")
					: postcode
		return patterns.get(country)?.test(value) ?? false
	}
	return !postcodeValidatorExistsForCountry(country) || postcodeValidator(postcode, country)
}
