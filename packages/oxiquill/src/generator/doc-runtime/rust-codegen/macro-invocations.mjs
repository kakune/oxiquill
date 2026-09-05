const identifierStart = /[_\p{XID_Start}]/u;
const identifierContinue = /\p{XID_Continue}/u;
const whitespace = /\p{Pattern_White_Space}/u;

// A capability scan, not a parser: visit each token once without expanding macros.
export function scanRustMacroInvocations(source, cell) {
  const macros = new Set();
  let identifier;
  let index = 0;

  while (index < source.length) {
    const character = codePointAt(source, index);
    if (whitespace.test(character)) {
      index += character.length;
    } else if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
    } else if (source.startsWith('/*', index)) {
      index = skipBlockComment(source, index, cell);
    } else if (character === '"') {
      index = skipString(source, index, cell);
      identifier = undefined;
    } else if (character === "'") {
      index = skipCharacterOrLifetime(source, index, cell);
      identifier = undefined;
    } else if (identifierContinue.test(character)) {
      const start = index;
      index = identifierEnd(source, index);
      const name = source.slice(start, index);
      identifier = identifierStart.test(character) ? name : undefined;

      if (['r', 'br', 'cr'].includes(name)) {
        let quote = index;
        while (source[quote] === '#') quote += 1;
        if (source[quote] === '"') {
          index = skipRawString(source, start, quote, quote - index, cell);
          identifier = undefined;
        } else if (name === 'r' && source[index] === '#' && identifierStart.test(codePointAt(source, index + 1))) {
          const rawStart = index + 1;
          index = identifierEnd(source, rawStart);
          identifier = source.slice(rawStart, index);
        }
      } else if (name === 'b' && source[index] === "'") {
        index = skipCharacterOrLifetime(source, index, cell, true);
        identifier = undefined;
      }
    } else {
      if (character === '!' && source[index + 1] !== '=' && identifier) macros.add(identifier);
      identifier = undefined;
      index += character.length;
    }
  }

  return macros;
}

function codePointAt(source, index) {
  const point = source.codePointAt(index);
  return point === undefined ? '' : String.fromCodePoint(point);
}

function identifierEnd(source, start) {
  let index = start;
  while (index < source.length) {
    const character = codePointAt(source, index);
    if (!identifierContinue.test(character)) break;
    index += character.length;
  }
  return index;
}

function skipBlockComment(source, start, cell) {
  let depth = 1;
  let index = start + 2;
  while (index < source.length) {
    if (source.startsWith('/*', index)) {
      depth += 1;
      index += 2;
    } else if (source.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  throw unterminated(source, start, 'block comment', cell);
}

function skipString(source, start, cell) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '"') return index + 1;
    index += source[index] === '\\' ? 2 : 1;
  }
  throw unterminated(source, start, 'string literal', cell);
}

function skipRawString(source, start, quote, hashes, cell) {
  let index = quote + 1;
  while (index < source.length) {
    if (source[index] !== '"') {
      index += 1;
      continue;
    }
    index += 1;
    let closingHashes = 0;
    while (closingHashes < hashes && source[index] === '#') {
      closingHashes += 1;
      index += 1;
    }
    if (closingHashes === hashes) return index;
  }
  throw unterminated(source, start, 'raw string literal', cell);
}

function skipCharacterOrLifetime(source, start, cell, byte = false) {
  let index = start + 1;
  if (source[index] === '\\') {
    index += 1;
    if (source[index] === 'u' && source[index + 1] === '{') {
      index += 2;
      while (/[\da-fA-F_]/u.test(source[index] ?? '')) index += 1;
      if (source[index] === '}') index += 1;
    } else {
      index += source[index] === 'x' ? 3 : 1;
    }
  } else {
    index += codePointAt(source, index).length;
  }
  if (source[index] === "'") return index + 1;
  if (!byte && identifierStart.test(codePointAt(source, start + 1))) {
    const raw = source.startsWith('r#', start + 1) && identifierStart.test(codePointAt(source, start + 3));
    return identifierEnd(source, start + (raw ? 3 : 1));
  }
  throw unterminated(source, start, byte ? 'byte character literal' : 'character literal', cell);
}

function unterminated(source, start, kind, cell) {
  const lines = source.slice(0, start).split('\n');
  const context = cell ? `Rust cell "${cell.id}"${cell.pagePath ? ` in ${cell.pagePath}` : ''}` : 'Rust source';
  return new Error(
    `${context} has an unterminated ${kind} at line ${lines.length}, column ${Array.from(lines.at(-1)).length + 1}.`
  );
}
