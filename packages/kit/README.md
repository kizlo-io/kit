# @kizlo/kit

Shared primitives for the Kizlo component kits: the pieces every integration kit needs and none of them should own.

Install it only to use it directly; the kits depend on it themselves.

```bash
pnpm add @kizlo/kit
```

Peer dependencies: `kizlo` 0.23+, which is where the client's type comes from, and `react` 19+ — both only if you import
`@kizlo/kit/react`, and both optional, so this package's framework-agnostic core drags neither into an app that wants
`decodeHtmlEntities` and nothing else.

| Import | Contents |
| --- | --- |
| `@kizlo/kit` | `decodeHtmlEntities`. No framework. |
| `@kizlo/kit/react` | `KizloProvider`, `useKizloContext`. Carries `"use client"`. |

## `KizloProvider` and `useKizloContext`

Mount your Kizlo client once and every kit's client-side hooks read it from there — no client prop on a hook, no kit importing
your client singleton:

```tsx
// app/providers.tsx
"use client"
import { KizloProvider } from "@kizlo/kit/react"
import { QueryClientProvider } from "@tanstack/react-query"
import { client } from "@/lib/kizlo/client"
import { queryClient } from "@/lib/query-client"

export function Providers({ children }) {
	return (
		<QueryClientProvider client={queryClient}>
			<KizloProvider client={client}>{children}</KizloProvider>
		</QueryClientProvider>
	)
}
```

Server components cannot read React context, so they keep taking the client as a prop. That is why a kit's server entry has a
`client` prop and its hooks do not. The browser client and the server client are different instances, so neither half holds the
other's.

A hook reads it with `useKizloContext()`:

```tsx
const { client } = useKizloContext()
await client.woocommerce.cart.get.call()
```

No path and no type argument, because there is nothing left to assert: `client` is typed `ActiveKizloClient`, which `kizlo`
resolves from the procedures your generated barrel registered. A call your contract does not carry is a compile error, and the
integration you forgot to install shows up in `tsc` rather than in a request.

The hook returns the context object rather than the client itself, so a locale, a session or kit-wide configuration can join it
later without changing a signature. It throws when no provider is mounted — the client is not optional, so every kit hook needs
`KizloProvider` above it.

## `decodeHtmlEntities(text)`

WordPress leaves entities in every `rendered` text field, so a product name arrives as `Kid&#8217;s bag`. Decode it before
putting it in a text node:

```tsx
import { decodeHtmlEntities } from "@kizlo/kit"

<h1>{decodeHtmlEntities(product.name)}</h1>
```

Rich content is different: that stays HTML and gets rendered as HTML.
