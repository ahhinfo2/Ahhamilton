// ══════════════════════════════════════════════════════════
// BANNIÈRE HORS-LIGNE + NOTIFICATION MISE À JOUR PWA
// ══════════════════════════════════════════════════════════
(function() {
  var offlineBanner = document.createElement('div');
  offlineBanner.id = 'offlineBanner';
  offlineBanner.textContent = 'Vous êtes hors ligne — certaines fonctions sont limitées.';
  offlineBanner.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:99999;background:#e65100;color:#fff;text-align:center;padding:10px 16px;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  document.body.prepend(offlineBanner);
  function checkOnline() { offlineBanner.style.display = navigator.onLine ? 'none' : 'block'; }
  window.addEventListener('online', checkOnline);
  window.addEventListener('offline', checkOnline);
  checkOnline();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'SW_UPDATED') {
        var bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#1b5e20;color:#fff;text-align:center;padding:12px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 -2px 8px rgba(0,0,0,.3)';
        bar.innerHTML = 'Nouvelle version disponible — <u>cliquez pour recharger</u>';
        bar.onclick = function() { location.reload(); };
        document.body.appendChild(bar);
      }
    });
  }
})();

// ══════════════════════════════════════════════════════════
// PAGE TRANSITION – fondu à l'entrée
// ══════════════════════════════════════════════════════════
document.documentElement.style.opacity = '0';
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.style.transition = 'opacity .45s ease';
  requestAnimationFrame(() => { document.documentElement.style.opacity = '1'; });
});

document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto') || href.startsWith('tel')) return;
  e.preventDefault();
  document.documentElement.style.opacity = '0';
  setTimeout(() => { location.href = href; }, 420);
});

// ══════════════════════════════════════════════════════════
// BARRE DE PROGRESSION (scroll)
// ══════════════════════════════════════════════════════════
const progressBar = document.createElement('div');
progressBar.id = 'scrollProgress';
document.body.prepend(progressBar);

// ══════════════════════════════════════════════════════════
// BOUTON RETOUR EN HAUT
// ══════════════════════════════════════════════════════════
const backTop = document.createElement('button');
backTop.id        = 'backTop';
backTop.innerHTML = '↑';
backTop.title     = 'Retour en haut';
backTop.onclick   = () => window.scrollTo({ top: 0, behavior: 'smooth' });
document.body.appendChild(backTop);

// ══════════════════════════════════════════════════════════
// BOUTON WHATSAPP
// ══════════════════════════════════════════════════════════
const waBtn = document.createElement('a');
waBtn.id        = 'whatsappBtn';
waBtn.href      = 'https://wa.me/12489622073?text=' + encodeURIComponent("Bonjour M. Jean Raymond, j'aimerais rejoindre le groupe whats'App de l'Association Haïtienne de Hamilton");
waBtn.target    = '_blank';
waBtn.rel       = 'noopener';
waBtn.title     = 'Rejoindre le groupe WhatsApp';
waBtn.innerHTML = `<svg viewBox="0 0 32 32" width="28" height="28" fill="currentColor">
  <path d="M16 2C8.28 2 2 8.28 2 16c0 2.46.65 4.8 1.8 6.82L2 30l7.36-1.77A13.93 13.93 0 0016 30c7.72 0 14-6.28 14-14S23.72 2 16 2zm0 25.5a11.44 11.44 0 01-5.82-1.59l-.42-.25-4.36 1.05 1.08-4.24-.28-.44A11.5 11.5 0 1116 27.5zm6.34-8.62c-.35-.17-2.06-1.01-2.38-1.13-.32-.12-.55-.17-.78.17-.23.35-.9 1.13-1.1 1.36-.2.23-.41.26-.76.09-.35-.17-1.48-.54-2.81-1.73-1.04-.92-1.74-2.06-1.94-2.41-.2-.35-.02-.54.15-.71.15-.15.35-.4.52-.6.17-.2.23-.35.35-.58.12-.23.06-.43-.03-.6-.09-.17-.78-1.88-1.07-2.58-.28-.68-.56-.59-.78-.6h-.66c-.23 0-.6.09-.91.43-.32.35-1.2 1.17-1.2 2.86s1.23 3.32 1.4 3.55c.17.23 2.42 3.7 5.87 5.19.82.35 1.46.56 1.96.72.82.26 1.57.22 2.16.13.66-.1 2.06-.84 2.35-1.66.29-.81.29-1.51.2-1.66-.08-.15-.31-.24-.66-.41z"/>
</svg>`;
document.body.appendChild(waBtn);

