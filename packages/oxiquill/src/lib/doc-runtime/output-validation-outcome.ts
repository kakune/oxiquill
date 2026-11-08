import type { OutcomeArtifact, OutcomeState } from './types.js';
import { outputArtifactLimits, utf8ByteLength } from './output-limits.mjs';
import {
  ArtifactValidationError,
  artifactMetadata,
  validateBaseArtifact,
  plainRecord,
  plainArray,
  requiredOwnValue,
  requiredString,
  finiteNumber,
  optionalString,
  rejectUnknownFields,
  payloadByteLength,
  type ValidationSuccess
} from './output-validation-common.js';

function boundedText(value: string, maximum: number, context: string, required = false): string {
  if ((required && value.trim() === '') || utf8ByteLength(value) > maximum)
    throw new ArtifactValidationError(
      `${context} must be ${required ? 'nonblank and ' : ''}at most ${maximum} UTF-8 bytes.`
    );
  return value;
}

export function validateOutcomeArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  const context = 'Outcome artifact';
  rejectUnknownFields(
    record,
    ['kind', 'id', 'title', 'caption', 'state', 'label', 'explanation', 'status', 'diagnostics'],
    context
  );
  const base = validateBaseArtifact(record);
  const state = requiredString(record, 'state', context);
  if (!['satisfied', 'partial', 'failed', 'unavailable'].includes(state))
    throw new ArtifactValidationError(`${context} state must be satisfied, partial, failed, or unavailable.`);
  const label = boundedText(requiredString(record, 'label', context), 256, `${context} label`, true);
  const explanation = optionalString(record, 'explanation', context);
  const status = optionalString(record, 'status', context);
  if (status !== undefined) boundedText(status, 256, `${context} status`);
  const diagnostics = Object.hasOwn(record, 'diagnostics')
    ? plainArray(requiredOwnValue(record, 'diagnostics', context), `${context} diagnostics`)
    : undefined;
  if (diagnostics && diagnostics.length > outputArtifactLimits.outcomeDiagnostics)
    throw new ArtifactValidationError(
      `${context} diagnostics must contain at most ${outputArtifactLimits.outcomeDiagnostics} entries.`
    );
  const artifact: OutcomeArtifact = {
    ...artifactMetadata(base),
    kind: 'outcome',
    state: state as OutcomeState,
    label,
    ...(explanation === undefined ? {} : { explanation }),
    ...(status === undefined ? {} : { status }),
    ...(diagnostics === undefined
      ? {}
      : {
          diagnostics: diagnostics.map((value, index) => {
            const context = `Outcome artifact diagnostic ${index + 1}`;
            const diagnostic = plainRecord(value, context);
            rejectUnknownFields(diagnostic, ['name', 'value', 'unit'], context);
            const name = boundedText(requiredString(diagnostic, 'name', context), 64, `${context} name`, true);
            const unit = optionalString(diagnostic, 'unit', context);
            if (unit !== undefined) boundedText(unit, 32, `${context} unit`);
            return {
              name,
              value: finiteNumber(requiredOwnValue(diagnostic, 'value', context), `${context} value`),
              ...(unit === undefined ? {} : { unit })
            };
          })
        })
  };
  const byteLength = payloadByteLength(artifact);
  if (byteLength > remainingBytes)
    throw new ArtifactValidationError(`${context} exceeds the remaining 16 MiB run limit.`);
  return { artifact, byteLength };
}
