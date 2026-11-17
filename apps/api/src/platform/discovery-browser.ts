/// <reference lib="dom" />
import { chromium, type Browser, type ElementHandle, type Page } from 'playwright-core';
import { discoveryUrl } from '../domain/competition-discovery';
import type { RawFetchResult } from './safe-fetch';

export interface BrowserObservation {
  url: string;
  html: string;
  text: string;
  controls: Array<{ id: number; label: string; kind: string; context: string; destination?: string }>;
}

type ReadResource = (url: string, accept: string, origin?: string, staticResource?: boolean) => Promise<RawFetchResult>;
type ChooseControl = (view: BrowserObservation) => Promise<{ id: number; reason: string } | null>;

// Bound both browser work and the model calls it can trigger.
const MAX_RESOURCES = 80;
const TIMEOUT = 6000;
const SESSION_TIMEOUT = 35000;
const NAVIGATION_CONTROL = /通知|公告|规程|章程|指南|赛程|赛事|竞赛|比赛|更多|下一页|下页|加载|展开|历届|next|more|notice|rules|schedule/i;
const EXCLUDED_CONTROL = /登录|注册账号|支付|提交|退出|删除|立即报名|我要报名|报名入口|登录报名|注册报名|sign[ -]?(?:in|up)|log[ -]?in|submit|delete|pay now/i;
let activeBrowsers = 0;

