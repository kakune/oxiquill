import type { Scene3dArtifact, Scene3dAxis, Scene3dCamera } from './types.js';
import { outputArtifactLimits, utf8ByteLength } from './output-limits.mjs';
import {
  ArtifactValidationError,
  artifactMetadata,
  finiteNumber,
  dataDescriptor,
  optionalString,
  plainArray,
  plainRecord,
  rejectUnknownFields,
  requiredOwnValue,
  requiredString,
  validateBaseArtifact,
  type ValidationSuccess
} from './output-validation-common.js';

function text(
  record: Record<string, unknown>,
  key: string,
  context: string,
  limit: number,
  required = false
): string | undefined {
  const value = required ? requiredString(record, key, context) : optionalString(record, key, context);
  if (value !== undefined && (utf8ByteLength(value) > limit || (required && value.length === 0))) {
    throw new ArtifactValidationError(`${context}.${key} must contain ${required ? '1' : '0'}–${limit} UTF-8 bytes.`);
  }
  return value;
}

function items(record: Record<string, unknown>, key: string, limit: number, required = false): unknown[] {
  if (!required && !Object.hasOwn(record, key)) return [];
  const values = plainArray(requiredOwnValue(record, key, 'Scene3d'), `Scene3d.${key}`);
  if (values.length > limit) throw new ArtifactValidationError(`Scene3d.${key} exceeds ${limit} entries.`);
  for (let index = outputArtifactLimits.chartDataItems + 1; index < values.length; index += 1) {
    dataDescriptor(values, index, `Scene3d.${key}[${index}]`);
  }
  return values;
}

function axis(value: unknown, context: string): Scene3dAxis {
  const record = plainRecord(value, context);
  rejectUnknownFields(record, ['label', 'unit'], context);
  const label = optionalString(record, 'label', context);
  const unit = text(record, 'unit', context, 32);
  return { ...(label === undefined ? {} : { label }), ...(unit === undefined ? {} : { unit }) };
}

function camera(value: unknown): Scene3dCamera {
  const record = plainRecord(value, 'Scene3d.camera');
  rejectUnknownFields(record, ['yaw', 'pitch', 'zoom'], 'Scene3d.camera');
  return Object.fromEntries(
    Object.keys(record).map((key) => {
      const number = finiteNumber(requiredOwnValue(record, key, 'Scene3d.camera'), `Scene3d.camera.${key}`);
      if ((key === 'pitch' && Math.abs(number) > 90) || (key === 'zoom' && number <= 0)) {
        throw new ArtifactValidationError(`Scene3d.camera.${key} is out of range.`);
      }
      return [key, number];
    })
  );
}

export function validateScene3dArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  rejectUnknownFields(
    record,
    ['kind', 'id', 'title', 'caption', 'points', 'edges', 'groups', 'axes', 'camera'],
    'Scene3d'
  );
  const base = artifactMetadata(validateBaseArtifact(record));
  const ids = new Set<string>();
  const points = items(record, 'points', outputArtifactLimits.scene3dPoints, true).map((value, index) => {
    const context = `Scene3d.points[${index}]`;
    const point = plainRecord(value, context);
    rejectUnknownFields(point, ['id', 'position', 'label', 'group'], context);
    const id = text(point, 'id', context, 64, true) as string;
    if (ids.has(id)) throw new ArtifactValidationError(`${context}.id duplicates ${JSON.stringify(id)}.`);
    ids.add(id);
    const raw = plainArray(requiredOwnValue(point, 'position', context), `${context}.position`);
    if (raw.length !== 3) throw new ArtifactValidationError(`${context}.position must contain three finite numbers.`);
    const position: readonly [number, number, number] = [
      finiteNumber(raw[0], `${context}.position[0]`),
      finiteNumber(raw[1], `${context}.position[1]`),
      finiteNumber(raw[2], `${context}.position[2]`)
    ];
    const label = text(point, 'label', context, 256);
    const group = optionalString(point, 'group', context);
    return { id, position, ...(label === undefined ? {} : { label }), ...(group === undefined ? {} : { group }) };
  });
  const edgeKeys = new Set<string>();
  const edges = items(record, 'edges', outputArtifactLimits.scene3dEdges).map((value, index) => {
    const context = `Scene3d.edges[${index}]`;
    const edge = plainRecord(value, context);
    rejectUnknownFields(edge, ['from', 'to'], context);
    const from = requiredString(edge, 'from', context);
    const to = requiredString(edge, 'to', context);
    for (const [field, id] of [
      ['from', from],
      ['to', to]
    ]) {
      if (!ids.has(id)) throw new ArtifactValidationError(`${context}.${field} references an unknown point id.`);
    }
    if (from === to) throw new ArtifactValidationError(`${context}.to must differ from from (self-edge).`);
    const key = JSON.stringify([from, to].sort());
    if (edgeKeys.has(key)) throw new ArtifactValidationError(`${context} is a duplicate undirected edge.`);
    edgeKeys.add(key);
    return { from, to };
  });
  const groupIds = new Set<string>();
  let groupBytes = 0;
  const groups = items(record, 'groups', Math.max(0, remainingBytes)).map((value, index) => {
    const context = `Scene3d.groups[${index}]`;
    const group = plainRecord(value, context);
    rejectUnknownFields(group, ['id', 'label'], context);
    const id = text(group, 'id', context, outputArtifactLimits.bytesPerMetadataField, true) as string;
    if (groupIds.has(id)) throw new ArtifactValidationError(`${context}.id is a duplicate group id.`);
    groupIds.add(id);
    const label = optionalString(group, 'label', context);
    groupBytes += utf8ByteLength(id) + utf8ByteLength(label ?? '');
    if (groupBytes > remainingBytes)
      throw new ArtifactValidationError('Scene3d.groups exceeds the remaining run byte limit.');
    return { id, ...(label === undefined ? {} : { label }) };
  });
  let axes: Scene3dArtifact['axes'];
  if (Object.hasOwn(record, 'axes')) {
    const raw = plainRecord(requiredOwnValue(record, 'axes', 'Scene3d'), 'Scene3d.axes');
    rejectUnknownFields(raw, ['x', 'y', 'z'], 'Scene3d.axes');
    axes = Object.fromEntries(
      Object.keys(raw).map((key) => [key, axis(requiredOwnValue(raw, key, 'Scene3d.axes'), `Scene3d.axes.${key}`)])
    );
  }
  const artifact: Scene3dArtifact = {
    ...base,
    kind: 'scene3d',
    points,
    ...(Object.hasOwn(record, 'edges') ? { edges } : {}),
    ...(Object.hasOwn(record, 'groups') ? { groups } : {}),
    ...(axes === undefined ? {} : { axes }),
    ...(Object.hasOwn(record, 'camera') ? { camera: camera(requiredOwnValue(record, 'camera', 'Scene3d')) } : {})
  };
  const byteLength = utf8ByteLength(JSON.stringify(artifact));
  if (byteLength > remainingBytes)
    throw new ArtifactValidationError('Scene3d exceeds the remaining 16 MiB run byte limit.');
  return { artifact, byteLength };
}