// ══════════════════════════════════════════════════════════
// SCROLL EVENTS (progress, back-to-top)
// navbar scroll géré par _nav.js
// ══════════════════════════════════════════════════════════
window.addEventListener('scroll', () => {
  const scrolled = window.scrollY;
  const total    = document.documentElement.scrollHeight - window.innerHeight;
  progressBar.style.width = total > 0 ? (scrolled / total) * 100 + '%' : '0%';
  backTop.classList.toggle('visible', scrolled > 400);
}, { passive: true });

// Hamburger géré par _nav.js

// ══════════════════════════════════════════════════════════
// COUNTER ANIMATION
// ══════════════════════════════════════════════════════════
function animateCounter(el) {
  const target   = parseInt(el.dataset.target, 10);
  const duration = 2000;
  const steps    = 60;
  let   current  = 0;
  const inc      = target / steps;
  const timer = setInterval(() => {
    current = Math.min(current + inc, target);
    el.textContent = Math.floor(current) + (current >= target ? '+' : '');
    if (current >= target) clearInterval(timer);
  }, duration / steps);
}

const counters = document.querySelectorAll('.stat-number');
const counterObs = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { animateCounter(e.target); counterObs.unobserve(e.target); } });
}, { threshold: 0.5 });
counters.forEach(c => counterObs.observe(c));

// ══════════════════════════════════════════════════════════
// SCROLL REVEAL (sections et cartes)
// ══════════════════════════════════════════════════════════
const revealSelectors = [
  '[data-reveal]',
  '.pillar-card', '.team-card-full', '.donation-card',
  '.contact-info', '.contact-form',
  '.section-header', '.footer-brand'
];

const revealObs = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      const delay = entry.target.dataset.delay || (i * 100);
      setTimeout(() => entry.target.classList.add('revealed'), parseInt(delay));
      revealObs.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll(revealSelectors.join(',')).forEach((el, i) => {
  el.classList.add('reveal-ready');
  el.dataset.delay = el.dataset.delay || (i % 4) * 120;
  revealObs.observe(el);
});

// ══════════════════════════════════════════════════════════
// WHATSAPP TOOLTIP (first visit)
// ══════════════════════════════════════════════════════════
(function() {
  if (sessionStorage.getItem('ahh_wa_shown')) return;
  sessionStorage.setItem('ahh_wa_shown', '1');
  var tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;bottom:90px;right:24px;background:#1b5e20;color:#fff;padding:10px 18px;border-radius:12px;font-size:.82rem;font-weight:600;z-index:999;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transition:opacity .4s;pointer-events:none';
  tip.textContent = 'Rejoignez notre groupe WhatsApp !';
  document.body.appendChild(tip);
  setTimeout(function() { tip.style.opacity = '1'; }, 2000);
  setTimeout(function() { tip.style.opacity = '0'; }, 7000);
  setTimeout(function() { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 8000);
})();

// ══════════════════════════════════════════════════════════
// CARROUSEL DE TÉMOIGNAGES
// ══════════════════════════════════════════════════════════
function initCarousel() {
  const carousel = document.getElementById('testimonialCarousel');
  if (!carousel) return;

  const slides  = carousel.querySelectorAll('.carousel-slide');
  const dotsEl  = document.getElementById('carouselDots');
  let   current = 0;
  let   timer;

  // Créer les points
  slides.forEach((_, i) => {
    const d = document.createElement('button');
    d.className = 'carousel-dot' + (i === 0 ? ' active' : '');
    d.onclick   = () => goTo(i);
    dotsEl.appendChild(d);
  });

  function goTo(idx) {
    slides[current].classList.remove('active');
    dotsEl.children[current].classList.remove('active');
    current = (idx + slides.length) % slides.length;
    slides[current].classList.add('active');
    dotsEl.children[current].classList.add('active');
    resetTimer();
  }

  function resetTimer() {
    clearInterval(timer);
    timer = setInterval(() => goTo(current + 1), 5000);
  }

  slides[0].classList.add('active');

  document.getElementById('carouselPrev')?.addEventListener('click', () => goTo(current - 1));
  document.getElementById('carouselNext')?.addEventListener('click', () => goTo(current + 1));

  // Swipe mobile
  let startX = 0;
  carousel.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  carousel.addEventListener('touchend',   e => {
    const diff = startX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) goTo(current + (diff > 0 ? 1 : -1));
  });

  resetTimer();
}
initCarousel();

