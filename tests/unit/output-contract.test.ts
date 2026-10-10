import { describe, expect, it } from 'vitest';
import cases from '../fixtures/output-contract.json';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';

describe('shared producer output contract', () => {
  for (const fixture of cases) {
    it(fixture.name, () => {
      const artifact = structuredClone(fixture.artifact);
      if (fixture.pointCount && artifact.spec?.series?.[0] && 'points' in artifact.spec.series[0]) {
        artifact.spec.series[0].points = Array.from({ length: fixture.pointCount }, () => [0, 1]);
      }
      expect(validateOutputArtifacts([artifact])[0]).toMatchObject(fixture.expected);
    });
  }
});
