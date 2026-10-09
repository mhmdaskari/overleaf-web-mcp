/** The release that enforces every default this one announces. */
export const ENFORCED_IN = '0.6.0'

/**
 * A call that relied on a default a later release tightens. It still did what it did before;
 * `enforcedIn` names the release from which the same call is refused.
 */
export interface Deprecation {
  /** The parameter the caller should pass from now on. */
  parameter: string
  message: string
  enforcedIn: string
}

/** Adds a deprecation once per parameter. */
export function addDeprecation(list: Deprecation[], parameter: string, message: string): void {
  if (list.some(entry => entry.parameter === parameter)) return
  list.push({ parameter, message, enforcedIn: ENFORCED_IN })
}