export function hasDiscoveryControls(html: string): boolean {
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return [...markup.matchAll(/<(button|summary)\b[^>]*>([\s\S]*?)<\/\1>/gi),
    ...markup.matchAll(/<(a|div|span)\b(?=[^>]*(?:\bonclick\s*=|\brole\s*=\s*["'](?:button|tab)["']|\bhref\s*=\s*["'](?:#(?!\/)|javascript:)))[^>]*>([\s\S]*?)<\/\1>/gi)]
    .some(([, , label]) => NAVIGATION_CONTROL.test(label.replace(/<[^>]+>/g, '')) && !EXCLUDED_CONTROL.test(label));
}

async function launchBrowser(): Promise<Browser> {
  for (const channel of ['chrome', 'msedge', undefined] as const) {
    try {
      return await chromium.launch({
        channel, headless: true, chromiumSandbox: true, timeout: TIMEOUT,
        // All HTTP resources are supplied via the existing guarded fetcher.
        proxy: { server: 'http://192.0.2.1:9', bypass: '<-loopback>' },
        args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
    } catch {
      // Try another installed browser.
    }
  }
  throw new Error('browser_unavailable');
}

async function observe(page: Page, origin: string) {
  const controls: BrowserObservation['controls'] = [];
  const handles: ElementHandle[] = [];
  const nodes = await page.locator('a, button, summary, [role="button"], [role="tab"], [onclick], [tabindex="0"]').elementHandles();
  for (const node of nodes.slice(0, 120)) {
    const item = await node.evaluate(node => {
      if (!(node instanceof HTMLElement)) return null;
      return {
        label: (node.getAttribute('aria-label') || node.innerText || node.getAttribute('title') || '')
          .replace(/\s+/g, ' ').trim().slice(0, 120),
        kind: node.getAttribute('role') || node.tagName.toLowerCase(),
        context: (node.parentElement?.querySelector('h1,h2,h3,h4')?.textContent ?? '').trim().slice(0, 80),
        href: node.getAttribute('href'),
        disabled: node.matches(':disabled,[aria-disabled="true"],[download]') || !!node.closest('form'),
      };
    }).catch(() => null);
    if (!item || item.disabled || !NAVIGATION_CONTROL.test(item.label) || EXCLUDED_CONTROL.test(item.label)) continue;
    let destination: string | undefined;
    if (item.href && !item.href.startsWith('#')) {
      const address = URL.parse(item.href, page.url());
      if (address?.protocol !== 'javascript:' && (!address || address.origin !== origin)) continue;
      if (address?.origin === origin) destination = address.pathname.slice(0, 160);
    }
    if (!(await node.isVisible())) continue;
    handles.push(node);
    controls.push({ id: controls.length + 1, label: item.label, kind: item.kind, context: item.context, destination });
    if (controls.length >= 16) break;
  }
  const url = discoveryUrl(page.url());
  if (!url || new URL(url).origin !== origin) throw new Error('browser_offsite');
  const text = (await page.locator('body').innerText({ timeout: TIMEOUT })).trim().slice(0, 2600);
  const html = await page.content();
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new Error('response_too_large');
  return { view: { url, text, html, controls }, handles, nodes };
}

export async function browseDiscoveryPage(
  url: string, seed: RawFetchResult, readResource: ReadResource, choose: ChooseControl,
  onClick: (label: string, url: string, reason: string) => void,
  resourceBudget = 8 * 1024 * 1024,
): Promise<BrowserObservation[]> {
  if (activeBrowsers >= 2) throw new Error('browser_busy');
  activeBrowsers++;
  let browser: Browser | undefined;
  let deadline: NodeJS.Timeout | undefined;
  try {
    browser = await launchBrowser();
    const session = browser;
    deadline = setTimeout(() => void session.close().catch(() => undefined), SESSION_TIMEOUT);
    const origin = new URL(url).origin;
    const documentUrl = url.split('#', 1)[0];
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.routeWebSocket('**/*', ws => ws.close());
    let requests = 0;
    let bytes = 0;
    await context.route('**/*', async route => {
      try {
        const request = route.request();
        const address = discoveryUrl(request.url());
        const kind = request.resourceType();
        const staticResource = kind === 'script' || kind === 'stylesheet';
        if (!address || request.method() !== 'GET' || !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(kind)
          || (!staticResource && new URL(address).origin !== origin) || ++requests > MAX_RESOURCES || bytes > resourceBudget) {
          await route.abort();
          return;
        }
        const response = address === documentUrl && kind === 'document' ? seed
          : await readResource(address, request.headers().accept || '*/*', staticResource ? undefined : origin, staticResource);
        bytes += response.buffer.length;
        if (bytes > resourceBudget || (kind === 'document' && (response.finalUrl !== address || !/html/i.test(response.contentType ?? '')))) {
          await route.abort();
          return;
        }
        await route.fulfill({
          status: response.status, contentType: response.contentType ?? 'application/octet-stream', body: response.buffer,
          headers: response.browserHeaders,
        });
      } catch {
        await route.abort().catch(() => undefined);
      }
    });

    let page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const snapshots: BrowserObservation[] = [];
    const seen = new Set<string>();
    while (browser.isConnected()) {
      await page.waitForLoadState('networkidle', { timeout: 2200 }).catch(() => undefined);
      const observation = await observe(page, origin).catch(error => {
        if (!snapshots.length) throw error;
        return null;
      });
      if (!observation) break;
      const { view, handles, nodes } = observation;
      const signature = JSON.stringify([view.url, view.text, view.controls]);
      if (seen.has(signature)) break;
      seen.add(signature);
      snapshots.push(view);
      if (!view.controls.length) break;
      const decision = await choose(view) ?? (view.controls.length ? { id: 1, reason: '模型不可用，按页面导航顺序核验' } : null);
      if (!decision || !Number.isInteger(decision.id)) break;
      const handle = handles[decision.id - 1];
      if (!handle) break;
      try {
        await handle.click({ timeout: 2500 });
        onClick(view.controls[decision.id - 1].label, view.url, decision.reason);
        const popup = context.pages().at(-1);
        if (popup && popup !== page) {
          page = popup;
          await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT });
        } else {
          await page.waitForFunction(previousText => document.body?.innerText.trim().slice(0, 2600) !== previousText,
            view.text, { timeout: 2200 }).catch(() => undefined);
        }
      } catch {
        break;
      } finally {
        await Promise.allSettled(nodes.map(node => node.dispose()));
      }
    }
    return snapshots;
  } finally {
    clearTimeout(deadline);
    try {
      await browser?.close().catch(() => undefined);
    } finally {
      activeBrowsers--;
    }
  }
}
