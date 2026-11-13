/** Browser entry point. No imports/exports: compiled once to a classic inline script by controller.ts. */
function mountCapPage(base: string): void {
  interface TelegramApp {
    initData: string;
    colorScheme?: string;
    ready(): void;
    onEvent?(event: string, handler: () => void): void;
    openTelegramLink?(url: string): void;
    close(): void;
  }
  interface CapBrowser {
    Telegram?: { WebApp?: TelegramApp };
    CAP_SILENT?: boolean;
    CAP_CUSTOM_HASHWX_URL?: string;
    CAP_PAKO_URL?: string;
    CAP_CUSTOM_FETCH?: (url: string, options?: RequestInit) => Promise<Response>;
  }
  interface Session { passed?: boolean; ticket?: string; returnUrl?: string }
  interface PictureStatus { state: 'waiting' | 'ready' | 'review' | 'finished'; returnUrl?: string }

  const browser = window as unknown as CapBrowser;
  const element = (id: string): HTMLElement => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing page element: ${id}`);
    return node;
  };
  const status = element('status');
  const close = element('close');
  const app = browser.Telegram?.WebApp;
  app?.ready();
  const theme = () => {
    document.documentElement.dataset.theme = app?.colorScheme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  };
  theme();
  app?.onEvent?.('themeChanged', theme);

  const setState = (text: string, loading = false, error = false) => {
    status.textContent = text;
    element('progress').hidden = !loading;
    element('card').classList.toggle('error', error);
  };
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const request = async (url: string, options: RequestInit = {}): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (response.status !== 429 || attempt >= 11) return response;
      const body = await response.clone().json().catch(() => ({})) as { reason?: string };
      if (!['busy', 'upload_busy'].includes(body.reason ?? '')) return response;
      setState('Verification is busy. We’ll retry automatically…', true);
      await delay(Math.min(3000, 500 * 2 ** Math.min(attempt, 3)) + Math.random() * 500);
    }
  };

  const launchParam = new URLSearchParams(app?.initData ?? '').get('start_param') ?? '';
  const directLaunch = launchParam.startsWith('cap_');
  let returnUrl: string | undefined;
  const returnToTelegram = () => {
    try {
      if (!directLaunch && returnUrl && app?.openTelegramLink) app.openTelegramLink(returnUrl);
    } catch {}
    setTimeout(() => { try { app?.close(); } catch {} }, 150);
  };
  close.onclick = returnToTelegram;

  async function verify(): Promise<void> {
    try {
      const requestId = directLaunch ? launchParam.slice(4) : new URLSearchParams(location.search).get('request');
      if (!requestId) { close.hidden = !app?.initData; return; }
      document.title = 'XM Gatekeeper verification';
      document.documentElement.dataset.view = 'verify';
      element('eyebrow').textContent = 'MEMBERSHIP VERIFICATION';
      element('steps').hidden = false;
      element('heading').textContent = 'Verify your access, Agent.';
      setState('Verifying your Telegram account…', true);
      element('guidance').textContent = 'After the browser check, we’ll prepare one picture question with six choices. You’ll return to Telegram automatically when your question is ready.';
      element('help').textContent = 'Need assistance? Return to your verification message and select “I need help”.';
      if (!app?.initData) throw new Error('Open this check using the Verify button in your group or the bot.');
      const identity = { initData: app.initData, requestId };
      const response = await request(base + '/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(identity),
      });
      if (response.status === 429) throw new Error('Verification is busy. Please return to Telegram and try again shortly.');
      if (!response.ok) throw new Error('This check expired or does not belong to your account. Return to the bot to continue.');
      const session = await response.json() as Session;
      returnUrl = session.returnUrl;
      let finishing = false;

      const done = async () => {
        if (finishing) return;
        finishing = true;
        element('check').replaceChildren();
        close.hidden = false;
        setState('Browser check complete. Preparing your picture question…', true);
        element('step-browser').classList.remove('active');
        element('step-browser').removeAttribute('aria-current');
        element('step-picture').classList.add('active');
        element('step-picture').setAttribute('aria-current', 'step');
        for (let attempt = 0; attempt < 240; attempt++) {
          try {
            const response = await fetch(base + '/status', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(identity), signal: AbortSignal.timeout(8000),
            });
            if (response.ok) {
              const result = await response.json() as PictureStatus;
              if (result.state === 'ready') {
                returnUrl = result.returnUrl;
                setState('Your picture question is ready. Returning to Telegram…');
                setTimeout(returnToTelegram, 600);
                return;
              }
              if (result.state !== 'waiting') {
                setState(result.state === 'finished' ? 'Your verification is complete.' : 'Administrator assistance is required. Please return to Telegram for help.');
                return;
              }
            } else if (response.status === 403) {
              setState('Please return to the bot and reopen verification.', false, true);
              return;
            }
          } catch {}
          await delay(1000);
        }
        setState('Preparing your question is taking longer than expected. You can return to Telegram; your question will appear as soon as it is ready.');
      };
      if (session.passed) { void done(); return; }
      browser.CAP_SILENT = true;
      browser.CAP_CUSTOM_HASHWX_URL = base + '/hashwx.wasm';
      browser.CAP_PAKO_URL = base + '/pako.js';
      browser.CAP_CUSTOM_FETCH = async (url, options = {}) => {
        const response = await request(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + session.ticket } });
        if (url.endsWith('/redeem') && response.ok) {
          const result = await response.clone().json() as { success?: boolean; returnUrl?: string };
          if (result.success) returnUrl = result.returnUrl;
        }
        return response;
      };
      const script = document.createElement('script');
      script.src = base + '/widget.js';
      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = reject;
        document.head.append(script);
      });
      const widget = document.createElement('cap-widget');
      widget.setAttribute('data-cap-api-endpoint', base + '/api/');
      widget.addEventListener('solve', () => { void done(); });
      setState('Complete the browser check below to continue.');
      element('check').append(widget);
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
      setState(message || 'Could not load the check. Please return to the bot and try again.', false, true);
      close.hidden = false;
    }
  }
  void verify();
}
