import { generateRustInputBinding } from '../rust-readers.mjs';
import { rustFunctionName, rustIdentifier } from '../rust-identifiers.mjs';
import { generateRustPreludeMacros } from './macros.mjs';

export function generateRustFunction(cell) {
  const inputBindings = cell.inputs.map((input) => `    ${generateRustInputBinding(input)}`).join('\n');
  const escapedSource = indentRustSource(cell.source);
  const macros = generateRustPreludeMacros(cell.source);
  const inputsParameter = cell.inputs.length > 0 ? 'inputs' : '_inputs';

  return `fn ${rustFunctionName(cell.id)}(${inputsParameter}: &Value) -> Result<CellOutput, String> {
${inputBindings ? `${inputBindings}\n` : ''}    let __stdout = std::cell::RefCell::new(String::new());
    let __plots = std::cell::RefCell::new(Vec::new());
    let __outputs = std::cell::RefCell::new(Vec::new());
${macros ? `\n${macros}\n` : ''}

${escapedSource}

    Ok(finish_cell_output(
        __stdout.into_inner(),
        __plots.into_inner(),
        __outputs.into_inner(),
    ))
}`;
}

export function generateRustTests(cells) {
  if (cells.length === 0) return '';
  const tests = cells.map(generateRustTest).join('\n\n');
  return `#[cfg(test)]
mod tests {
    use wasm_bindgen_test::wasm_bindgen_test;

${tests}
}`;
}

function generateRustTest(cell) {
  const defaultInputs = Object.fromEntries(cell.inputs.map((input) => [input.name, input.value]));
  const testName = `generated_${rustIdentifier(cell.id)}_runs`;
  const failureMessage = `generated Rust cell ${cell.id} should run with default inputs`;
  return `    #[wasm_bindgen_test]
    fn ${testName}() {
        let output = super::run_rust_cell(${JSON.stringify(cell.id)}, ${JSON.stringify(JSON.stringify(defaultInputs))})
            .expect(${JSON.stringify(failureMessage)});

        assert!(
            output.contains("stdout"),
            ${JSON.stringify(`generated Rust cell ${cell.id} output should include stdout`)}
        );
    }`;
}

function indentRustSource(source) {
  return source
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
