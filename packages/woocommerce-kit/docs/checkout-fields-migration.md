# Migrating checkout fields from the `{ values }` API

The next minor replaces `useCheckoutFields({ values })` with form accessors and explicit events. Keep your existing
`QueryClientProvider`, `KizloProvider` and `WooCommerceProvider`. Your form library remains the only editable values store.

1. Change the form type to `CheckoutFormValues`. `CheckoutFieldValues` is the raw editable SDK-shaped draft used by the independent
   core resolvers and `encode`. Both derive their field/value contracts from the active registered client, including
   registered number fields and empty string-select placeholders. Drafts may omit native members and registered answers;
   key conversion preserves these editable value types and optionality.
2. Initialize once with `fields.defaultValues`; do not reset on refetch. For saved SDK values, use `fields.encode(saved)`.
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
   Keep request assembly outside the fields converter. Kit copies common native members only; billing email/Tax ID and
   billing/shipping additional fields remain separate. Sharing is disabled for shipping-free and forced-billing cases.
8. Pass `fields.schema` to the form library's Standard Schema integration. Its input and output are the same encoded
   `CheckoutFormValues`; validation returns the supplied candidate and maps issues to safe form paths. Call
   `fields.decode(values)` to restore original field IDs before passing values to your application submit callback. The
   result is the decoded schema shape, including the sharing control. The application owns confirmation request assembly,
   effective address projection, removal of form-only controls and payment/provider data.
9. After a silent reset or prefill, call `fields.reevaluate()`. This reevaluates fields without clearing a coherent prefilled
   country/state pair. Keep the form library's reset defaults when refreshing its options; the TanStack example shows this.

```tsx
// Before: each values render reevaluated the fields, with raw paths and consumer adapters.
const fields = useCheckoutFields({ values })

// After: the form commits an edit, then its single configured route reevaluates the fields.
const fields = useCheckoutFields({ getValues: readFormValues, setValues: applyFormPatches })
form.reset(fields.encode(savedFields))
fields.reevaluate()
// Inside the form's validated submit callback:
await onSubmit(fields.decode(formValues))
```

The complete [TanStack Form](../types/checkout-fields.example.tsx) and
[React Hook Form](../types/checkout-fields-rhf.example.tsx) examples render contact, shipping, billing and order fields plus
checkout controls in one form. They preserve the setter contract, wire a single event route and pass decoded values to
application-owned submit callbacks. Repricing, address persistence, checkout status and server-error integration remain in
their respective hooks and application callbacks. The fields hook adds no lifecycle callbacks or network mutations.

## Migrating key conversions

Rename `fields.getInput(raw)` to `fields.encode(raw)` and `fields.getOutput(values)` to `fields.decode(values)`. The old
getters are removed. Both new methods are synchronous, source-independent key transformations. They preserve the supplied
shape and values, including empty registered selects, omitted native members, independent addresses and form controls.
Initialize from `fields.defaultValues` when you want the checkout's saved values; encoding itself adds no defaults.

The decoder no longer projects billing/shipping addresses, omits digital shipping or filters members. Move those decisions to
the application checkout integration. A decoded draft remains a draft rather than a complete `ConfirmCheckoutInput`; the
converter neither rejects missing confirmation members nor performs field validation. Key collisions still throw to prevent
silent data loss. Runtime rules remain in `fields.schema`, which the form library executes.

The introspection-generated additional-field registrations continue to supply the TypeScript value types through the active
client. The encoded and decoded representations retain those types and optionality. Runtime storefront bindings and field
schemas supply the corresponding form rules; conversion only reverses the key encoding.

For repricing, pass native address snapshots to `useCartAddress().onAddressChange`, including `country`, `state`, `city`,
`postcode` and the current sharing selection. Cart actions apply the store's effective-address policy to drafts separately
from field key conversion.
