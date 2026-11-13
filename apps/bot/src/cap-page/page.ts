import { globeScript } from '../globe';
import { capPageController } from './controller';
import { capPageStyles } from './styles';

/** Pure page renderer; no database, Telegram identity or verification side effects. */
export function renderCapPage(base: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XM Gatekeeper</title>
<style>${capPageStyles}</style>
<main><div class="earth" aria-hidden="true"><canvas id="earth"></canvas></div><header class="brand"><span class="mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></svg></span>XM Gatekeeper</header><div id="eyebrow" class="label">COMMUNITY VERIFICATION</div><h1 id="heading">Welcome, Agent.<span>Your next link awaits.</span></h1><ol id="steps" class="steps" hidden aria-label="Verification steps"><li id="step-browser" class="active" aria-current="step">1 · Browser check</li><li id="step-picture">2 · Picture question</li></ol><section id="card" class="card" aria-label="Verification status"><div id="progress" class="progress" hidden role="progressbar" aria-label="Preparing verification"></div><p id="status" role="status" aria-live="polite">Welcome to XM Gatekeeper</p><div id="check"></div><p id="guidance">A quick verification for your Ingress community. Tap Verify in your group to begin. Already verified? You’re ready to connect.</p><button id="close" hidden>Back to chat</button></section><p id="help">Built for Ingress communities. Unofficial; not affiliated with Niantic Spatial.</p></main>
<script src="https://telegram.org/js/telegram-web-app.js"></script><script>${capPageController(base)}</script><script>${globeScript}</script></html>`;
}
