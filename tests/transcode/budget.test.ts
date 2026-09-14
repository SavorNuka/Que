import { describe, expect, it, vi } from 'vitest';
import { ConcurrencyBudget } from '../../src/main/transcode/budget';

describe('ConcurrencyBudget', () => {
  it('starts with all cores available and none reserved', () => {
    const b = new ConcurrencyBudget(8);
    expect(b.total).toBe(8);
    expect(b.reserved).toBe(0);
    expect(b.available).toBe(8);
  });

  it('reserving reduces what is left for background work', () => {
    const b = new ConcurrencyBudget(8);
    b.reserve(4);
    expect(b.reserved).toBe(4);
    expect(b.available).toBe(4);
  });

  it('releasing gives the cores back', () => {
    const b = new ConcurrencyBudget(8);
    const release = b.reserve(4);
    release();
    expect(b.reserved).toBe(0);
    expect(b.available).toBe(8);
  });

  it('release is idempotent — calling it twice does not double-refund', () => {
    const b = new ConcurrencyBudget(8);
    const release = b.reserve(4);
    release();
    release();
    expect(b.reserved).toBe(0);
  });

  it('never lets available drop below 1, even fully reserved', () => {
    const b = new ConcurrencyBudget(4);
    b.reserve(4);
    b.reserve(4);
    expect(b.available).toBe(1);
  });

  it('clamps a reservation larger than the total', () => {
    const b = new ConcurrencyBudget(4);
    b.reserve(100);
    expect(b.reserved).toBe(4);
  });

  it('notifies subscribers on reserve and on release', () => {
    const b = new ConcurrencyBudget(8);
    const onChange = vi.fn();
    b.onChange(onChange);

    const release = b.reserve(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('an unsubscribed listener stops being notified', () => {
    const b = new ConcurrencyBudget(8);
    const onChange = vi.fn();
    const unsubscribe = b.onChange(onChange);
    unsubscribe();

    b.reserve(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('defaults total from the machine when none is given', () => {
    const b = new ConcurrencyBudget();
    expect(b.total).toBeGreaterThanOrEqual(1);
  });
});
