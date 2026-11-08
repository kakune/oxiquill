import { needsExports } from './exports.mjs';
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
  const exports = needsExports(cell);
  const dependencyBindings = Object.entries(cell.dependsOn ?? {})
    .map(([name, dependency]) => {
      const value = `dependencies.get(${JSON.stringify(name)}).ok_or_else(|| ${JSON.stringify(`Upstream producer ${dependency.cell} provided no exports`)}.to_owned())?`;
      return dependency.type
        ? `        let ${name}: ${dependency.type} = serde::Deserialize::deserialize(${value}).map_err(|error| format!("Producer ${dependency.cell} could not deserialize binding ${name}: {error}"))?;`
        : `        let ${name}: &serde_json::Value = ${value};`;
    })
    .join('\n');
  const macros = generateRustPreludeMacros(cell.source, invokedMacros);
  const inputsParameter = cell.inputs.length > 0 ? 'inputs' : '_inputs';

  return joinFragments([
    generatedFragment(
      `fn ${rustFunctionName(cell.id)}(${inputsParameter}: &Value, ${Object.keys(cell.dependsOn ?? {}).length ? 'dependencies' : '_dependencies'}: &Value) -> Result<CellOutput, String> {
    let __stdout = std::cell::RefCell::new(BoundedText::new());
    let __outputs = std::cell::RefCell::new(OutputCollector::new());
${exports ? `    let __exports = std::cell::RefCell::new(ExportCollector::new(${JSON.stringify(cell.title)}, &[${(cell.exports ?? []).map((name) => JSON.stringify(name)).join(', ')}]));` : ''}
`,
      cell,
      'wrapper'
    ),
    generatedFragment(macros ? `\n${macros}\n` : '', cell, 'prelude'),
    generatedFragment('\n    let _ = {\n', cell, 'wrapper'),
    generatedFragment(definitionsImports(cell), cell, 'imports'),
    generatedFragment(inputBindings ? `${inputBindings}\n` : '', cell, 'inputs'),
    generatedFragment(dependencyBindings ? `${dependencyBindings}\n` : '', cell, 'dependencies'),
    authoredFragment(cell),
    generatedFragment(
      `
    };

    ${exports ? 'let mut output = ' : 'Ok('}finish_cell_output(
        __stdout.into_inner(),
        __outputs.into_inner(),
    ${exports ? ');' : '))'}
${exports ? '    output.exports = Some(__exports.into_inner().finish()?);\n    Ok(output)' : ''}
}`,
      cell,
      'wrapper'
    )
  ]);
}
