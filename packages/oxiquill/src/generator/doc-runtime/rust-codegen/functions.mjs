import { generateRustInputBinding } from '../rust-readers.mjs';
import { rustFunctionName, rustIdentifier } from '../rust-identifiers.mjs';
import { scanRustMacroInvocations } from './macro-invocations.mjs';
import { generateRustPreludeMacros } from './macros.mjs';
import { outputArtifactLimits } from '../../../lib/doc-runtime/output-limits.mjs';

export function generateRustFunction(cell, invokedMacros = scanRustMacroInvocations(cell.source, cell)) {
  const inputBindings = cell.inputs.map((input) => `    ${generateRustInputBinding(input)}`).join('\n');
  const escapedSource = indentRustSource(cell.source);
  const macros = generateRustPreludeMacros(cell.source, invokedMacros);
  const inputsParameter = cell.inputs.length > 0 ? 'inputs' : '_inputs';

  return `fn ${rustFunctionName(cell.id)}(${inputsParameter}: &Value) -> Result<CellOutput, String> {
${inputBindings ? `${inputBindings}\n` : ''}    let __stdout = std::cell::RefCell::new(BoundedText::new());
    let __outputs = std::cell::RefCell::new(OutputCollector::new());
${macros ? `\n${macros}\n` : ''}

${escapedSource}

    Ok(finish_cell_output(
        __stdout.into_inner(),
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

    #[wasm_bindgen_test]
    fn generated_output_limits_are_enforced() {
        use std::fmt::Write as _;

        let mut exact = super::BoundedText::new();
        write!(&mut exact, "{}", "x".repeat(${outputArtifactLimits.bytesPerStream}))
            .expect("exact-limit stdout should be writable");
        assert_eq!(
            exact.content.len(),
            ${outputArtifactLimits.bytesPerStream},
            "exact-limit stdout should be retained"
        );
        assert!(!exact.truncated, "exact-limit stdout should not be marked truncated");

        let mut oversized = super::BoundedText::new();
        write!(&mut oversized, "{}", "x".repeat(${outputArtifactLimits.bytesPerStream + 1}))
            .expect("oversized stdout should be bounded without a formatting error");
        assert!(
            oversized.content.len() <= ${outputArtifactLimits.bytesPerStream},
            "oversized stdout should remain within its byte budget"
        );
        assert!(oversized.truncated, "oversized stdout should be marked truncated");

        let error = super::bounded_error_message(&"x".repeat(${outputArtifactLimits.bytesPerError + 1}));
        assert!(
            error.len() <= ${outputArtifactLimits.bytesPerError},
            "generated errors should remain within their byte budget"
        );
    }
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
