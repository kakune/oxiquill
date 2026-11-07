const forms = ['error', 'equals', 'range', 'approx'];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * @typedef {null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }} JsonValue
 * @typedef {{ error: string } | ({ path: string, artifact?: string } & (
 *   { equals: JsonValue } | { range: { min?: number, max?: number } } |
 *   { approx: { value: number, atol?: number, rtol?: number } }
 * ))} CellTestExpectation
 * @typedef {{ case: string, expect: CellTestExpectation[], location: { line: number, column: number },
 *   expectationLocations: { line: number, column: number }[] }} AuthoredCellTest
 */

export function validJsonPointer(value) {
  return typeof value === 'string' && (value === '' || (value.startsWith('/') && !/~(?:[^01]|$)/u.test(value)));
}

export function normalizeCellTests(metadata, cases, language, context, locate, diagnostics) {
  if (!Object.hasOwn(metadata, 'tests')) return [];
  const fail = (fieldPath, message) => diagnostics.push({ ...context, fieldPath, message, ...locate(fieldPath) });
  if (language !== 'rust') {
    fail('tests', `tests are not yet supported for ${language} cells`);
    return [];
  }
  if (!Array.isArray(metadata.tests)) {
    fail('tests', 'Expected a list of test mappings.');
    return [];
  }
  const seen = new Set();
  return metadata.tests.flatMap((test, index) => {
    const field = `tests[${index}]`;
    if (!record(test)) {
      fail(field, 'Expected a test mapping.');
      return [];
    }
    unknownFields(test, ['case', 'expect'], field, fail);
    if (test.case !== 'default' && !cases.some(({ id }) => id === test.case)) {
      fail(`${field}.case`, 'Expected default or an authored case id.');
    } else if (seen.has(test.case)) fail(`${field}.case`, `Duplicate test case ${JSON.stringify(test.case)}.`);
    seen.add(test.case);
    if (!Array.isArray(test.expect) || test.expect.length === 0) {
      fail(`${field}.expect`, 'Expected a non-empty list of expectations.');
      return [];
    }
    test.expect.forEach((expectation, expectationIndex) => {
      const path = `${field}.expect[${expectationIndex}]`;
      validateExpectation(expectation, path, fail);
      if (record(expectation) && Object.hasOwn(expectation, 'error') && test.expect.length !== 1) {
        fail(path, 'An error expectation must be the only expectation of its test.');
      }
    });
    return [
      {
        case: test.case,
        expect: test.expect,
        location: locate(field),
        expectationLocations: test.expect.map((_, i) => locate(`${field}.expect[${i}]`))
      }
    ];
  });
}

function validateExpectation(value, path, fail) {
  if (!record(value)) return fail(path, 'Expected an expectation mapping.');
  const selected = forms.filter((form) => Object.hasOwn(value, form));
  if (selected.length !== 1) return fail(path, 'Expected exactly one of error, equals, range, or approx.');
  const [form] = selected;
  unknownFields(value, form === 'error' ? ['error'] : ['artifact', 'path', form], path, fail);
  if (form === 'error') {
    if (
      typeof value.error !== 'string' ||
      new TextEncoder().encode(value.error).length < 1 ||
      new TextEncoder().encode(value.error).length > 256
    ) {
      fail(`${path}.error`, 'Expected an execution-error substring of 1–256 UTF-8 bytes.');
    }
    return;
  }
  if (!validJsonPointer(value.path)) fail(`${path}.path`, 'Expected an RFC 6901 JSON Pointer.');
  if (Object.hasOwn(value, 'artifact') && (typeof value.artifact !== 'string' || !value.artifact.length)) {
    fail(`${path}.artifact`, 'Expected a non-empty artifact id.');
  }
  if (form === 'equals') {
    if (!jsonValue(value.equals)) fail(`${path}.equals`, 'Expected a finite JSON value.');
    return;
  }
  const constraint = value[form];
  const constraintPath = `${path}.${form}`;
  if (!record(constraint)) return fail(constraintPath, 'Expected a mapping.');
  unknownFields(constraint, form === 'range' ? ['min', 'max'] : ['value', 'atol', 'rtol'], constraintPath, fail);
  if (form === 'range') {
    if (!Object.hasOwn(constraint, 'min') && !Object.hasOwn(constraint, 'max'))
      fail(constraintPath, 'Expected at least one bound.');
    ['min', 'max'].forEach((key) => {
      if (Object.hasOwn(constraint, key) && !finite(constraint[key]))
        fail(`${constraintPath}.${key}`, 'Expected a finite number.');
    });
    if (constraint.min > constraint.max) fail(constraintPath, 'Minimum must not exceed maximum.');
  } else {
    if (!finite(constraint.value)) fail(`${constraintPath}.value`, 'Expected a finite number.');
    ['atol', 'rtol'].forEach((key) => {
      if (Object.hasOwn(constraint, key) && (!finite(constraint[key]) || constraint[key] < 0))
        fail(`${constraintPath}.${key}`, 'Expected a finite non-negative tolerance.');
    });
    if (!(constraint.atol > 0) && !(constraint.rtol > 0))
      fail(constraintPath, 'At least one tolerance must be positive.');
  }
}

function unknownFields(value, allowed, path, fail) {
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .forEach((key) => fail(`${path}.${key}`, 'Unknown field.'));
}

function jsonValue(value, ancestors = []) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return true;
  if (typeof value !== 'object' || ancestors.includes(value)) return false;
  return Object.values(value).every((child) => jsonValue(child, [...ancestors, value]));
}

export function resolveJsonPointer(root, pointer) {
  return pointer === ''
    ? { found: true, value: root }
    : pointer
        .slice(1)
        .split('/')
        .reduce(
          (result, token) => {
            const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~');
            const value = result.value;
            if (
              !result.found ||
              value === null ||
              typeof value !== 'object' ||
              !Object.hasOwn(value, key) ||
              (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(key))
            )
              return { found: false };
            return { found: true, value: value[key] };
          },
          { found: true, value: root }
        );
}

export function equalJson(actual, expected) {
  if (actual === expected) return true;
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object' ||
    Array.isArray(actual) !== Array.isArray(expected)
  )
    return false;
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && equalJson(actual[key], expected[key]))
  );
}

export function evaluateExpectation(expectation, outcome) {
  if (Object.hasOwn(expectation, 'error')) {
    return outcome.kind === 'execution-error' && outcome.error.includes(expectation.error)
      ? undefined
      : { reason: 'expected-error', actual: outcome.error ?? outcome.result };
  }
  if (outcome.kind !== 'result') return { reason: outcome.kind, actual: outcome.error };
  const root =
    expectation.artifact === undefined
      ? outcome.result
      : outcome.result.outputs.find((artifact) => artifact.id === expectation.artifact);
  if (root === undefined) return { reason: 'missing-artifact' };
  const resolved = resolveJsonPointer(root, expectation.path);
  if (!resolved.found) return { reason: 'missing-path' };
  const actual = resolved.value;
  if (Object.hasOwn(expectation, 'equals'))
    return equalJson(actual, expectation.equals) ? undefined : { reason: 'not-equal', actual };
  if (!finite(actual)) return { reason: 'not-finite-number', actual };
  if (expectation.range) {
    const { min, max } = expectation.range;
    return (min === undefined || actual >= min) && (max === undefined || actual <= max)
      ? undefined
      : { reason: 'out-of-range', actual };
  }
  const { value, atol = 0, rtol = 0 } = expectation.approx;
  return Math.abs(actual - value) <= atol + rtol * Math.abs(value) ? undefined : { reason: 'not-approximate', actual };
}
