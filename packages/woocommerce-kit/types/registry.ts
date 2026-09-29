/**
 * Registers the WooCommerce contract with `kizlo` for this package's own type-checking.
 *
 * `ActiveKizloClient` resolves from whatever procedures a project registered, and falls back to `any` when nothing has been.
 * A consuming storefront registers its own in its generated barrel; the kit has no barrel, so without this file the kit's
 * calls would compile against that fallback and drift from the contract unnoticed.
 *
 * It is listed in `tsconfig.json` and deliberately not in `tsconfig.build.json`: nothing imports it, so it stays out of the
 * entry graph and the published declarations name `ActiveKizloClient` rather than baking this repo's contract into them.
 *
 * Nothing here talks to a running WordPress. The procedure tree is static, so this is written rather than generated.
 */

import type { woocommerce } from "@kizlo/woocommerce"
import type { RootProcedures } from "kizlo"

declare module "kizlo" {
	interface KizloProcedureRegistry {
		procedures: RootProcedures<[ReturnType<typeof woocommerce>]>
	}
}
