export const PORTABLE_INTEGER_MIN = -(2 ** 31);
export const PORTABLE_INTEGER_MAX = 2 ** 31 - 1;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isPortableInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= PORTABLE_INTEGER_MIN &&
    value <= PORTABLE_INTEGER_MAX
  );
}
