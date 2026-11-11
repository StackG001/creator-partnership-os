# publisher

Pushes the finished funnel to Whop, records the revenue split, and syncs sales back into `Launch` so results are logged per creator.

`--dry-run` prints the exact API payload without creating anything.

## How the creator is paid

The creator is paid through **Whop revenue share**, not an affiliate link. They
get 50% of every sale of their product, set on that product only and
calculated after all Whop fees (see `docs/partnership-terms.md`).

A live publish uses the official SDK (`@whop/sdk`, pinned at 2.7.0) and makes
four calls, in this order:

1. `affiliates.create`: the creator's affiliate record on our account, or the
   existing one if they already have it.
2. `products.create`
3. `affiliates.overrides.create` with `override_type: "rev_share"`, the
   product's id, `commission_value` 50 and `revenue_basis: "post_fees"`.
4. `checkoutConfigurations.create`, with a one-time `variant` on that product.

The checkout is created only after the override succeeds. If step 3 fails,
the product exists in Whop but nothing is on sale, and the error says so.

How to run it:

```
npm run publisher -- --handle emmarepairs --whop-user <their Whop username/email> --dry-run   # prints all four calls, makes none
npm run publisher -- --handle emmarepairs --whop-user <their Whop username/email>
npm run deals -- --terms @emmarepairs --whop-user <username>    # or save it on the deal first
```

- **No Whop account on file:** a live publish refuses unless `--whop-user`
  (or `Deal.whopUser`) is set.
- **`--skip-rev-share`:** publishes without the override. The Launch is marked
  `REV SHARE NOT SET IN WHOP` and `deals --report` flags it until it's done by
  hand.
- **Launch IDs:** `externalProductId` is the `prod_…` and `externalPlanId` is
  the checkout variant's `plan_…`.
