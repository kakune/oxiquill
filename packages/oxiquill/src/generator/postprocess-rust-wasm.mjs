// wasm-bindgen glue keeps module and instance handles that the documentation
// runtime never reads; dropping them keeps each module's glue minimal.
export function removeUnusedGlueState(source) {
  return source.replace(
    [
      'let wasmModule, wasmInstance, wasm;',
      'function __wbg_finalize_init(instance, module) {',
      '    wasmInstance = instance;',
      '    wasm = instance.exports;',
      '    wasmModule = module;'
    ].join('\n'),
    ['let wasm;', 'function __wbg_finalize_init(instance) {', '    wasm = instance.exports;'].join('\n')
  );
}
