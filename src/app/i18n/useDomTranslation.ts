import React from 'react';
import { EN_TERM_MAP, TRANSLATION_BUNDLES, type LanguageCode } from '@/app/i18n/i18nConfig';

const TEXT_ATTRS = ['placeholder', 'title', 'aria-label'] as const;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
const TRANSLATION_SKIP_ATTR = 'data-i18n-skip';
const HAN_RE = /[\u3400-\u9FFF]/u;
const HAN_GLOBAL_RE = /[\u3400-\u9FFF]+/gu;
const ALPHA_RE = /[A-Za-z]/;
const TERM_PAIRS = Object.entries(EN_TERM_MAP).sort((a, b) => b[0].length - a[0].length);
const missingTermsReported = new Set<string>();
const EN_CANONICAL_TOKENS: Record<string, string> = {
  ai: 'AI',
  aoi: 'AOI',
  aois: 'AOIs',
  api: 'API',
  csv: 'CSV',
  esc: 'ESC',
  hz: 'Hz',
  id: 'ID',
  ip: 'IP',
  ipc: 'IPC',
  mp4: 'MP4',
  udp: 'UDP',
  url: 'URL',
  ws: 'WS',
};

const normalizePunctuation = (value: string): string =>
  value
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/：/g, ': ')
    .replace(/，/g, ', ')
    .replace(/。/g, '. ')
    .replace(/；/g, '; ')
    .replace(/、/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

const isUserEditableElement = (element: Element | null): boolean => {
  if (!element) return false;
  if (element instanceof HTMLInputElement) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return false;
};

const isNodeInsideUserEditable = (node: Node): boolean => {
  let current: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (current) {
    if (isUserEditableElement(current)) return true;
    current = current.parentElement;
  }
  return false;
};

const isNodeInsideTranslationSkip = (node: Node): boolean => {
  let current: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (current) {
    const skipAttr = current.getAttribute(TRANSLATION_SKIP_ATTR);
    if (skipAttr !== null && skipAttr !== 'false') return true;
    current = current.parentElement;
  }
  return false;
};

const fallbackTranslateChinese = (core: string): string => {
  if (!HAN_RE.test(core)) return core;
  let out = core;
  for (const [zh, en] of TERM_PAIRS) {
    if (!out.includes(zh)) continue;
    out = out.split(zh).join(` ${en} `);
  }
  out = normalizePunctuation(out);
  if (!HAN_RE.test(out)) return out;

  // Prevent mixed zh/en fragments like "命令通道未 Connect" when a full phrase mapping is missing.
  // In that case prefer the original source text instead of partial term substitution.
  if (ALPHA_RE.test(out)) {
    const unresolvedMixed = core.trim();
    if (!missingTermsReported.has(unresolvedMixed)) {
      missingTermsReported.add(unresolvedMixed);
      console.warn('[i18n] Mixed fallback suppressed:', unresolvedMixed);
    }
    return core;
  }

  const unresolved = core.trim();
  if (!missingTermsReported.has(unresolved)) {
    missingTermsReported.add(unresolved);
    console.warn('[i18n] Missing translation fallback:', unresolved);
  }

  return out;
};

const normalizeEnglishSentenceCase = (value: string): string => {
  if (!ALPHA_RE.test(value)) return value;
  const tokens = value.split(/(\s+)/u);
  const normalizedTokens = tokens.map((token) => {
    if (!token || /^\s+$/u.test(token)) return token;
    const match = token.match(/^([^A-Za-z0-9-]*)([A-Za-z0-9-]+)([^A-Za-z0-9-]*)$/u);
    if (!match) return token;
    const [, leading, core, trailing] = match;
    const lowerCore = core.toLowerCase();
    const canonical = EN_CANONICAL_TOKENS[lowerCore];
    if (canonical) return `${leading}${canonical}${trailing}`;
    // Preserve short all-caps technical tokens or hyphenated IDs, e.g. UET-SA, JSON, MS.
    if (/^[A-Z0-9-]+$/u.test(core) && (core.length <= 4 || core.includes('-') || /\d/u.test(core))) {
      return token;
    }
    // Preserve brand/proper names with internal capitals, e.g. OpenAI, DeepSeek, WebSocket.
    if (/[A-Z].+[A-Z]/u.test(core) && /[a-z]/u.test(core)) return token;
    return `${leading}${lowerCore}${trailing}`;
  });
  const normalized = normalizedTokens.join('');
  return normalized.replace(/[A-Za-z]/u, (ch) => ch.toUpperCase());
};

const translateCoreText = (core: string, language: LanguageCode): string => {
  if (language === 'zh-CN') return core;
  const bundle = TRANSLATION_BUNDLES[language];
  if (!bundle) return core;
  if (bundle.exact[core]) return normalizeEnglishSentenceCase(bundle.exact[core]);
  const normalized = core.replace(/\s+/gu, ' ').trim();
  if (normalized && bundle.exact[normalized]) return normalizeEnglishSentenceCase(bundle.exact[normalized]);
  for (const rule of bundle.rules) {
    if (rule.pattern.test(core)) return normalizeEnglishSentenceCase(core.replace(rule.pattern, rule.replace));
  }
  for (const rule of bundle.rules) {
    if (normalized && rule.pattern.test(normalized)) {
      return normalizeEnglishSentenceCase(normalized.replace(rule.pattern, rule.replace));
    }
  }
  return normalizeEnglishSentenceCase(fallbackTranslateChinese(core));
};

export const translateTextForLanguage = (value: string, language: LanguageCode): string => {
  if (!value) return value;
  if (language === 'en-US') {
    if (value.includes('\n')) {
      return value.split('\n').map((line) => translateTextForLanguage(line, language)).join('\n');
    }
    const reason = value.match(/^(\s*)原因[:：]\s*([\s\S]+)$/u);
    if (reason) return `${reason[1]}Reason: ${reason[2].split('；').map((part) => translateTextForLanguage(part, language)).join('; ')}`;
    const startFailure = value.match(/^(\s*start failed\s*\(-?\d+\)\s*-\s*)(未知错误，请检查设备连接和SDK配置)\s*$/iu);
    if (startFailure) return `${startFailure[1]}${translateCoreText(startFailure[2], language)}`;
  }
  const leading = value.match(/^\s*/u)?.[0] || '';
  const trailing = value.match(/\s*$/u)?.[0] || '';
  const core = value.slice(leading.length, value.length - trailing.length);
  if (!core) return value;
  const translated = translateCoreText(core, language);
  if (!translated || translated === core) return value;
  return `${leading}${translated}${trailing}`;
};

const translateElementAttrs = (
  element: Element,
  language: LanguageCode,
  touchedAttrs: Map<Element, Map<(typeof TEXT_ATTRS)[number], string>>,
) => {
  for (const attr of TEXT_ATTRS) {
    const raw = element.getAttribute(attr);
    if (!raw) continue;
    const next = translateTextForLanguage(raw, language);
    if (next !== raw) {
      const stored = touchedAttrs.get(element) || new Map<(typeof TEXT_ATTRS)[number], string>();
      if (!stored.has(attr)) stored.set(attr, raw);
      touchedAttrs.set(element, stored);
      element.setAttribute(attr, next);
    }
  }
};

const translateNode = (
  node: Node,
  language: LanguageCode,
  touchedText: Map<Text, string>,
  touchedAttrs: Map<Element, Map<(typeof TEXT_ATTRS)[number], string>>,
): void => {
  if (isNodeInsideTranslationSkip(node)) return;

  if (node.nodeType === Node.TEXT_NODE) {
    if (isNodeInsideUserEditable(node)) return;
    const textNode = node as Text;
    const raw = textNode.nodeValue || '';
    const next = translateTextForLanguage(raw, language);
    if (next !== raw) {
      if (!touchedText.has(textNode)) touchedText.set(textNode, raw);
      textNode.nodeValue = next;
    }
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  if (SKIP_TAGS.has(element.tagName)) return;

  translateElementAttrs(element, language, touchedAttrs);
  const children = Array.from(element.childNodes);
  for (const child of children) {
    translateNode(child, language, touchedText, touchedAttrs);
  }
};

export function useDomTranslation(language: LanguageCode): void {
  React.useEffect(() => {
    if (language !== 'en-US') return;
    const root = document.body;
    if (!root) return;

    const touchedText = new Map<Text, string>();
    const touchedAttrs = new Map<Element, Map<(typeof TEXT_ATTRS)[number], string>>();

    const observerOptions: MutationObserverInit = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TEXT_ATTRS as unknown as string[],
    };
    const pendingNodes = new Set<Node>();
    let frameId = 0;
    let disposed = false;

    const flushPendingTranslations = () => {
      frameId = 0;
      if (disposed || pendingNodes.size === 0) return;
      const nodes = Array.from(pendingNodes);
      pendingNodes.clear();
      // Translation itself mutates text nodes. Temporarily disconnect and
      // discard those self-generated records so dynamic React updates cannot
      // create a translation feedback loop on large result lists.
      observer.disconnect();
      nodes.forEach((node) => {
        if (node.isConnected) translateNode(node, language, touchedText, touchedAttrs);
      });
      observer.takeRecords();
      if (!disposed) observer.observe(root, observerOptions);
    };

    const scheduleTranslation = (node: Node) => {
      pendingNodes.add(node);
      if (!frameId) frameId = window.requestAnimationFrame(flushPendingTranslations);
    };

    translateNode(root, language, touchedText, touchedAttrs);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData' || mutation.type === 'attributes') {
          scheduleTranslation(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach(scheduleTranslation);
      }
    });
    observer.observe(root, observerOptions);

    return () => {
      disposed = true;
      observer.disconnect();
      if (frameId) window.cancelAnimationFrame(frameId);
      pendingNodes.clear();
      touchedText.forEach((raw, node) => {
        if (!node.isConnected) return;
        if (node.nodeValue !== raw) node.nodeValue = raw;
      });
      touchedAttrs.forEach((attrs, element) => {
        if (!element.isConnected) return;
        attrs.forEach((raw, attr) => {
          const current = element.getAttribute(attr);
          if (current !== raw) element.setAttribute(attr, raw);
        });
      });
    };
  }, [language]);
}
