import { vi } from 'vitest';

export const chart = {
  getOption: vi.fn(() => ({})),
  dispatchAction: vi.fn(),
  getWidth: vi.fn(() => 720),
  getHeight: vi.fn(() => 360),
  on: vi.fn(),
  convertToPixel: vi.fn(() => [0, 0]),
  containPixel: vi.fn(() => true),
  dispose: vi.fn(),
  resize: vi.fn(),
  setOption: vi.fn()
};

export const echartsInit = vi.fn((element?: HTMLElement, theme?: unknown) => {
  void element;
  void theme;
  return chart;
});
export const echartsUse = vi.fn();
export const mermaidInitialize = vi.fn();
export const mermaidRender = vi.fn();
