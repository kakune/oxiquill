import { vi } from 'vitest';

export const chart = {
  dispose: vi.fn(),
  resize: vi.fn(),
  setOption: vi.fn()
};

export const echartsInit = vi.fn(() => chart);
export const echartsUse = vi.fn();
export const mermaidInitialize = vi.fn();
export const mermaidRender = vi.fn();
