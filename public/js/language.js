import hindi from './i18n/hi.js';

let language = 'en';
let large = false;
let dark = false;
const staticText = [];
try {
  language = localStorage.getItem('carecircle.language') === 'hi' ? 'hi' : 'en';
  large = localStorage.getItem('carecircle.large-text') === 'true';
  dark = localStorage.getItem('carecircle.theme') === 'dark';
} catch { /* Browser preferences can be unavailable. */ }

export const tr = value => language === 'hi' && Object.hasOwn(hindi, value) ? hindi[value] : value;
export const locale = () => language === 'hi' ? 'hi-IN' : 'en-IN';
export const inHindi = () => language === 'hi';

function apply() {
  document.documentElement.lang = language;
  document.documentElement.toggleAttribute('data-large-text', large);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  for (const [node, key, original] of staticText) {
    if (!node.parentElement) continue;
    const translated = original.replace(key, () => tr(key));
    if (node.nodeValue !== translated) node.nodeValue = translated;
  }
  for (const element of document.querySelectorAll('[data-i18n]')) {
    const text = tr(element.dataset.i18n);
    if (element.textContent !== text) element.textContent = text;
  }
  const textButton = document.getElementById('large-text');
  textButton.textContent = tr('Larger text');
  textButton.setAttribute('aria-pressed', String(large));
  document.getElementById('language').value = language;
  document.title = tr('CareCircle | Daily care');
  for (const element of document.querySelectorAll('[data-i18n-label]')) {
    element.setAttribute('aria-label', tr(element.dataset.i18nLabel));
  }
  document.querySelector('[name="key"]').placeholder = tr('6 letters or numbers');
  const themeButton = document.getElementById('theme');
  themeButton.textContent = tr('Dark mode');
  themeButton.setAttribute('aria-pressed', String(dark));
}

export function initPreferences(onLanguageChange) {
  // Capture only the original HTML. Rendered names, notes and titles belong to users.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const original = node.nodeValue;
    const key = original.trim();
    const parent = node.parentElement;
    if (!Object.hasOwn(hindi, key) || parent.closest('[data-i18n], script, style, datalist')) continue;
    if (parent.matches('option:not([value])')) parent.value = key;
    staticText.push([node, key, original]);
  }
  apply();
  document.getElementById('language').addEventListener('change', event => {
    language = event.currentTarget.value === 'hi' ? 'hi' : 'en';
    try { localStorage.setItem('carecircle.language', language); } catch { /* Preferences remain active in this tab. */ }
    apply();
    onLanguageChange();
  });
  document.getElementById('large-text').addEventListener('click', () => {
    large = !large;
    try { localStorage.setItem('carecircle.large-text', String(large)); } catch { /* Preferences remain active in this tab. */ }
    apply();
  });
  document.getElementById('theme').addEventListener('click', () => {
    dark = !dark;
    try { localStorage.setItem('carecircle.theme', dark ? 'dark' : 'light'); } catch { /* Preferences remain active in this tab. */ }
    apply();
  });
}
