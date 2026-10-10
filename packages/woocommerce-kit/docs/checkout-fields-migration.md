# Validated checkout preparation and availability

Upgrade the registered SDK to `@kizlo/woocommerce@^0.15.0` and the browser client to `kizlo@^0.26.1` together.
Guard `fields.isReady` once in the parent. Pass the narrowed `ReadyCheckoutFieldsApi` to a child keyed by `fields.session`,
then initialize the native form directly with its required `defaultValues` and `schema`. Bind the optional native adapter
in that child. The complete [TanStack](../types/checkout-fields.example.tsx) and
[RHF](../types/checkout-fields-rhf.example.tsx) examples follow this pattern without empty defaults or reset effects.

Replace application confirmation projection and completeness casts with:

```tsx
await checkout.confirmAsync(fields.toCheckout({ input: { paymentData: providerData } }))
// Or supply the submit callback's exact candidate:
await checkout.confirmAsync(fields.toCheckout({ values: formValues, input: { successPath: "/thanks" } }))
```

Preparation decodes field IDs, replaces top-level properties with raw `input`, projects effective addresses, and validates
merchant conditions and SDK request structure. Supplied nested objects/arrays replace the property completely. Provider
payloads and return paths are retained; response extensions are not copied. Missing sources, missing current values or
invalid final input throw `CheckoutPreparationError` with field-path issues and populate the existing form error channels.
The form retains its dirty/touched state. Key codecs remain lossless and manual request assembly remains supported.

`expectedTotal` defaults to the minor-unit digit string represented by the committed cart sources. Explicit
`input.expectedTotal` overrides it; an explicit `undefined` omits protection. An already prepared request never adopts a
later fetched amount. Preparation performs no request, address save, refresh or tokenization.

Use `fields.isLoading` for initial acquisition and `fields.isFetching` for background progress. `fields.error` now wraps
all failed sources in `failures`, retaining their original SDK errors; `cause`, `source`, `code` and `data` describe the first
failure. Move address-save error reads to `fields.syncError`. Use `fields.refresh()` for aggregate retry. Cached usable
sources remain ready after background failure. Unavailable reasons distinguish loading, failed acquisition, paid checkout
and missing data. Availability stays separate from `checkout.isLocked`, form validity and gateway eligibility.

On `CHECKOUT_TOTAL_MISMATCH`, render the checkout-level review message and updated shared-cart total. Kit publishes
current evidence or reconciles it safely, keeps the draft, and performs no automatic confirmation retry. A new explicit
submit gesture prepares the newly displayed total. Clear settled submission errors with `checkout.reset()` before native
validation of that attempt. Historical additional-field keys stay available for server sanitization; numeric request
answers are rejected because the supported SDK scalar structure is string/boolean.

## Earlier accessor migration

### Migrating checkout fields from the `{ values }` API

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
   or a field callback, and avoid attaching both. Remove application country/state/postcode clearing: Kit now requests those clears.
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
   Use `toCheckout()` for validated preparation, or retain explicit manual assembly. Kit copies common native members only; billing email/Tax ID and
   billing/shipping additional fields remain separate. Sharing is disabled for shipping-free and forced-billing cases.
8. Pass `fields.schema` to the form library's Standard Schema integration. Its input and output are the same encoded
   `CheckoutFormValues`; validation returns the supplied candidate and maps issues to safe form paths. Call
   `fields.decode(values)` to restore original field IDs before passing values to your application submit callback. The
   result is the decoded draft, including the sharing control. Use `toCheckout({ values, input })` when you want Kit to prepare
   confirmation; manual assembly remains available.
9. After a silent reset or prefill, call `fields.reevaluate()`. This reevaluates fields without clearing a coherent prefilled
   country/state/postcode set. Keep the form library's reset defaults when refreshing its options; the TanStack example shows this.

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
checkout controls in one form. They preserve the setter contract, wire a single event route and prepare requests for
direct confirmation. The examples bind named validation and input blur to automatic address syncing; cart transport
owns scheduling and requests, and the application still invokes confirmation explicitly. Metadata-only fields consumers do not initiate saves.

## Migrating key conversions

Rename `fields.getInput(raw)` to `fields.encode(raw)` and `fields.getOutput(values)` to `fields.decode(values)`. The old
getters are removed. Both new methods are synchronous, source-independent key transformations. They preserve the supplied
shape and values, including empty registered selects, omitted native members, independent addresses and form controls.
Initialize from `fields.defaultValues` when you want the checkout's saved values; encoding itself adds no defaults.

The decoder no longer projects billing/shipping addresses, omits digital shipping or filters members. Use `toCheckout()` for those decisions, or retain
your manual checkout integration. A decoded draft remains a draft rather than a complete `ConfirmCheckoutInput`; the
converter neither rejects missing confirmation members nor performs field validation. Key collisions still throw to prevent
silent data loss. Runtime rules remain in `fields.schema`, which the form library executes.

The introspection-generated additional-field registrations continue to supply the TypeScript value types through the active
client. The encoded and decoded representations retain those types and optionality. Runtime storefront bindings and field
schemas supply the corresponding form rules; conversion only reverses the key encoding.

## Migrating automatic address updates

Bind `validateField(name): boolean | Promise<boolean>` together with `getValues` and `setValues` to activate automatic
syncing on one fields hook per form. Remove the separate cart `onAddressChange` listener. Run Kit's schema and your
application validation; do not treat cached errors as fresh validity. RHF can use `form.trigger(name)` through its resolver.
TanStack must execute the same schema for its sync-time validation cause, await the named result, and restore any
synchronously changed interaction flags immediately, without restoring stale flags after an async result.

Call `fields.handleFieldBlur(name)` after the form's blur handler. Kit debounces typing for 1500 ms and flushes valid country
changes/blur. Pending invalid fields block the combined address batch; unrelated unchanged errors do not. State and postcode
are cleared on country changes unless replacements are supplied together. Empty country resets have a narrow sync exemption;
full submission still validates all required fields. Postcodes now receive a local country-specific format check.

The form retains its values when cart responses arrive. `isRepricing` includes validation and queued/in-flight saves, which also
participate in `useCheckout().isLocked` and its confirmation guard. Failure retains the draft and checkout guard through invalid
edits; another edit or blur retries, or returning to the acknowledged address clears the failure. Hidden values/constraints and independent
registered address buckets keep their existing Kit contract.

Remove imports of `isAddressComplete` and `defaultShouldUpdateAddress`; neither is public. Do not replace them with a
whole-address completeness gate. Standalone `useCartAddress` remains available with its existing default or full replacement
callback, explicit patch mutations, and new `flush()`/`cancel()` controls.