// ══════════════════════════════════════════════════════════
// LIGHTBOX GALERIE
// ══════════════════════════════════════════════════════════
function initLightbox() {
  const items = document.querySelectorAll('.gallery-item[data-label]');
  if (!items.length) return;

  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.innerHTML = `
    <div class="lb-backdrop"></div>
    <div class="lb-content">
      <button class="lb-close" id="lbClose">✕</button>
      <button class="lb-nav lb-prev" id="lbPrev">‹</button>
      <div class="lb-display" id="lbDisplay"></div>
      <button class="lb-nav lb-next" id="lbNext">›</button>
      <div class="lb-caption" id="lbCaption"></div>
      <div class="lb-counter" id="lbCounter"></div>
    </div>`;
  document.body.appendChild(lb);

  let current = 0;
  const list  = [...items];

  function open(idx) {
    current = idx;
    const item = list[idx];
    const emoji = item.querySelector('.gallery-placeholder')?.textContent || '🖼️';
    const label = item.dataset.label || '';
    const bg    = item.style.background || 'linear-gradient(135deg,#1b5e20,#43a047)';

    document.getElementById('lbDisplay').innerHTML =
      `<div class="lb-placeholder" style="background:${bg}">${emoji}</div>`;
    document.getElementById('lbCaption').textContent  = label;
    document.getElementById('lbCounter').textContent  = `${idx + 1} / ${list.length}`;
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() { lb.classList.remove('open'); document.body.style.overflow = ''; }
  function prev()  { open((current - 1 + list.length) % list.length); }
  function next()  { open((current + 1) % list.length); }

  list.forEach((item, i) => {
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => open(i));
  });

  document.getElementById('lbClose').onclick = close;
  document.getElementById('lbPrev').onclick  = prev;
  document.getElementById('lbNext').onclick  = next;
  lb.querySelector('.lb-backdrop').onclick   = close;

  document.addEventListener('keydown', e => {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape')     close();
    if (e.key === 'ArrowLeft')  prev();
    if (e.key === 'ArrowRight') next();
  });

  // Swipe mobile
  let sx = 0;
  lb.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend',   e => {
    const d = sx - e.changedTouches[0].clientX;
    if (Math.abs(d) > 50) d > 0 ? next() : prev();
  });
}
initLightbox();

// ══════════════════════════════════════════════════════════
// CONTACT FORM
// ══════════════════════════════════════════════════════════
const contactForm = document.getElementById('contactForm');
if (contactForm) {
  contactForm.addEventListener('submit', e => {
    e.preventDefault();
    const btn = contactForm.querySelector('button[type="submit"]');
    btn.textContent = '✓ Message envoyé!';
    btn.style.background = 'linear-gradient(135deg,#1b5e20,#43a047)';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = 'Envoyer le message';
      btn.style.background = '';
      btn.disabled = false;
      contactForm.reset();
    }, 3500);
  });
}

