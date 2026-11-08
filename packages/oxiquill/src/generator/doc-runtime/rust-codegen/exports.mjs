import { outputArtifactLimits } from '../../../lib/doc-runtime/output-limits.mjs';
import { authoredMacroInvocations } from './macro-invocations.mjs';

export const needsExports = (cell) => Boolean(cell.exports?.length || authoredMacroInvocations(cell).has('export'));

// Wrap values recursively, rather than inspecting serde_json::Value after it has
// already replaced NaN and infinities with null. Serialize only once per value.
export function generateRustExportSupport(cells) {
  if (!cells.some(needsExports)) return '';
  const scalar = [
    ['bool', 'bool'],
    ['i8', 'i8'],
    ['i16', 'i16'],
    ['i32', 'i32'],
    ['i64', 'i64'],
    ['i128', 'i128'],
    ['u8', 'u8'],
    ['u16', 'u16'],
    ['u32', 'u32'],
    ['u64', 'u64'],
    ['u128', 'u128'],
    ['char', 'char'],
    ['str', '&str'],
    ['bytes', '&[u8]']
  ];
  const compounds = [
    ['SerializeSeq', 'serialize_seq', 'len: Option<usize>', 'len', [['serialize_element', 'value']]],
    ['SerializeTuple', 'serialize_tuple', 'len: usize', 'len', [['serialize_element', 'value']]],
    [
      'SerializeTupleStruct',
      'serialize_tuple_struct',
      "name: &'static str, len: usize",
      'name, len',
      [['serialize_field', 'value']]
    ],
    [
      'SerializeTupleVariant',
      'serialize_tuple_variant',
      "name: &'static str, index: u32, variant: &'static str, len: usize",
      'name, index, variant, len',
      [['serialize_field', 'value']]
    ],
    [
      'SerializeMap',
      'serialize_map',
      'len: Option<usize>',
      'len',
      [
        ['serialize_key', 'value'],
        ['serialize_value', 'value']
      ]
    ],
    [
      'SerializeStruct',
      'serialize_struct',
      "name: &'static str, len: usize",
      'name, len',
      [['serialize_field', 'key, value']]
    ],
    [
      'SerializeStructVariant',
      'serialize_struct_variant',
      "name: &'static str, index: u32, variant: &'static str, len: usize",
      'name, index, variant, len',
      [['serialize_field', 'key, value']]
    ]
  ];
  return `
struct Finite<'a, T: ?Sized>(&'a T);
impl<T: Serialize + ?Sized> Serialize for Finite<'_, T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(FiniteSerializer(serializer))
    }
}
struct FiniteSerializer<S>(S);
struct FiniteCompound<S>(S);
impl<S: serde::Serializer> serde::Serializer for FiniteSerializer<S> {
    type Ok = S::Ok;
    type Error = S::Error;
${compounds.map(([trait]) => `    type ${trait} = FiniteCompound<S::${trait}>;`).join('\n')}
${scalar.map(([method, type]) => `    fn serialize_${method}(self, value: ${type}) -> Result<Self::Ok, Self::Error> { self.0.serialize_${method}(value) }`).join('\n')}
${['f32', 'f64']
  .map(
    (type) => `    fn serialize_${type}(self, value: ${type}) -> Result<Self::Ok, Self::Error> {
        if !value.is_finite() { return Err(serde::ser::Error::custom("non-finite export data")); }
        self.0.serialize_${type}(value)
    }`
  )
  .join('\n')}
    fn serialize_none(self) -> Result<Self::Ok, Self::Error> { self.0.serialize_none() }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<Self::Ok, Self::Error> { self.0.serialize_some(&Finite(value)) }
    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> { self.0.serialize_unit() }
    fn serialize_unit_struct(self, name: &'static str) -> Result<Self::Ok, Self::Error> { self.0.serialize_unit_struct(name) }
    fn serialize_unit_variant(self, name: &'static str, index: u32, variant: &'static str) -> Result<Self::Ok, Self::Error> { self.0.serialize_unit_variant(name, index, variant) }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, name: &'static str, value: &T) -> Result<Self::Ok, Self::Error> { self.0.serialize_newtype_struct(name, &Finite(value)) }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, name: &'static str, index: u32, variant: &'static str, value: &T) -> Result<Self::Ok, Self::Error> { self.0.serialize_newtype_variant(name, index, variant, &Finite(value)) }
${compounds.map(([trait, method, parameters, args]) => `    fn ${method}(self, ${parameters}) -> Result<Self::${trait}, Self::Error> { self.0.${method}(${args}).map(FiniteCompound) }`).join('\n')}
}
${compounds
  .map(
    ([trait, , , , methods]) => `impl<S: serde::ser::${trait}> serde::ser::${trait} for FiniteCompound<S> {
    type Ok = S::Ok;
    type Error = S::Error;
${methods.map(([method, args]) => `    fn ${method}<T: Serialize + ?Sized>(&mut self, ${args.includes('key') ? "key: &'static str, " : ''}value: &T) -> Result<(), Self::Error> { self.0.${method}(${args.includes('key') ? 'key, ' : ''}&Finite(value)) }`).join('\n')}
    fn end(self) -> Result<Self::Ok, Self::Error> { self.0.end() }
}`
  )
  .join('\n')}
struct ExportWriter(Vec<u8>);
impl std::io::Write for ExportWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > ${outputArtifactLimits.exportBytesPerRun} {
            return Err(std::io::Error::other("export data exceeded ${outputArtifactLimits.exportBytesPerRun} bytes"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
struct ExportCollector {
    producer: &'static str,
    declared: &'static [&'static str],
    values: serde_json::Map<String, Value>,
    sizes: std::collections::BTreeMap<String, usize>,
    bytes: usize,
}
impl ExportCollector {
    fn new(producer: &'static str, declared: &'static [&'static str]) -> Self {
        Self { producer, declared, values: serde_json::Map::new(), sizes: std::collections::BTreeMap::new(), bytes: 2 }
    }
    fn write<T: Serialize + ?Sized>(&mut self, name: &str, value: &T) -> Result<(), String> {
        if !self.declared.contains(&name) { return Err(format!("Producer {} wrote undeclared export {name}", self.producer)); }
        let mut writer = ExportWriter(Vec::new());
        serde_json::to_writer(&mut writer, &Finite(value)).map_err(|error| format!("Producer {} export {name}: {error}", self.producer))?;
        let size = writer.0.len() + name.len() + 3;
        let old = self.sizes.get(name).copied();
        let bytes = self.bytes - old.unwrap_or(0) + size + usize::from(old.is_none() && !self.values.is_empty());
        if bytes > ${outputArtifactLimits.exportBytesPerRun} { return Err(format!("Producer {} export data exceeded ${outputArtifactLimits.exportBytesPerRun} bytes", self.producer)); }
        let value = serde_json::from_slice(&writer.0).map_err(|error| format!("Producer {} export {name}: {error}", self.producer))?;
        self.values.insert(name.to_owned(), value);
        self.sizes.insert(name.to_owned(), size);
        self.bytes = bytes;
        Ok(())
    }
    fn finish(self) -> Result<Value, String> {
        if let Some(name) = self.declared.iter().find(|name| !self.values.contains_key(**name)) {
            return Err(format!("Producer {} is missing export {name}", self.producer));
        }
        Ok(Value::Object(self.values))
    }
}
`;
}
