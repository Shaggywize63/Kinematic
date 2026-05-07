/**
 * Sanitise a user-supplied search string before interpolating it into a
 * PostgREST `.or()` / `.ilike()` filter expression.
 *
 * PostgREST's filter grammar reserves several characters that, if left in
 * the value portion of a filter, let an attacker break out of the intended
 * predicate and inject new ones. Concretely:
 *
 *   `q = q.or(`first_name.ilike.%${input}%,...`)`
 *
 * with `input = "x,company.eq.target"` produces
 *
 *   first_name.ilike.%x,company.eq.target%,last_name.ilike.%x,company...
 *
 * which PostgREST happily parses as two predicates — the second one is
 * fully attacker-controlled. Same trick works with `(`, `)`, `,`, `"`, `\`.
 *
 * We strip those plus the ilike wildcards (`%` `_` `*`) so the search term
 * is treated as a literal substring, not a pattern.
 *
 * Length is also bounded to keep query size predictable.
 */
export function sanitisePostgrestSearch(input: unknown): string {
  return String(input ?? '')
    .replace(/[%_*]/g, '')        // ilike wildcards
    .replace(/[(),"\\]/g, '')     // PostgREST or-filter syntax
    .trim()
    .slice(0, 80);
}
