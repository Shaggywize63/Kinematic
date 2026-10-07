/**
 * Reserved tokens inside a custom field's `options` list.
 *
 * `crm_custom_field_defs.options` is a plain string[] and the live database has no column for
 * extra field settings, so a few behaviours are switched on by a reserved token sitting in that
 * list (the `image` field already works this way with 'camera_only' and 'front'). Reserved
 * tokens are written `__like_this__`; every client hides them from the visible choices.
 *
 *   __searchable__          a `select` is shown as a search box instead of a plain menu
 *                           (long lists such as crops)
 *   __source:products__     a `select` takes its choices from the Products list instead of
 *                           `options`; the value stored is just the product NAME
 *
 * The web dashboard, Android and iOS implement these identically.
 */
export const OPTION_SEARCHABLE = '__searchable__';
export const OPTION_SOURCE_PRODUCTS = '__source:products__';

/** True for a reserved token (never shown as a choice). */
export const isReservedOption = (o: string): boolean => /^__.+__$/.test(o);

/** The choices a person should see — the reserved tokens removed. */
export const visibleOptions = (options: readonly string[] | null | undefined): string[] =>
  (options ?? []).filter((o) => !isReservedOption(o));

export const isSearchableOptions = (options: readonly string[] | null | undefined): boolean =>
  !!options?.includes(OPTION_SEARCHABLE) || !!options?.includes(OPTION_SOURCE_PRODUCTS);

export const isProductSourceOptions = (options: readonly string[] | null | undefined): boolean =>
  !!options?.includes(OPTION_SOURCE_PRODUCTS);
