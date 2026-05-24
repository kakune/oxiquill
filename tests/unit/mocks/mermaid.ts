import { mermaidInitialize, mermaidRender } from './external-runtime';

export type MermaidConfig = Record<string, unknown>;

export default {
  initialize: mermaidInitialize,
  render: mermaidRender
};
