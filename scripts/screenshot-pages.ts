// Render actual application pages with synthetic Telegram responses for documentation.
import { renderCapPage } from '../apps/bot/src/cap-page/page';
import { mkdirSync } from 'node:fs';
const output = process.argv[2];
if (!output) throw Error('Provide an output directory');
mkdirSync(output, { recursive: true });
const html = renderCapPage('/guard/verify').replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', '');
await Bun.write(`${output}/home.html`, html);
const fixture = `<script>window.Telegram={WebApp:{initData:'start_param=cap_demo',colorScheme:'dark',ready(){},onEvent(){},close(){}}};window.fetch=async()=>new Response(JSON.stringify({passed:true,state:'waiting'}));</script>`;
await Bun.write(`${output}/cap.html`, html.replace('<script>', fixture + '<script>'));