// ══════════════════════════════════════════════════════════
// AUTO-REFRESH — mise à jour automatique sans rafraîchir
// Toutes les sections dynamiques se mettent à jour seules
// ══════════════════════════════════════════════════════════
(function autoRefresh() {
  const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001/api' : '/api';
  const BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001' : '';

  // Signature JSON pour détecter les changements
  function sig(obj) { return JSON.stringify(obj); }

  // ── Registre des watchers actifs ──────────────────────────
  const watchers = [];

  function watch(endpoint, intervalMs, onUpdate, { runNow = false } = {}) {
    let lastSig = null;
    async function check() {
      try {
        const r = await fetch(API + endpoint, { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        const s = sig(data);
        if (s !== lastSig) {
          lastSig = s;
          onUpdate(data);
        }
      } catch(e) {}
    }
    if (runNow) check();
    const id = setInterval(check, intervalMs);
    watchers.push(id);
  }

  // ── À la une (index.html) ─────────────────────────────────
  if (document.getElementById('featured-activity')) {
    watch('/activities/featured', 30000, function(act) {
      const sec = document.getElementById('featured-activity');
      if (!act) { sec.style.display = 'none'; return; }
      sec.style.display = 'block';
      document.getElementById('featured-titre').textContent = act.titre;
      const meta = [];
      if (act.date_debut) meta.push('📅 ' + new Date(act.date_debut).toLocaleDateString('fr-CA', {weekday:'long',day:'numeric',month:'long',year:'numeric'}));
      if (act.lieu) meta.push('📍 ' + act.lieu);
      if (act.prix > 0) meta.push('💳 ' + act.prix.toFixed(2) + ' $');
      else meta.push('✅ Entrée libre');
      document.getElementById('featured-meta').innerHTML = meta.join('&nbsp;·&nbsp;');
      if (act.description) {
        var descEl = document.getElementById('featured-desc');
        var tmp = document.createElement('div'); tmp.innerHTML = act.description;
        var plain = tmp.textContent || tmp.innerText || '';
        if (plain.length <= 300) { descEl.innerHTML = act.description; }
        else { descEl.textContent = plain.substring(0, 240) + '...'; }
      }
      const imgDiv = document.getElementById('featured-img');
      if (act.flyer) imgDiv.innerHTML = '<img src="' + BASE + act.flyer + '" alt="' + act.titre + '" style="width:100%;max-width:380px;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);object-fit:cover;aspect-ratio:3/4;display:block">';
      const btn = document.getElementById('featured-btn');
      if (act.paiement_requis && act.prix > 0) { btn.href = 'billets.html?id=' + act.id; btn.textContent = '🎟️ Acheter un billet : ' + act.prix.toFixed(2) + ' $'; }
      else if (act.qr_token) { btn.href = 'activity-checkout.html?actid=' + act.id + '&token=' + act.qr_token; btn.textContent = '✅ Confirmer ma présence'; }
      else { btn.href = 'dashboard/login.html'; btn.textContent = '👤 S\'inscrire'; }
    }, { runNow: true });
  }

  // ── Activités publiques (actualites.html) ─────────────────
  if (document.getElementById('activites-grid') || document.getElementById('acts-container')) {
    watch('/activities/public', 45000, function(acts) {
      const el = document.getElementById('activites-grid') || document.getElementById('acts-container');
      if (!el || !acts.length) return;
      // Déclencher la fonction de rendu si elle existe
      if (typeof renderActivites === 'function') renderActivites(acts);
      else if (typeof renderActs === 'function') renderActs(acts);
    });
  }

  // ── Annonces publiques (annonces.html) ────────────────────
  if (document.getElementById('annonces-grid') || document.getElementById('annonces-container')) {
    watch('/annonces/public', 45000, function(data) {
      if (typeof renderAnnonces === 'function') renderAnnonces(data);
    });
  }

  // ── Talents (talents.html) ────────────────────────────────
  if (document.getElementById('talents-grid') || document.getElementById('talents-container')) {
    watch('/talents/public', 60000, function(data) {
      if (typeof renderTalents === 'function') renderTalents(data);
    });
  }

  // ── Stats (index.html) ───────────────────────────────────
  if (document.getElementById('stat-membres')) {
    watch('/stats/public', 60000, function(s) {
      // Membres actifs : respect du show_membres
      var elM = document.getElementById('stat-membres');
      if (elM) {
        if (s.show_membres === 0 || s.show_membres === false) {
          var row = elM.closest('.stat-item'); if (row) row.style.display = 'none';
        } else {
          var row2 = elM.closest('.stat-item'); if (row2) row2.style.display = '';
          elM.textContent = s.membres + '+';
          elM.setAttribute('data-target', s.membres);
        }
      }
      // Heures bénévolat : respect du show_benevoles
      var elB = document.getElementById('stat-benevoles');
      if (elB) {
        if (s.show_benevoles === 0 || s.show_benevoles === false) {
          var rowB = elB.closest('.stat-item'); if (rowB) rowB.style.display = 'none';
        } else {
          var rowB2 = elB.closest('.stat-item'); if (rowB2) rowB2.style.display = '';
          elB.textContent = s.benevoles + '+';
          elB.setAttribute('data-target', s.benevoles);
        }
      }
      // Activités et années (toujours visibles)
      var elA = document.getElementById('stat-activites'); if (elA) { elA.textContent = s.activites + '+'; }
      var elAn = document.getElementById('stat-annees'); if (elAn) { elAn.textContent = s.annees + '+'; }
    }, { runNow: true });
  }

  // ── Galerie (galerie.html) ────────────────────────────────
  if (document.getElementById('galerie-grid') || document.getElementById('gallery-grid')) {
    watch('/gallery/public', 60000, function(data) {
      if (typeof renderGallery === 'function') renderGallery(data);
    });
  }

})();

// ══════════════════════════════════════════════════════════
// #3  MODE SOMBRE — toggle + localStorage
// ══════════════════════════════════════════════════════════
(function() {
  var btn = document.createElement('button');
  btn.id = 'darkToggle';
  btn.title = 'Mode sombre';
  btn.textContent = '🌙';
  btn.onclick = function() {
    var isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('ahh_dark', isDark ? '1' : '0');
    btn.textContent = isDark ? '☀️' : '🌙';
  };
  document.body.appendChild(btn);
  if (localStorage.getItem('ahh_dark') === '1') {
    document.documentElement.classList.add('dark');
    btn.textContent = '☀️';
  }
})();

// ══════════════════════════════════════════════════════════
// #13 CONFETTIS HAÏTIENS (canvas flottants dans le hero)
// ══════════════════════════════════════════════════════════
(function initConfetti() {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'confetti-canvas';
  hero.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const COLORS = ['#003F87','#D21034','#ffffff','#f9a825','#003F87','#D21034'];
  let particles = [];
  let W, H, raf;

  function resize() {
    W = canvas.width  = hero.offsetWidth;
    H = canvas.height = hero.offsetHeight;
  }

  function spawn() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: 2 + Math.random() * 3,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      vx: (Math.random() - .5) * .4,
      vy: -.2 - Math.random() * .5,
      life: 0,
      maxLife: 220 + Math.random() * 180,
    };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (particles.length < 45) particles.push(spawn());

    particles = particles.filter(p => p.life < p.maxLife);
    particles.forEach(p => {
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -10) { p.y = H + 4; p.x = Math.random() * W; }
      const alpha = Math.sin((p.life / p.maxLife) * Math.PI) * .55;
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });
  // Ne lancer que si l'utilisateur ne préfère pas les mouvements réduits
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // Pré-remplir
    for (let i = 0; i < 40; i++) { const p = spawn(); p.life = Math.random() * p.maxLife; particles.push(p); }
    draw();
  }
})();

