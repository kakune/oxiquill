import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import RuntimeDisclosure from '../../packages/oxiquill/src/components/doc-runtime/RuntimeDisclosure';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function disclosure(disabled = false, busy = false) {
  return (
    <RuntimeDisclosure id="exports" label="Export" disabled={disabled} busy={busy} overlay>
      {(close) => (
        <button type="button" onClick={close}>
          Save SVG
        </button>
      )}
    </RuntimeDisclosure>
  );
}

it('exposes a controlled disclosure of ordinary buttons and restores focus after choosing an action', () => {
  render(disclosure());
  const trigger = screen.getByRole('button', { name: 'Export' });
  expect(trigger).toHaveAttribute('aria-controls', 'exports');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'Save SVG' })).toBeNull();
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.queryByRole('menu')).toBeNull();
  const action = screen.getByRole('button', { name: 'Save SVG' });
  action.focus();
  fireEvent.click(action);
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

it('dismisses on Escape and a second trigger click, restoring focus, but leaves ordinary keys alone', () => {
  render(disclosure());
  const trigger = screen.getByRole('button', { name: 'Export' });
  for (const close of [() => fireEvent.keyDown(document, { key: 'Escape' }), () => fireEvent.click(trigger)]) {
    fireEvent.click(trigger);
    screen.getByRole('button', { name: 'Save SVG' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    close();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  }
});

it('closes on an outside click without taking focus from the clicked control', () => {
  render(
    <>
      {disclosure()}
      <input aria-label="Outside" />
    </>
  );
  const trigger = screen.getByRole('button', { name: 'Export' });
  const outside = screen.getByRole('textbox', { name: 'Outside' });
  fireEvent.click(trigger);
  screen.getByRole('button', { name: 'Save SVG' }).focus();
  outside.focus();
  fireEvent.click(outside);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(outside).toHaveFocus();
  // Clicking non-focusable content keeps focus in context on the trigger.
  fireEvent.click(trigger);
  screen.getByRole('button', { name: 'Save SVG' }).focus();
  fireEvent.click(document.body);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});

it('leaves Escape to other page controls while focus is outside the disclosure', () => {
  render(
    <>
      {disclosure()}
      <input aria-label="Search" />
    </>
  );
  const trigger = screen.getByRole('button', { name: 'Export' });
  const search = screen.getByRole('textbox', { name: 'Search' });
  fireEvent.click(trigger);
  search.focus();
  expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(true);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(search).toHaveFocus();
});

it('keeps internal clicks open and uses no document listeners while closed', () => {
  const add = vi.spyOn(document, 'addEventListener');
  const remove = vi.spyOn(document, 'removeEventListener');
  const view = render(
    <RuntimeDisclosure id="series" label="Series">
      {() => <button type="button">Toggle series</button>}
    </RuntimeDisclosure>
  );
  const trigger = screen.getByRole('button', { name: 'Series' });
  const count = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'click' || type === 'keydown').length;
  expect(count(add)).toBe(0);
  for (let i = 0; i < 5; i++) {
    fireEvent.click(trigger);
    const inside = screen.getByRole('button', { name: 'Toggle series' });
    fireEvent.click(inside);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    inside.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
  }
  expect(count(add)).toBe(10);
  expect(count(remove)).toBe(10);
  fireEvent.click(trigger);
  view.unmount();
  expect(count(add)).toBe(12);
  expect(count(remove)).toBe(12);
});

it('preserves a focusable busy trigger and prevents activation until ready', () => {
  const view = render(disclosure(true));
  const trigger = screen.getByRole('button', { name: 'Export' });
  expect(trigger).toBeDisabled();
  view.rerender(disclosure(false, true));
  expect(trigger).toBeEnabled();
  trigger.focus();
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveAttribute('aria-busy', 'true');
  expect(trigger).toHaveAttribute('aria-disabled', 'true');
  view.rerender(disclosure());
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
});
