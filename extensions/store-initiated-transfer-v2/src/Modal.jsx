import React, { useState, useEffect, useRef } from 'react'
import {
  Navigator,
  Screen,
  Text,
  ScrollView,
  Section,
  Button,
  TextField,
  NumberField,
  SearchBar,
  CameraScanner,
  Box,
  Stack,
  Image,
  Icon,
  Selectable,
  useApi,
  useScannerDataSubscription,
  reactExtension,
} from '@shopify/ui-extensions-react/point-of-sale'

  const Modal = () => {
  const api = useApi()
  const {currentSession} = api.session
  const {locationId, userId, staffMemberId} = currentSession
  const [selectedDestination, setSelectedDestination] = useState(null)
  const [locations, setLocations] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [destFilterKey, setDestFilterKey] = useState(0) // Bumped to remount the destination filter so it resets each visit
  const [scannedItems, setScannedItems] = useState([])
  const [lastScannedItem, setLastScannedItem] = useState(null)
  const [isCreatingTransfer, setIsCreatingTransfer] = useState(false)
  const [showCamera, setShowCamera] = useState(false)
  const [itemSearchResults, setItemSearchResults] = useState([])
  const [isSearchingItems, setIsSearchingItems] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const isProcessingScanRef = useRef(false)
  const searchDebounceRef = useRef(null) // Holds the pending manual-search timer so we can debounce keystrokes

  // Scanner API subscription.
  // Keep the whole result object: the subscription emits a NEW object on every
  // scan event (even when the same barcode is scanned twice in a row), so its
  // identity is what tells us a real scan happened — unlike `data`, which stays
  // the same string for repeat scans of one barcode.
  const scanResult = useScannerDataSubscription()
  const scannerData = scanResult?.data
  const scannerSource = scanResult?.source
  // Tracks the last scan result we've already dispatched. Initialized to the
  // current value so a stale barcode left in the (module-global) subscribable
  // from a previous modal session is NOT auto-added on mount.
  const processedScanRef = useRef(scanResult)

  // Fetch locations from Shopify Admin API
  const fetchLocations = async () => {
    try {
      const requestBody = {
        query: `
          query {
            locations(first: 250) {
              edges {
                node {
                  id
                  name
                  address {
                    formatted
                  }
                }
              }
            }
          }
        `,
      };

      const res = await fetch('shopify:admin/api/graphql.json', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      const jsonResponse = await res.json();

      if (jsonResponse.errors) {
        console.error('GraphQL errors:', jsonResponse.errors);
        return [];
      }

      const locationsData = jsonResponse?.data?.locations?.edges || [];
      
      // Transform location data for our use
      const transformedLocations = locationsData.map(edge => {
        const location = edge.node;
        // Handle address - formatted field returns an array
        const addressLines = location.address?.formatted || [];
        
        return {
          id: location.id,
          name: location.name,
          address: addressLines.join(', ') || 'No address available',
          addressLines: addressLines
        };
      });
      setLocations(transformedLocations);
      return transformedLocations;
    } catch (error) {
      console.error('Error fetching locations:', error);
      return [];
    }
  };

  // Find current location for origin display
  const currentLocation = locations.find(location => location.id === `gid://shopify/Location/${locationId}`)
  
  // Filter out current location from destination options
  let destinationOptions = locations.filter(location => location.id !== `gid://shopify/Location/${locationId}`)
  
  // Apply search filter if search term exists
  if (searchTerm.trim()) {
    const searchLower = searchTerm.toLowerCase().trim();
    destinationOptions = destinationOptions.filter(location => {
      // Check if location name contains search term
      const nameMatch = location.name.toLowerCase().includes(searchLower);
      
      // Check if any address line contains search term
      const addressMatch = location.addressLines.some(line => 
        line.toLowerCase().includes(searchLower)
      );
      
      return nameMatch || addressMatch;
    });
  }

  // Dispatch a scan only when the subscription emits a NEW result object.
  // Each real scan event (including a second scan of the same barcode) produces
  // a fresh object, so depending on its identity fires once per scan. Unrelated
  // re-renders — e.g. pressing the quantity +/- buttons — reuse the same object,
  // so they no longer replay the last barcode and bump a random row.
  React.useLayoutEffect(() => {
    if (scanResult === processedScanRef.current) return;
    processedScanRef.current = scanResult;

    if (scannerData && !isCreatingTransfer && !isProcessingScanRef.current) {
      isProcessingScanRef.current = true;

      handleScanEvent(scannerData, scannerSource).finally(() => {
        isProcessingScanRef.current = false;
      });
    }
  }, [scanResult])

  // Fetch variant by barcode with inventory levels
  const fetchVariantByBarcode = async (barcode) => {
    try {
      // Construct the query with proper barcode filter
      const barcodeQuery = `barcode:${barcode}`;
      
      const requestBody = {
        query: `
          query GetVariantByBarcode($originLocationId: ID!, $destinationLocationId: ID!) {
            productVariants(first: 1, query: "${barcodeQuery}") {
              edges {
                node {
                  id
                  title
                  barcode
                  price
                  image {
                    url
                  }
                  product {
                    id
                    title
                    featuredImage {
                      url
                    }
                  }
                  inventoryItem {
                    id
                    originInventoryLevel: inventoryLevel(locationId: $originLocationId) {
                      quantities(names: "available") {
                        quantity
                      }
                    }
                    destinationInventoryLevel: inventoryLevel(locationId: $destinationLocationId) {
                      quantities(names: "available") {
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          originLocationId: currentLocation?.id,
          destinationLocationId: selectedDestination?.id
        },
      };

      const res = await fetch('shopify:admin/api/graphql.json', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      const jsonResponse = await res.json();

      if (jsonResponse.errors) {
        console.error('GraphQL errors:', jsonResponse.errors);
        return null;
      }

      const variants = jsonResponse?.data?.productVariants?.edges || [];
      
      if (variants.length === 0) {
        return null; // No variant found
      }

      const variant = variants[0].node;
      
      // Extract inventory quantities
      const originInventory = variant.inventoryItem?.originInventoryLevel?.quantities?.[0]?.quantity || 0;
      const destinationInventory = variant.inventoryItem?.destinationInventoryLevel?.quantities?.[0]?.quantity || 0;

      return {
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem?.id,
        title: variant.title,
        barcode: variant.barcode,
        price: variant.price,
        variantImage: variant.image?.url,
        productImage: variant.product?.featuredImage?.url,
        productTitle: variant.product?.title,
        productId: variant.product?.id,
        originInventory,
        destinationInventory
      };
    } catch (error) {
      console.error('Error fetching variant by barcode:', error);
      return null;
    }
  };

  // Fetch variants by free-text search (description/title, barcode, or SKU)
  // Returns multiple matches with inventory levels for the selected locations
  const fetchVariantsBySearch = async (term) => {
    try {
      // Match on barcode, SKU, variant title, and product title (partial)
      const escaped = term.trim().replace(/["\\]/g, '');
      const searchQuery =
        `barcode:${escaped}* OR sku:${escaped}* OR title:*${escaped}* OR product_title:*${escaped}*`;

      const requestBody = {
        query: `
          query SearchVariants($searchQuery: String!, $originLocationId: ID!, $destinationLocationId: ID!) {
            productVariants(first: 25, query: $searchQuery) {
              edges {
                node {
                  id
                  title
                  barcode
                  sku
                  price
                  image {
                    url
                  }
                  product {
                    id
                    title
                    featuredImage {
                      url
                    }
                  }
                  inventoryItem {
                    id
                    originInventoryLevel: inventoryLevel(locationId: $originLocationId) {
                      quantities(names: "available") {
                        quantity
                      }
                    }
                    destinationInventoryLevel: inventoryLevel(locationId: $destinationLocationId) {
                      quantities(names: "available") {
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          searchQuery,
          originLocationId: currentLocation?.id,
          destinationLocationId: selectedDestination?.id
        },
      };

      const res = await fetch('shopify:admin/api/graphql.json', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      const jsonResponse = await res.json();

      if (jsonResponse.errors) {
        console.error('GraphQL errors:', jsonResponse.errors);
        return [];
      }

      const variants = jsonResponse?.data?.productVariants?.edges || [];

      return variants.map(({ node: variant }) => {
        const originInventory = variant.inventoryItem?.originInventoryLevel?.quantities?.[0]?.quantity || 0;
        const destinationInventory = variant.inventoryItem?.destinationInventoryLevel?.quantities?.[0]?.quantity || 0;

        return {
          variantId: variant.id,
          inventoryItemId: variant.inventoryItem?.id,
          title: variant.title,
          barcode: variant.barcode,
          sku: variant.sku,
          price: variant.price,
          variantImage: variant.image?.url,
          productImage: variant.product?.featuredImage?.url,
          productTitle: variant.product?.title,
          productId: variant.product?.id,
          originInventory,
          destinationInventory
        };
      });
    } catch (error) {
      console.error('Error searching variants:', error);
      return [];
    }
  };

  // Helper function to get display title (variant title or product title)
  const getDisplayTitle = (variant) => {
    const hasValidVariantTitle = variant.title && 
                                variant.title.trim() !== '' && 
                                variant.title !== 'Default Title';
    return hasValidVariantTitle ? variant.title : variant.productTitle;
  };

  // Helper function to get image URL (variant image or product image)
  const getImageUrl = (variant) => {
    return variant.variantImage || variant.productImage || null;
  };

  // Create inventory transfer
  // Move a freshly created transfer out of DRAFT and into READY_TO_SHIP.
  // Returns the updated transfer on success, or an error shape on failure.
  const markTransferAsReadyToShip = async (transferId) => {
    try {
      const requestBody = {
        query: `
          mutation InventoryTransferMarkAsReadyToShip($id: ID!) {
            inventoryTransferMarkAsReadyToShip(id: $id) {
              inventoryTransfer {
                id
                name
                status
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          id: transferId
        }
      };

      const res = await fetch('shopify:admin/api/graphql.json', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      const jsonResponse = await res.json();

      if (jsonResponse.errors) {
        console.error('GraphQL errors (mark ready):', jsonResponse.errors);
        return { success: false, errors: jsonResponse.errors };
      }

      const { inventoryTransfer, userErrors } =
        jsonResponse?.data?.inventoryTransferMarkAsReadyToShip || {};

      if (userErrors && userErrors.length > 0) {
        console.error('User errors (mark ready):', userErrors);
        return { success: false, userErrors };
      }

      return { success: true, transfer: inventoryTransfer };
    } catch (error) {
      console.error('Error marking transfer as ready to ship:', error);
      return { success: false, error: error.message };
    }
  };

  const createInventoryTransfer = async (scannedItems, originLocation, destinationLocation) => {
    try {
      // Build line items from scanned items
      const lineItems = scannedItems.map(item => ({
        inventoryItemId: item.inventoryItemId,
        quantity: item.qtyAdded
      }));

      // Build the input payload
      const input = {
        dateCreated: new Date().toISOString(),
        destinationLocationId: destinationLocation.id,
        lineItems: lineItems,
        note: `Store transfer created via POS - ${scannedItems.length} items`,
        originLocationId: originLocation.id,
        referenceName: `POS-Transfer-${Date.now()}`,
        tags: ["pos-transfer", "store-initiated"]
      };

      // Generate idempotency key to prevent duplicate transfers
      const idempotencyKey = crypto.randomUUID();

      const requestBody = {
        query: `
          mutation InventoryTransferCreate($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
            inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
              inventoryTransfer {
                id
                name
                status
                dateCreated
                destination {
                  location {
                    id
                    name
                  }
                }
                origin {
                  location {
                    id
                    name
                  }
                }
                lineItems(first: 250) {
                  edges {
                    node {
                      title
                      totalQuantity
                      inventoryItem {
                        id
                      }
                    }
                  }
                }
                lineItemsCount{
                  count
                  precision
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          input: input,
          idempotencyKey: idempotencyKey
        }
      };

      const res = await fetch('shopify:admin/api/graphql.json', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      const jsonResponse = await res.json();

      if (jsonResponse.errors) {
        console.error('GraphQL errors:', jsonResponse.errors);
        return { success: false, errors: jsonResponse.errors };
      }

      const { inventoryTransfer, userErrors } = jsonResponse?.data?.inventoryTransferCreate || {};

      if (userErrors && userErrors.length > 0) {
        console.error('User errors:', userErrors);
        return { success: false, userErrors };
      }

      if (inventoryTransfer) {
        // The transfer is created in DRAFT status; promote it to READY_TO_SHIP.
        const readyResult = await markTransferAsReadyToShip(inventoryTransfer.id);

        if (!readyResult.success) {
          // The transfer exists (as a draft) but couldn't be marked ready.
          // Surface this so the clerk knows it needs manual promotion.
          return {
            success: true,
            transfer: inventoryTransfer,
            transferId: inventoryTransfer.id,
            transferName: inventoryTransfer.name,
            markReadyError: readyResult
          };
        }

        return {
          success: true,
          transfer: readyResult.transfer || inventoryTransfer,
          transferId: inventoryTransfer.id,
          transferName: inventoryTransfer.name
        };
      }

      return { success: false, error: 'No transfer returned' };
    } catch (error) {
      console.error('Error creating inventory transfer:', error);
      return { success: false, error: error.message };
    }
  };

  // Add or update scanned item in the array
  const addScannedItem = (variant) => {
    const displayTitle = getDisplayTitle(variant);
    const imageUrl = getImageUrl(variant);
    
    // Check if item already exists (by variant ID)
    const existingItemIndex = scannedItems.findIndex(item => item.variantId === variant.variantId);
    
    if (existingItemIndex !== -1) {
      // Item exists - check if we can increment quantity
      const existingItem = scannedItems[existingItemIndex];
      const newQuantity = existingItem.qtyAdded + 1;
      
      if (newQuantity > existingItem.atOrigin) {
        // Allow over-transfer (origin inventory may be inaccurate) but warn.
        api.toast.show(`Warning: transferring more than the ${existingItem.atOrigin} available at origin`);
      }

      // Item exists - increment quantity (immutably: new array AND new object)
      const updatedItem = { ...existingItem, qtyAdded: newQuantity };
      setScannedItems((prev) =>
        prev.map((i) => (i.variantId === variant.variantId ? updatedItem : i))
      );

      // Update last scanned item
      setLastScannedItem(updatedItem);

      return updatedItem;
    } else {
      // Warn if there's no inventory at origin, but still allow adding it.
      if (variant.originInventory === 0) {
        api.toast.show('Warning: no inventory available at origin for this item');
      }

      // New item - add to array
      const newItem = {
        variantId: variant.variantId,
        inventoryItemId: variant.inventoryItemId,
        productId: variant.productId,
        title: displayTitle,
        atOrigin: variant.originInventory,
        atDestination: variant.destinationInventory,
        qtyAdded: 1,
        imageUrl: imageUrl,
        barcode: variant.barcode,
        price: variant.price
      };
      
      // New item - append (functional updater so we always build on the latest state)
      setScannedItems((prev) => [...prev, newItem]);
      
      // Update last scanned item
      setLastScannedItem(newItem);
      
      return newItem;
    }
  };

  // Set an explicit quantity for an item (from the editable number box), clamped to [1, atOrigin]
  const updateItemQty = (variantId, value) => {
    const item = scannedItems.find((i) => i.variantId === variantId);
    if (!item) return;

    const parsed = parseInt(value, 10);
    let qty = isNaN(parsed) ? 1 : parsed;

    if (qty < 1) qty = 1;
    if (qty > item.atOrigin) {
      // Allow over-transfer (origin inventory may be inaccurate) but warn.
      api.toast.show(`Warning: transferring more than the ${item.atOrigin} available at origin`);
    }

    setScannedItems((prev) =>
      prev.map((i) => (i.variantId === variantId ? { ...i, qtyAdded: qty } : i))
    );
  };

  // Increment an item's quantity by 1, capped at available origin inventory
  const incrementItemQty = (variantId) => {
    const item = scannedItems.find((i) => i.variantId === variantId);
    if (!item) return;

    if (item.qtyAdded + 1 > item.atOrigin) {
      // Allow over-transfer (origin inventory may be inaccurate) but warn.
      api.toast.show(`Warning: transferring more than the ${item.atOrigin} available at origin`);
    }

    setScannedItems((prev) =>
      prev.map((i) => (i.variantId === variantId ? { ...i, qtyAdded: i.qtyAdded + 1 } : i))
    );
  };

  // Decrement an item's quantity by 1, with a floor of 1
  const decrementItemQty = (variantId) => {
    setScannedItems((prev) =>
      prev.map((i) =>
        i.variantId === variantId && i.qtyAdded > 1 ? { ...i, qtyAdded: i.qtyAdded - 1 } : i
      )
    );
  };

  // Remove an item from the transfer entirely
  const removeScannedItem = (variantId) => {
    setScannedItems((prev) => prev.filter((i) => i.variantId !== variantId));
    setLastScannedItem((prev) => (prev && prev.variantId === variantId ? null : prev));
  };

  // Handle create transfer button click
  const handleCreateTransfer = async () => {
    // Prevent double-clicks or multiple calls
    if (isCreatingTransfer) {
      return;
    }
    
    if (!currentLocation || !selectedDestination || scannedItems.length === 0) {
      api.toast.show('Please select both locations and scan at least one item.', { type: 'error' });
      return;
    }

    setIsCreatingTransfer(true);
    
    try {
      const result = await createInventoryTransfer(scannedItems, currentLocation, selectedDestination);
      
      if (result.success) {
        if (result.markReadyError) {
          // Transfer was created but stayed in DRAFT — let the clerk know.
          api.toast.show(`Transfer ${result.transferName} created as draft (couldn't mark ready to ship)`);
        } else {
          api.toast.show(`Transfer created and marked ready to ship: ${result.transferName}`, { type: 'success' });
        }

        // Close the modal after successful creation
        api.navigation.dismiss();
      } else {
        // Handle different error types
        if (result.userErrors && result.userErrors.length > 0) {
          const errorMessages = result.userErrors.map(error => error.message).join(', ');
          api.toast.show(`Transfer creation failed: ${errorMessages}`, { type: 'error' });
        } else if (result.errors && result.errors.length > 0) {
          const errorMessages = result.errors.map(error => error.message).join(', ');
          api.toast.show(`GraphQL error: ${errorMessages}`, { type: 'error' });
        } else {
          api.toast.show(`Transfer creation failed: ${result.error || 'Unknown error'}`, { type: 'error' });
        }
      }
    } catch (error) {
      console.error('Error in handleCreateTransfer:', error);
      api.toast.show('Failed to create transfer. Please try again.', { type: 'error' });
    } finally {
      setIsCreatingTransfer(false);
    }
  };

  // Handle scan events
  const handleScanEvent = async (data, source) => {
    // Don't process scans while creating a transfer
    if (isCreatingTransfer) {
      return;
    }
    
    // Check if we have both origin and destination selected
    if (!currentLocation || !selectedDestination) {
      api.toast.show('Please select both origin and destination locations first', { type: 'error' });
      return;
    }

    // Query for the variant by barcode
    const variant = await fetchVariantByBarcode(data);
    
    if (!variant) {
      api.toast.show('Error: Product not found', { type: 'error' });
      return;
    }

    // Add or update the scanned item
    const scannedItem = addScannedItem(variant);
    
    // Only show success toast if item was actually added/updated
    if (scannedItem) {
      api.toast.show(`Added: ${scannedItem.title} (Qty: ${scannedItem.qtyAdded})`, { type: 'success' });
    }
  }

  // Handle manual item search (by description, barcode, or SKU)
  const handleManualSearch = async (term) => {
    if (!term || !term.trim()) {
      setItemSearchResults([]);
      setHasSearched(false);
      return;
    }

    // Require both locations so we can resolve inventory levels
    if (!currentLocation || !selectedDestination) {
      api.toast.show('Please select both origin and destination locations first', { type: 'error' });
      return;
    }

    setIsSearchingItems(true);
    setHasSearched(true);
    try {
      const results = await fetchVariantsBySearch(term);
      setItemSearchResults(results);
    } catch (error) {
      console.error('Error in handleManualSearch:', error);
      api.toast.show('Search failed. Please try again.', { type: 'error' });
      setItemSearchResults([]);
    } finally {
      setIsSearchingItems(false);
    }
  };

  // Search as the user types: clear results on empty, otherwise debounce the
  // network search so we only fire ~350ms after the last keystroke.
  const handleSearchTextChange = (value) => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }

    if (!value || !value.trim()) {
      setItemSearchResults([]);
      setHasSearched(false);
      return;
    }

    searchDebounceRef.current = setTimeout(() => {
      handleManualSearch(value);
    }, 350);
  };

  // Add an item chosen from the manual search results
  const handleAddSearchResult = (variant) => {
    const added = addScannedItem(variant);
    if (added) {
      api.toast.show(`Added: ${added.title} (Qty: ${added.qtyAdded})`, { type: 'success' });
    }
  };

  // Fetch locations on component mount
  useEffect(() => {
    fetchLocations()
  }, [])

  // Render a location's name + address lines (shared by origin/destination displays)
  const LocationDetails = ({ location, placeholder }) =>
    location ? (
      <>
        <Text color="TextSuccess">{location.name}</Text>
        {location.addressLines.map((line, i) => (
          <Text key={i} color="TextSubdued" variant="captionRegular">{line}</Text>
        ))}
      </>
    ) : (
      <Text color="TextSubdued">{placeholder}</Text>
    )

  // Tappable destination row (replaces the destination List)
  const DestinationRow = ({ location }) => (
    <Stack direction="inline" gap="200" alignItems="center" inlineSize="100%">
      <Stack direction="block" flex={1} gap="none">
        <Text>{location.name}</Text>
        {location.addressLines.map((line, i) => (
          <Text key={i} color="TextSubdued" variant="captionRegular">{line}</Text>
        ))}
      </Stack>
      <Box inlineSize="90px">
        <Button
          title="Select"
          onPress={() => {
            setSelectedDestination(location)
            api.navigation.navigate('TransferSetup')
          }}
        />
      </Box>
    </Stack>
  )

  // Search-result row with image + info + Add button (replaces the search List)
  const SearchResultRow = ({ variant }) => {
    const imageUrl = getImageUrl(variant)
    return (
      <Stack direction="inline" gap="200" alignItems="center" inlineSize="100%">
        <Box inlineSize="48px" blockSize="48px">
          {imageUrl ? (
            <Image src={imageUrl} size="cover" />
          ) : (
            <Stack direction="block" inlineSize="100%" blockSize="100%" alignItems="center" justifyContent="center">
              <Icon name="image-placeholder" tone="icon-subdued" />
            </Stack>
          )}
        </Box>
        <Stack direction="block" flex={1} gap="none">
          <Text>{getDisplayTitle(variant)}</Text>
          <Text color="TextSubdued" variant="captionRegular">
            {variant.barcode ? `Barcode: ${variant.barcode}` : 'No barcode'}
          </Text>
          <Text color="TextSubdued" variant="captionRegular">
            At Origin: {variant.originInventory}
          </Text>
        </Stack>
        <Box inlineSize="90px">
          <Button title="Add" onPress={() => handleAddSearchResult(variant)} />
        </Box>
      </Stack>
    )
  }

  return (
    <Navigator>
      <Screen name="TransferSetup" title="Store Transfer">
        <ScrollView>
          <Section title="Transfer Setup">
            <Stack direction="inline" gap="400" alignItems="start">
              {/* Left column: location selection */}
              <Stack direction="block" inlineSize="50%" gap="300">
                <Text>Select origin and destination locations for the transfer:</Text>

                {/* Origin (current location, display only) */}
                <Stack direction="block" gap="none">
                  <Text>Origin</Text>
                  <LocationDetails location={currentLocation} placeholder="Current location" />
                </Stack>

                {/* Destination (chosen via button) */}
                <Stack direction="block" gap="100">
                  <Text>Destination</Text>
                  <LocationDetails location={selectedDestination} placeholder="Select destination location" />
                  <Box inlineSize="100%">
                    <Button
                      title={selectedDestination ? 'Change destination' : 'Select destination'}
                      onPress={() => {
                        setSearchTerm('') // Clear search when navigating to destination selection
                        setDestFilterKey((k) => k + 1) // Remount the filter so its text resets too
                        api.navigation.navigate('DestinationSelection')
                      }}
                    />
                  </Box>
                </Stack>
              </Stack>
              {/* Right column: camera scan button + camera */}
              <Stack direction="block" flex={1} gap="200">
                <Box inlineSize="100%">
                  <Button
                    title={showCamera ? 'Hide camera scanner' : 'Scan with camera'}
                    onPress={() => setShowCamera((prev) => !prev)}
                  />
                </Box>
                {showCamera && (
                  <>
                    <Box minBlockSize="191px">
                      <CameraScanner />
                    </Box>
                    <Text>
                      {selectedDestination
                        ? 'Point the camera at a barcode to add the item'
                        : 'Select a destination location before scanning'}
                    </Text>
                  </>
                )}
              </Stack>
            </Stack>
          </Section>
          
          {lastScannedItem && (
            <Section title="Last Scanned Item">
              <Stack direction="inline" gap="200" alignItems="center" inlineSize="100%">
                <Box inlineSize="48px" blockSize="48px">
                  {lastScannedItem.imageUrl ? (
                    <Image src={lastScannedItem.imageUrl} size="cover" />
                  ) : (
                    <Stack direction="block" inlineSize="100%" blockSize="100%" alignItems="center" justifyContent="center">
                      <Icon name="image-placeholder" tone="icon-subdued" />
                    </Stack>
                  )}
                </Box>
                <Stack direction="block" flex={1} gap="none">
                  <Text>{lastScannedItem.title}</Text>
                  <Text color="TextSubdued" variant="captionRegular">Qty at Origin: {lastScannedItem.atOrigin}</Text>
                  <Text color="TextSubdued" variant="captionRegular">Qty at Destination: {lastScannedItem.atDestination}</Text>
                  <Text color="TextSuccess" variant="captionRegular">Qty Added: {lastScannedItem.qtyAdded}</Text>
                </Stack>
              </Stack>
            </Section>
          )}
          
          <Section title="Transfer Items">
            <Text>Scan items with your hardware scanner or camera to add them to the transfer:</Text>
            {scannedItems.length > 0 ? (
              <Stack direction="block" inlineSize="100%" gap="300">
                <Text>Items Scanned: {scannedItems.length} (Total Qty: {scannedItems.reduce((total, item) => total + item.qtyAdded, 0)})</Text>
                {scannedItems.map((item) => (
                  <Stack
                    key={item.variantId}
                    direction="inline"
                    gap="200"
                    alignItems="start"
                    inlineSize="100%"
                  >
                    {/* Product image (or aligned placeholder when missing) */}
                    {/* Nudge the image down: bump IMAGE_TOP_OFFSET_PX 1px at a time until aligned. */}
                    <Stack direction="block">
                      <Box blockSize="14px" />
                      <Box inlineSize="48px" blockSize="48px">
                        {item.imageUrl ? (
                          <Image src={item.imageUrl} size="cover" />
                        ) : (
                          <Stack
                            direction="block"
                            inlineSize="100%"
                            blockSize="100%"
                            alignItems="center"
                            justifyContent="center"
                          >
                            <Icon name="image-placeholder" tone="icon-subdued" />
                          </Stack>
                        )}
                      </Box>
                    </Stack>

                    {/* Product info (expands to push controls to the far right) */}
                    <Stack direction="block" flex={1} gap="none">
                      <Text>{item.title}</Text>
                      <Text color="TextSubdued" variant="captionRegular">
                        Qty at Origin: {item.atOrigin}
                      </Text>
                      <Text color="TextSubdued" variant="captionRegular">
                        Qty at Destination: {item.atDestination}
                      </Text>
                    </Stack>

                    {/* Quantity controls + remove, pinned to the far right */}
                    <Stack direction="inline" gap="200" alignItems="center">
                      {/* Decrement */}
                      <Box inlineSize="44px">
                        <Button
                          title="−"
                          onPress={() => decrementItemQty(item.variantId)}
                          isDisabled={item.qtyAdded <= 1}
                        />
                      </Box>

                      {/* Editable quantity */}
                      <Box inlineSize="64px">
                        <NumberField
                          label=""
                          value={String(item.qtyAdded)}
                          onChange={(value) => updateItemQty(item.variantId, value)}
                          inputMode="numeric"
                          min={1}
                        />
                      </Box>

                      {/* Increment */}
                      <Box inlineSize="44px">
                        <Button
                          title="+"
                          onPress={() => incrementItemQty(item.variantId)}
                        />
                      </Box>

                      {/* Remove */}
                      <Selectable onPress={() => removeScannedItem(item.variantId)}>
                        <Icon name="delete" tone="icon-critical" />
                      </Selectable>
                    </Stack>
                  </Stack>
                ))}
              </Stack>
            ) : (
              <Text>Ready to scan items...</Text>
            )}
        </Section>
        <Section title="Add Items Manually">
            <Text>Search by description, barcode, or SKU to find and add items:</Text>
            <SearchBar
              placeholder="Search by description, barcode, or SKU"
              onSearch={handleManualSearch}
              onTextChange={handleSearchTextChange}
            />
            {isSearchingItems ? (
              <Text>Searching...</Text>
            ) : itemSearchResults.length > 0 ? (
              <Stack direction="block" gap="300" inlineSize="100%">
                {itemSearchResults.map((variant) => (
                  <SearchResultRow key={variant.variantId} variant={variant} />
                ))}
              </Stack>
            ) : hasSearched ? (
              <Text>No matching items found.</Text>
            ) : null}
        </Section>
        <Section title="Reference">
            <TextField
              label="Reference Note"
              placeholder=""
            />
        </Section>
        <Button 
          title={isCreatingTransfer ? "Creating Transfer..." : "Create Transfer"} 
          type="primary" 
          isDisabled={scannedItems.length === 0 || !selectedDestination || isCreatingTransfer}
          onPress={handleCreateTransfer} 
        />
        <Text></Text>
        <Button 
          title="Cancel" 
          type="destructive" 
          onPress={() => api.navigation.dismiss()} 
        />
        </ScrollView>
      </Screen>

      <Screen name="DestinationSelection" title="Select Destination">
        <ScrollView>
          <Section title="Filter Locations">
            <SearchBar
              key={destFilterKey}
              initialValue={searchTerm}
              placeholder="Filter by Location & Address"
              onSearch={setSearchTerm}
              onTextChange={setSearchTerm}
            />
          </Section>
          <Section title="Destination Locations">
            <Text>Choose the destination location:</Text>
            {destinationOptions.length > 0 ? (
              <Stack direction="block" gap="300" inlineSize="100%">
                {destinationOptions.map((option) => (
                  <DestinationRow key={option.id} location={option} />
                ))}
              </Stack>
            ) : (
              <Text>No matching locations found.</Text>
            )}
          </Section>
        </ScrollView>
      </Screen>
    </Navigator>
  )
}

export default reactExtension('pos.home.modal.render', () => <Modal />)