import { rustIdentifier, rustReaderName } from './rust-identifiers.mjs';

export function generateRustReaders(rustCells) {
  const readers = new Set(rustCells.flatMap((cell) => cell.inputs.map((input) => rustReaderName(input))));

  return [
    readers.has('read_f64') ? rustReadF64() : '',
    readers.has('read_i32') ? rustReadI32() : '',
    readers.has('read_bool') ? rustReadBool() : '',
    readers.has('read_string') ? rustReadString() : ''
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function generateRustInputBinding(input) {
  const key = JSON.stringify(input.name);
  const variable = rustIdentifier(input.name);
  return `let ${variable} = ${rustReaderName(input)}(inputs, ${key})?;`;
}

function rustReadF64() {
  return `fn read_f64(inputs: &Value, key: &str) -> Result<f64, String> {
    inputs
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("input {key} must be a number"))
}`;
}

function rustReadI32() {
  return `fn read_i32(inputs: &Value, key: &str) -> Result<i32, String> {
    let value = inputs
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("input {key} must be an integer"))?;
    i32::try_from(value).map_err(|_| format!("input {key} must be a signed 32-bit integer"))
}`;
}

function rustReadBool() {
  return `fn read_bool(inputs: &Value, key: &str) -> Result<bool, String> {
    inputs
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("input {key} must be a boolean"))
}`;
}

function rustReadString() {
  return `fn read_string(inputs: &Value, key: &str) -> Result<String, String> {
    inputs
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("input {key} must be a string"))
}`;
}
