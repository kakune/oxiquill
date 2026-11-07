import { generateRustInputBinding } from '../rust-readers.mjs';
import { rustFunctionName } from '../rust-identifiers.mjs';
import { scanRustMacroInvocations } from './macro-invocations.mjs';
import { generateRustPreludeMacros } from './macros.mjs';
import { authoredFragment, generatedFragment, joinFragments } from './source-map.mjs';
import { definitionsImports } from './definitions.mjs';

export function generateRustFunction(cell, invokedMacros = scanRustMacroInvocations(cell.source, cell)) {
  return generateRustFunctionMapped(cell, invokedMacros).text;
}

export function generateRustFunctionMapped(cell, invokedMacros = scanRustMacroInvocations(cell.source, cell)) {
  const inputBindings = cell.inputs.map((input) => `        ${generateRustInputBinding(input)}`).join('\n');
  const macros = generateRustPreludeMacros(cell.source, invokedMacros);
  const inputsParameter = cell.inputs.length > 0 ? 'inputs' : '_inputs';

  return joinFragments([
    generatedFragment(
      `fn ${rustFunctionName(cell.id)}(${inputsParameter}: &Value) -> Result<CellOutput, String> {
    let __stdout = std::cell::RefCell::new(BoundedText::new());
    let __outputs = std::cell::RefCell::new(OutputCollector::new());
`,
      cell,
      'wrapper'
    ),
    generatedFragment(macros ? `\n${macros}\n` : '', cell, 'prelude'),
    generatedFragment('\n    let _ = {\n', cell, 'wrapper'),
    generatedFragment(definitionsImports(cell), cell, 'imports'),
    generatedFragment(inputBindings ? `${inputBindings}\n` : '', cell, 'inputs'),
    authoredFragment(cell),
    generatedFragment(
      `
    };

    Ok(finish_cell_output(
        __stdout.into_inner(),
        __outputs.into_inner(),
    ))
}`,
      cell,
      'wrapper'
    )
  ]);
}
