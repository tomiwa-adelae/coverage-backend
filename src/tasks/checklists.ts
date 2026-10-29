/**
 * Documents a Nigerian bank asks for to open an account (CBN KYC). Added to a
 * prospect as tasks when forms go out, so what's still missing is visible.
 * Each bank's own list may differ a little; items can be deleted or added.
 */
export const CHECKLISTS = {
  INDIVIDUAL: [
    'Account opening form filled and signed',
    'BVN confirmed',
    'Valid ID (NIN slip, passport, driver’s licence or voter’s card)',
    'Utility bill (not older than 3 months)',
    '2 passport photographs',
    '2 reference forms (current account)',
    'Signature / mandate card signed',
  ],
  BUSINESS: [
    'Account opening form and mandate signed',
    'CAC certificate of registration',
    'CAC status report (directors and shareholders)',
    'MEMART (limited companies)',
    'Board resolution to open the account',
    'IDs, BVNs and photos of all signatories',
    'Utility bill for the business address',
    '2 reference forms',
    'TIN',
    'SCUML certificate (if the business type needs one)',
  ],
} as const;

export type ChecklistKind = keyof typeof CHECKLISTS;
