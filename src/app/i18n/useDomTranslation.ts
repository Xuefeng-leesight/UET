import React from 'react';
import { EN_TERM_MAP, TRANSLATION_BUNDLES, type LanguageCode } from '@/app/i18n/i18nConfig';
import { JA_EXACT } from '@/app/i18n/jaTranslations';

const TEXT_ATTRS = ['placeholder', 'title', 'aria-label'] as const;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
const TRANSLATION_SKIP_ATTR = 'data-i18n-skip';
const HAN_RE = /[\u3400-\u9FFF]/u;
const HAN_GLOBAL_RE = /[\u3400-\u9FFF]+/gu;
const ALPHA_RE = /[A-Za-z]/;
const TERM_PAIRS = Object.entries(EN_TERM_MAP).sort((a, b) => b[0].length - a[0].length);
// Japanese output keeps kanji, so the Han check alone cannot tell untranslated text apart.
// Only short multi-character terms are reused for partial substitution, so single characters
// and whole sentences are never spliced into unrelated text.
const JA_TERM_PAIRS = Object.entries(JA_EXACT)
  .filter(([zh]) => zh.length >= 2 && zh.length <= 8 && HAN_RE.test(zh))
  .sort((a, b) => b[0].length - a[0].length);
const REASON_LABELS: Partial<Record<LanguageCode, { label: string; separator: string }>> = {
  'en-US': { label: 'Reason: ', separator: '; ' },
  'ja-JP': { label: '原因：', separator: '、' },
};
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

// Substitutes known Chinese terms with Japanese ones, but only when every Han run of the
// source is covered; otherwise the original Chinese is kept to avoid mixed zh/ja output.
const fallbackTranslateChineseToJapanese = (core: string): string | null => {
  if (!HAN_RE.test(core)) return core;
  const parts: string[] = [];
  let out = core;
  for (const [zh, ja] of JA_TERM_PAIRS) {
    if (!out.includes(zh)) continue;
    out = out.split(zh).join(`\u0000${parts.length}\u0000`);
    parts.push(ja);
  }
  if (HAN_RE.test(out)) {
    const unresolved = core.trim();
    if (!missingTermsReported.has(unresolved)) {
      missingTermsReported.add(unresolved);
      console.warn('[i18n] Missing ja translation:', unresolved);
    }
    return null;
  }
  return out.replace(/\u0000(\d+)\u0000/gu, (_, index: string) => parts[Number(index)] ?? '');
};

const MAX_JA_RULE_DEPTH = 3;

// Returns null when the text cannot be fully translated, so callers can keep the source.
const resolveJapanese = (core: string, depth = 0): string | null => {
  const bundle = TRANSLATION_BUNDLES['ja-JP'];
  if (bundle.exact[core]) return bundle.exact[core];
  const normalized = core.replace(/\s+/gu, ' ').trim();
  if (normalized && bundle.exact[normalized]) return bundle.exact[normalized];
  if (!HAN_RE.test(core)) return core;
  if (depth < MAX_JA_RULE_DEPTH) {
    const candidates = normalized && normalized !== core ? [core, normalized] : [core];
    for (const candidate of candidates) {
      for (const rule of bundle.rules) {
        const match = candidate.match(rule.pattern);
        if (!match) continue;
        const translated = applyJapaneseReplacement(rule.replace, match, depth);
        if (translated !== null) return translated;
      }
    }
  }
  return fallbackTranslateChineseToJapanese(core);
};

