import { readFileSync } from 'node:fs';

// Bun is the application runtime. Compile once on module load, never for each HTTP request.
// Keep the browser entry point import-free so a classic inline script needs no module loader.
const source = readFileSync(new URL('./browser-client.ts', import.meta.url), 'utf8');
const browserScript = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(source);

export function capPageController(base: string): string {
  const encodedBase = JSON.stringify(base).replace(/</g, '\\u003c');
  return `${browserScript}\nmountCapPage(${encodedBase});`;
}
