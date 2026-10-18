/**
 * The symbologies we look for. Fewer formats means faster decoding and fewer false reads.
 * Code 128 is the common one on industrial and pallet labels; Code 39 and ITF turn up on older
 * labels and cartons; EAN/UPC are retail; QR and Data Matrix are what we'd print ourselves.
 * Names follow the Barcode Detection API.
 */
export const SCAN_FORMATS = [
  "code_128",
  "code_39",
  "itf",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "qr_code",
  "data_matrix",
] as const;

export type ScanFormat = (typeof SCAN_FORMATS)[number];
