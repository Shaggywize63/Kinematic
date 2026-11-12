// Write-time validation for the Privacy/DPDP collections, with plain sentences (no code-style prefixes). zod has already checked the
// types and enums; these add the content rules the contract names: a retention rule's dataset and basis are non-empty and its keep_years
// is zero or more. Pure functions, no database access.

/** The first problem with a retention rule's content, or null. dataset / basis come pre-trimmed from the service. */
export function validateRetention(dataset: string, basis: string, keepYears: number): string | null {
  if (dataset.trim().length === 0) return 'Give the dataset a name';
  if (basis.trim().length === 0) return 'Give a basis for keeping it';
  if (!Number.isFinite(keepYears) || keepYears < 0) return 'Keep period cannot be negative';
  return null;
}
