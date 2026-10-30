'use strict';

// ---- À modifier ici ----
// Lien de l'installateur (à changer quand le repo GitHub passe en privé).
const DOWNLOAD_URL = 'https://github.com/ThomasLpgs/VirtualDeck/releases/latest';
// Dernière version publiée : le bouton télécharge directement son installateur.
const LATEST_RELEASE_API = 'https://api.github.com/repos/ThomasLpgs/VirtualDeck/releases/latest';
const INSTALLER_URL_PREFIX = 'https://github.com/ThomasLpgs/VirtualDeck/releases/download/';
const INSTALLER_NAME = /^VirtualDeck-Setup-\d+\.\d+\.\d+\.exe$/;

// Offre payante : prix et liens de paiement (Lemon Squeezy / Paddle).
// Un lien vide affiche « Bientôt disponible ».
const PLANS = {
  pro: { monthly: 4.99, yearly: 49.99, checkout: { monthly: '', yearly: '' } },
};

// Contenu provisoire de l'offre (clés de traduction ci-dessous).
const PLAN_FEATURES = {
  pro: ['pf.phoneInf', 'pf.allpc', 'pf.support'],
};
// ------------------------

const EN = {
  'nav.features': 'Features',
  'nav.phone': 'Phone',
  'nav.pricing': 'Pricing',
  'nav.faq': 'FAQ',
  'nav.download': 'Download',
  'hero.badge': 'Version 1.13 · Windows 10 and 11',
  'hero.title': 'Your Stream Deck, without the hardware.',
  'hero.lead': 'A keyboard shortcut opens a grid of buttons under your mouse. One click switches your OBS scene, plays an animation or a sound, turns on your lights or opens an app.',
  'hero.cta': 'Download for free',
  'hero.cta2': 'See plans',
  'hero.hint': 'Free, no account, no ads.',
  'features.eyebrow': 'Features',
  'features.title': 'Everything you need to run your stream.',
  'f.obs.t': 'OBS Studio and Streamlabs',
  'f.obs.d': 'Scenes, sources and animations, muted audio, clips, live and recording. Buttons show the live state: LIVE 1:02:03, REC, MUTED.',
  'f.multi.t': 'Multi-actions',
  'f.multi.d': 'One button chains a scene, music and a hidden webcam, with delays between each step.',
  'f.sound.t': 'Sounds and music',
  'f.sound.d': 'Play sound effects, control Spotify or YouTube, mute every microphone on your PC at once.',
  'f.lights.t': 'Hue and Govee lights',
  'f.lights.d': 'Turn your lamps on, off or change their color, right on your home network.',
  'f.templates.t': 'Ready-made templates',
  'f.templates.d': 'Stream, chat, Discord, music, Teams, Zoom: one click adds a full deck.',
  'f.vertical.t': 'Vertical format and 6 languages',
  'f.vertical.d': 'Works with Aitum Vertical for TikTok and Shorts. Over 2,000 icons, grids up to 8 × 6, full config export, one-click updates.',
  'phone.pill': 'Premium',
  'phone.title': 'Your phone becomes a touch Stream Deck.',
  'phone.lead': 'Scan a QR code and you are ready. No app to install, everything stays on your home Wi-Fi.',
  'phone.c1': 'Live LIVE, REC and MUTED badges',
  'phone.c2': 'Every tap is signed: other devices on the Wi-Fi cannot trigger anything',
  'phone.c3': 'Swipe to switch pages',
  'phone.cta': 'See plans',
  'shots.eyebrow': 'Screenshots',
  'shots.title': 'Easy to set up.',
  'shots.c1': 'Look and action of every button',
  'shots.c2': 'Connect to OBS or Streamlabs, with a step-by-step guide',
  'shots.c3': 'Language, shortcut, deck size, pages, backup',
  'pricing.eyebrow': 'Pricing',
  'pricing.title': 'Free on PC. Premium for your phone.',
  'pricing.monthly': 'Monthly',
  'pricing.yearly': 'Yearly',
  'pricing.save': '2 months free',
  'pricing.note': 'No account: you get a license key by email to paste into VirtualDeck. Cancel anytime.',
  'plan.free.name': 'Free',
  'plan.free.desc': 'All of VirtualDeck on your PC, forever.',
  'plan.free.f1': 'Every action and integration',
  'plan.free.f2': 'Unlimited pages, templates and icons',
  'plan.free.f3': 'Updates included',
  'plan.free.cta': 'Download',
  'plan.pro.name': 'Premium',
  'plan.soon': 'Coming soon',
  'plan.buy': 'Subscribe',
  'per.month': '/ month',
  'per.year': '/ year',
  'sub.yearly': 'That is {x} / month',
  'sub.monthly': 'Billed monthly',
  'pf.phoneInf': 'Phone deck, unlimited phones',
  'pf.allpc': 'Everything in Free',
  'pf.support': 'Priority support',
  'faq.title': 'Frequently asked questions',
  'faq.q1': 'Is VirtualDeck really free?',
  'faq.a1': 'Yes. Every feature on PC is free, with no time limit. Only the phone deck needs a subscription.',
  'faq.q2': 'Do I need an account?',
  'faq.a2': 'No. After purchase you get a license key by email. Paste it into VirtualDeck settings and phone mode unlocks.',
  'faq.q3': 'Do I need to install an app on my phone?',
  'faq.a3': 'No. Scan the QR code with your camera and the deck opens in the browser. You can add it to your home screen like an app.',
  'faq.q4': 'Windows says "Windows protected your PC"',
  'faq.a4': 'That is normal for an unsigned indie app. Click "More info" then "Run anyway".',
  'faq.q5': 'How do I cancel my subscription?',
  'faq.a5': 'Anytime, from the link in your purchase receipt. Phone mode stays active until the end of the paid period.',
  'dl.title': 'Ready to try it?',
  'dl.lead': 'Download the installer, run it, and your deck is ready in a minute.',
  'dl.cta': 'Download for Windows',
  'dl.hint': 'Windows 10 and 11 · 64-bit',
  'footer.made': 'Made in France',
};

