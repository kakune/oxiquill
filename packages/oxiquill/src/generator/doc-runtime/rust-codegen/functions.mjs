import { generateRustInputBinding } from '../rust-readers.mjs';
import { rustFunctionName } from '../rust-identifiers.mjs';
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

export function generateRustTest(cell) {
  const defaultInputs = Object.fromEntries(cell.inputs.map((input) => [input.name, input.value]));
  return `#[cfg(test)]
mod tests {
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn first_generated_cell_runs() {
        let output = super::run_rust_cell(${JSON.stringify(cell.id)}, ${JSON.stringify(
          JSON.stringify(defaultInputs)
        )})
        .expect("generated Rust cell should run");

        assert!(
            output.contains("stdout"),
            "generated cell output should include stdout"
        );
    }
}`;
}

function indentRustSource(source) {
  return source
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
