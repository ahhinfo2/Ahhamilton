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
waBtn.href      = 'https://wa.me/19058188269';
waBtn.target    = '_blank';
waBtn.rel       = 'noopener';
waBtn.title     = 'Nous écrire sur WhatsApp';
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
