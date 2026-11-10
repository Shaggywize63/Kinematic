// PORT of kinematic-dashboard src/lib/hrms/live/masking.ts, kept free of imports so the engine stays pure (no logger, no crypto).
// The server's own copies are looksMaskedPan / looksMaskedAccount in src/lib/hrmsCrypto.ts; tests/hrmsPayroll.test.ts checks the two agree.

// Masked personal data in live mode.
// The server never sends a PAN or a bank account number in full: it sends a mask (the last four characters stay visible)
// and keeps the real value encrypted. The mask must be recognised on this side so that it is (a) shown as "on file" and
// not as "invalid", and (b) never sent back as if it were a new value. These two tests mirror the server's own
// (Kinematic/src/lib/hrmsCrypto.ts looksMaskedPan / looksMaskedAccount) so both ends agree on what a mask is.

/**
 * A mask rather than a real PAN: it has a bullet or an asterisk, or a run of four or more X.
 * A real PAN cannot have that run (the fourth letter is a holder type and is never X), so AXXPX1234F is not a mask.
 */
export const looksMaskedPan = (v: string | null | undefined): boolean => !!v && (/[•*]/.test(v) || /X{4,}/i.test(v));

/** A mask rather than an account number: real account numbers are digits only. */
export const looksMaskedAccount = (v: string | null | undefined): boolean => !!v && /[•*xX]/.test(v);

/** True when any sensitive value of this employee-like object is a mask (the object came from the server). */
export const hasMaskedSensitive = (e: { pan?: string; bank?: { accountNumber?: string } | null }): boolean =>
  looksMaskedPan(e.pan) || looksMaskedAccount(e.bank?.accountNumber);
