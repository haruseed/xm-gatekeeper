import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { ApplicationLifecycle } from '../apps/bot/src/lifecycle';
import { sleep } from '../apps/bot/src/polling';

test('shutdown stops intake, drains work spawned by an in-flight request, then closes once', async () => {
  const request = Promise.withResolvers<void>();
  const child = Promise.withResolvers<void>();
  const order: string[] = [];
  const lifecycle = new ApplicationLifecycle(() => { order.push('stop-intake'); }, () => { order.push('close'); });
  lifecycle.track(request.promise.then(() => {
    lifecycle.track(child.promise.then(() => { order.push('child-done'); }));
    order.push('request-done');
  }));
  const stopped = lifecycle.stop();
  expect(lifecycle.signal.aborted).toBe(true);
  expect(lifecycle.stop()).toBe(stopped);
  expect(order).toEqual(['stop-intake']);
  request.resolve();
  await request.promise;
  expect(order).not.toContain('close');
  child.resolve();
  expect(await stopped).toBe(true);
  expect(order).toEqual(['stop-intake', 'request-done', 'child-done', 'close']);
});

test('shutdown deadline leaves a database in use open for process termination', async () => {
  const task = Promise.withResolvers<void>();
  let closed = false;
  const lifecycle = new ApplicationLifecycle(() => {}, () => { closed = true; }, 1);
  lifecycle.track(task.promise);
  expect(await lifecycle.stop()).toBe(false);
  expect(closed).toBe(false);
  task.resolve();
  await task.promise;
  expect(closed).toBe(false);
});

test('failed startup still permits resource cleanup', async () => {
  let closed = 0;
  const lifecycle = new ApplicationLifecycle(() => {}, () => { closed++; });
  const startup = lifecycle.track(Promise.reject(new Error('webhook registration failed')));
  await expect(startup).rejects.toThrow('webhook registration failed');
  expect(await lifecycle.stop()).toBe(true);
  expect(closed).toBe(1);
});

test('sleep cancels promptly and does not accumulate abort listeners', async () => {
  const controller = new AbortController();
  await sleep(1, controller.signal);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  const pending = sleep(60000, controller.signal);
  controller.abort();
  await pending;
  await sleep(60000, controller.signal);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});
