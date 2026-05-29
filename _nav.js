// Injecte la navbar, le footer et le sélecteur de langue sur toutes les pages publiques
(function() {
  const curPath = window.location.pathname;
  const inDash  = curPath.includes('/dashboard/');
  const pre     = inDash ? '../' : '';

  const page = curPath.split('/').pop() || 'index.html';
  function active(href) { return page === href.split('/').pop() ? 'nav-link active-link' : 'nav-link'; }
  function activeDrop(pages) { return pages.some(p => page === p) ? 'nav-link dropdown-toggle active-link' : 'nav-link dropdown-toggle'; }

  // ── Dictionnaire de traductions ──────────────────────────────────────────
  var T = {
    fr: {},  // rempli par _lang.js pour les clés courtes (hero.badge, etc.)
    en: {
      'Accueil':'Home', 'Association':'Association', 'À propos':'About Us',
      'Notre équipe':'Our Team', 'Devenir membre':'Join Us',
      'Activités':'Activities', 'Événements':'Events', 'Galerie photos':'Photo Gallery',
      'Communauté':'Community', 'Nos talents':'Our Talents',
      'Petites annonces':'Classifieds', 'Contact':'Contact', 'Connexion':'Login',
      'Découvrir':'Discover', 'Membre':'Member', 'Nous joindre':'Contact Us',
      'Équipe':'Team', 'Confidentialité':'Privacy', 'Galerie':'Gallery',
      'Espace membre':'Member Area', 'Faire un don':'Donate', 'Nous contacter':'Contact Us',
      'Politique de confidentialité':'Privacy Policy',
      'footer-desc':'Haitian Association of Hamilton — A community united in culture and solidarity.',
      'footer-copy':'© 2026 AHH — Association Haïtienne de Hamilton. All rights reserved.',
    },
    ht: {
      'Accueil':'Akèy', 'Association':'Asosyasyon', 'À propos':'Sou nou',
      'Notre équipe':'Ekip nou an', 'Devenir membre':'Vin manm',
      'Activités':'Aktivite', 'Événements':'Evènman', 'Galerie photos':'Galri foto',
      'Communauté':'Kominote', 'Nos talents':'Talan nou yo',
      'Petites annonces':'Piti anonn', 'Contact':'Kontakte', 'Connexion':'Koneksyon',
      'Découvrir':'Dekouvri', 'Membre':'Manm', 'Nous joindre':'Jwenn nou',
      'Équipe':'Ekip', 'Confidentialité':'Konfidansyalite', 'Galerie':'Galri',
      'Espace membre':'Espas manm', 'Faire un don':'Fè yon don', 'Nous contacter':'Kontakte nou',
      'Politique de confidentialité':'Politik konfidansyalite',
      'footer-desc':'Asosyasyon Ayisyen Hamilton — Yon kominote ini nan kilti ak solidarite.',
      'footer-copy':'© 2026 AHH — Asosyasyon Ayisyen Hamilton. Tout dwa rezève.',
    }
  };

  // Merge extended translations from _lang.js if loaded
  if (window.AHH_T) {
    if (window.AHH_T.fr) Object.assign(T.fr, window.AHH_T.fr);
    if (window.AHH_T.en) Object.assign(T.en, window.AHH_T.en);
    if (window.AHH_T.ht) Object.assign(T.ht, window.AHH_T.ht);
  }

  var _lang = localStorage.getItem('ahh_lang') || 'fr';
  var LANG_LABELS = { fr:'FR', en:'EN', ht:'HT' };

  function t(key) {
    var dict = T[_lang];
    if (!dict || !dict[key]) {
      // Fallback : pour FR, cherche dans T.fr, sinon retourne la clé
      return (_lang === 'fr' && T.fr && T.fr[key]) ? T.fr[key] : key;
    }
    return dict[key];
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
      el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });
    // Update label
    var lbl = document.getElementById('pubLangLabel');
    if (lbl) lbl.textContent = LANG_LABELS[_lang] || _lang.toUpperCase();
    // Mark active option
    document.querySelectorAll('.pub-lang-opt').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.lang === _lang);
    });
  }

  function setLang(lang) {
    _lang = lang;
    localStorage.setItem('ahh_lang', lang);
    applyTranslations();
    // Also sync dashboard lang if present
    if (window.AHH_LANG) AHH_LANG.set(lang);
  }

  // ── NAV HTML ─────────────────────────────────────────────────────────────
  var navHTML = `
  <header class="navbar" id="navbar">
    <div class="container nav-inner">

      <!-- Logo -->
      <a href="${pre}index.html" class="logo">
        <img src="${pre}Public/logo1.png" alt="AHH" class="logo-img"/>
        <div class="logo-text-group">
          <span class="logo-sub" style="font-size:.85rem;line-height:1.35">Association<br/>Haïtienne de<br/>Hamilton</span>
        </div>
      </a>

      <!-- Overlay mobile -->
      <div class="nav-overlay" id="navOverlay"></div>

      <!-- Navigation principale -->
      <nav class="nav-links" id="navLinks">
        <!-- Header mobile -->
        <div class="nav-mobile-header">
          <img src="${pre}Public/logo1.png" alt="AHH" class="logo-img" style="width:32px;height:32px"/>
          <span style="color:#fff;font-weight:600;font-size:.75rem">Association Haïtienne de Hamilton</span>
          <button class="nav-close" id="navClose">✕</button>
        </div>

        <a href="${pre}index.html" class="${active('index.html')}" data-i18n="Accueil">Accueil</a>

        <!-- Dropdown : Association -->
        <div class="dropdown">
          <button class="${activeDrop(['equipe.html'])} dropdown-toggle">
            <span data-i18n="Association">Association</span> <span class="dropdown-caret">▾</span>
          </button>
          <div class="dropdown-menu">
            <a href="${pre}equipe.html"   class="${active('equipe.html')}"   data-i18n="Notre équipe">Notre équipe</a>
            <a href="${pre}adhesion.html" class="${active('adhesion.html')}" data-i18n="Devenir membre">Devenir membre</a>
          </div>
        </div>

        <!-- Dropdown : Activités -->
        <div class="dropdown">
          <button class="${activeDrop(['actualites.html','galerie.html'])} dropdown-toggle">
            <span data-i18n="Activités">Activités</span> <span class="dropdown-caret">▾</span>
          </button>
          <div class="dropdown-menu">
            <a href="${pre}actualites.html" class="${active('actualites.html')}" data-i18n="Événements">Événements</a>
            <a href="${pre}galerie.html"    class="${active('galerie.html')}"    data-i18n="Galerie photos">Galerie photos</a>
          </div>
        </div>

        <!-- Dropdown : Communauté -->
        <div class="dropdown">
          <button class="${activeDrop(['talents.html','annonces.html'])} dropdown-toggle">
            <span data-i18n="Communauté">Communauté</span> <span class="dropdown-caret">▾</span>
          </button>
          <div class="dropdown-menu">
            <a href="${pre}talents.html"  class="${active('talents.html')}"  data-i18n="Nos talents">Nos talents</a>
            <a href="${pre}annonces.html" class="${active('annonces.html')}" data-i18n="Petites annonces">Petites annonces</a>
          </div>
        </div>

        <a href="${pre}about.html" class="${active('about.html')}" data-i18n="À propos">À propos</a>
        <a href="${pre}dashboard/login.html" class="btn btn-login" data-i18n="Connexion">Connexion</a>
      </nav>

      <!-- Sélecteur de langue -->
      <div class="pub-lang-selector" id="pubLangSel">
        <button class="pub-lang-btn" id="pubLangBtn" aria-label="Langue">
          🌐 <span id="pubLangLabel">FR</span>
        </button>
        <div class="pub-lang-dropdown" id="pubLangDrop">
          <button class="pub-lang-opt" data-lang="fr">🇫🇷 Français</button>
          <button class="pub-lang-opt" data-lang="en">🇬🇧 English</button>
          <button class="pub-lang-opt" data-lang="ht">🇭🇹 Kreyòl ayisyen</button>
        </div>
      </div>

      <!-- Hamburger -->
      <button class="hamburger" id="hamburger" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </header>`;

  // ── FOOTER ────────────────────────────────────────────────────────────────
  var footerHTML = `
  <footer class="footer">
    <div class="container footer-inner">
      <div class="footer-brand">
        <a href="${pre}index.html" class="logo footer-logo">
          <img src="${pre}Public/logo1.png" alt="AHH" class="logo-img"/>
          <span class="logo-text">AHH</span>
        </a>
        <p data-i18n="footer-desc">Association Haïtienne de Hamilton — Une communauté unie dans la culture et la solidarité.</p>
        <div class="footer-socials">
          <a href="#" class="social-icon" aria-label="Facebook">f</a>
          <a href="#" class="social-icon" aria-label="Instagram">in</a>
          <a href="#" class="social-icon" aria-label="YouTube">▶</a>
        </div>
      </div>
      <div class="footer-links">
        <h5 data-i18n="Association">Association</h5>
        <a href="${pre}about.html"    data-i18n="À propos">À propos</a>
        <a href="${pre}equipe.html"   data-i18n="Équipe">Équipe</a>
        <a href="${pre}adhesion.html" data-i18n="Devenir membre">Devenir membre</a>
        <a href="${pre}privacy.html"  data-i18n="Confidentialité">Confidentialité</a>
      </div>
      <div class="footer-links">
        <h5 data-i18n="Découvrir">Découvrir</h5>
        <a href="${pre}actualites.html" data-i18n="Événements">Événements</a>
        <a href="${pre}galerie.html"    data-i18n="Galerie">Galerie</a>
        <a href="${pre}talents.html"    data-i18n="Nos talents">Nos talents</a>
        <a href="${pre}annonces.html"   data-i18n="Petites annonces">Petites annonces</a>
      </div>
      <div class="footer-links">
        <h5 data-i18n="Membre">Membre</h5>
        <a href="${pre}dashboard/login.html" data-i18n="Espace membre">Espace membre</a>
        <a href="https://donate.stripe.com/fZe9CTg1Oh0qehacMM" target="_blank" rel="noopener" data-i18n="Faire un don">Faire un don</a>
        <a href="${pre}index.html#contact"   data-i18n="Nous contacter">Nous contacter</a>
      </div>
      <div class="footer-contact">
        <h5 data-i18n="Nous joindre">Nous joindre</h5>
        <p>231 Fernwood Crescent<br/>Hamilton, ON  L8T 3L7</p>
        <p><a href="tel:9058188269">905-818-8269</a></p>
        <p><a href="tel:9055197967">905-519-7967</a></p>
        <p><a href="mailto:info@ahhamilton.ca">info@ahhamilton.ca</a></p>
      </div>
    </div>
    <div class="footer-bottom">
      <div class="container footer-bottom-inner">
        <p data-i18n="footer-copy">© 2026 AHH — Association Haïtienne de Hamilton. Tous droits réservés.</p>
        <p><a href="${pre}privacy.html" style="color:rgba(255,255,255,.45)" data-i18n="Politique de confidentialité">Politique de confidentialité</a></p>
      </div>
    </div>
  </footer>`;

  // ── Injection ─────────────────────────────────────────────────────────────
  document.body.insertAdjacentHTML('afterbegin', navHTML);
  if (!document.querySelector('footer.footer')) {
    document.body.insertAdjacentHTML('beforeend', footerHTML);
  }

  // Appliquer la langue sauvegardée au chargement
  applyTranslations();

  // ── Hamburger mobile ──────────────────────────────────────────────────────
  var ham = document.getElementById('hamburger');
  var nav = document.getElementById('navLinks');
  var ov  = document.getElementById('navOverlay');
  var cl  = document.getElementById('navClose');

  function openNav()  { nav.classList.add('open'); ham.classList.add('active'); ov.classList.add('show'); document.body.style.overflow='hidden'; }
  function closeNav() { nav.classList.remove('open'); ham.classList.remove('active'); ov.classList.remove('show'); document.body.style.overflow=''; }

  ham && ham.addEventListener('click', function() { nav.classList.contains('open') ? closeNav() : openNav(); });
  cl  && cl.addEventListener('click', closeNav);
  ov  && ov.addEventListener('click', closeNav);

  nav && nav.querySelectorAll('a:not(.dropdown-menu a)').forEach(function(a) { a.addEventListener('click', closeNav); });

  // ── Dropdowns desktop (hover) / mobile (click) ────────────────────────────
  document.querySelectorAll('.dropdown').forEach(function(dd) {
    var toggle = dd.querySelector('.dropdown-toggle');
    var menu   = dd.querySelector('.dropdown-menu');

    dd.addEventListener('mouseenter', function() { if (window.innerWidth > 768) menu.classList.add('open'); });
    dd.addEventListener('mouseleave', function() { if (window.innerWidth > 768) menu.classList.remove('open'); });

    toggle && toggle.addEventListener('click', function(e) {
      if (window.innerWidth <= 768) { e.stopPropagation(); menu.classList.toggle('open'); }
    });

    menu && menu.querySelectorAll('a').forEach(function(a) {
      a.addEventListener('click', function() { menu.classList.remove('open'); closeNav(); });
    });
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.dropdown')) {
      document.querySelectorAll('.dropdown-menu.open').forEach(function(m) { m.classList.remove('open'); });
    }
  });

  // ── Scroll navbar ──────────────────────────────────────────────────────────
  var navbar = document.getElementById('navbar');
  function updateNav() { navbar && navbar.classList.toggle('scrolled', window.scrollY > 40); }
  window.addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  // ── Sélecteur de langue ────────────────────────────────────────────────────
  var langSel  = document.getElementById('pubLangSel');
  var langBtn  = document.getElementById('pubLangBtn');
  var langDrop = document.getElementById('pubLangDrop');

  langBtn && langBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    langSel.classList.toggle('open');
  });

  document.querySelectorAll('.pub-lang-opt').forEach(function(btn) {
    btn.addEventListener('click', function() {
      setLang(btn.dataset.lang);
      langSel.classList.remove('open');
    });
  });

  document.addEventListener('click', function(e) {
    if (!langSel.contains(e.target)) langSel.classList.remove('open');
  });
})();
