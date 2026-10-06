# Migrating checkout fields from the `{ values }` API

The next minor replaces `useCheckoutFields({ values })` with form accessors and explicit events. Keep your existing
`QueryClientProvider`, `KizloProvider` and `WooCommerceProvider`. Your form library remains the only editable values store.

1. Change the form type to `CheckoutFormValues`. `CheckoutFieldValues` remains the raw SDK input type used by the independent
   core resolvers and `getInput`. Both derive their field/value contracts from the active registered client, including
   registered number fields.
2. Initialize once with `fields.defaultValues`; do not reset on refetch. For saved SDK values, use `fields.getInput(saved)`.
   Store raw `field.key` only when you need its SDK identity; use `field.name` for the form library. Remove external opaque-ID
   encoding and decoding. A literal `%2E` in an ID is encoded again and round-trips distinctly from a literal dot.
3. Replace the render-driven `values` argument with `getValues` and synchronous `setValues`. Remove the values-only
   subscription used to update field definitions. The getter returns the complete current snapshot; the setter receives
   readonly named patches and does not reset the whole form or defaults.
4. Call `fields.handleFieldChange(name, normalizedValue)` once after each relevant edit commits. Choose either a form listener
   or a field callback, and avoid attaching both. Remove application country/state clearing: Kit now requests those clears.
   Native `getProps` forwards into your form callback and does not duplicate your configured event route.
5. Honor each patch's separate listener, interaction metadata and validation options. Dependency clears use
   `{ runListeners: false, meta: "preserve", validate: false }`; they preserve existing dirty/touched state. Apply all patches
   before requested validation. For TanStack, map to `dontRunListeners`, `dontUpdateMeta` and `dontValidate`; preserve
   interaction flags if `validateField` itself touches a field. In React Hook Form, map metadata to `shouldDirty`/`shouldTouch`,
   apply with `shouldValidate: false`, and call `trigger` only after the complete patch list when requested. The example uses a
   field-level route, so `setValue` does not reenter it.
6. Render from `definition.getProps({ value, onValueChange, onBlur, invalid })`. Discriminate `kind`, spread `props`, supply
   select options from metadata, and render your own label/error markup. Remove local country/state widgets and native
   normalization. `errorId` associates errors with the generated control. Hidden fields keep their stored values.
7. Use the optional `useShippingAsBilling` boolean in this same form only when `fields.canUseShippingAsBilling` is true.
   Remove local address presentation/output adapters. Kit copies common native members only; billing email/Tax ID and
   billing/shipping additional fields remain separate. Sharing is disabled for shipping-free and forced-billing cases.
8. Pass `fields.schema` to the form library's Standard Schema integration. Validation uses the supplied candidate and returns
   its encoded representation on success, with safe issue paths on failure. Always call `fields.getOutput(values)` at the
   SDK boundary, even after successful validation. The output remains a partial SDK input: supply/check any confirmation
   requirements, such as billing address and payment method, when composing the separate `useCheckout` action.
9. After a silent reset or prefill, call `fields.reevaluate()`. This reevaluates fields without clearing a coherent prefilled
   country/state pair. Keep the form library's reset defaults when refreshing its options; the TanStack example shows this.

```tsx
// Before: each values render reevaluated the fields, with raw paths and consumer adapters.
const fields = useCheckoutFields({ values })

// After: the form commits an edit, then its single configured route reevaluates the fields.
const fields = useCheckoutFields({ getValues: readFormValues, setValues: applyFormPatches })
form.reset(fields.getInput(savedFields))
fields.reevaluate()
const sdkFields = fields.getOutput(formValues)
```

The complete [TanStack Form](../types/checkout-fields.example.tsx) and
[React Hook Form](../types/checkout-fields-rhf.example.tsx) examples render contact, shipping, billing and order fields plus
checkout controls in one form. They preserve the setter contract, wire a single event route and demonstrate separate
confirmation. Repricing, address persistence, checkout status and server-error integration remain in their respective hooks
and application callbacks. The fields hook adds no lifecycle callbacks or network mutations.
