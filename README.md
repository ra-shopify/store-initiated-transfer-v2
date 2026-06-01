# Store Initiated Transfer V2

A Shopify **Point of Sale (POS) UI extension** that lets a store clerk create an
inventory transfer from the POS device they're standing at. The clerk picks a
destination location, builds a list of items (by scanning or searching), adjusts
quantities, and submits. The transfer is created and immediately promoted to
**Ready to Ship**.

The extension is built with `@shopify/ui-extensions-react/point-of-sale` and talks
to the Admin GraphQL API directly from the device.

---

## What the app does

The extension injects into two places on the POS home screen:

| Target | Module | Purpose |
| --- | --- | --- |
| `pos.home.tile.render` | [`Tile.jsx`](extensions/store-initiated-transfer-v2/src/Tile.jsx) | A "Store Initiated Transfers" tile. Tapping it opens the modal. |
| `pos.home.modal.render` | [`Modal.jsx`](extensions/store-initiated-transfer-v2/src/Modal.jsx) | The full transfer workflow. |

The workflow:

1. **Origin is automatic.** The origin is the location the POS device is currently
   signed into — the clerk never picks it.
2. **Choose a destination.** A second screen lists every other location (filterable
   by name) and the clerk taps one.
3. **Add items** by any of the three methods below.
4. **Review and adjust quantities.** Each line has a `−` / number / `+` control.
   Over-transferring (more than is available at the origin) is allowed but raises a
   warning toast, so a transfer can still be recorded when on-hand counts are stale.
5. **Submit.** The app creates the transfer and marks it ready to ship.

As items are added, the app looks up the variant's available quantity at **both** the
origin and the destination, so the clerk can see what's actually in stock before
committing.

---

## The three ways to add items

All three funnel into the same line-item list. The only difference is how a variant
gets identified.

### 1. Manual search

A `SearchBar` at the bottom of the setup screen. Typing is debounced (~350ms) and
runs a `productVariants` query that matches on **barcode, SKU, product title, and
variant title** (`barcode:* OR sku:* OR title:* OR product_title:*`). Up to 25
matches are shown as rows with an **Add** button. This is the fallback for items
without a scannable barcode, or when the clerk only knows the product name.

### 2. Camera scanner

A **"Scan with camera"** button toggles the built-in `<CameraScanner />` component
on. Barcodes read by the camera are delivered through `useScannerDataSubscription()`
with `source: 'camera'`.

### 3. Hardware / regular scanner

A connected barcode scanner (Bluetooth sled, USB, or the embedded device scanner)
needs **no UI** — it's always listening. Those scans arrive through the *same*
`useScannerDataSubscription()` hook, just with `source: 'external'` or
`source: 'embedded'` instead of `'camera'`.

Because the camera and the hardware scanner share one subscription, both run through
the same handler: a scan triggers an **exact** barcode lookup
(`productVariants(first: 1, query: "barcode:...")`). If the variant is already on the
list its quantity is incremented; otherwise a new line is added.

> **Scan de-duplication.** The scan handler keys off the *identity* of the
> scan-result object (tracked with a ref guard), not its string value. This prevents
> an unrelated re-render — e.g. tapping `+` on a line — from replaying the last
> barcode and adding a phantom unit. The guard is seeded with the current scan result
> on mount so a stale barcode left over from a previous session isn't auto-added.

---

## GraphQL operations

Everything talks to the Admin GraphQL API via
`fetch('shopify:admin/api/graphql.json', { method: 'POST', ... })` from inside the
extension. No app backend is involved in the transfer flow.

### Queries

| Query | Used for |
| --- | --- |
| `locations(first: 250)` | Populate the destination list. |
| `productVariants(first: 1, query: "barcode:...")` | Resolve a scanned barcode to one variant, including its `inventoryLevel` available quantity at the origin and destination. |
| `productVariants(first: 25, query: $searchQuery)` | Back the manual search bar. |

### Mutations

The submit step is **two mutations in sequence**.

#### 1. `inventoryTransferCreate` — creates the transfer (as a DRAFT)

```graphql
mutation inventoryTransferCreate($input: InventoryTransferCreateInput!, $idempotencyKey: String!)
  @idempotent(key: $idempotencyKey) {
  inventoryTransferCreate(input: $input) {
    inventoryTransfer { id status }
    userErrors { field message }
  }
}
```

The `input` carries:

- `originLocationId` (the device's location) and `destinationLocationId`
- `lineItems`: `[{ inventoryItemId, quantity }]`
- `dateCreated`, a `note`, a `referenceName` (`POS-Transfer-<timestamp>`), and
  `tags: ["pos-transfer", "store-initiated"]` so these transfers are easy to filter
  in the admin.

**Idempotency.** The mutation is wrapped in the `@idempotent(key:)` directive and
passed a fresh `crypto.randomUUID()` key. If the request is retried (flaky POS
network, double tap), the server returns the *same* transfer instead of creating a
duplicate. This matters on a shop floor where connectivity is unreliable and a
double-submit would otherwise create two real transfers.

`inventoryTransferCreate` produces the transfer in **DRAFT** status.

#### 2. `inventoryTransferMarkAsReadyToShip` — promotes DRAFT → READY_TO_SHIP

```graphql
mutation inventoryTransferMarkAsReadyToShip($id: ID!) {
  inventoryTransferMarkAsReadyToShip(id: $id) {
    inventoryTransfer { id status }
    userErrors { field message }
  }
}
```

A draft transfer isn't actionable by the receiving location yet, so the app
immediately calls this with the new transfer's `id`. On success the status becomes
**READY_TO_SHIP** and the clerk is done. If this second call fails, the app reports
that the transfer was saved as a **draft** (it still exists and can be promoted later
from the admin) rather than silently losing the work.

### Access scopes

The operations above require these scopes (declared in
[`shopify.app.toml`](shopify.app.toml)):

- `read_locations` — list locations
- `read_inventory` — read per-location available quantities
- `write_inventory_transfers` — create and promote transfers
- `write_products` — product / variant lookups

---

## Project layout

```
extensions/store-initiated-transfer-v2/
  shopify.extension.toml   # api_version, targets
  src/
    Tile.jsx               # POS home tile -> opens the modal
    Modal.jsx              # the entire transfer workflow
```

The surrounding Remix app (`app/`, `prisma/`, etc.) is the standard app scaffold used
for OAuth / installation; the transfer feature itself lives entirely in the POS
extension and calls the Admin API directly.

> **Note:** `shopify.extension.toml` sets `api_version = "unstable"` because the
> inventory-transfer mutations are still on the unstable channel. Pin this to a stable
> version once those APIs graduate.

---

## Running locally

### Prerequisites

- [Node.js](https://nodejs.org/en/download/)
- A [Shopify Partner account](https://partners.shopify.com/signup)
- A [development store](https://help.shopify.com/en/partners/dashboard/development-stores#create-a-development-store)
  with POS, plus a device or the POS simulator to preview the extension

### Start

```shell
npm install
npm run dev
```

`npm run dev` launches the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli),
which builds the extension, creates a tunnel, and lets you preview the tile and modal
on a development store's POS.

---

## Resources

- [POS UI extensions](https://shopify.dev/docs/api/pos-ui-extensions)
- [`inventoryTransferCreate` mutation](https://shopify.dev/docs/api/admin-graphql/unstable/mutations/inventoryTransferCreate)
- [`inventoryTransferMarkAsReadyToShip` mutation](https://shopify.dev/docs/api/admin-graphql/unstable/mutations/inventoryTransferMarkAsReadyToShip)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