// "$n" keeps the capture, "{n}" must translate (otherwise the rule fails), "{n?}" is best effort.
const applyJapaneseReplacement = (template: string, match: RegExpMatchArray, depth: number): string | null => {
  let failed = false;
  const out = template.replace(/\$(\d+)|\{(\d+)(\?)?\}/gu, (_, literal?: string, group?: string, optional?: string) => {
    if (literal) return match[Number(literal)] ?? '';
    const captured = match[Number(group)] ?? '';
    const translated = resolveJapanese(captured.trim(), depth + 1);
    if (translated !== null) return translated;
    if (!optional) failed = true;
    return captured;
  });
  return failed ? null : out;
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
  if (language === 'ja-JP') return resolveJapanese(core) ?? core;
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
  if (!value.trim()) return value;
  if (language === 'zh-CN') return value;
  const reasonLabel = REASON_LABELS[language];
  if (reasonLabel) {
    if (value.includes('\n')) {
      // Match complete notices first: deletion and calibration rules span lines.
      // Splitting first makes those rules unreachable even when the bundle has them.
      if (language === 'ja-JP') {
        const translated = resolveJapanese(value.trim());
        if (translated !== null) {
          return `${value.match(/^\s*/u)?.[0] || ''}${translated}${value.match(/\s*$/u)?.[0] || ''}`;
        }
      }
      return value.split('\n').map((line) => translateTextForLanguage(line, language)).join('\n');
    }
    const reason = value.match(/^(\s*)原因[:：]\s*([\s\S]+)$/u);
    if (reason) return `${reason[1]}${reasonLabel.label}${reason[2].split('；').map((part) => translateTextForLanguage(part, language)).join(reasonLabel.separator)}`;
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

// For text the DOM layer does not reach (data-i18n-skip regions, native dialogs, canvas):
// English keeps its hand-written text, other languages translate the Chinese source.
export const localizeText = (language: LanguageCode, zh: string, en?: string): string => {
  if (language === 'en-US' && en !== undefined) return en;
  return translateTextForLanguage(zh, language);
};

// Last value written by the translator per node/attribute. Japanese output still contains
// kanji, so re-scanning an already translated node must not translate it a second time.
type ProducedValues = {
  text: WeakMap<Text, string>;
  attrs: WeakMap<Element, Map<(typeof TEXT_ATTRS)[number], string>>;
};

const translateElementAttrs = (
  element: Element,
  language: LanguageCode,
  touchedAttrs: Map<Element, Map<(typeof TEXT_ATTRS)[number], string>>,
  produced: ProducedValues,
) => {
  for (const attr of TEXT_ATTRS) {
    const raw = element.getAttribute(attr);
    if (!raw) continue;
    if (produced.attrs.get(element)?.get(attr) === raw) continue;
    const next = translateTextForLanguage(raw, language);
    if (next !== raw) {
      const stored = touchedAttrs.get(element) || new Map<(typeof TEXT_ATTRS)[number], string>();
      stored.set(attr, raw);
      touchedAttrs.set(element, stored);
      element.setAttribute(attr, next);
      const producedAttrs = produced.attrs.get(element) || new Map<(typeof TEXT_ATTRS)[number], string>();
      producedAttrs.set(attr, next);
      produced.attrs.set(element, producedAttrs);
    }
  }
};

const translateNode = (
  node: Node,
  language: LanguageCode,
  touchedText: Map<Text, string>,
  touchedAttrs: Map<Element, Map<(typeof TEXT_ATTRS)[number], string>>,
  produced: ProducedValues,
): void => {
  if (isNodeInsideTranslationSkip(node)) return;

  if (node.nodeType === Node.TEXT_NODE) {
    if (isNodeInsideUserEditable(node)) return;
    const textNode = node as Text;
    const raw = textNode.nodeValue || '';
    if (produced.text.get(textNode) === raw) return;
    const next = translateTextForLanguage(raw, language);
    if (next !== raw) {
      touchedText.set(textNode, raw);
      textNode.nodeValue = next;
      produced.text.set(textNode, next);
    }
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  if (SKIP_TAGS.has(element.tagName)) return;

  translateElementAttrs(element, language, touchedAttrs, produced);
  const children = Array.from(element.childNodes);
  for (const child of children) {
    translateNode(child, language, touchedText, touchedAttrs, produced);
  }
};

export function useDomTranslation(language: LanguageCode): void {
  React.useEffect(() => {
    if (language === 'zh-CN') return;
    const root = document.body;
    if (!root) return;

    const touchedText = new Map<Text, string>();
    const touchedAttrs = new Map<Element, Map<(typeof TEXT_ATTRS)[number], string>>();
    const produced: ProducedValues = { text: new WeakMap(), attrs: new WeakMap() };

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
        if (node.isConnected) translateNode(node, language, touchedText, touchedAttrs, produced);
      });
      observer.takeRecords();
      if (!disposed) observer.observe(root, observerOptions);
    };

    const scheduleTranslation = (node: Node) => {
      pendingNodes.add(node);
      if (!frameId) frameId = window.requestAnimationFrame(flushPendingTranslations);
    };

    translateNode(root, language, touchedText, touchedAttrs, produced);
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
      // Restore only values still showing our translation: when switching languages React
      // has already rendered the new language's text, which must not be overwritten.
      touchedText.forEach((raw, node) => {
        if (!node.isConnected) return;
        if (node.nodeValue === produced.text.get(node)) node.nodeValue = raw;
      });
      touchedAttrs.forEach((attrs, element) => {
        if (!element.isConnected) return;
        attrs.forEach((raw, attr) => {
          const current = element.getAttribute(attr);
          if (current === produced.attrs.get(element)?.get(attr)) element.setAttribute(attr, raw);
        });
      });
    };
  }, [language]);
}