const FR_EXTRA = {
  'plan.buy': "S'abonner",
  'per.month': '/ mois',
  'per.year': '/ an',
  'sub.yearly': 'Soit {x} / mois',
  'sub.monthly': 'Facturé chaque mois',
  'pf.phoneInf': 'Deck sur téléphone, téléphones illimités',
  'pf.allpc': "Tout ce qu'inclut l'offre Gratuite",
  'pf.support': 'Support prioritaire',
};

// French texts come from the HTML itself, read once at startup.
const FR = { ...FR_EXTRA };
document.querySelectorAll('[data-i18n]').forEach((el) => {
  FR[el.dataset.i18n] = el.textContent;
});

let lang = 'fr';
let billing = 'monthly';

function t(key) {
  return (lang === 'en' ? EN : FR)[key] ?? FR[key] ?? key;
}

function formatPrice(value) {
  return new Intl.NumberFormat(lang === 'en' ? 'en-IE' : 'fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}

function renderPlans() {
  document.querySelectorAll('[data-plan]').forEach((card) => {
    const id = card.dataset.plan;
    const plan = PLANS[id];
    const price = plan[billing];
    card.querySelector('.amount').textContent = formatPrice(price);
    card.querySelector('.per').textContent = t(billing === 'monthly' ? 'per.month' : 'per.year');
    card.querySelector('.plan-sub').textContent =
      billing === 'yearly' ? t('sub.yearly').replace('{x}', formatPrice(price / 12)) : t('sub.monthly');

    const list = card.querySelector('.checks');
    const check = document.querySelector('.checks .icon');
    list.replaceChildren(
      ...PLAN_FEATURES[id].map((key) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = t(key);
        li.append(check.cloneNode(true), label);
        return li;
      }),
    );

    const buy = card.querySelector('.buy');
    const url = plan.checkout[billing];
    const ready = url.startsWith('https://');
    buy.href = ready ? url : '#';
    if (ready) buy.removeAttribute('aria-disabled');
    else buy.setAttribute('aria-disabled', 'true');
    buy.textContent = t(ready ? 'plan.buy' : 'plan.soon');
  });
}

function applyLanguage() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    if (el.classList.contains('buy')) return;
    el.textContent = t(el.dataset.i18n);
  });
  document.getElementById('lang-toggle').textContent = lang === 'fr' ? 'EN' : 'FR';
  renderPlans();
}

function savedLanguage() {
  try {
    return localStorage.getItem('lang');
  } catch {
    return null;
  }
}

document.getElementById('lang-toggle').addEventListener('click', () => {
  lang = lang === 'fr' ? 'en' : 'fr';
  try {
    localStorage.setItem('lang', lang);
  } catch {}
  applyLanguage();
});

document.querySelectorAll('.billing-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    billing = btn.dataset.billing;
    document.querySelectorAll('.billing-btn').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    });
    renderPlans();
  });
});

// GitHub injoignable ou réponse inattendue : le bouton garde la page des versions.
async function linkLatestInstaller() {
  try {
    const res = await fetch(LATEST_RELEASE_API);
    if (!res.ok) return;
    const release = await res.json();
    const asset = (release.assets || []).find((a) => INSTALLER_NAME.test(a.name));
    const url = asset && asset.browser_download_url;
    if (typeof url === 'string' && url.startsWith(INSTALLER_URL_PREFIX)) {
      document.getElementById('download-link').href = url;
    }
  } catch {}
}

document.getElementById('download-link').href = DOWNLOAD_URL;
linkLatestInstaller();
document.getElementById('year').textContent = new Date().getFullYear();

lang = savedLanguage() || (navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en');
applyLanguage();