// ══════════════════════════════════════════════════════════
// #16 COUNTDOWN — prochain événement
// ══════════════════════════════════════════════════════════
(function initCountdown() {
  const bar = document.getElementById('countdownBar');
  if (!bar) return;
  const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001/api' : '/api';

  let targetDate = null;
  let eventName  = '';
  let cdTimer    = null;

  function pad(n) { return String(n).padStart(2, '0'); }

  function tick() {
    if (!targetDate) return;
    const diff = targetDate - Date.now();
    if (diff <= 0) { bar.style.display = 'none'; return; }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    const numEl = bar.querySelectorAll('.cd-num');
    if (numEl.length === 4) {
      numEl[0].textContent = pad(d);
      numEl[1].textContent = pad(h);
      numEl[2].textContent = pad(m);
      numEl[3].textContent = pad(s);
    }
  }

  // Charger la config countdown du comité
  Promise.all([
    fetch(API + '/countdown').then(function(r) { return r.ok ? r.json() : {}; }).catch(function() { return {}; }),
    fetch(API + '/activities/featured').then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
    fetch(API + '/activities/public').then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; })
  ]).then(function(results) {
    var cfg = results[0] || {};
    var featured = results[1];
    var acts = results[2];
    var now = Date.now();

    // Si le comité a désactivé le countdown
    if (cfg.actif === false) { bar.style.display = 'none'; return; }

    // Mode manuel : texte et date définis par le comité
    if (!cfg.auto && cfg.texte && cfg.date) {
      targetDate = new Date(cfg.date).getTime();
      eventName = cfg.texte;
    } else {
      // Mode auto : featured en priorité, sinon prochaine activité
      var chosen = null;
      if (featured && featured.date_debut && new Date(featured.date_debut) > now) {
        chosen = featured;
      }
      if (!chosen) {
        chosen = acts
          .filter(function(a) { return a.date_debut && new Date(a.date_debut) > now; })
          .sort(function(a, b) { return new Date(a.date_debut) - new Date(b.date_debut); })[0];
      }
      if (!chosen) { bar.style.display = 'none'; return; }
      targetDate = new Date(chosen.date_debut).getTime();
      eventName = chosen.titre;
    }

    var nameEl = bar.querySelector('.countdown-event');
    if (nameEl) nameEl.textContent = eventName;
    bar.style.display = '';
    tick();
    cdTimer = setInterval(tick, 1000);
  }).catch(function() { bar.style.display = 'none'; });
})();

