import { generateRustInputBinding } from '../rust-readers.mjs';
import { rustFunctionName } from '../rust-identifiers.mjs';
import { scanRustMacroInvocations } from './macro-invocations.mjs';
import { generateRustPreludeMacros } from './macros.mjs';

export function generateRustFunction(cell, invokedMacros = scanRustMacroInvocations(cell.source, cell)) {
  const inputBindings = cell.inputs.map((input) => `        ${generateRustInputBinding(input)}`).join('\n');
  const macros = generateRustPreludeMacros(cell.source, invokedMacros);
  const inputsParameter = cell.inputs.length > 0 ? 'inputs' : '_inputs';

  return `fn ${rustFunctionName(cell.id)}(${inputsParameter}: &Value) -> Result<CellOutput, String> {
    let __stdout = std::cell::RefCell::new(BoundedText::new());
    let __outputs = std::cell::RefCell::new(OutputCollector::new());
${macros ? `\n${macros}\n` : ''}

    let _ = {
${inputBindings ? `${inputBindings}\n` : ''}${cell.source}
    };

    Ok(finish_cell_output(
        __stdout.into_inner(),
        __outputs.into_inner(),
    ))
}`;
}