// ══════════════════════════════════════════════════════════
// #15 RECHERCHE UNIVERSELLE (Ctrl+K / ⌘K)
// ══════════════════════════════════════════════════════════
(function initSearch() {
  const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001/api' : '/api';

  // Créer le modal
  const overlay = document.createElement('div');
  overlay.id = 'searchOverlay';
  overlay.innerHTML = `
    <div class="search-modal" id="searchModal" role="dialog" aria-label="Recherche">
      <div class="search-header">
        <span class="search-icon">🔍</span>
        <input id="searchInput" type="text" placeholder="Rechercher activités, pages, membres…" autocomplete="off"/>
        <div class="search-kbd"><kbd>Esc</kbd> fermer</div>
      </div>
      <div class="search-results" id="searchResults"></div>
      <div class="search-footer">
        <span>↑↓ naviguer</span>
        <span>↵ ouvrir</span>
        <span><kbd>Ctrl</kbd><kbd>K</kbd> ouvrir</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input   = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');

  const PAGES = [
    { title: 'Accueil', sub: 'Page principale', url: '/index.html', icon: '🏠' },
    { title: 'Activités', sub: 'Événements et ateliers', url: '/actualites.html', icon: '📅' },
    { title: 'Galerie', sub: 'Photos de nos événements', url: '/galerie.html', icon: '🖼️' },
    { title: 'Notre équipe', sub: 'Membres du conseil', url: '/equipe.html', icon: '👥' },
    { title: 'Adhésion', sub: 'Rejoindre l\'AHH', url: '/adhesion.html', icon: '🤝' },
    { title: 'Annonces', sub: 'Nouvelles et annonces', url: '/annonces.html', icon: '📢' },
    { title: 'Talents', sub: 'Répertoire des talents', url: '/talents.html', icon: '✨' },
    { title: 'Contact', sub: 'Nous joindre', url: '/index.html#contact', icon: '✉️' },
    { title: 'Faire un don', sub: 'Soutenir la communauté', url: '/index.html#don', icon: '💛' },
    { title: 'Mon espace', sub: 'Tableau de bord membre', url: '/dashboard/app.html', icon: '🔐' },
  ];

  let acts = [], active = 0;

  fetch(API + '/activities/public').then(r => r.ok ? r.json() : []).then(d => { acts = d; }).catch(() => {});

  function open() {
    overlay.classList.add('open');
    setTimeout(() => input.focus(), 50);
    render('');
  }
  function close() {
    overlay.classList.remove('open');
    input.value = '';
    results.innerHTML = '';
  }

  function render(q) {
    q = q.toLowerCase().trim();
    const pageHits = PAGES.filter(p => p.title.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q));
    const actHits  = acts.filter(a => a.titre && a.titre.toLowerCase().includes(q)).slice(0, 5);
    const all = [
      ...pageHits.map(p => ({ title: p.title, sub: p.sub, url: p.url, icon: p.icon, type: 'page' })),
      ...actHits.map(a => ({
        title: a.titre,
        sub: a.date_debut ? '📅 ' + new Date(a.date_debut).toLocaleDateString('fr-CA') : 'Activité',
        url: 'actualites.html',
        icon: '🎭', type: 'activity',
      })),
    ].slice(0, 10);

    if (!all.length) {
      results.innerHTML = '<div class="search-empty">Aucun résultat pour "' + q + '"</div>';
      return;
    }
    results.innerHTML = all.map((item, i) => `
      <a class="search-result-item${i === 0 ? ' active' : ''}" href="${item.url}">
        <div class="search-result-icon ${item.type}">${item.icon}</div>
        <div>
          <div class="search-result-title">${item.title}</div>
          <div class="search-result-sub">${item.sub}</div>
        </div>
      </a>`).join('');
    active = 0;
  }

  input.addEventListener('input', () => { render(input.value); active = 0; });

  // Keyboard nav
  overlay.addEventListener('keydown', e => {
    const items = results.querySelectorAll('.search-result-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[active]?.classList.remove('active'); active = (active + 1) % items.length; items[active]?.classList.add('active'); items[active]?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); items[active]?.classList.remove('active'); active = (active - 1 + items.length) % items.length; items[active]?.classList.add('active'); items[active]?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter')     { items[active]?.click(); }
    if (e.key === 'Escape')    { close(); }
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); overlay.classList.contains('open') ? close() : open(); }
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  // Bouton loupe (optionnel, injecté dans la navbar)
  document.addEventListener('DOMContentLoaded', () => {
    const navInner = document.querySelector('.nav-inner');
    if (!navInner) return;
    const btn = document.createElement('button');
    btn.id = 'searchTrigger';
    btn.title = 'Recherche (Ctrl+K)';
    btn.textContent = '🔍';
    btn.style.cssText = 'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;cursor:pointer;transition:.2s;margin-left:4px;';
    btn.onclick = open;
    navInner.appendChild(btn);
  });
})();

// ══════════════════════════════════════════════════════════
// #24 INDICATEUR SECTION ACTIVE (IntersectionObserver)
// ══════════════════════════════════════════════════════════
(function initNavIndicator() {
  const sections = document.querySelectorAll('section[id], .hero[id]');
  if (!sections.length) return;

  const navLinks = document.querySelectorAll('.nav-link[href*="#"], .nav-link[data-section]');

  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const id = entry.target.id;
      navLinks.forEach(link => {
        const href = link.getAttribute('href') || '';
        link.classList.toggle('nav-section-active', href.includes('#' + id) || link.dataset.section === id);
      });
    });
  }, { threshold: 0.4, rootMargin: '-80px 0px -40% 0px' });

  sections.forEach(s => obs.observe(s));
})();

// ══════════════════════════════════════════════════════════
// #29 MÉTÉO HAMILTON (Open-Meteo — sans clé API)
// ══════════════════════════════════════════════════════════
(function initMeteo() {
  const widget = document.getElementById('meteoWidget');
  if (!widget) return;

  const ICONS = {
    0:'☀️',1:'🌤',2:'⛅',3:'☁️',45:'🌫',48:'🌫',
    51:'🌦',53:'🌦',55:'🌧',61:'🌧',63:'🌧',65:'🌧',
    71:'🌨',73:'🌨',75:'❄️',80:'🌧',81:'🌧',82:'⛈',
    95:'⛈',96:'⛈',99:'⛈',
  };

  fetch('https://api.open-meteo.com/v1/forecast?latitude=43.26&longitude=-79.87&current_weather=true&temperature_unit=celsius&timezone=America%2FToronto')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data?.current_weather) return;
      const { temperature, weathercode } = data.current_weather;
      const icon = ICONS[weathercode] || '🌡';
      widget.innerHTML = `<span class="meteo-icon">${icon}</span><span>Hamilton</span><span class="meteo-temp">${Math.round(temperature)}°C</span>`;
      widget.style.display = '';
    })
    .catch(() => { widget.style.display = 'none'; });
})();

// ══════════════════════════════════════════════════════════
// #12 PARALLAX MULTICOUCHE (hero)
// ══════════════════════════════════════════════════════════
(function initParallax() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const overlay  = document.querySelector('.hero-overlay');
  const bg       = document.querySelector('.hero-photo-bg');
  if (!bg) return;

  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > window.innerHeight) return;
    bg.style.transform      = `translateY(${y * 0.28}px)`;
    if (overlay) overlay.style.transform = `translateY(${y * 0.12}px)`;
  }, { passive: true });
})();

// ══════════════════════════════════════════════════════════
// #26 FAQ ACCORDION
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.faq-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const wasOpen = item.classList.contains('open');
      // Fermer tous
      document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  // Spring reveal sur nouveaux éléments
  document.querySelectorAll('[data-spring]').forEach(el => {
    el.classList.add('reveal-spring');
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { setTimeout(() => e.target.classList.add('revealed'), parseInt(e.target.dataset.delay || 0)); obs.unobserve(e.target); } });
    }, { threshold: 0.12 });
    obs.observe(el);
  });

  // Mobile horizontal scroll pour activités
  const feedGrid = document.getElementById('feedGrid');
  if (feedGrid) feedGrid.classList.add('hscroll-mobile');
});

// ══════════════════════════════════════════════════════════
// CHATBOT WIDGET
// ══════════════════════════════════════════════════════════
(function() {
  var BASE_API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001/api' : '/api';
  var chatOpen = false;
  var wrap = document.createElement('div');
  wrap.id = 'ahhChat';
  wrap.innerHTML = '<button id="chatBtn" aria-label="Ouvrir l\'assistant AHH" style="position:fixed;bottom:96px;right:22px;z-index:997;width:48px;height:48px;border-radius:50%;border:none;background:#1b5e20;color:#fff;font-size:1.2rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:.3s" onclick="toggleChat()">💬</button>' +
    '<div id="chatBox" style="display:none;position:fixed;bottom:155px;right:22px;width:340px;max-width:calc(100vw - 40px);height:400px;background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.2);z-index:997;flex-direction:column;overflow:hidden">' +
      '<div style="background:#1b5e20;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center"><div><strong>Assistant AHH</strong><br><span style=font-size:.75rem;opacity:.7>Posez-moi une question !</span></div><button onclick="toggleChat()" aria-label="Fermer l\'assistant" style="background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer">✕</button></div>' +
      '<div id="chatMessages" role="log" aria-live="polite" aria-label="Conversation avec l\'assistant" style="flex:1;overflow-y:auto;padding:14px;font-size:.85rem"></div>' +
      '<div style="padding:10px;border-top:1px solid #eee;display:flex;gap:6px"><label for="chatInput" class="sr-only">Votre question</label><input id="chatInput" placeholder="Votre question..." style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:.85rem" onkeydown="if(event.key===\'Enter\')sendChat()"/><button onclick="sendChat()" aria-label="Envoyer" style="background:#1b5e20;color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:600">→</button></div>' +
    '</div>';
  document.body.appendChild(wrap);

  window.toggleChat = function() {
    var box = document.getElementById('chatBox');
    chatOpen = !chatOpen;
    box.style.display = chatOpen ? 'flex' : 'none';
    if (chatOpen && !box.dataset.init) {
      box.dataset.init = '1';
      addMsg('bot', 'Bonjour ! 👋 Je suis l\'assistant de l\'AHH. Comment puis-je vous aider ?');
    }
  };

  function addMsg(who, text) {
    var div = document.getElementById('chatMessages');
    var m = document.createElement('div');
    m.style.cssText = 'margin-bottom:10px;padding:8px 12px;border-radius:12px;max-width:85%;font-size:.84rem;line-height:1.5;' + (who === 'bot' ? 'background:#e8f5e9;color:#1a2e1a;margin-right:auto' : 'background:#1b5e20;color:#fff;margin-left:auto');
    // Les réponses du bot sont du HTML de confiance (liens/mise en forme écrits en dur côté
    // serveur, jamais du contenu utilisateur reflété) — mais ce que la personne tape elle-même
    // ne doit jamais être interprété comme HTML.
    if (who === 'bot') m.innerHTML = text; else m.textContent = text;
    div.appendChild(m);
    div.scrollTop = div.scrollHeight;
  }

  window.sendChat = function() {
    var input = document.getElementById('chatInput');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    addMsg('user', msg);
    fetch(BASE_API + '/chatbot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) })
      .then(function(r) { return r.json(); })
      .then(function(d) { addMsg('bot', d.reply || 'Désolé, une erreur est survenue.'); })
      .catch(function() { addMsg('bot', 'Erreur de connexion. Réessayez plus tard.'); });
  };
})();
