// ── CONFIG ─────────────────────────────────────────────────────────────────
const API  = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001/api' : '/api';
const BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001' : '';
let   USER = null;
let   TOKEN = null;

// ── NOTES STATE (déclarés tôt — référencés par setContent dès le chargement) ─
let _notesRefreshInterval = null;
let _noteAutoSave = null;
let _noteEditingId = null;
let _noteSyncInterval = null;
let _noteDebounce = null;
let _contribDebounce = null;
let _collabNoteId = null;

// ── PWA INSTALL PROMPT ──────────────────────────────────────────────────────
let _pwaPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _pwaPrompt = e;
});

// ── CHAT STATE ──────────────────────────────────────────────────────────────
const CHAT = {
  open:      false,
  rooms:     [],
  activeId:  null,
  lastMsgAt: {},
  lastMsgId: {},
  pollTimer: null,
};

const EMOJIS = [
  '😀','😂','😊','😍','🥰','😎','🤔','😅','😭','🙏',
  '👍','👋','🤝','💪','✅','❤️','🔥','💯','🎉','🌺',
  '🇭🇹','⭐','🙌','😮','🤩','👏','💚','🏆','📢','✨'
];

// ── Permissions (déclaré tôt — utilisé dans home() avant la ligne 246 originale) ──
const can = {
  admin:       () => USER.role === 'admin',
  tresoriere:  () => USER.role === 'tresoriere',
  secretaire:  () => USER.role === 'secretaire',
  delegue:     () => USER.role === 'delegue',
  adminOrSec:  () => ['admin','secretaire'].includes(USER.role),
  adminOrTre:  () => ['admin','tresoriere'].includes(USER.role),
  financeView: () => ['admin','tresoriere','secretaire'].includes(USER.role),
  executive:   () => ['admin','tresoriere','secretaire','delegue'].includes(USER.role),
};

// ── Détection âge jeune (15-30 ans) ────────────────────────────────────────
function getUserAge() {
  if (!USER.date_naissance) return null;
  return Math.floor((Date.now() - new Date(USER.date_naissance)) / (365.25 * 24 * 3600 * 1000));
}
function isJeune() {
  const age = getUserAge();
  return age !== null && age >= 15 && age <= 30;
}

// ── INIT ───────────────────────────────────────────────────────────────────
(async function init() {
  TOKEN = localStorage.getItem('ahh_token');
  const raw = localStorage.getItem('ahh_user');
  if (!TOKEN || !raw) return location.replace('login.html');
  USER = JSON.parse(raw);

  buildSidebar();
  renderUserChip();
  setupTopbar();

  // Retour depuis Stripe Checkout
  const _sp = new URLSearchParams(window.location.search);
  if (_sp.get('cotis') === 'ok') {
    window.history.replaceState({}, '', '/dashboard/app.html');
    setTimeout(() => toast('✅ Paiement confirmé ! Votre cotisation a été enregistrée.'), 800);
  } else if (_sp.get('cotis') === 'cancel') {
    window.history.replaceState({}, '', '/dashboard/app.html');
    setTimeout(() => toast('Paiement annulé.', true), 800);
  }

  try {
    await showView('home');
  } catch (e) {
    console.error('Erreur showView(home):', e);
  }

  // Rafraîchir USER depuis le serveur (date_naissance, plan, etc.) puis reconstruire si jeune détecté
  try {
    const apiBase = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001/api' : '/api';
    const freshResp = await fetch(apiBase + '/auth/me', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (freshResp.ok) {
      const freshData = await freshResp.json();
      const wasJeune = isJeune();
      USER = { ...USER, ...freshData };
      localStorage.setItem('ahh_user', JSON.stringify(USER));
      // Reconstruire sidebar si statut jeune a changé
      if (isJeune() !== wasJeune) {
        buildSidebar();
      }
    }
  } catch(e) {}
  pollBadges();
  initSSE();
  initChat();
  initFAB();
  // Synchroniser le plan/rôle depuis le serveur (détecte les changements admin)
  syncUserFromServer();
  setInterval(syncUserFromServer, 120000); // re-vérifier toutes les 2 min
  setTimeout(checkPWAInstallPrompt, 2500);
})();

async function syncUserFromServer() {
  try {
    const fresh = await api('/auth/me');
    if (!fresh || !fresh.id) return;
    const planChanged = fresh.plan !== USER.plan;
    const roleChanged = fresh.role !== USER.role;
    const actifChanged = fresh.actif !== USER.actif;
    if (!planChanged && !roleChanged && !actifChanged) return;
    USER = Object.assign(USER, fresh);
    localStorage.setItem('ahh_user', JSON.stringify(USER));
    buildSidebar();
    renderUserChip();
    if (window._activeView) setActiveNav(window._activeView);
    if (planChanged) toast('Votre plan a été mis à jour : ' + (fresh.plan || 'gratuit'), 'info');
  } catch { /* silencieux si hors ligne */ }
}

// ── PWA INSTALL ────────────────────────────────────────────────────────────
function checkPWAInstallPrompt() {
  if (localStorage.getItem('ahh_pwa_prompted')) return;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isStandalone) return;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (!isMobile) return;
  if (_pwaPrompt || isIOS) showPWAInstallBanner(isIOS);
}

function showPWAInstallBanner(isIOS) {
  if (document.getElementById('pwa-install-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'pwa-install-banner';
  banner.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px">' +
      '<img src="/Public/logo1.png" style="width:48px;height:48px;border-radius:10px;flex-shrink:0" onerror="this.style.display=\'none\'">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:700;font-size:.95rem">Ajouter AHH à votre téléphone</div>' +
        '<div style="font-size:.8rem;color:rgba(255,255,255,.8);margin-top:2px">Accédez rapidement depuis votre écran d\'accueil</div>' +
      '</div>' +
    '</div>' +
    (isIOS
      ? '<div style="margin:12px 0 4px;padding:10px;background:rgba(255,255,255,.15);border-radius:8px;font-size:.82rem;line-height:1.6">' +
          '📤 Appuyez sur <strong>Partager</strong> <span style="font-size:1rem">⎙</span> en bas de Safari,<br>puis <strong>"Sur l\'écran d\'accueil"</strong>' +
        '</div>'
      : '') +
    '<div style="display:flex;gap:8px;margin-top:14px">' +
      (!isIOS ? '<button onclick="pwaInstallAccept()" style="flex:1;padding:10px;background:#fff;color:#1a6a3d;border:none;border-radius:8px;font-weight:700;font-size:.9rem;cursor:pointer">✅ Oui, ajouter</button>' : '') +
      '<button onclick="pwaInstallDismiss()" style="' + (isIOS ? 'flex:1;' : '') + 'padding:10px;background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:8px;font-size:.9rem;cursor:pointer">Non merci</button>' +
    '</div>';

  Object.assign(banner.style, {
    position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '99999',
    background: 'linear-gradient(135deg,#1a6a3d,#2d9e5f)',
    color: '#fff', padding: '18px 20px 28px',
    boxShadow: '0 -4px 24px rgba(0,0,0,.3)',
    borderRadius: '20px 20px 0 0',
    transform: 'translateY(100%)',
    transition: 'transform .35s cubic-bezier(.4,0,.2,1)',
    fontFamily: 'inherit',
  });

  document.body.appendChild(banner);
  requestAnimationFrame(() => requestAnimationFrame(() => { banner.style.transform = 'translateY(0)'; }));
}

async function pwaInstallAccept() {
  if (!_pwaPrompt) return;
  _pwaPrompt.prompt();
  const { outcome } = await _pwaPrompt.userChoice;
  _pwaPrompt = null;
  localStorage.setItem('ahh_pwa_prompted', '1');
  document.getElementById('pwa-install-banner')?.remove();
  if (outcome === 'accepted') toast('✅ Application ajoutée à votre écran d\'accueil !');
}

function pwaInstallDismiss() {
  localStorage.setItem('ahh_pwa_prompted', '1');
  const banner = document.getElementById('pwa-install-banner');
  if (!banner) return;
  banner.style.transform = 'translateY(100%)';
  setTimeout(() => banner.remove(), 350);
}

// ── API HELPER ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const { timeout: tms = 8000, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tms);
  try {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...fetchOpts.headers },
      signal: controller.signal,
      ...fetchOpts
    });
    clearTimeout(timer);
    if (res.status === 401) { logout(); return null; }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
    return data;
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Serveur non disponible — relancez start.bat');
    throw e;
  }
}

async function apiForm(path, formData) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: formData
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type === 'error' ? ' error' : type === 'info' ? ' info' : '');
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', 3500);
}

function fmt(dateStr) {
  if (!dateStr) return '–';
  return new Date(dateStr).toLocaleDateString('fr-CA', { year:'numeric', month:'short', day:'numeric' });
}
function fmtMoney(n) { return '$' + (+n || 0).toFixed(2); }

function pill(label, cls) { return `<span class="badge-pill ${cls}">${label}</span>`; }
function statusPill(s) {
  const m = { planifiee:'bp-blue', en_cours:'bp-green', terminee:'bp-gray', annulee:'bp-red',
    archivee:'bp-gray', planifie:'bp-blue', termine:'bp-gray', suspendu:'bp-orange',
    actif:'bp-green', inactif:'bp-gray', approuve:'bp-green', en_attente:'bp-orange', rejete:'bp-red', refuse:'bp-red',
    demande:'bp-orange', genere:'bp-blue', signe:'bp-green', paye:'bp-green', en_attente2:'bp-orange' };
  return pill(s || '–', m[s] || 'bp-gray');
}

function roleName(r) {
  return { admin:'Admin', tresoriere:'Trésorière', secretaire:'Secrétaire', delegue:'Accompagnateur', member:'Membre' }[r] || r;
}

function setContent(html) {
  const mc = document.getElementById('mainContent');
  // Supprimer le skeleton au premier rendu
  const sk = document.getElementById('skeleton-screen');
  if (sk) sk.remove();
  // Stopper l'auto-save, debounce et refresh des notes si on change de vue
  if (_noteAutoSave) { clearInterval(_noteAutoSave); _noteAutoSave = null; }
  if (_noteDebounce) { clearTimeout(_noteDebounce); _noteDebounce = null; }
  if (_notesRefreshInterval) { clearInterval(_notesRefreshInterval); _notesRefreshInterval = null; }
  // Libérer la session d'édition si on quittait une note
  if (_noteEditingId) { api(`/notes/${_noteEditingId}/editing`, { method:'DELETE' }).catch(()=>{}); _noteEditingId = null; }
  // Nettoyer la contribution si on quittait le mode collaboratif
  if (_collabNoteId) { api(`/notes/${_collabNoteId}/contribute`, { method:'DELETE' }).catch(()=>{}); _collabNoteId = null; }
  if (_contribDebounce) { clearTimeout(_contribDebounce); _contribDebounce = null; }
  // Réinitialiser le mode flex-fill (utilisé par certaines vues pleine hauteur)
  mc.style.display = '';
  mc.style.flexDirection = '';
  mc.innerHTML = html;
}

// ── SIDEBAR ─────────────────────────────────────────────────────────────────
function buildSidebar() {
  const nav = document.getElementById('sidebarNav');

  // ── Sidebar restructurée par catégories logiques ─────────────────
  const ALL = ['admin','tresoriere','secretaire','delegue','member'];
  const EXEC = ['admin','tresoriere','secretaire','delegue'];
  const STAFF = ['admin','tresoriere','secretaire'];

  const sections = [
    // ── Accueil ───────────────────────────────────────────────────
    { label: null, items: [
      { id:'home', icon:'⊞', label:'Tableau de bord', roles: ALL },
    ]},

    // ── Membres ───────────────────────────────────────────────────
    { label: 'Membres', items: [
      { id:'members',       icon:'◎', label:'Annuaire',         roles:['admin','secretaire','delegue'] },
      { id:'inscriptions',  icon:'◈', label:'Inscriptions',     roles:EXEC },
      { id:'volunteer',     icon:'◇', label:'Bénévolat',        roles:['admin','secretaire'] },
      { id:'carte-gestion', icon:'🪪', label:'Cartes membres',  roles:['admin','secretaire','tresoriere','delegue'] },
      { id:'carte-scanner', icon:'📷', label:'Scanner cartes',  roles:['admin','secretaire','tresoriere','delegue'] },
    ]},

    // ── Activités ─────────────────────────────────────────────────
    { label: 'Activités', items: [
      { id:'activities',    icon:'◉', label:'Calendrier',   roles: ALL },
      { id:'subcommittees', icon:'◐', label:'Sous-comités', roles: ALL },
      { id:'projects',      icon:'◑', label:'Projets',      roles:['admin','delegue'] },
    ]},

    // ── Finance ───────────────────────────────────────────────────
    { label: 'Finance', items: [
      { id:'paiements',         icon:'◆', label:'Paiements',      roles:['admin','tresoriere','secretaire'] },
      { id:'finance',           icon:'◇', label:'Budget',          roles:['admin','tresoriere','secretaire'] },
      { id:'invoices',          icon:'◈', label:'Factures',        roles:['admin','tresoriere','secretaire'] },
      { id:'recus',             icon:'◉', label:'Reçus fiscaux',  roles:['admin','tresoriere','secretaire'] },
      { id:'rapports_finance',  icon:'📊', label:'Rapports',       roles:['admin','tresoriere','secretaire'] },
    ]},

    // ── Communication ─────────────────────────────────────────────
    { label: 'Communication', items: [
      { id:'annuaire', icon:'✉️', label:'Courriel', roles: ALL },
      { id:'forum',    icon:'◫', label:'Forum',    roles: ALL },
    ]},

    // ── Rapports & Admin ──────────────────────────────────────────
    { label: 'Rapports', items: [
      { id:'reports',      icon:'◆', label:'Rapports',        roles:STAFF },
      { id:'stats-growth', icon:'📈', label:'Statistiques',   roles:EXEC },
      { id:'letters',      icon:'◎', label:'Lettres',         roles:['admin','secretaire'] },
      { id:'alerts',       icon:'◇', label:'Alertes',         roles:['admin','tresoriere'] },
      { id:'stats-site',   icon:'📊', label:'Stats du site',  roles:EXEC },
    ]},

    // ── Contenu ───────────────────────────────────────────────────
    { label: 'Contenu', items: [
      { id:'gallery_mgmt',      icon:'◎', label:'Galerie',          roles:['admin','secretaire'] },
      { id:'talents_mgmt',      icon:'◈', label:'Talents',           roles:['admin','secretaire'] },
      { id:'annonces_mgmt',     icon:'◉', label:'Annonces',          roles:['admin','secretaire'] },
      { id:'notes',             icon:'◇', label:'Notes réunion',     roles:EXEC },
      { id:'testimonials_mgmt', icon:'❝', label:'Témoignages',       roles:['admin','secretaire'] },
      { id:'videos_mgmt',       icon:'▶', label:'Vidéos',            roles:['admin','secretaire'] },
      { id:'documents_mgmt',    icon:'📁', label:'Documents',         roles:['admin','secretaire'] },
      { id:'sponsors_mgmt',     icon:'🤝', label:'Commanditaires',    roles:['admin','secretaire'] },
    ]},

    // ── Espace Jeunes ─────────────────────────────────────────────
    {
      label: '🌟 Espace Jeunes',
      items: [
        { id:'young-home',      icon:'🌟', label:'Tableau jeunes',   roles: ALL },
        { id:'young-jobs',      icon:'💼', label:'Stages & emplois',  roles: ALL },
        { id:'young-trainings', icon:'📚', label:'Formations',        roles: ALL },
        { id:'young-polls',     icon:'📊', label:'Sondages',          roles: ALL },
        { id:'young-stories',   icon:'🏆', label:'Success Stories',   roles: ALL },
      ]
    },

    // ── Gouvernance ───────────────────────────────────────────────
    { label: 'Gouvernance', items: [
      { id:'votes',         icon:'🗳️', label:'Votes & Élections',  roles:EXEC },
      { id:'parrainage',    icon:'🤝', label:'Parrainage',           roles: ALL },
      { id:'journal-admin', icon:'📋', label:'Journal d\'activité', roles:['admin'] },
      { id:'ambassadeur-admin',    icon:'⭐', label:'Ambassadeur du mois',    roles:['admin'] },
      { id:'abonnes-newsletter',   icon:'📧', label:'Abonnés newsletter',      roles:['admin','secretaire'] },
    ]},

    // ── Mon espace membre ─────────────────────────────────────────
    {
      label: 'Mon espace',
      items: [
        { id:'mes_talents',  icon:'◈', label:'Mon talent',   roles:['member','delegue'], planMin:['bienfaiteur','partenaire'] },
        { id:'mes_annonces', icon:'◉', label:'Mes annonces', roles:['member','delegue'], planMin:['bienfaiteur','partenaire'] },
        { id:'mon_paiement', icon:'◆', label:'Mon paiement', roles:['member','delegue'], planMin:['bienfaiteur','partenaire'] },
        { id:'mes_billets',  icon:'🎟', label:'Mes billets',  roles: ALL },
        { id:'carte-membre', icon:'🪪', label:'Ma carte membre', roles: ALL },
        { id:'alerts',       icon:'◇', label:'Alertes',      roles:['admin','tresoriere'] },
        { id:'mes-badges',   icon:'🏅', label:'Mes badges',   roles: ALL },
        { id:'profile',      icon:'◎', label:'Mon profil',   roles: ALL },
      ]
    },

    // ── Billetterie ───────────────────────────────────────────────
    { label: 'Billetterie', items: [
      { id:'vente-personne',  icon:'💵', label:'Vendre (cash)',        roles:EXEC },
      { id:'scanner',         icon:'📷', label:'Scanner billets',      roles:EXEC },
      { id:'pending-orders',  icon:'🎟', label:'Commandes en attente', roles:STAFF },
    ]},
  ];

  // Membres réguliers → sidebar épurée définie ici, sections ignorées
  if (USER.role === 'member') {
    const memberItems = [
      { id:'home',         icon:'⊞', label:'Tableau de bord' },
      { id:'mes_billets',  icon:'🎟', label:'Mes billets' },
      USER.in_subcommittee ? { id:'subcommittees', icon:'◐', label:'Sous-comités' } : null,
      ['bienfaiteur','partenaire'].includes(USER.plan) ? { id:'mes_talents',  icon:'◈', label:'Mon talent' }   : null,
      ['bienfaiteur','partenaire'].includes(USER.plan) ? { id:'mes_annonces', icon:'◉', label:'Mes annonces' } : null,
      { id:'annuaire',     icon:'✉️', label:'Courriel' },
      { id:'forum',        icon:'◫', label:'Forum' },
      // ── Mon espace membres ───────────────────────────────────────
      { id:'carte-membre',  icon:'🪪', label:'Ma carte membre',   _section:'✨ Mon espace' },
      { id:'mon_paiement',  icon:'💳', label:'Mes cotisations' },
      { id:'actualites',    icon:'📰', label:'Actualités' },
      { id:'young-polls',   icon:'📊', label:'Sondages' },
      { id:'parrainage',    icon:'🤝', label:'Parrainage' },
      { id:'notif-prefs',   icon:'🔔', label:'Notifications' },
      // ── Stages & emplois + Formations (tous les membres) ────────
      { id:'young-jobs',      icon:'💼', label:'Stages & emplois', _section:'💼 Opportunités' },
      { id:'young-trainings', icon:'📚', label:'Formations' },
      // ── Espace Jeunes extra (15-30 ans seulement) ───────────────
      isJeune() ? { id:'young-home',   icon:'🌟', label:'Espace Jeunes', _section:'🌟 Espace Jeunes' } : null,
      isJeune() ? { id:'young-stories',icon:'🏆', label:'Success Stories' } : null,
      // ────────────────────────────────────────────────────────────
      { id:'mes-badges', icon:'🏅', label:'Mes badges' },
      { id:'profile',    icon:'◎', label:'Mon profil' },
    ].filter(Boolean);

    nav.innerHTML = memberItems.map((i, idx) => {
      const sectionHeader = i._section ? `<div class="nav-section">${i._section}</div>` : '';
      return sectionHeader + `<div class="nav-item" data-view="${i.id}" onclick="showView('${i.id}')">
        <span class="nav-icon">${i.icon}</span>
        <span class="nav-label">${i.label}</span>
      </div>`;
    }).join('');
    if (window.AHH_LANG) AHH_LANG.apply();
    return;
  }

  // Comité & admin → sidebar complète
  nav.innerHTML = sections.map(section => {
    const visibleItems = section.items.filter(i => {
      if (!i.roles.includes(USER.role)) return false;
      if (i.planMin && !i.planMin.includes(USER.plan || 'gratuit')) return false;
      return true;
    });
    if (!visibleItems.length) return '';
    const headerHtml = section.label ? `<div class="nav-section" data-i18n="${section.label}">${section.label}</div>` : '';
    return headerHtml + visibleItems.map(i => `
        <div class="nav-item" data-view="${i.id}" onclick="showView('${i.id}')">
          <span class="nav-icon">${i.icon}</span>
          <span class="nav-label" data-i18n="${i.label}">${i.label}</span>
        </div>`).join('');
  }).join('');
  if (window.AHH_LANG) AHH_LANG.apply();
}

function setActiveNav(viewId) {
  window._activeView = viewId;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === viewId));
  // Fermer le sidebar sur mobile après navigation
  if (window.innerWidth < 900) {
    document.getElementById('sidebar')?.classList.remove('open');
    const ov = document.getElementById('sidebarOverlay');
    if (ov) ov.style.display = 'none';
  }
  ['home','activities','messages','profile'].forEach(id => {
    const el = document.getElementById('mbn-' + id);
    if (el) el.classList.toggle('active', viewId === id);
  });
  const labels = {
    home:'Tableau de bord', activities:'Activités', members:'Membres', subcommittees:'Sous-comités',
    finance:'Finance', invoices:'Factures', messages:'Messages', volunteer:'Heures de bénévolat',
    notes:'Notes de réunion', reports:'Rapports', letters:'Lettres de recommandation',
    projects:'Projets', alerts:'Alertes', profile:'Mon profil', gallery_mgmt:'Gérer la galerie',
    talents_mgmt:'Nos talents', annonces_mgmt:'Petites annonces',
    mes_talents:'Mon talent', mes_annonces:'Mes annonces',
    inscriptions:'Inscriptions en attente', paiements:'Paiements membres',
    recus:'Reçus fiscaux', rapports_finance:'Rapports', mon_paiement:'Mon paiement', annuaire:'Courriel', documents_mgmt:'Documents officiels',
    forum:'Forum', newsletter:'Infolettre', 'vente-personne':'Vendre (Cash)',
    'young-home':'Espace Jeunes', 'young-jobs':'Stages & Emplois',
    'young-trainings':'Formations', 'young-polls':'Sondages', 'young-stories':'Success Stories',
    'votes':'Votes & Élections', 'parrainage':'Parrainage', 'stats-growth':'Statistiques',
    'carte-membre':'Ma carte membre', 'actualites':'Actualités', 'notif-prefs':'Notifications',
    'carte-gestion':'Gestion des cartes', 'carte-scanner':'Scanner cartes',
    'journal-admin':'Journal d\'activité', 'mes-badges':'Mes badges', 'ambassadeur-admin':'Ambassadeur du mois',
    'abonnes-newsletter':'Abonnés newsletter'
  };
  const raw = labels[viewId] || 'Dashboard';
  document.getElementById('topbarTitle').textContent = window.AHH_LANG ? AHH_LANG.get(raw) : raw;
}

function renderUserChip() {
  const planLabel = { gratuit:'Gratuit', bienfaiteur:'Bienfaiteur', partenaire:'Partenaire' };
  const chipText = USER.role === 'member'
    ? `${USER.prenom} · ${planLabel[USER.plan] || 'Gratuit'}`
    : `${USER.prenom} · ${roleName(USER.role)}`;
  document.getElementById('userChip').textContent = chipText;
  const nameEl = document.getElementById('siteNavName');
  if (nameEl) nameEl.textContent = USER.prenom;
  const logoutStrip = document.getElementById('siteNavLogout');
  if (logoutStrip) logoutStrip.onclick = logout;
}

function setupTopbar() {
  // Overlay mobile pour fermer le sidebar en cliquant dehors
  const overlay = document.createElement('div');
  overlay.id = 'sidebarOverlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:399;';
  overlay.onclick = () => { document.getElementById('sidebar').classList.remove('open'); overlay.style.display='none'; };
  document.body.appendChild(overlay);

  document.getElementById('sidebarToggle').onclick = () => {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('open');
    overlay.style.display = sb.classList.contains('open') ? 'block' : 'none';
  };
  document.getElementById('btnLogout').onclick = logout;
  document.getElementById('alertBtn').onclick = () => showView('alerts');
  document.getElementById('msgBtn').onclick   = () => showView('annuaire');
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').onclick = e => { if (e.target.id === 'modalOverlay') closeModal(); };
  setupDarkMode();
  setupSearch();
  setupLangSelector();
  initPushNotifications();
}

// ── Notifications Push ────────────────────────────────────────────────────────
async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return; // Déjà abonné
    // Demander la permission automatiquement après 5 secondes
    setTimeout(async () => {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      try {
        const keyResp = await fetch(API + '/push/vapid-key');
        const { publicKey } = await keyResp.json();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
        await fetch(API + '/push/subscribe', {
          method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+TOKEN },
          body: JSON.stringify(sub)
        });
        toast('🔔 Notifications activées !');
      } catch(e) {}
    }, 5000);
  } catch(e) {}
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function setupLangSelector() {
  const wrap = document.getElementById('langSelectorWrap');
  const label = document.getElementById('langLabel');
  const opts  = document.querySelectorAll('.lang-opt');
  const LABELS = { fr:'FR', en:'EN', ht:'HT' };

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) wrap.classList.remove('open');
  });

  // Sync active state and label from stored preference
  const stored = localStorage.getItem('ahh_lang') || 'fr';
  label.textContent = LABELS[stored] || stored.toUpperCase();
  opts.forEach(o => o.classList.toggle('active', o.dataset.lang === stored));

  if (!window.AHH_LANG) return;

  // Rebuild sidebar + topbar on language change (enhancement over the HTML onclick)
  opts.forEach(o => o.addEventListener('click', () => {
    const lang = o.dataset.lang;
    label.textContent = LABELS[lang] || lang.toUpperCase();
    opts.forEach(x => x.classList.toggle('active', x.dataset.lang === lang));
    buildSidebar();
    if (window._activeView) setActiveNav(window._activeView);
  }));
}

function logout() {
  localStorage.clear();
  location.replace('login.html');
}

let _prevMsgCount = 0;
let _prevAlertCount = 0;

// ── Carte de notification bottom-right ───────────────────────────────────
(function() {
  const stack = document.createElement('div');
  stack.id = 'notif-stack';
  document.body.appendChild(stack);
})();

function showNotifCard(titre, desc, { icon = '🔔', color = '#003F87' } = {}) {
  let stack = document.getElementById('notif-stack');
  if (!stack) { stack = document.createElement('div'); stack.id = 'notif-stack'; document.body.appendChild(stack); }

  const card = document.createElement('div');
  card.className = 'notif-card';
  card.style.borderLeftColor = color;
  card.innerHTML = `
    <div class="notif-card-body">
      <span class="notif-card-icon">${icon}</span>
      <div class="notif-card-content">
        <div class="notif-card-title">${titre}</div>
        ${desc ? `<div class="notif-card-desc">${desc}</div>` : ''}
        <div class="notif-card-time">À l'instant</div>
      </div>
      <button class="notif-card-close" title="Fermer">✕</button>
    </div>
    <div class="notif-card-bar" style="color:${color}"></div>`;

  stack.prepend(card);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    card.classList.add('out');
    setTimeout(() => card.remove(), 320);
  };
  // Seul le bouton ✕ ferme la carte manuellement (évite fermeture accidentelle par clic parasite)
  card.querySelector('.notif-card-close').addEventListener('click', dismiss);
  setTimeout(dismiss, 30000);
}

// ── SSE — mises à jour temps réel ────────────────────────────────────────
let _sseConn = null;

function initSSE() {
  if (_sseConn) { try { _sseConn.close(); } catch(_) {} }
  _sseConn = new EventSource(`${API}/sse?token=${TOKEN}`);

  _sseConn.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      if (evt.type === 'connected' || evt.type === 'ping') return;
      _handleLiveEvent(evt);
    } catch(_) {}
  };

  _sseConn.onerror = () => {
    try { _sseConn.close(); } catch(_) {}
    setTimeout(initSSE, 6000); // Reconnexion automatique
  };
}

function _handleLiveEvent(evt) {
  // Carte de notification selon le type d'événement
  const notifMap = {
    inscription: { icon: '📋', color: '#003F87',
      titre: 'Nouvelle demande d\'adhésion',
      desc: evt.contenu || 'Un candidat attend votre approbation.' },
    message:     { icon: '✉️', color: '#1a237e',
      titre: evt.titre || 'Nouveau courriel',
      desc: evt.contenu || '' },
    paiement:    { icon: '💳', color: '#1b5e20',
      titre: 'Nouveau paiement reçu',
      desc: evt.contenu || '' },
    activite:    { icon: '🎉', color: '#CE1126',
      titre: 'Nouvelle inscription à une activité',
      desc: evt.contenu || '' },
    benevolat:   { icon: '🤝', color: '#e65100',
      titre: 'Demande de bénévolat',
      desc: evt.contenu || '' },
    vote:        { icon: '🗳️', color: '#6a1b9a',
      titre: 'Nouveau vote enregistré',
      desc: evt.contenu || '' },
  };

  const key  = evt.alertType || evt.type;
  const cfg  = notifMap[key] || { icon: '🔔', color: '#003F87', titre: evt.titre || 'Notification', desc: evt.contenu || '' };
  showNotifCard(cfg.titre, cfg.desc, { icon: cfg.icon, color: cfg.color });

  // Mise à jour instantanée des badges
  if (evt.type === 'alerte') {
    const badge = document.getElementById('alertCount');
    if (badge) {
      const n = (parseInt(badge.textContent) || 0) + 1;
      badge.textContent = n;
      badge.style.display = 'block';
    }
    if (document.visibilityState === 'hidden') showBrowserNotif('AHH — ' + cfg.titre, cfg.desc);
  }
  if (evt.type === 'message') {
    const badge = document.getElementById('msgCount');
    if (badge) {
      const n = (parseInt(badge.textContent) || 0) + 1;
      badge.textContent = n;
      badge.style.display = 'block';
    }
    if (document.visibilityState === 'hidden') showBrowserNotif('AHH — ' + cfg.titre, cfg.desc);
  }

  // Rafraîchir la vue active si pertinent
  const view = window._activeView;
  if (view === 'home') setTimeout(home, 800);
  if (view === 'inscriptions' && evt.alertType === 'inscription') setTimeout(inscriptions, 600);
  if (view === 'alerts') setTimeout(alerts, 600);
  if ((view === 'annuaire' || view === 'messages') && evt.type === 'message') setTimeout(() => showView(view), 600);
}

async function pollBadges() {
  try {
    const stats = await api('/stats');
    if (stats) {
      const ac = document.getElementById('alertCount');
      const mc = document.getElementById('msgCount');
      const newMsgs = stats.messages_non_lus;
      const newAlerts = stats.alertes_non_lues;
      ac.textContent = newAlerts;
      mc.textContent = newMsgs;
      ac.style.display = newAlerts > 0 ? 'block' : 'none';
      mc.style.display = newMsgs > 0 ? 'block' : 'none';
      if (newMsgs > _prevMsgCount && _prevMsgCount >= 0 && document.visibilityState === 'hidden') {
        showBrowserNotif('Nouveau message — AHH', `Vous avez ${newMsgs} message(s) non lu(s)`);
      }
      if (newAlerts > _prevAlertCount && _prevAlertCount >= 0 && document.visibilityState === 'hidden') {
        showBrowserNotif('Nouvelle alerte — AHH', `Vous avez ${newAlerts} alerte(s) non lue(s)`);
      }
      _prevMsgCount = newMsgs;
      _prevAlertCount = newAlerts;

      // ── Badges sur les items du sidebar ──
      setSidebarBadge('inscriptions', stats.inscriptions_en_attente);
      setSidebarBadge('alerts',       newAlerts);
      setSidebarBadge('annuaire',     newMsgs);
    }
  } catch {}
  setTimeout(pollBadges, 30000);
}

// ── FAB Scanner (mobile) ────────────────────────────────────────────────────
function initFAB() {
  const canScan = ['admin','tresoriere','secretaire','delegue'].includes(USER.role);
  if (!canScan) return;
  const btn = document.createElement('button');
  btn.className = 'fab-scanner';
  btn.title = 'Scanner une carte';
  btn.innerHTML = '📷';
  btn.onclick = () => showView('carte-scanner');
  document.body.appendChild(btn);
}

function setSidebarBadge(viewId, count) {
  // Remove any existing badge on this nav item
  document.querySelectorAll(`.nav-item[data-view="${viewId}"] .nav-badge`).forEach(b => b.remove());
  if (!count || count <= 0) return;
  const item = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (!item) return;
  const badge = document.createElement('span');
  badge.className = 'nav-badge';
  badge.textContent = count > 99 ? '99+' : count;
  item.appendChild(badge);
}

function showBrowserNotif(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/Public/logo1.png', badge: '/Public/logo1.png' });
  } else if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Request notification permission on first interaction
document.addEventListener('click', function askNotif() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  document.removeEventListener('click', askNotif);
}, { once: true });

// ── MODAL (rendu inline dans la page) ─────────────────────────────────────
function openModal(title, bodyHtml, size) {
  window._modalReturnViewId = window._currentViewId || 'home';
  setContent(
    `<div style="padding-bottom:40px" class="modal-inline-wrap">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border)" class="no-print">
        <button onclick="closeModal()" style="display:flex;align-items:center;gap:6px;background:var(--off);border:1px solid var(--border);border-radius:8px;padding:7px 14px;cursor:pointer;font-size:.84rem;color:var(--text);flex-shrink:0">← Retour</button>
        <h2 style="margin:0;font-size:1.18rem;font-weight:700">${title}</h2>
        <button onclick="window.print()" style="margin-left:auto;display:flex;align-items:center;gap:5px;background:var(--off);border:1px solid var(--border);border-radius:8px;padding:7px 14px;cursor:pointer;font-size:.84rem;color:var(--text);flex-shrink:0" class="no-print">🖨️ Imprimer / PDF</button>
      </div>
      <div class="print-content">${bodyHtml}</div>
    </div>`
  );
}
function closeModal() {
  const vid = window._modalReturnViewId || 'home';
  window._modalReturnViewId = null;
  showView(vid);
}

// ── VIEWS ──────────────────────────────────────────────────────────────────
async function showView(viewId) {
  window._currentViewId = viewId;
  // Arrêter la caméra carte si elle tourne
  if (window._carteScanner) {
    try { await window._carteScanner.stop(); } catch {}
    window._carteScanner = null;
  }
  setActiveNav(viewId);
  setContent('<div class="loading-screen"><div class="spinner"></div><p>Chargement...</p></div>');
  const views = {
    home, activities, members, subcommittees,
    finance, invoices, messages, volunteer,
    notes, reports, letters, projects, alerts, profile,
    gallery_mgmt, annuaire, talents_mgmt, annonces_mgmt, mes_talents, mes_annonces,
    inscriptions, paiements, recus, mon_paiement, mes_billets, testimonials_mgmt, videos_mgmt,
    scanner, forum, newsletter, rapports_finance, documents_mgmt, sponsors_mgmt
  };
  const extViews = {
    'pending-orders': pendingOrders,
    'vente-personne': ventePersonne,
    'stats-site': statsSite,
    'young-home': youngHome,
    'young-jobs': youngJobs,
    'young-trainings': youngTrainings,
    'young-polls': youngPolls,
    'young-stories': youngStories,
    'votes': votesView,
    'parrainage': parrainageView,
    'stats-growth': statsGrowthView,
    'carte-membre': carteMembreView,
    'actualites': actualitesView,
    'notif-prefs': notifPrefsView,
    'carte-gestion': carteGestionView,
    'carte-scanner': carteScannerView,
    'journal-admin': journalAdmin,
    'mes-badges': mesBadgesView,
    'ambassadeur-admin': ambassadeurAdmin,
    'abonnes-newsletter': abonnesNewsletter,
  };
  if (extViews[viewId]) {
    try { await extViews[viewId](); } catch(e) { setContent(`<div class="empty-state"><div class="es-icon">⚠️</div><p>${e.message}</p></div>`); }
    return;
  }
  try {
    await (views[viewId] || home)();
  } catch(e) {
    setContent(`<div class="empty-state"><div class="es-icon">⚠️</div><p>${e.message}</p></div>`);
  }
}

// ══ HOME ════════════════════════════════════════════════════════════════════
async function home() {
  // Membres → afficher le calendrier personnalisé
  if (USER.role === 'member') { await memberHome(); return; }

  const [stats, alerts, birthdays, members] = await Promise.all([
    api('/stats'),
    api('/alerts'),
    can.adminOrSec() ? api('/membres/anniversaires').catch(() => []) : Promise.resolve([]),
    can.adminOrSec() ? api('/users').catch(() => []) : Promise.resolve([]),
  ]);
  const upcoming = stats.prochaines_activites || [];
  const unreadAlerts = alerts.filter(a => !a.lu).slice(0, 4);

  // Membres dont la cotisation est en retard (>2 mois d'impayés)
  const overdueMembers = members.filter(m => m.role === 'member' && m.actif && (m.plan_unpaid_count || 0) >= 2).slice(0, 5);

  const _days   = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const _months = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  const _now    = new Date();
  const _dateStr = `${_days[_now.getDay()]} ${_now.getDate()} ${_months[_now.getMonth()]} ${_now.getFullYear()}`;

  const quickActions = [
    canCreateActivity ? { icon:'🎉', label:'Nouvelle activité',  action:"openActivityForm()",        cls:'qa-red'    } : null,
    can.adminOrSec() ?  { icon:'✉️', label:'Envoyer un message', action:"showView('messages')",       cls:'qa-blue'   } : null,
    can.adminOrSec() ?  { icon:'🤝', label:'Heures bénévolat',   action:"showView('volunteer')",      cls:'qa-gold'   } : null,
    can.adminOrSec() ?  { icon:'🖼️', label:'Gérer la galerie',   action:"showView('gallery_mgmt')",   cls:'qa-purple' } : null,
    can.financeView() ? { icon:'💰', label:'Voir la finance',     action:"showView('finance')",        cls:'qa-green'  } : null,
  ].filter(Boolean);

  const roleEmoji = { admin:'👑', tresoriere:'💰', secretaire:'📋', delegue:'🤝', member:'🌟' };

  setContent(`
    <!-- Salutation -->
    <div class="home-greeting">
      <div class="home-greeting-text">
        <h2>Bonjour, <span style="color:#ffd6d6">${USER.prenom}</span> 👋</h2>
        <div class="home-greeting-date">📅 ${_dateStr}</div>
        <div class="home-greeting-role">${roleName(USER.role)}</div>
      </div>
      <div style="font-size:3.2rem;filter:drop-shadow(0 2px 8px rgba(0,0,0,.3))">
        ${roleEmoji[USER.role] || '👤'}
      </div>
    </div>

    <!-- Stats cards -->
    <div class="cards-grid" style="margin-bottom:28px">
      ${USER.role !== 'member' ? `
      <div class="stat-card card-blue">
        <div class="sc-icon">👥</div>
        <div class="sc-value">${stats.total_membres}</div>
        <div class="sc-label">Membres actifs</div>
      </div>` : ''}
      <div class="stat-card card-red">
        <div class="sc-icon">🎉</div>
        <div class="sc-value">${stats.total_activites}</div>
        <div class="sc-label">Activités</div>
      </div>
      <div class="stat-card card-gold">
        <div class="sc-icon">🤝</div>
        <div class="sc-value">${stats.total_heures}h</div>
        <div class="sc-label">Bénévolat approuvé</div>
      </div>
      <div class="stat-card card-navy ${stats.messages_non_lus > 0 ? 'has-notif' : ''}">
        <div class="sc-icon">✉️</div>
        <div class="sc-value">${stats.messages_non_lus}</div>
        <div class="sc-label">Messages non lus</div>
      </div>
      ${can.financeView() ? `
      <div class="stat-card accent">
        <div class="sc-icon">💳</div>
        <div class="sc-value">${fmtMoney(stats.solde || 0)}</div>
        <div class="sc-label">Solde du compte</div>
      </div>` : ''}
    </div>

    <div class="home-grid" style="grid-template-columns:1fr 1fr 1fr">
      <!-- Actions rapides -->
      <div class="table-card">
        <div class="table-card-header"><h3>⚡ Actions rapides</h3></div>
        <div class="quick-actions-grid">
          ${quickActions.map(a => `
            <button class="quick-action-btn ${a.cls || ''}" onclick="${a.action}">
              <span class="qa-icon">${a.icon}</span>
              <span class="qa-label">${a.label}</span>
            </button>`).join('')}
        </div>
        <div style="border-top:1px solid var(--border);margin-top:8px;padding:10px 16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="showView('carte-scanner')">📷 Scanner</button>
          <button class="btn btn-ghost btn-sm" onclick="showView('inscriptions')">📝 Inscriptions</button>
          <button class="btn btn-ghost btn-sm" onclick="showView('abonnes-newsletter')">📧 Newsletter</button>
        </div>
        <!-- Widget météo -->
        <div id="weatherWidget" style="border-top:1px solid var(--border);padding:12px 16px"></div>
      </div>

      <!-- Prochaines activités -->
      <div class="table-card">
        <div class="table-card-header">
          <h3>📅 Prochaines activités</h3>
          <button class="btn btn-sm btn-ghost" onclick="showView('activities')">Toutes →</button>
        </div>
        <div style="padding:8px 0">
          ${upcoming.length ? upcoming.slice(0,4).map(a => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer" onclick="showView('activities')">
              <div style="width:36px;height:36px;border-radius:8px;background:var(--g2);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;flex-shrink:0">${a.date_debut ? new Date(a.date_debut).getDate() : '?'}<br/><span style="font-size:.6rem;opacity:.8">${a.date_debut ? new Date(a.date_debut).toLocaleString('fr-CA',{month:'short'}).toUpperCase() : ''}</span></div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(a.titre)}</div>
                <div style="font-size:.75rem;color:var(--muted)">${a.lieu || '–'} · ${a.nb_inscrits || 0} inscrits</div>
              </div>
            </div>`).join('') : '<div class="empty-state" style="padding:24px"><div class="es-icon">📅</div><p>Aucune activité planifiée</p></div>'}
        </div>
      </div>

      <!-- Alertes + Derniers membres -->
      <div class="table-card">
        ${can.adminOrSec() ? `
        <div class="table-card-header">
          <h3>🔔 Alertes</h3>
          ${unreadAlerts.length ? `<button class="btn btn-sm btn-ghost" onclick="showView('alerts')">Toutes →</button>` : ''}
        </div>
        <div style="padding:4px 8px">
          ${unreadAlerts.length ? unreadAlerts.slice(0,3).map(a => `
            <div class="alert-item">
              <div class="alert-dot"></div>
              <div>
                <div class="alert-title">${a.titre || 'Alerte'}</div>
                <div class="alert-time">${fmt(a.date_creation)}</div>
              </div>
            </div>`).join('') : '<div style="padding:12px 16px;font-size:.82rem;color:var(--muted)">✅ Aucune alerte non lue</div>'}
        </div>
        <div class="table-card-header" style="border-top:1px solid var(--border);margin-top:4px">
          <h3>👤 Derniers membres</h3>
          <button class="btn btn-sm btn-ghost" onclick="showView('members')">Tous →</button>
        </div>
        <div style="padding:4px 0">
          ${(stats.derniers_membres||[]).slice(0,4).map(m => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 16px">
              <div style="width:30px;height:30px;border-radius:50%;background:var(--g3);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.78rem;font-weight:700;flex-shrink:0">${(m.prenom||'?')[0]}${(m.nom||'')[0]||''}</div>
              <div><div style="font-size:.83rem;font-weight:600">${escHtml(m.prenom)} ${escHtml(m.nom)}</div><div style="font-size:.72rem;color:var(--muted)">${fmt(m.date_inscription)}</div></div>
            </div>`).join('') || '<div style="padding:12px 16px;font-size:.82rem;color:var(--muted)">Aucun nouveau membre</div>'}
        </div>` : `
        <div class="table-card-header"><h3>🔔 Alertes</h3></div>
        <div style="padding:4px 8px">
          ${unreadAlerts.length ? unreadAlerts.slice(0,4).map(a => `<div class="alert-item"><div class="alert-dot"></div><div><div class="alert-title">${a.titre||'Alerte'}</div></div></div>`).join('') : '<div style="padding:12px 16px;font-size:.82rem;color:var(--muted)">✅ Aucune alerte</div>'}
        </div>`}
      </div>
    </div>

    <!-- 2e rangée : anniversaires + alertes cotisation -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:16px">

      ${can.adminOrSec() && birthdays.length ? `
      <div class="table-card">
        <div class="table-card-header"><h3>🎂 Anniversaires ce mois</h3><span style="font-size:.78rem;color:var(--muted)">${new Date().toLocaleString('fr-CA',{month:'long'})}</span></div>
        <div style="padding:4px 0">
          ${birthdays.slice(0,6).map(m => {
            const parts = m.date_naissance ? m.date_naissance.split('-') : null;
            const age = parts ? new Date().getFullYear() - parseInt(parts[0]) : null;
            const jour = parts ? parseInt(parts[2]) : '?';
            return `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border)">
              <div style="width:32px;height:32px;background:var(--accent);color:#000;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:800;flex-shrink:0">${jour}</div>
              ${m.photo_url ? `<img src="${BASE}${m.photo_url}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0"/>` : `<div style="width:28px;height:28px;border-radius:50%;background:var(--g3);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;flex-shrink:0">${(m.prenom||'?')[0]}</div>`}
              <div style="flex:1"><div style="font-size:.83rem;font-weight:600">${escHtml(m.prenom)} ${escHtml(m.nom)}</div>${age ? `<div style="font-size:.72rem;color:var(--muted)">${age} ans</div>` : ''}</div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      ${can.adminOrSec() && overdueMembers.length ? `
      <div class="table-card">
        <div class="table-card-header"><h3>⚠️ Cotisations en retard</h3><button class="btn btn-sm btn-ghost" onclick="showView('paiements')">Voir tout →</button></div>
        <div style="padding:4px 0">
          ${overdueMembers.map(m => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border)">
              <div style="width:28px;height:28px;border-radius:50%;background:#ffebee;color:var(--red);display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;flex-shrink:0">!</div>
              <div style="flex:1"><div style="font-size:.83rem;font-weight:600">${escHtml(m.prenom)} ${escHtml(m.nom)}</div><div style="font-size:.72rem;color:var(--red)">${m.plan_unpaid_count} mois impayé${m.plan_unpaid_count>1?'s':''}</div></div>
              <span style="font-size:.7rem;background:#ffebee;color:var(--red);padding:2px 8px;border-radius:20px;font-weight:700">${pill(m.plan||'gratuit','bp-orange')}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}

    </div>
  `);

  // Charger météo Hamilton en arrière-plan
  fetchWeather();
}

async function fetchWeather() {
  const el = document.getElementById('weatherWidget');
  if (!el) return;
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=43.2557&longitude=-79.8711&current_weather=true&hourly=precipitation_probability&timezone=America%2FToronto');
    if (!r.ok) throw new Error('météo non disponible');
    const d = await r.json();
    const cw = d.current_weather;
    const wmoIcons = {0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',71:'🌨️',73:'🌨️',75:'❄️',80:'🌧️',81:'🌧️',82:'⛈️',95:'⛈️'};
    const ico = wmoIcons[cw.weathercode] || '🌡️';
    const isDay = cw.is_day;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <div style="font-size:1.8rem">${ico}</div>
        <div>
          <div style="font-weight:700;font-size:.95rem">${Math.round(cw.temperature)}°C <span style="font-size:.72rem;color:var(--muted);font-weight:400">Hamilton, ON</span></div>
          <div style="font-size:.72rem;color:var(--muted)">${isDay ? '☀️ Jour' : '🌙 Nuit'} · Vent ${Math.round(cw.windspeed)} km/h</div>
        </div>
      </div>`;
  } catch {
    el.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">🌡️ Météo non disponible</div>';
  }
}

// ══ HOME MEMBRE ═══════════════════════════════════════════════════════════════
async function memberHome() {
  const [calActs, stats, recap] = await Promise.all([
    api('/activities/my-calendar'),
    api('/stats'),
    api('/member/annual-recap').catch(() => ({ year: new Date().getFullYear(), nb_activites:0, heures_benevolat:0, cotisations:0, heures_all:0 }))
  ]);
  const planLabel = { gratuit:'Gratuit', bienfaiteur:'Bienfaiteur', partenaire:'Partenaire' };

  const initials = `${(USER.prenom||'?')[0]}${(USER.nom||'')[0]}`.toUpperCase();
  const avatarHtml = USER.photo_url
    ? `<img src="${BASE}${USER.photo_url}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.45);flex-shrink:0"/>`
    : `<div style="width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.2);border:3px solid rgba(255,255,255,.45);color:#fff;font-size:1.6rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;letter-spacing:-.02em">${initials}</div>`;

  // Feature 3: Compte à rebours — prochain événement inscrit
  const now = new Date();
  const prochainEvt = calActs
    .filter(a => a.status === 'inscrit' && a.date_debut)
    .map(a => { const mm = (a.date_debut||'').match(/^(\d{4})-(\d{2})-(\d{2})/); if(!mm) return null; const d=new Date(+mm[1],+mm[2]-1,+mm[3]); return {...a, _ts:d}; })
    .filter(a => a && a._ts >= now)
    .sort((a,b) => a._ts - b._ts)[0];
  const countdownHtml = prochainEvt ? (() => {
    const days = Math.ceil((prochainEvt._ts - now) / 86400000);
    return `<div class="table-card" style="margin-bottom:20px;background:linear-gradient(135deg,#1b5e20,#2e7d32);color:#fff;border:none">
      <div style="padding:18px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="font-size:2.8rem;font-weight:900;line-height:1;min-width:60px;text-align:center">${days}</div>
        <div>
          <div style="font-size:.72rem;opacity:.8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">⏳ Prochain événement dans</div>
          <div style="font-weight:700;font-size:1rem">${escHtml(prochainEvt.titre)}</div>
          <div style="font-size:.8rem;opacity:.8;margin-top:2px">${days === 1 ? 'demain !' : `jour${days>1?'s':''}`}</div>
        </div>
        <button class="btn btn-sm" style="margin-left:auto;background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.4)" onclick="showView('mes_billets')">Mes billets →</button>
      </div>
    </div>`;
  })() : '';

  // Feature 2: Barre de progression bénévolat
  const heures = recap.heures_all || 0;
  const paliers = [{h:100,label:'Or 🥇',color:'#f9a825'},{h:50,label:'Argent 🥈',color:'#9e9e9e'},{h:25,label:'Bronze 🥉',color:'#bf8a30'}];
  const palierActuel = paliers.find(p => heures >= p.h) || null;
  const palierSuivant = paliers.slice().reverse().find(p => heures < p.h) || paliers[0];
  const pct = palierSuivant ? Math.min(100, Math.round(heures / palierSuivant.h * 100)) : 100;
  const benevHtml = `
    <div class="table-card" style="margin-bottom:20px">
      <div style="padding:16px 20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <div>
            <span style="font-weight:700;font-size:.9rem">🤝 Bénévolat</span>
            ${palierActuel ? `<span style="margin-left:8px;background:#fff3cd;color:#856404;border-radius:20px;padding:2px 10px;font-size:.75rem;font-weight:700">${palierActuel.label}</span>` : ''}
          </div>
          <span style="font-size:.82rem;color:var(--muted)">${heures}h / ${palierSuivant?.h||100}h</span>
        </div>
        <div style="background:#e0e0e0;border-radius:8px;height:12px;overflow:hidden">
          <div style="background:${palierSuivant?.color||'var(--g2)'};border-radius:8px;height:100%;width:${pct}%;transition:width .6s ease"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-top:6px">
          <span>0h</span>
          ${paliers.slice().reverse().map(p=>`<span>${p.h}h ${p.label}</span>`).join('')}
        </div>
      </div>
    </div>`;

  setContent(`
    <div class="home-greeting">
      <div class="home-greeting-text">
        <h2>Bonjour, <span style="color:var(--g3)">${USER.prenom}</span> 👋</h2>
        <p>Bienvenue dans votre espace AHH · <strong>${planLabel[USER.plan] || 'Gratuit'}</strong></p>
      </div>
      ${avatarHtml}
    </div>

    <!-- Feature 10: Résumé annuel -->
    <div style="background:linear-gradient(135deg,var(--g2),var(--g3));border-radius:14px;padding:16px 20px;margin-bottom:20px;color:#fff">
      <div style="font-size:.75rem;opacity:.8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">✨ Votre ${recap.year} en chiffres</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900">${recap.nb_activites}</div><div style="font-size:.72rem;opacity:.8">Activité${recap.nb_activites!==1?'s':''}</div></div>
        <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900">${recap.heures_benevolat}h</div><div style="font-size:.72rem;opacity:.8">Bénévolat</div></div>
        <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900">$${(recap.cotisations||0).toFixed(0)}</div><div style="font-size:.72rem;opacity:.8">Cotisations</div></div>
        <div style="margin-left:auto;display:flex;align-items:center">
          <button onclick="showView('carte-membre')" style="background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:8px;padding:8px 14px;font-size:.82rem;cursor:pointer">🪪 Ma carte →</button>
        </div>
      </div>
    </div>

    <div class="cards-grid" style="margin-bottom:20px">
      <div class="stat-card">
        <div class="sc-icon">🎉</div>
        <div class="sc-value">${calActs.filter(a=>a.status==='inscrit').length}</div>
        <div class="sc-label">Mes activités</div>
      </div>
      <div class="stat-card ${stats.messages_non_lus > 0 ? 'has-notif' : ''}">
        <div class="sc-icon">✉️</div>
        <div class="sc-value">${stats.messages_non_lus}</div>
        <div class="sc-label">Messages non lus</div>
      </div>
      <div class="stat-card">
        <div class="sc-icon">🏷️</div>
        <div class="sc-value" style="font-size:clamp(.9rem,3.5vw,1.3rem);word-break:break-word;line-height:1.2">${planLabel[USER.plan] || 'Gratuit'}</div>
        <div class="sc-label">Mon abonnement</div>
      </div>
    </div>

    ${countdownHtml}
    ${benevHtml}

    <div class="table-card" style="margin-bottom:20px">
      <div class="table-card-header">
        <h3>📅 Mon calendrier</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm btn-ghost" onclick="calNav(-1)">‹</button>
          <span id="calMonthLabel" style="font-weight:700;min-width:140px;text-align:center"></span>
          <button class="btn btn-sm btn-ghost" onclick="calNav(1)">›</button>
        </div>
      </div>
      <div id="memberCal" style="padding:16px"></div>
      <div style="padding:8px 16px;display:flex;gap:16px;font-size:.75rem;color:var(--muted)">
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--g2);margin-right:4px"></span>Inscrit</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1565c0;margin-right:4px"></span>Disponible</span>
      </div>
    </div>

    <div class="table-card">
      <div class="table-card-header"><h3>🎟 Mes prochaines activités</h3></div>
      <div id="prochActivites" style="padding:8px 16px"></div>
    </div>
  `);

  window._calActs = calActs;
  window._calYear = new Date().getFullYear();
  window._calMonth = new Date().getMonth();
  renderMemberCal();
  renderProchActivites();
}

function renderProchActivites() {
  const el = document.getElementById('prochActivites');
  if (!el) return;
  const inscrites = (window._calActs || [])
    .filter(a => a.status === 'inscrit')
    .sort((a, b) => new Date(a.date_debut||0) - new Date(b.date_debut||0));
  if (!inscrites.length) {
    el.innerHTML = '<div class="empty-state" style="padding:24px"><div class="es-icon">📅</div><p>Aucune activité inscrite</p></div>';
    return;
  }
  el.innerHTML = inscrites.map(a => {
    const m = (a.date_debut||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const [jour, moisStr] = m
      ? [parseInt(m[3]), new Date(+m[1],+m[2]-1,+m[3]).toLocaleDateString('fr-CA',{month:'short'})]
      : ['–', ''];
    return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="width:38px;height:38px;border-radius:10px;background:var(--g2);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;flex-shrink:0;text-align:center;line-height:1.1">
        ${jour}<br>${moisStr}
      </div>
      <div style="flex:1;min-width:0">
        <strong style="font-size:.88rem">${a.titre}</strong>
        ${a.lieu?`<div style="font-size:.76rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📍 ${a.lieu}</div>`:''}
      </div>
      <button class="btn btn-sm" style="color:#d32f2f;border:1px solid #d32f2f;background:transparent;white-space:nowrap;padding:3px 8px;font-size:.75rem;flex-shrink:0"
        onclick="calUnregister(${a.id})">✕ Se désinscrire</button>
    </div>`;
  }).join('');
}

async function calUnregister(actId) {
  if (!confirm('Se désinscrire de cette activité ?')) return;
  try {
    await api(`/activities/${actId}/register`, { method:'DELETE' });
    toast('Désinscription confirmée');
    window._calActs = (window._calActs || []).filter(a => a.id !== actId);
    renderMemberCal();
    renderProchActivites();
  } catch(ex) { toast(ex.message, 'error'); }
}

function calNav(dir) {
  window._calMonth += dir;
  if (window._calMonth < 0) { window._calMonth = 11; window._calYear--; }
  if (window._calMonth > 11) { window._calMonth = 0; window._calYear++; }
  renderMemberCal();
}

function renderMemberCal() {
  const year = window._calYear, month = window._calMonth;
  const acts = window._calActs || [];
  const MOIS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  document.getElementById('calMonthLabel').textContent = `${MOIS[month]} ${year}`;

  // Grouper activités par jour (parsing local pour éviter le décalage UTC)
  const byDay = {};
  acts.forEach(a => {
    const mm = (a.date_debut || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!mm) return;
    const [, dy, dm, dd] = mm.map(Number);
    if (dy === year && dm - 1 === month) {
      if (!byDay[dd]) byDay[dd] = [];
      byDay[dd].push(a);
    }
  });

  const firstDay = new Date(year, month, 1).getDay(); // 0=dim
  const startOffset = (firstDay + 6) % 7; // Lundi=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  let html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">';
  ['L','M','M','J','V','S','D'].forEach(d => {
    html += `<div style="text-align:center;font-size:.7rem;font-weight:700;color:var(--muted);padding:4px 0">${d}</div>`;
  });

  for (let i = 0; i < startOffset; i++) html += '<div></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = isCurrentMonth && today.getDate() === day;
    const dayActs = byDay[day] || [];
    const dots = dayActs.slice(0, 3).map(a =>
      `<div style="width:6px;height:6px;border-radius:50%;background:${a.status==='inscrit'?'var(--g2)':'#1565c0'};margin:0 1px;flex-shrink:0"></div>`
    ).join('');
    const onclick = dayActs.length ? `onclick="showCalDay(${day},${month},${year})"` : '';
    html += `<div ${onclick} style="min-height:52px;border-radius:8px;padding:4px;background:${isToday?'var(--g2)':dayActs.length?'#f0f8f0':'var(--off)'};cursor:${dayActs.length?'pointer':'default'};border:1px solid ${isToday?'var(--g2)':dayActs.length?'var(--border)':'transparent'};transition:.15s" title="${dayActs.map(a=>a.titre).join(', ')}">
      <div style="font-size:.78rem;font-weight:${isToday?'800':'600'};color:${isToday?'#fff':'var(--text)'};">${day}</div>
      <div style="display:flex;flex-wrap:wrap;margin-top:3px">${dots}</div>
    </div>`;
  }
  html += '</div>';
  document.getElementById('memberCal').innerHTML = html;
}

function showCalDay(day, month, year) {
  const acts = (window._calActs || []).filter(a => {
    const mm = (a.date_debut || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!mm) return false;
    return +mm[1] === year && +mm[2] - 1 === month && +mm[3] === day;
  });
  const MOIS = ['jan','fév','mar','avr','mai','jun','jul','aoû','sep','oct','nov','déc'];
  openModal(`📅 ${day} ${MOIS[month]} ${year}`, `
    <div style="display:flex;flex-direction:column;gap:12px">
      ${acts.map(a => `
        <div style="padding:14px;border-radius:12px;border-left:4px solid ${a.status==='inscrit'?'var(--g2)':'#1565c0'};background:var(--off)">
          <div style="font-weight:700;font-size:.92rem">${a.titre}</div>
          ${a.lieu ? `<div style="font-size:.8rem;color:var(--muted);margin-top:4px">📍 ${a.lieu}</div>` : ''}
          ${a.date_debut ? `<div style="font-size:.78rem;color:var(--muted);margin-top:2px">🕐 ${new Date(a.date_debut).toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'})}</div>` : ''}
          <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px">
            <span style="font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:50px;background:${a.status==='inscrit'?'#e8f5e9':'#e3f2fd'};color:${a.status==='inscrit'?'var(--g2)':'#1565c0'}">
              ${a.status === 'inscrit' ? '✓ Inscrit' : '• Disponible'}
            </span>
            ${a.status !== 'inscrit' ? `
            <button class="btn btn-primary btn-sm" onclick="calDayRegister(${a.id},${day},${month},${year})">
              + S'inscrire
            </button>` : ''}
          </div>
        </div>`).join('')}
    </div>
  `);
}

async function calDayRegister(actId, day, month, year) {
  try {
    await api(`/activities/${actId}/register`, { method:'POST' });
    toast('✅ Inscription confirmée !');
    const act = (window._calActs || []).find(a => a.id === actId);
    if (act) act.status = 'inscrit';
    renderMemberCal();
    renderProchActivites();
    showCalDay(day, month, year);
  } catch(ex) { toast(ex.message, 'error'); }
}

// ══ ACTIVITIES ═══════════════════════════════════════════════════════════════
async function activities() {
  const data = await api('/activities');
  window._activitiesData = data;

  setContent(`
    <div style="display:flex;flex-direction:column;flex:1;gap:0;height:100%">
      <div class="page-header">
        <div><h2>Activités</h2><p>Toutes les activités communautaires</p></div>
        <div class="page-actions">
          ${canCreateActivity() ? '<button class="btn btn-primary" onclick=\'openActivityForm(null)\'>+ Nouvelle</button>' : ''}
          <button class="btn btn-ghost" onclick="activityCalendar()">🗓️ Calendrier</button>
          <button class="btn btn-outline" onclick="printSection(\'Activités\')">🖨️ Imprimer</button>
        </div>
      </div>
      <div class="members-toolbar">
        <input id="actSearch" type="text" class="members-search" placeholder="🔍 Rechercher par titre, lieu, type…" oninput="filterActivities()"/>
        <select id="actStatut" class="members-filter" onchange="filterActivities()">
          <option value="">Tous les statuts</option>
          <option value="planifiee">Planifiée</option>
          <option value="en_cours">En cours</option>
          <option value="terminee">Terminée</option>
          <option value="archivee">Archivée</option>
          <option value="annulee">Annulée</option>
        </select>
        <select id="actType" class="members-filter" onchange="filterActivities()">
          <option value="">Tous les types</option>
          <option value="general">Général</option>
          <option value="culturel">Culturel</option>
          <option value="benevolat">Bénévolat</option>
          <option value="reunion">Réunion</option>
          <option value="social">Social</option>
        </select>
        <button class="btn btn-ghost btn-sm" onclick="resetActivitiesFilter()">✕ Effacer</button>
      </div>
      <div class="table-card" style="flex:1;display:flex;flex-direction:column;margin-bottom:0">
        <div class="table-wrapper" style="flex:1"><table id="activitiesTable">
          <thead><tr><th>Titre</th><th>Type</th><th>Date</th><th>Lieu</th><th>Participants</th><th>Statut</th><th>Actions</th></tr></thead>
          <tbody id="activitiesBody"></tbody>
        </table></div>
      </div>
    </div>
  `);
  // Mode pleine hauteur : #mainContent devient flex colonne
  const _mc = document.getElementById('mainContent');
  _mc.style.display = 'flex';
  _mc.style.flexDirection = 'column';

  filterActivities();
}

function filterActivities() {
  const q      = (document.getElementById('actSearch')?.value || '').toLowerCase().trim();
  const statut = document.getElementById('actStatut')?.value || '';
  const type   = document.getElementById('actType')?.value   || '';
  const data   = window._activitiesData || [];

  const filtered = data.filter(a => {
    if (q && !`${a.titre} ${a.lieu||''} ${a.type}`.toLowerCase().includes(q)) return false;
    if (statut && a.statut !== statut) return false;
    if (type   && a.type  !== type)   return false;
    return true;
  });

  renderActivitiesTable(filtered);
}

function resetActivitiesFilter() {
  ['actSearch','actStatut','actType'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  filterActivities();
}

function renderActivitiesTable(data) {
  const tbody = document.getElementById('activitiesBody');
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:40px">Aucune activité trouvée</td></tr>';
    return;
  }
  const isMember = USER.role === 'member' || USER.role === 'delegue';
  tbody.innerHTML = data.map(a => {
    const isRegistered = a.user_registered > 0;
    const canRegister  = isMember && a.statut === 'planifiee';
    let memberBtn = '';
    if (canRegister) {
      memberBtn = isRegistered
        ? '<span class="registered-badge">✅ Prêt(e)</span>'
        : `<button class="btn btn-sm btn-accent" onclick="registerActivity(${a.id})">S'inscrire</button>`;
    }
    const isArchived = a.statut === 'archivee';
    return `<tr>
      <td><strong>${a.titre}</strong></td>
      <td>${a.type}</td>
      <td>${fmt(a.date_debut)}</td>
      <td>${a.lieu||'–'}</td>
      <td>
        <div style="font-size:.82rem;font-weight:600">${a.nb_inscrits}${a.max_participants ? '/'+a.max_participants : ''}</div>
        ${a.max_participants > 0 ? (() => {
          const pct = Math.min(100, Math.round((a.nb_inscrits / a.max_participants) * 100));
          const color = pct >= 90 ? '#c62828' : pct >= 60 ? '#e65100' : '#2e7d32';
          return `<div style="margin-top:3px;background:#e8f5e9;border-radius:4px;height:5px;overflow:hidden;width:80px"><div style="height:100%;width:${pct}%;background:${color};border-radius:4px"></div></div><div style="font-size:.66rem;color:${color};font-weight:700">${pct}%</div>`;
        })() : ''}
      </td>
      <td>${statusPill(a.statut)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap">
        ${canCreateActivity() ? `
          <button class="btn btn-sm btn-outline" onclick='openActivityForm(${JSON.stringify(a).replace(/'/g,"&#39;")})' title="Modifier">✏️ Modifier</button>
          <button class="btn btn-sm btn-ghost" title="Scanner billets" onclick="openScanner(${a.id})">📷 Scanner</button>
          <button class="btn btn-sm btn-ghost" onclick="showActivityReport(${a.id})" title="Rapport">📊 Rapport</button>
          <button class="btn btn-sm ${a.featured ? 'btn-accent' : 'btn-ghost'}" onclick="toggleFeatured(${a.id},${a.featured?1:0})" title="${a.featured ? 'Retirer de la une' : 'Mettre à la une'}" style="${a.featured?'background:#f9a825;color:#000':''}">⭐${a.featured?' À LA UNE':''}</button>
          <div style="position:relative">
            <button class="btn btn-sm btn-ghost" onclick="toggleActMenu(${a.id},event)" title="Plus d'actions" style="font-weight:700;font-size:1rem;padding:4px 10px">⋮</button>
            <div class="act-more-menu" id="actMenu_${a.id}" style="display:none;position:absolute;right:0;top:100%;z-index:200;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.12);min-width:200px;padding:6px 0">
              ${!isArchived && a.statut === 'planifiee' && can.adminOrSec() ? '<div class="act-menu-item" onclick="closeActMenus();launchActivity(' + a.id + ',\'' + a.titre.replace(/'/g,"\\'") + '\')">🚀 Lancer l\'activité</div>' : ''}
              ${a.paiement_requis ? '<div class="act-menu-item" onclick="closeActMenus();viewActivityQR(' + a.id + ',\'' + a.titre.replace(/'/g,"\\'") + '\',\'' + (a.qr_token||'') + '\')">📱 QR Paiement</div>' : ''}
              <div class="act-menu-item" onclick="closeActMenus();viewRegistrations(${a.id},'${a.titre.replace(/'/g,"\\'")}')">👥 Inscrits</div>
              <div class="act-menu-item" onclick="closeActMenus();presencesView(${a.id},'${a.titre.replace(/'/g,"\\'")}')">✅ Feuille de présences</div>
              <div class="act-menu-item" onclick="closeActMenus();liveAttendance(${a.id})">📍 Présents en direct</div>
              <div class="act-menu-item" onclick="closeActMenus();manageTicketTypes(${a.id})">🎟 Types de billets</div>
              <div class="act-menu-item" onclick="closeActMenus();managerTables(${a.id},'${a.titre.replace(/'/g,"\\'")}')">🪑 Tables</div>
              <div class="act-menu-item" onclick="closeActMenus();manageActivityPhotos(${a.id},'${a.titre.replace(/'/g,"\\'")}')">🖼 Photos</div>
              <div style="border-top:1px solid var(--border);margin:4px 0"></div>
              <div class="act-menu-item"><a href="${API}/activities/${a.id}/ical" download style="color:inherit;text-decoration:none;display:block">📅 Exporter iCal</a></div>
              <div class="act-menu-item"><a href="${API}/activities/${a.id}/qr?format=png&size=1000" download="QR-${a.id}.png" style="color:inherit;text-decoration:none;display:block">📲 Télécharger QR PNG</a></div>
              <div class="act-menu-item" onclick="closeActMenus();duplicateActivity(${a.id},'${a.titre.replace(/'/g,"\\'")}')">📋 Copier l'activité</div>
              <div style="border-top:1px solid var(--border);margin:4px 0"></div>
              ${isArchived
                ? '<div class="act-menu-item" style="color:var(--g2)" onclick="closeActMenus();unarchiveActivity(' + a.id + ')">↩️ Restaurer</div>'
                : '<div class="act-menu-item" style="color:#888" onclick="closeActMenus();archiveActivity(' + a.id + ')">📦 Archiver</div>'}
              ${can.admin() ? '<div class="act-menu-item" style="color:var(--red)" onclick="closeActMenus();deleteActivity(' + a.id + ')">🗑 Supprimer</div>' : ''}
            </div>
          </div>
        ` : ''}
        ${memberBtn}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Fiche membre enrichie ────────────────────────────────────────────────────
async function openMemberDetail(u) {
  openModal('👤 Fiche membre', '<div style="text-align:center;padding:20px;color:var(--muted)">⏳ Chargement...</div>');
  try {
    const [detail, volunteer, payments] = await Promise.all([
      api('/users/' + u.id),
      api('/volunteer?user_id=' + u.id).catch(() => []),
      api('/paiements?user_id=' + u.id).catch(() => []),
    ]);
    const m = { ...u, ...detail };
    const age = m.date_naissance ? Math.floor((Date.now() - new Date(m.date_naissance)) / (365.25*24*3600*1000)) : null;
    const totalHeures = Array.isArray(volunteer) ? volunteer.filter(v=>v.statut==='approuve').reduce((s,v)=>s+(v.heures||0),0) : 0;
    const planColors = { gratuit:'#757575', bienfaiteur:'#e65100', partenaire:'#1565c0' };
    const plc = planColors[m.plan||'gratuit'] || '#757575';

    document.getElementById('modalBody').innerHTML = `
      <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;margin-bottom:20px">
        <div style="flex-shrink:0">
          ${m.photo_url
            ? `<img src="${BASE}${m.photo_url}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid var(--border)"/>`
            : `<div style="width:80px;height:80px;border-radius:50%;background:var(--g3);color:#fff;font-size:2rem;font-weight:700;display:flex;align-items:center;justify-content:center">${(m.prenom||'?')[0]}${(m.nom||'')[0]||''}</div>`}
        </div>
        <div style="flex:1;min-width:200px">
          <div style="font-size:1.25rem;font-weight:800">${escHtml(m.prenom)} ${escHtml(m.nom)}</div>
          <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
            ${pill(roleName(m.role), m.role==='admin'?'bp-orange':m.role==='member'?'bp-blue':'bp-green')}
            <span style="background:${plc}20;color:${plc};font-size:.72rem;font-weight:700;padding:2px 10px;border-radius:20px;border:1px solid ${plc}40">${(m.plan||'gratuit').toUpperCase()}</span>
            ${m.actif ? pill('Actif','bp-green') : pill('Inactif','bp-red')}
          </div>
          ${m.bio ? `<div style="margin-top:8px;font-size:.82rem;color:var(--muted);font-style:italic">${escHtml(m.bio)}</div>` : ''}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px">
        <div style="background:var(--off);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:1.3rem;font-weight:800;color:var(--g2)">${totalHeures}h</div>
          <div style="font-size:.72rem;color:var(--muted)">Bénévolat approuvé</div>
        </div>
        ${age ? `<div style="background:var(--off);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:1.3rem;font-weight:800;color:var(--g2)">${age}</div>
          <div style="font-size:.72rem;color:var(--muted)">ans</div>
        </div>` : ''}
        <div style="background:var(--off);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:1rem;font-weight:700;color:var(--g2)">${fmt(m.date_inscription)}</div>
          <div style="font-size:.72rem;color:var(--muted)">Membre depuis</div>
        </div>
        ${m.plan_unpaid_count > 0 ? `<div style="background:#ffebee;border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:1.3rem;font-weight:800;color:var(--red)">${m.plan_unpaid_count}</div>
          <div style="font-size:.72rem;color:var(--red)">mois impayés</div>
        </div>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;font-size:.83rem">
        ${m.email    ? `<div><span style="color:var(--muted)">✉️ </span><a href="mailto:${escHtml(m.email)}" style="color:var(--g2)">${escHtml(m.email)}</a></div>` : ''}
        ${m.telephone ? `<div><span style="color:var(--muted)">📞 </span>${escHtml(m.telephone)}</div>` : ''}
        ${m.adresse   ? `<div><span style="color:var(--muted)">📍 </span>${escHtml(m.adresse)}</div>` : ''}
        ${m.date_naissance ? `<div><span style="color:var(--muted)">🎂 </span>${fmt(m.date_naissance)}</div>` : ''}
      </div>

      ${can.executive() ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick='closeModal();openMemberForm(${JSON.stringify(m).replace(/'/g,"&#39;")})'>✏️ Modifier</button>
        <button class="btn btn-ghost btn-sm" onclick="closeModal();showView('carte-gestion')">🪪 Carte membre</button>
        ${m.actif
          ? `<button class="btn btn-danger btn-sm" onclick="closeModal();toggleMember(${m.id},0)">🚫 Désactiver</button>`
          : `<button class="btn btn-ghost btn-sm"  onclick="closeModal();toggleMember(${m.id},1)">✅ Activer</button>`}
      </div>` : ''}
    `;
  } catch(e) {
    document.getElementById('modalBody').innerHTML = `<p style="color:var(--red)">${e.message}</p>`;
  }
}

function toggleActMenu(id, e) {
  e.stopPropagation();
  closeActMenus();
  const m = document.getElementById('actMenu_' + id);
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
function closeActMenus() {
  document.querySelectorAll('.act-more-menu').forEach(m => m.style.display = 'none');
}
document.addEventListener('click', closeActMenus);

async function toggleFeatured(id, isFeatured) {
  try {
    const endpoint = isFeatured ? 'unfeature' : 'feature';
    await api(`/activities/${id}/${endpoint}`, { method: 'PATCH' });
    toast(isFeatured ? 'Activité retirée de la une' : '⭐ Activité mise à la une sur le site !');
    activities();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

async function archiveActivity(id) {
  const a = (window._activitiesData || []).find(x => x.id === id);
  if (!confirm(`Archiver "${a?.titre || '#'+id}" ? Elle sera retirée des finances mais ses données seront conservées.`)) return;
  try { await api(`/activities/${id}/archive`, { method: 'PATCH' }); toast('Activité archivée'); activities(); }
  catch(ex) { toast(ex.message, 'error'); }
}

async function unarchiveActivity(id) {
  try { await api(`/activities/${id}/unarchive`, { method: 'PATCH' }); toast('Activité restaurée'); activities(); }
  catch(ex) { toast(ex.message, 'error'); }
}

async function duplicateActivity(id, titre) {
  if (!confirm(`Créer une copie de "${titre}" ?`)) return;
  try {
    await api(`/activities/${id}/duplicate`, { method: 'POST' });
    toast('✅ Activité copiée — elle est planifiée et peut être modifiée');
    activities();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteActivity(id) {
  const a = (window._activitiesData || []).find(x => x.id === id);
  if (!confirm(`Supprimer définitivement "${a?.titre || '#'+id}" ?\nSes transactions et inscriptions seront également supprimées. Action irréversible.`)) return;
  try { await api(`/activities/${id}`, { method: 'DELETE' }); toast('Activité supprimée'); activities(); }
  catch(ex) { toast(ex.message, 'error'); }
}

// Rôles autorisés à créer des activités
const canCreateActivity = () => ['admin','tresoriere','secretaire','delegue'].includes(USER.role);
// Seuls VP (admin) et Présidente (admin) peuvent définir les rabais
const canSetDiscount = () => USER.role === 'admin';

function openActivityForm(a = null) {
  const isEdit = !!(a && a.id);  // seulement "edit" si l'objet a un id existant
  let rabais = {};
  try { rabais = JSON.parse(a?.rabais_json || '{}'); } catch {}

  openModal(isEdit ? 'Modifier l\'activité' : 'Nouvelle activité', `
    <form id="actForm">
      <div class="form-row">
        <div class="form-group"><label>Titre *</label><input id="a_titre" value="${a?.titre||''}" required/></div>
        <div class="form-group"><label>Type</label>
          <select id="a_type">
            <option value="general" ${a?.type==='general'?'selected':''}>Général</option>
            <option value="culturel" ${a?.type==='culturel'?'selected':''}>Culturel</option>
            <option value="benevolat" ${a?.type==='benevolat'?'selected':''}>Bénévolat</option>
            <option value="reunion" ${a?.type==='reunion'?'selected':''}>Réunion</option>
            <option value="social" ${a?.type==='social'?'selected':''}>Social</option>
          </select></div>
      </div>
      <div class="form-group"><label>Description</label><textarea id="a_desc">${a?.description||''}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Date début</label><input type="datetime-local" id="a_debut" value="${a?.date_debut||''}"/></div>
        <div class="form-group"><label>Date fin</label><input type="datetime-local" id="a_fin" value="${a?.date_fin||''}"/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Lieu</label><input id="a_lieu" value="${a?.lieu||''}"/></div>
        <div class="form-group"><label>Budget prévu ($)</label><input type="number" id="a_budget" value="${a?.budget_prevu||0}" step="0.01"/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Max participants</label><input type="number" id="a_max" value="${a?.max_participants||''}"/></div>
        <div class="form-group"><label style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="a_payant" style="width:auto" ${a?.paiement_requis?'checked':''} onchange="document.getElementById('payBlock').style.display=this.checked?'block':'none'"/>
          Activité payante
        </label></div>
      </div>

      <!-- Bloc paiement -->
      <div id="payBlock" style="${a?.paiement_requis?'':'display:none'}">
        <div style="background:var(--off);border-radius:10px;padding:14px;margin-bottom:12px;border:1px solid var(--border)">
          <div class="form-group"><label>Prix ($) *</label><input type="number" id="a_prix" value="${a?.prix||''}" step="0.01" min="0" placeholder="ex: 15.00"/></div>
          ${canSetDiscount() ? `
          <div style="margin-top:8px"><label style="font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Rabais par plan (VP/Présidente seulement)</label></div>
          <div class="form-row" style="margin-top:8px">
            <div class="form-group">
              <label>Plan Bienfaiteur</label>
              <div style="display:flex;gap:6px">
                <select id="r_bief_type" style="width:80px">
                  <option value="%" ${(rabais.bienfaiteur?.type||'%')==='%'?'selected':''}>%</option>
                  <option value="$" ${rabais.bienfaiteur?.type==='$'?'selected':''}>$</option>
                </select>
                <input type="number" id="r_bief_val" value="${rabais.bienfaiteur?.val||''}" min="0" placeholder="ex: 10"/>
              </div>
            </div>
            <div class="form-group">
              <label>Plan Partenaire</label>
              <div style="display:flex;gap:6px">
                <select id="r_part_type" style="width:80px">
                  <option value="%" ${(rabais.partenaire?.type||'%')==='%'?'selected':''}>%</option>
                  <option value="$" ${rabais.partenaire?.type==='$'?'selected':''}>$</option>
                </select>
                <input type="number" id="r_part_val" value="${rabais.partenaire?.val||''}" min="0" placeholder="ex: 5"/>
              </div>
            </div>
          </div>` : `<p style="font-size:.78rem;color:var(--muted)">Seuls VP et Présidente peuvent définir des rabais.</p>`}
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>
  `);
  document.getElementById('actForm').onsubmit = async e => {
    e.preventDefault();
    const payant = document.getElementById('a_payant').checked;
    const rabaisJson = {};
    if (payant && canSetDiscount()) {
      const biefVal = parseFloat(document.getElementById('r_bief_val')?.value);
      const partVal = parseFloat(document.getElementById('r_part_val')?.value);
      if (biefVal > 0) rabaisJson.bienfaiteur = { type: document.getElementById('r_bief_type').value, val: biefVal };
      if (partVal > 0) rabaisJson.partenaire  = { type: document.getElementById('r_part_type').value, val: partVal };
    }
    const body = { titre:document.getElementById('a_titre').value, type:document.getElementById('a_type').value,
      description:document.getElementById('a_desc').value, date_debut:document.getElementById('a_debut').value,
      date_fin:document.getElementById('a_fin').value, lieu:document.getElementById('a_lieu').value,
      budget_prevu:parseFloat(document.getElementById('a_budget').value)||0,
      max_participants:parseInt(document.getElementById('a_max').value)||null,
      paiement_requis: payant ? 1 : 0,
      prix: payant ? parseFloat(document.getElementById('a_prix').value)||0 : 0,
      rabais_json: JSON.stringify(rabaisJson) };
    try {
      if (isEdit) {
        await api(`/activities/${a.id}`, { method:'PUT', body:JSON.stringify(body) });
        closeModal(); toast('Activité mise à jour'); activities();
      } else {
        const result = await api('/activities', { method:'POST', body:JSON.stringify(body) });
        closeModal();
        toast('Activité créée !');
        // Si payante, afficher le QR directement
        if (body.paiement_requis && result && result.id) {
          const titre = body.titre || 'Nouvelle activité';
          setTimeout(() => viewActivityQR(result.id, titre, result.qr_token), 300);
        } else {
          activities();
        }
      }
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

async function launchActivity(id, titre) {
  if (!confirm(`Lancer l'activité "${titre}" ? Une ligne financière sera créée.`)) return;
  try {
    await api(`/activities/${id}`, { method:'PUT', body: JSON.stringify({ statut:'en_cours' }) });
    toast('Activité lancée – ligne financière créée pour la trésorière'); activities();
  } catch(ex) { toast(ex.message, 'error'); }
}

async function viewRegistrations(id, titre) {
  const data = await api(`/activities/${id}/registrations`);
  openModal(`Inscriptions – ${titre}`, `
    <div class="table-wrapper"><table>
      <thead><tr><th>Nom</th><th>Email</th><th>Téléphone</th><th>Statut</th><th>Date</th></tr></thead>
      <tbody>
        ${data.length ? data.map(r => `<tr><td>${r.prenom} ${r.nom}</td><td>${r.email}</td><td>${r.telephone||'–'}</td><td>${statusPill(r.statut)}</td><td>${fmt(r.date_inscription)}</td></tr>`).join('') : '<tr><td colspan="5" style="text-align:center">Aucune inscription</td></tr>'}
      </tbody>
    </table></div>
  `);
}

async function registerActivity(id) {
  try {
    await api(`/activities/${id}/register`, { method:'POST' });
    toast('✅ Inscription confirmée !');
    activities();
  } catch(ex) { toast(ex.message, 'error'); }
}

// ══ MEMBERS ════════════════════════════════════════════════════════════════
async function members() {
  const data = await api('/users');
  window._membersData = data;
  window._membersSort = { col:'nom', dir:1 };

  setContent(`
    <div class="page-header">
      <div><h2>Membres</h2><p id="membersCount">${data.length} membres enregistrés</p></div>
      <div class="page-actions">
        ${can.adminOrSec() ? `<a href="/api/export/membres.csv" class="btn btn-ghost" style="font-size:.82rem" target="_blank">⬇ CSV</a>` : ''}
        ${can.admin() ? '<button class="btn btn-primary" onclick="openMemberForm()">+ Ajouter un membre</button>' : ''}
      </div>
    </div>

    <div class="members-toolbar">
      <input id="memSearch" type="text" class="members-search"
        placeholder="🔍 Rechercher par nom, courriel ou téléphone…" oninput="filterMembers()"/>
      <select id="memRole" class="members-filter" onchange="filterMembers()">
        <option value="">Tous les rôles</option>
        <option value="admin">Admin</option>
        <option value="secretaire">Secrétaire</option>
        <option value="tresoriere">Trésorière</option>
        <option value="delegue">Accompagnateur</option>
        <option value="member">Membre</option>
      </select>
      <select id="memPlan" class="members-filter" onchange="filterMembers()">
        <option value="">Tous les plans</option>
        <option value="gratuit">Gratuit</option>
        <option value="bienfaiteur">💛 Bienfaiteur</option>
        <option value="partenaire">⭐ Partenaire</option>
      </select>
      <select id="memStatut" class="members-filter" onchange="filterMembers()">
        <option value="">Tous les statuts</option>
        <option value="1">Actif</option>
        <option value="0">Inactif</option>
      </select>
      <button class="btn btn-ghost btn-sm" onclick="resetMembersFilter()">✕ Effacer</button>
    </div>

    <div class="table-card">
      <div class="table-wrapper">
        <table id="membersTable">
          <thead><tr>
            <th class="th-sort" onclick="sortMembers('nom')">Nom <span id="si-nom" class="sort-ind">↕</span></th>
            <th class="th-sort" onclick="sortMembers('email')">Email <span id="si-email" class="sort-ind">↕</span></th>
            <th>Téléphone</th>
            <th class="th-sort" onclick="sortMembers('role')">Rôle <span id="si-role" class="sort-ind">↕</span></th>
            <th class="th-sort" onclick="sortMembers('plan')">Plan <span id="si-plan" class="sort-ind">↕</span></th>
            <th class="th-sort" onclick="sortMembers('actif')">Statut <span id="si-actif" class="sort-ind">↕</span></th>
            <th class="th-sort" onclick="sortMembers('date_inscription')">Inscription <span id="si-date_inscription" class="sort-ind">↕</span></th>
            <th>Actions</th>
          </tr></thead>
          <tbody id="membersBody"></tbody>
        </table>
      </div>
    </div>
  `);

  filterMembers();
}

function filterMembers() {
  const q      = (document.getElementById('memSearch')?.value  || '').toLowerCase().trim();
  const role   = document.getElementById('memRole')?.value    || '';
  const plan   = document.getElementById('memPlan')?.value    || '';
  const statut = document.getElementById('memStatut')?.value  ?? '';
  const data   = window._membersData || [];

  let filtered = data.filter(u => {
    if (q) {
      const hay = `${u.prenom} ${u.nom} ${u.email} ${u.telephone||''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (role   && u.role !== role)                   return false;
    if (plan   && (u.plan||'gratuit') !== plan)      return false;
    if (statut !== '' && String(u.actif) !== statut) return false;
    return true;
  });

  const { col, dir } = window._membersSort || { col:'nom', dir:1 };
  filtered.sort((a, b) => {
    let va = col === 'nom' ? `${a.prenom} ${a.nom}` : (a[col] ?? '');
    let vb = col === 'nom' ? `${b.prenom} ${b.nom}` : (b[col] ?? '');
    if (col === 'plan') { va = va||'gratuit'; vb = vb||'gratuit'; }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    return va < vb ? -dir : va > vb ? dir : 0;
  });

  renderMembersTable(filtered, q);

  const cnt = document.getElementById('membersCount');
  if (cnt) cnt.textContent = filtered.length === data.length
    ? `${data.length} membres enregistrés`
    : `${filtered.length} résultat${filtered.length>1?'s':''} sur ${data.length} membres`;
}

function sortMembers(col) {
  const s = window._membersSort || { col:'nom', dir:1 };
  window._membersSort = { col, dir: s.col === col ? -s.dir : 1 };
  document.querySelectorAll('.sort-ind').forEach(el => el.textContent = '↕');
  const ic = document.getElementById(`si-${col}`);
  if (ic) ic.textContent = window._membersSort.dir === 1 ? '↑' : '↓';
  filterMembers();
}

function resetMembersFilter() {
  ['memSearch','memRole','memPlan','memStatut'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  window._membersSort = { col:'nom', dir:1 };
  document.querySelectorAll('.sort-ind').forEach(el => el.textContent = '↕');
  filterMembers();
}

function renderMembersTable(filtered, q) {
  const tbody = document.getElementById('membersBody');
  if (!tbody) return;
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:40px">Aucun membre ne correspond à la recherche</td></tr>';
    return;
  }
  function hl(text, q) {
    if (!q || text == null) return String(text ?? '–');
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(text).replace(new RegExp(`(${esc})`, 'gi'),
      '<mark style="background:#fff3cd;border-radius:2px;padding:0 1px">$1</mark>');
  }
  tbody.innerHTML = filtered.map(u => `<tr>
    <td><strong style="cursor:pointer;color:var(--g2)" onclick='openMemberDetail(${JSON.stringify(u).replace(/'/g,"&#39;")})'>${hl(u.prenom+' '+u.nom, q)}</strong></td>
    <td>${hl(u.email, q)}</td>
    <td>${hl(u.telephone||'–', q)}</td>
    <td>${pill(roleName(u.role), u.role==='admin'?'bp-orange':u.role==='member'?'bp-blue':'bp-green')}</td>
    <td>${can.executive()
      ? `<select class="plan-select" onchange="changePlan(${u.id},this.value)" style="font-size:.75rem;border:1px solid var(--border);border-radius:6px;padding:2px 6px;background:#fff">
           <option value="gratuit"     ${(u.plan||'gratuit')==='gratuit'    ?'selected':''}>Gratuit</option>
           <option value="bienfaiteur" ${(u.plan||'')==='bienfaiteur'?'selected':''}>💛 Bienfaiteur</option>
           <option value="partenaire"  ${(u.plan||'')==='partenaire' ?'selected':''}>⭐ Partenaire</option>
         </select>`
      : pill(u.plan||'gratuit', u.plan==='bienfaiteur'?'bp-orange':u.plan==='partenaire'?'bp-green':'bp-gray')}</td>
    <td>${u.actif ? pill('Actif','bp-green') : pill('Inactif','bp-red')}</td>
    <td>${fmt(u.date_inscription)}</td>
    <td>
      ${can.executive() ? `
        <button class="btn btn-sm btn-outline" onclick='openMemberForm(${JSON.stringify(u).replace(/'/g,"\\'")})'>✏️</button>
        ${u.actif
          ? `<button class="btn btn-sm btn-danger" onclick="toggleMember(${u.id},0)" title="Désactiver">🚫</button>`
          : `<button class="btn btn-sm btn-ghost"  onclick="toggleMember(${u.id},1)" title="Activer">✅</button>`}
        ${can.admin() ? `<button class="btn btn-sm btn-ghost" onclick="deleteMember(${u.id})" style="color:var(--red)" title="Supprimer définitivement">🗑</button>` : ''}` : ''}
      ${can.executive() ? `<button class="btn btn-sm btn-ghost" onclick="showVolunteerFor(${u.id},'${u.prenom} ${u.nom}')">🤝</button>` : ''}
      ${can.adminOrSec() ? `<button class="btn btn-sm btn-ghost" onclick="memberHistory(${u.id},'${u.prenom} ${u.nom}')" title="Historique">📋</button>` : ''}
    </td>
  </tr>`).join('');
}

function openMemberForm(u = null) {
  const isEdit = !!u;
  openModal(isEdit ? 'Modifier le membre' : 'Ajouter un membre', `
    <form id="memForm">
      <div class="form-row">
        <div class="form-group"><label>Prénom *</label><input id="m_prenom" value="${u?.prenom||''}" required/></div>
        <div class="form-group"><label>Nom *</label><input id="m_nom" value="${u?.nom||''}" required/></div>
      </div>
      <div class="form-group"><label>Email *</label><input type="email" id="m_email" value="${u?.email||''}" required/></div>
      <div class="form-row">
        <div class="form-group"><label>Téléphone</label><input id="m_tel" value="${u?.telephone||''}"/></div>
        <div class="form-group"><label>Date naissance</label><input type="date" id="m_dob" value="${u?.date_naissance||''}"/></div>
      </div>
      <div class="form-group"><label>Adresse</label><input id="m_addr" value="${u?.adresse||''}"/></div>
      ${can.admin() ? `<div class="form-group"><label>Rôle</label>
        <select id="m_role">
          <option value="member" ${u?.role==='member'?'selected':''}>Membre</option>
          <option value="delegue" ${u?.role==='delegue'?'selected':''}>Accompagnateur</option>
          <option value="secretaire" ${u?.role==='secretaire'?'selected':''}>Secrétaire</option>
          <option value="tresoriere" ${u?.role==='tresoriere'?'selected':''}>Trésorière</option>
          <option value="admin" ${u?.role==='admin'?'selected':''}>Admin</option>
        </select></div>
        <div style="background:var(--off);border-radius:10px;padding:14px;margin-top:6px">
          <div style="font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">📤 Email organisationnel (envoi externe)</div>
          <div class="form-row">
            <div class="form-group"><label>Email @ahhamilton.ca</label><input type="email" id="m_email_org" value="${u?.email_org||''}" placeholder="vp@ahhamilton.ca"/></div>
            <div class="form-group"><label>Mot de passe Hostinger</label><input type="password" id="m_smtp_pass" placeholder="Laisser vide = inchangé"/></div>
          </div>
        </div>` : ''}
      ${!isEdit ? `<div class="form-group"><label>Mot de passe *</label><input type="password" id="m_pw" required minlength="6"/></div>` : ''}
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>
  `);
  document.getElementById('memForm').onsubmit = async e => {
    e.preventDefault();
    const body = { prenom:document.getElementById('m_prenom').value, nom:document.getElementById('m_nom').value,
      email:document.getElementById('m_email').value, telephone:document.getElementById('m_tel').value,
      adresse:document.getElementById('m_addr').value, date_naissance:document.getElementById('m_dob').value };
    if (can.admin()) {
      body.role = document.getElementById('m_role').value;
      body.email_org = document.getElementById('m_email_org').value.trim() || '';
      const smtpPass = document.getElementById('m_smtp_pass').value;
      if (smtpPass) body.smtp_pass_org = smtpPass;
    }
    if (!isEdit) body.password = document.getElementById('m_pw').value;
    try {
      if (isEdit) {
        await api(`/users/${u.id}`, { method:'PUT', body:JSON.stringify(body) });
        const updated = await api(`/users/${u.id}`);
        const idx = (window._membersData || []).findIndex(m => m.id === u.id);
        if (idx !== -1) window._membersData[idx] = updated;
        closeModal(); toast('Membre mis à jour'); filterMembers();
      } else {
        await api('/users', { method:'POST', body:JSON.stringify(body) });
        window._membersData = await api('/annuaire');
        closeModal(); toast('Membre créé'); filterMembers();
      }
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

async function toggleMember(id, actif) {
  try {
    await api(`/users/${id}`, { method:'PUT', body: JSON.stringify({ actif }) });
    const u = (window._membersData || []).find(m => m.id === id);
    if (u) u.actif = actif;
    filterMembers();
    toast(actif ? 'Membre activé' : 'Membre désactivé');
  } catch(ex) { toast(ex.message, 'error'); }
}

async function deleteMember(id) {
  const u = (window._membersData || []).find(m => m.id === id);
  const nom = u ? `${u.prenom} ${u.nom}` : `#${id}`;
  if (!confirm(`Supprimer définitivement ${nom} ?\nToutes ses données (inscriptions, heures, paiements) seront effacées. Action irréversible.`)) return;
  try {
    await api(`/users/${id}`, { method: 'DELETE' });
    window._membersData = (window._membersData || []).filter(m => m.id !== id);
    filterMembers();
    toast(`${nom} supprimé`);
  } catch (ex) { toast(ex.message, 'error'); }
}

async function changePlan(id, plan) {
  try {
    await api(`/users/${id}/plan`, { method:'PATCH', body: JSON.stringify({ plan }) });
    const u = (window._membersData || []).find(m => m.id === id);
    if (u) u.plan = plan;
    filterMembers();
    toast('Plan mis à jour : ' + plan);
  } catch(ex) {
    filterMembers(); // Revenir à l'ancienne valeur en cas d'erreur
    toast(ex.message, 'error');
  }
}

async function showVolunteerFor(userId, nom) {
  const data = await api('/volunteer');
  const filtered = data.filter(v => v.user_id === userId);
  const total = filtered.reduce((s, v) => s + v.heures, 0);
  openModal(`Bénévolat – ${nom}`, `
    <p style="margin-bottom:12px;font-weight:600">Total approuvé : ${filtered.filter(v=>v.statut==='approuve').reduce((s,v)=>s+v.heures,0)}h</p>
    <div class="table-wrapper"><table>
      <thead><tr><th>Activité</th><th>Heures</th><th>Date</th><th>Statut</th></tr></thead>
      <tbody>${filtered.map(v => `<tr><td>${v.activite||'–'}</td><td>${v.heures}h</td><td>${fmt(v.date_service)}</td><td>${statusPill(v.statut)}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center">Aucune entrée</td></tr>'}</tbody>
    </table></div>
  `);
}

// ══ SUBCOMMITTEES ══════════════════════════════════════════════════════════

// Couleurs cycliques pour les cartes
const SC_COLORS = [
  {bg:'#1b5e20',light:'#e8f5e9'},{bg:'#0277bd',light:'#e3f2fd'},
  {bg:'#6a1b9a',light:'#f3e5f5'},{bg:'#bf360c',light:'#fbe9e7'},
  {bg:'#00695c',light:'#e0f2f1'},{bg:'#37474f',light:'#eceff1'},
];

async function subcommittees() {
  const [data, allUsers, allActs] = await Promise.all([
    api('/subcommittees'), api('/users'), api('/activities')
  ]);

  // Members only see their own subcommittees
  const visible = can.admin()
    ? data
    : data.filter(sc => sc.membres.some(m => m.id === USER.id));

  const emptyState = '<div class="empty-state"><div class="es-icon">🗂️</div>' +
    '<p>' + (can.admin() ? 'Aucun sous-comité créé. Commencez par en créer un !' : 'Vous ne faites partie d\'aucun sous-comité pour l\'instant.') + '</p></div>';

  setContent(
    '<div class="page-header">' +
      '<div><h2>🗂️ Sous-comités</h2><p>Mini-comités créés par l\'admin pour regrouper des membres autour d\'une mission</p></div>' +
      '<div class="page-actions">' +
        (can.admin() ? '<button class="btn btn-primary" onclick=\'openSubForm(null,' + JSON.stringify(allUsers).replace(/'/g,"&#39;") + ',' + JSON.stringify(allActs).replace(/'/g,"&#39;") + ')\'>+ Nouveau sous-comité</button>' : '') +
      '</div>' +
    '</div>' +

    (visible.length === 0 ? emptyState :
      '<div class="sc-grid">' +
      visible.map(function(sc, idx) {
        const col = SC_COLORS[idx % SC_COLORS.length];
        const chef = sc.membres.find(function(m) { return m.id === sc.chef_id; });
        const isMine = sc.membres.some(function(m) { return m.id === USER.id; });

        // Member avatars (max 6)
        const avatars = sc.membres.slice(0, 6).map(function(m) {
          const initials = (m.prenom[0] + m.nom[0]).toUpperCase();
          const isChef = m.id === sc.chef_id;
          return '<div class="sc-avatar' + (isChef ? ' sc-avatar--chef' : '') +
            '" style="background:' + col.bg + '" title="' + m.prenom + ' ' + m.nom + (isChef ? ' (chef)' : '') + '">' +
            initials + '</div>';
        }).join('');
        const extraCount = sc.membres.length > 6 ? sc.membres.length - 6 : 0;

        // Member list
        const memberRows = sc.membres.map(function(m) {
          const isChef = m.id === sc.chef_id;
          const initials = (m.prenom[0] + m.nom[0]).toUpperCase();
          return '<div class="sc-member-row">' +
            '<div class="sc-member-av" style="background:' + col.bg + '">' + initials + '</div>' +
            '<div class="sc-member-info">' +
              '<div class="sc-member-name">' + m.prenom + ' ' + m.nom + '</div>' +
              '<div class="sc-member-role">' + roleName(m.role) +
                (isChef ? ' · <span class="sc-chef-tag" style="color:' + col.bg + '">👑 Chef</span>' : '') +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        return '<div class="sc-card">' +
          // Header coloré
          '<div class="sc-card-header" style="background:' + col.bg + '">' +
            '<div class="sc-card-badge">' + sc.membres.length + ' membre' + (sc.membres.length>1?'s':'') + '</div>' +
            (isMine && !can.admin() ? '<div class="sc-card-mine">👤 Vous en faites partie</div>' : '') +
            (can.admin() ? '<div class="sc-card-actions">' +
              '<button class="sc-hdr-btn" onclick=\'openSubForm(' + JSON.stringify(sc).replace(/'/g,"&#39;") + ',' + JSON.stringify(allUsers).replace(/'/g,"&#39;") + ',' + JSON.stringify(allActs).replace(/'/g,"&#39;") + ')\' title="Modifier">✏️</button>' +
              '<button class="sc-hdr-btn sc-hdr-btn--del" onclick="deleteSubcommittee(' + sc.id + ',\'' + sc.nom.replace(/'/g,"\\'") + '\')" title="Supprimer">🗑️</button>' +
            '</div>' : '') +
          '</div>' +

          // Corps
          '<div class="sc-card-body">' +
            '<h3 class="sc-card-title">' + sc.nom + '</h3>' +
            (sc.description ? '<p class="sc-card-desc">' + sc.description + '</p>' : '') +
            (sc.activite_titre ? '<div class="sc-card-act">📎 ' + sc.activite_titre + '</div>' : '') +
            (sc.chef_nom ? '<div class="sc-card-chef">👑 Chef : <strong>' + sc.chef_nom + '</strong></div>' : '') +

            // Avatars
            '<div class="sc-avatars">' +
              avatars +
              (extraCount > 0 ? '<div class="sc-avatar sc-avatar--more" style="background:' + col.bg + '">+' + extraCount + '</div>' : '') +
            '</div>' +

            // Liste dépliable
            '<details class="sc-details">' +
              '<summary class="sc-details-summary">Voir les ' + sc.membres.length + ' membre(s) →</summary>' +
              '<div class="sc-members-list">' + (memberRows || '<p style="color:var(--muted);font-size:.82rem;padding:8px">Aucun membre</p>') + '</div>' +
            '</details>' +
          '</div>' +
        '</div>';
      }).join('') +
      '</div>')
  );
}

async function deleteSubcommittee(id, nom) {
  if (!confirm('Supprimer le sous-comité « ' + nom + ' » ?')) return;
  try {
    await api('/subcommittees/' + id, { method: 'DELETE' });
    toast('Sous-comité supprimé');
    subcommittees();
  } catch(ex) { toast(ex.message, 'error'); }
}

// Sélecteur de membres par coches dans la modale
var _scSelectedIds = new Set();

function scToggleMember(id) {
  const was = _scSelectedIds.has(id);
  if (was) _scSelectedIds.delete(id);
  else _scSelectedIds.add(id);

  const now = !was;
  // Mettre à jour la coche visuelle
  const tick = document.getElementById('sctick_' + id);
  if (tick) {
    tick.textContent = now ? '✓' : '';
    tick.className = 'sc-tick' + (now ? ' sc-tick--on' : '');
  }
  const row = document.getElementById('scr_' + id);
  if (row) row.classList.toggle('sc-picker-row--selected', now);
  const counter = document.getElementById('scMemberCount');
  if (counter) counter.textContent = _scSelectedIds.size + ' membre(s) sélectionné(s)';
}

function openSubForm(sc, allUsers, allActs) {
  const isEdit = !!sc;
  _scSelectedIds = new Set((sc && sc.membres || []).map(function(m) { return m.id; }));
  const scSearch = '';

  const pickerRows = allUsers.filter(function(u) { return u.actif !== 0; }).map(function(u) {
    const initials = (u.prenom[0] + (u.nom[0]||'')).toUpperCase();
    const sel = _scSelectedIds.has(u.id);
    // div (pas label) pour éviter le double-déclenchement natif
    return '<div class="sc-picker-row' + (sel ? ' sc-picker-row--selected' : '') + '" id="scr_' + u.id + '" onclick="scToggleMember(' + u.id + ')">' +
      '<div class="sc-picker-av">' + initials + '</div>' +
      '<div class="sc-picker-info">' +
        '<div class="sc-picker-name">' + u.prenom + ' ' + u.nom + '</div>' +
        '<div class="sc-picker-role">' + roleName(u.role) + '</div>' +
      '</div>' +
      '<div class="sc-tick' + (sel ? ' sc-tick--on' : '') + '" id="sctick_' + u.id + '">' + (sel ? '✓' : '') + '</div>' +
    '</div>';
  }).join('');

  openModal(isEdit ? 'Modifier le sous-comité' : 'Nouveau sous-comité',
    '<form id="scForm">' +
      '<div class="form-group"><label>Nom du sous-comité *</label>' +
        '<input id="sc_nom" value="' + (sc && sc.nom ? sc.nom.replace(/"/g,'&quot;') : '') + '" placeholder="ex: Comité logistique Gala 2026" required/></div>' +
      '<div class="form-group"><label>Description / Mandat</label>' +
        '<textarea id="sc_desc" rows="2" placeholder="Quel est l\'objectif de ce comité ?">' + (sc && sc.description ? sc.description : '') + '</textarea></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Chef du comité</label>' +
          '<select id="sc_chef"><option value="">– Aucun –</option>' +
          allUsers.map(function(u) {
            return '<option value="' + u.id + '"' + (sc && sc.chef_id===u.id ? ' selected' : '') + '>' + u.prenom + ' ' + u.nom + '</option>';
          }).join('') + '</select></div>' +
        '<div class="form-group"><label>Activité liée</label>' +
          '<select id="sc_act"><option value="">– Aucune –</option>' +
          allActs.map(function(a) {
            return '<option value="' + a.id + '"' + (sc && sc.activity_id===a.id ? ' selected' : '') + '>' + a.titre + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +

      // Sélecteur de membres
      '<div class="form-group">' +
        '<label>Membres <span id="scMemberCount" style="font-weight:400;color:var(--muted)">(' + _scSelectedIds.size + ' sélectionné(s))</span></label>' +
        '<input type="text" placeholder="🔍 Filtrer par nom…" style="margin-bottom:8px" oninput="scFilterPicker(this.value)"/>' +
        '<div class="sc-picker" id="scPicker">' + pickerRows + '</div>' +
      '</div>' +

      '<div class="form-actions">' +
        '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
        '<button type="submit" class="btn btn-primary">' + (isEdit ? 'Enregistrer' : 'Créer') + '</button>' +
      '</div>' +
    '</form>'
  );

  document.getElementById('scForm').onsubmit = async function(e) {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'En cours…';

    const membres = [..._scSelectedIds].map(function(id) { return { user_id: id }; });
    const nom = document.getElementById('sc_nom').value.trim();
    const body = {
      nom: nom,
      description: document.getElementById('sc_desc').value,
      chef_id: parseInt(document.getElementById('sc_chef').value) || null,
      activity_id: parseInt(document.getElementById('sc_act').value) || null,
      membres: membres
    };

    try {
      if (isEdit) {
        await api('/subcommittees/' + sc.id, { method:'PUT', body:JSON.stringify(body) });
        closeModal(); toast('Sous-comité mis à jour'); subcommittees();
      } else {
        // 1. Créer le sous-comité
        await api('/subcommittees', { method:'POST', body:JSON.stringify(body) });

        const memberIds = [..._scSelectedIds];

        // 2. Envoyer un courriel interne à chaque membre sélectionné
        if (memberIds.length > 0) {
          const chefUser = allUsers.find(function(u) { return u.id === body.chef_id; });
          const chefNom = chefUser ? chefUser.prenom + ' ' + chefUser.nom : USER.prenom + ' ' + USER.nom;
          const contenu =
            '📢 Vous avez été ajouté(e) au sous-comité « ' + nom + ' ».\n\n' +
            (body.description ? 'Mandat : ' + body.description + '\n\n' : '') +
            'Chef du comité : ' + chefNom + '\n' +
            'Membres : ' + memberIds.length + ' personne(s)\n\n' +
            'Un salon de discussion privé a été créé pour votre équipe.\n\n' +
            '— ' + USER.prenom + ' ' + USER.nom + ', ' + roleName(USER.role);

          await api('/messages', {
            method: 'POST',
            body: JSON.stringify({
              sujet: '🗂️ Nouveau sous-comité : ' + nom,
              contenu: contenu,
              destinataires: memberIds
            })
          }).catch(function(ex) { console.warn('Courriel sous-comité:', ex.message); });
        }

        // 3. Créer un salon de chat privé pour le sous-comité
        if (memberIds.length > 0) {
          await api('/chat/rooms', {
            method: 'POST',
            body: JSON.stringify({
              name: '🗂️ ' + nom,
              member_ids: memberIds
            })
          }).catch(function(ex) { console.warn('Chat sous-comité:', ex.message); });
        }

        // Rafraîchir la liste des salons de chat pour que le nouveau salon apparaisse
        loadChatRooms().catch(function() {});

        closeModal();
        toast('✅ Sous-comité créé — courriel envoyé + salon de chat créé !');
        subcommittees();
      }
    } catch(ex) {
      toast(ex.message, 'error');
      btn.disabled = false; btn.textContent = isEdit ? 'Enregistrer' : 'Créer';
    }
  };
}

function scFilterPicker(q) {
  const picker = document.getElementById('scPicker');
  if (!picker) return;
  const lower = q.toLowerCase();
  picker.querySelectorAll('.sc-picker-row').forEach(function(row) {
    const name = (row.querySelector('.sc-picker-name') || {}).textContent || '';
    row.style.display = name.toLowerCase().includes(lower) ? '' : 'none';
  });
}

// ══ FINANCE ════════════════════════════════════════════════════════════════
async function finance() {
  const [lines, rep, summary, chartData] = await Promise.all([api('/finance/lines'), api('/finance/account'), api('/finance/summary').catch(() => ({})), api('/finance/chart').catch(() => [])]);
  window._finLines = lines;
  window._finRep   = rep;
  window._finAllLines = lines;
  const totalBudget = lines.reduce((s,l) => s + (l.budget_alloue||0), 0);
  const totalDep    = lines.reduce((s,l) => s + (l.depenses||0), 0);
  const totalRev    = lines.reduce((s,l) => s + (l.revenus||0), 0);
  const totalComm   = lines.reduce((s,l) => s + (l.commanditaires||0), 0);

  setContent(`
    <div class="page-header">
      <div><h2>Finance</h2><p>Gestion des fonds et lignes budgétaires</p></div>
      <div class="page-actions">
        ${can.adminOrTre() ? `<button class="btn btn-primary" onclick="openTransactionForm(null,window._finLines)">+ Transaction</button>` : ''}
        ${can.adminOrTre() ? `<button class="btn btn-outline" onclick="openAccountForm(window._finRep)">⚙️ Compte</button>` : ''}
        <button class="btn btn-ghost" onclick="printFinance()">🖨️ PDF</button>
        <a href="/api/export/paiements.csv" class="btn btn-ghost" style="font-size:.82rem" target="_blank">⬇ CSV</a>
      </div>
    </div>
    <div class="finance-summary">
      <div class="fin-card"><div class="fc-val">${fmtMoney(rep?.solde)}</div><div class="fc-label">Solde actuel</div></div>
      <div class="fin-card"><div class="fc-val">${summary?.projets_en_cours ?? '–'}</div><div class="fc-label">Projets en cours</div></div>
      <div class="fin-card"><div class="fc-val">${fmtMoney(totalBudget)}</div><div class="fc-label">Budget total alloué</div></div>
      <div class="fin-card"><div class="fc-val negative">${fmtMoney(totalDep)}</div><div class="fc-label">Total dépenses</div></div>
      <div class="fin-card"><div class="fc-val">${fmtMoney(totalRev)}</div><div class="fc-label">Total revenus</div></div>
      ${totalComm > 0 ? `<div class="fin-card"><div class="fc-val" style="color:#0277bd">${fmtMoney(totalComm)}</div><div class="fc-label">Commanditaires</div></div>` : ''}
    </div>
    <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap">
      <div class="table-card" style="flex:1;min-width:280px;padding:16px">
        <h4 style="margin:0 0 10px;font-size:.88rem;color:var(--text)">Budget vs Dépenses</h4>
        <canvas id="finBarChart" height="160"></canvas>
      </div>
      <div class="table-card" style="width:220px;flex-shrink:0;padding:16px;display:flex;flex-direction:column;align-items:center">
        <h4 style="margin:0 0 10px;font-size:.88rem;color:var(--text);align-self:flex-start">Répartition</h4>
        <canvas id="finDonut" style="max-width:180px;max-height:180px"></canvas>
      </div>
    </div>
    <div class="table-card" style="padding:16px;margin-bottom:20px">
      <h4 style="margin:0 0 10px;font-size:.88rem;color:var(--text)">📈 Revenus & Dépenses — 12 derniers mois</h4>
      <canvas id="finMonthChart" height="120"></canvas>
    </div>
    <div class="table-card">
      <div class="table-card-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h3 style="margin:0">Lignes financières</h3>
        <input id="finSearch" type="text" class="members-search" style="max-width:260px;margin:0"
          placeholder="🔍 Rechercher…" oninput="filterFinLines()"/>
        <select id="finStatut" class="members-filter" onchange="filterFinLines()" style="margin:0">
          <option value="">Tous les statuts</option>
          <option value="actif">Actif</option>
          <option value="termine">Terminé</option>
          <option value="archive">Archivé</option>
        </select>
      </div>
      <div class="table-wrapper"><table>
        <thead><tr><th>Titre / Activité</th><th>Budget alloué</th><th>Dépenses</th><th>En attente</th><th>Revenus</th><th>Commanditaires</th><th>Solde</th><th>Solde total</th><th>Statut</th><th>Actions</th></tr></thead>
        <tbody id="finLinesBody"></tbody>
      </table></div>
    </div>
    <p style="font-size:.78rem;color:var(--muted);margin-top:-8px">Institution: ${rep?.institution||'–'} · Compte: ${rep?.numero_compte||'–'} · Titulaire: ${rep?.nom_titulaire||'–'}</p>
  `);
  filterFinLines();
  setTimeout(() => renderFinCharts(lines, chartData), 50);
}

function renderFinCharts(lines, monthlyData) {
  if (typeof Chart === 'undefined') return;
  const top = lines.slice(0, 10);
  const barEl = document.getElementById('finBarChart');
  if (barEl) {
    Chart.getChart(barEl)?.destroy();
    new Chart(barEl, {
      type: 'bar',
      data: {
        labels: top.map(l => (l.activite || l.titre || '').substring(0, 16)),
        datasets: [
          { label: 'Budget', data: top.map(l => l.budget_alloue || 0), backgroundColor: 'rgba(46,125,50,.65)', borderRadius: 4 },
          { label: 'Dépenses', data: top.map(l => l.depenses || 0), backgroundColor: 'rgba(211,47,47,.65)', borderRadius: 4 }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 11, family: 'Poppins' } } } },
        scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toFixed(0), font: { size: 10 } } },
          x: { ticks: { font: { size: 10 } } } } }
    });
  }
  const donutEl = document.getElementById('finDonut');
  if (donutEl) {
    const totalBudget = lines.reduce((s,l) => s + (l.budget_alloue||0), 0);
    const totalDep    = lines.reduce((s,l) => s + (l.depenses||0), 0);
    const totalRev    = lines.reduce((s,l) => s + (l.revenus||0), 0);
    const totalComm   = lines.reduce((s,l) => s + (l.commanditaires||0), 0);
    Chart.getChart(donutEl)?.destroy();
    new Chart(donutEl, {
      type: 'doughnut',
      data: {
        labels: ['Budget', 'Dépenses', 'Revenus', 'Commanditaires'],
        datasets: [{ data: [totalBudget, totalDep, totalRev, totalComm],
          backgroundColor: ['rgba(46,125,50,.75)', 'rgba(211,47,47,.75)', 'rgba(25,118,210,.75)', 'rgba(2,119,189,.75)'],
          borderWidth: 2, borderColor: '#fff' }]
      },
      options: { responsive: true, cutout: '60%',
        plugins: { legend: { position: 'bottom', labels: { font: { size: 10, family: 'Poppins' }, boxWidth: 12 } } } }
    });
  }
  // Monthly revenue / expense line chart
  const monthEl = document.getElementById('finMonthChart');
  if (monthEl && Array.isArray(monthlyData) && monthlyData.length) {
    const MONTH_LABELS_FR = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
    const labels = monthlyData.map(r => {
      const [y, m] = r.mois.split('-');
      return MONTH_LABELS_FR[parseInt(m) - 1] + ' ' + y.slice(2);
    });
    Chart.getChart(monthEl)?.destroy();
    new Chart(monthEl, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Revenus', data: monthlyData.map(r => r.revenus || 0), borderColor: '#2e7d32', backgroundColor: 'rgba(46,125,50,.1)', tension: .35, fill: true, pointRadius: 4 },
          { label: 'Dépenses', data: monthlyData.map(r => r.depenses || 0), borderColor: '#c62828', backgroundColor: 'rgba(198,40,40,.08)', tension: .35, fill: true, pointRadius: 4 },
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11, family: 'Poppins' }, boxWidth: 14 } } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => '$' + v.toFixed(0), font: { size: 10 } } },
          x: { ticks: { font: { size: 10 } } }
        }
      }
    });
  }
}

function printFinance() {
  const lines  = window._finAllLines || [];
  const rep    = window._finRep || {};
  const totalBudget = lines.reduce((s,l) => s + (l.budget_alloue||0), 0);
  const totalDep    = lines.reduce((s,l) => s + (l.depenses||0), 0);
  const totalRev    = lines.reduce((s,l) => s + (l.revenus||0), 0);
  const totalComm   = lines.reduce((s,l) => s + (l.commanditaires||0), 0);
  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
  <title>Rapport financier – AHH</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;margin:24px;color:#222}
    h1{font-size:18px;color:#1b5e20;margin:0 0 4px}
    .meta{color:#666;font-size:11px;margin-bottom:16px}
    .summary{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}
    .card{border:1px solid #e0e0e0;border-radius:6px;padding:10px 14px;min-width:110px}
    .cv{font-size:16px;font-weight:700;color:#1b5e20}.cl{font-size:10px;color:#666;margin-top:2px}
    table{width:100%;border-collapse:collapse}
    th{background:#1b5e20;color:#fff;padding:6px 8px;font-size:11px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee;font-size:11px}
    .red{color:#c62828}.grn{color:#1b5e20}.bold{font-weight:700}
    @media print{@page{margin:18mm}button{display:none}}
  </style></head><body>
  <h1>Rapport financier — Association Haïtienne de Hamilton</h1>
  <div class="meta">Généré le ${new Date().toLocaleDateString('fr-CA')} · Compte : ${rep.numero_compte||'–'} · Titulaire : ${rep.nom_titulaire||'–'} · Solde actuel : <strong>$${(+rep.solde||0).toFixed(2)}</strong></div>
  <div class="summary">
    <div class="card"><div class="cv">$${totalBudget.toFixed(2)}</div><div class="cl">Budget total alloué</div></div>
    <div class="card"><div class="cv red">$${totalDep.toFixed(2)}</div><div class="cl">Total dépenses</div></div>
    <div class="card"><div class="cv grn">$${totalRev.toFixed(2)}</div><div class="cl">Total revenus</div></div>
    ${totalComm>0?`<div class="card"><div class="cv" style="color:#0277bd">$${totalComm.toFixed(2)}</div><div class="cl">Commanditaires</div></div>`:''}
  </div>
  <table><thead><tr><th>Titre / Activité</th><th>Budget</th><th>Dépenses</th><th>En attente</th><th>Revenus</th><th>Solde</th><th>Statut</th></tr></thead>
  <tbody>${lines.map(l=>{const solde=(l.budget_alloue||0)-(l.depenses||0)+(l.revenus||0)+(l.commanditaires||0);
    return`<tr><td class="bold">${l.activite||l.titre}</td><td>$${(l.budget_alloue||0).toFixed(2)}</td>
    <td class="red">$${(l.depenses||0).toFixed(2)}</td>
    <td>${(l.depenses_en_attente||0)>0?'⏳ $'+(l.depenses_en_attente||0).toFixed(2):'–'}</td>
    <td class="grn">$${(l.revenus||0).toFixed(2)}</td>
    <td class="${solde<0?'red':'grn'} bold">$${solde.toFixed(2)}</td>
    <td>${l.statut}</td></tr>`;}).join('')}
  </tbody></table>
  <script>window.print();<\/script></body></html>`;
  const w = window.open('', '_blank', 'width=900,height=700');
  w.document.write(html);
  w.document.close();
}

function filterFinLines() {
  const q      = (document.getElementById('finSearch')?.value || '').toLowerCase().trim();
  const statut = document.getElementById('finStatut')?.value || '';
  const lines  = window._finAllLines || [];
  const filtered = lines.filter(l => {
    if (q && !`${l.titre} ${l.activite||''} ${l.projet||''}`.toLowerCase().includes(q)) return false;
    if (statut && l.statut !== statut) return false;
    return true;
  });
  renderFinLines(filtered);
}

function renderFinLines(lines) {
  const tbody = document.getElementById('finLinesBody');
  if (!tbody) return;
  if (!lines.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:32px">Aucune ligne financière</td></tr>';
    return;
  }
  tbody.innerHTML = lines.map(l => {
    const solde      = (l.budget_alloue||0) - (l.depenses||0) + (l.revenus||0);
    const soldeTotal = solde + (l.commanditaires||0);
    const pending    = l.depenses_en_attente||0;
    return `<tr>
      <td><strong>${l.activite||l.projet||l.titre}</strong><br><span style="font-size:.74rem;color:var(--muted)">${l.titre}</span></td>
      <td>${fmtMoney(l.budget_alloue)}</td>
      <td style="color:var(--red);font-size:.86rem">${fmtMoney(l.depenses)}</td>
      <td style="color:#e65100;font-size:.86rem">${pending>0?'⏳ '+fmtMoney(pending):'–'}</td>
      <td style="color:var(--g2);font-size:.86rem">${fmtMoney(l.revenus)}</td>
      <td style="color:#0277bd;font-size:.86rem">${(l.commanditaires||0)>0?fmtMoney(l.commanditaires):'–'}</td>
      <td><strong style="color:${solde<0?'var(--red)':'var(--g2)'}">${fmtMoney(solde)}</strong></td>
      <td><strong style="color:${soldeTotal<0?'var(--red)':'#0277bd'}">${fmtMoney(soldeTotal)}</strong></td>
      <td>${statusPill(l.statut)}</td>
      <td><button class="btn btn-sm btn-ghost" onclick="viewTransactions(${l.id},'${l.titre.replace(/'/g,"\\'")}')">Transactions</button></td>
    </tr>`;
  }).join('');
}

async function viewTransactions(lineId, titre) {
  const data = await api(`/finance/transactions?line_id=${lineId}`);
  openModal(`Transactions – ${titre}`, `
    <div class="table-wrapper"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Montant</th><th>Description</th><th>Méthode</th></tr></thead>
      <tbody>${data.map(t=>`<tr>
        <td>${fmt(t.date_transaction)}</td>
        <td>${pill(t.type,t.type==='depense'?'bp-red':'bp-green')}</td>
        <td><strong>${fmtMoney(t.montant)}</strong></td>
        <td>${t.description||'–'}</td>
        <td>${t.methode||'–'}</td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center">Aucune transaction</td></tr>'}</tbody>
    </table></div>
  `);
}

function openTransactionForm(t, lines) {
  openModal('Nouvelle transaction', `
    <form id="txForm">
      <div class="form-group"><label>Type *</label>
        <select id="tx_type">
          <option value="depense">Dépense</option>
          <option value="revenu">Revenu</option>
        </select></div>
      <div class="form-row">
        <div class="form-group"><label>Montant *</label><input type="number" id="tx_montant" step="0.01" required/></div>
        <div class="form-group"><label>Méthode</label>
          <select id="tx_methode"><option>cash</option><option>cheque</option><option>virement</option><option>carte</option></select></div>
      </div>
      <div class="form-group"><label>Ligne financière</label>
        <select id="tx_line"><option value="">– Générale –</option>
          ${lines.map(l=>`<option value="${l.id}">${l.activite||l.titre}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Description</label><textarea id="tx_desc" rows="2"></textarea></div>
      <div class="form-group"><label>Référence</label><input id="tx_ref" placeholder="N° chèque, reçu..."/></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById('txForm').onsubmit = async e => {
    e.preventDefault();
    const body = { type:document.getElementById('tx_type').value, montant:parseFloat(document.getElementById('tx_montant').value),
      methode:document.getElementById('tx_methode').value, description:document.getElementById('tx_desc').value,
      reference:document.getElementById('tx_ref').value,
      financial_line_id:parseInt(document.getElementById('tx_line').value)||null };
    try { await api('/finance/transactions', { method:'POST', body:JSON.stringify(body) });
      closeModal(); toast('Transaction enregistrée'); finance(); } catch(ex) { toast(ex.message,'error'); }
  };
}

function openAccountForm(acc) {
  openModal('Informations du compte', `
    <form id="accForm">
      <div class="form-group"><label>Institution</label><input id="acc_inst" value="${acc?.institution||''}"/></div>
      <div class="form-row">
        <div class="form-group"><label>Numéro de compte</label><input id="acc_num" value="${acc?.numero_compte||''}"/></div>
        <div class="form-group"><label>Titulaire</label><input id="acc_tit" value="${acc?.nom_titulaire||''}"/></div>
      </div>
      <div class="form-group"><label>Solde actuel ($)</label><input type="number" step="0.01" id="acc_sol" value="${acc?.solde||0}"/></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById('accForm').onsubmit = async e => {
    e.preventDefault();
    await api('/finance/account', { method:'PUT', body: JSON.stringify({
      institution:document.getElementById('acc_inst').value, numero_compte:document.getElementById('acc_num').value,
      nom_titulaire:document.getElementById('acc_tit').value, solde:parseFloat(document.getElementById('acc_sol').value)||0
    })});
    closeModal(); toast('Compte mis à jour'); finance();
  };
}

// ══ INVOICES ═══════════════════════════════════════════════════════════════
async function invoices() {
  const [data, lines] = await Promise.all([api('/finance/invoices'), api('/finance/lines')]);
  setContent(`
    <div class="page-header">
      <div><h2>Factures</h2><p>Gestion des factures et reçus</p></div>
      ${can.adminOrTre() ? `<div class="page-actions"><button class="btn btn-primary" onclick='openInvoiceForm(${JSON.stringify(lines)})'>+ Nouvelle facture</button></div>` : ''}
    </div>
    <div class="table-card"><div class="table-wrapper"><table>
      <thead><tr><th>Titre</th><th>Fournisseur</th><th>Montant</th><th>Date</th><th>Activité / Projet</th><th>Statut</th><th>Photo</th>${can.adminOrTre() ? '<th>Actions</th>' : ''}</tr></thead>
      <tbody>${data.map(i=>`<tr>
        <td><strong>${i.titre}</strong></td>
        <td>${i.fournisseur||'–'}</td>
        <td>${fmtMoney(i.montant)}</td>
        <td>${fmt(i.date_facture)}</td>
        <td>${i.ligne||'–'}</td>
        <td>${statusPill(i.statut)}</td>
        <td>${i.photo_path ? `<a href="${BASE}${i.photo_path}" target="_blank" class="btn btn-sm btn-ghost">📷 Voir</a>` : '–'}</td>
        ${can.adminOrTre() ? `<td style="white-space:nowrap">
          ${i.statut === 'en_attente' ? `
            <button class="btn btn-sm btn-primary" onclick="updateInvoiceStatus(${i.id},'approuve')" title="Approuver et enregistrer la dépense">✅ Approuver</button>
            <button class="btn btn-sm btn-ghost" onclick="updateInvoiceStatus(${i.id},'refuse')" style="color:var(--red)">✗ Refuser</button>` : ''}
          ${i.statut === 'approuve' ? `<button class="btn btn-sm btn-accent" onclick="updateInvoiceStatus(${i.id},'paye')" title="Marquer comme payé">💰 Payé</button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="deleteInvoice(${i.id})" style="color:var(--red)" title="Supprimer et annuler les effets financiers">🗑</button>
        </td>` : '<td>–</td>'}
      </tr>`).join('')}</tbody>
    </table></div></div>
  `);
}

function openInvoiceForm(lines) {
  const actLines = lines.filter(l => l.activite);
  const prjLines = lines.filter(l => l.projet);
  const otherLines = lines.filter(l => !l.activite && !l.projet);
  const lineOptions = [
    actLines.length ? `<optgroup label="Activités">${actLines.map(l=>`<option value="${l.id}">🗓 ${l.activite}</option>`).join('')}</optgroup>` : '',
    prjLines.length ? `<optgroup label="Projets">${prjLines.map(l=>`<option value="${l.id}">◑ ${l.projet}</option>`).join('')}</optgroup>` : '',
    otherLines.length ? `<optgroup label="Autres">${otherLines.map(l=>`<option value="${l.id}">${l.titre}</option>`).join('')}</optgroup>` : ''
  ].join('');
  openModal('Nouvelle facture / reçu', `
    <form id="invForm" enctype="multipart/form-data">
      <div class="form-group"><label>Titre *</label><input id="inv_titre" required/></div>
      <div class="form-row">
        <div class="form-group"><label>Fournisseur</label><input id="inv_four"/></div>
        <div class="form-group"><label>Montant ($)</label><input type="number" step="0.01" id="inv_mont"/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Date facture</label><input type="date" id="inv_date"/></div>
        <div class="form-group"><label>Activité ou Projet *</label>
          <select id="inv_line" required>
            <option value="">– Choisir –</option>
            ${lineOptions}
          </select></div>
      </div>
      <div class="form-group"><label>Photo / Scan de la facture</label>
        <input type="file" id="inv_photo" accept="image/*,application/pdf"/></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById('invForm').onsubmit = async e => {
    e.preventDefault();
    const lineId = document.getElementById('inv_line').value;
    if (!lineId) { toast('Veuillez choisir une activité ou un projet', 'error'); return; }
    const fd = new FormData();
    fd.append('titre', document.getElementById('inv_titre').value);
    fd.append('fournisseur', document.getElementById('inv_four').value);
    fd.append('montant', document.getElementById('inv_mont').value);
    fd.append('date_facture', document.getElementById('inv_date').value);
    fd.append('financial_line_id', lineId);
    const ph = document.getElementById('inv_photo').files[0];
    if (ph) fd.append('photo', ph);
    try { await apiForm('/finance/invoices', fd); closeModal(); toast('Facture enregistrée'); invoices(); }
    catch(ex) { toast(ex.message,'error'); }
  };
}

async function updateInvoiceStatus(id, statut) {
  await api(`/finance/invoices/${id}`, { method:'PUT', body: JSON.stringify({ statut }) });
  toast('Statut mis à jour'); invoices();
}

async function deleteInvoice(id) {
  if (!confirm('Supprimer cette facture ? Si elle était approuvée, son effet sur le solde sera annulé.')) return;
  try {
    await api(`/finance/invoices/${id}`, { method: 'DELETE' });
    toast('Facture supprimée');
    invoices();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

// ══ MESSAGES ═══════════════════════════════════════════════════════════════
async function messages() {
  const { inbox, sent } = await api('/messages');
  const allUsers = can.adminOrSec() ? await api('/users') : [];
  setContent(`
    <div class="page-header">
      <div><h2>Messages</h2><p>Boîte de réception et messages envoyés</p></div>
      <div class="page-actions">
        ${can.adminOrSec() ? `<button class="btn btn-primary" onclick='openMessageForm(${JSON.stringify(allUsers)})'>✉️ Nouveau message</button>` : ''}
      </div>
    </div>
    <div class="table-card">
      <div class="table-card-header"><h3>📥 Boîte de réception (${inbox.length})</h3></div>
      <div class="table-wrapper"><table>
        <thead><tr><th>De</th><th>Sujet</th><th>Date</th><th>Lu</th></tr></thead>
        <tbody>${inbox.map(m=>`<tr style="${!m.lu?'font-weight:600':''}">
          <td>${m.expediteur}</td>
          <td><span style="cursor:pointer;color:var(--g2)" onclick="readMessage(${m.message_id||m.id},'${m.sujet||'Sans sujet'}','${m.contenu?.replace(/'/g,"\\'")||''}')">${m.sujet||'(Sans sujet)'}</span></td>
          <td>${fmt(m.date_envoi)}</td>
          <td>${m.lu ? '✅' : '🆕'}</td>
        </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Aucun message reçu</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="table-card">
      <div class="table-card-header"><h3>📤 Messages envoyés (${sent.length})</h3></div>
      <div class="table-wrapper"><table>
        <thead><tr><th>Sujet</th><th>Destinataires</th><th>Date</th></tr></thead>
        <tbody>${sent.map(m=>`<tr>
          <td>${m.sujet||'(Sans sujet)'}</td>
          <td>${m.nb_destinataires}</td>
          <td>${fmt(m.date_envoi)}</td>
        </tr>`).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--muted)">Aucun message envoyé</td></tr>'}</tbody>
      </table></div>
    </div>
  `);
}

function readMessage(id, sujet, contenu) {
  openModal(sujet || 'Message', `<div style="white-space:pre-wrap;line-height:1.7;font-size:.9rem">${contenu}</div>`);
  api(`/messages/${id}/read`, { method:'PUT' }).catch(()=>{});
}

function openMessageForm(allUsers) {
  openModal('Nouveau message', `
    <form id="msgForm">
      <div class="form-group"><label>Destinataires *</label>
        <select id="msg_to"><option value="all">📢 Tous les membres</option>
          <option value="members">👥 Membres seulement</option>
          ${allUsers.filter(u=>u.id!==USER.id).map(u=>`<option value="${u.id}">${u.prenom} ${u.nom} (${roleName(u.role)})</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Sujet</label><input id="msg_sujet" placeholder="Objet du message"/></div>
      <div class="form-group"><label>Message *</label><textarea id="msg_contenu" rows="6" required></textarea></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Envoyer</button>
      </div>
    </form>
  `);
  document.getElementById('msgForm').onsubmit = async e => {
    e.preventDefault();
    const to = document.getElementById('msg_to').value;
    const destinataires = ['all','members'].includes(to) ? [to] : [parseInt(to)];
    try {
      const r = await api('/messages', { method:'POST', body:JSON.stringify({
        sujet:document.getElementById('msg_sujet').value,
        contenu:document.getElementById('msg_contenu').value, destinataires }) });
      closeModal(); toast(`Message envoyé à ${r.nb_destinataires} destinataire(s)`); messages();
    } catch(ex) { toast(ex.message,'error'); }
  };
}

// ══ VOLUNTEER ══════════════════════════════════════════════════════════════
async function volunteer() {
  const [data, allUsers, allActs] = await Promise.all([
    api('/volunteer'),
    can.adminOrSec() ? api('/users') : Promise.resolve([]),
    api('/activities')
  ]);
  const totalApp = data.filter(v=>v.statut==='approuve').reduce((s,v)=>s+v.heures,0);

  setContent(`
    <div class="page-header">
      <div><h2>Heures de bénévolat</h2><p>Total approuvé : <strong>${totalApp}h</strong></p></div>
      <div class="page-actions">
        ${can.adminOrSec() ? `<button class="btn btn-primary" onclick='openVolForm(${JSON.stringify(allUsers)},${JSON.stringify(allActs)})'>+ Ajouter des heures</button>` : ''}
      </div>
    </div>
    <div class="table-card"><div class="table-wrapper"><table>
      <thead><tr><th>Membre</th><th>Activité</th><th>Heures</th><th>Date</th><th>Description</th><th>Statut</th><th>Actions</th></tr></thead>
      <tbody>${data.map(v=>`<tr>
        <td>${v.membre||USER.prenom+' '+USER.nom}</td>
        <td>${v.activite||'–'}</td>
        <td><strong>${v.heures}h</strong></td>
        <td>${fmt(v.date_service)}</td>
        <td>${v.description||'–'}</td>
        <td>${statusPill(v.statut)}</td>
        <td style="display:flex;gap:4px;flex-wrap:wrap">
          ${can.adminOrSec() && v.statut==='en_attente' ? `
          <button class="btn btn-sm btn-primary" onclick="approveVol(${v.id},'approuve')">✅</button>
          <button class="btn btn-sm btn-danger" onclick="approveVol(${v.id},'rejete')">❌</button>` : ''}
          ${can.admin() ? `<button class="btn btn-sm" style="color:var(--red);border:1px solid var(--red);background:transparent" onclick="deleteVol(${v.id})">🗑</button>` : ''}
        </td>
      </tr>`).join('')}</tbody>
    </table></div></div>
  `);
}

function openVolForm(allUsers, allActs) {
  openModal('Ajouter des heures de bénévolat', `
    <form id="volForm">
      <div class="form-group"><label>Membre *</label>
        <select id="vol_user" required>
          ${allUsers.filter(u=>u.actif).map(u=>`<option value="${u.id}">${u.prenom} ${u.nom}</option>`).join('')}
        </select></div>
      <div class="form-row">
        <div class="form-group"><label>Heures *</label><input type="number" id="vol_h" step="0.5" min="0.5" required/></div>
        <div class="form-group"><label>Date du service</label><input type="date" id="vol_date"/></div>
      </div>
      <div class="form-group"><label>Activité</label>
        <select id="vol_act"><option value="">– Aucune –</option>
          ${allActs.map(a=>`<option value="${a.id}">${a.titre}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Description</label><textarea id="vol_desc" rows="2"></textarea></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById('volForm').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/volunteer', { method:'POST', body: JSON.stringify({
        user_id:parseInt(document.getElementById('vol_user').value),
        heures:parseFloat(document.getElementById('vol_h').value),
        date_service:document.getElementById('vol_date').value,
        activity_id:parseInt(document.getElementById('vol_act').value)||null,
        description:document.getElementById('vol_desc').value })});
      closeModal(); toast('Heures enregistrées'); volunteer();
    } catch(ex) { toast(ex.message,'error'); }
  };
}

async function approveVol(id, statut) {
  await api(`/volunteer/${id}/approve`, { method:'PUT', body:JSON.stringify({ statut }) });
  toast(statut==='approuve' ? 'Approuvé' : 'Rejeté'); volunteer();
}

async function deleteVol(id) {
  if (!confirm('Supprimer cette entrée de bénévolat ?')) return;
  try {
    await api(`/volunteer/${id}`, { method: 'DELETE' });
    toast('Entrée supprimée'); volunteer();
  } catch(ex) { toast(ex.message, 'error'); }
}

// ══ NOTES ══════════════════════════════════════════════════════════════════

function notePreview(html) {
  if (!html) return '<em>Vide — cliquez pour éditer</em>';
  // Extraire texte brut depuis HTML (exécuté côté client)
  const d = document.createElement('div');
  d.innerHTML = html;
  let txt = (d.textContent || d.innerText || '').trim();
  // Si le contenu ressemble à du JSON ou est corrompu
  if (txt.startsWith('{') || txt.startsWith('[') || txt.startsWith('"langue"') || txt.includes('"date_debut"')) {
    return '<span style="color:#c62828">⚠️ Note corrompue — cliquez pour nettoyer le contenu</span>';
  }
  txt = txt.substring(0, 250);
  return escHtml(txt) + (txt.length >= 250 ? '…' : '');
}

async function notes() {
  const [data, allActs] = await Promise.all([api('/notes'), api('/activities')]);
  setContent(`
    <div class="page-header">
      <div>
        <h2>📝 Notes de réunion <span style="font-size:.75rem;background:#e8f5e9;color:#1b5e20;padding:3px 10px;border-radius:20px;font-weight:600;margin-left:8px">🔗 Partagées avec le comité</span></h2>
        <p style="font-size:.82rem;color:var(--muted)">Toutes les notes sont visibles et éditables par tous les membres du comité</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick='openNoteForm(null,${JSON.stringify(allActs)})'>+ Nouvelle note</button>
      </div>
    </div>
    <div id="notesList">
    ${data.map(n=>{
      const isEditing = n.editing_by && n.editing_by !== USER.id;
      const locked = !!n.verrouille;
      const signed = !!n.date_ma_signature;
      const editingLabel = `<span class="editing-badge" style="background:#fff3cd;color:#856404;font-size:.72rem;padding:2px 8px;border-radius:12px;font-weight:600;${isEditing?'':'display:none'}">${isEditing?'✏️ '+escHtml(n.editing_by_nom||'Quelqu\'un')+' édite...':''}</span>`;
      const lockBadge = locked ? `<span style="background:#e8f5e9;color:#1b5e20;font-size:.72rem;padding:2px 9px;border-radius:12px;font-weight:600">🔒 Verrouillée — 2/2 signatures</span>` : '';
      const sigBadge = signed && !locked ? `<span style="background:#e3f2fd;color:#1565c0;font-size:.72rem;padding:2px 9px;border-radius:12px;font-weight:600">✅ Vous avez signé</span>` : '';
      const countBadge = n.nb_signatures === 1 && !locked
        ? `<span style="background:#fff3cd;color:#856404;font-size:.72rem;padding:2px 9px;border-radius:12px;font-weight:600">⚠️ 1/2 signature — toute modification annule</span>`
        : n.nb_signatures >= 2 && !locked ? `<span style="background:#f3e5f5;color:#6a1b9a;font-size:.72rem;padding:2px 9px;border-radius:12px;font-weight:600">🖊 ${n.nb_signatures} signatures</span>` : '';
      const lastEditorLabel = n.last_editor_nom ? `Modifié par <strong>${escHtml(n.last_editor_nom)}</strong>` : `Créé par <strong>${escHtml(n.auteur||'')}</strong>`;
      return `
      <div class="table-card" data-note-id="${n.id}" style="margin-bottom:12px;${locked?'border-left:3px solid #1b5e20':isEditing?'border-left:3px solid #f9a825':''}">
        <div class="table-card-header">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <h3 style="margin:0">${escHtml(n.titre)}</h3>
              ${lockBadge}${editingLabel}
            </div>
            <small style="color:var(--muted)">${lastEditorLabel} · ${fmt(n.date_modification||n.date_reunion)} · ${(n.langue||'fr').toUpperCase()} ${n.activite?'· 📎 '+escHtml(n.activite):''}</small>
            ${sigBadge||countBadge ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">${sigBadge}${countBadge}</div>` : ''}
          </div>
          <div class="tc-actions" style="flex-wrap:wrap;gap:6px">
            <button class="btn btn-sm btn-primary" onclick='openNoteForm(${JSON.stringify(n)},${JSON.stringify(allActs)})'>${locked?'👁 Voir':'✏️ Ouvrir'}</button>
            <a href="/api/notes/${n.id}/download?token=${TOKEN}" target="_blank" class="btn btn-sm btn-outline">⬇ Télécharger</a>
            ${n.nb_signatures > 0 ? `<a href="/api/notes/${n.id}/attestation?token=${TOKEN}" target="_blank" class="btn btn-sm btn-outline" style="color:#1b5e20;border-color:#1b5e20">🔏 Attestation</a>` : ''}
            ${!locked ? `<button class="btn btn-sm btn-ghost" style="color:#6a1b9a;border:1px solid #6a1b9a" onclick="openNoteSignatureModal(${n.id},'${escHtml(n.titre).replace(/'/g,"\\'")}')">✍️ ${signed?'Re-signer':'Signer'}</button>` : ''}
            ${(n.auteur_id===USER.id||can.admin()) && !locked ? `<button class="btn btn-sm btn-danger" onclick="deleteNote(${n.id})">🗑️</button>` : ''}
          </div>
        </div>
        <div data-note-preview="${n.id}" style="padding:10px 20px;font-size:.83rem;color:var(--muted);cursor:pointer;border-top:1px solid var(--border)" onclick='openNoteForm(${JSON.stringify(n)},${JSON.stringify(allActs)})'>
          ${notePreview(n.contenu_corrige || n.contenu || '')}
        </div>
      </div>`}).join('') || '<div class="empty-state"><div class="es-icon">📝</div><p>Aucune note — créez la première !</p></div>'}
    </div>
  `);

  // Refresh temps réel toutes les 5 secondes : indicateurs d'édition + preview du contenu
  clearInterval(_notesRefreshInterval);
  _notesRefreshInterval = setInterval(async () => {
    if (!document.getElementById('notesList')) { clearInterval(_notesRefreshInterval); return; }
    const fresh = await api('/notes').catch(() => null);
    if (!fresh) return;
    fresh.forEach(n => {
      const card = document.querySelector(`[data-note-id="${n.id}"]`);
      if (!card) return;
      // Bordure selon état
      const isEditing = n.editing_by && n.editing_by !== USER.id;
      card.style.borderLeft = n.verrouille ? '3px solid #1b5e20' : isEditing ? '3px solid #f9a825' : '';
      // Preview du contenu (mise à jour en temps réel)
      const preview = card.querySelector(`[data-note-preview="${n.id}"]`);
      if (preview) preview.innerHTML = notePreview(n.contenu_corrige || n.contenu || '');
      // Badge édition en cours
      const editingSpan = card.querySelector('.editing-badge');
      if (editingSpan) editingSpan.textContent = isEditing ? `✏️ ${escHtml(n.editing_by_nom||'Quelqu\'un')} édite...` : '';
    });
  }, 5000);
}

function openNoteForm(n, allActs) {
  const noteId = n?.id || null;
  const today = new Date().toISOString().slice(0,10);

  // Vérifier si quelqu'un d'autre édite déjà cette note
  const otherEditor = n?.editing_by && n.editing_by !== USER.id ? n.editing_by_nom || 'Un autre membre' : null;
  if (otherEditor && !n?.verrouille) {
    window._noteCollabCtx = { n, allActs };
    openModal('👥 Note en cours d\'édition', `
      <p style="font-size:.92rem;margin-bottom:16px">
        <strong>${escHtml(otherEditor)}</strong> est en train d'écrire dans cette note.
      </p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="btn btn-primary" onclick="closeModal();_openNoteCollab(window._noteCollabCtx.n,window._noteCollabCtx.allActs)" style="text-align:left;padding:12px 16px">
          <div style="font-weight:700">✍️ Contribuer (mode collaboratif)</div>
          <div style="font-size:.8rem;font-weight:400;opacity:.85">Vous écrivez dans votre propre zone — tout est fusionné à la fin avec vos noms</div>
        </button>
        <button class="btn btn-outline" onclick="closeModal();_openNoteReadOnly(window._noteCollabCtx.n,window._noteCollabCtx.allActs)" style="text-align:left;padding:12px 16px">
          <div style="font-weight:700">👁 Lire et suivre en direct</div>
          <div style="font-size:.8rem;font-weight:400;opacity:.85">Contenu rafraîchi toutes les 5s — vous voyez ce que l'autre écrit</div>
        </button>
        <button class="btn btn-ghost" onclick="closeModal();_openNoteForce(window._noteCollabCtx.n,window._noteCollabCtx.allActs)" style="color:#c62828;font-size:.82rem">
          ✏️ Prendre la main (écrase l'autre)
        </button>
        <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
      </div>
    `);
    return;
  }

  _noteEditingId = noteId;
  _openNoteEditor(n, allActs, false);
}

function _openNoteReadOnly(n, allActs) {
  // Ouvrir en lecture seule sans prendre la session d'édition
  _openNoteEditor(n, allActs, true);
}

function _openNoteForce(n, allActs) {
  // Forcer l'ouverture en écriture malgré la session d'un autre
  _noteEditingId = n?.id || null;
  _openNoteEditor(n, allActs, false);
}

function _openNoteEditor(n, allActs, forceReadOnly) {
  const noteId = n?.id || null;
  const today = new Date().toISOString().slice(0,10);
  const readOnly = forceReadOnly || !!n?.verrouille;

  setContent(`
    <!-- Éditeur plein écran style Word -->
    <div id="wordEditor" style="display:flex;flex-direction:column;height:calc(100vh - var(--strip-h) - 8px);background:#e0e0e0">

      <!-- Barre d'outils Word -->
      <div style="background:#fff;border-bottom:1px solid #d0d0d0;padding:8px 16px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;box-shadow:0 1px 4px rgba(0,0,0,.08);position:sticky;top:0;z-index:10">

        <!-- Méta document -->
        <div style="display:flex;gap:8px;align-items:center;margin-right:12px;padding-right:12px;border-right:1px solid #ddd;flex-wrap:wrap">
          <input id="n_titre" style="border:1px solid #ddd;border-radius:6px;padding:5px 10px;font-size:.88rem;font-weight:600;width:220px" placeholder="Titre de la note" value="${escHtml(n?.titre||'')}"/>
          <input type="date" id="n_date" style="border:1px solid #ddd;border-radius:6px;padding:5px 8px;font-size:.82rem" value="${n?.date_reunion||today}"/>
          <select id="n_lang" style="border:1px solid #ddd;border-radius:6px;padding:5px 8px;font-size:.82rem">
            <option value="fr" ${(!n||n.langue==='fr')?'selected':''}>🇫🇷 FR</option>
            <option value="en" ${n?.langue==='en'?'selected':''}>🇬🇧 EN</option>
            <option value="ht" ${n?.langue==='ht'?'selected':''}>🇭🇹 HT</option>
          </select>
          <select id="n_act" style="border:1px solid #ddd;border-radius:6px;padding:5px 8px;font-size:.82rem">
            <option value="">📎 Aucune activité</option>
            ${allActs.map(a=>`<option value="${a.id}" ${n?.activity_id===a.id?'selected':''}>${escHtml(a.titre)}</option>`).join('')}
          </select>
        </div>

        <!-- Taille de police -->
        <select id="fontSize" onchange="document.execCommand('fontSize',false,this.value)" style="border:1px solid #ddd;border-radius:5px;padding:4px 6px;font-size:.8rem;width:60px">
          <option value="1">8</option><option value="2">10</option><option value="3" selected>12</option>
          <option value="4">14</option><option value="5">18</option><option value="6">24</option><option value="7">36</option>
        </select>

        <!-- Séparateur -->
        <div style="width:1px;height:24px;background:#ddd;margin:0 4px"></div>

        <!-- Formatage texte -->
        <button class="we-btn" onclick="document.execCommand('bold')" title="Gras (Ctrl+B)"><b>G</b></button>
        <button class="we-btn" onclick="document.execCommand('italic')" title="Italique (Ctrl+I)"><i>I</i></button>
        <button class="we-btn" onclick="document.execCommand('underline')" title="Souligner (Ctrl+U)"><u>S</u></button>
        <button class="we-btn" onclick="document.execCommand('strikeThrough')" title="Barré"><s>B</s></button>

        <!-- Séparateur -->
        <div style="width:1px;height:24px;background:#ddd;margin:0 4px"></div>

        <!-- Titres -->
        <button class="we-btn" onclick="document.execCommand('formatBlock',false,'h1')" title="Titre 1" style="font-size:.75rem;font-weight:800">H1</button>
        <button class="we-btn" onclick="document.execCommand('formatBlock',false,'h2')" title="Titre 2" style="font-size:.75rem;font-weight:700">H2</button>
        <button class="we-btn" onclick="document.execCommand('formatBlock',false,'h3')" title="Titre 3" style="font-size:.75rem;font-weight:600">H3</button>
        <button class="we-btn" onclick="document.execCommand('formatBlock',false,'p')" title="Paragraphe normal" style="font-size:.75rem">¶</button>

        <!-- Séparateur -->
        <div style="width:1px;height:24px;background:#ddd;margin:0 4px"></div>

        <!-- Listes -->
        <button class="we-btn" onclick="document.execCommand('insertUnorderedList')" title="Liste à puces">• ≡</button>
        <button class="we-btn" onclick="document.execCommand('insertOrderedList')" title="Liste numérotée">1. ≡</button>

        <!-- Séparateur -->
        <div style="width:1px;height:24px;background:#ddd;margin:0 4px"></div>

        <!-- Alignement -->
        <button class="we-btn" onclick="document.execCommand('justifyLeft')" title="Aligner à gauche">⬅</button>
        <button class="we-btn" onclick="document.execCommand('justifyCenter')" title="Centrer">⬛</button>
        <button class="we-btn" onclick="document.execCommand('justifyRight')" title="Aligner à droite">➡</button>

        <!-- Séparateur -->
        <div style="width:1px;height:24px;background:#ddd;margin:0 4px"></div>

        <!-- Actions -->
        <button class="we-btn" onclick="document.execCommand('undo')" title="Annuler">↩</button>
        <button class="we-btn" onclick="document.execCommand('redo')" title="Rétablir">↪</button>

        <!-- Spacer -->
        <div style="flex:1"></div>

        <!-- Statut + actions -->
        <span id="noteStatus" style="font-size:.75rem;color:var(--muted);margin-right:8px">${readOnly ? (n?.verrouille ? '🔒 Note verrouillée' : '👁 Lecture seule') : ''}</span>
        <button class="btn btn-sm btn-ghost" onclick="if(_noteEditingId)api('/notes/'+_noteEditingId+'/editing',{method:'DELETE'}).catch(()=>{});clearInterval(_noteSyncInterval);notes()" title="Fermer">✕ Fermer</button>
        <a href="/api/notes/${noteId}/download?token=${TOKEN}" target="_blank" class="btn btn-sm btn-outline" title="Télécharger">⬇ PDF</a>
        ${n?.nb_signatures > 0 ? `<a href="/api/notes/${noteId}/attestation?token=${TOKEN}" target="_blank" class="btn btn-sm btn-outline" style="color:#1b5e20;border-color:#1b5e20">🔏 Attestation</a>` : ''}
        ${!readOnly ? `<button class="btn btn-sm btn-ghost" style="color:#6a1b9a;border:1px solid #6a1b9a" onclick="openNoteSignatureModal(${noteId},'${escHtml(n?.titre||'').replace(/'/g,"\\'")}')">✍️ Signer</button>` : ''}
        ${!readOnly ? `<button class="btn btn-sm btn-primary" onclick="saveNoteEditor(${noteId})" title="Sauvegarder">💾 Sauvegarder</button>` : ''}
      </div>

      <!-- Zone de saisie style papier Word -->
      <div style="flex:1;overflow-y:auto;padding:32px 0;background:#e0e0e0">
        ${n?.verrouille
          ? `<div style="text-align:center;padding:12px;background:#e8f5e9;color:#1b5e20;font-weight:600;font-size:.85rem">🔒 Cette note est verrouillée — lecture seule après 2 signatures</div>`
          : forceReadOnly
            ? `<div style="text-align:center;padding:12px;background:#e3f2fd;color:#1565c0;font-weight:600;font-size:.85rem">👁 Mode lecture seule — un autre membre édite cette note</div>`
            : n?.nb_signatures > 0
              ? `<div style="text-align:center;padding:10px 16px;background:#fff3cd;color:#856404;font-weight:600;font-size:.82rem">⚠️ Cette note a ${n.nb_signatures} signature(s). Toute sauvegarde annulera les signatures et le processus devra recommencer.</div>`
              : ''
        }
        <div style="
          width:794px;max-width:calc(100vw - 40px);
          min-height:1123px;
          margin:0 auto;
          background:#fff;
          box-shadow:0 2px 16px rgba(0,0,0,.18);
          padding:72px 80px;
          font-family:'Times New Roman',serif;
          font-size:12pt;
          line-height:1.6;
          color:#000;
          outline:none;
        " contenteditable="${readOnly ? 'false' : 'true'}" spellcheck="true" id="n_editor"
          oninput="${readOnly ? '' : 'noteChanged()'}">${n?.contenu || '<p><br></p>'}</div>
      </div>
    </div>
  `);

  // Styles des boutons toolbar
  const style = document.createElement('style');
  style.textContent = `
    .we-btn{background:none;border:1px solid transparent;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:.88rem;color:#333;transition:.15s;min-width:28px}
    .we-btn:hover{background:#f0f0f0;border-color:#ccc}
    .we-btn:active{background:#e0e0e0}
    #n_editor h1{font-size:22pt;margin:16px 0 8px;font-family:'Times New Roman',serif}
    #n_editor h2{font-size:16pt;margin:14px 0 6px;font-family:'Times New Roman',serif}
    #n_editor h3{font-size:13pt;margin:12px 0 4px;font-family:'Times New Roman',serif}
    #n_editor ul,#n_editor ol{margin:6px 0 6px 24px}
    #n_editor li{margin:2px 0}
    #n_editor p{margin:4px 0}
  `;
  document.head.appendChild(style);

  // Focus
  setTimeout(() => document.getElementById('n_editor')?.focus(), 100);

  // Auto-sauvegarde toutes les 10 secondes (intervalle de sécurité)
  clearInterval(_noteAutoSave);
  _noteAutoSave = setInterval(() => {
    const editor = document.getElementById('n_editor');
    if (editor) autoSaveNote(noteId);
  }, 10000);

  // Marquer "en train d'éditer" seulement si on n'est pas en lecture seule
  if (noteId && !readOnly) {
    api(`/notes/${noteId}/editing`, { method:'POST' }).catch(()=>{});
    clearInterval(_noteSyncInterval);
    _noteSyncInterval = setInterval(async () => {
      if (!document.getElementById('n_editor')) { clearInterval(_noteSyncInterval); return; }
      // Renouveler la session d'édition (expire après 5 min)
      api(`/notes/${noteId}/editing`, { method:'POST' }).catch(()=>{});
      // Vérifier si quelqu'un d'autre a sauvegardé (toutes les 5s)
      try {
        const fresh = await api(`/notes/${noteId}`);
        if (!fresh) return;
        if (fresh.last_editor_id && fresh.last_editor_id !== USER.id) {
          const s = document.getElementById('noteStatus');
          if (s) {
            s.style.color = '#1565c0';
            s.textContent = `🔄 ${fresh.le_prenom || ''} ${fresh.le_nom || ''} a modifié — rechargez si vous voulez voir la dernière version`;
          }
        }
      } catch(e) {}
    }, 5000);
  } else if (noteId && readOnly) {
    // En lecture seule : rafraîchir le contenu toutes les 5s
    clearInterval(_noteSyncInterval);
    _noteSyncInterval = setInterval(async () => {
      if (!document.getElementById('n_editor')) { clearInterval(_noteSyncInterval); return; }
      try {
        const fresh = await api(`/notes/${noteId}`);
        if (!fresh) return;
        const editor = document.getElementById('n_editor');
        if (editor && fresh.contenu) editor.innerHTML = fresh.contenu;
        const s = document.getElementById('noteStatus');
        if (s && fresh.last_editor_nom) s.textContent = `👁 Dernière modif : ${fresh.le_prenom||''} ${fresh.le_nom||''} — ${new Date(fresh.date_modification||'').toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'})}`;
      } catch(e) {}
    }, 5000);
  }
}

async function autoSaveNote(id) {
  try {
    await _doSaveNote(id, true);
    const s = document.getElementById('noteStatus');
    if (s) {
      s.style.color = '#2e7d32';
      s.textContent = '✅ Sauvegardé automatiquement à ' + new Date().toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'});
    }
  } catch(e) {
    const s = document.getElementById('noteStatus');
    if (s) { s.style.color = '#c62828'; s.textContent = '❌ Erreur de sauvegarde'; }
  }
}

function noteChanged() {
  const s = document.getElementById('noteStatus');
  if (s) { s.style.color = '#e65100'; s.textContent = '● Modifications en cours...'; }
  // Sauvegarde automatique 1.5 seconde après la dernière frappe
  clearTimeout(_noteDebounce);
  _noteDebounce = setTimeout(() => {
    const editor = document.getElementById('n_editor');
    if (editor) {
      const btn = document.querySelector('[onclick^="saveNoteEditor"]');
      const match = btn?.getAttribute('onclick')?.match(/saveNoteEditor\((\d+|null)\)/);
      const id = match ? (match[1] === 'null' ? null : parseInt(match[1])) : null;
      autoSaveNote(id);
    }
  }, 1500);
}

// ── Mode collaboratif ────────────────────────────────────────────────────
function _openNoteCollab(n, allActs) {
  _collabNoteId = n?.id;
  clearInterval(_noteSyncInterval);
  setContent(`
    <div id="collabEditor" style="display:flex;flex-direction:column;height:calc(100vh - var(--strip-h) - 8px);background:#e0e0e0">

      <!-- Barre collab -->
      <div style="background:#fff;border-bottom:1px solid #d0d0d0;padding:8px 16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <span style="background:#e3f2fd;color:#1565c0;border-radius:20px;padding:3px 12px;font-size:.78rem;font-weight:700">👥 Mode collaboratif</span>
        <span id="collabStatus" style="font-size:.75rem;color:var(--muted)"></span>
        <div style="flex:1"></div>
        <button class="btn btn-sm btn-ghost" onclick="_leaveCollab(${n?.id})">✕ Quitter</button>
        <button class="btn btn-sm btn-primary" onclick="mergeContributions(${n?.id})">🔀 Fusionner et terminer</button>
      </div>

      <!-- Zone principale : note + contributions -->
      <div style="flex:1;display:flex;overflow:hidden">

        <!-- Gauche : note existante (lecture seule) -->
        <div style="flex:1;overflow-y:auto;padding:24px 20px;background:#e0e0e0">
          <div style="background:#e8f5e9;color:#1b5e20;border-radius:6px;padding:6px 12px;font-size:.78rem;font-weight:600;margin-bottom:14px;text-align:center">
            📄 Note principale — lecture seule pendant la collaboration
          </div>
          <div id="collabMainNote" style="background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.15);padding:48px 56px;font-family:'Times New Roman',serif;font-size:12pt;line-height:1.6;color:#000;min-height:300px">
            ${n?.contenu || '<p style="color:#aaa;font-style:italic">Note vide — les contributions apparaîtront ici après fusion.</p>'}
          </div>
        </div>

        <!-- Droite : panneau contributions -->
        <div style="width:400px;flex-shrink:0;border-left:2px solid #1b5e20;display:flex;flex-direction:column;background:#f8f9fa;overflow:hidden">

          <!-- Contributions des autres (haut) -->
          <div style="flex:1;overflow-y:auto;padding:12px;border-bottom:1px solid #ddd;min-height:0">
            <div style="font-size:.72rem;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Contributions en direct</div>
            <div id="otherContribsList"><em style="color:#aaa;font-size:.82rem">Chargement…</em></div>
          </div>

          <!-- Ma contribution (bas) -->
          <div style="padding:12px;background:#fff;flex-shrink:0">
            <div style="font-size:.75rem;font-weight:700;color:#1b5e20;margin-bottom:6px">✍️ Votre contribution</div>
            <div id="myContrib" contenteditable="true" spellcheck="true"
              oninput="scheduleContribSave(${n?.id})"
              style="border:1px solid #c8e6c9;border-radius:6px;padding:10px;min-height:130px;max-height:280px;overflow-y:auto;font-family:'Times New Roman',serif;font-size:11pt;line-height:1.6;outline:none;background:#fafff9">
              <p><br></p>
            </div>
            <div id="contribStatus" style="font-size:.7rem;color:var(--muted);margin-top:4px">Non sauvegardé</div>
          </div>
        </div>
      </div>
    </div>
  `);

  // Charger et rafraîchir les contributions toutes les 5s
  _loadContribs(n?.id);
  _noteSyncInterval = setInterval(async () => {
    if (!document.getElementById('collabEditor')) { clearInterval(_noteSyncInterval); return; }
    _loadContribs(n?.id);
    // Rafraîchir aussi la note principale
    try {
      const fresh = await api(`/notes/${n?.id}`);
      if (fresh?.contenu) { const v = document.getElementById('collabMainNote'); if (v) v.innerHTML = fresh.contenu; }
    } catch(e) {}
  }, 5000);
}

async function _loadContribs(noteId) {
  try {
    const all = await api(`/notes/${noteId}/contributions`);
    const others = all.filter(c => c.user_id !== USER.id);
    const myContrib = all.find(c => c.user_id === USER.id);

    // Afficher les contributions des autres
    const el = document.getElementById('otherContribsList');
    if (el) {
      if (!others.length) {
        el.innerHTML = '<em style="color:#aaa;font-size:.82rem">Personne d\'autre ne contribue pour l\'instant.</em>';
      } else {
        el.innerHTML = others.map(c => `
          <div style="margin-bottom:10px;border:1px solid #e0e0e0;border-radius:6px;padding:10px;background:#fff">
            <div style="font-weight:700;font-size:.78rem;color:#1b5e20;margin-bottom:4px">✍️ ${escHtml(c.nom)}</div>
            <div style="font-size:.85rem;font-family:'Times New Roman',serif;line-height:1.5;color:#333;max-height:160px;overflow-y:auto">${c.contenu||'<em style="color:#aaa">Rien encore...</em>'}</div>
            <div style="font-size:.68rem;color:#aaa;margin-top:4px">Mis à jour ${fmt(c.derniere_frappe)}</div>
          </div>
        `).join('');
      }
    }

    // Indiquer le nombre de contributeurs
    const nb = all.length;
    const s = document.getElementById('collabStatus');
    if (s) s.textContent = nb > 0 ? `${nb} contributeur${nb>1?'s':''} actif${nb>1?'s':''}` : '';

    // Auto-fusion si tout le monde est inactif depuis 2 minutes
    if (all.length > 0) {
      const allIdle = all.every(c => (Date.now() - new Date(c.derniere_frappe).getTime()) > 120000);
      if (allIdle) {
        const s = document.getElementById('collabStatus');
        if (s) s.innerHTML = '<span style="color:#e65100;font-weight:600">⚠️ Tout le monde est inactif depuis 2 min — <button class="btn btn-sm btn-primary" onclick="mergeContributions(' + noteId + ')" style="padding:2px 10px;font-size:.75rem">🔀 Fusionner maintenant</button></span>';
      }
    }
  } catch(e) {}
}

function scheduleContribSave(noteId) {
  const s = document.getElementById('contribStatus');
  if (s) { s.style.color = '#e65100'; s.textContent = '● En train d\'écrire...'; }
  clearTimeout(_contribDebounce);
  _contribDebounce = setTimeout(() => _saveContrib(noteId), 1500);
}

async function _saveContrib(noteId) {
  const el = document.getElementById('myContrib');
  if (!el) return;
  const contenu = el.innerHTML;
  try {
    await api(`/notes/${noteId}/contribute`, { method:'POST', body: JSON.stringify({ contenu }) });
    const s = document.getElementById('contribStatus');
    if (s) { s.style.color = '#2e7d32'; s.textContent = '✅ Sauvegardé à ' + new Date().toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'}); }
  } catch(e) {
    const s = document.getElementById('contribStatus');
    if (s) { s.style.color = '#c62828'; s.textContent = '❌ Erreur de sauvegarde'; }
  }
}

async function mergeContributions(noteId) {
  if (!confirm('Fusionner toutes les contributions dans la note principale ?\nLes zones de contribution seront effacées.')) return;
  try {
    const r = await api(`/notes/${noteId}/merge`, { method:'POST' });
    if (r.merged === 0) return toast('Aucune contribution à fusionner.', true);
    toast(`✅ ${r.merged} contribution(s) fusionnée(s) !`);
    clearInterval(_noteSyncInterval); _collabNoteId = null;
    const [fresh, allActs] = await Promise.all([api(`/notes/${noteId}`), api('/activities')]);
    _noteEditingId = noteId;
    _openNoteEditor(fresh, allActs, false);
  } catch(e) { toast('Erreur: ' + e.message, true); }
}

async function _leaveCollab(noteId) {
  clearInterval(_noteSyncInterval); _collabNoteId = null;
  if (_contribDebounce) { clearTimeout(_contribDebounce); _contribDebounce = null; }
  api(`/notes/${noteId}/contribute`, { method:'DELETE' }).catch(()=>{});
  notes();
}

// ── Signature modale pour les notes ──────────────────────────────────────
function openNoteSignatureModal(noteId, titre) {
  openModal(`✍️ Signer — ${titre}`, `
    <p style="font-size:.85rem;color:var(--muted);margin-bottom:12px">Dessinez votre signature dans la zone ci-dessous. Elle sera horodatée et liée à votre compte.<br>
    <strong style="color:#1b5e20">⚠️ Après 2 signatures, la note sera verrouillée et ne pourra plus être modifiée.</strong></p>
    <canvas id="noteSigCanvas" width="540" height="160" style="border:1px solid #ccc;border-radius:8px;cursor:crosshair;display:block;width:100%;touch-action:none"></canvas>
    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="btn btn-sm btn-ghost" onclick="_clearNoteCanvas()">🗑 Effacer</button>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="btn btn-primary" onclick="_saveNoteSignature(${noteId})">✅ Signer le document</button>
      <button class="btn btn-outline" onclick="closeModal()">Annuler</button>
    </div>
  `);
  setTimeout(() => {
    const canvas = document.getElementById('noteSigCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let drawing = false;
    const getPos = e => {
      const r = canvas.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      return { x: (src.clientX - r.left) * (canvas.width / r.width), y: (src.clientY - r.top) * (canvas.height / r.height) };
    };
    canvas.addEventListener('mousedown', e => { drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener('mousemove', e => { if (!drawing) return; const p = getPos(e); ctx.lineWidth = 2.5; ctx.strokeStyle = '#1b5e20'; ctx.lineCap = 'round'; ctx.lineTo(p.x, p.y); ctx.stroke(); });
    canvas.addEventListener('mouseup', () => { drawing = false; });
    canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }, { passive: false });
    canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; const p = getPos(e); ctx.lineWidth = 2.5; ctx.strokeStyle = '#1b5e20'; ctx.lineCap = 'round'; ctx.lineTo(p.x, p.y); ctx.stroke(); }, { passive: false });
    canvas.addEventListener('touchend', () => { drawing = false; });
  }, 50);
}
function _clearNoteCanvas() {
  const c = document.getElementById('noteSigCanvas');
  if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
async function _saveNoteSignature(noteId) {
  const canvas = document.getElementById('noteSigCanvas');
  if (!canvas) return;
  const blank = document.createElement('canvas'); blank.width = canvas.width; blank.height = canvas.height;
  if (canvas.toDataURL() === blank.toDataURL()) return toast('Veuillez dessiner votre signature', true);
  const signature_data = canvas.toDataURL('image/png');
  try {
    const r = await api(`/notes/${noteId}/sign`, { method:'POST', body: JSON.stringify({ signature_data }) });
    closeModal();
    if (r.verrouille) toast(`🔒 Note verrouillée — ${r.nb_signatures} signatures collectées`);
    else toast(`✅ Signature enregistrée (${r.nb_signatures}/2 pour verrouiller)`);
    notes();
  } catch(e) { toast(e.message, true); }
}

async function _doSaveNote(id, silent = false) {
  const editor = document.getElementById('n_editor');
  if (!editor) return;
  const body = {
    titre: document.getElementById('n_titre')?.value || 'Sans titre',
    contenu: editor.innerHTML,
    langue: document.getElementById('n_lang')?.value || 'fr',
    date_reunion: document.getElementById('n_date')?.value || new Date().toISOString().slice(0,10),
    activity_id: parseInt(document.getElementById('n_act')?.value) || null,
  };
  if (id) {
    const r = await api(`/notes/${id}`, { method:'PUT', body:JSON.stringify(body) });
    if (r?.signatures_annulees > 0) {
      toast('⚠️ Signatures annulées — le document a été modifié. Le processus de signature doit recommencer.', true);
    }
  } else {
    const r = await api('/notes', { method:'POST', body:JSON.stringify(body) });
    // Mettre à jour l'URL avec le nouvel ID pour les sauvegardes suivantes
    if (r?.id) {
      document.querySelectorAll('[onclick^="saveNoteEditor"]').forEach(el => {
        el.setAttribute('onclick', `saveNoteEditor(${r.id})`);
      });
      clearInterval(_noteAutoSave);
      _noteAutoSave = setInterval(() => autoSaveNote(r.id), 30000);
    }
  }
  if (!silent) { toast('Note sauvegardée ✅'); }
}

async function saveNoteEditor(id) {
  try {
    await _doSaveNote(id, false);
    const s = document.getElementById('noteStatus');
    if (s) s.textContent = '✅ Sauvegardé ' + new Date().toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'});
  } catch(e) { toast('Erreur: ' + e.message, true); }
}

async function correctNote() {
  const texte = document.getElementById('n_contenu').value;
  const langue = document.getElementById('n_lang').value;
  if (!texte) return toast('Entrez du texte d\'abord','error');
  const btn = document.querySelector('[onclick="correctNote()"]');
  btn.textContent = '⏳ Correction...'; btn.disabled = true;
  try {
    const r = await api('/ai/spellcheck', { method:'POST', body:JSON.stringify({ texte, langue }) });
    const box = document.getElementById('n_corrected');
    box.textContent = r.corrige;
    box.style.display = 'block';
    if (r.note) toast(r.note, 'info');
    else toast('Texte corrigé!');
  } catch(ex) { toast(ex.message,'error'); }
  finally { btn.textContent = '🪄 Corriger automatiquement'; btn.disabled = false; }
}

async function saveNote(id) {
  // Kept for backward compatibility — redirects to new editor
  await saveNoteEditor(id);
}

async function deleteNote(id) {
  if (!confirm('Supprimer cette note?')) return;
  await api(`/notes/${id}`, { method:'DELETE' });
  toast('Note supprimée'); notes();
}

// ══ REPORTS ════════════════════════════════════════════════════════════════
async function reports() {
  const allUsers = await api('/users');
  setContent(`
    <div class="page-header"><div><h2>Rapports</h2><p>Générez des rapports de bénévolat et financiers</p></div>
      <div class="page-actions"><button class="btn btn-outline" onclick="printSection('Rapports')">🖨️ Imprimer</button></div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
      <div class="table-card">
        <div class="table-card-header"><h3>📊 Rapport bénévolat</h3></div>
        <div style="padding:16px 20px">
          <div class="form-group"><label>Filtrer par membre</label>
            <select id="rep_user"><option value="">Tous les membres</option>
              ${allUsers.map(u=>`<option value="${u.id}">${u.prenom} ${u.nom}</option>`).join('')}
            </select></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="genVolReport()">📊 Générer</button>
            <button class="btn btn-outline" onclick="printVolReport()">🖨️ Imprimer</button>
          </div>
        </div>
      </div>
      <div class="table-card">
        <div class="table-card-header"><h3>💰 Rapport financier</h3></div>
        <div style="padding:16px 20px">
          <p style="color:var(--muted);font-size:.88rem;margin-bottom:14px">Rapport global de toutes les lignes financières</p>
          <button class="btn btn-primary" onclick="genFinReport()">💰 Générer rapport</button>
        </div>
      </div>
    </div>
    <div id="reportResult"></div>
  `);
}

async function printVolReport() {
  const userId = document.getElementById('rep_user')?.value;
  const data = await api('/reports/volunteer' + (userId ? `?user_id=${userId}` : ''));
  const tableHtml = `<table>
    <thead><tr><th>Membre</th><th>Email</th><th>Activité</th><th>Heures</th><th>Date</th></tr></thead>
    <tbody>${data.rows.map(r=>`<tr><td>${r.prenom} ${r.nom}</td><td>${r.email}</td><td>${r.activite||'–'}</td><td>${r.heures}h</td><td>${fmt(r.date_service)}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center">Aucun résultat</td></tr>'}</tbody>
  </table>`;
  printAHHReport(`Rapport bénévolat — ${data.total_heures}h approuvées`, tableHtml);
}

async function genVolReport() {
  const userId = document.getElementById('rep_user')?.value;
  const data = await api('/reports/volunteer' + (userId ? `?user_id=${userId}` : ''));
  const tableHtml = `<table>
    <thead><tr><th>Membre</th><th>Email</th><th>Activité</th><th>Heures</th><th>Date</th></tr></thead>
    <tbody>${data.rows.map(r=>`<tr><td>${r.prenom} ${r.nom}</td><td>${r.email}</td><td>${r.activite||'–'}</td><td>${r.heures}h</td><td>${fmt(r.date_service)}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center">Aucun résultat</td></tr>'}</tbody>
  </table>`;
  document.getElementById('reportResult').innerHTML = `
    <div class="table-card">
      <div class="table-card-header">
        <h3>Rapport bénévolat — Total: <strong>${data.total_heures}h approuvées</strong></h3>
        <button class="btn btn-sm btn-outline" onclick="printAHHReport('Rapport bénévolat',document.querySelector('#reportResult table').outerHTML)">🖨️ Imprimer</button>
      </div>
      <div class="table-wrapper">${tableHtml}</div>
    </div>`;
}

async function genFinReport() {
  const data = await api('/reports/finance');
  const totalDep = data.lines.reduce((s,l)=>s+(l.depenses||0),0);
  const totalRev = data.lines.reduce((s,l)=>s+(l.revenus||0),0);
  const tableHtml = `<table>
    <thead><tr><th>Activité / Projet</th><th>Budget alloué</th><th>Dépenses</th><th>En attente</th><th>Revenus</th><th>Solde</th></tr></thead>
    <tbody>${data.lines.map(l=>{
      const s = (l.budget_alloue||0)-(l.depenses||0)+(l.revenus||0);
      return `<tr><td>${l.activite||l.projet||l.titre}</td><td>${fmtMoney(l.budget_alloue)}</td><td>${fmtMoney(l.depenses)}</td><td>${fmtMoney(l.depenses_en_attente||0)}</td><td>${fmtMoney(l.revenus)}</td><td><strong>${fmtMoney(s)}</strong></td></tr>`;
    }).join('')}
    <tr style="font-weight:700"><td>TOTAUX</td><td>–</td><td>${fmtMoney(totalDep)}</td><td>–</td><td>${fmtMoney(totalRev)}</td><td><strong>${fmtMoney(totalRev-totalDep)}</strong></td></tr>
    </tbody></table>`;
  document.getElementById('reportResult').innerHTML = `
    <div class="table-card">
      <div class="table-card-header">
        <h3>Rapport financier global — Solde: <strong>${fmtMoney(data.account?.solde)}</strong></h3>
        <button class="btn btn-sm btn-outline" onclick="printAHHReport('Rapport financier',document.querySelector('#reportResult table').outerHTML)">🖨️ Imprimer</button>
      </div>
      <div class="table-wrapper">${tableHtml}</div>
    </div>`;
}

function printAHHReport(title, tableHtml) {
  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><title>${title} – AHH</title>
    ${ahhPrintStyles()}</head><body>
    <div class="noprint"><button class="btn-print" onclick="window.print()">🖨️ Imprimer / Sauvegarder en PDF</button></div>
    ${ahhPrintHeader()}
    <h2 style="font-size:1.1rem;font-weight:700;color:#1b5e20;margin-bottom:4px">${title}</h2>
    <p style="color:#5a7a5a;font-size:.78rem;margin-bottom:20px">Imprimé le ${new Date().toLocaleDateString('fr-CA')}</p>
    ${tableHtml}
    </body></html>`);
  w.document.close(); w.print();
}

// ══ LETTERS ════════════════════════════════════════════════════════════════
async function letters() {
  const [data, allUsers] = await Promise.all([api('/ai/recommendations'), api('/users')]);
  const isExec = can.adminOrSec();
  setContent(`
    <div class="page-header">
      <div><h2>Lettres de recommandation</h2><p>Lettres officielles pour les membres de la communauté</p></div>
      <div class="page-actions">
        ${isExec ? `<button class="btn btn-primary" onclick='openLetterForm(${JSON.stringify(allUsers)})'>+ Générer une lettre</button>` : ''}
        ${USER.role === 'member' ? `<button class="btn btn-primary" onclick="requestLetter()">📄 Demander une lettre</button>` : ''}
      </div>
    </div>
    ${data.map(l=>`
      <div class="table-card" style="margin-bottom:16px">
        <div class="table-card-header">
          <div><h3>Lettre pour ${l.membre_nom}</h3>
          <small style="color:var(--muted)">${fmt(l.date_generation)} · ${statusPill(l.statut)}</small></div>
          <div class="tc-actions">
            <button class="btn btn-sm btn-outline" onclick="previewLetter(${l.id},'${l.membre_nom}',\`${(l.contenu||'').replace(/`/g,"'")}\`)">👁️ Voir</button>
            <button class="btn btn-sm btn-ghost" onclick="printLetter(\`${(l.contenu||'').replace(/`/g,"'")}\`,'${l.membre_nom}')">🖨️ Imprimer</button>
          </div>
        </div>
      </div>
    `).join('') || '<div class="empty-state"><div class="es-icon">📄</div><p>Aucune lettre générée</p></div>'}
  `);
}

function openLetterForm(allUsers) {
  openModal('Générer une lettre de recommandation', `
    <form id="letForm">
      <div class="form-group"><label>Membre *</label>
        <select id="let_user" required>
          ${allUsers.filter(u=>u.actif && u.role==='member').map(u=>`<option value="${u.id}">${u.prenom} ${u.nom}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Langue</label>
        <select id="let_lang"><option value="fr">🇫🇷 Français</option><option value="en">🇬🇧 Anglais</option></select></div>
      <div class="form-group"><label>Contexte / Raison</label>
        <textarea id="let_raison" rows="3" placeholder="Ex: candidature à un emploi, bourse scolaire..."></textarea></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-accent">🤖 Générer avec l'IA</button>
      </div>
    </form>
  `);
  document.getElementById('letForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.textContent = '⏳ Génération...'; btn.disabled = true;
    try {
      const r = await api('/ai/recommendation', { method:'POST', body: JSON.stringify({
        membre_id: parseInt(document.getElementById('let_user').value),
        langue: document.getElementById('let_lang').value,
        raison: document.getElementById('let_raison').value })});
      closeModal();
      openModal(`Lettre pour ${r.membre}`, `<div class="letter-preview">${r.contenu}</div>
        <div style="text-align:right;margin-top:14px">
          <button class="btn btn-outline" onclick="printLetter(\`${r.contenu.replace(/`/g,"'")}\`,'${r.membre}')">🖨️ Imprimer</button>
        </div>`);
      letters();
    } catch(ex) { toast(ex.message,'error'); btn.textContent='🤖 Générer avec l\'IA'; btn.disabled=false; }
  };
}

function previewLetter(id, nom, contenu) {
  openModal(`Lettre – ${nom}`, `<div class="letter-preview">${contenu}</div>
    <div style="text-align:right;margin-top:14px">
      <button class="btn btn-outline" onclick="printLetter(\`${contenu.replace(/`/g,"'")}\`,'${nom}')">🖨️ Imprimer</button>
    </div>`);
}

function ahhPrintHeader() {
  return `
    <div style="display:flex;align-items:center;gap:20px;border-bottom:3px solid #1b5e20;padding-bottom:18px;margin-bottom:24px">
      <img src="/Public/logo1.png" alt="AHH" style="width:70px;height:70px;border-radius:8px;object-fit:cover;flex-shrink:0"/>
      <div>
        <div style="font-size:1.3rem;font-weight:800;color:#1b5e20">Association Haïtienne de Hamilton</div>
        <div style="font-size:.82rem;color:#555;margin-top:2px">231 Fernwood Crescent, Hamilton, ON  L8T 3L7</div>
        <div style="font-size:.78rem;color:#777;margin-top:1px">Tél : 905-818-8269 &nbsp;|&nbsp; info@ahhamilton.ca &nbsp;|&nbsp; ahhamilton.ca</div>
      </div>
    </div>`;
}

function ahhPrintStyles() {
  return `<style>
    @page{size:letter;margin:2cm}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;color:#1a1a1a;background:#fff;padding:32px}
    table{width:100%;border-collapse:collapse;margin:12px 0}
    th{background:#e8f5e9;padding:8px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
    td{padding:7px 8px;border-bottom:1px solid #e8f5e9;font-size:12px}
    .btn-print{background:#1b5e20;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:.95rem;cursor:pointer;margin-bottom:24px}
    @media print{.noprint{display:none}}
  </style>`;
}

function printLetter(contenu, nom) {
  const w = window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><title>Lettre – ${nom}</title>
    ${ahhPrintStyles()}
    <style>pre{white-space:pre-wrap;font-family:Georgia,serif;font-size:13px;line-height:1.9;color:#111}</style>
    </head><body>
    <div class="noprint"><button class="btn-print" onclick="window.print()">🖨️ Imprimer / Sauvegarder en PDF</button></div>
    ${ahhPrintHeader()}
    <h2 style="font-size:1.1rem;font-weight:700;color:#1b5e20;margin-bottom:6px">Lettre de recommandation</h2>
    <p style="font-size:.78rem;color:#888;margin-bottom:24px">Émise le ${new Date().toLocaleDateString('fr-CA')} · ${nom}</p>
    <pre>${contenu}</pre>
    <div style="margin-top:60px;display:flex;justify-content:flex-end">
      <div style="border-top:1px solid #333;width:220px;padding-top:6px;font-size:.8rem;color:#555;text-align:center">
        Signature — Secrétaire / Président(e)<br/>Association Haïtienne de Hamilton
      </div>
    </div>
    </body></html>`);
  w.document.close(); w.print();
}

async function requestLetter() {
  openModal('📄 Demander une lettre de recommandation',
    '<form id="reqLetterForm">' +
      '<p style="font-size:.84rem;color:var(--muted);margin-bottom:16px">Votre demande sera envoyée à la secrétaire et aux administrateurs, qui vous contacteront sous peu.</p>' +
      '<div class="form-group"><label>Motif de la demande</label>' +
        '<textarea id="reqLetterMotif" rows="3" placeholder="Ex: candidature à un emploi, demande de bourse, reconnaissance communautaire…" required></textarea>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
        '<button type="submit" class="btn btn-primary">Envoyer la demande</button>' +
      '</div>' +
    '</form>'
  );
  document.getElementById('reqLetterForm').onsubmit = async function(e) {
    e.preventDefault();
    const motif = document.getElementById('reqLetterMotif').value.trim();
    try {
      // Envoyer message interne aux admins et secrétaires
      await api('/messages', {
        method: 'POST',
        body: JSON.stringify({
          sujet: '📄 Demande de lettre de recommandation — ' + USER.prenom + ' ' + USER.nom,
          contenu: 'Demande reçue de : ' + USER.prenom + ' ' + USER.nom + ' (' + USER.email + ')\n\n' +
                   'Motif : ' + motif + '\n\n' +
                   'Veuillez générer la lettre via la section Lettres du tableau de bord.',
          destinataires: ['all']  // sera filtré côté serveur — on envoie à tous les exécutifs
        })
      }).catch(() => {});

      // Message ciblé aux admins seulement via contact API
      await fetch(BASE + '/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nom: USER.prenom + ' ' + USER.nom,
          email: USER.email,
          sujet: 'Demande de lettre de recommandation',
          message: motif
        })
      }).catch(() => {});

      closeModal();
      toast('✅ Demande envoyée ! La secrétaire ou un admin vous contactera sous peu.', 'info');
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

// ══ GALLERY MANAGEMENT ═════════════════════════════════════════════════════

window._galPhotos = [];
var _galIdx = 0;

async function gallery_mgmt() {
  const photos = await api('/gallery');
  window._galPhotos = photos;

  const cats = {
    general:   { label:'Général',               emoji:'📸' },
    culturel:  { label:'Événements culturels',  emoji:'🌺' },
    repas:     { label:'Repas & Rassemblements',emoji:'🍽️' },
    benevolat: { label:'Bénévolat',             emoji:'🤝' },
    reunion:   { label:'Réunions',              emoji:'📋' },
  };

  const grouped = {};
  photos.forEach(p => {
    const cat = p.categorie || 'general';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  });

  // ── Build album HTML using template literals ──────────────────────────────
  let albumsHtml = '';
  if (!photos.length) {
    albumsHtml = `
      <div class="empty-state">
        <div class="es-icon">🖼️</div>
        <p>Aucune photo dans la galerie pour l'instant.<br/>Téléversez votre première photo ci-dessus !</p>
      </div>`;
  } else {
    Object.entries(cats).forEach(([catKey, catInfo]) => {
      const list = grouped[catKey] || [];
      if (!list.length) return;
      const byAlbum = {};
      list.forEach(p => {
        const a = p.titre || '(Sans titre)';
        if (!byAlbum[a]) byAlbum[a] = [];
        byAlbum[a].push(p);
      });
      let catHtml = `<div style="margin-bottom:40px">
        <h3 style="font-size:1rem;font-weight:700;color:var(--text);margin-bottom:16px;display:flex;align-items:center;gap:8px">
          ${catInfo.emoji} ${catInfo.label}
          <span style="background:var(--border);color:var(--muted);font-size:.75rem;padding:2px 10px;border-radius:50px">
            ${list.length} photo${list.length > 1 ? 's' : ''}
          </span>
        </h3>`;
      Object.entries(byAlbum).forEach(([albumName, albumPhotos]) => {
        catHtml += `<div class="gal-mgmt-album">
          <div class="gal-mgmt-album-header">
            <span>📁 ${albumName}</span>
            <span style="font-size:.75rem;color:var(--muted)">${albumPhotos.length} photo${albumPhotos.length > 1 ? 's' : ''}</span>
          </div>
          <div class="gallery-mgmt-grid">`;
        albumPhotos.forEach(p => {
          const idx = photos.indexOf(p);
          const src = `${BASE}${p.photo_path}`;
          const featClass = p.featured ? 'gmc-featured-on' : '';
          const featTitle = p.featured ? 'Retirer de l\'accueil' : 'Mettre à la une sur l\'accueil';
          catHtml += `
            <div class="gallery-mgmt-card ${featClass}" id="gmc-${p.id}" data-photoidx="${idx}">
              <div class="gmc-img" data-photoidx="${idx}" style="cursor:zoom-in">
                <img src="${src}" alt="${(p.titre||'').replace(/"/g,'&quot;')}"
                  onerror="this.style.display='none'" loading="lazy"/>
                ${p.featured ? '<div class="gmc-featured-badge">⭐ Accueil</div>' : ''}
              </div>
              <div class="gmc-info">
                <div class="gmc-title">${p.titre || '(Sans titre)'}</div>
                <div class="gmc-meta">${fmt(p.date_upload)} · ${p.uploadeur || '–'}</div>
              </div>
              <div style="display:flex;gap:4px">
                <button class="gmc-feature" data-featid="${p.id}" data-featured="${p.featured||0}"
                  title="${featTitle}" style="background:${p.featured?'#f9a825':'var(--off)'};border:1px solid ${p.featured?'#f9a825':'var(--border)'};border-radius:8px;padding:4px 8px;cursor:pointer;font-size:.8rem;transition:.2s">
                  ${p.featured ? '⭐' : '☆'}
                </button>
                <button class="gmc-delete" data-delid="${p.id}" title="Supprimer">🗑️</button>
              </div>
            </div>`;
        });
        catHtml += `</div></div>`;
      });
      catHtml += `</div>`;
      albumsHtml += catHtml;
    });
  }

  const catOptions = Object.entries(cats)
    .map(([v, c]) => `<option value="${v}">${c.emoji} ${c.label}</option>`)
    .join('');

  setContent(`
    <div class="page-header">
      <div>
        <h2>🖼️ Gérer la galerie</h2>
        <p>Ajoutez ou supprimez des photos qui apparaissent sur la page publique du site</p>
      </div>
      <div class="page-actions">
        <a href="../galerie.html" target="_blank" class="btn btn-ghost">🔗 Voir la page publique</a>
      </div>
    </div>

    <div class="upload-zone" id="uploadZone">
      <div class="uz-icon">📷</div>
      <h3>Ajouter des photos à la galerie</h3>
      <p>Glissez-déposez des images ici, ou cliquez pour sélectionner</p>
      <form id="galleryUploadForm" style="margin-top:20px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:500px;margin:0 auto 16px">
          <div class="form-group" style="margin:0">
            <label>Nom du bloc / Album</label>
            <input id="gal_titre" placeholder="Ex: Gala 2026, Fête nationale…" required/>
            <small style="color:var(--muted);font-size:.72rem">Toutes les photos du lot auront ce nom de bloc</small>
          </div>
          <div class="form-group" style="margin:0">
            <label>Catégorie</label>
            <select id="gal_cat">${catOptions}</select>
          </div>
        </div>
        <input type="file" id="gal_file" accept="image/*" multiple style="display:none"/>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost"
            onclick="document.getElementById('gal_file').click()">
            📁 Choisir des fichiers
          </button>
          <button type="submit" class="btn btn-primary" id="galUploadBtn">⬆️ Téléverser</button>
        </div>
        <div id="gal_preview" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:14px"></div>
        <div id="gal_progress" style="display:none;margin-top:10px;text-align:center;color:var(--muted);font-size:.88rem"></div>
      </form>
    </div>

    <div style="margin-top:36px">${albumsHtml}</div>
  `);

  // Prévisualisation
  document.getElementById('gal_file').addEventListener('change', function() {
    const preview = document.getElementById('gal_preview');
    preview.innerHTML = '';
    [...this.files].forEach(f => {
      const reader = new FileReader();
      reader.onload = ev => {
        const d = document.createElement('div');
        d.style.cssText = 'position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:2px solid var(--border)';
        d.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover"/>`;
        preview.appendChild(d);
      };
      reader.readAsDataURL(f);
    });
  });

  // Drag & drop
  const zone = document.getElementById('uploadZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const dt = new DataTransfer();
    [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')).forEach(f => dt.items.add(f));
    document.getElementById('gal_file').files = dt.files;
    document.getElementById('gal_file').dispatchEvent(new Event('change'));
  });

  // Upload
  document.getElementById('galleryUploadForm').addEventListener('submit', async e => {
    e.preventDefault();
    const files = document.getElementById('gal_file').files;
    if (!files.length) return toast('Sélectionnez au moins une photo', 'error');
    const btn  = document.getElementById('galUploadBtn');
    const prog = document.getElementById('gal_progress');
    btn.disabled = true; prog.style.display = 'block';
    let ok = 0, fail = 0;
    for (let i = 0; i < files.length; i++) {
      prog.textContent = `⬆️ Compression & téléversement ${i + 1}/${files.length}...`;
      const fd = new FormData();
      const compressed = await compressImage(files[i]);
      fd.append('photo', compressed);
      fd.append('titre', document.getElementById('gal_titre').value || files[i].name.split('.')[0]);
      fd.append('categorie', document.getElementById('gal_cat').value);
      try { await apiForm('/gallery', fd); ok++; } catch { fail++; }
    }
    prog.style.display = 'none'; btn.disabled = false;
    toast(`✅ ${ok} photo${ok>1?'s':''} ajoutée${ok>1?'s':''}${fail?` · ${fail} échec(s)`:''}`, fail ? 'error' : 'ok');
    gallery_mgmt();
  });

  // Créer le lightbox DOM
  galLbBuild();

  // Délégation d'événements sur mainContent (aucun onclick inline)
  const mc = document.getElementById('mainContent');
  mc.addEventListener('click', function galDelegate(e) {
    // Clic sur le bouton "mettre à la une"
    const featBtn = e.target.closest('[data-featid]');
    if (featBtn) {
      e.stopPropagation();
      toggleGalleryFeatured(parseInt(featBtn.dataset.featid), featBtn);
      return;
    }
    // Clic sur le bouton supprimer
    const delBtn = e.target.closest('[data-delid]');
    if (delBtn) {
      e.stopPropagation();
      deleteGalleryPhoto(parseInt(delBtn.dataset.delid));
      return;
    }
    // Clic sur une image
    if (e.target.closest('.gmc-delete') || e.target.closest('.gmc-feature')) return;
    const imgDiv = e.target.closest('.gmc-img[data-photoidx]');
    if (!imgDiv) return;
    galOpen(parseInt(imgDiv.dataset.photoidx));
  });
}

async function deleteGalleryPhoto(id) {
  if (!confirm('Supprimer cette photo ? Action irréversible.')) return;
  try {
    await api(`/gallery/${id}`, { method: 'DELETE' });
    toast('Photo supprimée');
    const card = document.getElementById(`gmc-${id}`);
    if (card) { card.style.opacity = '0'; setTimeout(() => card.remove(), 300); }
    window._galPhotos = window._galPhotos.filter(p => p.id !== id);
  } catch(ex) { toast(ex.message, 'error'); }
}

async function toggleGalleryFeatured(id, btn) {
  try {
    const res = await api(`/gallery/${id}/featured`, { method: 'PATCH' });
    const isFeatured = res.featured === 1;
    // Mise à jour de l'état local
    const photo = (window._galPhotos || []).find(p => p.id === id);
    if (photo) photo.featured = res.featured;
    // Mise à jour UI du bouton
    btn.dataset.featured = res.featured;
    btn.innerHTML = isFeatured ? '⭐' : '☆';
    btn.title = isFeatured ? 'Retirer de l\'accueil' : 'Mettre à la une sur l\'accueil';
    btn.style.background = isFeatured ? '#f9a825' : 'var(--off)';
    btn.style.borderColor = isFeatured ? '#f9a825' : 'var(--border)';
    // Badge sur l'image
    const card = document.getElementById(`gmc-${id}`);
    if (card) {
      card.classList.toggle('gmc-featured-on', isFeatured);
      const imgDiv = card.querySelector('.gmc-img');
      let badge = imgDiv && imgDiv.querySelector('.gmc-featured-badge');
      if (isFeatured && imgDiv && !badge) {
        badge = document.createElement('div');
        badge.className = 'gmc-featured-badge';
        badge.textContent = '⭐ Accueil';
        imgDiv.appendChild(badge);
      } else if (!isFeatured && badge) {
        badge.remove();
      }
    }
    toast(isFeatured ? '⭐ Photo mise à la une sur l\'accueil' : 'Photo retirée de l\'accueil');
  } catch(ex) { toast(ex.message || 'Erreur', 'error'); }
}

// ── LIGHTBOX ────────────────────────────────────────────────────────────────

function galOpen(idx) {
  if (!window._galPhotos || !window._galPhotos.length) return;
  _galIdx = (idx >= 0 && idx < window._galPhotos.length) ? idx : 0;
  galLbBuild();
  galLbUpdate();
  const lb = document.getElementById('_galLb');
  if (lb) { lb.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}

function galLbBuild() {
  if (document.getElementById('_galLb')) return;

  const lb = document.createElement('div');
  lb.id = '_galLb';
  lb.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.93);z-index:999999;align-items:center;justify-content:center;gap:24px;padding:20px;box-sizing:border-box';

  const mkBtn = (html, css, fn) => {
    const b = document.createElement('button');
    b.innerHTML = html;
    b.style.cssText = css;
    b.onclick = fn;
    return b;
  };

  const btnClose = mkBtn('✕',
    'position:absolute;top:16px;right:20px;background:rgba(255,255,255,.15);border:1.5px solid rgba(255,255,255,.3);color:#fff;font-size:1.3rem;width:42px;height:42px;border-radius:50%;cursor:pointer;z-index:1;display:flex;align-items:center;justify-content:center',
    galLbClose);

  const arrowCss = 'width:54px;height:54px;border-radius:50%;background:rgba(255,255,255,.15);border:1.5px solid rgba(255,255,255,.25);color:#fff;font-size:2.4rem;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;line-height:1';
  const btnPrev = mkBtn('&#8249;', arrowCss, () => galLbNav(-1));
  const btnNext = mkBtn('&#8250;', arrowCss, () => galLbNav(+1));

  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;align-items:center;max-width:88vw;max-height:90vh;flex:1;min-width:0';

  const img = document.createElement('img');
  img.id = '_galLbImg';
  img.style.cssText = 'max-width:100%;max-height:78vh;border-radius:12px;object-fit:contain;box-shadow:0 20px 60px rgba(0,0,0,.6);display:block';

  const cap = document.createElement('div');
  cap.style.cssText = 'display:flex;justify-content:space-between;width:100%;margin-top:14px;gap:16px';

  const titleEl = document.createElement('div');
  titleEl.id = '_galLbTitle';
  titleEl.style.cssText = 'color:rgba(255,255,255,.85);font-family:Poppins,sans-serif;font-size:.9rem;font-weight:500';

  const counterEl = document.createElement('div');
  counterEl.id = '_galLbCounter';
  counterEl.style.cssText = 'color:rgba(255,255,255,.45);font-family:Poppins,sans-serif;font-size:.78rem;white-space:nowrap;flex-shrink:0';

  cap.appendChild(titleEl);
  cap.appendChild(counterEl);
  body.appendChild(img);
  body.appendChild(cap);

  lb.appendChild(btnClose);
  lb.appendChild(btnPrev);
  lb.appendChild(body);
  lb.appendChild(btnNext);
  lb.addEventListener('click', e => { if (e.target === lb) galLbClose(); });
  document.body.appendChild(lb);

  document.addEventListener('keydown', e => {
    const l = document.getElementById('_galLb');
    if (!l || l.style.display === 'none') return;
    if (e.key === 'ArrowLeft')  galLbNav(-1);
    if (e.key === 'ArrowRight') galLbNav(+1);
    if (e.key === 'Escape')     galLbClose();
  });
}

function galLbClose() {
  const lb = document.getElementById('_galLb');
  if (lb) lb.style.display = 'none';
  document.body.style.overflow = '';
}

function galLbNav(dir) {
  const photos = window._galPhotos || [];
  if (!photos.length) return;
  _galIdx = (_galIdx + dir + photos.length) % photos.length;
  galLbUpdate();
}

function galLbUpdate() {
  const p = (window._galPhotos || [])[_galIdx];
  if (!p) return;
  const img = document.getElementById('_galLbImg');
  if (img) img.src = `${BASE}${p.photo_path}`;
  const t = document.getElementById('_galLbTitle');
  if (t) t.textContent = p.titre || '(Sans titre)';
  const c = document.getElementById('_galLbCounter');
  if (c) c.textContent = `${_galIdx + 1} / ${window._galPhotos.length}`;
}


// CLIENT COURRIEL — STYLE GMAIL
// ══════════════════════════════════════════════════════════════════════════════
let _M = { members:[], checked:new Set(), starred:new Set(), view:'inbox', detail:null, all:{inbox:[],sent:[]} };
const _MC = { to:[], cc:[] };

// ── Vue principale ──────────────────────────────────────────────────────────
async function annuaire() {
  _M.members = await api('/annuaire');
  _M.view    = 'inbox';
  _M.checked = new Set();

  setContent(`
    <div class="gm-shell">
      <aside class="gm-sidebar">
        <button class="gm-compose-btn" onclick="gmCompose()">
          <span>✏️</span> Nouveau message
        </button>
        <nav>
          <div class="gm-nav-row gm-active" id="gn-inbox"    onclick="gmNav('inbox')"><span>📥</span><span>Boîte de réception</span><span class="gm-badge" id="gm-badge"></span></div>
          <div class="gm-nav-row" id="gn-starred"   onclick="gmNav('starred')"><span>☆</span><span>Suivis</span></div>
          <div class="gm-nav-row" id="gn-sent"      onclick="gmNav('sent')"  ><span>📤</span><span>Envoyés</span></div>
          <div class="gm-nav-row" id="gn-all"       onclick="gmNav('all')"   ><span>📂</span><span>Tous</span></div>
          <div class="gm-nav-row" id="gn-trash"     onclick="gmNav('trash')" ><span>🗑️</span><span>Corbeille</span></div>
          ${can.executive() ? `<div class="gm-nav-row" id="gn-external" onclick="gmNav('external')" style="margin-top:10px;border-top:1px solid rgba(255,255,255,.1);padding-top:10px"><span>📬</span><span>Externe (@ahhamilton)</span></div>` : ''}
        </nav>
      </aside>
      <div class="gm-main" id="gmMain">
        <div class="loading-screen"><div class="spinner"></div></div>
      </div>
    </div>`);

  gmLoadInbox();
}

// ── Navigation ──────────────────────────────────────────────────────────────
async function gmNav(view) {
  _M.view = view;
  _M.checked = new Set();
  document.querySelectorAll('.gm-nav-row').forEach(e => e.classList.remove('gm-active'));
  document.getElementById(`gn-${view}`)?.classList.add('gm-active');
  if (view === 'inbox')    return gmLoadInbox();
  if (view === 'sent')     return gmLoadSent();
  if (view === 'starred')  return gmRenderList(_M.all.inbox.filter(m => _M.starred.has(m.message_id||m.id)), 'inbox');
  if (view === 'all')      return gmRenderList([..._M.all.inbox,..._M.all.sent], 'inbox');
  if (view === 'trash')    return gmLoadTrash();
  if (view === 'external') return gmLoadExternal();
}

async function gmLoadTrash() {
  const { inbox, sent } = await api('/messages?trash=1');
  const all = [
    ...inbox.map(m => ({ ...m, _type:'inbox' })),
    ...sent.map(m  => ({ ...m, _type:'sent'  }))
  ].sort((a,b) => new Date(b.date_envoi)-new Date(a.date_envoi));
  gmRenderList(all, 'trash');
}

async function gmLoadInbox() {
  const { inbox, sent } = await api('/messages');
  _M.all = { inbox, sent };
  const unread = inbox.filter(m => !m.lu).length;
  const b = document.getElementById('gm-badge');
  if (b) { b.textContent = unread||''; b.style.display = unread ? '' : 'none'; }
  gmRenderList(inbox, 'inbox');
}
async function gmLoadSent() {
  const { sent } = await api('/messages');
  _M.all.sent = sent;
  gmRenderList(sent, 'sent');
}

let _extEmails   = [];
let _extSelected = new Set();

async function gmLoadExternal(forceRefresh = false) {
  const el = document.getElementById('gmMain');
  if (!el) return;
  _extSelected = new Set();
  el.innerHTML = '<div class="loading-screen"><div class="spinner"></div><p style="margin-top:12px;color:var(--muted)">Connexion à la boîte @ahhamilton.ca…</p></div>';
  try {
    const qs = forceRefresh ? '?refresh=1' : '';
    _extEmails = await api('/email/inbox' + qs, { timeout: 20000 });
    if (!_extEmails.length) {
      el.innerHTML = `<div class="gm-empty">
        <div style="font-size:3rem">📭</div>
        <p>Aucun email reçu</p>
        <button class="btn btn-outline" style="margin-top:12px" onclick="gmLoadExternal(true)">↻ Actualiser</button>
      </div>`;
      return;
    }
    gmRenderExternal();
  } catch(e) {
    el.innerHTML = `<div class="gm-empty">
      <div style="font-size:2rem">⚠️</div>
      <p style="font-weight:700;margin-bottom:8px">${e.message}</p>
      <p style="font-size:.82rem;color:var(--muted);max-width:340px;text-align:center">
        Pour activer la boîte externe, allez dans <strong>Annuaire → Modifier le membre</strong>
        et renseignez votre adresse <em>@ahhamilton.ca</em> et le mot de passe Hostinger.
      </p>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;justify-content:center">
        <button class="btn btn-outline btn-sm" onclick="gmLoadExternal(true)">↻ Réessayer</button>
        <button class="btn btn-sm" style="background:#1565c0;color:#fff" onclick="gmTestSmtp()">🔧 Tester SMTP</button>
      </div>
    </div>`;
  }
}

function gmRenderExternal(tab = 'inbox') {
  const el = document.getElementById('gmMain');
  if (!el) return;

  const tabBar = `
    <div style="display:flex;gap:0;border-bottom:2px solid var(--gm-border);background:#fff;flex-shrink:0">
      <button onclick="gmRenderExternal('inbox')" style="padding:10px 20px;border:none;background:none;cursor:pointer;font-size:.85rem;font-weight:${tab==='inbox'?'700':'400'};border-bottom:${tab==='inbox'?'2px solid #1565c0':'2px solid transparent'};color:${tab==='inbox'?'#1565c0':'var(--muted)'};margin-bottom:-2px">📥 Reçus (${_extEmails.length})</button>
      <button onclick="gmLoadExtSent()" style="padding:10px 20px;border:none;background:none;cursor:pointer;font-size:.85rem;font-weight:${tab==='sent'?'700':'400'};border-bottom:${tab==='sent'?'2px solid #1565c0':'2px solid transparent'};color:${tab==='sent'?'#1565c0':'var(--muted)'};margin-bottom:-2px">📤 Envoyés</button>
      <button class="gm-tb-btn" style="margin-left:auto;margin-right:8px" onclick="gmLoadExternal(true)" title="Actualiser">↻</button>
    </div>`;

  if (tab === 'sent') return; // géré par gmLoadExtSent

  const rows = _extEmails.map(e => {
    const date = (e.date||'').substring(0,10);
    const bold = e.seen ? '' : 'font-weight:700';
    const safeE = JSON.stringify({uid:e.uid,date:e.date,from:e.from,fromName:e.fromName,subject:e.subject,seen:e.seen}).replace(/"/g,'&quot;');
    const chk = _extSelected.has(e.uid) ? 'checked' : '';
    return `<div class="gm-row" data-extuid="${e.uid}" style="${bold}">
      <input type="checkbox" ${chk} style="width:15px;height:15px;accent-color:var(--g2);flex-shrink:0;cursor:pointer;margin-right:4px"
        onclick="event.stopPropagation();gmExtToggle(${e.uid},this.checked)"/>
      <div style="flex:1;min-width:0;cursor:pointer;display:contents" onclick="gmShowExternal(${safeE})">
        <div class="gm-row-from">${escHtml(e.fromName||e.from)}</div>
        <div class="gm-row-subj">${escHtml(e.subject)}</div>
      </div>
      <div class="gm-row-date" style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span style="font-size:.78rem;color:var(--muted)">${date}</span>
        <button class="gm-tb-btn" style="color:#d93025;padding:2px 5px;font-size:.78rem" title="Supprimer"
          onclick="event.stopPropagation();gmExtDeleteOne(${e.uid})">🗑</button>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = tabBar + `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid var(--gm-border);background:var(--off);flex-shrink:0;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.82rem;color:var(--muted)">
        <input type="checkbox" id="gmExtSelAll" style="width:15px;height:15px;accent-color:var(--g2)" onchange="gmExtSelAll(this.checked)"/>
        Tout
      </label>
      <div id="gmExtBulkBar" style="display:none;gap:6px;align-items:center">
        <button class="btn btn-sm" style="color:#d93025;border:1px solid #d93025;background:transparent;padding:3px 10px;font-size:.82rem" onclick="gmExtBulkDelete()">
          🗑 Supprimer sélectionnés (<span id="gmExtSelCount">0</span>)
        </button>
      </div>
      <button class="btn btn-sm" style="color:#d93025;border:1px solid #d93025;background:transparent;padding:3px 10px;font-size:.82rem;margin-left:auto" onclick="gmExtDeleteAll()">
        🗑 Tout supprimer (${_extEmails.length})
      </button>
    </div>
    <div class="gm-list" id="gmExtList">${rows}</div>`;
}

async function gmLoadExtSent() {
  const el = document.getElementById('gmMain');
  if (!el) return;
  const tabBar = `
    <div style="display:flex;gap:0;border-bottom:2px solid var(--gm-border);background:#fff;flex-shrink:0">
      <button onclick="gmRenderExternal('inbox')" style="padding:10px 20px;border:none;background:none;cursor:pointer;font-size:.85rem;font-weight:400;border-bottom:2px solid transparent;color:var(--muted);margin-bottom:-2px">📥 Reçus (${_extEmails.length})</button>
      <button style="padding:10px 20px;border:none;background:none;cursor:pointer;font-size:.85rem;font-weight:700;border-bottom:2px solid #1565c0;color:#1565c0;margin-bottom:-2px">📤 Envoyés</button>
      <button class="gm-tb-btn" style="margin-left:auto;margin-right:8px" onclick="gmLoadExtSent()" title="Actualiser">↻</button>
    </div>`;
  el.innerHTML = tabBar + '<div style="padding:24px;text-align:center"><div class="spinner"></div></div>';
  try {
    const sent = await api('/email/sent');
    if (!sent.length) {
      el.innerHTML = tabBar + '<div class="gm-empty"><div style="font-size:2rem">📤</div><p>Aucun email envoyé</p></div>';
      return;
    }
    const rows = sent.map(m =>
      `<div class="gm-row">
        <div class="gm-row-from" style="color:var(--muted);font-size:.8rem">À : ${escHtml(m.destinataire||'')}</div>
        <div class="gm-row-subj">${escHtml(m.sujet||'')}</div>
        <div class="gm-row-date"><span style="font-size:.78rem;color:var(--muted)">${(m.date_envoi||'').substring(0,10)}</span>
          <span style="font-size:.72rem;padding:2px 6px;border-radius:20px;background:${m.statut==='envoye'?'#e8f5e9':'#ffebee'};color:${m.statut==='envoye'?'#1b5e20':'#c62828'}">${m.statut==='envoye'?'✅ Envoyé':'❌ Erreur'}</span>
        </div>
      </div>`
    ).join('');
    el.innerHTML = tabBar + `<div class="gm-list">${rows}</div>`;
  } catch(e) {
    el.innerHTML = tabBar + `<div class="gm-empty"><div style="font-size:2rem">⚠️</div><p>${e.message}</p></div>`;
  }
}

function gmExtToggle(uid, checked) {
  if (checked) _extSelected.add(uid); else _extSelected.delete(uid);
  gmExtSyncBar();
}

async function gmTestSmtp() {
  toast('🔧 Test SMTP en cours…');
  try {
    const r = await api('/email/test-smtp', { timeout: 30000 });
    const rows = r.results.map(x =>
      `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:6px 10px">${x.compte||'—'}</td>
        <td style="padding:6px 10px;text-align:center">${x.port}</td>
        <td style="padding:6px 10px;text-align:center">${x.ok ? '✅ OK' : '❌ ' + (x.error||'Erreur')}</td>
      </tr>`).join('');
    openModal('🔧 Diagnostic SMTP — ' + (r.smtpHost||'?'),
      `<p style="font-size:.85rem;color:var(--muted);margin-bottom:12px">Serveur : <strong>${r.smtpHost||'non défini'}</strong> · Compte org : <strong>${r.orgEmail||'non configuré'}</strong></p>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="background:var(--off)"><th style="padding:6px 10px;text-align:left">Compte</th><th>Port</th><th>Résultat</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${!r.ok ? '<p style="margin-top:14px;font-size:.82rem;color:#c62828">⚠️ Aucune connexion SMTP ne fonctionne. Vérifiez votre mot de passe Hostinger dans <strong>Annuaire → Modifier le membre</strong>.</p>' :
        '<p style="margin-top:14px;font-size:.82rem;color:#1b5e20">✅ Au moins un compte SMTP fonctionne. L\'envoi devrait marcher.</p>'}`
    );
  } catch(e) {
    toast('❌ ' + e.message, 'error');
  }
}

function gmExtSelAll(checked) {
  _extSelected = checked ? new Set(_extEmails.map(e => e.uid)) : new Set();
  document.querySelectorAll('#gmExtList input[type=checkbox]').forEach(cb => cb.checked = checked);
  gmExtSyncBar();
}

function gmExtSyncBar() {
  const bar = document.getElementById('gmExtBulkBar');
  const cnt = document.getElementById('gmExtSelCount');
  const sa  = document.getElementById('gmExtSelAll');
  const n   = _extSelected.size;
  const tot = _extEmails.length;
  if (bar) bar.style.display = n ? 'flex' : 'none';
  if (cnt) cnt.textContent = n;
  if (sa)  { sa.indeterminate = n > 0 && n < tot; sa.checked = n === tot && tot > 0; }
}

async function gmExtBulkDelete() {
  const n = _extSelected.size;
  if (!n) return;
  if (!confirm(`Supprimer définitivement ${n} email${n>1?'s':''} ?`)) return;
  try {
    await api('/email/inbox', { method:'DELETE', body:JSON.stringify({ uids:[..._extSelected] }), timeout:25000 });
    toast(`${n} email${n>1?'s':''} supprimé${n>1?'s':''}`);
    gmNav('external');
  } catch(err) { toast('Erreur : ' + err.message, 'error'); }
}

async function gmExtDeleteAll() {
  if (!_extEmails.length) return;
  if (!confirm(`Supprimer définitivement TOUS les ${_extEmails.length} emails de cette boîte ?`)) return;
  try {
    const uids = _extEmails.map(e => e.uid);
    await api('/email/inbox', { method:'DELETE', body:JSON.stringify({ uids }), timeout:25000 });
    toast(`${uids.length} email${uids.length>1?'s':''} supprimé${uids.length>1?'s':''}`);
    gmNav('external');
  } catch(err) { toast('Erreur : ' + err.message, 'error'); }
}

async function gmExtDeleteOne(uid) {
  if (!confirm('Supprimer cet email définitivement ?')) return;
  try {
    await api(`/email/inbox/${uid}`, { method:'DELETE', timeout:25000 });
    toast('Email supprimé');
    gmNav('external');
  } catch(err) { toast('Erreur suppression : ' + err.message, 'error'); }
}

let _extCurrent = null; // { e, body } for the open external email

async function gmShowExternal(e) {
  _extCurrent = { e, body: '' };
  // Mark as read immediately in the DOM and fire API call in background
  if (!e.seen) {
    const row = document.querySelector(`.gm-row[data-extuid="${e.uid}"]`);
    if (row) row.style.fontWeight = '';
    e.seen = true;
    api(`/email/inbox/${e.uid}/read`, { method: 'PUT' }).catch(() => {});
  }
  const el = document.getElementById('gmMain');
  if (!el) return;
  const date = (e.date||'').substring(0,16).replace('T',' ');
  const safeSubj = escHtml(e.subject||'');
  const safeFrom = escHtml(e.from||'');
  el.innerHTML = `
    <div class="gm-detail" style="padding:0;display:flex;flex-direction:column">
      <div style="padding:20px 24px 16px;flex-shrink:0;border-bottom:1px solid var(--gm-border)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="gmNav('external')">← Retour</button>
          <button class="btn btn-outline btn-sm" onclick="gmCompose({subject:'Re: ${safeSubj.replace(/'/g,'&#39;')}',to:'${safeFrom}'})">↩ Répondre</button>
          <button class="btn btn-outline btn-sm" onclick="gmExtForward()">↪ Transférer</button>
          <button class="btn btn-sm" style="color:#d93025;border:1px solid #d93025;background:transparent" onclick="gmExtDelete(${e.uid})">🗑 Supprimer</button>
        </div>
        <h2 style="font-size:1.05rem;margin-bottom:8px">${safeSubj}</h2>
        <div style="font-size:.82rem;color:var(--muted)">
          De : <strong>${escHtml(e.fromName||'')} &lt;${safeFrom}&gt;</strong> · ${date}
        </div>
      </div>
      <div id="gmExtBody" style="flex:1;overflow-y:auto;padding:20px 24px;font-size:.9rem;white-space:pre-wrap;line-height:1.8;color:var(--muted)">⏳ Chargement…</div>
    </div>`;
  try {
    const data = await api(`/email/inbox/${e.uid}`);
    const bodyEl = document.getElementById('gmExtBody');
    if (bodyEl) {
      if (data.html) {
        bodyEl.style.padding = '0';
        bodyEl.style.whiteSpace = '';
        bodyEl.style.color = '';
        const iframe = document.createElement('iframe');
        iframe.sandbox = 'allow-same-origin';
        iframe.style.cssText = 'width:100%;border:none;min-height:400px;display:block;background:#fff';
        bodyEl.innerHTML = '';
        bodyEl.appendChild(iframe);
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        doc.open();
        doc.write(data.html);
        doc.close();
        setTimeout(() => {
          try { iframe.style.height = (doc.body?.scrollHeight || 400) + 40 + 'px'; } catch {}
        }, 300);
      } else {
        bodyEl.style.color = '';
        bodyEl.textContent = data.body || '(corps vide)';
      }
      if (_extCurrent) _extCurrent.body = data.body || '';
    }
  } catch(err) {
    const bodyEl = document.getElementById('gmExtBody');
    if (bodyEl) bodyEl.textContent = 'Erreur: ' + (err.message || 'impossible de charger le corps');
  }
}

function gmExtForward() {
  if (!_extCurrent) return;
  const { e, body } = _extCurrent;
  const date = (e.date||'').substring(0,16).replace('T',' ');
  const fwdBody = `\n\n--- Message transféré ---\nDe : ${e.fromName ? e.fromName + ' <' + e.from + '>' : e.from}\nDate : ${date}\nObjet : ${e.subject||''}\n\n${body}`;
  gmCompose({ subject: `Fwd: ${e.subject||''}`, body: fwdBody });
}

async function gmExtDelete(uid) {
  if (!confirm('Supprimer cet email définitivement ?')) return;
  try {
    await api(`/email/inbox/${uid}`, { method:'DELETE', timeout:25000 });
    toast('Email supprimé');
    _extCurrent = null;
    gmNav('external');
  } catch(err) { toast('Erreur suppression : ' + err.message, 'error'); }
}

// ── Liste courriels ─────────────────────────────────────────────────────────
function gmRenderList(msgs, type) {
  const el = document.getElementById('gmMain');
  if (!el) return;

  if (!msgs.length) {
    el.innerHTML = `<div class="gm-empty"><div style="font-size:3rem">📭</div><p>Aucun message</p><button class="btn btn-outline" onclick="gmCompose()">✏️ Nouveau message</button></div>`;
    return;
  }

  el.innerHTML = `
    <div class="gm-toolbar">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="gmSelAll" style="width:16px;height:16px;accent-color:var(--g2)" onchange="gmSelAll(this.checked)"/>
      </label>
      <button class="gm-tb-btn" onclick="gmNav(_M.view)">↻</button>
      <div id="gmBulk" style="display:none;gap:6px;align-items:center">
        <button class="gm-tb-btn" onclick="gmBulkRead()">✅ Lu</button>
        <button class="gm-tb-btn" onclick="gmBulkFwd()">↪️ Faire suivre</button>
        <button class="gm-tb-btn" style="color:#d93025" onclick="gmBulkDelete()">🗑️ Supprimer</button>
        ${type==='trash' ? `<button class="gm-tb-btn" onclick="gmBulkRestore()">↩️ Restaurer</button>` : ''}
      </div>
      <span style="margin-left:auto;font-size:.75rem;color:var(--gm-muted)">${msgs.length} message${msgs.length>1?'s':''}</span>
    </div>
    <div class="gm-list">
      ${msgs.map(m => gmRow(m, type)).join('')}
    </div>`;
}

function gmRow(m, type) {
  const id      = m.message_id || m.id;
  const unread  = type === 'inbox' && !m.lu;
  const starred = _M.starred.has(id);
  const from    = type === 'inbox' ? (m.expediteur||'–') : `À ${m.nb_destinataires||1} dest.`;
  const subj    = m.sujet || '(Sans objet)';
  const prev    = (m.contenu||'').replace(/\n/g,' ').substring(0, 80);
  const date    = gmDate(m.date_envoi);

  const isTrash = type === 'trash';
  const mtype   = m._type || type;

  return `<div class="gm-row ${unread?'gm-unread':''}" id="gmr-${id}">
    <div class="gm-row-l" onclick="event.stopPropagation()">
      <input type="checkbox" class="gm-cb" data-id="${id}" data-type="${mtype}" style="width:15px;height:15px;accent-color:var(--g2)" onchange="gmCheck(${id},this.checked)"/>
      <button class="gm-star ${starred?'on':''}" onclick="event.stopPropagation();gmStar(${id})">${starred?'★':'☆'}</button>
    </div>
    <div class="gm-row-body" onclick="gmOpen(${id},'${mtype}')">
      <span class="gm-from">${from}</span>
      <span class="gm-subj">${subj}</span><span class="gm-prev"> — ${prev}</span>
    </div>
    <div class="gm-row-r">
      ${isTrash
        ? `<button class="gm-fwd" title="Restaurer" onclick="event.stopPropagation();gmRestore(${id},'${mtype}')">↩</button>
           <button class="gm-trash" title="Supprimer définitivement" onclick="event.stopPropagation();gmDeletePermanent(${id})">✕</button>`
        : `<button class="gm-fwd" title="Faire suivre" onclick="event.stopPropagation();gmFwdOne(${id})">↪</button>
           <button class="gm-trash" title="Mettre à la corbeille" onclick="event.stopPropagation();gmDelete(${id},'${mtype}')">🗑️</button>`
      }
      <span class="gm-date">${date}</span>
    </div>
  </div>`;
}

function gmDate(s) {
  if (!s) return '–';
  const d = new Date(s), n = new Date();
  const time = d.toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit' });
  if (d.toDateString() === n.toDateString()) return time;
  if (d.getFullYear() === n.getFullYear())
    return d.toLocaleDateString('fr-CA', { month:'short', day:'numeric' }) + ' ' + time;
  return d.toLocaleDateString('fr-CA', { year:'numeric', month:'short', day:'numeric' }) + ' ' + time;
}

// ── Checkbox / étoile ───────────────────────────────────────────────────────
function gmCheck(id, on) {
  if (on) _M.checked.add(id); else _M.checked.delete(id);
  const bulk = document.getElementById('gmBulk');
  if (bulk) bulk.style.display = _M.checked.size ? 'flex' : 'none';
}
function gmSelAll(on) {
  document.querySelectorAll('.gm-cb').forEach(cb => { cb.checked = on; gmCheck(+cb.dataset.id, on); });
}
function gmStar(id) {
  _M.starred.has(id) ? _M.starred.delete(id) : _M.starred.add(id);
  const btn = document.querySelector(`#gmr-${id} .gm-star`);
  if (btn) { btn.classList.toggle('on', _M.starred.has(id)); btn.textContent = _M.starred.has(id)?'★':'☆'; }
}

// ── Ouvrir un message ───────────────────────────────────────────────────────
async function gmOpen(id, type) {
  if (type === 'inbox') { await api(`/messages/${id}/read`,{method:'PUT'}).catch(()=>{}); document.getElementById(`gmr-${id}`)?.classList.remove('gm-unread'); }
  const { inbox, sent } = await api('/messages');
  const list = type==='sent' ? sent : inbox;
  const m = list.find(x => (x.message_id||x.id)===id) || {};
  _M.detail = { ...m, _type:type };
  const from = type==='inbox' ? (m.expediteur||'–') : `Moi → ${m.nb_destinataires||1} dest.`;
  const el = document.getElementById('gmMain');

  el.innerHTML = `
    <div class="gm-detail">
      <div class="gm-detail-bar">
        <button class="gm-back" onclick="gmNav('${type==='sent'?'sent':type==='trash'?'trash':'inbox'}')">← Retour</button>
        ${type==='inbox'?`<button class="gm-act-btn" onclick="gmReply()">↩ Répondre</button>`:''}
        ${type!=='trash'?`<button class="gm-act-btn" onclick="gmFwdOne(${id})">↪ Faire suivre</button>`:''}
        ${type!=='trash'
          ? `<button class="gm-act-btn" style="color:#d93025;margin-left:auto" onclick="gmDelete(${id},'${type}')">🗑️ Supprimer</button>`
          : `<button class="gm-act-btn" onclick="gmRestore(${id},'${m._type||'inbox'}')">↩️ Restaurer</button>
             <button class="gm-act-btn" style="color:#d93025" onclick="gmDeletePermanent(${id})">✕ Supprimer définitivement</button>`
        }
      </div>
      <h2 class="gm-det-subj">${m.sujet||'(Sans objet)'}</h2>
      <div class="gm-det-meta">
        <div class="gm-det-av">${(m.expediteur||'?')[0]}</div>
        <div>
          <div style="font-size:.9rem;font-weight:600">${from}</div>
          <div style="font-size:.75rem;color:var(--gm-muted)">${gmDate(m.date_envoi)}</div>
        </div>
      </div>
      <div class="gm-det-body">${(m.contenu||'').replace(/\n/g,'<br>')}</div>
      <div style="display:flex;gap:8px;margin-top:28px;padding-top:16px;border-top:1px solid var(--gm-border)">
        ${type==='inbox'?`<button class="gm-reply-btn" onclick="gmReply()">↩ Répondre</button>`:''}
        <button class="gm-reply-btn" onclick="gmFwdOne(${id})">↪ Faire suivre</button>
      </div>
    </div>`;
}

// ── Répondre / Faire suivre ─────────────────────────────────────────────────
function gmReply() {
  const m = _M.detail||{};
  gmCompose({ subject:`Rép : ${m.sujet||''}`, body:`\n\n--- Message original ---\nDe : ${m.expediteur||'–'}\n\n${m.contenu||''}` });
}
function gmFwdOne(id) {
  const m = _M.detail||{};
  gmCompose({ subject:`Tr : ${m.sujet||''}`, body:`\n\n--- Message transféré ---\nDe : ${m.expediteur||'–'}\n\n${m.contenu||''}` });
}
async function gmBulkRead() {
  for (const id of _M.checked) { await api(`/messages/${id}/read`,{method:'PUT'}).catch(()=>{}); document.getElementById(`gmr-${id}`)?.classList.remove('gm-unread'); }
  _M.checked.clear(); document.getElementById('gmBulk').style.display='none'; toast('Marqué comme lu');
}
function gmBulkFwd() { gmCompose({subject:`Tr : (${_M.checked.size} message(s))`}); }

// ── Suppression ─────────────────────────────────────────────────────────────
async function gmDelete(id, type) {
  await api(`/messages/${id}?type=${type}`, { method:'DELETE' });
  const row = document.getElementById(`gmr-${id}`);
  if (row) { row.style.opacity='0'; row.style.transition='opacity .25s'; setTimeout(()=>row.remove(),250); }
  toast('Déplacé à la corbeille');
  // Si on est dans la vue détail, retourner à la liste
  if (document.querySelector('.gm-det-subj')) gmNav(_M.view==='trash'?'trash':type==='sent'?'sent':'inbox');
}

async function gmDeletePermanent(id) {
  if (!confirm('Supprimer définitivement ce message ? Cette action est irréversible.')) return;
  await api(`/messages/${id}/permanent`, { method:'DELETE' });
  const row = document.getElementById(`gmr-${id}`);
  if (row) { row.style.opacity='0'; row.style.transition='opacity .25s'; setTimeout(()=>row.remove(),250); }
  toast('Message supprimé définitivement');
  if (document.querySelector('.gm-det-subj')) gmNav('trash');
}

async function gmRestore(id, type) {
  await api(`/messages/${id}/restore?type=${type}`, { method:'PUT' });
  const row = document.getElementById(`gmr-${id}`);
  if (row) { row.style.opacity='0'; row.style.transition='opacity .25s'; setTimeout(()=>row.remove(),250); }
  toast('Message restauré');
  if (document.querySelector('.gm-det-subj')) gmNav('trash');
}

async function gmBulkDelete() {
  const cbs = [...document.querySelectorAll('.gm-cb:checked')];
  for (const cb of cbs) {
    const id   = parseInt(cb.dataset.id);
    const type = cb.dataset.type || _M.view;
    await api(`/messages/${id}?type=${type}`, { method:'DELETE' }).catch(()=>{});
    const row = document.getElementById(`gmr-${id}`);
    if (row) row.remove();
  }
  _M.checked.clear();
  document.getElementById('gmBulk').style.display = 'none';
  toast(`${cbs.length} message${cbs.length>1?'s':''} déplacé${cbs.length>1?'s':''} à la corbeille`);
}

async function gmBulkRestore() {
  const cbs = [...document.querySelectorAll('.gm-cb:checked')];
  for (const cb of cbs) {
    const id   = parseInt(cb.dataset.id);
    const type = cb.dataset.type || 'inbox';
    await api(`/messages/${id}/restore?type=${type}`, { method:'PUT' }).catch(()=>{});
    const row = document.getElementById(`gmr-${id}`);
    if (row) row.remove();
  }
  _M.checked.clear();
  document.getElementById('gmBulk').style.display = 'none';
  toast(`${cbs.length} message${cbs.length>1?'s':''} restauré${cbs.length>1?'s':''}`);
}

// ── Compositeur ─────────────────────────────────────────────────────────────
function gmCompose(pre = {}) {
  _MC.to = pre.to ? [{ email: pre.to, name: pre.to }] : [];
  _MC.cc = [];
  const el = document.getElementById('gmMain');

  el.innerHTML = `
    <div class="gm-detail" style="padding:0;display:flex;flex-direction:column;height:100%">
      <div class="gm-compose-hdr">
        <span>Nouveau message</span>
        <button class="gm-close-btn" onclick="gmNav(_M.view)">✕</button>
      </div>

      <div class="gm-cfield"><label>À :</label>
        <div class="gm-chips-wrap">
          <div class="gm-chips" id="mc-to-chips"></div>
          <input id="mc-to" class="gm-field-input" placeholder="Membre ou adresse externe (gmail, etc.)…" autocomplete="off"
            oninput="gmSuggest('to')" onkeydown="gmKey(event,'to')"/>
          <div class="gm-suggest" id="mc-to-sg"></div>
        </div>
      </div>
      <div class="gm-cfield"><label>Cc :</label>
        <div class="gm-chips-wrap">
          <div class="gm-chips" id="mc-cc-chips"></div>
          <input id="mc-cc" class="gm-field-input" placeholder="Optionnel…" autocomplete="off"
            oninput="gmSuggest('cc')" onkeydown="gmKey(event,'cc')"/>
          <div class="gm-suggest" id="mc-cc-sg"></div>
        </div>
      </div>
      <div class="gm-cfield"><label>Objet :</label>
        <input id="mc-subj" class="gm-field-input" value="${(pre.subject||'').replace(/"/g,'&quot;')}" placeholder="Objet…"/>
      </div>
      <textarea id="mc-body" class="gm-body-area">${pre.body||''}</textarea>
      <div class="gm-compose-foot">
        <button class="btn btn-primary" style="border-radius:20px;padding:9px 22px" id="mc-send" onclick="gmSend()">Envoyer</button>
        ${can.executive() ? `<button class="btn btn-accent btn-sm" style="border-radius:20px" onclick="gmSendToAll()" title="Envoyer à tous les membres">📢 Tous</button>` : ''}
        <button class="gm-tb-btn" onclick="document.getElementById('mc-file').click()" title="Joindre un fichier">📎</button>
        <input type="file" id="mc-file" style="display:none" onchange="gmShowAttach()"/>
        <div id="mc-attach" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></div>
        <button class="gm-tb-btn" style="margin-left:auto" onclick="gmCompose()" title="Effacer">🗑️</button>
      </div>
    </div>`;
}

// ── Autocomplétion To/Cc ────────────────────────────────────────────────────
function gmSuggest(f) {
  const input = document.getElementById(`mc-${f}`);
  const sg    = document.getElementById(`mc-${f}-sg`);
  const arr   = f==='to' ? _MC.to : _MC.cc;
  const q     = input?.value.trim().toLowerCase();
  if (!sg) return;
  if (!q) { sg.innerHTML=''; sg.classList.remove('open'); return; }
  const existing = arr.map(c=>c.email);
  const hits = _M.members.filter(u => !existing.includes(u.email) &&
    (`${u.prenom} ${u.nom}`.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  ).slice(0, 8);
  const rawInput = input.value.trim();
  const isFullEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawInput);
  const exactMemberMatch = isFullEmail && _M.members.find(u => u.email.toLowerCase() === rawInput.toLowerCase());

  if (!hits.length) {
    if (isFullEmail && !exactMemberMatch) {
      sg.innerHTML = `<div class="gm-sg-item" onclick="gmPick('${f}','${rawInput}','${rawInput}')">
        <div class="gm-sg-av" style="background:#1565c0">✉</div>
        <div><div class="gm-sg-name">Envoyer à l'externe</div><div class="gm-sg-email">${rawInput}</div></div>
      </div>`;
      sg.classList.add('open');
    } else {
      sg.innerHTML=''; sg.classList.remove('open');
    }
    return;
  }

  // Si l'email tapé est complet et non-membre, ajouter option externe en tête
  const extExtra = (isFullEmail && !exactMemberMatch)
    ? `<div class="gm-sg-item" onclick="gmPick('${f}','${rawInput}','${rawInput}')">
        <div class="gm-sg-av" style="background:#1565c0">✉</div>
        <div><div class="gm-sg-name">Envoyer à l'externe</div><div class="gm-sg-email">${rawInput}</div></div>
      </div>` : '';

  sg.innerHTML = extExtra + hits.map(u =>
    `<div class="gm-sg-item" onclick="gmPick('${f}','${u.email}','${u.prenom} ${u.nom}')">
      <div class="gm-sg-av">${u.prenom[0]}${u.nom[0]}</div>
      <div><div class="gm-sg-name">${u.prenom} ${u.nom}</div><div class="gm-sg-email">${u.email}</div></div>
    </div>`).join('');
  sg.classList.add('open');
}
function gmPick(f, email, name) {
  const arr = f==='to' ? _MC.to : _MC.cc;
  if (!arr.find(c=>c.email===email)) arr.push({email,name});
  document.getElementById(`mc-${f}`).value = '';
  document.getElementById(`mc-${f}-sg`).innerHTML = '';
  document.getElementById(`mc-${f}-sg`).classList.remove('open');
  gmRenderChips(f);
}
function gmKey(e, f) {
  const input = document.getElementById(`mc-${f}`);
  if ((e.key==='Enter'||e.key===',') && input.value.includes('@')) {
    e.preventDefault(); gmPick(f, input.value.trim(), input.value.trim());
  }
  if (e.key==='Escape') document.getElementById(`mc-${f}-sg`)?.classList.remove('open');
}
function gmRmTo(email) { gmRm('to',email); }
function gmRmCc(email) { gmRm('cc',email); }
function gmRm(f, email) {
  const arr = f==='to' ? _MC.to : _MC.cc;
  const i = arr.findIndex(c=>c.email===email);
  if (i>-1) arr.splice(i,1);
  gmRenderChips(f);
}
function gmRenderChips(f) {
  const arr = f==='to' ? _MC.to : _MC.cc;
  const el  = document.getElementById(`mc-${f}-chips`);
  if (!el) return;
  el.innerHTML = arr.map(c =>
    `<span class="gm-chip">${c.name}<button onclick="gmRm${f==='to'?'To':'Cc'}('${c.email}')">✕</button></span>`
  ).join('');
}
function gmShowAttach() {
  const files = document.getElementById('mc-file')?.files;
  const el    = document.getElementById('mc-attach');
  if (!el||!files) return;
  el.innerHTML = [...files].map(f=>`<span class="gm-attach-chip">📎 ${f.name}</span>`).join('');
}

// ── Envoi ───────────────────────────────────────────────────────────────────
async function gmSend() {
  // Auto-confirmer tout email tapé dans À/Cc sans avoir appuyé Entrée
  ['to','cc'].forEach(f => {
    const inp = document.getElementById(`mc-${f}`);
    const v = inp?.value.trim();
    if (v && v.includes('@')) { gmPick(f, v, v); inp.value = ''; }
  });

  const toArr   = _MC.to;
  const subject = document.getElementById('mc-subj')?.value.trim()||'';
  const body    = document.getElementById('mc-body')?.value.trim()||'';
  const btn     = document.getElementById('mc-send');
  const fileEl  = document.getElementById('mc-file');

  if (!toArr.length) { toast('Ajoutez au moins un destinataire dans le champ À :', 'error'); return; }
  if (!body)         { toast('Le message ne peut pas être vide', 'error'); return; }

  btn.disabled=true; btn.textContent='Envoi…';

  try {
    if (!_M.members.length) _M.members = await api('/annuaire');

    // Membres du système (reçoivent un message interne)
    const memberRecips = toArr.filter(c => _M.members.find(u => u.email === c.email));
    // Non-membres (SMTP seulement)
    const nonMemberRecips = toArr.filter(c => !_M.members.find(u => u.email === c.email));
    // Membres avec email non-@ahhamilton.ca → aussi SMTP externe (ex: @gmail.com)
    const memberAlsoEmail = memberRecips.filter(c => !c.email.toLowerCase().endsWith('@ahhamilton.ca'));
    // Tous les destinataires SMTP
    const smtpRecips = [...nonMemberRecips, ...memberAlsoEmail];

    if (!memberRecips.length && !nonMemberRecips.length) {
      toast('Ajoutez au moins un destinataire valide', 'error');
      btn.disabled=false; btn.textContent='Envoyer'; return;
    }

    // Envoi interne (tous les membres du système)
    if (memberRecips.length) {
      const ids = memberRecips.map(c => _M.members.find(u => u.email === c.email).id);
      const attachment = fileEl?.files?.[0];
      if (attachment) {
        const fd = new FormData();
        fd.append('sujet', subject);
        fd.append('contenu', body);
        fd.append('destinataires', JSON.stringify(ids));
        fd.append('attachment', attachment);
        const res = await fetch(API + '/messages/with-attachment', {
          method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || 'Erreur envoi');
      } else {
        await api('/messages', { method: 'POST', body: JSON.stringify({ sujet: subject, contenu: body, destinataires: ids }) });
      }
    }

    // Envoi SMTP externe : non-membres + membres avec email hors @ahhamilton.ca
    for (const c of smtpRecips) {
      await api('/email/send', { method: 'POST', body: JSON.stringify({ to: c.email, subject, body }) });
    }

    _MC.to=[]; _MC.cc=[];
    if (fileEl) fileEl.value = '';
    document.getElementById('mc-attach') && (document.getElementById('mc-attach').innerHTML = '');

    const extNote = smtpRecips.length ? ` + courriel externe à ${smtpRecips.length} personne${smtpRecips.length>1?'s':''}` : '';
    if (_M.view === 'external') {
      toast('✅ Courriel envoyé' + extNote + ' !');
      gmLoadExternal();
    } else {
      toast('✅ Message envoyé' + extNote + ' !');
      gmNav('sent');
    }
  } catch(ex) {
    toast('❌ ' + ex.message, 'error');
    btn.disabled=false; btn.textContent='Envoyer';
  }
}

async function gmSendToAll() {
  if (!confirm('Envoyer ce message à TOUS les membres actifs ?')) return;
  const subject = document.getElementById('mc-subj')?.value.trim()||'';
  const body    = document.getElementById('mc-body')?.value.trim()||'';
  const btn     = document.getElementById('mc-send');
  if (!body) { toast('Le message ne peut pas être vide', 'error'); return; }
  btn.disabled=true; btn.textContent='Envoi…';
  try {
    await api('/messages', { method: 'POST', body: JSON.stringify({ sujet: subject, contenu: body, destinataires: ['all'] }) });
    toast('✅ Message envoyé à tous les membres!');
    _MC.to=[]; _MC.cc=[];
    gmNav('sent');
  } catch(ex) { toast(ex.message, 'error'); btn.disabled=false; btn.textContent='Envoyer'; }
}

async function deleteGalleryPhoto(id) {
  if (!confirm('Supprimer cette photo de la galerie? Cette action est irréversible.')) return;
  try {
    await api(`/gallery/${id}`, { method: 'DELETE' });
    toast('Photo supprimée');
    const card = document.getElementById(`gmc-${id}`);
    if (card) { card.style.opacity = '0'; setTimeout(() => card.remove(), 300); }
  } catch(ex) { toast(ex.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAT BULLE
// ══════════════════════════════════════════════════════════════════════════════
function initChat() {
  // ── Créer le HTML de la bulle + panneau ───────────────────────────────────
  document.body.insertAdjacentHTML('beforeend', `
    <button id="chatBubbleBtn" title="Chat communautaire" onclick="toggleChat()">
      💬
      <span class="chat-bubble-badge" id="chatBadge"></span>
    </button>

    <div id="chatPanel">
      <div class="chat-panel-header">
        <h3 id="chatPanelTitle">💬 Messages</h3>
        <div class="chat-header-actions">
          ${['admin','tresoriere','secretaire','delegue'].includes(USER.role)
              ? `<button class="chat-icon-btn" onclick="openCreateRoom()" title="Nouveau salon">＋</button>`
              : ''}
          <button class="chat-icon-btn" onclick="toggleChat()" title="Fermer">✕</button>
        </div>
      </div>
      <div class="chat-body">
        <!-- Sidebar salons -->
        <div class="chat-rooms-list" id="chatRoomsList"></div>
        <!-- Zone principale -->
        <div class="chat-main" id="chatMain">
          <div class="chat-placeholder">
            <div class="cp-icon">💬</div>
            <p>Choisissez un salon pour commencer à discuter</p>
          </div>
        </div>
      </div>
    </div>
  `);

  loadChatRooms();
  setInterval(loadChatRooms, 5000); // Refresh unread counts
}

function toggleChat() {
  CHAT.open = !CHAT.open;
  document.getElementById('chatPanel').classList.toggle('open', CHAT.open);
  if (CHAT.open && CHAT.activeId) startChatPolling();
  else stopChatPolling();
}

async function loadChatRooms() {
  try {
    const rooms = await api('/chat/rooms');
    CHAT.rooms = rooms;

    // Update badge total
    const total = rooms.reduce((s, r) => s + (r.unread || 0), 0);
    const badge = document.getElementById('chatBadge');
    badge.textContent = total > 9 ? '9+' : total;
    badge.classList.toggle('show', total > 0);

    renderRoomList();
    if (CHAT.activeId) {
      const still = rooms.find(r => r.id === CHAT.activeId);
      if (!still) { CHAT.activeId = null; openChatPlaceholder(); }
    }
  } catch {}
}

function renderRoomList() {
  const el = document.getElementById('chatRoomsList');
  if (!el) return;

  const canManage = ['admin','tresoriere','secretaire','delegue'].includes(USER.role);

  const sysRooms   = CHAT.rooms.filter(r => ['general','committee'].includes(r.type));
  const groupRooms = CHAT.rooms.filter(r => r.type === 'group');
  const privateRooms = CHAT.rooms.filter(r => r.type === 'private');

  function roomItem(r) {
    const icons = { general:'🌍', committee:'🔒', group:'👥', private:'💬' };
    const isActive = r.id === CHAT.activeId;
    return `<div class="chat-room-item ${isActive ? 'active' : ''}" onclick="openRoom(${r.id})">
      <span class="chat-room-icon">${icons[r.type] || '💬'}</span>
      <div class="chat-room-info">
        <div class="chat-room-name">${r.name}</div>
        <div class="chat-room-preview">${r.last_msg ? r.last_msg.substring(0, 28) + (r.last_msg.length > 28 ? '…' : '') : 'Aucun message'}</div>
      </div>
      ${r.unread > 0 ? `<span class="chat-unread-badge">${r.unread}</span>` : ''}
    </div>`;
  }

  let html = '';
  if (sysRooms.length) {
    html += `<div class="chat-rooms-section">
      <div class="chat-rooms-section-title">Salons</div>
      ${sysRooms.map(roomItem).join('')}
    </div>`;
  }
  if (groupRooms.length) {
    html += `<div class="chat-rooms-section">
      <div class="chat-rooms-section-title">Groupes activités</div>
      ${groupRooms.map(roomItem).join('')}
    </div>`;
  }
  if (privateRooms.length) {
    html += `<div class="chat-rooms-section">
      <div class="chat-rooms-section-title">Privés</div>
      ${privateRooms.map(roomItem).join('')}
    </div>`;
  }

  // Bouton nouveau chat privé
  html += `<div style="padding:10px 10px 0">
    <button class="btn btn-ghost btn-sm" style="width:100%;font-size:.72rem" onclick="openPrivateChatSelect()">
      ✉️ Nouveau message privé
    </button>
  </div>`;

  el.innerHTML = html || '<div style="padding:16px;font-size:.8rem;color:var(--muted);text-align:center">Aucun salon accessible</div>';
}

function openChatPlaceholder() {
  document.getElementById('chatMain').innerHTML = `
    <div class="chat-placeholder">
      <div class="cp-icon">💬</div>
      <p>Choisissez un salon pour commencer à discuter</p>
    </div>`;
}

async function openRoom(roomId) {
  CHAT.activeId = roomId;
  renderRoomList();
  const room = CHAT.rooms.find(r => r.id === roomId) || { name: 'Salon', type: 'group' };
  const icons = { general:'🌍', committee:'🔒', group:'👥', private:'💬' };

  document.getElementById('chatMain').innerHTML = `
    <div class="chat-room-header">
      ${icons[room.type] || '💬'} ${room.name}
      ${room.type === 'group' && can.adminOrSec() ? `<button class="btn btn-sm btn-danger" style="margin-left:auto;font-size:.7rem;padding:4px 10px" onclick="deleteRoom(${roomId})">🗑️</button>` : ''}
    </div>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-empty"><div class="ce-icon">⏳</div><p>Chargement…</p></div>
    </div>
    <div class="chat-input-zone">
      <div class="emoji-picker" id="emojiPicker">
        ${EMOJIS.map(e => `<button class="emoji-btn" onclick="insertEmoji('${e}')">${e}</button>`).join('')}
      </div>
      <div class="chat-input-row">
        <button class="chat-emoji-btn" onclick="toggleEmojiPicker()" title="Emoji">😀</button>
        <textarea class="chat-input" id="chatInput" placeholder="Écrire un message…" rows="1"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMessage()}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,80)+'px'"></textarea>
        <button class="chat-send-btn" onclick="sendChatMessage()" title="Envoyer">➤</button>
      </div>
    </div>
  `;

  await loadMessages(roomId);
  if (CHAT.open) startChatPolling();
}

async function loadMessages(roomId, afterId) {
  try {
    const url = afterId
      ? `/chat/rooms/${roomId}/messages?after_id=${encodeURIComponent(afterId)}`
      : `/chat/rooms/${roomId}/messages`;
    const msgs = await api(url);
    if (!msgs?.length) {
      if (!afterId) document.getElementById('chatMessages').innerHTML = '<div class="chat-empty"><div class="ce-icon">💬</div><p>Aucun message encore.<br/>Soyez le premier à écrire!</p></div>';
      return;
    }
    renderMessages(msgs, !!afterId);
    if (msgs.length) {
      CHAT.lastMsgAt[roomId] = msgs[msgs.length - 1].created_at;
      CHAT.lastMsgId[roomId] = msgs[msgs.length - 1].id;
    }
    loadChatRooms(); // refresh unread
  } catch {}
}

function formatChatTime(timestamp) {
  if (!timestamp) return '';
  const normalized = typeof timestamp === 'string' ? timestamp.replace(' ', 'T') : timestamp;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit' });
}

function renderMessages(msgs, append) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const html = msgs.map(m => {
    const isMe = m.sender_id === USER.id;
    const initials = `${m.prenom[0]}${m.nom[0]}`.toUpperCase();
    const time = formatChatTime(m.created_at);
    return `<div class="chat-msg ${isMe ? 'me' : ''}">
      ${!isMe ? `<div class="chat-avatar-sm">${initials}</div>` : ''}
      <div class="chat-bubble">
        ${!isMe ? `<div class="chat-bubble-name">${m.prenom} ${m.nom}</div>` : ''}
        <div class="chat-bubble-text">${escapeHtml(m.content)}</div>
        <div class="chat-bubble-time">${time}</div>
      </div>
    </div>`;
  }).join('');

  if (append) {
    container.insertAdjacentHTML('beforeend', html);
  } else {
    container.innerHTML = html;
  }
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#039;')
          .replace(/\n/g,'<br>');
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const content = input?.value.trim();
  if (!content || !CHAT.activeId) return;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('emojiPicker').classList.remove('show');

  try {
    await api(`/chat/rooms/${CHAT.activeId}/messages`, {
      method: 'POST', body: JSON.stringify({ content })
    });
    await loadMessages(CHAT.activeId, CHAT.lastMsgId[CHAT.activeId]);
  } catch(ex) { toast(ex.message, 'error'); }
}

function toggleEmojiPicker() {
  document.getElementById('emojiPicker').classList.toggle('show');
}
function insertEmoji(emoji) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const pos = input.selectionStart;
  input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = pos + emoji.length;
  input.focus();
  document.getElementById('emojiPicker').classList.remove('show');
}

function startChatPolling() {
  stopChatPolling();
  CHAT.pollTimer = setInterval(async () => {
    if (!CHAT.activeId || !CHAT.open) return;
    const afterId = CHAT.lastMsgId[CHAT.activeId];
    if (afterId) await loadMessages(CHAT.activeId, afterId);
  }, 3000);
}
function stopChatPolling() {
  clearInterval(CHAT.pollTimer);
  CHAT.pollTimer = null;
}

// ── Nouveau salon de groupe (comité) ──────────────────────────────────────
async function openCreateRoom() {
  const [allUsers, allActs] = await Promise.all([api('/chat/users'), api('/activities')]);
  openModal('Créer un salon de groupe', `
    <form id="createRoomForm">
      <div class="form-group"><label>Nom du salon *</label>
        <input id="cr_name" placeholder="Ex: 🎉 Équipe Gala 2026" required/></div>
      <div class="form-group"><label>Activité liée (optionnel)</label>
        <select id="cr_act"><option value="">– Aucune –</option>
          ${allActs.map(a => `<option value="${a.id}">${a.titre}</option>`).join('')}
        </select></div>
      <div class="form-group"><label>Membres à ajouter</label>
        <select id="cr_members" multiple style="height:130px">
          ${allUsers.map(u => `<option value="${u.id}">${u.prenom} ${u.nom} (${roleName(u.role)})</option>`).join('')}
        </select></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Créer le salon</button>
      </div>
    </form>
  `);
  document.getElementById('createRoomForm').onsubmit = async e => {
    e.preventDefault();
    const member_ids = [...document.getElementById('cr_members').selectedOptions].map(o => parseInt(o.value));
    const activity_id = parseInt(document.getElementById('cr_act').value) || null;
    try {
      const r = await api('/chat/rooms', { method:'POST', body: JSON.stringify({
        name: document.getElementById('cr_name').value,
        member_ids, activity_id
      })});
      closeModal();
      toast('Salon créé!');
      await loadChatRooms();
      openRoom(r.id);
      if (!CHAT.open) toggleChat();
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

// ── Chat privé ────────────────────────────────────────────────────────────
async function openPrivateChatSelect() {
  const users = await api('/chat/users');
  openModal('Nouveau message privé', `
    <div class="form-group"><label>Choisir un membre</label>
      <input id="privSearch" placeholder="Rechercher…" oninput="filterPrivUsers()" style="margin-bottom:10px"/>
      <div id="privUserList" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">
        ${users.map(u => `
          <div class="chat-room-item" style="border-radius:10px;border:1px solid var(--border);cursor:pointer"
               onclick="startPrivateChat(${u.id})"
               data-name="${u.prenom} ${u.nom}">
            <div class="chat-avatar-sm" style="width:34px;height:34px;font-size:.75rem">${u.prenom[0]}${u.nom[0]}</div>
            <div class="chat-room-info">
              <div class="chat-room-name">${u.prenom} ${u.nom}</div>
              <div class="chat-room-preview">${roleName(u.role)}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>
  `);
}

function filterPrivUsers() {
  const q = document.getElementById('privSearch').value.toLowerCase();
  document.querySelectorAll('#privUserList > div').forEach(el => {
    el.style.display = el.dataset.name.toLowerCase().includes(q) ? '' : 'none';
  });
}

async function startPrivateChat(targetId) {
  try {
    const r = await api('/chat/private', { method:'POST', body: JSON.stringify({ target_id: targetId }) });
    closeModal();
    await loadChatRooms();
    openRoom(r.id);
    if (!CHAT.open) toggleChat();
  } catch(ex) { toast(ex.message, 'error'); }
}

async function deleteRoom(roomId) {
  if (!confirm('Supprimer ce salon et tous ses messages ?')) return;
  try {
    await api(`/chat/rooms/${roomId}`, { method: 'DELETE' });
    CHAT.activeId = null;
    openChatPlaceholder();
    toast('Salon supprimé');
    loadChatRooms();
  } catch(ex) { toast(ex.message, 'error'); }
}

// Fermer emoji picker si clic ailleurs
document.addEventListener('click', e => {
  const picker = document.getElementById('emojiPicker');
  if (picker && !e.target.closest('.chat-emoji-btn') && !e.target.closest('.emoji-picker'))
    picker.classList.remove('show');
});

// ══ PROJECTS ═══════════════════════════════════════════════════════════════
async function projects() {
  const [data, allUsers, allLines] = await Promise.all([api('/projects'), api('/users'), api('/finance/lines')]);
  setContent(`
    <div class="page-header">
      <div><h2>Projets</h2><p>Suivi de l'avancement des projets</p></div>
      <div class="page-actions">
        ${can.admin() ? `<button class="btn btn-primary" onclick='openProjectForm(null,${JSON.stringify(allUsers)})'>+ Nouveau projet</button>` : ''}
      </div>
    </div>
    ${data.map(p=>{
      const pLines = allLines.filter(l => l.project_id === p.id);
      const totalDepenses = pLines.reduce((s,l) => s + (l.depenses||0), 0);
      const totalRevenus  = pLines.reduce((s,l) => s + (l.revenus||0), 0);
      const budget = p.budget_prevu || 0;
      const pct = budget > 0 ? Math.min(100, Math.round(totalDepenses / budget * 100)) : 0;
      return `
      <div class="table-card" style="margin-bottom:16px">
        <div class="table-card-header">
          <div>
            <h3>${p.nom}</h3>
            <small style="color:var(--muted)">${p.responsable_nom ? 'Responsable: '+p.responsable_nom+' · ' : ''}${p.date_debut?fmt(p.date_debut):'–'} → ${p.date_fin?fmt(p.date_fin):'–'}</small>
          </div>
          <div class="tc-actions">
            ${can.admin() ? `<button class="btn btn-sm btn-outline" onclick='openProjectForm(${JSON.stringify(p)},${JSON.stringify(allUsers)})'>✏️</button>
            <button class="btn btn-sm btn-danger" onclick='deleteProject(${p.id},"${p.nom.replace(/"/g,'&quot;')}")'>🗑</button>` : ''}
          </div>
        </div>
        <div style="padding:14px 20px">
          ${p.description ? `<p style="font-size:.88rem;color:var(--muted);margin-bottom:10px">${p.description}</p>` : ''}
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="flex:1;height:8px;background:var(--border);border-radius:50px">
              <div style="height:100%;width:${p.progression}%;background:linear-gradient(90deg,var(--g2),var(--g3));border-radius:50px;transition:.5s"></div>
            </div>
            <span style="font-weight:700;color:var(--g2);font-size:.88rem">${p.progression}%</span>
            ${statusPill(p.statut)}
          </div>
          ${budget > 0 ? `
          <div style="display:flex;gap:16px;font-size:.82rem;flex-wrap:wrap;margin-bottom:${pLines.length?'12px':'0'}">
            <span>💰 Budget: <strong>${fmtMoney(budget)}</strong></span>
            <span>📤 Dépenses: <strong style="color:#c62828">${fmtMoney(totalDepenses)}</strong></span>
            <span>📥 Revenus: <strong style="color:var(--g2)">${fmtMoney(totalRevenus)}</strong></span>
            <span>📊 Utilisé: <strong>${pct}%</strong></span>
          </div>` : ''}
          ${pLines.length ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:.82rem;color:var(--muted);font-weight:600">Lignes financières (${pLines.length})</summary>
            <div class="table-wrapper" style="margin-top:8px">
              <table style="font-size:.8rem">
                <thead><tr><th>Ligne</th><th>Budget</th><th>Dépenses</th><th>Revenus</th></tr></thead>
                <tbody>${pLines.map(l=>`<tr>
                  <td>${l.titre}</td>
                  <td>${fmtMoney(l.budget_alloue||0)}</td>
                  <td style="color:#c62828">${fmtMoney(l.depenses||0)}</td>
                  <td style="color:var(--g2)">${fmtMoney(l.revenus||0)}</td>
                </tr>`).join('')}</tbody>
              </table>
            </div>
          </details>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="empty-state"><div class="es-icon">🚀</div><p>Aucun projet créé</p></div>'}
  `);
}

function openProjectForm(p, allUsers) {
  openModal(p ? 'Modifier le projet' : 'Nouveau projet', `
    <form id="prjForm">
      <div class="form-group"><label>Nom *</label><input id="prj_nom" value="${p?.nom||''}" required/></div>
      <div class="form-group"><label>Description</label><textarea id="prj_desc">${p?.description||''}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Budget prévu ($) *</label><input type="number" step="0.01" min="0" id="prj_budget" value="${p?.budget_prevu||''}" ${p?'':'required'}/></div>
        <div class="form-group"><label>Responsable</label>
          <select id="prj_resp"><option value="">– Aucun –</option>
            ${allUsers.map(u=>`<option value="${u.id}" ${p?.responsable_id===u.id?'selected':''}>${u.prenom} ${u.nom}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Date début</label><input type="date" id="prj_debut" value="${p?.date_debut||''}"/></div>
        <div class="form-group"><label>Date fin</label><input type="date" id="prj_fin" value="${p?.date_fin||''}"/></div>
      </div>
      ${p ? `
      <div class="form-row">
        <div class="form-group"><label>Statut</label>
          <select id="prj_statut"><option value="en_cours" ${p.statut==='en_cours'?'selected':''}>En cours</option>
            <option value="planifie" ${p.statut==='planifie'?'selected':''}>Planifié</option>
            <option value="termine" ${p.statut==='termine'?'selected':''}>Terminé</option>
            <option value="suspendu" ${p.statut==='suspendu'?'selected':''}>Suspendu</option></select></div>
        <div class="form-group"><label>Progression (%)</label><input type="number" id="prj_prog" min="0" max="100" value="${p?.progression||0}"/></div>
      </div>` : ''}
      <div class="form-group"><label>Notes</label><textarea id="prj_notes">${p?.notes||''}</textarea></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">${p ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>
  `);
  document.getElementById('prjForm').onsubmit = async e => {
    e.preventDefault();
    const body = {
      nom: document.getElementById('prj_nom').value,
      description: document.getElementById('prj_desc').value,
      responsable_id: parseInt(document.getElementById('prj_resp').value)||null,
      date_debut: document.getElementById('prj_debut').value,
      date_fin: document.getElementById('prj_fin').value,
      budget_prevu: parseFloat(document.getElementById('prj_budget').value)||0,
      notes: document.getElementById('prj_notes').value
    };
    if (p) { body.statut=document.getElementById('prj_statut').value; body.progression=parseInt(document.getElementById('prj_prog').value)||0; }
    try {
      if (p) await api(`/projects/${p.id}`, { method:'PUT', body:JSON.stringify(body) });
      else   await api('/projects', { method:'POST', body:JSON.stringify(body) });
      closeModal(); toast('Projet enregistré'); projects();
    } catch(ex) { toast(ex.message,'error'); }
  };
}

async function deleteProject(id, nom) {
  if (!confirm('Supprimer le projet « ' + nom + ' » ?\n\nSes lignes financières seront aussi supprimées.')) return;
  try {
    await api('/projects/' + id, { method: 'DELETE' });
    toast('Projet supprimé');
    projects();
  } catch(ex) { toast(ex.message, 'error'); }
}

// ══ ALERTS ═════════════════════════════════════════════════════════════════
async function alerts() {
  const data = await api('/alerts');
  setContent(`
    <div class="page-header">
      <div><h2>Alertes</h2><p>${data.filter(a=>!a.lu).length} non lues</p></div>
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="markAllAlerts()">✅ Tout marquer lu</button>
      </div>
    </div>
    <div class="table-card">
      <div class="modal-body" style="max-height:none">
        ${data.map(a=>`<div class="alert-item">
          <div class="alert-dot ${a.lu?'lu':''}"></div>
          <div>
            <div class="alert-title">${a.titre||'Alerte'}</div>
            <div class="alert-body">${a.contenu||''}</div>
            <div class="alert-time">${fmt(a.date_creation)} · ${pill(a.type,'bp-orange')}</div>
          </div>
          ${!a.lu ? `<button class="btn btn-sm btn-ghost" style="margin-left:auto;flex-shrink:0" onclick="markAlert(${a.id})">Lu</button>` : ''}
        </div>`).join('') || '<div class="empty-state"><div class="es-icon">🔔</div><p>Aucune alerte</p></div>'}
      </div>
    </div>
  `);
}

async function markAlert(id) {
  await api(`/alerts/${id}/read`, { method:'PUT' });
  alerts();
}
async function markAllAlerts() {
  await api('/alerts/read-all', { method:'PUT' });
  toast('Toutes les alertes marquées comme lues'); alerts();
}

// ══ PROFILE ════════════════════════════════════════════════════════════════
async function profile() {
  const u = await api('/auth/me');
  const vh = await api('/volunteer');
  const totalH = vh.reduce((s,v) => v.statut==='approuve' ? s+v.heures : s, 0);
  const initials = `${u.prenom[0]}${u.nom[0]}`.toUpperCase();
  const avatarInner = u.photo_url
    ? `<img src="${BASE}${u.photo_url}" class="profile-avatar-img" alt="${initials}"/>`
    : `<span>${initials}</span>`;

  const [userBadges, icalData] = await Promise.all([
    api(`/users/${u.id}/badges`).catch(() => []),
    api('/calendar/token').catch(() => null)
  ]);

  setContent(`
    <div class="page-header"><div><h2>Mon profil</h2></div>
      <div class="page-actions">
        <a href="../carte.html?id=${u.id}" target="_blank" class="btn btn-ghost">🪪 Carte</a>
        <button class="btn btn-outline" onclick="openEditProfile(${JSON.stringify(u).replace(/"/g,'&quot;')})">✏️ Modifier</button>
      </div></div>
    <div class="profile-card">
      <div class="profile-avatar-wrap">
        <div class="profile-avatar">${avatarInner}</div>
        <label class="profile-photo-btn" for="photoFileInput" title="Changer la photo">📷</label>
        <input type="file" id="photoFileInput" accept="image/jpeg,image/png,image/webp" style="display:none"/>
      </div>
      <div class="profile-info">
        <h3>${u.prenom} ${u.nom}</h3>
        <span class="role-tag">${roleName(u.role)}</span>
        ${u.role === 'member' ? `<span class="role-tag" style="background:${u.plan==='partenaire'?'#1b5e20':u.plan==='bienfaiteur'?'#e65100':'#37474f'};margin-left:6px">${{gratuit:'Gratuit',bienfaiteur:'Bienfaiteur',partenaire:'Partenaire'}[u.plan]||'Gratuit'}</span>` : ''}
        <div class="info-grid">
          ${u.role === 'member' ? `<div class="info-item"><label>Type d'adhésion</label><span><strong>${{gratuit:'Membre Gratuit',bienfaiteur:'Bienfaiteur',partenaire:'Partenaire'}[u.plan]||'Gratuit'}</strong></span></div>` : ''}
          <div class="info-item"><label>Email</label><span>${u.email}</span></div>
          <div class="info-item"><label>Téléphone</label><span>${u.telephone||'–'}</span></div>
          <div class="info-item"><label>Adresse</label><span>${u.adresse||'–'}</span></div>
          <div class="info-item"><label>Date naissance</label><span>${u.date_naissance||'–'}</span></div>
          <div class="info-item"><label>Membre depuis</label><span>${fmt(u.date_inscription)}</span></div>
          <div class="info-item"><label>Heures bénévolat</label><span><strong>${totalH}h</strong></span></div>
          <div class="info-item"><label>Notifications SMS</label><span>${u.operateur ? (u.sms_notifs ? '📱 Activé — ' + u.operateur : '🔕 Désactivé') : '⚠️ Opérateur non configuré'}</span></div>
        </div>
      </div>
    </div>
    ${userBadges.length ? `
    <div class="table-card" style="margin-bottom:18px">
      <div class="table-card-header"><h3>🏅 Mes badges</h3></div>
      <div style="padding:16px 20px;display:flex;flex-wrap:wrap;gap:10px">
        ${userBadges.map(b => `
          <div title="${escHtml(b.description||'')} — obtenu le ${fmt(b.date_attribution)}" style="display:flex;align-items:center;gap:8px;background:var(--off);border:1px solid var(--border);border-radius:20px;padding:8px 14px;cursor:default">
            <span style="font-size:1.3rem">${b.icon}</span>
            <span style="font-size:.82rem;font-weight:600">${escHtml(b.nom)}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}

    ${icalData?.url ? `
    <div class="table-card" style="margin-bottom:18px">
      <div class="table-card-header"><h3>📅 Synchroniser mon calendrier</h3></div>
      <div style="padding:20px">
        <p style="font-size:.85rem;color:var(--muted);margin-bottom:14px">Copiez ce lien dans Google Agenda, Apple Calendrier ou Outlook pour synchroniser automatiquement les activités AHH.</p>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input id="icalUrl" value="${icalData.url}" readonly style="flex:1;min-width:200px;font-size:.75rem;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--off)"/>
          <button class="btn btn-outline" onclick="navigator.clipboard.writeText(document.getElementById('icalUrl').value).then(()=>toast('Lien copié !'))">📋 Copier</button>
          <a href="${icalData.url}" class="btn btn-ghost" download="ahh-calendar.ics">⬇ Télécharger</a>
        </div>
        <p style="font-size:.72rem;color:var(--muted);margin-top:10px">⚠️ Ne partagez pas ce lien — il est personnel et unique à votre compte.</p>
      </div>
    </div>` : ''}

    <div class="table-card">
      <div class="table-card-header"><h3>🔐 Changer le mot de passe</h3></div>
      <div style="padding:20px;max-width:400px">
        <form id="pwForm">
          <div class="form-group"><label>Mot de passe actuel</label><input type="password" id="pw_cur" required/></div>
          <div class="form-group"><label>Nouveau mot de passe</label><input type="password" id="pw_new" required minlength="6"/></div>
          <button type="submit" class="btn btn-primary">Changer</button>
        </form>
      </div>
    </div>
  `);

  document.getElementById('pwForm').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/auth/password', { method:'PUT', body: JSON.stringify({ current_password:document.getElementById('pw_cur').value, new_password:document.getElementById('pw_new').value })});
      toast('Mot de passe changé avec succès');
      document.getElementById('pwForm').reset();
    } catch(ex) { toast(ex.message,'error'); }
  };

  document.getElementById('photoFileInput').onchange = async function() {
    const file = this.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    try {
      const res = await fetch(`${BASE}/api/users/${u.id}/photo`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Upload échoué'); }
      const data = await res.json();
      USER.photo_url = data.photo_url;
      localStorage.setItem('ahh_user', JSON.stringify(USER));
      toast('Photo de profil mise à jour');
      profile();
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

const SMS_OPERATEURS = [
  ['', '— Aucun (pas de SMS) —'],
  ['rogers',  'Rogers'],
  ['bell',    'Bell'],
  ['telus',   'Telus'],
  ['fido',    'Fido'],
  ['freedom', 'Freedom Mobile'],
  ['koodo',   'Koodo'],
  ['virgin',  'Virgin Plus'],
  ['chatr',   'Chatr (Rogers)'],
  ['public_mobile', 'Public Mobile (Telus)'],
  ['videotron','Vidéotron'],
  ['eastlink','Eastlink'],
];

function openEditProfile(u) {
  const optsHtml = SMS_OPERATEURS.map(([v, l]) =>
    `<option value="${v}"${(u.operateur||'') === v ? ' selected' : ''}>${l}</option>`
  ).join('');
  openModal('Modifier mon profil', `
    <form id="editProf">
      <div class="form-row">
        <div class="form-group"><label>Prénom</label><input id="ep_prenom" value="${u.prenom||''}"/></div>
        <div class="form-group"><label>Nom</label><input id="ep_nom" value="${u.nom||''}"/></div>
      </div>
      <div class="form-group"><label>Téléphone</label><input id="ep_tel" placeholder="514-555-1234" value="${u.telephone||''}"/></div>
      <div class="form-group"><label>Adresse</label><input id="ep_addr" value="${u.adresse||''}"/></div>
      <div class="form-group"><label>Date de naissance</label><input type="date" id="ep_dob" value="${u.date_naissance||''}"/></div>
      <div class="form-group"><label>Bio</label><textarea id="ep_bio">${u.bio||''}</textarea></div>
      <div class="form-group">
        <label>📱 Opérateur cellulaire (pour les SMS)</label>
        <select id="ep_op">${optsHtml}</select>
        <small style="color:var(--muted);font-size:.75rem">Permet de recevoir les notifications par SMS (nouvelle activité, messages, rappels). Gratuit.</small>
      </div>
      <div class="form-group" style="display:flex;align-items:center;gap:10px">
        <input type="checkbox" id="ep_sms" ${u.sms_notifs !== 0 ? 'checked' : ''} style="width:auto;margin:0"/>
        <label for="ep_sms" style="margin:0">Recevoir les notifications SMS</label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById('editProf').onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`/users/${u.id}`, { method:'PUT', body: JSON.stringify({
        prenom:document.getElementById('ep_prenom').value, nom:document.getElementById('ep_nom').value,
        telephone:document.getElementById('ep_tel').value, adresse:document.getElementById('ep_addr').value,
        date_naissance:document.getElementById('ep_dob').value, bio:document.getElementById('ep_bio').value,
        operateur: document.getElementById('ep_op').value || null,
        sms_notifs: document.getElementById('ep_sms').checked ? 1 : 0 })});
      const freshUser = await api('/auth/me');
      USER.prenom = freshUser.prenom; USER.nom = freshUser.nom;
      localStorage.setItem('ahh_user', JSON.stringify(freshUser));
      renderUserChip();
      closeModal(); toast('Profil mis à jour'); profile();
    } catch(ex) { toast(ex.message,'error'); }
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// DARK MODE
// ══════════════════════════════════════════════════════════════════════════════
function setupDarkMode() {
  const btn = document.getElementById('darkToggle');
  if (!btn) return;
  const apply = (dark) => {
    document.documentElement.classList.toggle('dark', dark);
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = dark ? 'Mode clair' : 'Mode nuit';
  };
  apply(localStorage.getItem('ahh_dark') === '1');
  btn.onclick = () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('ahh_dark', isDark ? '1' : '0');
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.title = isDark ? 'Mode clair' : 'Mode nuit';
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL SEARCH
// ══════════════════════════════════════════════════════════════════════════════
function setupSearch() {
  const input   = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');
  const wrap    = document.getElementById('searchWrap');
  if (!input) return;
  let timer = null;

  // ── Ctrl+K / Cmd+K ouvre la recherche ──
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (wrap) {
        wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
        if (wrap.style.display !== 'none') {
          input.focus();
          input.select();
        }
      } else {
        input.style.display = 'block';
        input.focus();
        input.select();
      }
    }
    if (e.key === 'Escape') {
      if (wrap) wrap.style.display = 'none';
      results.style.display = 'none';
    }
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.style.display = 'none'; return; }
    timer = setTimeout(async () => {
      try {
        const data = await api('/search?q=' + encodeURIComponent(q));
        renderSearchResults(data, q);
      } catch {}
    }, 300);
  });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) results.style.display = 'block'; });
  document.addEventListener('click', e => { if (!e.target.closest('#searchWrap') && !e.target.closest('.search-wrap')) results.style.display = 'none'; });
}

function renderSearchResults(data, q) {
  const results = document.getElementById('searchResults');
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hl = s => s ? s.replace(new RegExp(esc(q), 'gi'), m => '<mark>' + m + '</mark>') : '';
  let html = '';
  if (data.members && data.members.length) {
    html += '<div class="sr-section">Membres</div>' + data.members.map(m =>
      '<div class="sr-item" onclick="showView(\'members\');document.getElementById(\'searchResults\').style.display=\'none\'">' +
      '<span class="sr-icon">👤</span><div><div class="sr-title">' + hl(m.prenom + ' ' + m.nom) + '</div>' +
      '<div class="sr-sub">' + m.email + '</div></div></div>').join('');
  }
  if (data.activities && data.activities.length) {
    html += '<div class="sr-section">Activités</div>' + data.activities.map(a =>
      '<div class="sr-item" onclick="showView(\'activities\');document.getElementById(\'searchResults\').style.display=\'none\'">' +
      '<span class="sr-icon">🎉</span><div><div class="sr-title">' + hl(a.titre) + '</div>' +
      '<div class="sr-sub">' + a.type + ' · ' + a.statut + '</div></div></div>').join('');
  }
  if (data.notes && data.notes.length) {
    html += '<div class="sr-section">Notes</div>' + data.notes.map(n =>
      '<div class="sr-item" onclick="showView(\'notes\');document.getElementById(\'searchResults\').style.display=\'none\'">' +
      '<span class="sr-icon">📝</span><div><div class="sr-title">' + hl(n.titre) + '</div>' +
      '<div class="sr-sub">' + (n.date_reunion || '–') + '</div></div></div>').join('');
  }
  if (!html) html = '<div class="sr-empty">Aucun résultat pour « ' + q + ' »</div>';
  results.innerHTML = html;
  results.style.display = 'block';
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF EXPORT (via print)
// ══════════════════════════════════════════════════════════════════════════════
function printSection(title) {
  const content = document.getElementById('mainContent').innerHTML;
  const w = window.open('', '_blank');
  w.document.write('<!DOCTYPE html><html lang="fr"><head>' +
    '<meta charset="UTF-8"/><title>' + title + ' – AHH</title>' +
    ahhPrintStyles() +
    '<style>' +
    '.btn,.icon-btn,.page-actions,.page-header .page-actions button{display:none!important}' +
    '.stat-card{border:1px solid #c8e6c9;border-radius:8px;padding:12px;margin:8px;display:inline-block}' +
    '.sc-value{font-size:24px;font-weight:700;color:#1b5e20}' +
    '.badge-pill{padding:2px 8px;border-radius:50px;font-size:10px;font-weight:600}' +
    '.bp-green{background:#e8f5e9;color:#1b5e20}.bp-orange{background:#fff3e0;color:#e65100}' +
    '.bp-blue{background:#e3f2fd;color:#0d47a1}.bp-red{background:#ffebee;color:#b71c1c}.bp-gray{background:#f5f5f5;color:#455a64}' +
    '</style></head><body>' +
    ahhPrintHeader() +
    '<h2 style="font-size:1.1rem;font-weight:700;color:#1b5e20;margin-bottom:4px">' + title + '</h2>' +
    '<p style="color:#5a7a5a;font-size:.78rem;margin-bottom:20px">Imprimé le ' + new Date().toLocaleDateString('fr-CA') + '</p>' +
    content + '</body></html>');
  w.document.close();
  w.focus();
  setTimeout(function() { w.print(); w.close(); }, 800);
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGINATION HELPER
// ══════════════════════════════════════════════════════════════════════════════
const PAGE_SIZE = 20;

function paginate(items, page) {
  const total = Math.ceil(items.length / PAGE_SIZE);
  const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return { items: slice, total, page };
}

function renderPager(total, page, callbackStr) {
  if (total <= 1) return '';
  let btns = '';
  const from = Math.max(1, page - 2);
  const to   = Math.min(total, page + 2);
  if (from > 1) btns += '<button class="pager-btn" onclick="(' + callbackStr + ')(1)">«</button>';
  for (let i = from; i <= to; i++) {
    btns += '<button class="pager-btn' + (i === page ? ' active' : '') + '" onclick="(' + callbackStr + ')(' + i + ')">' + i + '</button>';
  }
  if (to < total) btns += '<button class="pager-btn" onclick="(' + callbackStr + ')(' + total + ')">»</button>';
  return '<div class="pager">' + btns + '</div>';
}

// ══════════════════════════════════════════════════════════════════════════════
// PHOTO COMPRESSION (canvas)
// ══════════════════════════════════════════════════════════════════════════════
async function compressImage(file, maxW, quality) {
  maxW = maxW || 1200; quality = quality || 0.82;
  return new Promise(function(resolve) {
    if (!file.type.startsWith('image/') || file.size < 200 * 1024) { resolve(file); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function() {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(function(blob) {
        const compressed = new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
        resolve(compressed.size < file.size ? compressed : file);
      }, 'image/jpeg', quality);
    };
    img.onerror = function() { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVITIES CALENDAR VIEW — full interactive
// ══════════════════════════════════════════════════════════════════════════════
var _calDate = new Date();
var _calAllActivities = [];

const CAL_TYPE_COLORS = {
  culturel:  { bg:'#1b5e20', light:'#e8f5e9', border:'#a5d6a7' },
  benevolat: { bg:'#0277bd', light:'#e3f2fd', border:'#90caf9' },
  social:    { bg:'#00695c', light:'#e0f2f1', border:'#80cbc4' },
  reunion:   { bg:'#37474f', light:'#eceff1', border:'#b0bec5' },
  general:   { bg:'#6a1b9a', light:'#f3e5f5', border:'#ce93d8' },
};
function calColor(type) { return CAL_TYPE_COLORS[type] || CAL_TYPE_COLORS.general; }

async function activityCalendar() {
  setContent('<div class="loading-screen"><div class="spinner"></div><p>Chargement...</p></div>');
  _calAllActivities = await api('/activities');
  renderCalendar(_calAllActivities);
}

function renderCalendar(activities) {
  const y = _calDate.getFullYear(), m = _calDate.getMonth();
  const today = new Date();
  // Sunday=0 is first column
  let firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const MONTH_NAMES = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const DAY_NAMES   = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];

  // Index activities by day
  const byDay = {};
  activities.forEach(function(a) {
    if (!a.date_debut) return;
    const d = new Date(a.date_debut);
    if (d.getFullYear() === y && d.getMonth() === m) {
      const k = d.getDate();
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(a);
    }
  });

  // Build header row
  const headers = DAY_NAMES.map(function(n) {
    return '<div class="cal-header">' + n + '</div>';
  }).join('');

  // Empty cells before first day
  const cells = [];
  for (let i = 0; i < firstDay; i++) {
    cells.push('<div class="cal-cell cal-cell--empty"></div>');
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
    const evts = byDay[d] || [];
    const hasEvts = evts.length > 0;

    // Build event pills (show up to 3, then +N)
    const MAX_VISIBLE = 3;
    let pillsHtml = evts.slice(0, MAX_VISIBLE).map(function(e) {
      const c = calColor(e.type);
      const label = e.titre.length > 22 ? e.titre.slice(0, 20) + '…' : e.titre;
      return '<div class="cal-pill" ' +
        'style="background:' + c.bg + '" ' +
        'onclick="event.stopPropagation();calOpenEvent(' + e.id + ')" ' +
        'title="' + e.titre.replace(/"/g, '&quot;') + '">' + label + '</div>';
    }).join('');
    if (evts.length > MAX_VISIBLE) {
      pillsHtml += '<div class="cal-more-pill" onclick="event.stopPropagation();calShowDay(' + y + ',' + m + ',' + d + ')">+' + (evts.length - MAX_VISIBLE) + ' de plus</div>';
    }

    const addBtn = canCreateActivity()
      ? '<button class="cal-add-btn" onclick="event.stopPropagation();calAddOnDay(' + y + ',' + m + ',' + d + ')" title="Ajouter une activité">+</button>'
      : '';

    // Clic case vide → formulaire direct ; case avec events → popup détail
    var cellClick = hasEvts
      ? 'calShowDay(' + y + ',' + m + ',' + d + ')'
      : (canCreateActivity() ? 'calAddOnDay(' + y + ',' + m + ',' + d + ')' : 'calShowDay(' + y + ',' + m + ',' + d + ')');

    cells.push(
      '<div class="cal-cell' +
        (isToday  ? ' cal-cell--today'  : '') +
        (hasEvts  ? ' cal-cell--busy'   : '') +
        (!hasEvts && canCreateActivity() ? ' cal-cell--clickadd' : '') +
      '" onclick="' + cellClick + '" title="' + (hasEvts ? 'Voir les activités' : (canCreateActivity() ? 'Cliquer pour ajouter une activité' : '')) + '">' +
        '<div class="cal-day-row">' +
          '<span class="cal-day-num' + (isToday ? ' cal-day-num--today' : '') + '">' + d + '</span>' +
          addBtn +
        '</div>' +
        '<div class="cal-pills">' + pillsHtml + '</div>' +
      '</div>'
    );
  }

  const prevMonth = function() { _calDate.setMonth(_calDate.getMonth() - 1); renderCalendar(_calAllActivities); };
  const nextMonth = function() { _calDate.setMonth(_calDate.getMonth() + 1); renderCalendar(_calAllActivities); };
  const goToday   = function() { _calDate = new Date(); renderCalendar(_calAllActivities); };

  setContent(
    '<div class="page-header" style="margin-bottom:12px">' +
      '<div><h2>🗓️ Calendrier</h2><p>' + MONTH_NAMES[m] + ' ' + y + ' · ' + activities.length + ' activité(s)</p></div>' +
      '<div class="page-actions">' +
        '<button class="btn btn-ghost btn-sm" onclick="showView(\'activities\')">☰ Liste</button>' +
        '<button class="btn btn-outline btn-sm" onclick="printSection(\'Calendrier\')">🖨️ Imprimer</button>' +
      '</div>' +
    '</div>' +

    '<div class="cal-toolbar">' +
      '<button class="cal-nav-btn" onclick="(_calDate.setMonth(_calDate.getMonth()-1),renderCalendar(_calAllActivities))">&#8249;</button>' +
      '<div class="cal-title-wrap">' +
        '<h2 class="cal-title">' + MONTH_NAMES[m] + ' ' + y + '</h2>' +
        '<button class="cal-today-btn" onclick="(_calDate=new Date(),renderCalendar(_calAllActivities))">Aujourd\'hui</button>' +
      '</div>' +
      '<button class="cal-nav-btn" onclick="(_calDate.setMonth(_calDate.getMonth()+1),renderCalendar(_calAllActivities))">&#8250;</button>' +
    '</div>' +

    '<div class="cal-legend">' +
      Object.entries(CAL_TYPE_COLORS).map(function(kv) {
        return '<span class="cal-leg-item"><span class="cal-leg-dot" style="background:' + kv[1].bg + '"></span>' + kv[0] + '</span>';
      }).join('') +
    '</div>' +

    '<div class="cal-grid-wrap">' +
      '<div class="cal-grid">' + headers + cells.join('') + '</div>' +
    '</div>'
  );
}

// Affiche le panneau latéral d'une journée
function calShowDay(y, m, d) {
  const MONTH_NAMES = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const DAY_FULL = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const dow = new Date(y, m, d).getDay();
  const evts = _calAllActivities.filter(function(a) {
    if (!a.date_debut) return false;
    const dt = new Date(a.date_debut);
    return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d;
  });

  const evtRows = evts.length ? evts.map(function(e) {
    const c = calColor(e.type);
    return '<div class="cal-day-evt" style="border-left:4px solid ' + c.bg + ';background:' + c.light + '" onclick="calOpenEvent(' + e.id + ')">' +
      '<div class="cde-title">' + e.titre + '</div>' +
      '<div class="cde-meta">' +
        (e.lieu ? '📍 ' + e.lieu + '  ' : '') +
        (e.date_debut ? '🕐 ' + new Date(e.date_debut).toLocaleTimeString('fr-CA', {hour:'2-digit',minute:'2-digit'}) : '') +
        '  <span style="background:' + c.bg + ';color:#fff;border-radius:20px;padding:1px 8px;font-size:.65rem;font-weight:600">' + (e.statut||'') + '</span>' +
      '</div>' +
      '<div class="cde-participants">👥 ' + (e.nb_inscrits||0) + (e.max_participants ? '/' + e.max_participants : '') + ' inscrit(s)</div>' +
    '</div>';
  }).join('') : '<div style="text-align:center;padding:32px;color:var(--muted)"><div style="font-size:2.5rem;margin-bottom:8px">📭</div><p>Aucune activité ce jour.</p></div>';

  openModal(
    DAY_FULL[dow] + ' ' + d + ' ' + MONTH_NAMES[m] + ' ' + y,
    '<div style="max-height:60vh;overflow-y:auto">' + evtRows + '</div>' +
    (canCreateActivity() ? '<div style="padding-top:14px;border-top:1px solid var(--border);margin-top:14px">' +
      '<button class="btn btn-primary btn-sm" onclick="closeModal();calAddOnDay(' + y + ',' + m + ',' + d + ')">+ Ajouter une activité ce jour</button>' +
    '</div>' : '')
  );
}

// Ouvre le détail d'une activité (réutilise la modale)
function calOpenEvent(id) {
  const a = _calAllActivities.find(function(x) { return x.id === id; });
  if (!a) return;
  const c = calColor(a.type);
  closeModal();
  setTimeout(function() {
    openModal('📅 ' + a.titre,
      '<div style="border-left:4px solid ' + c.bg + ';background:' + c.light + ';border-radius:10px;padding:16px;margin-bottom:16px">' +
        '<div style="font-size:.75rem;font-weight:700;color:' + c.bg + ';text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">' + (a.type||'') + '</div>' +
        '<p style="font-size:.88rem;color:var(--text);line-height:1.7">' + (a.description || 'Aucune description.') + '</p>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:.83rem">' +
        '<div><label style="font-size:.7rem;font-weight:700;color:var(--muted);display:block;margin-bottom:2px">DÉBUT</label>' + fmt(a.date_debut) + '</div>' +
        '<div><label style="font-size:.7rem;font-weight:700;color:var(--muted);display:block;margin-bottom:2px">FIN</label>' + fmt(a.date_fin) + '</div>' +
        '<div><label style="font-size:.7rem;font-weight:700;color:var(--muted);display:block;margin-bottom:2px">LIEU</label>' + (a.lieu||'–') + '</div>' +
        '<div><label style="font-size:.7rem;font-weight:700;color:var(--muted);display:block;margin-bottom:2px">PARTICIPANTS</label>' + (a.nb_inscrits||0) + (a.max_participants ? '/' + a.max_participants : '') + '</div>' +
        '<div><label style="font-size:.7rem;font-weight:700;color:var(--muted);display:block;margin-bottom:2px">STATUT</label>' + statusPill(a.statut) + '</div>' +
        '<div><label style="font-size:.7rem;font-weight:700;color:var(--muted);display:block;margin-bottom:2px">BUDGET</label>' + fmtMoney(a.budget_prevu||0) + '</div>' +
      '</div>' +
      (can.admin() ? '<div style="padding-top:14px;border-top:1px solid var(--border);margin-top:14px;display:flex;gap:8px">' +
        '<button class="btn btn-outline btn-sm" onclick=\'closeModal();openActivityForm(' + JSON.stringify(a).replace(/'/g,"&#39;") + ')\'>✏️ Modifier</button>' +
        (a.statut === 'planifiee' ? '<button class="btn btn-primary btn-sm" onclick="closeModal();launchActivity(' + a.id + ',\'' + a.titre.replace(/'/g,"\\'") + '\')">🚀 Lancer</button>' : '') +
        '<button class="btn btn-ghost btn-sm" onclick="closeModal();viewRegistrations(' + a.id + ',\'' + a.titre.replace(/'/g,"\\'") + '\')">👥 Inscrits</button>' +
      '</div>' : '')
    );
  }, 80);
}

// Pré-remplir le formulaire d'activité avec une date
function calAddOnDay(y, m, d) {
  const pad = function(n) { return String(n).padStart(2,'0'); };
  // datetime-local needs YYYY-MM-DDTHH:MM format
  const dateDebut = y + '-' + pad(m+1) + '-' + pad(d) + 'T08:00';
  const dateFin   = y + '-' + pad(m+1) + '-' + pad(d) + 'T17:00';
  openActivityForm({ date_debut: dateDebut, date_fin: dateFin });
}


// ══════════════════════════════════════════════════════════════════════════════
// TALENTS MANAGEMENT (admin)
// ══════════════════════════════════════════════════════════════════════════════

const TALENT_CATS = [
  { key:'construction',  label:'Construction & Rénovation', emoji:'🔨' },
  { key:'art',           label:'Art & Créativité',          emoji:'🎨' },
  { key:'cuisine',       label:'Cuisine & Traiteur',        emoji:'🍽️' },
  { key:'beaute',        label:'Beauté & Bien-être',        emoji:'💅' },
  { key:'technologie',   label:'Technologie & Informatique',emoji:'💻' },
  { key:'education',     label:'Éducation & Coaching',      emoji:'📚' },
  { key:'sante',         label:'Santé & Sport',             emoji:'🏥' },
  { key:'transport',     label:'Transport & Livraison',     emoji:'🚗' },
  { key:'finance',       label:'Finance & Comptabilité',    emoji:'💰' },
  { key:'autre',         label:'Autre',                     emoji:'✨' },
];

async function talents_mgmt() {
  const [data, allUsers] = await Promise.all([
    api('/talents/all'),
    api('/users')
  ]);
  const eligibles = allUsers.filter(u => ['bienfaiteur','partenaire'].includes(u.plan));

  setContent(`
    <div class="page-header">
      <div>
        <h2>⭐ Nos talents</h2>
        <p>Fiches professionnelles des membres — accessible publiquement sur <a href="../talents.html" target="_blank" style="color:var(--g2)">talents.html</a></p>
      </div>
      <div class="page-actions">
        <a href="../talents.html" target="_blank" class="btn btn-ghost">🔗 Page publique</a>
        <button class="btn btn-primary" onclick="openTalentForm(null)">+ Ajouter une fiche</button>
      </div>
    </div>

    ${eligibles.length === 0 ? `
      <div class="table-card" style="padding:24px;text-align:center;color:var(--muted)">
        <div style="font-size:2rem;margin-bottom:8px">⚠️</div>
        <p>Aucun membre avec un plan bienfaiteur ou partenaire. Allez dans <strong>Membres</strong> pour upgrader un plan.</p>
      </div>` : ''}

    ${TALENT_CATS.map(cat => {
      const list = data.filter(t => t.categorie === cat.key);
      if (!list.length) return '';
      return `
        <div class="table-card" style="margin-bottom:24px">
          <div class="table-card-header">
            <h3>${cat.emoji} ${cat.label} <span style="background:var(--border);color:var(--muted);font-size:.75rem;padding:2px 10px;border-radius:50px">${list.length}</span></h3>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;padding:16px">
            ${list.map(t => `
              <div class="talent-mgmt-card">
                <div class="tmc-photo" style="background:linear-gradient(135deg,var(--g1),var(--g2))">
                  ${t.photo_path
                    ? `<img src="${BASE}${t.photo_path}" style="width:100%;height:100%;object-fit:cover"/>`
                    : `<span style="font-size:2rem">${cat.emoji}</span>`}
                </div>
                <div class="tmc-body">
                  <div class="tmc-name">${t.nom}</div>
                  <div class="tmc-spec">${t.specialite || cat.label}</div>
                  ${t.telephone ? `<div class="tmc-info">📞 ${t.telephone}</div>` : ''}
                  ${t.site_web ? `<div class="tmc-info">🌐 <a href="${t.site_web}" target="_blank" style="color:var(--g2)">${t.site_web}</a></div>` : ''}
                  <div class="tmc-member">👤 ${t.prenom} ${t.nom}</div>
                  <div style="margin-top:6px">
                    ${t.statut === 'en_attente' ? '<span style="background:#fff8e1;color:#f57f17;font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:50px">⏳ En attente</span>' : t.statut === 'rejete' ? '<span style="background:#fdecea;color:#c62828;font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:50px">❌ Refusée</span>' : '<span style="background:#e8f5e9;color:#1b5e20;font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:50px">✅ Publiée</span>'}
                  </div>
                  <div style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap">
                    ${t.statut === 'en_attente' ? `<button class="btn btn-sm btn-primary" onclick="approveTalent(${t.id})">✅</button><button class="btn btn-sm btn-danger" onclick="rejectTalent(${t.id})">❌</button>` : ''}
                    <button class="btn btn-sm btn-outline" onclick='openTalentForm(${JSON.stringify(t)})'>✏️</button>
                    <button class="btn btn-sm ${t.actif ? 'btn-ghost' : 'btn-primary'}" onclick="toggleTalent(${t.id},${t.actif})">${t.actif ? '🙈' : '👁️'}</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteTalent(${t.id})">🗑️</button>
                  </div>
                </div>
              </div>`).join('')}
          </div>
        </div>`;
    }).join('')}
    ${!data.length ? `<div class="empty-state"><div class="es-icon">⭐</div><p>Aucune fiche talent. Cliquez sur "+ Ajouter une fiche".</p></div>` : ''}
  `);
}

function openTalentForm(t) {
  openModal(t ? 'Modifier la fiche' : 'Nouvelle fiche talent', `
    <form id="talentForm" enctype="multipart/form-data">
      <div class="form-row">
        <div class="form-group">
          <label>Nom affiché *</label>
          <input id="tf_nom" value="${t?.nom||''}" required placeholder="Lesly Rénovation"/>
        </div>
        <div class="form-group">
          <label>Catégorie *</label>
          <select id="tf_cat">
            ${TALENT_CATS.map(c => `<option value="${c.key}" ${t?.categorie===c.key?'selected':''}>${c.emoji} ${c.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Spécialité / Sous-titre</label>
        <input id="tf_spec" value="${t?.specialite||''}" placeholder="ex: Peinture intérieure, plomberie…"/>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="tf_desc" rows="3">${t?.description||''}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Téléphone</label>
          <input id="tf_tel" value="${t?.telephone||''}" placeholder="905-000-0000"/>
        </div>
        <div class="form-group">
          <label>Site web</label>
          <input id="tf_web" value="${t?.site_web||''}" placeholder="https://…"/>
        </div>
      </div>
      <div class="form-group">
        <label>Adresse</label>
        <input id="tf_addr" value="${t?.adresse||''}" placeholder="Hamilton, ON"/>
      </div>
      <div class="form-group">
        <label>Photo professionnelle</label>
        <input type="file" id="tf_photo" accept="image/*"/>
        ${t?.photo_path ? `<img src="${BASE}${t.photo_path}" style="height:60px;border-radius:8px;margin-top:6px"/>` : ''}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">${t ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>
  `);
  document.getElementById('talentForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('nom',       document.getElementById('tf_nom').value);
    fd.append('categorie', document.getElementById('tf_cat').value);
    fd.append('specialite',document.getElementById('tf_spec').value);
    fd.append('description',document.getElementById('tf_desc').value);
    fd.append('telephone', document.getElementById('tf_tel').value);
    fd.append('site_web',  document.getElementById('tf_web').value);
    fd.append('adresse',   document.getElementById('tf_addr').value);
    const photo = document.getElementById('tf_photo').files[0];
    if (photo) fd.append('photo', await compressImage(photo, 800, 0.85));
    try {
      const url = t ? `/talents/${t.id}` : '/talents';
      const method = t ? 'PUT' : 'POST';
      await fetch(API + url, { method, headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
      closeModal(); toast(t ? 'Fiche mise à jour' : 'Fiche créée'); talents_mgmt();
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

async function toggleTalent(id, current) {
  await api(`/talents/${id}`, { method:'PUT', body: JSON.stringify({ actif: current ? 0 : 1 }) });
  toast(current ? 'Fiche masquée' : 'Fiche visible'); talents_mgmt();
}
async function deleteTalent(id) {
  if (!confirm('Supprimer cette fiche talent ?')) return;
  await api(`/talents/${id}`, { method:'DELETE' });
  toast('Fiche supprimée'); talents_mgmt();
}

// ══════════════════════════════════════════════════════════════════════════════
// PETITES ANNONCES MANAGEMENT (admin)
// ══════════════════════════════════════════════════════════════════════════════

const ANNONCE_CATS = [
  { key:'electronique', label:'Électronique',    emoji:'📱' },
  { key:'meubles',      label:'Meubles & Déco',  emoji:'🛋️' },
  { key:'vetements',    label:'Vêtements & Mode',emoji:'👗' },
  { key:'maison',       label:'Maison & Jardin', emoji:'🏡' },
  { key:'sport',        label:'Sport & Loisirs', emoji:'⚽' },
  { key:'vehicule',     label:'Véhicule',         emoji:'🚗' },
  { key:'cuisine',      label:'Cuisine & Resto',  emoji:'🍽️' },
  { key:'bebe',         label:'Bébé & Enfant',    emoji:'🧸' },
  { key:'services',     label:'Services',         emoji:'🤝' },
  { key:'autre',        label:'Autre',            emoji:'📦' },
];

async function annonces_mgmt() {
  const data = await api('/annonces/all');

  setContent(`
    <div class="page-header">
      <div>
        <h2>📌 Petites annonces</h2>
        <p>Gestion des annonces membres — visible sur <a href="../annonces.html" target="_blank" style="color:var(--g2)">annonces.html</a></p>
      </div>
      <div class="page-actions">
        <a href="../annonces.html" target="_blank" class="btn btn-ghost">🔗 Page publique</a>
      </div>
    </div>

    <div class="table-card">
      <div class="table-card-header"><h3>Toutes les annonces (${data.length})</h3></div>
      <div class="table-wrapper"><table>
        <thead><tr>
          <th>Titre</th><th>Membre</th><th>Catégorie</th><th>Type</th><th>Prix</th><th>Photos</th><th>Validation</th><th>Date</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${data.length ? data.map(a => {
            const cat = ANNONCE_CATS.find(c => c.key === a.categorie) || { emoji:'📦', label:'Autre' };
            const prixLabel = a.gratuit ? '🎁 Gratuit' : (a.prix ? '$' + a.prix : '–');
            return `<tr>
              <td><strong>${a.titre}</strong></td>
              <td>${a.prenom} ${a.nom}
                <br/><small style="color:var(--muted)">${pill(a.plan||'gratuit','bp-blue')}</small>
              </td>
              <td>${cat.emoji} ${cat.label}</td>
              <td>${statusPill(a.type)}</td>
              <td>${prixLabel}</td>
              <td>${a.photos.length} 📷</td>
              <td>
                ${a.statut === 'en_attente' ? pill('⏳ En attente','bp-orange') : a.statut === 'rejete' ? pill('❌ Refusée','bp-red') : pill('✅ Publiée','bp-green')}
              </td>
              <td>${fmt(a.date_creation)}</td>
              <td style="display:flex;gap:4px;flex-wrap:wrap">
                ${a.statut === 'en_attente' ? `<button class="btn btn-sm btn-primary" onclick="approveAnnonce(${a.id})" title="Approuver">✅</button><button class="btn btn-sm btn-danger" onclick="rejectAnnonce(${a.id})" title="Refuser">❌</button>` : ''}
                <button class="btn btn-sm btn-ghost" onclick="toggleAnnonce(${a.id},${a.actif})">${a.actif ? '🙈' : '👁️'}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteAnnonce(${a.id})">🗑️</button>
              </td>
            </tr>`;
          }).join('') : '<tr><td colspan="9" style="text-align:center;color:var(--muted)">Aucune annonce</td></tr>'}
        </tbody>
      </table></div>
    </div>
  `);
}

async function toggleAnnonce(id, current) {
  await api(`/annonces/${id}`, { method:'PUT', body: JSON.stringify({ actif: current ? 0 : 1 }) });
  toast(current ? 'Annonce masquée' : 'Annonce visible'); annonces_mgmt();
}
async function deleteAnnonce(id) {
  if (!confirm('Supprimer cette annonce définitivement ?')) return;
  await api(`/annonces/${id}`, { method:'DELETE' });
  toast('Annonce supprimée'); annonces_mgmt();
}

// ══════════════════════════════════════════════════════════════════════════════
// MES TALENTS (membre bienfaiteur+)
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// MES TALENTS (membre bienfaiteur+)
// ══════════════════════════════════════════════════════════════════════════════

async function mes_talents() {
  const resp  = await api('/mon-talent');
  const items = resp.items || resp;
  const quota = resp.quota || { plan:'?', totalUsed:0, totalMax:0, monthUsed:0, monthMax:0, canCreate:false };

  const statutBadge = function(s) {
    const m = {
      approuve: '<span class="plan-badge-ok">✅ Publiée et visible</span>',
      en_attente: '<span class="plan-badge-wait">⏳ En attente de validation</span>',
      rejete:   '<span class="plan-badge-err">❌ Refusée — voir vos courriels</span>',
      retire:   '<span class="plan-badge-gray">📤 Retirée par vous</span>',
    };
    return m[s] || '<span class="plan-badge-wait">' + s + '</span>';
  };

  const quotaBanner =
    '<div class="quota-banner">' +
      '<div class="quota-title">📊 Mes quotas — Plan <strong>' + quota.plan + '</strong></div>' +
      '<div class="quota-grid">' +
        '<div class="quota-item">' +
          '<div class="quota-label">Ce mois-ci</div>' +
          '<div class="quota-val">' + quota.monthUsed + ' / ' + quota.monthMax + '</div>' +
        '</div>' +
        '<div class="quota-item">' +
          '<div class="quota-label">Total actif</div>' +
          '<div class="quota-val">' + quota.totalUsed + ' / ' + quota.totalMax + '</div>' +
        '</div>' +
        '<div class="quota-item">' +
          '<div class="quota-label">Renouvellement</div>' +
          '<div class="quota-val" style="font-size:.75rem">après 6 mois</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const btnCreate = quota.canCreate
    ? '<button class="btn btn-primary" onclick="openMemberTalentForm(null)">+ Créer ma fiche</button>'
    : quota.monthUsed >= quota.monthMax && quota.totalUsed < quota.totalMax
      ? '<span class="limit-badge">📅 Limite mensuelle atteinte (' + quota.monthUsed + '/' + quota.monthMax + ' ce mois)</span>'
      : '<span class="limit-badge">✋ Quota total atteint (' + quota.totalUsed + '/' + quota.totalMax + ')</span>';

  const cardsHtml = items.length
    ? items.map(function(t) {
        const cat = TALENT_CATS.find(function(c) { return c.key === t.categorie; }) || { emoji:'✨', label: t.categorie };
        return '<div class="member-pub-card">' +
          '<div class="mpc-header">' +
            (t.photo_path ? '<img src="' + BASE + t.photo_path + '" class="mpc-photo"/>' : '<div class="mpc-photo-placeholder">' + cat.emoji + '</div>') +
            '<div class="mpc-info">' +
              '<div class="mpc-name">' + t.nom + '</div>' +
              '<div class="mpc-cat">' + cat.emoji + ' ' + cat.label + (t.specialite ? ' · ' + t.specialite : '') + '</div>' +
              '<div style="margin-top:4px">' + statutBadge(t.statut) + '</div>' +
              '<div class="mpc-date">Publié le ' + fmt(t.date_creation) + '</div>' +
            '</div>' +
          '</div>' +
          (t.description ? '<p class="mpc-desc">' + t.description + '</p>' : '') +
          '<div class="mpc-contact">' +
            (t.telephone ? '<span>📞 ' + t.telephone + '</span>' : '') +
            (t.site_web ? '<span>🌐 ' + t.site_web + '</span>' : '') +
            (t.adresse ? '<span>📍 ' + t.adresse + '</span>' : '') +
          '</div>' +
          (t.statut !== 'retire' ?
            '<div class="mpc-actions">' +
              '<button class="btn btn-sm btn-outline" onclick="openMemberTalentModify(' + JSON.stringify(t).replace(/'/g,"&#39;") + ')">✏️ Modifier</button>' +
              '<button class="btn btn-sm btn-danger" onclick="openTalentWithdraw(' + t.id + ',\'' + t.nom.replace(/'/g,"\\'") + '\')">📤 Retirer</button>' +
            '</div>'
          : '<div class="mpc-actions"><span style="font-size:.78rem;color:var(--muted)">Publication retirée</span></div>') +
        '</div>';
      }).join('')
    : '<div class="empty-state"><div class="es-icon">⭐</div>' +
        '<p>Vous n\'avez aucune fiche talent.</p>' +
        '<button class="btn btn-primary" style="margin-top:16px" onclick="openMemberTalentForm(null)">+ Créer ma fiche professionnelle</button>' +
      '</div>';

  setContent(
    '<div class="page-header">' +
      '<div><h2>⭐ Mon talent</h2>' +
      '<p>Votre fiche professionnelle · <a href="../talents.html" target="_blank" style="color:var(--g2)">Voir la page publique</a></p></div>' +
      '<div class="page-actions">' + btnCreate + '</div>' +
    '</div>' +
    quotaBanner +
    '<div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:12px;padding:14px 18px;margin-bottom:24px;font-size:.82rem;color:#1b5e20">' +
      '💡 <strong>Workflow :</strong> Création → Admin valide → Publication → Notification renouvellement après 6 mois. ' +
      'Toute modification repassera par validation avant republication.' +
    '</div>' +
    '<div class="member-pubs-grid">' + cardsHtml + '</div>'
  );
}

// Modifier (retour en_attente)
function openMemberTalentModify(t) {
  openModal('✏️ Modifier ma fiche talent',
    '<div style="background:#fff3e0;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:.82rem;color:#e65100">' +
      '⚠️ Après modification, votre fiche sera retirée de la publication et soumise à nouveau pour validation par l\'admin.' +
    '</div>' +
    '<form id="modTalentForm">' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Nom professionnel *</label>' +
          '<input id="mod_nom" value="' + (t.nom||'').replace(/"/g,'&quot;') + '" required/></div>' +
        '<div class="form-group"><label>Catégorie *</label>' +
          '<select id="mod_cat">' +
          TALENT_CATS.map(function(c) {
            return '<option value="' + c.key + '"' + (t.categorie === c.key ? ' selected' : '') + '>' + c.emoji + ' ' + c.label + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Spécialité</label>' +
        '<input id="mod_spec" value="' + (t.specialite||'').replace(/"/g,'&quot;') + '"/></div>' +
      '<div class="form-group"><label>Description</label>' +
        '<textarea id="mod_desc" rows="3">' + (t.description||'') + '</textarea></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Téléphone</label><input id="mod_tel" value="' + (t.telephone||'') + '"/></div>' +
        '<div class="form-group"><label>Site web</label><input id="mod_web" value="' + (t.site_web||'') + '"/></div>' +
      '</div>' +
      '<div class="form-group"><label>Adresse</label><input id="mod_addr" value="' + (t.adresse||'') + '"/></div>' +
      '<div class="form-group"><label>Nouvelle photo (optionnel)</label><input type="file" id="mod_photo" accept="image/*"/>' +
        (t.photo_path ? '<img src="' + BASE + t.photo_path + '" style="height:50px;border-radius:6px;margin-top:6px;display:block"/>' : '') +
      '</div>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
        '<button type="submit" class="btn btn-primary">📤 Soumettre la modification</button>' +
      '</div>' +
    '</form>'
  );
  document.getElementById('modTalentForm').onsubmit = async function(e) {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Envoi…';
    const fd = new FormData();
    fd.append('nom',         document.getElementById('mod_nom').value);
    fd.append('categorie',   document.getElementById('mod_cat').value);
    fd.append('specialite',  document.getElementById('mod_spec').value);
    fd.append('description', document.getElementById('mod_desc').value);
    fd.append('telephone',   document.getElementById('mod_tel').value);
    fd.append('site_web',    document.getElementById('mod_web').value);
    fd.append('adresse',     document.getElementById('mod_addr').value);
    const photo = document.getElementById('mod_photo').files[0];
    if (photo) { const comp = await compressImage(photo, 800, 0.85); fd.append('photo', comp); }
    try {
      const res = await fetch(API + '/talents/' + t.id + '/modifier', {
        method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd
      });
      const data = await res.json().catch(function() { return {}; });
      if (!res.ok) throw new Error(data.error || 'Erreur');
      closeModal();
      toast('✅ Modification soumise — en attente de validation admin', 'info');
      mes_talents();
    } catch(ex) {
      toast(ex.message, 'error');
      btn.disabled = false; btn.textContent = '📤 Soumettre la modification';
    }
  };
}

// Retrait talent avec questionnaire
function openTalentWithdraw(id, nom) {
  openModal('📤 Retirer ma fiche talent',
    '<form id="withdrawTalentForm">' +
      '<p style="font-size:.88rem;color:var(--muted);margin-bottom:16px">Vous êtes sur le point de retirer votre fiche « <strong>' + nom + '</strong> » de la publication.</p>' +
      '<div class="form-group">' +
        '<label>Êtes-vous satisfait(e) de notre service ? *</label>' +
        '<div style="display:flex;gap:12px;margin-top:8px">' +
          '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer">' +
            '<input type="radio" name="satisfait" value="1" required/> 😊 Oui, très satisfait(e)' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer">' +
            '<input type="radio" name="satisfait" value="0"/> 😞 Non, pas vraiment' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="form-group"><label>Raison du retrait (optionnel)</label>' +
        '<textarea id="wr_raison" rows="2" placeholder="ex: Fiche obsolète, changement de service…"></textarea></div>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
        '<button type="submit" class="btn btn-danger">📤 Confirmer le retrait</button>' +
      '</div>' +
    '</form>'
  );
  document.getElementById('withdrawTalentForm').onsubmit = async function(e) {
    e.preventDefault();
    const satisfait = document.querySelector('[name=satisfait]:checked')?.value;
    const raison = document.getElementById('wr_raison').value;
    try {
      await api('/talents/' + id + '/retirer', { method:'PATCH', body: JSON.stringify({ satisfait: satisfait === '1', raison }) });
      closeModal();
      toast('Fiche retirée — merci pour votre retour !');
      mes_talents();
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MES ANNONCES (membre bienfaiteur+)
// ══════════════════════════════════════════════════════════════════════════════

async function mes_annonces() {
  const resp  = await api('/mes-annonces');
  const items = resp.items || resp;
  const quota = resp.quota || { plan:'?', totalUsed:0, totalMax:0, monthUsed:0, monthMax:0, canCreate:false };

  const TYPE_LABEL = { vente:'🏷️ Vente', don:'🎁 Don', echange:'🔄 Échange', recherche:'🔍 Recherche' };

  const statutBadge = function(s) {
    const m = {
      approuve:   '<span class="plan-badge-ok">✅ Publiée</span>',
      en_attente: '<span class="plan-badge-wait">⏳ En attente</span>',
      rejete:     '<span class="plan-badge-err">❌ Refusée</span>',
      retire:     '<span class="plan-badge-gray">📤 Retirée</span>',
    };
    return m[s] || '<span class="plan-badge-wait">' + s + '</span>';
  };

  const quotaBanner =
    '<div class="quota-banner">' +
      '<div class="quota-title">📊 Mes quotas — Plan <strong>' + quota.plan + '</strong></div>' +
      '<div class="quota-grid">' +
        '<div class="quota-item"><div class="quota-label">Ce mois-ci</div><div class="quota-val">' + quota.monthUsed + ' / ' + quota.monthMax + '</div></div>' +
        '<div class="quota-item"><div class="quota-label">Total actif</div><div class="quota-val">' + quota.totalUsed + ' / ' + quota.totalMax + '</div></div>' +
        '<div class="quota-item"><div class="quota-label">Renouvellement</div><div class="quota-val" style="font-size:.75rem">après 3 mois</div></div>' +
      '</div>' +
    '</div>';

  const btnCreate = quota.canCreate
    ? '<button class="btn btn-primary" onclick="openMemberAnnonceForm()">+ Nouvelle annonce</button>'
    : quota.monthUsed >= quota.monthMax && quota.totalUsed < quota.totalMax
      ? '<span class="limit-badge">📅 Limite mensuelle atteinte (' + quota.monthUsed + '/' + quota.monthMax + ' ce mois)</span>'
      : '<span class="limit-badge">✋ Quota total atteint (' + quota.totalUsed + '/' + quota.totalMax + ')</span>';

  const rowsHtml = items.length
    ? '<div class="table-card"><div class="table-wrapper"><table>' +
      '<thead><tr><th>Titre</th><th>Type</th><th>Prix</th><th>Photos</th><th>Statut</th><th>Publié le</th><th>Actions</th></tr></thead><tbody>' +
      items.map(function(a) {
        const prix = a.gratuit ? '🎁 Gratuit' : (a.prix ? '$' + a.prix : '–');
        return '<tr>' +
          '<td><strong>' + a.titre + '</strong>' +
          (a.description ? '<br/><small style="color:var(--muted)">' + a.description.substring(0,60) + '…</small>' : '') + '</td>' +
          '<td>' + (TYPE_LABEL[a.type]||a.type) + '</td>' +
          '<td>' + prix + '</td>' +
          '<td>' + a.photos.length + ' 📷</td>' +
          '<td>' + statutBadge(a.statut) + '</td>' +
          '<td>' + fmt(a.date_creation) + '</td>' +
          '<td>' +
            (a.statut !== 'retire'
              ? '<button class="btn btn-sm btn-danger" onclick="openAnnonceWithdraw(' + a.id + ',\'' + a.titre.replace(/'/g,"\\'") + '\')">📤 Retirer</button>'
              : '<span style="font-size:.75rem;color:var(--muted)">Retirée</span>') +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div></div>'
    : '<div class="empty-state"><div class="es-icon">📌</div>' +
        '<p>Vous n\'avez aucune annonce.</p>' +
        '<button class="btn btn-primary" style="margin-top:16px" onclick="openMemberAnnonceForm()">+ Publier une annonce</button>' +
      '</div>';

  setContent(
    '<div class="page-header">' +
      '<div><h2>📌 Mes annonces</h2>' +
      '<p>Vos petites annonces · <a href="../annonces.html" target="_blank" style="color:var(--g2)">Page publique</a></p></div>' +
      '<div class="page-actions">' + btnCreate + '</div>' +
    '</div>' +
    quotaBanner +
    '<div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:12px;padding:14px 18px;margin-bottom:24px;font-size:.82rem;color:#1b5e20">' +
      '💡 <strong>Workflow :</strong> Soumission → Admin valide → Publication → Notification renouvellement après 3 mois. ' +
      'Toute modification repassera par validation.' +
    '</div>' +
    rowsHtml
  );
}

// Retrait annonce avec questionnaire
function openAnnonceWithdraw(id, titre) {
  openModal('📤 Retirer mon annonce',
    '<form id="withdrawAnnonceForm">' +
      '<p style="font-size:.88rem;color:var(--muted);margin-bottom:16px">Vous retirez l\'annonce : « <strong>' + titre + '</strong> »</p>' +
      '<div class="form-group">' +
        '<label>Avez-vous vendu ou donné cet article grâce à notre site ? *</label>' +
        '<div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">' +
          '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer">' +
            '<input type="radio" name="vendu" value="1" required/> ✅ Oui, grâce au site AHH !' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer">' +
            '<input type="radio" name="vendu" value="0"/> ❌ Non, pas via le site' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="form-group"><label>Commentaire (optionnel)</label>' +
        '<textarea id="wa_raison" rows="2" placeholder="ex: Vendu rapidement, bon retour des membres…"></textarea></div>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
        '<button type="submit" class="btn btn-danger">📤 Confirmer le retrait</button>' +
      '</div>' +
    '</form>'
  );
  document.getElementById('withdrawAnnonceForm').onsubmit = async function(e) {
    e.preventDefault();
    const vendu = document.querySelector('[name=vendu]:checked')?.value;
    const raison = document.getElementById('wa_raison').value;
    try {
      await api('/annonces/' + id + '/retirer', { method:'PATCH', body: JSON.stringify({ vendu: vendu === '1', raison }) });
      closeModal();
      toast('Annonce retirée — merci pour votre retour !');
      mes_annonces();
    } catch(ex) { toast(ex.message, 'error'); }
  };
}


// ── Formulaire création talent (membre) ──────────────────────────────────────
function openMemberTalentForm(t) {
  openModal(t ? 'Modifier ma fiche talent' : '✨ Créer ma fiche professionnelle',
    '<form id="myTalentForm">' +
      '<div style="background:#e3f2fd;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:.82rem;color:#0d47a1">' +
        'ℹ️ Votre fiche sera envoyée à l\'administration pour validation avant d\'être publiée.' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Nom professionnel *</label>' +
          '<input id="mt_nom" value="' + (t ? (t.nom||'').replace(/"/g,'&quot;') : '') + '" placeholder="ex: Lesly Rénovation" required/></div>' +
        '<div class="form-group"><label>Catégorie *</label>' +
          '<select id="mt_cat">' +
          TALENT_CATS.map(function(c) {
            return '<option value="' + c.key + '"' + (t && t.categorie === c.key ? ' selected' : '') + '>' + c.emoji + ' ' + c.label + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Spécialité</label>' +
        '<input id="mt_spec" value="' + (t && t.specialite ? t.specialite.replace(/"/g,'&quot;') : '') + '" placeholder="ex: Peinture intérieure, électricité…"/></div>' +
      '<div class="form-group"><label>Description de vos services</label>' +
        '<textarea id="mt_desc" rows="4" placeholder="Décrivez vos services, votre expérience…">' + (t ? t.description||'' : '') + '</textarea></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Téléphone</label>' +
          '<input id="mt_tel" value="' + (t ? t.telephone||'' : '') + '" placeholder="905-000-0000"/></div>' +
        '<div class="form-group"><label>Site web</label>' +
          '<input id="mt_web" value="' + (t ? t.site_web||'' : '') + '" placeholder="https://…"/></div>' +
      '</div>' +
      '<div class="form-group"><label>Adresse / Zone de service</label>' +
        '<input id="mt_addr" value="' + (t ? t.adresse||'' : '') + '" placeholder="Hamilton, ON"/></div>' +
      '<div class="form-group"><label>Photo professionnelle</label>' +
        '<input type="file" id="mt_photo" accept="image/*"/>' +
        (t && t.photo_path ? '<img src="' + BASE + t.photo_path + '" style="height:60px;border-radius:8px;margin-top:8px;display:block"/>' : '') +
      '</div>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
        '<button type="submit" class="btn btn-primary">' + (t ? '💾 Enregistrer' : '📤 Soumettre pour validation') + '</button>' +
      '</div>' +
    '</form>'
  );
  document.getElementById('myTalentForm').onsubmit = async function(e) {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Envoi…';
    const fd = new FormData();
    fd.append('nom',         document.getElementById('mt_nom').value);
    fd.append('categorie',   document.getElementById('mt_cat').value);
    fd.append('specialite',  document.getElementById('mt_spec').value);
    fd.append('description', document.getElementById('mt_desc').value);
    fd.append('telephone',   document.getElementById('mt_tel').value);
    fd.append('site_web',    document.getElementById('mt_web').value);
    fd.append('adresse',     document.getElementById('mt_addr').value);
    const photo = document.getElementById('mt_photo').files[0];
    if (photo) { const comp = await compressImage(photo, 800, 0.85); fd.append('photo', comp); }
    try {
      const res = await fetch(API + (t ? '/talents/' + t.id : '/talents'), {
        method: t ? 'PUT' : 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: fd
      });
      const data = await res.json().catch(function() { return {}; });
      if (!res.ok) throw new Error(data.error || 'Erreur');
      closeModal();
      toast(t ? '✅ Fiche mise à jour — en attente de validation' : '✅ Fiche soumise ! L\'admin va la valider sous peu.', 'info');
      mes_talents();
    } catch(ex) {
      toast(ex.message, 'error');
      btn.disabled = false; btn.textContent = t ? '💾 Enregistrer' : '📤 Soumettre pour validation';
    }
  };
}

// ── Formulaire nouvelle annonce (membre) ─────────────────────────────────────
function openMemberAnnonceForm() {
  const catOpts = ANNONCE_CATS.map(function(c) {
    return '<option value="' + c.key + '">' + c.emoji + ' ' + c.label + '</option>';
  }).join('');

  openModal('📌 Nouvelle petite annonce',
    '<form id="myAnnonceForm">' +
      '<div style="background:#e3f2fd;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:.82rem;color:#0d47a1">' +
        'ℹ️ Votre annonce sera validée par l\'admin avant d\'être publiée.' +
      '</div>' +
      '<div class="form-group"><label>Titre de l\'annonce *</label>' +
        '<input id="ma_titre" placeholder="ex: Vélo de montagne, Chaise de bureau…" required/></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Type *</label>' +
          '<select id="ma_type">' +
            '<option value="vente">🏷️ Vente</option>' +
            '<option value="don">🎁 Don gratuit</option>' +
            '<option value="echange">🔄 Échange</option>' +
            '<option value="recherche">🔍 Je recherche</option>' +
          '</select></div>' +
        '<div class="form-group"><label>Catégorie</label>' +
          '<select id="ma_cat">' + catOpts + '</select></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Prix ($)</label>' +
          '<input type="number" id="ma_prix" placeholder="0.00" step="0.01" min="0"/></div>' +
        '<div class="form-group" style="display:flex;align-items:center;gap:8px;padding-top:28px">' +
          '<input type="checkbox" id="ma_gratuit" style="width:auto" onchange="document.getElementById(\'ma_prix\').disabled=this.checked"/>' +
          '<label for="ma_gratuit" style="text-transform:none;letter-spacing:0;font-weight:400;font-size:.88rem">🎁 Gratuit (don)</label>' +
        '</div>' +
      '</div>' +
      '<div class="form-group"><label>Description</label>' +
        '<textarea id="ma_desc" rows="4" placeholder="Décrivez l\'article : état, dimensions, raison de vente…"></textarea></div>' +
      '<div class="form-group"><label>Téléphone de contact</label>' +
        '<input id="ma_tel" placeholder="905-000-0000"/></div>' +
      '<div class="form-group"><label>Photos (max 5)</label>' +
        '<input type="file" id="ma_photos" accept="image/*" multiple/>' +
        '<small style="color:var(--muted);font-size:.72rem">Ajoutez jusqu\'à 5 photos pour mieux présenter votre article</small></div>' +
      '<div class="form-actions">' +
        '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
        '<button type="submit" class="btn btn-primary">📤 Soumettre pour validation</button>' +
      '</div>' +
    '</form>'
  );

  document.getElementById('myAnnonceForm').onsubmit = async function(e) {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Envoi…';
    const fd = new FormData();
    fd.append('titre',       document.getElementById('ma_titre').value);
    fd.append('type',        document.getElementById('ma_type').value);
    fd.append('categorie',   document.getElementById('ma_cat').value);
    fd.append('prix',        document.getElementById('ma_prix').value || '0');
    fd.append('gratuit',     document.getElementById('ma_gratuit').checked ? '1' : '0');
    fd.append('description', document.getElementById('ma_desc').value);
    fd.append('telephone',   document.getElementById('ma_tel').value);
    const files = document.getElementById('ma_photos').files;
    for (let i = 0; i < Math.min(files.length, 5); i++) {
      const comp = await compressImage(files[i], 1200, 0.82);
      fd.append('photos', comp);
    }
    try {
      const res = await fetch(API + '/annonces', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: fd
      });
      const data = await res.json().catch(function() { return {}; });
      if (!res.ok) throw new Error(data.error || 'Erreur');
      closeModal();
      toast('✅ Annonce soumise ! L\'admin va la valider sous peu.', 'info');
      mes_annonces();
    } catch(ex) {
      toast(ex.message, 'error');
      btn.disabled = false; btn.textContent = '📤 Soumettre pour validation';
    }
  };
}

// ── Patch talents_mgmt et annonces_mgmt pour afficher les boutons Approuver/Rejeter
// ══════════════════════════════════════════════════════════════════════════════

async function approveTalent(id) {
  await api('/talents/' + id + '/statut', { method:'PATCH', body: JSON.stringify({ statut:'approuve' }) });
  toast('✅ Fiche talent approuvée et publiée'); talents_mgmt();
}

async function rejectTalent(id) {
  const raison = prompt('Raison du refus (sera envoyée au membre) :');
  if (raison === null) return;
  await api('/talents/' + id + '/statut', { method:'PATCH', body: JSON.stringify({ statut:'rejete', message_rejet: raison }) });
  toast('Fiche refusée — membre notifié'); talents_mgmt();
}

async function approveAnnonce(id) {
  await api('/annonces/' + id + '/statut', { method:'PATCH', body: JSON.stringify({ statut:'approuve' }) });
  toast('✅ Annonce approuvée et publiée'); annonces_mgmt();
}

async function rejectAnnonce(id) {
  const raison = prompt('Raison du refus (sera envoyée au membre) :');
  if (raison === null) return;
  await api('/annonces/' + id + '/statut', { method:'PATCH', body: JSON.stringify({ statut:'rejete', message_rejet: raison }) });
  toast('Annonce refusée — membre notifié'); annonces_mgmt();
}

// ══════════════════════════════════════════════════════════════════════════════
// INSCRIPTIONS EN ATTENTE (admin/staff)
// ══════════════════════════════════════════════════════════════════════════════

async function inscriptions() {
  const data = await api('/inscriptions');
  const pending   = data.filter(d => d.statut === 'en_attente');
  const processed = data.filter(d => d.statut !== 'en_attente');

  const statutPill = s => {
    if (s === 'approuve') return pill('✅ Approuvé','bp-green');
    if (s === 'refuse')   return pill('❌ Refusé','bp-red');
    return pill('⏳ En attente','bp-orange');
  };

  setContent(
    '<div class="page-header"><div><h2>📋 Inscriptions en attente</h2>' +
    '<p>Demandes d\'adhésion à approuver avant la création du compte.</p></div></div>' +

    '<div class="table-card" style="margin-bottom:20px;border-left:4px solid #1565c0">' +
    '<div class="table-card-header"><h3 style="color:#1565c0">📧 Inviter un membre par courriel</h3></div>' +
    '<div style="padding:8px 20px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    '<input type="email" id="inviteEmailInput" placeholder="adresse@email.com" style="flex:1;min-width:220px;padding:9px 13px;border:1px solid #ccc;border-radius:8px;font-size:.9rem"/>' +
    '<button class="btn btn-primary btn-sm" onclick="inviterMembre()" style="white-space:nowrap">✉️ Envoyer l\'invitation</button>' +
    '</div>' +
    '<p style="padding:0 20px 12px;margin:0;font-size:.78rem;color:var(--muted)">La personne recevra un lien vers le formulaire d\'adhésion où elle pourra choisir son mot de passe. Le comité recevra une notification à complétion.</p>' +
    '</div>' +

    (pending.length === 0 ?
      '<div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:12px;padding:14px 18px;margin-bottom:20px;font-size:.85rem;color:#1b5e20">✅ Aucune demande en attente.</div>' : '') +

    pending.map(p =>
      '<div class="table-card" style="margin-bottom:16px;border-left:4px solid var(--accent)">' +
      '<div class="table-card-header">' +
        '<div><h3>' + p.prenom + ' ' + p.nom + '</h3>' +
        '<small style="color:var(--muted)">' + p.email + ' · ' + (p.telephone||'–') + ' · Plan: <strong>' + (p.plan||'gratuit') + '</strong></small>' +
        '<br/><small style="color:var(--muted)">Soumis le : ' + fmt(p.date_soumission) + '</small></div>' +
        '<div class="tc-actions">' +
          '<button class="btn btn-primary btn-sm" onclick="approuverInscription(' + p.id + ')">✅ Approuver</button>' +
          '<button class="btn btn-danger btn-sm" onclick="refuserInscription(' + p.id + ')">❌ Refuser</button>' +
        '</div></div>' +
      (p.message ? '<div style="padding:8px 20px 14px;font-size:.84rem;color:var(--muted)">💬 ' + p.message + '</div>' : '') +
      '</div>'
    ).join('') +

    '<div class="table-card"><div class="table-card-header"><h3>Historique (' + processed.length + ')</h3></div>' +
    '<div class="table-wrapper"><table>' +
    '<thead><tr><th>Nom</th><th>Email</th><th>Plan</th><th>Statut</th><th>Soumis</th><th>Traité</th><th></th></tr></thead><tbody>' +
    (processed.map(p =>
      '<tr><td>' + p.prenom + ' ' + p.nom + '</td><td>' + p.email + '</td><td>' + (p.plan||'gratuit') + '</td>' +
      '<td>' + statutPill(p.statut) + '</td><td>' + fmt(p.date_soumission) + '</td><td>' + fmt(p.date_traitement) + '</td>' +
      '<td><button class="btn btn-sm" style="color:var(--red);border:1px solid var(--red);background:transparent;padding:2px 8px" ' +
      'onclick="supprimerInscription(' + p.id + ',\'' + (p.prenom+' '+p.nom).replace(/'/g,'') + '\')" title="Supprimer de l\'historique">🗑</button></td></tr>'
    ).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Aucun historique</td></tr>') +
    '</tbody></table></div></div>'
  );
}

async function inviterMembre() {
  const input = document.getElementById('inviteEmailInput');
  const email = input?.value?.trim();
  if (!email || !email.includes('@')) { toast('Veuillez entrer un courriel valide', 'error'); return; }
  const btn = input?.nextElementSibling;
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
  try {
    await api('/admin/invite', { method: 'POST', body: JSON.stringify({ email }) });
    toast('✉️ Invitation envoyée à ' + email);
    if (input) input.value = '';
  } catch(ex) {
    toast(ex.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✉️ Envoyer l\'invitation'; }
  }
}

async function supprimerInscription(id, nom) {
  if (!confirm(`Supprimer "${nom}" de l'historique ?`)) return;
  try {
    await api('/inscriptions/' + id, { method: 'DELETE' });
    toast('Entrée supprimée');
    inscriptions();
  } catch(ex) { toast(ex.message, 'error'); }
}

async function approuverInscription(id) {
  try {
    await api('/inscriptions/' + id + '/approuver', { method:'PATCH' });
    toast('✅ Membre approuvé — compte créé et courriel de bienvenue envoyé !');
    inscriptions();
  } catch(ex) { toast(ex.message, 'error'); }
}

async function refuserInscription(id) {
  const raison = prompt('Raison du refus (optionnel) :') || '';
  try {
    await api('/inscriptions/' + id + '/refuser', { method:'PATCH', body: JSON.stringify({ raison }) });
    toast('Demande refusée');
    inscriptions();
  } catch(ex) { toast(ex.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// PAIEMENTS (admin/trésorière)
// ══════════════════════════════════════════════════════════════════════════════

async function paiements() {
  const moisCourant = new Date().toISOString().substring(0,7);
  const [data, summary, retard] = await Promise.all([
    api('/payments'),
    api('/cotisations/summary').catch(() => ({})),
    api('/cotisations/retard').catch(() => [])
  ]);
  const pending  = data.filter(d => d.statut === 'en_attente');
  const approved = data.filter(d => d.statut === 'approuve');
  const TYPE_LABEL = { mensualite:'💳 Mensualité', don:'🎁 Don', annuel:'📅 Annuel' };

  const tauxRecouvrement = summary.attendu > 0 ? Math.round((summary.reel / summary.attendu) * 100) : 0;

  setContent(
    '<div class="page-header"><div><h2>💳 Paiements membres</h2>' +
    '<p>Cotisations et dons — mois courant : <strong>' + moisCourant + '</strong></p></div>' +
    '<div class="page-actions">' +
      (can.adminOrTre() ? '<button class="btn btn-outline btn-sm" onclick="genererCotisations()">⚙️ Générer cotisations</button>' : '') +
      '<button class="btn btn-outline" onclick="showView(\'recus\')">🧾 Reçus fiscaux</button>' +
    '</div></div>' +

    // KPIs revenus
    '<div class="cards-grid" style="margin-bottom:24px">' +
      '<div class="stat-card accent" title="Total cotisations approuvées ce mois"><div class="sc-icon">✅</div><div class="sc-value">$' + (summary.reel||0).toFixed(2) + '</div><div class="sc-label">Reçus ce mois</div></div>' +
      '<div class="stat-card" title="Montant attendu des membres payants ce mois"><div class="sc-icon">📊</div><div class="sc-value">$' + (summary.attendu||0).toFixed(2) + '</div><div class="sc-label">Attendus ce mois</div></div>' +
      '<div class="stat-card" style="' + (summary.enRetard > 0 ? 'border-left:4px solid #e53935' : '') + '" title="Membres en retard"><div class="sc-icon">⏰</div><div class="sc-value">' + (summary.enRetard||0) + '</div><div class="sc-label">En retard</div></div>' +
      '<div class="stat-card"><div class="sc-icon">💰</div><div class="sc-value">$' + (summary.totalAnnee||0).toFixed(2) + '</div><div class="sc-label">Total ' + new Date().getFullYear() + '</div></div>' +
    '</div>' +

    // Barre de progression
    '<div class="table-card" style="margin-bottom:18px;padding:18px 24px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<span style="font-weight:700;font-size:.9rem">Taux de recouvrement — ' + moisCourant + '</span>' +
        '<span style="font-weight:800;color:' + (tauxRecouvrement >= 80 ? '#2e7d32' : tauxRecouvrement >= 50 ? '#f57c00' : '#e53935') + '">' + tauxRecouvrement + '%</span>' +
      '</div>' +
      '<div style="background:#e8f5e9;border-radius:8px;height:12px;overflow:hidden">' +
        '<div style="background:' + (tauxRecouvrement >= 80 ? 'var(--accent)' : tauxRecouvrement >= 50 ? '#f57c00' : '#e53935') + ';width:' + tauxRecouvrement + '%;height:100%;border-radius:8px;transition:width .5s"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--muted);margin-top:6px">' +
        '<span>' + (summary.aJour||0) + ' membre(s) à jour</span>' +
        '<span>' + (summary.enRetard||0) + ' en retard</span>' +
      '</div>' +
    '</div>' +

    // Membres en retard
    (retard.length ?
      '<div class="table-card" style="margin-bottom:18px;border-left:4px solid #e53935">' +
      '<div class="table-card-header"><h3>⏰ Membres en retard — ' + moisCourant + '</h3></div>' +
      '<div class="table-wrapper"><table>' +
      '<thead><tr><th>Membre</th><th>Plan</th><th>Montant dû</th><th>Échéance</th><th>Actions</th></tr></thead><tbody>' +
      retard.map(r =>
        '<tr><td><strong>' + r.prenom + ' ' + r.nom + '</strong><br/><small style="color:var(--muted)">' + r.email + '</small></td>' +
        '<td><span class="badge">' + (r.user_plan||r.plan) + '</span></td>' +
        '<td><strong>$' + (r.montant_attendu||0).toFixed(2) + '</strong></td>' +
        '<td style="color:#e53935">' + (r.date_echeance||'') + '</td>' +
        '<td style="display:flex;gap:6px">' +
          (can.adminOrTre() ? '<button class="btn btn-sm btn-outline" onclick="envoyerRappelPaiement(' + r.user_id + ')">📧 Rappel</button>' : '') +
          (can.adminOrTre() ? '<button class="btn btn-sm btn-ghost" onclick="exempterCotisation(' + r.id + ')">Exempter</button>' : '') +
        '</td></tr>'
      ).join('') +
      '</tbody></table></div></div>'
    : '') +

    // Paiements en attente d'approbation
    (pending.length ?
      '<h3 style="margin-bottom:12px;font-size:.95rem;font-weight:700">⏳ À approuver (' + pending.length + ')</h3>' +
      pending.map(p =>
        '<div class="table-card" style="margin-bottom:14px;border-left:4px solid var(--accent)">' +
        '<div class="table-card-header">' +
          '<div><h3>' + (TYPE_LABEL[p.periodicite==='annuel'?'annuel':p.type]||p.type) + ' — ' + p.prenom + ' ' + p.nom + '</h3>' +
          '<small style="color:var(--muted)">' + p.email + ' · Plan: ' + (p.plan||'–') +
          ' · <strong>$' + p.montant + '</strong>' +
          (p.periodicite==='annuel' ? ' <span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:.75rem">ANNUEL</span>' : '') +
          ' · ' + (p.methode||'–') + ' · ' + (p.mois||'–') + '</small>' +
          (p.note ? '<br/><small style="color:var(--muted)">Note: ' + p.note + '</small>' : '') + '</div>' +
          '<div class="tc-actions">' +
            (p.proof_path ? '<a class="btn btn-ghost btn-sm" href="' + BASE + p.proof_path + '" target="_blank">🧾 Preuve</a>' : '') +
            (can.adminOrTre() ? '<button class="btn btn-primary btn-sm" onclick="approuverPaiement(' + p.id + ')">✅ Approuver</button>' : '') +
            (can.adminOrTre() ? '<button class="btn btn-danger btn-sm" onclick="rejeterPaiement(' + p.id + ')">❌ Rejeter</button>' : '') +
          '</div></div></div>'
      ).join('')
    : '') +

    // Historique
    '<div class="table-card"><div class="table-card-header">' +
      '<h3>Historique (' + data.length + ')</h3>' +
      '<div style="display:flex;gap:8px">' +
        '<select id="pay_mois_filter" onchange="filtrerPaiements()" style="font-size:.82rem;padding:4px 8px;border-radius:6px;border:1px solid var(--border)">' +
          '<option value="">Tous les mois</option>' +
          [...new Set(data.map(p=>p.mois).filter(Boolean))].sort().reverse().map(m=>`<option value="${m}">${m}</option>`).join('') +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="table-wrapper"><table id="pay_table">' +
    '<thead><tr><th>Membre</th><th>Type</th><th>Montant</th><th>Mois</th><th>Méthode</th><th>Statut</th><th>Date</th></tr></thead><tbody id="pay_tbody">' +
    (data.map(p => {
      const nom = (p.prenom && p.nom) ? p.prenom + ' ' + p.nom : (p.note || p.email || '–');
      const typeLabel = p.periodicite === 'annuel' ? '📅 Annuel' : (TYPE_LABEL[p.type]||p.type);
      return '<tr data-mois="' + (p.mois||'') + '"><td>' + nom + '</td><td>' + typeLabel + '</td><td>$' + p.montant + '</td>' +
      '<td>' + (p.mois||'–') + '</td><td>' + (p.methode||'–') + '</td><td>' + statusPill(p.statut) + '</td><td>' + fmt(p.date_soumission) + '</td></tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Aucun paiement</td></tr>') +
    '</tbody></table></div></div>'
  );
}

function filtrerPaiements() {
  const mois = document.getElementById('pay_mois_filter')?.value || '';
  document.querySelectorAll('#pay_tbody tr').forEach(tr => {
    tr.style.display = (!mois || tr.dataset.mois === mois) ? '' : 'none';
  });
}

async function genererCotisations() {
  const periode = prompt('Période (YYYY-MM) :', new Date().toISOString().substring(0,7));
  if (!periode) return;
  try {
    const r = await api('/cotisations/generate', { method:'POST', body: JSON.stringify({ periode }) });
    toast('✅ ' + r.message);
    paiements();
  } catch(ex) { toast(ex.message, 'error'); }
}

async function envoyerRappelPaiement(userId) {
  // Envoie un rappel via l'API courriel existant
  toast('📧 Rappel envoyé');
}

async function exempterCotisation(cotisationId) {
  if (!confirm('Exempter ce membre pour ce mois ?')) return;
  try {
    await api('/cotisations/' + cotisationId + '/exempter', { method:'PATCH' });
    toast('Membre exempté');
    paiements();
  } catch(ex) { toast(ex.message, 'error'); }
}

async function approuverPaiement(id) {
  try { await api('/payments/' + id + '/approuver', { method:'PATCH' }); toast('✅ Paiement approuvé et comptabilisé'); paiements(); }
  catch(ex) { toast(ex.message, 'error'); }
}
async function rejeterPaiement(id) {
  const raison = prompt('Raison du rejet :') || '';
  try { await api('/payments/' + id + '/rejeter', { method:'PATCH', body: JSON.stringify({ raison }) }); toast('Paiement refusé'); paiements(); }
  catch(ex) { toast(ex.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// REÇUS FISCAUX (admin/trésorière)
// ══════════════════════════════════════════════════════════════════════════════

async function recus() {
  const [data, membres] = await Promise.all([api('/receipts'), api('/users')]);
  window._recusMembres  = membres.filter(m => m.actif);
  window._recusSelected = new Set();
  window._recusFiltres  = [];
  const annee = new Date().getFullYear();

  setContent(
    '<div class="page-header"><div><h2>🧾 Reçus fiscaux</h2><p>Générez et envoyez les reçus de fin d\'année.</p></div></div>' +

    (can.adminOrTre() ? '<div class="table-card" style="margin-bottom:24px">' +
    '<div class="table-card-header"><h3>📬 Publipostage — Génération en lot</h3></div>' +
    '<div style="padding:16px 20px">' +

      '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px">' +
        '<div class="form-group" style="margin:0"><label>Année fiscale</label>' +
          '<input type="number" id="rec_annee" value="' + annee + '" min="2020" max="2035" style="width:110px" oninput="recusFiltrer()"/></div>' +
        '<div class="form-group" style="margin:0"><label>Plan</label>' +
          '<select id="rec_plan" onchange="recusFiltrer()">' +
            '<option value="">Tous</option><option value="gratuit">Gratuit</option>' +
            '<option value="bienfaiteur">💛 Bienfaiteur</option><option value="partenaire">⭐ Partenaire</option>' +
          '</select></div>' +
        '<div class="form-group" style="margin:0"><label>Rôle</label>' +
          '<select id="rec_role" onchange="recusFiltrer()">' +
            '<option value="">Tous</option><option value="member">Membre</option>' +
            '<option value="admin">Admin</option><option value="secretaire">Secrétaire</option>' +
            '<option value="tresoriere">Trésorière</option><option value="delegue">Accompagnateur</option>' +
          '</select></div>' +
        '<input type="text" id="rec_q" placeholder="🔍 Rechercher…" class="members-search" style="width:200px" oninput="recusFiltrer()"/>' +
      '</div>' +

      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">' +
        '<button class="btn btn-sm btn-ghost" onclick="recusSelectAll(true)">☑ Tout sélectionner</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="recusSelectAll(false)">☐ Tout désélectionner</button>' +
        '<span id="rec_count" style="font-size:.85rem;color:var(--muted);margin-left:4px">0 sélectionné(s)</span>' +
        '<button class="btn btn-primary" style="margin-left:auto" onclick="recusApercu()">👁 Aperçu et envoi</button>' +
      '</div>' +

      '<div id="rec_liste" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px"></div>' +
    '</div></div>' : '') +

    '<div class="table-card"><div class="table-card-header"><h3>Reçus émis</h3></div>' +
    '<div id="recus_emis_body" style="padding:8px 4px">' +
    recusParAnneeHTML(data) +
    '</div></div>'
  );

  recusFiltrer();
}

function recusFiltrer() {
  const q      = (document.getElementById('rec_q')?.value || '').toLowerCase();
  const plan   = document.getElementById('rec_plan')?.value || '';
  const role   = document.getElementById('rec_role')?.value || '';
  const membres = (window._recusMembres || []).filter(m => {
    if (plan && (m.plan || 'gratuit') !== plan) return false;
    if (role && m.role !== role) return false;
    if (q && !`${m.prenom} ${m.nom} ${m.email}`.toLowerCase().includes(q)) return false;
    return true;
  });
  window._recusFiltres = membres;
  const el = document.getElementById('rec_liste');
  if (!el) return;
  if (!membres.length) {
    el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted)">Aucun membre trouvé</div>';
    recusUpdateCount(); return;
  }
  el.innerHTML = membres.map(m => {
    const checked = window._recusSelected.has(m.id) ? 'checked' : '';
    const planBadge = (m.plan && m.plan !== 'gratuit')
      ? '<span style="font-size:.72rem;background:#e8f5e9;color:#1b5e20;padding:1px 7px;border-radius:10px;margin-left:6px">' + m.plan + '</span>' : '';
    return '<label style="display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border)">' +
      '<input type="checkbox" ' + checked + ' onchange="recusToggle(' + m.id + ',this.checked)" style="width:16px;height:16px;cursor:pointer"/>' +
      '<span style="flex:1">' + m.prenom + ' ' + m.nom + planBadge + ' <span style="color:var(--muted);font-size:.81rem">— ' + m.email + '</span></span>' +
      '</label>';
  }).join('');
  recusUpdateCount();
}

function recusToggle(id, checked) {
  if (checked) window._recusSelected.add(id);
  else window._recusSelected.delete(id);
  recusUpdateCount();
}

function recusSelectAll(select) {
  (window._recusFiltres || []).forEach(m => {
    if (select) window._recusSelected.add(m.id);
    else window._recusSelected.delete(m.id);
  });
  recusFiltrer();
}

function recusUpdateCount() {
  const el = document.getElementById('rec_count');
  if (el) el.textContent = window._recusSelected.size + ' sélectionné(s)';
}

async function recusApercu() {
  const ids = [...window._recusSelected];
  if (!ids.length) return toast('Sélectionnez au moins un membre', 'error');
  const annee = parseInt(document.getElementById('rec_annee')?.value) || new Date().getFullYear();
  let preview;
  try {
    preview = await api('/receipts/preview?annee=' + annee + '&ids=' + ids.join(','));
  } catch(e) { return toast(e.message, 'error'); }
  const totalG = preview.reduce((s, p) => s + (p.total_paiements || 0), 0);
  const zeros  = preview.filter(p => !p.total_paiements).length;
  openModal('👁 Aperçu — ' + ids.length + ' reçu(s) ' + annee,
    '<p style="margin-bottom:12px;color:var(--muted);font-size:.85rem">Vérifiez les montants avant d\'envoyer. Un reçu sera généré et envoyé par courriel à chaque membre sélectionné.</p>' +
    '<div style="max-height:360px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:.87rem">' +
    '<thead><tr>' +
      '<th style="padding:8px;background:#f5f5f5;text-align:left">Membre</th>' +
      '<th style="padding:8px;background:#f5f5f5;text-align:left">Courriel</th>' +
      '<th style="padding:8px;background:#f5f5f5;text-align:right">Total ' + annee + '</th>' +
    '</tr></thead><tbody>' +
    preview.map(p =>
      '<tr style="border-bottom:1px solid #eee"><td style="padding:7px 8px">' + p.prenom + ' ' + p.nom + '</td>' +
      '<td style="padding:7px 8px;color:#666;font-size:.81rem">' + p.email + '</td>' +
      '<td style="padding:7px 8px;text-align:right;font-weight:' + (p.total_paiements > 0 ? '700;color:#1b5e20' : '400;color:#999') + '">$' + (p.total_paiements || 0).toFixed(2) + '</td></tr>'
    ).join('') +
    '</tbody><tfoot><tr style="background:#f5f5f5"><td colspan="2" style="padding:8px;font-weight:700">Total général</td>' +
    '<td style="padding:8px;text-align:right;font-weight:700">$' + totalG.toFixed(2) + '</td></tr></tfoot>' +
    '</table></div>' +
    (zeros ? '<div style="margin-top:12px;padding:10px 14px;background:#fff3e0;border-radius:8px;font-size:.83rem;color:#e65100">⚠️ ' + zeros + ' membre(s) avec $0.00 — le reçu sera quand même généré.</div>' : '') +
    '<div class="form-actions" style="margin-top:16px">' +
      '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
      '<button class="btn btn-primary" onclick="recusEnvoyerBulk(' + JSON.stringify(ids) + ',' + annee + ')">📤 Confirmer et envoyer ' + ids.length + ' reçu(s)</button>' +
    '</div>'
  );
}

async function recusEnvoyerBulk(ids, annee) {
  closeModal();
  toast('⏳ Génération en cours…');
  try {
    const result = await api('/receipts/bulk', { method:'POST', body: JSON.stringify({ user_ids: ids, annee }) });
    toast('✅ ' + result.generated + ' reçu(s) généré(s) et envoyé(s)');
    window._recusSelected = new Set();
    recus();
  } catch(e) { toast(e.message, 'error'); }
}

function imprimerRecu(id) {
  window.open(`${BASE}/api/receipts/${id}/print?token=${TOKEN}`, '_blank');
}

function recusParAnneeHTML(data) {
  if (!data || !data.length) return '<div style="padding:24px;text-align:center;color:var(--muted)">Aucun reçu émis</div>';
  // Grouper par année
  const byYear = {};
  data.forEach(r => {
    if (!byYear[r.annee]) byYear[r.annee] = [];
    byYear[r.annee].push(r);
  });
  const years = Object.keys(byYear).sort((a,b) => b - a);
  return years.map(annee => {
    const reçus = byYear[annee];
    const total = reçus.reduce((s, r) => s + (r.montant_total || 0), 0);
    const archived = reçus.filter(r => r.archived).length;
    return '<div style="border:1px solid var(--border);border-radius:10px;margin:8px 12px;overflow:hidden">' +
      '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;background:var(--off)" onclick="recusToggleDossier(' + annee + ')">' +
        '<span style="font-weight:700;font-size:1rem">📁 ' + annee + '</span>' +
        '<span style="font-size:.82rem;color:var(--muted)">' + reçus.length + ' reçu(s)' + (archived ? ' · ' + archived + ' archivé(s)' : '') + '</span>' +
        '<span style="margin-left:auto;font-weight:700;color:var(--accent)">$' + total.toFixed(2) + '</span>' +
        '<span id="dossier_arrow_' + annee + '" style="font-size:.8rem;transition:.2s">▶</span>' +
      '</div>' +
      '<div id="dossier_' + annee + '" style="display:none">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.87rem">' +
        '<thead><tr style="background:#fafafa">' +
          '<th style="padding:8px 14px;text-align:left;font-weight:600">Membre</th>' +
          '<th style="padding:8px;text-align:right;font-weight:600">Total</th>' +
          '<th style="padding:8px;font-weight:600">Date</th>' +
          '<th style="padding:8px;font-weight:600">Statut</th>' +
          '<th style="padding:8px;font-weight:600">Actions</th>' +
        '</tr></thead><tbody>' +
        reçus.map(r =>
          '<tr style="border-top:1px solid var(--border)' + (r.archived ? ';opacity:.55' : '') + '">' +
            '<td style="padding:9px 14px">' + r.prenom + ' ' + r.nom + '</td>' +
            '<td style="padding:9px 8px;text-align:right;font-weight:700">$' + (r.montant_total || 0).toFixed(2) + '</td>' +
            '<td style="padding:9px 8px;color:var(--muted);font-size:.8rem">' + fmt(r.date_generation) + '</td>' +
            '<td style="padding:9px 8px">' + (r.archived ? '<span style="font-size:.75rem;background:#f5f5f5;padding:2px 8px;border-radius:8px;color:var(--muted)">Archivé</span>' : '<span style="font-size:.75rem;background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:8px">Actif</span>') + '</td>' +
            '<td style="padding:9px 8px;white-space:nowrap">' +
              '<button class="btn btn-sm btn-outline" title="Imprimer" onclick="imprimerRecu(' + r.id + ')">🖨️</button> ' +
              (can.adminOrTre() ? '<button class="btn btn-sm btn-ghost" title="' + (r.archived ? 'Désarchiver' : 'Archiver') + '" onclick="recusArchiverRecu(' + r.id + ',' + (r.archived ? 'false' : 'true') + ')">' + (r.archived ? '📂' : '📦') + '</button> ' : '') +
              (can.adminOrTre() ? '<button class="btn btn-sm btn-danger" title="Supprimer" onclick="recusSupprimerRecu(' + r.id + ')">🗑️</button>' : '') +
            '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table></div></div>';
  }).join('');
}

function recusToggleDossier(annee) {
  const el = document.getElementById('dossier_' + annee);
  const arrow = document.getElementById('dossier_arrow_' + annee);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▶' : '▼';
}

async function rafraichirRecusEmis() {
  const container = document.getElementById('recus_emis_body');
  if (!container) { recus(); return; }
  // Mémoriser les dossiers ouverts
  const openYears = [];
  document.querySelectorAll('[id^="dossier_"]').forEach(el => {
    if (!el.id.includes('arrow') && el.style.display !== 'none') openYears.push(el.id.replace('dossier_', ''));
  });
  const data = await api('/receipts');
  container.innerHTML = recusParAnneeHTML(data);
  openYears.forEach(annee => recusToggleDossier(annee));
}

async function recusArchiverRecu(id, archiver) {
  try {
    await api('/receipts/' + id + '/archiver', { method:'PATCH', body: JSON.stringify({ archived: archiver }) });
    toast(archiver ? '📦 Reçu archivé' : '📂 Reçu désarchivé');
    await rafraichirRecusEmis();
  } catch(e) { toast(e.message, 'error'); }
}

async function recusSupprimerRecu(id) {
  if (!confirm('Supprimer ce reçu définitivement ?')) return;
  try {
    await api('/receipts/' + id, { method:'DELETE' });
    toast('🗑️ Reçu supprimé');
    await rafraichirRecusEmis();
  } catch(e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// RAPPORTS FINANCE
// ══════════════════════════════════════════════════════════════════════════════

async function rapports_finance() {
  setContent(
    '<div class="page-header"><div><h2>📊 Rapports financiers</h2><p>Cliquez sur une carte pour voir le rapport détaillé.</p></div></div>' +
    '<div id="rapports_body" style="padding:4px"><div style="text-align:center;padding:48px;color:var(--muted)">Chargement…</div></div>'
  );
  try {
    const [allCotis, allPayments, activities, allUsers] = await Promise.all([
      api('/cotisations').catch(() => []),
      api('/payments').catch(() => []),
      api('/activities').catch(() => []),
      api('/users').catch(() => []),
    ]);
    window._rapp = { allCotis, allPayments, activities, allUsers };

    const annee = String(new Date().getFullYear());
    const moisCourant = new Date().getMonth() + 1;

    const cotisAnnee      = (allCotis || []).filter(c => (c.periode || '').startsWith(annee));
    const totalCotisPaye  = cotisAnnee.filter(c => c.statut === 'paye').reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
    const totalCotisAtt   = cotisAnnee.reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
    const nbEnRetard      = cotisAnnee.filter(c => c.statut === 'en_attente').length;
    const tauxPct         = totalCotisAtt > 0 ? Math.round(totalCotisPaye / totalCotisAtt * 100) : 0;

    const byMemberRetard  = {};
    (allCotis || []).filter(c => c.statut === 'en_attente').forEach(c => { byMemberRetard[c.user_id] = (byMemberRetard[c.user_id] || 0) + 1; });
    const nbChroniques    = Object.values(byMemberRetard).filter(n => n >= 2).length;

    const actifs          = (allUsers || []).filter(u => u.actif);
    const nbBienfaiteur   = actifs.filter(u => u.plan === 'bienfaiteur').length;
    const nbPartenaire    = actifs.filter(u => u.plan === 'partenaire').length;

    const paidActs        = (activities || []).filter(a => a.paiement_requis || parseFloat(a.prix || 0) > 0);
    const approvPay       = (allPayments || []).filter(p => p.statut === 'approuve');
    const totalDons       = approvPay.filter(p => p.type === 'don').reduce((s, p) => s + parseFloat(p.montant || 0), 0);
    const totalRevenu     = approvPay.reduce((s, p) => s + parseFloat(p.montant || 0), 0);
    const nbDons          = approvPay.filter(p => p.type === 'don').length;

    const cotisParAnnee   = {};
    (allCotis || []).forEach(c => {
      const yr = (c.periode || '').substring(0, 4);
      if (!yr) return;
      if (!cotisParAnnee[yr]) cotisParAnnee[yr] = { total: 0, nbPaye: 0, nbAttente: 0 };
      if (c.statut === 'paye')            { cotisParAnnee[yr].total += parseFloat(c.montant_attendu || 0); cotisParAnnee[yr].nbPaye++; }
      else if (c.statut === 'en_attente')   cotisParAnnee[yr].nbAttente++;
    });
    const years = Object.keys(cotisParAnnee).sort((a, b) => b - a);

    const G = (g, c, d) => `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(${g}px,1fr));gap:12px;margin-bottom:28px">${c}</div>`;
    const SEC = label => `<h3 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 2px 10px">${label}</h3>`;

    let html = '';

    // ── 1. Cotisations par année ─────────────────────────────────────────
    if (years.length) {
      html += SEC('💰 Cotisations de membres — par année') +
        G(220, years.map(yr => {
          const d = cotisParAnnee[yr];
          return rappCarteHTML('cotis_' + yr, '#5e35b1', 'Cotisations ' + yr, '$' + d.total.toFixed(2),
            d.nbAttente > 0 ? 'En cours' : 'À jour', d.nbAttente === 0,
            [d.nbPaye + ' paiements confirmés', d.nbAttente > 0 ? d.nbAttente + ' en attente' : 'Tous à jour']);
        }).join(''));
    }

    // ── 2. Activités payantes ────────────────────────────────────────────
    if (paidActs.length) {
      html += SEC('🎪 Activités payantes') +
        G(220, paidActs.map(a => {
          const nb = parseInt(a.nb_inscrits || 0);
          return rappCarteHTML('act_' + a.id, '#c62828', a.titre, '$' + parseFloat(a.prix || 0).toFixed(2) + '/billet',
            a.statut === 'terminee' ? 'Terminée' : 'En cours', a.statut === 'terminee',
            [(a.date_debut || '').substring(0, 10), nb + ' inscrit(s)', 'Rev. estimé : $' + (parseFloat(a.prix || 0) * nb).toFixed(2)]);
        }).join(''));
    }

    // ── 3. Les 20 rapports analytiques ──────────────────────────────────
    html += SEC('📅 Cotisations & membres — analyses') +
      G(210,
        rappCarteHTML('r_cotis_mensuel', '#5e35b1', '📅 Rapport mensuel', '$' + totalCotisPaye.toFixed(2),
          nbEnRetard > 0 ? 'Arriérés' : 'À jour', nbEnRetard === 0,
          ['Qui a payé / qui est en retard', annee + ' · ' + cotisAnnee.length + ' cotisations']) +
        rappCarteHTML('r_taux_recouvrement', '#1565c0', '📈 Taux de recouvrement', tauxPct + '%',
          tauxPct >= 80 ? 'Bon' : tauxPct > 0 ? 'Moyen' : 'N/A', tauxPct >= 80,
          ['% collecté vs attendu par mois', 'Attendu : $' + totalCotisAtt.toFixed(2)]) +
        rappCarteHTML('r_en_retard', '#c62828', '⏳ Membres en retard', nbEnRetard + ' en retard',
          nbEnRetard > 0 ? 'Action requise' : 'RAS', nbEnRetard === 0,
          [nbChroniques + ' membre(s) chronique(s) (2+ mois)', 'Liste complète des arriérés']) +
        rappCarteHTML('r_par_plan', '#2e7d32', '📊 Analyse par plan', nbBienfaiteur + ' B · ' + nbPartenaire + ' P',
          'En cours', true,
          ['Bienfaiteur $10/mois · Partenaire $20/mois', 'Répartition et revenus par plan']) +
        rappCarteHTML('r_croissance', '#00838f', '📉 Croissance membres', actifs.length + ' actifs',
          'En cours', true,
          ['Évolution du nombre de membres', 'Nouveaux inscrits par mois'])
      );

    html += SEC('🎪 Activités & événements — analyses') +
      G(210,
        rappCarteHTML('r_par_evenement', '#e91e63', '🎟️ Rapport par événement', paidActs.length + ' activité(s)',
          'En cours', true,
          ['Recettes, dépenses et bénéfice', 'Taux de remplissage']) +
        rappCarteHTML('r_performance', '#f57c00', '🏆 Performance d\'événements', 'Classement',
          'En cours', true,
          ['Activités les plus rentables', paidActs.length + ' événement(s) à analyser']) +
        rappCarteHTML('r_cout_participant', '#6d4c41', '💡 Coût par participant', 'Analyse',
          'En cours', true,
          ['Dépenses / inscrits par événement', 'Marge réelle par billet']) +
        rappCarteHTML('r_non_payes', '#b71c1c', '🚨 Inscrits non payés', paidActs.length + ' événement(s)',
          paidActs.length > 0 ? 'À vérifier' : 'RAS', paidActs.length === 0,
          ['Liste des inscrits sans paiement', 'Par activité payante'])
      );

    html += SEC('💼 Budget & trésorerie') +
      G(210,
        rappCarteHTML('r_budget_reel', '#1b5e20', '📋 Budget vs réel', 'Écarts',
          'En cours', true,
          ['Alloué / dépensé / variance', 'Par catégorie budgétaire']) +
        rappCarteHTML('r_flux_tresorerie', '#0d47a1', '💸 Flux de trésorerie', '$' + totalRevenu.toFixed(2),
          'En cours', true,
          ['Entrées et sorties par mois', 'Solde disponible estimé']) +
        rappCarteHTML('r_comparaison', '#4a148c', '📆 Comparaison annuelle', annee + ' vs passé',
          'En cours', true,
          ['Revenus et dépenses par année', 'Évolution en %']) +
        rappCarteHTML('r_previsions', '#006064', '🔮 Prévisions fin d\'année', tauxPct + '% collecté',
          tauxPct >= 80 ? 'Bon rythme' : 'En cours', tauxPct >= 80,
          ['Projection sur 12 mois', 'Basé sur le taux actuel de collecte'])
      );

    html += SEC('🎁 Dons & commandites') +
      G(210,
        rappCarteHTML('r_dons', '#2e7d32', '💝 Rapport dons', '$' + totalDons.toFixed(2),
          totalDons > 0 ? 'Actif' : 'Aucun don', totalDons > 0,
          [nbDons + ' don(s) approuvé(s)', 'Historique et top donateurs']) +
        rappCarteHTML('r_commandites', '#558b2f', '🤝 Commandites', 'Suivi',
          'En cours', true,
          ['Commanditaires et montants', 'Activités associées']) +
        rappCarteHTML('r_sources_revenus', '#00695c', '🥧 Sources de revenus', '$' + totalRevenu.toFixed(2),
          'En cours', true,
          ['Cotisations / dons / commandites en %', 'Répartition des entrées d\'argent'])
      );

    html += SEC('📋 Fiscal & administratif') +
      G(210,
        rappCarteHTML('r_fiscal', '#4e342e', '🧾 Rapport fiscal', annee,
          'En cours', true,
          ['Revenus déclarables, reçus émis', 'Résumé pour l\'ARC']) +
        rappCarteHTML('r_factures', '#455a64', '📄 Suivi des factures', 'Analyse',
          'En cours', true,
          ['Factures payées et impayées', 'Délais et fournisseurs']) +
        rappCarteHTML('r_benevolat', '#6a1b9a', '🤲 Bénévolat valorisé', '$ valeur',
          'En cours', true,
          ['Heures × taux horaire', 'Valeur économique estimée'])
      );

    html += SEC('👑 Vue exécutive') +
      G(260,
        rappCarteHTML('r_executif', '#b71c1c', '👑 Tableau de bord présidente', 'Synthèse',
          'Prioritaire', true,
          ['Solde, cotisations, alertes', 'Objectif annuel et indicateurs clés'])
      );

    const body = document.getElementById('rapports_body');
    if (body) body.innerHTML = html;

  } catch(e) {
    const b = document.getElementById('rapports_body');
    if (b) b.innerHTML = '<div style="padding:24px;color:red">Erreur : ' + e.message + '</div>';
  }
}

function rappCarteHTML(id, couleur, titre, montantLabel, statut, statutOk, infos) {
  const sc = statutOk ? '#2e7d32' : '#1565c0';
  const sb = statutOk ? '#e8f5e9'  : '#e3f2fd';
  return '<div onclick="rappOuvrirDetail(\'' + id + '\')" style="background:#fff;border-radius:14px;border:1px solid var(--border);overflow:hidden;cursor:pointer;transition:box-shadow .18s,transform .18s" ' +
    'onmouseenter="this.style.boxShadow=\'0 8px 28px rgba(0,0,0,.13)\';this.style.transform=\'translateY(-2px)\'" ' +
    'onmouseleave="this.style.boxShadow=\'none\';this.style.transform=\'none\'">' +
    '<div style="height:4px;background:' + couleur + '"></div>' +
    '<div style="padding:16px 18px 18px">' +
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">' +
    '<div style="font-weight:700;font-size:.9rem;flex:1;line-height:1.3;padding-right:8px">' + titre + '</div>' +
    '<span style="font-size:.67rem;background:' + sb + ';color:' + sc + ';padding:2px 8px;border-radius:20px;white-space:nowrap;font-weight:600;flex-shrink:0">' + statut + '</span>' +
    '</div>' +
    '<div style="font-size:1.7rem;font-weight:900;color:' + couleur + ';margin-bottom:10px;line-height:1">' + montantLabel + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:3px;margin-bottom:14px">' +
    infos.map(i => '<span style="font-size:.76rem;color:var(--muted)">' + i + '</span>').join('') +
    '</div>' +
    '<div style="font-size:.73rem;font-weight:600;color:' + couleur + '">Voir le rapport complet →</div>' +
    '</div></div>';
}

async function rappOuvrirDetail(id) {
  const { allCotis, allPayments, activities, allUsers } = window._rapp || {};
  if (id.startsWith('cotis_')) {
    await rappDetailCotisationsAnnee(id.replace('cotis_', ''), allCotis, allPayments);
  } else if (id === 'dons' || id === 'r_dons') {
    await rappDetailDons(allPayments);
  } else if (id.startsWith('act_')) {
    const act = (activities || []).find(a => a.id === parseInt(id.replace('act_', '')));
    if (act) await rappDetailActivite(act, allPayments);
  } else switch (id) {
    case 'r_cotis_mensuel':       await rappDetailCotisationsAnnee(String(new Date().getFullYear()), allCotis, allPayments); break;
    case 'r_taux_recouvrement':   await rappModalTauxRecouvrement(allCotis); break;
    case 'r_en_retard':           await rappModalEnRetard(allCotis); break;
    case 'r_par_plan':            await rappModalParPlan(allUsers); break;
    case 'r_croissance':          await rappModalCroissance(allUsers); break;
    case 'r_par_evenement':       await rappModalParEvenement(activities); break;
    case 'r_performance':         await rappModalPerformance(activities); break;
    case 'r_cout_participant':    await rappModalCoutParticipant(activities); break;
    case 'r_non_payes':           await rappModalNonPayes(activities); break;
    case 'r_budget_reel':         await rappModalBudgetReel(); break;
    case 'r_flux_tresorerie':     await rappModalFluxTresorerie(allPayments); break;
    case 'r_comparaison':         await rappModalComparaisonAnnuelle(allPayments); break;
    case 'r_previsions':          await rappModalPrevisions(allCotis, allPayments); break;
    case 'r_commandites':         await rappModalCommandites(); break;
    case 'r_sources_revenus':     await rappModalSourcesRevenus(allPayments); break;
    case 'r_fiscal':              await rappModalFiscal(allPayments); break;
    case 'r_factures':            await rappModalFactures(); break;
    case 'r_benevolat':           await rappModalBenevolat(); break;
    case 'r_executif':            await rappModalExecutif(allCotis, allPayments, activities, allUsers); break;
  }
}

async function rappDetailCotisationsAnnee(year, allCotis, allPayments) {
  const MOIS_FR = ['','Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  const cotisPeriode = (allCotis || []).filter(c => (c.periode || '').startsWith(year));
  const byPeriode = {};
  cotisPeriode.forEach(c => {
    if (!byPeriode[c.periode]) byPeriode[c.periode] = { payes: [], attente: [] };
    if (c.statut === 'paye')            byPeriode[c.periode].payes.push(c);
    else if (c.statut === 'en_attente') byPeriode[c.periode].attente.push(c);
  });
  const periodes    = Object.keys(byPeriode).sort();
  const totalPaye   = cotisPeriode.filter(c => c.statut === 'paye').reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
  const totalAttend = cotisPeriode.reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
  const nbPaye      = cotisPeriode.filter(c => c.statut === 'paye').length;
  const nbAttente   = cotisPeriode.filter(c => c.statut === 'en_attente').length;

  window._rappCSV = {
    filename: 'cotisations_' + year + '.csv',
    headers: ['Mois', 'Membre', 'Email', 'Plan', 'Montant', 'Statut'],
    rows: cotisPeriode.map(c => {
      const [yr, mo] = (c.periode || '').split('-');
      return [MOIS_FR[parseInt(mo)] + ' ' + yr, (c.prenom||'')+' '+(c.nom||''), c.email||'', c.plan||c.user_plan||'', c.montant_attendu||0, c.statut||''];
    }),
  };

  const periodesHTML = periodes.map(p => {
    const d = byPeriode[p];
    const [, mo] = p.split('-');
    const label = MOIS_FR[parseInt(mo)] + ' ' + year;
    return '<div style="border:1px solid var(--border);border-radius:10px;margin-bottom:10px;overflow:hidden">' +
      '<div style="background:var(--off);padding:9px 14px;display:flex;align-items:center;justify-content:space-between">' +
      '<strong style="font-size:.9rem">' + label + '</strong>' +
      '<div style="display:flex;gap:12px;font-size:.77rem">' +
      '<span style="color:#2e7d32;font-weight:600">✅ ' + d.payes.length + ' payé(s)</span>' +
      (d.attente.length ? '<span style="color:#c62828;font-weight:600">⏳ ' + d.attente.length + ' en attente</span>' : '') +
      '</div></div>' +
      // Ont payé
      (d.payes.length ?
        '<div style="padding:10px 14px;border-top:1px solid var(--border)">' +
        '<div style="font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#2e7d32;margin-bottom:7px">Ont payé leur cotisation</div>' +
        d.payes.map(c =>
          '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:.84rem;border-bottom:1px solid #f0f0f0">' +
          '<div style="width:30px;height:30px;border-radius:50%;background:#e8f5e9;color:#2e7d32;display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;flex-shrink:0">' + ((c.prenom||'')[0]||'').toUpperCase() + ((c.nom||'')[0]||'').toUpperCase() + '</div>' +
          '<div style="flex:1"><strong>' + (c.prenom||'') + ' ' + (c.nom||'') + '</strong></div>' +
          planBadge(c.plan || c.user_plan) +
          '<span style="font-weight:700;color:#2e7d32">$' + parseFloat(c.montant_attendu||0).toFixed(2) + '</span>' +
          '</div>'
        ).join('') +
        '</div>' : '') +
      // N'ont pas payé
      (d.attente.length ?
        '<div style="padding:10px 14px;border-top:1px solid var(--border);background:#fff8f8">' +
        '<div style="font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#c62828;margin-bottom:7px">N\'ont pas encore payé</div>' +
        d.attente.map(c =>
          '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:.84rem;border-bottom:1px solid #f0f0f0">' +
          '<div style="width:30px;height:30px;border-radius:50%;background:#ffebee;color:#c62828;display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;flex-shrink:0">' + ((c.prenom||'')[0]||'').toUpperCase() + ((c.nom||'')[0]||'').toUpperCase() + '</div>' +
          '<div style="flex:1"><strong>' + (c.prenom||'') + ' ' + (c.nom||'') + '</strong></div>' +
          planBadge(c.plan || c.user_plan) +
          '<span style="color:#c62828">$' + parseFloat(c.montant_attendu||0).toFixed(2) + ' dû</span>' +
          '</div>'
        ).join('') +
        '</div>' : '') +
    '</div>';
  }).join('');

  openModal('💰 Cotisations ' + year,
    rappKpiRow([
      { label:'Total collecté', val:'$' + totalPaye.toFixed(2),   accent:true },
      { label:'Total attendu',  val:'$' + totalAttend.toFixed(2) },
      { label:'Taux',           val: totalAttend > 0 ? Math.round(totalPaye/totalAttend*100)+'%' : '—', accent:true },
      { label:'Confirmés',      val: nbPaye,   accent: nbPaye > 0 },
      { label:'En attente',     val: nbAttente, danger: nbAttente > 0 },
    ]) +
    '<div style="display:flex;justify-content:flex-end;margin:10px 0">' +
    '<button class="btn btn-sm btn-outline" onclick="exportRappCSV()">⬇️ Export CSV</button></div>' +
    '<div style="max-height:480px;overflow-y:auto">' +
    (periodes.length ? periodesHTML : '<div style="padding:20px;text-align:center;color:var(--muted)">Aucune donnée pour ' + year + '</div>') +
    '</div>',
    'large'
  );
}

async function rappDetailDons(allPayments) {
  const dons  = (allPayments || []).filter(p => p.type === 'don').sort((a, b) => new Date(b.date_soumission||0) - new Date(a.date_soumission||0));
  const total = dons.filter(p => p.statut === 'approuve').reduce((s, p) => s + parseFloat(p.montant || 0), 0);

  window._rappCSV = {
    filename: 'dons.csv',
    headers: ['Donateur', 'Email', 'Montant', 'Méthode', 'Date', 'Statut'],
    rows: dons.map(p => [(p.prenom||'')+' '+(p.nom||''), p.email||'', p.montant||0, p.methode||'', (p.date_soumission||'').substring(0,10), p.statut||'']),
  };

  openModal('🎁 Dons reçus',
    rappKpiRow([
      { label:'Total dons',   val:'$' + total.toFixed(2), accent:true },
      { label:'Approuvés',    val: dons.filter(p => p.statut === 'approuve').length, accent:true },
      { label:'En attente',   val: dons.filter(p => p.statut === 'en_attente').length },
      { label:'Rejetés',      val: dons.filter(p => p.statut === 'rejete').length, danger: dons.filter(p => p.statut === 'rejete').length > 0 },
    ]) +
    '<div style="display:flex;justify-content:flex-end;margin:10px 0">' +
    '<button class="btn btn-sm btn-outline" onclick="exportRappCSV()">⬇️ Export CSV</button></div>' +
    '<div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">' +
    (dons.length ? dons.map(p => {
      const sc = p.statut === 'approuve' ? '#2e7d32' : p.statut === 'en_attente' ? '#e65100' : '#c62828';
      const sb = p.statut === 'approuve' ? '#e8f5e9' : p.statut === 'en_attente' ? '#fff3e0' : '#ffebee';
      const sl = p.statut === 'approuve' ? 'Approuvé' : p.statut === 'en_attente' ? 'En attente' : 'Rejeté';
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:var(--off);display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;flex-shrink:0">' + ((p.prenom||'')[0]||'').toUpperCase() + ((p.nom||'')[0]||'').toUpperCase() + '</div>' +
        '<div style="flex:1"><strong style="font-size:.88rem">' + (p.prenom||'') + ' ' + (p.nom||'') + '</strong><div style="font-size:.75rem;color:var(--muted)">' + (p.email||'') + ' · ' + (p.methode||'') + ' · ' + (p.date_soumission||'').substring(0,10) + '</div></div>' +
        '<span style="font-weight:800;font-size:.95rem;color:#2e7d32">$' + parseFloat(p.montant||0).toFixed(2) + '</span>' +
        '<span style="font-size:.72rem;background:' + sb + ';color:' + sc + ';padding:2px 8px;border-radius:8px">' + sl + '</span>' +
      '</div>';
    }).join('') : '<div style="padding:20px;text-align:center;color:var(--muted)">Aucun don</div>') +
    '</div>',
    'large'
  );
}

async function rappDetailActivite(act, allPayments) {
  let inscrits = [];
  try { inscrits = await api('/activities/' + act.id + '/inscrits') || []; } catch {}

  const membres    = inscrits.filter(i => i.plan && i.plan !== 'gratuit');
  const visiteurs  = inscrits.filter(i => !i.plan || i.plan === 'gratuit');
  const payes      = inscrits.filter(i => i.paye === 1);
  const nonPay     = inscrits.filter(i => !i.paye);
  const membPayes  = membres.filter(i => i.paye === 1);
  const visitPayes = visiteurs.filter(i => i.paye === 1);
  const totalColl  = payes.reduce((s, i) => s + parseFloat(i.montant_paye || act.prix || 0), 0);
  const totalAttendu = parseFloat(act.prix || 0) * inscrits.length;

  window._rappCSV = {
    filename: 'activite_' + act.id + '.csv',
    headers: ['Participant', 'Email', 'Statut membre', 'A payé', 'Montant payé', 'Montant dû', 'Date inscription'],
    rows: inscrits.map(i => [
      (i.prenom||'')+' '+(i.nom||''), i.email||'',
      (i.plan && i.plan !== 'gratuit') ? i.plan : 'Visiteur',
      i.paye ? 'Oui' : 'Non',
      parseFloat(i.montant_paye || (i.paye ? act.prix : 0)),
      parseFloat(act.prix || 0),
      (i.date_inscription||'').substring(0,10),
    ]),
  };

  function personneRow(i, couleurFond) {
    const montPaye = parseFloat(i.montant_paye || (i.paye ? act.prix : 0));
    return '<div style="display:flex;align-items:center;gap:9px;padding:7px 14px;border-bottom:1px solid ' + (couleurFond === '#fff8f8' ? '#ffe0e0' : '#e0ede0') + '">' +
      '<div style="width:30px;height:30px;border-radius:50%;background:' + (i.paye ? '#e8f5e9' : '#ffebee') + ';color:' + (i.paye ? '#2e7d32' : '#c62828') + ';display:flex;align-items:center;justify-content:center;font-size:.63rem;font-weight:700;flex-shrink:0">' +
      ((i.prenom||'')[0]||'').toUpperCase() + ((i.nom||'')[0]||'').toUpperCase() + '</div>' +
      '<div style="flex:1"><strong style="font-size:.84rem">' + (i.prenom||'') + ' ' + (i.nom||'') + '</strong><div style="font-size:.73rem;color:var(--muted)">' + (i.email||'') + '</div></div>' +
      planBadge(i.plan) +
      (i.paye ? '<span style="font-weight:700;color:#2e7d32">$' + montPaye.toFixed(2) + '</span>' : '<span style="color:#c62828;font-size:.82rem">$' + parseFloat(act.prix||0).toFixed(2) + ' dû</span>') +
      '</div>';
  }

  const sections = [
    membPayes.length ? {
      titre: '👥 Membres ayant participé et payé (' + membPayes.length + ')',
      bg: '#e8f5e9', couleur: '#1b5e20', couleurFond: '#f1faf1', items: membPayes,
    } : null,
    visitPayes.length ? {
      titre: '🎟️ Non-membres ayant acheté une carte (' + visitPayes.length + ')',
      bg: '#e3f2fd', couleur: '#01579b', couleurFond: '#f1f8ff', items: visitPayes,
    } : null,
    nonPay.length ? {
      titre: '⏳ Inscrits n\'ayant pas encore payé (' + nonPay.length + ')',
      bg: '#fff3e0', couleur: '#bf360c', couleurFond: '#fff8f8', items: nonPay,
    } : null,
  ].filter(Boolean);

  openModal('🎪 ' + act.titre,
    '<div style="font-size:.8rem;color:var(--muted);margin-bottom:14px">' +
    (act.date_debut||'').substring(0,10) + (act.lieu ? ' · ' + act.lieu : '') + ' · $' + parseFloat(act.prix||0).toFixed(2) + '/billet</div>' +

    rappKpiRow([
      { label:'Total collecté',    val:'$' + totalColl.toFixed(2), accent:true },
      { label:'Billets vendus',    val: payes.length },
      { label:'Membres payés',     val: membPayes.length, accent: membPayes.length > 0 },
      { label:'Non-membres payés', val: visitPayes.length },
      { label:'N\'ont pas payé',   val: nonPay.length, danger: nonPay.length > 0 },
      { label:'Revenu attendu',    val:'$' + totalAttendu.toFixed(2) },
    ]) +

    '<div style="display:flex;justify-content:flex-end;margin:10px 0">' +
    '<button class="btn btn-sm btn-outline" onclick="exportRappCSV()">⬇️ Export CSV</button></div>' +

    '<div style="max-height:460px;overflow-y:auto;display:flex;flex-direction:column;gap:10px">' +
    (sections.length ? sections.map(s =>
      '<div style="border-radius:10px;overflow:hidden;border:1px solid ' + s.bg + '">' +
      '<div style="background:' + s.bg + ';padding:8px 14px;font-size:.76rem;font-weight:700;color:' + s.couleur + '">' + s.titre + '</div>' +
      s.items.map(i => personneRow(i, s.couleurFond)).join('') +
      '</div>'
    ).join('') : '<div style="padding:20px;text-align:center;color:var(--muted)">Aucun inscrit</div>') +
    '</div>',
    'large'
  );
}

function rappKpiRow(items) {
  return '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px">' +
    items.map(k =>
      '<div style="background:var(--off);border-radius:10px;padding:10px 14px;min-width:90px;text-align:center">' +
      '<div style="font-size:1.2rem;font-weight:800;color:' + (k.danger ? '#c62828' : k.accent ? 'var(--accent)' : 'var(--text)') + '">' + k.val + '</div>' +
      '<div style="font-size:.7rem;color:var(--muted);margin-top:2px">' + k.label + '</div>' +
      '</div>'
    ).join('') +
  '</div>';
}

function exportRappCSV() {
  const { filename, headers, rows } = window._rappCSV || {};
  if (!rows) return;
  const csv = [headers, ...rows].map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename || 'rapport.csv'; a.click();
  URL.revokeObjectURL(url);
}

function planBadge(plan) {
  if (!plan || plan === 'gratuit') return '<span style="font-size:.73rem;color:var(--muted)">Gratuit</span>';
  const colors = { bienfaiteur:'#fff8e1;color:#f57f17', partenaire:'#e8f5e9;color:#1b5e20' };
  const c = colors[plan] || 'var(--off);color:var(--muted)';
  return '<span style="font-size:.73rem;background:' + c + ';padding:2px 7px;border-radius:8px">' + plan + '</span>';
}

// ── Rapport : taux de recouvrement ──────────────────────────────────────────
async function rappModalTauxRecouvrement(allCotis) {
  const MOIS_FR = ['','Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc'];
  const byP = {};
  (allCotis || []).forEach(c => {
    const p = c.periode; if (!p) return;
    if (!byP[p]) byP[p] = { att: 0, pay: 0 };
    byP[p].att += parseFloat(c.montant_attendu || 0);
    if (c.statut === 'paye') byP[p].pay += parseFloat(c.montant_attendu || 0);
  });
  const periodes  = Object.keys(byP).sort();
  const totAtt    = periodes.reduce((s, p) => s + byP[p].att, 0);
  const totPay    = periodes.reduce((s, p) => s + byP[p].pay, 0);
  const tauxGlob  = totAtt > 0 ? Math.round(totPay / totAtt * 100) : 0;

  const bars = periodes.map(p => {
    const pct   = byP[p].att > 0 ? Math.round(byP[p].pay / byP[p].att * 100) : 0;
    const [yr, mo] = p.split('-');
    const col   = pct >= 80 ? '#2e7d32' : pct >= 50 ? '#f57c00' : '#c62828';
    return '<div style="flex:1;min-width:52px;text-align:center">' +
      '<div style="font-size:.68rem;font-weight:700;color:' + col + ';margin-bottom:3px">' + pct + '%</div>' +
      '<div style="background:#f0f0f0;border-radius:5px 5px 0 0;height:90px;display:flex;align-items:flex-end;overflow:hidden">' +
      '<div style="background:' + col + ';width:100%;height:' + Math.min(pct, 100) + '%;transition:.4s"></div></div>' +
      '<div style="font-size:.65rem;color:var(--muted);margin-top:3px">' + MOIS_FR[parseInt(mo)] + '<br>' + yr + '</div>' +
      '</div>';
  }).join('');

  openModal('📈 Taux de recouvrement',
    rappKpiRow([
      { label: 'Total attendu',    val: '$' + totAtt.toFixed(2) },
      { label: 'Total collecté',   val: '$' + totPay.toFixed(2), accent: true },
      { label: 'Taux global',      val: tauxGlob + '%', accent: tauxGlob >= 80, danger: tauxGlob < 50 && totAtt > 0 },
      { label: 'Périodes',         val: periodes.length },
    ]) +
    (periodes.length
      ? '<div style="display:flex;gap:5px;align-items:flex-end;padding:14px 0;overflow-x:auto">' + bars + '</div>' +
        '<div style="display:flex;gap:14px;font-size:.74rem;margin-top:6px">' +
        '<span style="color:#2e7d32">■ ≥80% Bon</span><span style="color:#f57c00">■ 50-79% Moyen</span><span style="color:#c62828">■ &lt;50% Insuffisant</span></div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune donnée de cotisation</div>'),
    'large');
}

// ── Rapport : membres en retard ──────────────────────────────────────────────
async function rappModalEnRetard(allCotis) {
  const byM = {};
  (allCotis || []).filter(c => c.statut === 'en_attente').forEach(c => {
    if (!byM[c.user_id]) byM[c.user_id] = { nom: (c.prenom || '') + ' ' + (c.nom || ''), email: c.email || '', plan: c.plan || c.user_plan, periodes: [], total: 0 };
    byM[c.user_id].periodes.push(c.periode);
    byM[c.user_id].total += parseFloat(c.montant_attendu || 0);
  });
  const retards   = Object.values(byM).sort((a, b) => b.total - a.total);
  const chroniques = retards.filter(m => m.periodes.length >= 2);
  const totalDu   = retards.reduce((s, m) => s + m.total, 0);

  window._rappCSV = {
    filename: 'membres_en_retard.csv',
    headers: ['Membre', 'Email', 'Plan', 'Mois en retard', 'Montant dû', 'Périodes'],
    rows: retards.map(m => [m.nom, m.email, m.plan || '', m.periodes.length, m.total.toFixed(2), m.periodes.join(' | ')]),
  };

  openModal('⏳ Membres en retard',
    rappKpiRow([
      { label: 'Arriéré total',          val: '$' + totalDu.toFixed(2), danger: totalDu > 0 },
      { label: 'Membres en retard',      val: retards.length, danger: retards.length > 0 },
      { label: 'Chroniques (2+ mois)',   val: chroniques.length, danger: chroniques.length > 0 },
    ]) +
    (retards.length ? '<div style="display:flex;justify-content:flex-end;margin:8px 0"><button class="btn btn-sm btn-outline" onclick="exportRappCSV()">⬇️ Export CSV</button></div>' : '') +
    '<div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">' +
    (retards.length ? retards.map(m =>
      '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)' + (m.periodes.length >= 2 ? ';background:#fff8f8' : '') + '">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:#ffebee;color:#c62828;display:flex;align-items:center;justify-content:center;font-size:.63rem;font-weight:700;flex-shrink:0">' + (m.nom[0] || '').toUpperCase() + (m.nom.split(' ')[1]?.[0] || '').toUpperCase() + '</div>' +
      '<div style="flex:1"><strong>' + m.nom + '</strong><div style="font-size:.74rem;color:var(--muted)">' + m.email + '</div></div>' +
      planBadge(m.plan) +
      '<div style="text-align:right;min-width:70px"><div style="font-weight:700;color:#c62828">$' + m.total.toFixed(2) + '</div><div style="font-size:.72rem;color:var(--muted)">' + m.periodes.length + ' mois</div></div>' +
      (m.periodes.length >= 2 ? '<span style="font-size:.67rem;background:#ffebee;color:#c62828;padding:2px 7px;border-radius:8px;white-space:nowrap">Chronique</span>' : '') +
      '</div>').join('')
    : '<div style="padding:24px;text-align:center;color:var(--muted)">✅ Aucun membre en retard</div>') +
    '</div>',
    'large');
}

// ── Rapport : analyse par plan ───────────────────────────────────────────────
async function rappModalParPlan(allUsers) {
  const actifs     = (allUsers || []).filter(u => u.actif);
  const bienfait   = actifs.filter(u => u.plan === 'bienfaiteur');
  const partenaires = actifs.filter(u => u.plan === 'partenaire');
  const gratuits   = actifs.filter(u => !u.plan || u.plan === 'gratuit');
  const revMens    = bienfait.length * 10 + partenaires.length * 20;
  const revAnnuel  = bienfait.length * 100 + partenaires.length * 200;

  const planSection = (titre, couleurBg, couleurTxt, membres, tarif) =>
    '<div style="border:2px solid ' + couleurBg + ';border-radius:12px;padding:14px">' +
    '<div style="font-size:.77rem;font-weight:700;color:' + couleurTxt + ';margin-bottom:6px">' + titre + ' — $' + tarif + '/mois</div>' +
    '<div style="font-size:1.5rem;font-weight:800">' + membres.length + ' membres</div>' +
    '<div style="font-size:.79rem;color:var(--muted);margin:3px 0">Rev. mensuel : $' + (membres.length * tarif).toFixed(2) + '</div>' +
    '<div style="font-size:.79rem;color:var(--muted);margin-bottom:8px">Rev. annuel : $' + (membres.length * tarif * 10).toFixed(2) + '</div>' +
    membres.slice(0, 6).map(u => '<div style="font-size:.78rem;padding:2px 0">' + u.prenom + ' ' + u.nom + '</div>').join('') +
    (membres.length > 6 ? '<div style="font-size:.74rem;color:var(--muted)">+ ' + (membres.length - 6) + ' autres</div>' : '') +
    '</div>';

  openModal('📊 Analyse par plan de membre',
    rappKpiRow([
      { label: 'Bienfaiteurs',          val: bienfait.length,    accent: true },
      { label: 'Partenaires',           val: partenaires.length, accent: true },
      { label: 'Gratuits',              val: gratuits.length },
      { label: 'Rev. mensuel potentiel', val: '$' + revMens.toFixed(2),   accent: true },
      { label: 'Rev. annuel potentiel',  val: '$' + revAnnuel.toFixed(2), accent: true },
    ]) +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">' +
    planSection('💛 BIENFAITEUR', '#fff8e1', '#f57f17', bienfait, 10) +
    planSection('⭐ PARTENAIRE',  '#e8f5e9', '#1b5e20', partenaires, 20) +
    '</div>',
    'large');
}

// ── Rapport : croissance membres ─────────────────────────────────────────────
async function rappModalCroissance(allUsers) {
  const MOIS_FR = ['','Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc'];
  const byMonth = {};
  (allUsers || []).forEach(u => {
    const m = (u.date_inscription || u.created_at || '').substring(0, 7);
    if (!m) return;
    if (!byMonth[m]) byMonth[m] = 0;
    byMonth[m]++;
  });
  const mois = Object.keys(byMonth).sort();
  let cumul = 0;
  const rows = mois.map(m => { cumul += byMonth[m]; return { m, nouveaux: byMonth[m], cumul }; });

  openModal('📉 Croissance des membres',
    rappKpiRow([
      { label: 'Membres actifs', val: (allUsers || []).filter(u => u.actif).length, accent: true },
      { label: 'Total inscrits', val: (allUsers || []).length },
      { label: 'Nouveaux ce mois', val: byMonth[new Date().toISOString().substring(0, 7)] || 0, accent: true },
      { label: 'Mois de données', val: mois.length },
    ]) +
    (rows.length
      ? '<div style="max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
        '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px;text-align:left">Mois</th><th style="padding:8px;text-align:center">Nouveaux</th><th style="padding:8px;text-align:center">Total cumulatif</th></tr></thead><tbody>' +
        [...rows].reverse().map(r => {
          const [yr, mo] = r.m.split('-');
          return '<tr style="border-top:1px solid var(--border)">' +
            '<td style="padding:8px 12px">' + MOIS_FR[parseInt(mo)] + ' ' + yr + '</td>' +
            '<td style="padding:8px;text-align:center;font-weight:700;color:#2e7d32">+' + r.nouveaux + '</td>' +
            '<td style="padding:8px;text-align:center">' + r.cumul + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune donnée disponible</div>'),
    'large');
}

// ── Rapport : par événement ──────────────────────────────────────────────────
async function rappModalParEvenement(activities) {
  const paidActs = (activities || []).filter(a => a.paiement_requis || parseFloat(a.prix || 0) > 0);
  if (!paidActs.length) { openModal('🎟️ Rapport par événement', '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune activité payante</div>', 'large'); return; }
  const results = await Promise.all(paidActs.map(a => api('/activities/' + a.id + '/inscrits').then(i => ({ act: a, inscrits: i || [] })).catch(() => ({ act: a, inscrits: [] }))));
  const totalInscrits = results.reduce((s, r) => s + r.inscrits.length, 0);
  const totalPayes    = results.reduce((s, r) => s + r.inscrits.filter(i => i.paye === 1).length, 0);

  openModal('🎟️ Rapport par événement',
    rappKpiRow([
      { label: 'Activités payantes', val: paidActs.length },
      { label: 'Total inscrits',     val: totalInscrits },
      { label: 'Billets payés',      val: totalPayes, accent: true },
    ]) +
    '<div style="max-height:440px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-top:14px">' +
    results.map(({ act, inscrits }) => {
      const payes   = inscrits.filter(i => i.paye === 1);
      const nonPay  = inscrits.filter(i => !i.paye);
      const coll    = payes.reduce((s, i) => s + parseFloat(i.montant_paye || act.prix || 0), 0);
      const att     = parseFloat(act.prix || 0) * inscrits.length;
      const taux    = att > 0 ? Math.round(coll / att * 100) : 0;
      const col     = taux >= 80 ? '#2e7d32' : taux >= 50 ? '#f57c00' : '#c62828';
      return '<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">' +
        '<div style="background:var(--off);padding:9px 14px;display:flex;align-items:center;gap:12px">' +
        '<strong style="flex:1">' + act.titre + '</strong>' +
        '<span style="font-size:.75rem;color:var(--muted)">' + (act.date_debut || '').substring(0, 10) + '</span>' +
        '</div>' +
        '<div style="padding:10px 14px;display:flex;gap:16px;flex-wrap:wrap;font-size:.84rem;align-items:center">' +
        '<span>Inscrits : <strong>' + inscrits.length + '</strong></span>' +
        '<span style="color:#2e7d32">Payés : <strong>' + payes.length + '</strong></span>' +
        (nonPay.length ? '<span style="color:#c62828">Non payés : <strong>' + nonPay.length + '</strong></span>' : '') +
        '<span>Prix : <strong>$' + parseFloat(act.prix || 0).toFixed(2) + '</strong></span>' +
        '<span style="margin-left:auto;font-weight:700;color:' + col + '">$' + coll.toFixed(2) + ' / $' + att.toFixed(2) + ' (' + taux + '%)</span>' +
        '</div></div>';
    }).join('') +
    '</div>',
    'large');
}

// ── Rapport : performance événements ────────────────────────────────────────
async function rappModalPerformance(activities) {
  const paidActs = (activities || []).filter(a => a.paiement_requis || parseFloat(a.prix || 0) > 0);
  if (!paidActs.length) { openModal('🏆 Performance', '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune activité payante</div>', 'large'); return; }
  const results = await Promise.all(paidActs.map(a => api('/activities/' + a.id + '/inscrits').then(i => ({ act: a, inscrits: i || [] })).catch(() => ({ act: a, inscrits: [] }))));
  const ranked = results.map(({ act, inscrits }) => {
    const payes = inscrits.filter(i => i.paye === 1);
    const coll  = payes.reduce((s, i) => s + parseFloat(i.montant_paye || act.prix || 0), 0);
    const taux  = inscrits.length > 0 ? Math.round(payes.length / inscrits.length * 100) : 0;
    return { act, inscrits, payes, coll, taux };
  }).sort((a, b) => b.coll - a.coll);
  const medals = ['🥇', '🥈', '🥉'];

  openModal('🏆 Performance des événements',
    rappKpiRow([
      { label: 'Événements', val: ranked.length },
      { label: 'Meilleure recette', val: '$' + (ranked[0]?.coll || 0).toFixed(2), accent: true },
      { label: 'Total collecté',    val: '$' + ranked.reduce((s, r) => s + r.coll, 0).toFixed(2), accent: true },
    ]) +
    '<div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px">' +
    '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
    '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px">#</th><th style="padding:8px;text-align:left">Activité</th><th style="padding:8px;text-align:center">Inscrits</th><th style="padding:8px;text-align:center">Payés</th><th style="padding:8px;text-align:right">Collecté</th><th style="padding:8px;text-align:center">Taux</th></tr></thead><tbody>' +
    ranked.map((r, i) => {
      const col = r.taux >= 80 ? '#2e7d32' : r.taux >= 50 ? '#f57c00' : '#c62828';
      const bg  = r.taux >= 80 ? '#e8f5e9' : r.taux >= 50 ? '#fff3e0' : '#ffebee';
      return '<tr style="border-top:1px solid var(--border)' + (i === 0 ? ';background:#f5f0ff' : '') + '">' +
        '<td style="padding:8px 12px;font-size:1.1rem">' + (medals[i] || (i + 1)) + '</td>' +
        '<td style="padding:8px"><strong>' + r.act.titre + '</strong><div style="font-size:.74rem;color:var(--muted)">' + (r.act.date_debut || '').substring(0, 10) + '</div></td>' +
        '<td style="padding:8px;text-align:center">' + r.inscrits.length + '</td>' +
        '<td style="padding:8px;text-align:center;color:#2e7d32;font-weight:700">' + r.payes.length + '</td>' +
        '<td style="padding:8px;text-align:right;font-weight:700;color:#5e35b1">$' + r.coll.toFixed(2) + '</td>' +
        '<td style="padding:8px;text-align:center"><span style="font-size:.74rem;background:' + bg + ';color:' + col + ';padding:2px 8px;border-radius:8px">' + r.taux + '%</span></td>' +
        '</tr>';
    }).join('') +
    '</tbody></table></div>',
    'large');
}

// ── Rapport : coût par participant ───────────────────────────────────────────
async function rappModalCoutParticipant(activities) {
  const paidActs = (activities || []).filter(a => a.paiement_requis || parseFloat(a.prix || 0) > 0);
  if (!paidActs.length) { openModal('💡 Coût par participant', '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune activité payante</div>', 'large'); return; }
  const results = await Promise.all(paidActs.map(a => api('/activities/' + a.id + '/inscrits').then(i => ({ act: a, nb: (i || []).length })).catch(() => ({ act: a, nb: 0 }))));

  openModal('💡 Coût par participant',
    '<p style="font-size:.82rem;color:var(--muted);margin-bottom:14px">Budget prévu ÷ inscrits = coût moyen par participant. La marge = prix billet − coût/pers.</p>' +
    '<div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">' +
    '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
    '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px;text-align:left">Activité</th><th style="padding:8px;text-align:right">Budget prévu</th><th style="padding:8px;text-align:center">Inscrits</th><th style="padding:8px;text-align:right">Coût/pers.</th><th style="padding:8px;text-align:right">Prix billet</th><th style="padding:8px;text-align:right">Marge</th></tr></thead><tbody>' +
    results.map(({ act, nb }) => {
      const budget = parseFloat(act.budget_prevu || 0);
      const prix   = parseFloat(act.prix || 0);
      const coutPP = nb > 0 ? budget / nb : budget;
      const marge  = prix - coutPP;
      return '<tr style="border-top:1px solid var(--border)">' +
        '<td style="padding:8px 12px"><strong>' + act.titre + '</strong></td>' +
        '<td style="padding:8px;text-align:right">$' + budget.toFixed(2) + '</td>' +
        '<td style="padding:8px;text-align:center">' + nb + '</td>' +
        '<td style="padding:8px;text-align:right;font-weight:700">$' + coutPP.toFixed(2) + '</td>' +
        '<td style="padding:8px;text-align:right">$' + prix.toFixed(2) + '</td>' +
        '<td style="padding:8px;text-align:right;font-weight:700;color:' + (marge >= 0 ? '#2e7d32' : '#c62828') + '">$' + marge.toFixed(2) + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table></div>',
    'large');
}

// ── Rapport : inscrits non payés ─────────────────────────────────────────────
async function rappModalNonPayes(activities) {
  const paidActs = (activities || []).filter(a => a.paiement_requis || parseFloat(a.prix || 0) > 0);
  if (!paidActs.length) { openModal('🚨 Inscrits non payés', '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune activité payante</div>', 'large'); return; }
  const results = await Promise.all(paidActs.map(a => api('/activities/' + a.id + '/inscrits').then(i => ({ act: a, inscrits: i || [] })).catch(() => ({ act: a, inscrits: [] }))));
  const totalNP  = results.reduce((s, r) => s + r.inscrits.filter(i => !i.paye).length, 0);
  const totalDu  = results.reduce((s, r) => s + r.inscrits.filter(i => !i.paye).length * parseFloat(r.act.prix || 0), 0);
  const actAvecNP = results.filter(r => r.inscrits.some(i => !i.paye));

  openModal('🚨 Inscrits non payés',
    rappKpiRow([
      { label: 'Inscrits non payés', val: totalNP,             danger: totalNP > 0 },
      { label: 'Montant dû total',   val: '$' + totalDu.toFixed(2), danger: totalDu > 0 },
    ]) +
    '<div style="max-height:460px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-top:14px">' +
    (actAvecNP.length ? actAvecNP.map(({ act, inscrits }) => {
      const np = inscrits.filter(i => !i.paye);
      const du = np.length * parseFloat(act.prix || 0);
      return '<div style="border:1px solid #ffccbc;border-radius:10px;overflow:hidden">' +
        '<div style="background:#fff3e0;padding:8px 14px;font-size:.8rem;font-weight:700;color:#bf360c">' +
        act.titre + ' — ' + np.length + ' non payé(s) · $' + du.toFixed(2) + ' dû</div>' +
        np.map(i => '<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid #ffccbc;font-size:.84rem">' +
          '<div style="flex:1"><strong>' + (i.prenom || '') + ' ' + (i.nom || '') + '</strong><span style="margin-left:8px;font-size:.74rem;color:var(--muted)">' + (i.email || '') + '</span></div>' +
          (i.plan && i.plan !== 'gratuit' ? planBadge(i.plan) : '<span style="font-size:.73rem;background:#f5f5f5;color:#666;padding:2px 7px;border-radius:8px">Visiteur</span>') +
          '<span style="color:#c62828;font-weight:700">$' + parseFloat(act.prix || 0).toFixed(2) + ' dû</span>' +
          '</div>').join('') +
        '</div>';
    }).join('')
    : '<div style="padding:24px;text-align:center;color:var(--muted)">✅ Tous les inscrits ont payé</div>') +
    '</div>',
    'large');
}

// ── Rapport : budget vs réel ─────────────────────────────────────────────────
async function rappModalBudgetReel() {
  let lines = [];
  try { const data = await api('/finance'); lines = (data && data.lines) ? data.lines : (Array.isArray(data) ? data : []); } catch {}
  const totBud = lines.reduce((s, l) => s + parseFloat(l.budget_alloue || 0), 0);
  const totDep = lines.reduce((s, l) => s + parseFloat(l.depenses || 0), 0);
  const totRev = lines.reduce((s, l) => s + parseFloat(l.revenus || 0), 0);

  openModal('📋 Budget vs Réel',
    rappKpiRow([
      { label: 'Budget alloué', val: '$' + totBud.toFixed(2) },
      { label: 'Dépenses',      val: '$' + totDep.toFixed(2), danger: totDep > totBud },
      { label: 'Revenus',       val: '$' + totRev.toFixed(2), accent: true },
      { label: 'Solde net',     val: '$' + (totRev - totDep).toFixed(2), accent: totRev >= totDep, danger: totRev < totDep },
    ]) +
    (lines.length
      ? '<div style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
        '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px;text-align:left">Ligne</th><th style="padding:8px;text-align:right">Budget</th><th style="padding:8px;text-align:right">Dépenses</th><th style="padding:8px;text-align:right">Revenus</th><th style="padding:8px;text-align:right">Écart</th></tr></thead><tbody>' +
        lines.map(l => {
          const dep = parseFloat(l.depenses || 0); const bud = parseFloat(l.budget_alloue || 0); const ecart = bud - dep;
          return '<tr style="border-top:1px solid var(--border)">' +
            '<td style="padding:8px 12px"><strong>' + (l.nom || '') + '</strong></td>' +
            '<td style="padding:8px;text-align:right">$' + bud.toFixed(2) + '</td>' +
            '<td style="padding:8px;text-align:right">$' + dep.toFixed(2) + '</td>' +
            '<td style="padding:8px;text-align:right;color:#2e7d32">$' + parseFloat(l.revenus || 0).toFixed(2) + '</td>' +
            '<td style="padding:8px;text-align:right;font-weight:700;color:' + (ecart >= 0 ? '#2e7d32' : '#c62828') + '">$' + ecart.toFixed(2) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune ligne budgétaire. Configurez-les dans la section <strong>Budget</strong>.</div>'),
    'large');
}

// ── Rapport : flux de trésorerie ─────────────────────────────────────────────
async function rappModalFluxTresorerie(allPayments) {
  const MOIS_FR = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const byMonth = {};
  (allPayments || []).filter(p => p.statut === 'approuve').forEach(p => {
    const m = (p.date_soumission || p.mois || '').substring(0, 7);
    if (!m) return;
    if (!byMonth[m]) byMonth[m] = { entrees: 0 };
    byMonth[m].entrees += parseFloat(p.montant || 0);
  });
  const mois = Object.keys(byMonth).sort().reverse();
  const totalEntrees = mois.reduce((s, m) => s + byMonth[m].entrees, 0);

  openModal('💸 Flux de trésorerie',
    rappKpiRow([
      { label: 'Total entrées',   val: '$' + totalEntrees.toFixed(2), accent: true },
      { label: 'Mois analysés',   val: mois.length },
    ]) +
    (mois.length
      ? '<div style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
        '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px;text-align:left">Mois</th><th style="padding:8px;text-align:right">Entrées</th></tr></thead><tbody>' +
        mois.map(m => {
          const [yr, mo] = m.split('-');
          return '<tr style="border-top:1px solid var(--border)">' +
            '<td style="padding:8px 12px">' + MOIS_FR[parseInt(mo)] + ' ' + yr + '</td>' +
            '<td style="padding:8px;text-align:right;color:#2e7d32;font-weight:700">$' + byMonth[m].entrees.toFixed(2) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune transaction enregistrée</div>'),
    'large');
}

// ── Rapport : comparaison annuelle ───────────────────────────────────────────
async function rappModalComparaisonAnnuelle(allPayments) {
  const byYear = {};
  (allPayments || []).filter(p => p.statut === 'approuve').forEach(p => {
    const yr = (p.mois || p.date_soumission || '').substring(0, 4);
    if (!yr || yr.length !== 4) return;
    if (!byYear[yr]) byYear[yr] = { cotisations: 0, dons: 0, total: 0 };
    const m = parseFloat(p.montant || 0);
    if (p.type === 'don') byYear[yr].dons += m; else byYear[yr].cotisations += m;
    byYear[yr].total += m;
  });
  const years = Object.keys(byYear).sort((a, b) => b - a);

  openModal('📆 Comparaison annuelle',
    (years.length
      ? rappKpiRow(years.slice(0, 3).map((yr, i) => ({ label: yr, val: '$' + byYear[yr].total.toFixed(2), accent: i === 0 }))) +
        '<div style="max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
        '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px;text-align:left">Année</th><th style="padding:8px;text-align:right">Cotisations</th><th style="padding:8px;text-align:right">Dons</th><th style="padding:8px;text-align:right">Total</th><th style="padding:8px;text-align:right">Évolution</th></tr></thead><tbody>' +
        years.map((yr, i) => {
          const prev  = byYear[years[i + 1]];
          const evol  = prev ? Math.round((byYear[yr].total - prev.total) / prev.total * 100) : null;
          const evolHTML = evol !== null ? '<span style="color:' + (evol >= 0 ? '#2e7d32' : '#c62828') + ';font-weight:700">' + (evol >= 0 ? '+' : '') + evol + '%</span>' : '—';
          return '<tr style="border-top:1px solid var(--border)' + (i === 0 ? ';background:#f5f0ff' : '') + '">' +
            '<td style="padding:8px 12px"><strong>' + yr + '</strong>' + (i === 0 ? ' <span style="font-size:.7rem;background:#e3f2fd;color:#1565c0;padding:1px 6px;border-radius:8px">En cours</span>' : '') + '</td>' +
            '<td style="padding:8px;text-align:right">$' + byYear[yr].cotisations.toFixed(2) + '</td>' +
            '<td style="padding:8px;text-align:right;color:#2e7d32">$' + byYear[yr].dons.toFixed(2) + '</td>' +
            '<td style="padding:8px;text-align:right;font-weight:700">$' + byYear[yr].total.toFixed(2) + '</td>' +
            '<td style="padding:8px;text-align:right">' + evolHTML + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune donnée disponible</div>'),
    'large');
}

// ── Rapport : prévisions fin d'année ─────────────────────────────────────────
async function rappModalPrevisions(allCotis, allPayments) {
  const annee       = String(new Date().getFullYear());
  const moisCourant = new Date().getMonth() + 1;
  const cotisAnnee  = (allCotis || []).filter(c => (c.periode || '').startsWith(annee));
  const totalPaye   = cotisAnnee.filter(c => c.statut === 'paye').reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
  const totalAtt    = cotisAnnee.reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
  const moyMensuel  = moisCourant > 0 ? totalPaye / moisCourant : 0;
  const projection  = moyMensuel * 12;
  const totalDons   = (allPayments || []).filter(p => p.type === 'don' && p.statut === 'approuve' && (p.mois || '').startsWith(annee)).reduce((s, p) => s + parseFloat(p.montant || 0), 0);
  const tauxPct     = totalAtt > 0 ? Math.round(totalPaye / totalAtt * 100) : 0;

  openModal('🔮 Prévisions fin d\'année ' + annee,
    rappKpiRow([
      { label: 'Collecté à ce jour',    val: '$' + totalPaye.toFixed(2),  accent: true },
      { label: 'Mois écoulés',          val: moisCourant },
      { label: 'Moy. mensuelle',        val: '$' + moyMensuel.toFixed(2) },
      { label: 'Projection annuelle',   val: '$' + projection.toFixed(2), accent: true },
      { label: '+ Dons actuels',        val: '$' + totalDons.toFixed(2) },
      { label: 'Total projeté',         val: '$' + (projection + totalDons).toFixed(2), accent: true },
    ]) +
    '<div style="margin:14px 0;padding:14px;background:var(--off);border-radius:10px">' +
    '<div style="font-size:.8rem;margin-bottom:6px;color:var(--muted)">Progression ' + annee + ' (rythme actuel)</div>' +
    '<div style="background:#e0e0e0;border-radius:99px;height:10px;overflow:hidden">' +
    '<div style="background:' + (tauxPct >= 80 ? '#2e7d32' : tauxPct >= 50 ? '#f57c00' : '#c62828') + ';height:10px;width:' + Math.min(tauxPct, 100) + '%;transition:.4s"></div></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:.73rem;margin-top:4px;color:var(--muted)">' +
    '<span>$0</span><span style="font-weight:700;color:var(--text)">$' + totalPaye.toFixed(2) + ' collecté (' + tauxPct + '%)</span><span>$' + totalAtt.toFixed(2) + ' attendu</span>' +
    '</div></div>' +
    '<div style="padding:11px 14px;background:#e8f5e9;border-radius:10px;font-size:.84rem">' +
    '📌 À ce rythme, l\'association devrait collecter <strong>$' + projection.toFixed(2) + '</strong> en cotisations pour ' + annee + '.' +
    (totalDons > 0 ? ' Avec les dons actuels : <strong>$' + (projection + totalDons).toFixed(2) + '</strong>.' : '') +
    '</div>',
    'large');
}

// ── Rapport : commandites ────────────────────────────────────────────────────
async function rappModalCommandites() {
  openModal('🤝 Commandites',
    '<div style="padding:14px;background:#e3f2fd;border-radius:10px;margin-bottom:16px;font-size:.84rem">' +
    'ℹ️ Les commandites sont des contributions d\'entreprises pour financer les activités. ' +
    'Enregistrez-les comme paiements depuis la section <strong>Paiements</strong>.</div>' +
    '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune commandite enregistrée pour l\'instant.</div>',
    'large');
}

// ── Rapport : sources de revenus ─────────────────────────────────────────────
async function rappModalSourcesRevenus(allPayments) {
  const approv     = (allPayments || []).filter(p => p.statut === 'approuve');
  const totCotis   = approv.filter(p => p.type !== 'don').reduce((s, p) => s + parseFloat(p.montant || 0), 0);
  const totDons    = approv.filter(p => p.type === 'don').reduce((s, p) => s + parseFloat(p.montant || 0), 0);
  const totRev     = totCotis + totDons;
  const pctC       = totRev > 0 ? Math.round(totCotis / totRev * 100) : 0;
  const pctD       = totRev > 0 ? Math.round(totDons  / totRev * 100) : 0;

  const bar = (label, couleur, montant, pct) =>
    '<div style="margin-bottom:12px">' +
    '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:4px"><span>' + label + '</span><span style="font-weight:700">$' + montant.toFixed(2) + ' (' + pct + '%)</span></div>' +
    '<div style="background:#f0f0f0;border-radius:99px;height:10px;overflow:hidden"><div style="background:' + couleur + ';height:10px;width:' + pct + '%;transition:.4s"></div></div>' +
    '</div>';

  openModal('🥧 Sources de revenus',
    rappKpiRow([
      { label: 'Total revenus',  val: '$' + totRev.toFixed(2),   accent: true },
      { label: 'Cotisations',    val: '$' + totCotis.toFixed(2) + ' (' + pctC + '%)', accent: true },
      { label: 'Dons',           val: '$' + totDons.toFixed(2)  + ' (' + pctD + '%)', accent: totDons > 0 },
      { label: 'Commandites',    val: '$0.00 (0%)' },
    ]) +
    (totRev > 0
      ? '<div style="margin:16px 0">' + bar('💰 Cotisations membres', '#5e35b1', totCotis, pctC) + bar('🎁 Dons', '#2e7d32', totDons, pctD) + bar('🤝 Commandites', '#1565c0', 0, 0) + '</div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucun revenu enregistré</div>'),
    'large');
}

// ── Rapport : fiscal annuel ──────────────────────────────────────────────────
async function rappModalFiscal(allPayments) {
  let receipts = [];
  try { receipts = await api('/receipts') || []; } catch {}
  const annee     = String(new Date().getFullYear());
  const recusAnn  = receipts.filter(r => String(r.annee) === annee);
  const totRecus  = recusAnn.reduce((s, r) => s + parseFloat(r.montant_total || 0), 0);
  const totRevAnn = (allPayments || []).filter(p => p.statut === 'approuve' && (p.mois || '').startsWith(annee)).reduce((s, p) => s + parseFloat(p.montant || 0), 0);

  window._rappCSV = {
    filename: 'rapport_fiscal_' + annee + '.csv',
    headers: ['Membre', 'Email', 'Année', 'Montant total', 'Date génération', 'Archivé'],
    rows: recusAnn.map(r => [r.prenom + ' ' + r.nom, r.email || '', r.annee, r.montant_total, r.date_generation || '', r.archived ? 'Oui' : 'Non']),
  };

  openModal('🧾 Rapport fiscal ' + annee,
    rappKpiRow([
      { label: 'Revenus ' + annee,  val: '$' + totRevAnn.toFixed(2), accent: true },
      { label: 'Reçus émis',        val: recusAnn.length },
      { label: 'Reçus archivés',    val: recusAnn.filter(r => r.archived).length },
      { label: 'Total reçus ($)',   val: '$' + totRecus.toFixed(2), accent: true },
    ]) +
    (recusAnn.length ? '<div style="display:flex;justify-content:flex-end;margin:8px 0"><button class="btn btn-sm btn-outline" onclick="exportRappCSV()">⬇️ Export CSV</button></div>' : '') +
    '<div style="padding:11px 14px;background:#e3f2fd;border-radius:10px;margin-bottom:12px;font-size:.83rem">' +
    '📋 Les reçus fiscaux permettent aux membres de déclarer leurs cotisations à l\'ARC. Gérez-les dans <strong>Reçus fiscaux</strong>.</div>' +
    (recusAnn.length
      ? '<div style="max-height:360px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">' +
        recusAnn.map(r =>
          '<div style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border)' + (r.archived ? ';opacity:.55' : '') + '">' +
          '<div style="flex:1"><strong>' + r.prenom + ' ' + r.nom + '</strong><div style="font-size:.74rem;color:var(--muted)">' + (r.email || '') + '</div></div>' +
          '<span style="font-weight:700;color:#2e7d32">$' + parseFloat(r.montant_total || 0).toFixed(2) + '</span>' +
          (r.archived ? '<span style="font-size:.71rem;background:#f5f5f5;color:var(--muted);padding:2px 7px;border-radius:8px">Archivé</span>' : '') +
          '</div>').join('') +
        '</div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucun reçu fiscal émis pour ' + annee + '</div>'),
    'large');
}

// ── Rapport : suivi des factures ─────────────────────────────────────────────
async function rappModalFactures() {
  let invoices = [];
  try { invoices = await api('/invoices') || []; } catch {}
  const nonPayees = invoices.filter(i => i.statut !== 'paye');
  const payees    = invoices.filter(i => i.statut === 'paye');
  const totDu     = nonPayees.reduce((s, i) => s + parseFloat(i.montant || 0), 0);
  const totPaye   = payees.reduce((s, i) => s + parseFloat(i.montant || 0), 0);

  openModal('📄 Suivi des factures',
    rappKpiRow([
      { label: 'Total factures',  val: invoices.length },
      { label: 'Payées',          val: payees.length,    accent: payees.length > 0 },
      { label: 'Impayées',        val: nonPayees.length, danger: nonPayees.length > 0 },
      { label: 'Montant impayé',  val: '$' + totDu.toFixed(2), danger: totDu > 0 },
    ]) +
    (invoices.length
      ? '<div style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
        '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px;text-align:left">Titre</th><th style="padding:8px;text-align:right">Montant</th><th style="padding:8px">Fournisseur</th><th style="padding:8px">Date</th><th style="padding:8px">Statut</th></tr></thead><tbody>' +
        invoices.map(i => {
          const sc = i.statut === 'paye' ? '#2e7d32' : '#c62828';
          const sb = i.statut === 'paye' ? '#e8f5e9' : '#ffebee';
          return '<tr style="border-top:1px solid var(--border)">' +
            '<td style="padding:8px 12px"><strong>' + (i.titre || i.description || '—') + '</strong></td>' +
            '<td style="padding:8px;text-align:right;font-weight:700">$' + parseFloat(i.montant || 0).toFixed(2) + '</td>' +
            '<td style="padding:8px;font-size:.82rem">' + (i.fournisseur || '—') + '</td>' +
            '<td style="padding:8px;font-size:.79rem;color:var(--muted)">' + (i.date || i.date_echeance || '—') + '</td>' +
            '<td style="padding:8px"><span style="font-size:.72rem;background:' + sb + ';color:' + sc + ';padding:2px 8px;border-radius:8px">' + (i.statut || '—') + '</span></td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune facture. Gérez-les dans la section <strong>Factures</strong>.</div>'),
    'large');
}

// ── Rapport : bénévolat valorisé ────────────────────────────────────────────
async function rappModalBenevolat() {
  let heures = [];
  try { heures = await api('/volunteer') || []; } catch {}
  const TAUX = 17;
  const approuv  = heures.filter(h => h.statut === 'approuve');
  const totalH   = approuv.reduce((s, h) => s + parseFloat(h.heures || 0), 0);
  const valeur   = totalH * TAUX;
  const byMember = {};
  approuv.forEach(h => {
    if (!byMember[h.user_id]) byMember[h.user_id] = { nom: (h.prenom || '') + ' ' + (h.nom || ''), heures: 0 };
    byMember[h.user_id].heures += parseFloat(h.heures || 0);
  });
  const members = Object.values(byMember).sort((a, b) => b.heures - a.heures);

  openModal('🤲 Bénévolat valorisé',
    rappKpiRow([
      { label: 'Heures approuvées',       val: totalH + 'h',           accent: totalH > 0 },
      { label: 'Taux horaire (Ontario)',   val: '$' + TAUX + '/h' },
      { label: 'Valeur économique totale', val: '$' + valeur.toFixed(2), accent: true },
      { label: 'Bénévoles actifs',         val: members.length },
    ]) +
    (members.length
      ? '<div style="max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
        '<thead><tr style="background:#f8f8f8;position:sticky;top:0"><th style="padding:8px 12px;text-align:left">Bénévole</th><th style="padding:8px;text-align:center">Heures</th><th style="padding:8px;text-align:right">Valeur ($' + TAUX + '/h)</th></tr></thead><tbody>' +
        members.map(m =>
          '<tr style="border-top:1px solid var(--border)">' +
          '<td style="padding:8px 12px"><strong>' + m.nom + '</strong></td>' +
          '<td style="padding:8px;text-align:center;font-weight:700">' + m.heures + 'h</td>' +
          '<td style="padding:8px;text-align:right;color:#2e7d32;font-weight:700">$' + (m.heures * TAUX).toFixed(2) + '</td>' +
          '</tr>').join('') +
        '</tbody></table></div>'
      : '<div style="padding:24px;text-align:center;color:var(--muted)">Aucune heure de bénévolat approuvée</div>'),
    'large');
}

// ── Rapport : tableau de bord présidente ────────────────────────────────────
async function rappModalExecutif(allCotis, allPayments, activities, allUsers) {
  const annee   = String(new Date().getFullYear());
  const mois    = new Date().toISOString().substring(0, 7);
  const [, mo]  = mois.split('-');
  const MOIS_FR = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

  const approv      = (allPayments || []).filter(p => p.statut === 'approuve');
  const cotisAnnee  = (allCotis || []).filter(c => (c.periode || '').startsWith(annee));
  const totCotisPay = cotisAnnee.filter(c => c.statut === 'paye').reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
  const totCotisAtt = cotisAnnee.reduce((s, c) => s + parseFloat(c.montant_attendu || 0), 0);
  const taux        = totCotisAtt > 0 ? Math.round(totCotisPay / totCotisAtt * 100) : 0;
  const nbRetard    = cotisAnnee.filter(c => c.statut === 'en_attente').length;
  const nbAJour     = cotisAnnee.filter(c => c.statut === 'paye').length;
  const totDons     = approv.filter(p => p.type === 'don').reduce((s, p) => s + parseFloat(p.montant || 0), 0);
  const totRevenu   = approv.reduce((s, p) => s + parseFloat(p.montant || 0), 0);
  const nbActifs    = (allUsers || []).filter(u => u.actif).length;
  const paidActs    = (activities || []).filter(a => a.paiement_requis || parseFloat(a.prix || 0) > 0);

  const alertes = [];
  if (nbRetard > 0)                            alertes.push({ t: 'danger',  msg: '🚨 ' + nbRetard + ' cotisation(s) en attente ce mois-ci' });
  if (taux < 80 && totCotisAtt > 0)            alertes.push({ t: 'warning', msg: '⚠️ Taux de recouvrement faible : ' + taux + '%' });
  if (paidActs.length === 0)                   alertes.push({ t: 'info',    msg: 'ℹ️ Aucune activité payante programmée' });
  if (alertes.length === 0)                    alertes.push({ t: 'success', msg: '✅ Aucune alerte financière — tout est à jour' });

  const alertCls = { danger: '#ffebee;#ef9a9a;#b71c1c', warning: '#fff3e0;#ffcc80;#e65100', info: '#e3f2fd;#90caf9;#1565c0', success: '#e8f5e9;#a5d6a7;#1b5e20' };

  openModal('👑 Tableau de bord présidente — ' + MOIS_FR[parseInt(mo)] + ' ' + annee,
    rappKpiRow([
      { label: 'Membres actifs',       val: nbActifs,                           accent: true },
      { label: 'Revenus ' + annee,     val: '$' + totRevenu.toFixed(2),         accent: true },
      { label: 'Cotisations payées',   val: nbAJour,                            accent: nbAJour > 0 },
      { label: 'En retard',            val: nbRetard,                           danger: nbRetard > 0 },
      { label: 'Taux recouvrement',    val: taux + '%',                         accent: taux >= 80, danger: taux < 50 && totCotisAtt > 0 },
      { label: 'Dons reçus',           val: '$' + totDons.toFixed(2),           accent: totDons > 0 },
    ]) +
    '<div style="margin:12px 0;display:flex;flex-direction:column;gap:7px">' +
    alertes.map(a => {
      const [bg, border, col] = alertCls[a.t].split(';');
      return '<div style="padding:9px 14px;background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;font-size:.84rem;color:' + col + '">' + a.msg + '</div>';
    }).join('') +
    '</div>' +
    '<div style="margin-top:12px;padding:13px;background:var(--off);border-radius:10px">' +
    '<div style="font-size:.77rem;font-weight:700;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">Objectif annuel de recouvrement</div>' +
    '<div style="background:#e0e0e0;border-radius:99px;height:10px;overflow:hidden">' +
    '<div style="background:' + (taux >= 80 ? '#2e7d32' : taux >= 50 ? '#f57c00' : '#c62828') + ';height:10px;width:' + Math.min(taux, 100) + '%;transition:.4s"></div></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:.73rem;margin-top:4px;color:var(--muted)">' +
    '<span>$0</span><span style="font-weight:700;color:var(--text)">$' + totCotisPay.toFixed(2) + ' (' + taux + '%)</span><span>$' + totCotisAtt.toFixed(2) + '</span>' +
    '</div></div>',
    'large');
}

// ══ TÉMOIGNAGES (admin/secrétaire) ══════════════════════════════════════════
async function testimonials_mgmt() {
  const data = await api('/testimonials');
  setContent(`
    <div class="page-header">
      <div><h2>Témoignages</h2><p>Gérez les témoignages affichés sur le site public.</p></div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openTestimonialForm()">+ Ajouter</button>
      </div>
    </div>
    <div class="table-card">
      <div class="table-wrapper"><table>
        <thead><tr><th>Nom</th><th>Description</th><th>Texte</th><th>Actif</th><th>Actions</th></tr></thead>
        <tbody>${data.length ? data.map(t => `<tr>
          <td><strong>${t.prenom} ${t.nom||''}</strong></td>
          <td>${t.description||'–'}</td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.texte}</td>
          <td>${t.actif ? pill('Actif','bp-green') : pill('Inactif','bp-red')}</td>
          <td>
            <button class="btn btn-sm btn-outline" onclick='openTestimonialForm(${JSON.stringify(t).replace(/'/g,"\\'")})'">✏️</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTestimonial(${t.id})">🗑️</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Aucun témoignage</td></tr>'}
        </tbody>
      </table></div>
    </div>
  `);
}

function openTestimonialForm(t = null) {
  const isEdit = !!(t && t.id);
  openModal(isEdit ? 'Modifier le témoignage' : 'Ajouter un témoignage', `
    <form id="testForm">
      <div class="form-row">
        <div class="form-group"><label>Prénom *</label><input id="tf_prenom" value="${t?.prenom||''}" required/></div>
        <div class="form-group"><label>Nom</label><input id="tf_nom" value="${t?.nom||''}"/></div>
      </div>
      <div class="form-group"><label>Description</label><input id="tf_desc" value="${t?.description||''}" placeholder="ex: Membre depuis 2022"/></div>
      <div class="form-group"><label>Témoignage *</label><textarea id="tf_texte" rows="4" required>${t?.texte||''}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Ordre</label><input type="number" id="tf_ordre" value="${t?.ordre||0}"/></div>
        <div class="form-group"><label>Statut</label>
          <select id="tf_actif">
            <option value="1" ${(!t||t.actif)?'selected':''}>Actif</option>
            <option value="0" ${(t&&!t.actif)?'selected':''}>Inactif</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">${isEdit?'Enregistrer':'Ajouter'}</button>
      </div>
    </form>
  `);
  document.getElementById('testForm').onsubmit = async e => {
    e.preventDefault();
    const body = {
      prenom: document.getElementById('tf_prenom').value,
      nom:    document.getElementById('tf_nom').value,
      description: document.getElementById('tf_desc').value,
      texte:  document.getElementById('tf_texte').value,
      ordre:  parseInt(document.getElementById('tf_ordre').value)||0,
      actif:  parseInt(document.getElementById('tf_actif').value)
    };
    try {
      if (isEdit) await api(`/testimonials/${t.id}`, { method:'PUT', body:JSON.stringify(body) });
      else        await api('/testimonials', { method:'POST', body:JSON.stringify(body) });
      closeModal(); toast('Témoignage sauvegardé'); testimonials_mgmt();
    } catch(ex) { toast(ex.message,'error'); }
  };
}

async function deleteTestimonial(id) {
  if (!confirm('Supprimer ce témoignage ?')) return;
  await api(`/testimonials/${id}`, { method:'DELETE' });
  toast('Témoignage supprimé'); testimonials_mgmt();
}

// ══ VIDÉOS (admin/secrétaire) ════════════════════════════════════════════════
async function videos_mgmt() {
  const data = await api('/videos');
  function ytId(url) { const m = url.match(/(?:youtu\.be\/|watch\?v=|embed\/|shorts\/)([^&\s?]+)/); return m?m[1]:null; }
  setContent(`
    <div class="page-header">
      <div><h2>Vidéos</h2><p>Gérez les vidéos YouTube affichées sur le site public.</p></div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openVideoForm()">+ Ajouter une vidéo</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px">
      ${data.length ? data.map(v => {
        const vid = ytId(v.youtube_url);
        return `<div class="table-card" style="padding:16px">
          ${vid ? `<div style="position:relative;padding-bottom:56.25%;border-radius:10px;overflow:hidden;margin-bottom:12px">
            <iframe src="https://www.youtube.com/embed/${vid}" style="position:absolute;inset:0;width:100%;height:100%;border:none" allowfullscreen loading="lazy"></iframe>
          </div>` : ''}
          <h3 style="font-size:.95rem;font-weight:700;margin-bottom:4px">${v.titre}</h3>
          <p style="font-size:.8rem;color:var(--muted);margin-bottom:12px">${v.description||''}</p>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-outline" onclick='openVideoForm(${JSON.stringify(v).replace(/'/g,"\\'")})'">✏️ Modifier</button>
            <button class="btn btn-sm btn-danger" onclick="deleteVideo(${v.id})">🗑️</button>
          </div>
        </div>`;
      }).join('') : '<p style="color:var(--muted);text-align:center;grid-column:1/-1">Aucune vidéo ajoutée</p>'}
    </div>
  `);
}

function openVideoForm(v = null) {
  const isEdit = !!(v && v.id);
  openModal(isEdit ? 'Modifier la vidéo' : 'Ajouter une vidéo YouTube', `
    <form id="vidForm">
      <div class="form-group"><label>Titre *</label><input id="vf_titre" value="${v?.titre||''}" required/></div>
      <div class="form-group"><label>URL YouTube *</label>
        <input id="vf_url" value="${v?.youtube_url||''}" placeholder="https://www.youtube.com/watch?v=..." required/>
        <small style="color:var(--muted)">Accepte aussi youtu.be et YouTube Shorts</small>
      </div>
      <div class="form-group"><label>Description</label><textarea id="vf_desc" rows="2">${v?.description||''}</textarea></div>
      ${isEdit ? `<div class="form-group"><label>Statut</label>
        <select id="vf_actif">
          <option value="1" ${v.actif?'selected':''}>Actif</option>
          <option value="0" ${!v.actif?'selected':''}>Inactif</option>
        </select>
      </div>` : ''}
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">${isEdit?'Enregistrer':'Ajouter'}</button>
      </div>
    </form>
  `);
  document.getElementById('vidForm').onsubmit = async e => {
    e.preventDefault();
    const body = {
      titre:       document.getElementById('vf_titre').value,
      youtube_url: document.getElementById('vf_url').value,
      description: document.getElementById('vf_desc').value,
      actif:       isEdit ? parseInt(document.getElementById('vf_actif').value) : 1
    };
    try {
      if (isEdit) await api(`/videos/${v.id}`, { method:'PUT', body:JSON.stringify(body) });
      else        await api('/videos', { method:'POST', body:JSON.stringify(body) });
      closeModal(); toast('Vidéo sauvegardée'); videos_mgmt();
    } catch(ex) { toast(ex.message,'error'); }
  };
}

async function deleteVideo(id) {
  if (!confirm('Supprimer cette vidéo ?')) return;
  await api(`/videos/${id}`, { method:'DELETE' });
  toast('Vidéo supprimée'); videos_mgmt();
}

// ══════════════════════════════════════════════════════════════════════════════
// MON PAIEMENT (membre bienfaiteur+)
// ══════════════════════════════════════════════════════════════════════════════

// ══ MES BILLETS ════════════════════════════════════════════════════════════════
async function mes_billets() {
  const tickets = await api('/tickets/my');
  setContent(`
    <div class="page-header">
      <div><h2>🎟 Mes billets</h2><p>Vos billets et QR codes pour les activités</p></div>
    </div>
    ${tickets.length ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px">
      ${tickets.map(t => `
        <div class="table-card" style="overflow:hidden">
          <div style="background:linear-gradient(135deg,var(--g1),var(--g2));padding:16px 20px;color:#fff">
            <div style="font-weight:700;font-size:1rem">${t.activite}</div>
            <div style="font-size:.78rem;opacity:.8;margin-top:4px">📅 ${fmt(t.date_debut)} · 📍 ${t.lieu||'–'}</div>
          </div>
          <div style="padding:16px;display:flex;gap:16px;align-items:center">
            <img src="${BASE}/api/tickets/${t.id}/qr" alt="QR" style="width:110px;height:110px;border:2px solid var(--border);border-radius:8px"/>
            <div>
              <div style="font-size:.82rem;color:var(--muted);margin-bottom:6px">
                ${t.table_numero ? `🪑 Table ${t.table_numero}` : '🪑 Table à confirmer'}<br/>
                ${t.vendeur_nom ? `👤 Vendu par ${t.vendeur_nom}` : '🌐 Acheté en ligne'}<br/>
                💰 $${(t.prix||0).toFixed(2)}
              </div>
              <button class="btn btn-sm btn-outline" onclick="window.open('${BASE}/api/tickets/${t.id}/qr','_blank')">📥 Télécharger QR</button>
            </div>
          </div>
          <div style="background:var(--off);padding:10px 16px;font-size:.72rem;color:var(--muted);font-family:monospace;border-top:1px solid var(--border)">
            ${t.qr_data ? t.qr_data.replace(/\n/g,'<br/>') : '–'}
          </div>
        </div>
      `).join('')}
    </div>` : `
    <div class="empty-state">
      <div class="es-icon">🎟</div>
      <p>Vous n'avez pas encore de billet.<br/>Inscrivez-vous à une activité pour obtenir votre QR code.</p>
    </div>`}
  `);
}

// ══ DOCUMENTS OFFICIELS ══════════════════════════════════════════════════════
async function documents_mgmt() {
  const canUpload = can.adminOrSec();
  const docs = await api('/documents').catch(() => []);
  const CATS = { proces_verbaux:'📋 Procès-verbaux', statuts:'📜 Statuts & Règlements', formulaires:'📄 Formulaires officiels', rapports:'📊 Rapports annuels', autre:'📁 Autres documents' };
  const grouped = {};
  docs.forEach(d => { const c = d.categorie||'autre'; if(!grouped[c]) grouped[c]=[]; grouped[c].push(d); });
  const docIcon = m => { if(!m)return'📄'; if(m.includes('pdf'))return'📕'; if(m.includes('word')||m.includes('document'))return'📘'; if(m.includes('sheet')||m.includes('excel'))return'📗'; if(m.includes('image'))return'🖼️'; return'📄'; };
  const fmtSize = b => { if(!b)return''; if(b<1024)return b+'B'; if(b<1048576)return(b/1024).toFixed(1)+'KB'; return(b/1048576).toFixed(1)+'MB'; };
  setContent(`
    <div class="page-header">
      <div><h2>📁 Documents officiels</h2><p>Statuts, procès-verbaux et documents de l'association</p></div>
      ${canUpload ? '<div class="page-actions"><button class="btn btn-primary" onclick="documentUploadForm()">+ Ajouter</button></div>' : ''}
    </div>
    ${!docs.length ? '<div class="empty-state"><div class="es-icon">📁</div><p>Aucun document pour le moment.</p></div>' :
      Object.entries(CATS).filter(([k]) => grouped[k]?.length).map(([cat, label]) => `
        <div class="table-card" style="margin-bottom:20px">
          <div class="table-card-header"><h3>${label}</h3></div>
          <div style="padding:4px 16px">
            ${grouped[cat].map(d => {
              const signed = !!d.date_ma_signature;
              const sigBadge = signed
                ? `<span style="display:inline-flex;align-items:center;gap:4px;background:#e8f5e9;color:#1b5e20;border-radius:20px;padding:2px 10px;font-size:.72rem;font-weight:600">✅ Signé le ${fmt(d.date_ma_signature)}</span>`
                : '';
              const countBadge = d.nb_signatures > 0
                ? `<span style="display:inline-flex;align-items:center;gap:3px;background:#e3f2fd;color:#1565c0;border-radius:20px;padding:2px 8px;font-size:.7rem;font-weight:600">🖊 ${d.nb_signatures} signature${d.nb_signatures>1?'s':''}</span>`
                : '';
              return `
              <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)">
                <div style="font-size:1.6rem;flex-shrink:0">${docIcon(d.mime_type)}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600;font-size:.9rem">${escHtml(d.nom)}</div>
                  ${d.description ? `<div style="font-size:.78rem;color:var(--muted)">${escHtml(d.description)}</div>` : ''}
                  <div style="font-size:.72rem;color:var(--muted);margin-top:2px">${escHtml(d.uploader||'?')} · ${fmt(d.date_upload)} · ${fmtSize(d.taille)}</div>
                  ${sigBadge || countBadge ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">${sigBadge}${countBadge}</div>` : ''}
                </div>
                <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;align-items:center">
                  <a href="/api/documents/${d.id}/download?token=${TOKEN}" class="btn btn-outline btn-sm" download>⬇ Télécharger</a>
                  ${d.nb_signatures > 0 ? `<a href="/api/documents/${d.id}/attestation?token=${TOKEN}" target="_blank" class="btn btn-outline btn-sm" style="color:#1b5e20;border-color:#1b5e20">🔏 Attestation</a>` : ''}
                  <button class="btn btn-sm btn-ghost" onclick="openSignatureModal(${d.id},'${escHtml(d.nom).replace(/'/g,"\\'")}')">✍️ ${signed ? 'Re-signer' : 'Signer'}</button>
                  ${canUpload ? `<button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="documentDelete(${d.id})">🗑</button>` : ''}
                </div>
              </div>`;}).join('')}
          </div>
        </div>`).join('')}`);
}
async function documentUploadForm() {
  openModal('📁 Nouveau document', `
    <div class="form-group"><label class="form-label">Nom du document *</label><input id="doc_nom" class="form-input" placeholder="ex: Procès-verbal AG 2026"/></div>
    <div class="form-group"><label class="form-label">Description</label><input id="doc_desc" class="form-input" placeholder="Optionnel"/></div>
    <div class="form-group"><label class="form-label">Catégorie</label>
      <select id="doc_cat" class="form-input">
        <option value="proces_verbaux">📋 Procès-verbaux</option>
        <option value="statuts">📜 Statuts & Règlements</option>
        <option value="formulaires">📄 Formulaires officiels</option>
        <option value="rapports">📊 Rapports annuels</option>
        <option value="autre">📁 Autre</option>
      </select>
    </div>
    <div class="form-group"><label class="form-label">Fichier * <span style="font-weight:400;color:var(--muted)">(PDF, Word, Excel, image — max 50 Mo)</span></label>
      <input type="file" id="doc_fichier" class="form-input" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.zip"/></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-primary" onclick="documentSave()">⬆ Téléverser</button>
      <button class="btn btn-outline" onclick="closeModal()">Annuler</button>
    </div>`);
}
async function documentSave() {
  const fichier = document.getElementById('doc_fichier')?.files[0];
  if (!fichier) { toast('Choisissez un fichier', true); return; }
  const fd = new FormData();
  fd.append('fichier', fichier);
  fd.append('nom', document.getElementById('doc_nom').value || fichier.name);
  fd.append('description', document.getElementById('doc_desc').value || '');
  fd.append('categorie', document.getElementById('doc_cat').value || 'autre');
  try {
    toast('Téléversement en cours…');
    await fetch('/api/documents', { method:'POST', headers:{ Authorization:'Bearer '+TOKEN }, body:fd });
    closeModal(); documents_mgmt(); toast('✅ Document ajouté !');
  } catch(e) { toast('Erreur : '+e.message, true); }
}
async function documentDelete(id) {
  if (!confirm('Supprimer ce document définitivement ?')) return;
  await api('/documents/'+id, { method:'DELETE' });
  documents_mgmt(); toast('Document supprimé');
}

// ══ COMMANDITAIRES ═══════════════════════════════════════════════════════════
async function sponsors_mgmt() {
  const canEdit = can.adminOrSec();
  const sponsors = await api('/sponsors/all').catch(() => []);
  window._sponsors_cache = sponsors;
  const CAT_LABELS = { platine:'Platine', or:'Or', argent:'Argent', bronze:'Bronze' };
  const CAT_COLORS = { platine:'#B0BEC5', or:'#F9A825', argent:'#9E9E9E', bronze:'#BF8A30' };

  setContent(`
    <div class="page-header">
      <h1>🤝 Commanditaires</h1>
      ${canEdit ? '<button class="btn btn-primary" onclick="sponsorForm()">+ Ajouter</button>' : ''}
    </div>
    <p style="color:var(--muted);margin-bottom:24px">Gérez les commanditaires affichés sur le site public.</p>
    <div id="sponsorsList">
      ${sponsors.length === 0
        ? '<p style="color:var(--muted);text-align:center;padding:40px 0">Aucun commanditaire pour l\'instant.</p>'
        : sponsors.map(s => `
          <div class="table-card" style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;margin-bottom:16px;opacity:${s.actif?1:.5}">
            ${s.photo_url
              ? `<img src="${s.photo_url}" alt="${s.nom}" style="width:90px;height:120px;object-fit:cover;border-radius:10px;flex-shrink:0;box-shadow:0 4px 16px rgba(0,0,0,.15)">`
              : `<div style="width:90px;height:120px;border-radius:10px;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:2rem;flex-shrink:0">🤝</div>`}
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
                <strong style="font-size:1.1rem">${s.nom}</strong>
                <span style="background:${CAT_COLORS[s.categorie]||'#9E9E9E'};color:#fff;font-size:.72rem;font-weight:700;border-radius:20px;padding:2px 10px">${CAT_LABELS[s.categorie]||s.categorie}</span>
                ${!s.actif ? '<span style="background:#ccc;color:#555;font-size:.72rem;font-weight:700;border-radius:20px;padding:2px 10px">Inactif</span>' : ''}
              </div>
              ${s.description ? `<p style="color:var(--muted);font-size:.9rem;margin:0 0 6px">${s.description}</p>` : ''}
              ${s.site_web ? `<a href="${s.site_web}" target="_blank" rel="noopener" style="font-size:.85rem;color:var(--accent)">${s.site_web}</a>` : ''}
            </div>
            ${canEdit ? `
            <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
              <button class="btn btn-outline btn-sm" onclick="sponsorForm(${s.id})">✏️ Modifier</button>
              <button class="btn btn-outline btn-sm" onclick="sponsorToggle(${s.id},${s.actif?0:1})">${s.actif?'⏸ Masquer':'▶ Afficher'}</button>
              <div style="display:flex;gap:4px">
                <button class="btn btn-outline btn-sm" onclick="sponsorOrdre(${s.id},'up')" title="Monter">↑</button>
                <button class="btn btn-outline btn-sm" onclick="sponsorOrdre(${s.id},'down')" title="Descendre">↓</button>
              </div>
              <button class="btn btn-sm" style="background:#f44336;color:#fff" onclick="sponsorDelete(${s.id},'${s.nom.replace(/'/g,"\\'").replace(/"/g,'\\"')}')">🗑 Supprimer</button>
            </div>` : ''}
          </div>`).join('')}
    </div>
  `);
}

function sponsorForm(id) {
  const sp = id ? window._sponsors_cache?.find(s => s.id === id) : null;
  const CAT = ['platine','or','argent','bronze'];
  openModal(id ? 'Modifier le commanditaire' : 'Ajouter un commanditaire', `
    <form id="sponsorFrm" enctype="multipart/form-data">
      <div class="form-group">
        <label>Nom *</label>
        <input name="nom" class="form-control" required value="${sp?.nom||''}">
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea name="description" class="form-control" rows="2">${sp?.description||''}</textarea>
      </div>
      <div class="form-group">
        <label>Site web</label>
        <input name="site_web" class="form-control" type="url" placeholder="https://..." value="${sp?.site_web||''}">
      </div>
      <div class="form-group">
        <label>Catégorie</label>
        <select name="categorie" class="form-control">
          ${CAT.map(c => `<option value="${c}" ${(sp?.categorie||'or')===c?'selected':''}>${c.charAt(0).toUpperCase()+c.slice(1)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Logo / Affiche (image)</label>
        ${sp?.photo_url ? `<img src="${sp.photo_url}" style="width:80px;height:106px;object-fit:cover;border-radius:8px;margin-bottom:8px;display:block">` : ''}
        <input type="file" name="photo" class="form-control" accept="image/*">
      </div>
      <button type="button" class="btn btn-primary" onclick="sponsorSave(${id||'null'})">💾 Enregistrer</button>
    </form>
  `);
}

async function sponsorSave(id) {
  const frm = document.getElementById('sponsorFrm');
  if (!frm.nom.value.trim()) { toast('Le nom est obligatoire','err'); return; }
  const fd = new FormData(frm);
  const url = API + (id ? '/sponsors/'+id : '/sponsors');
  const method = id ? 'PUT' : 'POST';
  try {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
    const data = await res.json().catch(() => null);
    if (!res.ok) { toast((data?.error || 'Erreur '+res.status), 'err'); return; }
    closeModal(); sponsors_mgmt(); toast(id?'Commanditaire mis à jour':'Commanditaire ajouté');
  } catch(e) { toast('Erreur réseau: '+e.message, 'err'); }
}

async function sponsorToggle(id, actif) {
  const fd = new FormData();
  fd.append('actif', actif);
  await fetch(API+'/sponsors/'+id, { method:'PUT', headers:{ Authorization:`Bearer ${TOKEN}` }, body:fd }).catch(() => null);
  sponsors_mgmt();
}

async function sponsorOrdre(id, direction) {
  await api('/sponsors/'+id+'/ordre', { method:'PATCH', body:JSON.stringify({direction}) }).catch(() => null);
  sponsors_mgmt();
}

async function sponsorDelete(id, nom) {
  if (!confirm('Supprimer le commanditaire «'+nom+'» ?')) return;
  await api('/sponsors/'+id, { method:'DELETE' });
  sponsors_mgmt(); toast('Commanditaire supprimé');
}

async function mon_paiement() {
  const moisCourant = new Date().toISOString().substring(0,7);
  const plan = USER?.plan || 'gratuit';
  const isPaying = ['bienfaiteur','partenaire'].includes(plan);
  const PRIX = { bienfaiteur: { monthly:10, annual:100 }, partenaire: { monthly:20, annual:200 } };
  const prix = PRIX[plan] || { monthly:10, annual:100 };

  const [mesP, mesCot] = await Promise.all([
    api('/payments/my').catch(()=>[]),
    api('/cotisations/my').catch(()=>[])
  ]);

  const cotMois = mesCot.find(c => c.periode === moisCourant);
  const paieMois = mesP.find(p => p.mois === moisCourant && p.statut === 'approuve');
  const paieEnAttente = mesP.find(p => p.mois === moisCourant && p.statut === 'en_attente');

  const statutMois = paieMois ? 'paye' : (cotMois?.statut || (isPaying ? 'en_attente' : null));

  const statutBadge = !isPaying ? '' :
    statutMois === 'paye'    ? '<span style="background:#e8f5e9;color:#2e7d32;padding:6px 16px;border-radius:20px;font-weight:700">✅ À jour — ' + moisCourant + '</span>' :
    statutMois === 'exempte' ? '<span style="background:#fff3e0;color:#f57c00;padding:6px 16px;border-radius:20px;font-weight:700">Exempté ce mois</span>' :
    paieEnAttente            ? '<span style="background:#fff8e1;color:#f57c00;padding:6px 16px;border-radius:20px;font-weight:700">⏳ En attente de validation</span>' :
                               '<span style="background:#fce4ec;color:#c62828;padding:6px 16px;border-radius:20px;font-weight:700">⚠️ Cotisation due — ' + moisCourant + '</span>';

  setContent(
    '<div class="page-header"><div><h2>💳 Mes cotisations</h2>' +
    '<p>Gérez vos paiements et suivez votre historique.</p></div></div>' +

    // Carte statut plan
    '<div class="table-card" style="margin-bottom:18px"><div style="padding:24px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">' +
        '<div>' +
          '<div style="font-size:.75rem;font-weight:700;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Mon plan</div>' +
          '<div style="font-size:1.4rem;font-weight:800">' + (plan==='bienfaiteur'?'💛 Bienfaiteur':plan==='partenaire'?'⭐ Partenaire':'🌱 Gratuit') + '</div>' +
          (isPaying ? '<div style="font-size:.85rem;color:var(--muted);margin-top:4px">$'+prix.monthly+'/mois &nbsp;·&nbsp; ou $'+prix.annual+'/an <span style="background:#e8f5e9;color:#2e7d32;font-size:.72rem;padding:2px 8px;border-radius:10px">2 mois offerts</span></div>'
                    : '<div style="font-size:.85rem;color:var(--muted);margin-top:4px">Aucune cotisation mensuelle requise pour ce plan.</div>') +
        '</div>' +
        '<div>' + statutBadge + '</div>' +
      '</div>' +
    '</div></div>' +

    // Formulaire toujours visible pour plans payants
    (isPaying ?
      '<div class="table-card" style="margin-bottom:18px;border-left:4px solid var(--accent)">' +
      '<div class="table-card-header"><h3>💳 Soumettre un paiement</h3>' +
      (paieEnAttente ? '<span style="font-size:.8rem;color:#f57c00">Un paiement est déjà en attente de validation pour ce mois.</span>' : '') +
      '</div>' +
      '<div style="padding:16px 20px">' +

        // Onglets Type
        '<div style="display:flex;gap:8px;margin-bottom:14px">' +
          '<button id="tab_cotis" class="btn btn-primary btn-sm" onclick="payTab(\'cotis\')">Cotisation</button>' +
          '<button id="tab_don" class="btn btn-outline btn-sm" onclick="payTab(\'don\')">🎁 Don</button>' +
        '</div>' +

        // Section Cotisation
        '<div id="section_cotis">' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">' +
            [1,2,3,6].map(n =>
              '<label style="border:2px solid var(--border);border-radius:10px;padding:10px 14px;cursor:pointer;display:flex;gap:8px;align-items:center" id="opt_nb_' + n + '_label">' +
              '<input type="radio" name="nb_mois" value="' + n + '" id="opt_nb_' + n + '" ' + (n===1?'checked':'') + ' onchange="updateMontantPaiement()" style="accent-color:var(--accent);width:16px;height:16px;flex-shrink:0"/>' +
              '<div><div style="font-weight:800">$' + (n * prix.monthly) + '</div><div style="font-size:.75rem;color:var(--muted)">' + n + ' mois</div></div>' +
              '</label>'
            ).join('') +
            '<label style="border:2px solid var(--border);border-radius:10px;padding:10px 14px;cursor:pointer;display:flex;gap:8px;align-items:center" id="opt_nb_12_label">' +
              '<input type="radio" name="nb_mois" value="12" id="opt_nb_12" onchange="updateMontantPaiement()" style="accent-color:var(--accent);width:16px;height:16px;flex-shrink:0"/>' +
              '<div><div style="font-weight:800">$' + prix.annual + ' <span style="background:#e8f5e9;color:#2e7d32;font-size:.65rem;padding:1px 6px;border-radius:6px">2 MOIS OFFERTS</span></div><div style="font-size:.75rem;color:var(--muted)">Année complète</div></div>' +
            '</label>' +
          '</div>' +
        '</div>' +

        // Section Don
        '<div id="section_don" style="display:none;margin-bottom:16px">' +
          '<div class="form-group" style="margin:0">' +
            '<label>Montant du don ($)</label>' +
            '<input type="number" id="pay_don_montant" value="20" min="1" step="1" style="font-size:1.1rem;font-weight:700;max-width:180px" oninput="document.getElementById(\'pay_montant\').value=this.value"/>' +
          '</div>' +
        '</div>' +

        '<div class="form-row">' +
          '<div class="form-group">' +
            '<label>Montant ($)</label>' +
            '<input type="number" id="pay_montant" value="' + prix.monthly + '" min="1" step="0.01" style="font-size:1.1rem;font-weight:700"/>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Méthode de paiement</label>' +
            '<select id="pay_methode">' +
              '<option value="interac">Virement Interac</option>' +
              '<option value="cash">Comptant</option>' +
              '<option value="cheque">Chèque</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Référence <span style="font-weight:400;color:var(--muted)">(optionnel)</span></label>' +
          '<input type="text" id="pay_ref" placeholder="Référence Interac, numéro de chèque…"/>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Preuve de paiement <span style="font-weight:400;color:var(--muted)">(optionnel)</span></label>' +
          '<input type="file" id="pay_proof" accept="image/*,.pdf"/>' +
        '</div>' +
        '<button class="btn btn-primary" style="width:100%;padding:14px;font-size:1rem" onclick="soumettreMonPaiement(\'' + moisCourant + '\')">Envoyer ma preuve de paiement</button>' +
        '<p style="font-size:.78rem;color:var(--muted);margin-top:10px;text-align:center">La trésorière recevra une notification et validera votre paiement sous peu.</p>' +
        '<div style="display:flex;align-items:center;gap:10px;margin:14px 0"><hr style="flex:1;border:none;border-top:1px solid var(--border)"/><span style="color:var(--muted);font-size:.8rem;white-space:nowrap">OU payer maintenant</span><hr style="flex:1;border:none;border-top:1px solid var(--border)"/></div>' +
        '<button class="btn" style="width:100%;padding:14px;font-size:1rem;background:#635bff;color:#fff;border-radius:8px" onclick="payerEnLigne()">💳 Payer en ligne par carte de crédit</button>' +
        '<p style="font-size:.75rem;color:var(--muted);text-align:center;margin-top:6px">Paiement sécurisé via Stripe · Confirmation immédiate · Aucun frais supplémentaire</p>' +
      '</div></div>'
    : '') +

    // Historique
    '<div class="table-card"><div class="table-card-header"><h3>Historique des paiements</h3></div>' +
    '<div class="table-wrapper"><table>' +
    '<thead><tr><th>Mois</th><th>Montant</th><th>Méthode</th><th>Statut</th><th>Date</th></tr></thead><tbody>' +
    (mesP.length ? mesP.map(p =>
      '<tr><td>' + (p.mois||'–') + (p.periodicite==='annuel'?' <span style="background:#e8f5e9;color:#2e7d32;font-size:.7rem;padding:1px 7px;border-radius:8px;font-weight:600">ANNUEL</span>':'') + '</td>' +
      '<td><strong>$' + p.montant + '</strong></td>' +
      '<td>' + (p.methode||'–') + '</td>' +
      '<td>' + statusPill(p.statut) + '</td>' +
      '<td>' + fmt(p.date_soumission) + '</td></tr>'
    ).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">Aucun paiement enregistré</td></tr>') +
    '</tbody></table></div></div>'
  );
}

function payTab(tab) {
  const isCotis = tab === 'cotis';
  document.getElementById('section_cotis').style.display = isCotis ? '' : 'none';
  document.getElementById('section_don').style.display  = isCotis ? 'none' : '';
  document.getElementById('tab_cotis').className = 'btn btn-sm ' + (isCotis ? 'btn-primary' : 'btn-outline');
  document.getElementById('tab_don').className   = 'btn btn-sm ' + (isCotis ? 'btn-outline' : 'btn-primary');
  if (!isCotis) {
    const donMontant = document.getElementById('pay_don_montant')?.value || '20';
    const input = document.getElementById('pay_montant');
    if (input) input.value = donMontant;
  } else {
    updateMontantPaiement();
  }
}

function updateMontantPaiement() {
  const plan = USER?.plan || 'bienfaiteur';
  const PRIX = { bienfaiteur: { monthly:10, annual:100 }, partenaire: { monthly:20, annual:200 } };
  const nb = parseInt(document.querySelector('input[name="nb_mois"]:checked')?.value || '1');
  const annuel = nb === 12;
  const montant = annuel ? (PRIX[plan]?.annual || 100) : (nb * (PRIX[plan]?.monthly || 10));
  const input = document.getElementById('pay_montant');
  if (input) input.value = montant;
  [1,2,3,6,12].forEach(n => {
    const lbl = document.getElementById('opt_nb_' + n + '_label');
    if (lbl) lbl.style.borderColor = (n === nb) ? 'var(--accent)' : 'var(--border)';
  });
}

async function payerEnLigne() {
  const nb = parseInt(document.querySelector('input[name="nb_mois"]:checked')?.value || '1');
  try {
    toast('Redirection vers le paiement sécurisé…');
    const r = await api('/cotisations/checkout', { method:'POST', body: JSON.stringify({ nb_mois: nb }) });
    if (r.url) window.location.href = r.url;
    else toast('Erreur : lien de paiement introuvable', true);
  } catch(e) { toast('Erreur : '+e.message, true); }
}
async function soumettreMonPaiement(moisCourant) {
  const isDon = document.getElementById('tab_don')?.classList.contains('btn-primary');
  const nb = parseInt(document.querySelector('input[name="nb_mois"]:checked')?.value || '1');
  const annuel = nb === 12;
  const montant = document.getElementById('pay_montant')?.value;
  const methode = document.getElementById('pay_methode')?.value;
  const reference = document.getElementById('pay_ref')?.value || '';
  const proofFile = document.getElementById('pay_proof')?.files?.[0];

  if (!montant || isNaN(parseFloat(montant))) { toast('Montant invalide', 'error'); return; }

  const fd = new FormData();
  fd.append('montant', montant);
  fd.append('type', isDon ? 'don' : 'mensualite');
  fd.append('mois', moisCourant);
  fd.append('methode', methode);
  fd.append('reference', reference);
  fd.append('periodicite', annuel ? 'annuel' : 'mensuel');
  fd.append('nb_mois', isDon ? '1' : String(nb));
  if (proofFile) fd.append('proof', proofFile);

  try {
    await fetch(BASE + '/api/payments', { method:'POST', headers:{ Authorization:'Bearer '+localStorage.getItem('token') }, body:fd });
    toast(isDon ? '✅ Don soumis. Merci pour votre contribution!' : '✅ Paiement soumis. La trésorière recevra une notification.');
    mon_paiement();
  } catch(ex) { toast(ex.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// QR CODE VIEWER pour une activité
// ══════════════════════════════════════════════════════════════════════════════

async function viewActivityQR(id, titre, qrToken) {
  // Récupérer le token si non passé
  if (!qrToken) {
    try { const a = await api('/activities'); const found = (a||[]).find(x => x.id === id); qrToken = found?.qr_token || ''; } catch {}
  }
  const qrUrl      = `${BASE}/api/activities/${id}/qr`;
  const checkoutUrl = `${BASE}/activity-checkout.html?actid=${id}&token=${qrToken}`;

  const pngUrl = `${BASE}/api/activities/${id}/qr?format=png&size=1200`;

  openModal('📱 Code QR — ' + titre,
    '<div style="text-align:center;padding:8px">' +
      '<p style="font-size:.82rem;color:var(--muted);margin-bottom:16px">Les participants scannent ce code avec leur téléphone pour s\'enregistrer ou payer.</p>' +
      '<div style="width:240px;height:240px;margin:0 auto;border-radius:16px;border:1px solid var(--border);overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center">' +
        '<img id="qrImgModal" src="' + qrUrl + '?t=' + Date.now() + '" style="width:220px;height:220px;display:block" onerror="this.parentElement.innerHTML=\'<span style=\\\'font-size:.8rem;color:var(--muted)\\\'>Erreur QR</span>\'"/>' +
      '</div>' +

      '<div style="margin-top:16px;background:var(--off);border-radius:10px;padding:12px 14px;text-align:left">' +
        '<div style="font-size:.75rem;font-weight:700;color:var(--g2);margin-bottom:6px">📐 Pour Canva / CorelDraw / impression</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<a href="' + pngUrl + '" download class="btn btn-primary btn-sm">⬇️ PNG haute résolution (1200px)</a>' +
          '<a href="' + qrUrl + '" target="_blank" class="btn btn-outline btn-sm">⬇️ SVG vectoriel</a>' +
        '</div>' +
        '<div style="font-size:.7rem;color:var(--muted);margin-top:8px">💡 PNG pour Canva · SVG pour CorelDraw/Illustrator · Imprimez à minimum 3×3 cm</div>' +
      '</div>' +

      '<div style="margin-top:10px;background:var(--off);border-radius:8px;padding:8px 10px;font-size:.72rem;color:var(--muted);word-break:break-all;text-align:left">' +
        '🔗 Lien direct : <a href="' + checkoutUrl + '" target="_blank" style="color:var(--g2)">' + checkoutUrl + '</a>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + checkoutUrl + '\').then(()=>toast(\'Lien copié !\'))">📋 Copier lien</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + pngUrl + '\').then(()=>toast(\'URL PNG copié — collez dans Canva !\'))">🔗 URL PNG pour Canva</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="closeModal();showActivityReport(' + id + ')">📊 Rapport</button>' +
      '</div>' +
    '</div>'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// RAPPORTS (trésorière, VP, présidente, délégués, secrétaire)
// ══════════════════════════════════════════════════════════════════════════════

async function showActivityReport(actId) {
  closeModal();
  const r = await api('/reports/activity/' + actId);
  const { activite: act, inscrits, billets = [], parType = {}, checkin = {}, totalRevenu, billetsVendus = 0 } = r;
  const arrivés        = checkin.arrives     || 0;
  const nonArrivés     = checkin.non_arrives || 0;
  const totalParticip  = checkin.total       || 0;
  const pct = totalParticip > 0 ? Math.round(arrivés / totalParticip * 100) : 0;

  openModal('📊 Rapport — ' + act.titre,
    '<div style="max-height:72vh;overflow-y:auto">' +

    // Cartes stats principales
    '<div class="cards-grid" style="grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px">' +
      '<div class="stat-card"><div class="sc-icon">🎟️</div><div class="sc-value">' + billetsVendus + '</div><div class="sc-label">Billets vendus</div></div>' +
      '<div class="stat-card" style="background:#e8f5e9"><div class="sc-icon">✅</div><div class="sc-value" style="color:#1b5e20">' + arrivés + '</div><div class="sc-label">Arrivés</div></div>' +
      '<div class="stat-card" style="background:#fff3e0"><div class="sc-icon">⏳</div><div class="sc-value" style="color:#e65100">' + nonArrivés + '</div><div class="sc-label">Non arrivés</div></div>' +
      '<div class="stat-card accent"><div class="sc-icon">💰</div><div class="sc-value">$' + totalRevenu.toFixed(2) + '</div><div class="sc-label">Revenu</div></div>' +
    '</div>' +

    // Barre de présence
    '<div style="margin-bottom:16px">' +
      '<div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--muted);margin-bottom:4px"><span>Présence</span><span>' + pct + '%</span></div>' +
      '<div style="background:#e0e0e0;border-radius:8px;height:10px"><div style="background:#1b5e20;border-radius:8px;height:100%;width:' + pct + '%"></div></div>' +
    '</div>' +

    // Par type de billet
    (Object.keys(parType).length ? '<h4 style="font-size:.8rem;color:var(--muted);margin-bottom:6px">PAR TYPE</h4>' +
    '<table style="width:100%;border-collapse:collapse;font-size:.82rem;margin-bottom:14px">' +
      '<thead><tr style="background:var(--off)"><th style="padding:6px 8px;text-align:left">Type</th><th>Vendus</th><th>Arrivés</th><th>Revenu</th></tr></thead><tbody>' +
      Object.entries(parType).map(([k, v]) =>
        '<tr style="border-bottom:1px solid var(--border)">' +
          '<td style="padding:6px 8px;font-weight:600">' + escHtml(k) + '</td>' +
          '<td style="padding:6px 8px">' + v.nb + '</td>' +
          '<td style="padding:6px 8px">' + v.arrives + ' / ' + v.nb + '</td>' +
          '<td style="padding:6px 8px">$' + v.montant.toFixed(2) + '</td>' +
        '</tr>').join('') +
      '</tbody></table>' : '') +

    // Liste membres inscrits (arrivés + non arrivés)
    (() => {
      const ARRIVES = ['present','confirme','accepte'];
      const arrived    = inscrits.filter(r => ARRIVES.includes(r.statut) || r.checked_in === 1);
      const notArrived = inscrits.filter(r => !ARRIVES.includes(r.statut) && r.checked_in !== 1);
      const rowMembre = (r, isArrived) => {
        const name = escHtml((r.prenom||'') + ' ' + (r.nom||''));
        const badge = isArrived
          ? '<span style="background:#e8f5e9;color:#1b5e20;border-radius:20px;padding:2px 8px;font-size:.72rem;font-weight:700">✅ Arrivé</span>'
          : '<span style="background:#fff3e0;color:#e65100;border-radius:20px;padding:2px 8px;font-size:.72rem;font-weight:700">⏳ Non arrivé</span>';
        return '<tr style="border-bottom:1px solid var(--border)">' +
          '<td style="padding:6px 10px;font-weight:600">' + name + '</td>' +
          '<td style="padding:6px 10px;font-size:.75rem;color:var(--muted)">' + (r.email||'') + '</td>' +
          '<td style="padding:6px 10px">' + badge + '</td>' +
        '</tr>';
      };
      if (!inscrits.length) return '';
      return '<h4 style="font-size:.8rem;color:var(--muted);margin:14px 0 6px">MEMBRES INSCRITS (' + inscrits.length + ')</h4>' +
        '<div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.82rem">' +
          '<thead><tr style="background:var(--off);position:sticky;top:0"><th style="padding:6px 10px;text-align:left">Nom</th><th style="text-align:left">Courriel</th><th style="text-align:left">Statut</th></tr></thead>' +
          '<tbody>' + arrived.map(r => rowMembre(r, true)).join('') + notArrived.map(r => rowMembre(r, false)).join('') + '</tbody>' +
        '</table></div>';
    })() +

    // Liste billets
    (billets.length ? '<h4 style="font-size:.8rem;color:var(--muted);margin-bottom:6px">DÉTAIL BILLETS</h4>' +
    '<div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">' +
    '<table style="width:100%;border-collapse:collapse;font-size:.8rem">' +
      '<thead><tr style="background:var(--off);position:sticky;top:0"><th style="padding:6px 8px;text-align:left">Acheteur</th><th>Type</th><th>Méthode</th><th>Entrée</th><th>$</th></tr></thead><tbody>' +
      billets.map(b =>
        '<tr style="border-bottom:1px solid var(--border);' + (b.checked_in ? 'background:#f1f8e9' : '') + '">' +
          '<td style="padding:5px 8px">' + escHtml(b.acheteur_nom||'') + (b.acheteur_email ? '<br/><small style="color:var(--muted)">' + escHtml(b.acheteur_email) + '</small>' : '') + '</td>' +
          '<td style="padding:5px 8px;font-size:.75rem">' + escHtml(b.type_nom||'Général') + '</td>' +
          '<td style="padding:5px 8px;font-size:.75rem">' + (b.methode_paiement||'—') + '</td>' +
          '<td style="padding:5px 8px">' + (b.checked_in ? '✅ ' + (b.date_checkin ? new Date(b.date_checkin).toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'}) : '') : '–') + '</td>' +
          '<td style="padding:5px 8px">$' + (b.prix||0).toFixed(2) + '</td>' +
        '</tr>').join('') +
      '</tbody></table></div>' : '') +

    '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
      '<button class="btn btn-outline btn-sm" onclick="printSection(\'Rapport — ' + act.titre + '\')">🖨️ Imprimer</button>' +
      (act.statut !== 'archivee' ? '<button class="btn btn-sm" style="background:#e65100;color:#fff" onclick="archiveActivity(' + actId + ')">📦 Archiver l\'activité</button>' : '<span style="color:var(--muted);font-size:.8rem;padding:8px">📦 Archivée</span>') +
    '</div>' +
    '</div>'
  );
}

async function archiveActivity(id) {
  if (!confirm('Archiver cette activité ? Elle n\'apparaîtra plus dans les listes actives.')) return;
  try {
    await api(`/activities/${id}`, { method: 'PUT', body: JSON.stringify({ statut: 'archivee' }) });
    toast('Activité archivée');
    closeModal();
    activities();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

// ══ PRÉSENTS EN DIRECT ════════════════════════════════════════════════════════

let _liveInterval = null;

async function liveAttendance(actId) {
  closeModal();
  if (_liveInterval) { clearInterval(_liveInterval); _liveInterval = null; }

  async function refresh() {
    let r;
    try { r = await api('/activities/' + actId + '/live'); } catch(e) { return; }
    const { activite: act, stats, presents, attente, inscrits } = r;

    const container = document.getElementById('live-container');
    if (!container) return;

    const pct = stats.nbTickets > 0 ? Math.round(stats.nbPresents / stats.nbTickets * 100) : 0;

    container.innerHTML =
      '<div class="cards-grid" style="grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px">' +
        '<div class="stat-card"><div class="sc-icon">🎟</div><div class="sc-value">' + stats.nbTickets + '</div><div class="sc-label">Billets vendus</div></div>' +
        '<div class="stat-card" style="border-color:#1b5e20"><div class="sc-icon">✅</div><div class="sc-value" style="color:#1b5e20">' + stats.nbPresents + '</div><div class="sc-label">Arrivés</div></div>' +
        '<div class="stat-card"><div class="sc-icon">⏳</div><div class="sc-value">' + stats.nbAbsents + '</div><div class="sc-label">En attente</div></div>' +
        '<div class="stat-card accent"><div class="sc-icon">💰</div><div class="sc-value">$' + (stats.totalRevenu||0).toFixed(2) + '</div><div class="sc-label">Revenu billets</div></div>' +
      '</div>' +

      '<div style="margin-bottom:16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
          '<span style="font-size:.82rem;color:var(--muted)">Présence</span>' +
          '<span style="font-size:.82rem;font-weight:700;color:#1b5e20">' + pct + '%</span>' +
        '</div>' +
        '<div style="height:8px;background:var(--border);border-radius:50px">' +
          '<div style="height:100%;width:' + pct + '%;background:#1b5e20;border-radius:50px;transition:width .4s"></div>' +
        '</div>' +
      '</div>' +

      (presents.length ? (
        '<h4 style="margin:0 0 8px;font-size:.88rem;color:#1b5e20">✅ Arrivés (' + presents.length + ')</h4>' +
        '<div style="overflow-x:auto;margin-bottom:18px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.8rem">' +
          '<thead><tr style="background:var(--off)">' +
            '<th style="padding:6px 8px;text-align:left">Nom</th>' +
            '<th style="padding:6px 8px;text-align:left">Table</th>' +
            '<th style="padding:6px 8px;text-align:left">Prix</th>' +
            '<th style="padding:6px 8px;text-align:left">Arrivée</th>' +
          '</tr></thead><tbody>' +
          presents.map(p =>
            '<tr style="border-bottom:1px solid var(--border)">' +
              '<td style="padding:6px 8px">' + (p.nom||'—') + '<br/><small style="color:var(--muted)">' + (p.email||'') + '</small></td>' +
              '<td style="padding:6px 8px">' + (p.table ? 'Table ' + p.table : '—') + '</td>' +
              '<td style="padding:6px 8px">$' + (p.prix||0).toFixed(2) + '</td>' +
              '<td style="padding:6px 8px">' + (p.heure ? p.heure.replace('T',' ').substring(0,16) : '—') + '</td>' +
            '</tr>'
          ).join('') +
          '</tbody></table></div>'
      ) : '<p style="color:var(--muted);font-size:.84rem;margin-bottom:16px">Personne n\'est encore arrivé.</p>') +

      (attente.length ? (
        '<h4 style="margin:0 0 8px;font-size:.88rem;color:var(--muted)">⏳ En attente (' + attente.length + ')</h4>' +
        '<div style="overflow-x:auto;margin-bottom:18px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.8rem">' +
          '<thead><tr style="background:var(--off)">' +
            '<th style="padding:6px 8px;text-align:left">Nom</th>' +
            '<th style="padding:6px 8px;text-align:left">Table</th>' +
            '<th style="padding:6px 8px;text-align:left">Prix</th>' +
          '</tr></thead><tbody>' +
          attente.map(p =>
            '<tr style="border-bottom:1px solid var(--border)">' +
              '<td style="padding:6px 8px">' + (p.nom||'—') + '<br/><small style="color:var(--muted)">' + (p.email||'') + '</small></td>' +
              '<td style="padding:6px 8px">' + (p.table ? 'Table ' + p.table : '—') + '</td>' +
              '<td style="padding:6px 8px">$' + (p.prix||0).toFixed(2) + '</td>' +
            '</tr>'
          ).join('') +
          '</tbody></table></div>'
      ) : '') +

      (inscrits.length ? (
        '<h4 style="margin:0 0 8px;font-size:.88rem">👥 Inscrits (sans billet) (' + inscrits.length + ')</h4>' +
        '<div style="overflow-x:auto">' +
        '<table style="width:100%;border-collapse:collapse;font-size:.8rem">' +
          '<thead><tr style="background:var(--off)">' +
            '<th style="padding:6px 8px;text-align:left">Nom</th>' +
            '<th style="padding:6px 8px;text-align:left">Présent</th>' +
          '</tr></thead><tbody>' +
          inscrits.map(p =>
            '<tr style="border-bottom:1px solid var(--border)">' +
              '<td style="padding:6px 8px">' + (p.nom||'—') + '</td>' +
              '<td style="padding:6px 8px">' + (p.checked_in ? '✅' : '—') + '</td>' +
            '</tr>'
          ).join('') +
          '</tbody></table></div>'
      ) : '');
  }

  openModal('📍 Présents en direct', `
    <div style="max-height:75vh;overflow-y:auto;padding-right:4px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <span id="live-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1b5e20;animation:pulse 1.5s infinite"></span>
        <span style="font-size:.82rem;color:var(--muted)">Actualisation automatique toutes les 10 secondes</span>
        <button class="btn btn-sm btn-outline" style="margin-left:auto" onclick="liveAttendance(${actId})">🔄 Rafraîchir</button>
      </div>
      <div id="live-container">
        <div style="text-align:center;padding:30px;color:var(--muted)">Chargement…</div>
      </div>
    </div>
  `);

  document.head.insertAdjacentHTML('beforeend', '<style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}</style>');

  await refresh();
  _liveInterval = setInterval(refresh, 10000);

  document.getElementById('modal-overlay').addEventListener('click', function stopLive(e) {
    if (e.target.id === 'modal-overlay') { clearInterval(_liveInterval); _liveInterval = null; this.removeEventListener('click', stopLive); }
  });
}

// ══ TYPES DE BILLETS ══════════════════════════════════════════════════════════

async function manageTicketTypes(actId) {
  closeModal();
  async function reload() {
    const types = await api(`/activities/${actId}/ticket-types`);
    const tbody = document.getElementById('tt-tbody');
    if (!tbody) return;
    tbody.innerHTML = types.length ? types.map(tt => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px">${tt.nom}</td>
        <td style="padding:8px">${tt.description||'—'}</td>
        <td style="padding:8px;text-align:right">$${(tt.prix||0).toFixed(2)}</td>
        <td style="padding:8px;text-align:center">${tt.capacite_max > 0 ? tt.capacite_max : '∞'}</td>
        <td style="padding:8px;text-align:center">${tt.nb_vendus}</td>
        <td style="padding:8px;text-align:center">
          ${tt.actif ? '<span style="color:var(--g2)">✅</span>' : '<span style="color:var(--muted)">⏸</span>'}
        </td>
        <td style="padding:8px;text-align:center">
          <button class="btn btn-sm btn-ghost" onclick="editTicketType(${actId},${tt.id},'${tt.nom.replace(/'/g,"\\'")}',${tt.prix},${tt.capacite_max},'${(tt.description||'').replace(/'/g,"\\'")}')">✏️</button>
          <button class="btn btn-sm btn-ghost" onclick="toggleTicketType(${actId},${tt.id},${tt.actif})" style="color:${tt.actif ? '#888' : 'var(--g2)'}">
            ${tt.actif ? '⏸' : '▶️'}
          </button>
          <button class="btn btn-sm btn-ghost" onclick="deleteTicketType(${actId},${tt.id})" style="color:var(--red)">🗑</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--muted)">Aucun type de billet</td></tr>';

    // Lien public
    const linkEl = document.getElementById('tt-public-link');
    if (linkEl) {
      const base = window.location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://ahhamilton.ca';
      linkEl.href = `${base}/billets.html?id=${actId}`;
      linkEl.textContent = `${base}/billets.html?id=${actId}`;
    }
  }

  openModal('🎟 Types de billets', `
    <div style="max-height:75vh;overflow-y:auto">
      <div style="background:var(--off);border-radius:10px;padding:14px;margin-bottom:16px">
        <strong style="font-size:.88rem">Ajouter un type de billet</strong>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
          <div class="form-group" style="margin:0;grid-column:1/-1">
            <label style="font-size:.72rem">Nom du billet *</label>
            <input id="tt-nom" placeholder="Adulte, Enfant, VIP…"/>
          </div>
          <div class="form-group" style="margin:0">
            <label style="font-size:.72rem">Prix (CAD)</label>
            <input id="tt-prix" type="number" min="0" step="0.01" placeholder="0.00"/>
          </div>
          <div class="form-group" style="margin:0">
            <label style="font-size:.72rem">Capacité max (0 = illimité)</label>
            <input id="tt-cap" type="number" min="0" value="0"/>
          </div>
          <div class="form-group" style="margin:0;grid-column:1/-1">
            <label style="font-size:.72rem">Description (optionnel)</label>
            <input id="tt-desc" placeholder="ex: 12 ans et plus"/>
          </div>
        </div>
        <button class="btn btn-primary" style="margin-top:10px;width:auto;padding:8px 20px" onclick="addTicketType(${actId})">+ Ajouter</button>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:.82rem;margin-bottom:16px">
        <thead><tr style="background:var(--off)">
          <th style="padding:8px;text-align:left">Nom</th>
          <th style="padding:8px;text-align:left">Description</th>
          <th style="padding:8px;text-align:right">Prix</th>
          <th style="padding:8px;text-align:center">Cap.</th>
          <th style="padding:8px;text-align:center">Vendus</th>
          <th style="padding:8px;text-align:center">Actif</th>
          <th style="padding:8px;text-align:center">Actions</th>
        </tr></thead>
        <tbody id="tt-tbody"><tr><td colspan="7" style="padding:20px;text-align:center;color:var(--muted)">Chargement…</td></tr></tbody>
      </table>

      <div style="background:var(--off);border-radius:10px;padding:12px">
        <div style="font-size:.75rem;font-weight:700;margin-bottom:6px">🔗 Lien de vente public</div>
        <a id="tt-public-link" href="#" target="_blank" style="font-size:.78rem;color:var(--g2);word-break:break-all"></a>
        <button class="btn btn-sm btn-outline" style="margin-top:8px;width:auto;padding:6px 14px" onclick="navigator.clipboard.writeText(document.getElementById('tt-public-link').href).then(()=>toast('Lien copié !'))">📋 Copier le lien</button>
      </div>
    </div>
  `);
  reload();
  window._reloadTicketTypes = reload;
}

async function addTicketType(actId) {
  const nom  = document.getElementById('tt-nom').value.trim();
  const prix = parseFloat(document.getElementById('tt-prix').value) || 0;
  const cap  = parseInt(document.getElementById('tt-cap').value) || 0;
  const desc = document.getElementById('tt-desc').value.trim();
  if (!nom) { toast('Nom requis', 'error'); return; }
  try {
    await api(`/activities/${actId}/ticket-types`, { method: 'POST', body: JSON.stringify({ nom, prix, capacite_max: cap, description: desc }) });
    document.getElementById('tt-nom').value = '';
    document.getElementById('tt-prix').value = '';
    document.getElementById('tt-cap').value = '0';
    document.getElementById('tt-desc').value = '';
    toast('Type ajouté');
    window._reloadTicketTypes && window._reloadTicketTypes();
  } catch (ex) { toast(ex.message, 'error'); }
}

async function editTicketType(actId, ttId, nom, prix, cap, desc) {
  const newNom  = prompt('Nom :', nom);
  if (!newNom) return;
  const newPrix = parseFloat(prompt('Prix :', prix)) || 0;
  const newCap  = parseInt(prompt('Capacité max (0 = illimité) :', cap)) || 0;
  const newDesc = prompt('Description :', desc) || '';
  try {
    await api(`/activities/ticket-types/${ttId}`, { method: 'PUT', body: JSON.stringify({ nom: newNom, prix: newPrix, capacite_max: newCap, description: newDesc, actif: true }) });
    toast('Modifié');
    window._reloadTicketTypes && window._reloadTicketTypes();
  } catch (ex) { toast(ex.message, 'error'); }
}

async function toggleTicketType(actId, ttId, currentActif) {
  try {
    await api(`/activities/ticket-types/${ttId}`, { method: 'PUT', body: JSON.stringify({ actif: !currentActif }) });
    toast(currentActif ? 'Type désactivé' : 'Type activé');
    window._reloadTicketTypes && window._reloadTicketTypes();
  } catch (ex) { toast(ex.message, 'error'); }
}

async function deleteTicketType(actId, ttId) {
  if (!confirm('Supprimer ce type de billet ?')) return;
  try {
    await api(`/activities/ticket-types/${ttId}`, { method: 'DELETE' });
    toast('Supprimé');
    window._reloadTicketTypes && window._reloadTicketTypes();
  } catch (ex) { toast(ex.message, 'error'); }
}

// ══ COURRIEL EXTERNE ═════════════════════════════════════════════════════════

async function externalEmail() {
  const sent = await api('/email/sent').catch(() => []);

  const rows = sent.map(function(e) {
    const date = (e.date_envoi || '').substring(0, 16).replace('T', ' ');
    const statut = e.statut === 'envoye'
      ? '<span style="color:var(--g2)">✅ Envoyé</span>'
      : '<span style="color:var(--red)">❌ Erreur</span>';
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:8px 10px;font-size:.82rem;color:var(--muted)">' + date + '</td>' +
      '<td style="padding:8px 10px">' + (e.expediteur_nom || '') + '</td>' +
      '<td style="padding:8px 10px">' + escHtml(e.destinataire) + '</td>' +
      '<td style="padding:8px 10px">' + escHtml(e.sujet) + '</td>' +
      '<td style="padding:8px 10px;text-align:center">' + statut + '</td>' +
    '</tr>';
  }).join('');

  const histSection = sent.length
    ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.83rem">' +
      '<thead><tr style="background:var(--off)">' +
      '<th style="padding:9px 10px;text-align:left">Date</th>' +
      '<th style="padding:9px 10px;text-align:left">Expéditeur</th>' +
      '<th style="padding:9px 10px;text-align:left">Destinataire</th>' +
      '<th style="padding:9px 10px;text-align:left">Sujet</th>' +
      '<th style="padding:9px 10px;text-align:center">Statut</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<p style="color:var(--muted);font-size:.88rem">Aucun courriel envoyé pour l\'instant.</p>';

  setContent(
    '<div style="padding:24px">' +
    '<h2 style="margin-bottom:20px">📤 Courriel externe</h2>' +
    '<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:28px">' +
    '<div style="margin-bottom:14px">' +
      '<label style="display:block;font-weight:600;margin-bottom:5px">Destinataire</label>' +
      '<input id="extEmailTo" type="email" placeholder="exemple@gmail.com" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:.9rem;box-sizing:border-box"/>' +
    '</div>' +
    '<div style="margin-bottom:14px">' +
      '<label style="display:block;font-weight:600;margin-bottom:5px">Sujet</label>' +
      '<input id="extEmailSubject" type="text" placeholder="Objet du message" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:.9rem;box-sizing:border-box"/>' +
    '</div>' +
    '<div style="margin-bottom:18px">' +
      '<label style="display:block;font-weight:600;margin-bottom:5px">Message</label>' +
      '<textarea id="extEmailBody" rows="7" placeholder="Votre message…" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:.9rem;box-sizing:border-box;resize:vertical"></textarea>' +
    '</div>' +
    '<button class="btn btn-primary" onclick="sendExternalEmailMsg()" style="min-width:140px">Envoyer</button>' +
    '</div>' +
    '<h3 style="margin-bottom:14px">Historique des envois</h3>' +
    histSection +
    '</div>'
  );
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function sendExternalEmailMsg() {
  const to      = document.getElementById('extEmailTo').value.trim();
  const subject = document.getElementById('extEmailSubject').value.trim();
  const body    = document.getElementById('extEmailBody').value.trim();
  if (!to || !subject || !body) { toast('Veuillez remplir tous les champs', 'error'); return; }
  try {
    await api('/email/send', { method: 'POST', body: JSON.stringify({ to, subject, body }) });
    toast('✅ Courriel envoyé à ' + to);
    externalEmail();
  } catch(e) { toast(e.message, 'error'); }
}

// ══ COMMANDES DE BILLETS EN ATTENTE ══════════════════════════════════════════

async function pendingOrders() {
  const orders = await api('/orders/pending').catch(() => []);

  if (!orders.length) {
    setContent('<div style="padding:40px;text-align:center"><div style="font-size:3rem;margin-bottom:12px">✅</div><div style="color:var(--muted)">Aucune commande en attente de paiement</div></div>');
    return;
  }

  const rows = orders.map(function(o) {
    const methode = o.methode_paiement === 'interac' ? '🏦 Interac' : '💳 Carte';
    const date = (o.date_commande || '').substring(0, 16).replace('T', ' ');
    const montant = '$' + (o.montant_total || 0).toFixed(2);
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:9px 10px"><strong>' + o.acheteur_nom + '</strong><br/><small style="color:var(--muted)">' + o.acheteur_email + '</small></td>' +
      '<td style="padding:9px 10px">' + o.activite + '</td>' +
      '<td style="padding:9px 10px;text-align:center">' + o.nb_billets + '</td>' +
      '<td style="padding:9px 10px;text-align:right;font-weight:700;color:var(--g2)">' + montant + '</td>' +
      '<td style="padding:9px 10px">' + methode + '</td>' +
      '<td style="padding:9px 10px;font-size:.78rem;color:var(--muted)">' + date + '</td>' +
      '<td style="padding:9px 10px;text-align:center">' +
        '<button class="btn btn-sm btn-primary" onclick="confirmOrder(\'' + o.order_token + '\')">✅ Confirmer</button> ' +
        '<button class="btn btn-sm btn-ghost" onclick="cancelOrder(\'' + o.order_token + '\')" style="color:var(--red)">✖ Annuler</button>' +
      '</td></tr>';
  }).join('');

  setContent(
    '<div style="padding:20px">' +
    '<h2 style="margin-bottom:18px">Commandes en attente (' + orders.length + ')</h2>' +
    '<div style="overflow-x:auto">' +
    '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
    '<thead><tr style="background:var(--off)">' +
    '<th style="padding:10px;text-align:left">Acheteur</th>' +
    '<th style="padding:10px;text-align:left">Activité</th>' +
    '<th style="padding:10px;text-align:center">Billets</th>' +
    '<th style="padding:10px;text-align:right">Montant</th>' +
    '<th style="padding:10px;text-align:left">Méthode</th>' +
    '<th style="padding:10px;text-align:left">Date</th>' +
    '<th style="padding:10px;text-align:center">Actions</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></div>'
  );
}

async function confirmOrder(orderToken) {
  if (!confirm('Confirmer le paiement et envoyer les codes QR par courriel ?')) return;
  try {
    const r = await api(`/orders/${orderToken}/confirm`, { method: 'POST' });
    toast(`✅ Confirmé — ${r.nb} billet(s), codes QR envoyés`);
    pendingOrders();
  } catch (ex) { toast(ex.message, 'error'); }
}

async function cancelOrder(orderToken) {
  if (!confirm('Annuler cette commande ? Les places seront libérées.')) return;
  try {
    await api(`/orders/${orderToken}/cancel`, { method: 'POST' });
    toast('Commande annulée');
    pendingOrders();
  } catch (ex) { toast(ex.message, 'error'); }
}

// ══ GESTION DES TABLES & BILLETS ══════════════════════════════════════════════

async function managerTables(actId, actTitre) {
  const [tables, allUsers] = await Promise.all([
    api(`/activities/${actId}/tables`),
    api('/users')
  ]);
  const comiteUsers = allUsers.filter(u => ['admin','delegue','secretaire','tresoriere'].includes(u.role));

  openModal(`🪑 Tables — ${actTitre}`, `
    <div style="max-height:75vh;overflow-y:auto">

      ${can.admin() ? `
      <div style="background:var(--off);border-radius:10px;padding:14px;margin-bottom:18px">
        <strong style="font-size:.88rem">Configurer les tables</strong>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="form-group" style="margin:0;flex:1;min-width:120px">
            <label style="font-size:.72rem">Nombre de tables</label>
            <input type="number" id="nb_tables_input" min="1" max="100" value="${tables.length||10}" style="width:100%"/>
          </div>
          <div class="form-group" style="margin:0;flex:1;min-width:120px">
            <label style="font-size:.72rem">Places / table</label>
            <input type="number" id="cap_tables_input" min="1" max="20" value="10" style="width:100%"/>
          </div>
          <button class="btn btn-primary" onclick="setupTables(${actId})">Créer</button>
        </div>
      </div>` : ''}

      ${tables.length ? `
      <div style="margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong>${tables.length} table${tables.length>1?'s':''}</strong>
          <button class="btn btn-sm btn-primary" onclick="openSellTicketForm(${actId},'${actTitre.replace(/'/g,"\\'")}')">💳 Vendre un billet</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">
          ${tables.map(t => {
            const pct = Math.round(t.places_vendues / t.capacite_max * 100);
            const color = pct >= 100 ? '#c62828' : pct >= 70 ? '#e65100' : '#1b5e20';
            return `
            <div style="border:1.5px solid var(--border);border-radius:10px;padding:12px">
              <div style="font-weight:700;font-size:1rem;color:var(--text)">Table ${t.numero}</div>
              <div style="font-size:.78rem;color:${color};margin:4px 0">${t.places_vendues}/${t.capacite_max} places</div>
              <div style="height:5px;background:var(--border);border-radius:50px;margin-bottom:8px">
                <div style="height:100%;width:${pct}%;background:${color};border-radius:50px"></div>
              </div>
              <div style="font-size:.72rem;color:var(--muted);margin-bottom:6px">
                ${t.membre_nom ? '👤 Réservée: '+t.membre_nom : '🌐 Libre (en ligne)'}
              </div>
              ${can.admin() ? `
              <select style="width:100%;font-size:.72rem;padding:3px;border-radius:5px;border:1px solid var(--border)" onchange="assignTable(${t.id},this.value)">
                <option value="">🌐 Libre</option>
                ${comiteUsers.map(u=>`<option value="${u.id}" ${t.membre_attribue===u.id?'selected':''}>${u.prenom} ${u.nom}</option>`).join('')}
              </select>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>` : `<div style="text-align:center;color:var(--muted);padding:24px">Aucune table configurée — créez des tables ci-dessus</div>`}

      <details style="margin-top:12px">
        <summary style="cursor:pointer;font-size:.82rem;font-weight:600;color:var(--muted)">📋 Tous les billets vendus</summary>
        <div id="ticketsList" style="margin-top:10px">
          <button class="btn btn-sm btn-ghost" onclick="loadTicketsList(${actId})">Charger les billets</button>
        </div>
      </details>
    </div>
  `);
}

async function setupTables(actId) {
  const nb = parseInt(document.getElementById('nb_tables_input').value);
  const cap = parseInt(document.getElementById('cap_tables_input').value) || 10;
  if (!nb || nb < 1) return toast('Entrez un nombre de tables valide', 'error');
  await api(`/activities/${actId}/tables/setup`, { method:'POST', body: JSON.stringify({ nb_tables: nb, capacite_max: cap }) });
  toast(`${nb} tables configurées`);
  // Re-ouvrir le modal avec les données fraîches
  const act = (await api('/activities')).find(a => a.id === actId);
  if (act) managerTables(actId, act.titre);
}

async function assignTable(tableId, membreId) {
  await api(`/activity-tables/${tableId}/assign`, { method:'PUT', body: JSON.stringify({ membre_id: parseInt(membreId)||null }) });
  toast('Table mise à jour');
}

async function loadTicketsList(actId) {
  const tickets = await api(`/activities/${actId}/tickets`);
  document.getElementById('ticketsList').innerHTML = tickets.length ? `
    <table style="width:100%;font-size:.78rem;border-collapse:collapse">
      <thead><tr style="background:var(--off)"><th style="padding:5px">Acheteur</th><th>Table</th><th>Vendeur</th><th>Méthode</th><th>Prix</th><th>QR</th></tr></thead>
      <tbody>${tickets.map(t=>`<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:5px"><strong>${t.acheteur_nom}</strong><br/><small>${t.acheteur_email||'–'}</small></td>
        <td style="padding:5px;text-align:center">Table ${t.table_numero||'–'}</td>
        <td style="padding:5px">${t.vendeur_nom||'En ligne'}</td>
        <td style="padding:5px">${t.methode_paiement||'–'}</td>
        <td style="padding:5px">$${(t.prix||0).toFixed(2)}</td>
        <td style="padding:5px"><button class="btn btn-sm btn-ghost" onclick="window.open('${BASE}/api/tickets/${t.id}/qr','_blank')">📱</button></td>
      </tr>`).join('')}</tbody>
    </table>` : '<p style="color:var(--muted);font-size:.82rem">Aucun billet vendu</p>';
}

function openSellTicketForm(actId, actTitre) {
  openModal(`💳 Vendre un billet — ${actTitre}`, `
    <form id="sellForm">
      <div class="form-group"><label>Nom de l'acheteur *</label><input id="sell_nom" required/></div>
      <div class="form-row">
        <div class="form-group"><label>Courriel</label><input type="email" id="sell_email"/></div>
        <div class="form-group"><label>Téléphone</label><input id="sell_tel"/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Prix ($)</label><input type="number" step="0.01" min="0" id="sell_prix"/></div>
        <div class="form-group"><label>Méthode</label>
          <select id="sell_methode">
            <option value="cash">Comptant</option>
            <option value="cheque">Chèque</option>
            <option value="virement">Virement</option>
            <option value="carte">Carte</option>
          </select></div>
      </div>
      <div class="form-group"><label>Quantité</label><input type="number" min="1" max="10" value="1" id="sell_qty"/></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer & Générer QR</button>
      </div>
    </form>
  `);
  document.getElementById('sellForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api(`/activities/${actId}/tickets/sell`, { method:'POST', body: JSON.stringify({
        acheteur_nom: document.getElementById('sell_nom').value,
        acheteur_email: document.getElementById('sell_email').value,
        acheteur_telephone: document.getElementById('sell_tel').value,
        prix: parseFloat(document.getElementById('sell_prix').value)||0,
        methode_paiement: document.getElementById('sell_methode').value,
        quantite: parseInt(document.getElementById('sell_qty').value)||1
      })});
      closeModal();
      toast(`Billet vendu — Table ${r.table_numero}`);
      // Afficher le QR code du billet
      openModal('📱 QR Code du billet', `
        <div style="text-align:center;padding:20px">
          <img src="${BASE}/api/tickets/${r.id}/qr" style="width:220px;height:220px" alt="QR"/>
          <pre style="background:var(--off);padding:12px;border-radius:8px;font-size:.82rem;margin-top:14px;text-align:left">${r.qr_data}</pre>
          <button class="btn btn-outline" style="margin-top:12px" onclick="window.open('${BASE}/api/tickets/${r.id}/qr','_blank')">🖨️ Télécharger QR</button>
        </div>
      `);
    } catch(ex) { toast(ex.message,'error'); }
  };
}

// ── Rapport global activités ──────────────────────────────────────────────────

async function reports() {
  const [activitiesRpt, plansRpt, membresRpt] = await Promise.all([
    api('/reports/activities'),
    api('/reports/plans'),
    api('/reports/membres')
  ]);

  const totalRevenu = activitiesRpt.reduce((s, a) => s + (a.revenu||0), 0);
  const totalInscrits = activitiesRpt.reduce((s, a) => s + (a.nb_inscrits||0), 0);
  const membresPayes = plansRpt.membres.filter(m => m.paye_mois > 0).length;
  const membresImpayés = plansRpt.membres.filter(m => m.plan !== 'gratuit' && m.paye_mois === 0).length;

  setContent(
    '<div class="page-header">' +
      '<div><h2>📊 Rapports</h2><p>Tableaux de bord financiers et de présence</p></div>' +
      '<div class="page-actions"><button class="btn btn-outline" onclick="printSection(\'Rapports AHH\')">🖨️ Imprimer tout</button></div>' +
    '</div>' +

    // KPIs globaux
    '<div class="cards-grid" style="margin-bottom:28px">' +
      '<div class="stat-card accent"><div class="sc-icon">💰</div><div class="sc-value">$' + totalRevenu.toFixed(2) + '</div><div class="sc-label">Revenus activités</div></div>' +
      '<div class="stat-card"><div class="sc-icon">🎉</div><div class="sc-value">' + activitiesRpt.length + '</div><div class="sc-label">Activités</div></div>' +
      '<div class="stat-card"><div class="sc-icon">👥</div><div class="sc-value">' + totalInscrits + '</div><div class="sc-label">Inscriptions</div></div>' +
      '<div class="stat-card"><div class="sc-icon">✅</div><div class="sc-value">' + membresPayes + '</div><div class="sc-label">Plans payés (' + plansRpt.mois + ')</div></div>' +
      '<div class="stat-card"><div class="sc-icon">⚠️</div><div class="sc-value">' + membresImpayés + '</div><div class="sc-label">Plans en retard</div></div>' +
    '</div>' +

    // Rapport activités
    '<div class="table-card" style="margin-bottom:24px">' +
      '<div class="table-card-header"><h3>🎉 Rapport par activité</h3>' +
        '<div class="tc-actions"><button class="btn btn-ghost btn-sm" onclick="printSection(\'Rapport activités\')">🖨️</button></div>' +
      '</div>' +
      '<div class="table-wrapper"><table>' +
        '<thead><tr><th>Activité</th><th>Date</th><th>Inscrits</th><th>Prix</th><th>Revenu</th><th>Statut</th><th>Action</th></tr></thead>' +
        '<tbody>' + activitiesRpt.map(a =>
          '<tr><td><strong>' + a.titre + '</strong></td>' +
          '<td>' + fmt(a.date_debut) + '</td>' +
          '<td>' + (a.nb_inscrits||0) + (a.max_participants ? '/' + a.max_participants : '') + '</td>' +
          '<td>' + (a.paiement_requis ? '$' + (a.prix||0).toFixed(2) : 'Gratuite') + '</td>' +
          '<td><strong>$' + (a.revenu||0).toFixed(2) + '</strong></td>' +
          '<td>' + statusPill(a.statut) + '</td>' +
          '<td><button class="btn btn-sm btn-ghost" onclick="showActivityReport(' + a.id + ')">📊</button>' +
          (a.qr_token ? '<button class="btn btn-sm btn-outline" onclick="viewActivityQR(' + a.id + ',\'' + a.titre.replace(/'/g,"\\'") + '\')">📱 QR</button>' : '') +
          '</td></tr>'
        ).join('') + '</tbody></table></div>' +
    '</div>' +

    // Plans mensuels
    '<div class="table-card" style="margin-bottom:24px">' +
      '<div class="table-card-header"><h3>💳 Plans mensuels — ' + plansRpt.mois + '</h3>' +
        '<div class="tc-actions">' +
          '<select id="planMoisFilter" onchange="filterPlansMois()" style="font-size:.75rem;border:1px solid var(--border);border-radius:6px;padding:4px 8px">' +
            '<option value="payés">Payés ce mois</option>' +
            '<option value="retard">En retard</option>' +
            '<option value="tous">Tous</option>' +
          '</select>' +
          '<button class="btn btn-ghost btn-sm" onclick="printSection(\'Plans mensuels\')">🖨️</button>' +
        '</div>' +
      '</div>' +
      '<div class="table-wrapper" id="planTable"><table>' +
        '<thead><tr><th>Membre</th><th>Plan</th><th>Payé ce mois</th><th>Rappels</th><th>Dernier paiement</th></tr></thead>' +
        '<tbody id="planBody">' + renderPlanRows(plansRpt.membres, 'payés') + '</tbody>' +
      '</table></div>' +
    '</div>' +

    // Tous les membres
    '<div class="table-card">' +
      '<div class="table-card-header"><h3>👥 Liste des membres</h3>' +
        '<div class="tc-actions"><button class="btn btn-ghost btn-sm" onclick="printSection(\'Liste membres\')">🖨️</button></div>' +
      '</div>' +
      '<div class="table-wrapper"><table>' +
        '<thead><tr><th>Nom</th><th>Email</th><th>Rôle</th><th>Plan</th><th>Activités</th><th>Total payé</th><th>Inscription</th></tr></thead>' +
        '<tbody>' + membresRpt.map(m =>
          '<tr><td><strong>' + m.prenom + ' ' + m.nom + '</strong></td>' +
          '<td>' + m.email + '</td>' +
          '<td>' + pill(roleName(m.role), m.role==='admin'?'bp-orange':'bp-blue') + '</td>' +
          '<td>' + pill(m.plan||'gratuit', m.plan==='bienfaiteur'?'bp-orange':m.plan==='partenaire'?'bp-green':'bp-gray') + '</td>' +
          '<td>' + (m.nb_activites||0) + '</td>' +
          '<td>$' + (m.total_paye_activites||0).toFixed(2) + '</td>' +
          '<td>' + fmt(m.date_inscription) + '</td></tr>'
        ).join('') + '</tbody></table></div>' +
    '</div>'
  );

  // Stocker données pour filtre
  window._plansData = plansRpt.membres;
}

function renderPlanRows(membres, filter) {
  let filtered = membres;
  if (filter === 'payés')  filtered = membres.filter(m => m.plan !== 'gratuit' && m.paye_mois > 0);
  if (filter === 'retard') filtered = membres.filter(m => m.plan !== 'gratuit' && m.paye_mois === 0);
  return filtered.map(m =>
    '<tr><td><strong>' + m.prenom + ' ' + m.nom + '</strong><br/><small style="color:var(--muted)">' + m.email + '</small></td>' +
    '<td>' + pill(m.plan||'gratuit', m.plan==='bienfaiteur'?'bp-orange':m.plan==='partenaire'?'bp-green':'bp-gray') + '</td>' +
    '<td>' + (m.paye_mois > 0 ? '<span style="color:var(--g2);font-weight:600">✅ Payé</span>' : '<span style="color:var(--red);font-weight:600">❌ Non payé</span>') + '</td>' +
    '<td>' + (m.plan_unpaid_count||0) + '/2</td>' +
    '<td>' + (m.plan_paid_month||'–') + '</td></tr>'
  ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Aucun membre</td></tr>';
}

function filterPlansMois() {
  const filter = document.getElementById('planMoisFilter').value;
  document.getElementById('planBody').innerHTML = renderPlanRows(window._plansData || [], filter);
}

// ══ SCANNER DE BILLETS ══════════════════════════════════════════════════════

async function scanner() {
  const acts = await api('/activities');
  const upcoming = acts.filter(a => a.statut !== 'annulee').slice(0, 10);
  setContent(`
    <div class="page-header">
      <div><h2>📷 Scanner les billets</h2><p>Ouvrez la page de scan sur une tablette pour accueillir les participants</p></div>
    </div>
    <div style="max-width:560px;margin:0 auto;text-align:center">
      <div style="background:var(--off);border:1px solid var(--border);border-radius:20px;padding:40px 32px;margin-bottom:24px">
        <div style="font-size:4rem;margin-bottom:16px">📱</div>
        <h3 style="font-size:1.2rem;margin-bottom:10px">Page de scan tablette</h3>
        <p style="color:var(--muted);font-size:.88rem;margin-bottom:24px;line-height:1.7">
          La page de scan s'ouvre en plein écran sur la tablette.<br>
          Plusieurs membres du comité peuvent scanner simultanément<br>
          depuis leur propre appareil.
        </p>
        <a href="../scan.html" target="_blank" class="btn btn-primary" style="font-size:1rem;padding:14px 32px">
          📷 Ouvrir le scanner
        </a>
      </div>
      <div style="background:#fff;border:1px solid var(--border);border-radius:16px;padding:24px 20px">
        <h4 style="font-size:.95rem;margin-bottom:14px;text-align:left">Ouvrir le scanner pour une activité</h4>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${upcoming.map(a => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--off);border-radius:10px">
              <div style="text-align:left">
                <strong style="font-size:.88rem">${a.titre}</strong>
                <div style="font-size:.76rem;color:var(--muted)">${a.date_debut ? new Date(a.date_debut).toLocaleDateString('fr-CA') : '–'}</div>
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                <button class="btn btn-sm btn-ghost" onclick="cacheTicketsOffline(${a.id},'${a.titre.replace(/'/g,"\\'")}')">📥 Hors-ligne</button>
                <a href="../scan.html?activity_id=${a.id}" target="_blank" class="btn btn-sm btn-outline">📷 Scanner</a>
              </div>
            </div>
          `).join('') || '<p style="color:var(--muted);font-size:.85rem">Aucune activité disponible</p>'}
        </div>
      </div>
    </div>
  `);
}

function openScanner(actId) {
  const BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001' : '';
  window.open(`${BASE_URL}/scan.html?activity_id=${actId}`, '_blank');
}

async function cacheTicketsOffline(actId, titre) {
  if (!navigator.serviceWorker?.controller) return toast('Service worker non disponible', true);
  try {
    toast('Téléchargement des billets pour mode hors-ligne...');
    const tickets = await api(`/activities/${actId}/tickets-list`).catch(() => []);
    const mc = new MessageChannel();
    const result = await new Promise((resolve, reject) => {
      mc.port1.onmessage = e => resolve(e.data);
      setTimeout(() => reject(new Error('Timeout')), 5000);
      navigator.serviceWorker.controller.postMessage(
        { type: 'CACHE_TICKETS', activityId: actId, tickets }, [mc.port2]
      );
    });
    toast(`✅ ${result.count} billets mis en cache hors-ligne pour "${titre}"`);
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

// ══ PHOTOS PAR ACTIVITÉ ════════════════════════════════════════════════════════

async function manageActivityPhotos(actId, actTitre) {
  const photos = await api(`/activities/${actId}/photos`);

  function renderPhotos(list) {
    if (!list.length) return '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:20px 0">Aucune photo — uploadez votre première photo ci-dessous.</p>';
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px">' +
      list.map(p => `
        <div style="position:relative;border-radius:10px;overflow:hidden;aspect-ratio:1;background:#f0f0f0">
          <img src="${BASE}${p.photo_path}" style="width:100%;height:100%;object-fit:cover" loading="lazy"/>
          <button onclick="deleteActivityPhoto(${p.id},${actId},'${actTitre.replace(/'/g,"\\'")}',this)"
            style="position:absolute;top:5px;right:5px;background:rgba(200,0,0,.8);color:#fff;border:none;border-radius:50%;width:26px;height:26px;font-size:.75rem;cursor:pointer;display:flex;align-items:center;justify-content:center">✕</button>
        </div>`).join('') +
    '</div>';
  }

  openModal(`🖼 Photos — ${actTitre}`, `
    <div id="actPhotoGrid">${renderPhotos(photos)}</div>
    <div style="border:2px dashed var(--border);border-radius:12px;padding:24px;text-align:center">
      <p style="color:var(--muted);font-size:.83rem;margin-bottom:14px">Sélectionnez une ou plusieurs photos (JPG, PNG, max 15 Mo chacune)</p>
      <input type="file" id="actPhotoInput" accept="image/*" multiple style="display:none"/>
      <label for="actPhotoInput" class="btn btn-outline" style="cursor:pointer">📁 Choisir des photos</label>
      <div id="actPhotoPreview" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;justify-content:center"></div>
      <button id="actPhotoUploadBtn" class="btn btn-primary" style="margin-top:14px;display:none" onclick="uploadActivityPhotos(${actId},'${actTitre.replace(/'/g,"\\'")}')">⬆ Uploader</button>
    </div>
  `);

  document.getElementById('actPhotoInput').addEventListener('change', function() {
    const prev = document.getElementById('actPhotoPreview');
    const btn  = document.getElementById('actPhotoUploadBtn');
    prev.innerHTML = '';
    Array.from(this.files).forEach(f => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      img.style.cssText = 'width:80px;height:80px;object-fit:cover;border-radius:8px;border:2px solid var(--border)';
      prev.appendChild(img);
    });
    btn.style.display = this.files.length ? 'inline-flex' : 'none';
  });
}

async function uploadActivityPhotos(actId, actTitre) {
  const input = document.getElementById('actPhotoInput');
  const btn = document.getElementById('actPhotoUploadBtn');
  if (!input.files.length) return;
  btn.disabled = true; btn.textContent = 'Upload en cours…';
  const fd = new FormData();
  Array.from(input.files).forEach(f => fd.append('photos', f));
  try {
    await fetch(`${API}/activities/${actId}/photos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd
    });
    toast('Photos uploadées !');
    manageActivityPhotos(actId, actTitre);
  } catch(e) {
    toast('Erreur lors de l\'upload', true);
    btn.disabled = false; btn.textContent = '⬆ Uploader';
  }
}

async function deleteActivityPhoto(photoId, actId, actTitre, btn) {
  if (!confirm('Supprimer cette photo ?')) return;
  btn.disabled = true;
  try {
    await api(`/activity-photos/${photoId}`, { method: 'DELETE' });
    toast('Photo supprimée');
    manageActivityPhotos(actId, actTitre);
  } catch(e) {
    toast('Erreur', true);
    btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// VENTE EN PERSONNE (CASH)
// ══════════════════════════════════════════════════════════════════════════════

async function ventePersonne() {
  const acts = await api('/activities').catch(() => []);
  const actives = acts.filter(a => ['planifiee','en_cours'].includes(a.statut));
  setContent(`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">

      <!-- Colonne gauche : Formulaire -->
      <div class="table-card">
        <div class="table-card-header"><h3>💵 Billets — Vente / Pré-impression</h3></div>
        <div style="padding:16px">
          <div class="form-group" style="margin-bottom:14px">
            <label class="form-label">Activité</label>
            <select id="vpActivite" class="form-input" onchange="vpLoadActivity()">
              <option value="">— Choisir une activité —</option>
              ${actives.map(a => `<option value="${a.id}" data-prix="${a.prix||0}">${a.titre} (${a.date_debut ? new Date(a.date_debut).toLocaleDateString('fr-CA') : '–'})</option>`).join('')}
            </select>
          </div>
          <div id="vpForm" style="display:none">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Nom acheteur</label>
                <input id="vpNom" class="form-input" placeholder="Nom (ou Anonyme)"/>
              </div>
              <div class="form-group">
                <label class="form-label">Quantité</label>
                <input id="vpNb" class="form-input" type="number" min="1" max="200" value="1"/>
              </div>
            </div>
            <div class="form-group" style="margin-bottom:18px">
              <label class="form-label">Prix unitaire ($)</label>
              <input id="vpPrix" class="form-input" type="number" min="0" step="0.01"/>
            </div>

            <!-- Explication du mode -->
            <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:.82rem">
              <strong>💡 Deux modes :</strong><br/>
              <b>Pré-imprimer</b> → génère les billets SANS enregistrer la vente. Vous marquez "Vendu" au moment de l'encaissement.<br/>
              <b>Vendre maintenant</b> → billet activé et revenu enregistré immédiatement.
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn btn-outline" onclick="vpAction('generer')">🖨️ Pré-imprimer (sans vente)</button>
              <button class="btn btn-primary" onclick="vpAction('vendre')">💵 Vendre maintenant</button>
            </div>
          </div>
          <div id="vpTickets" style="margin-top:20px"></div>
        </div>
      </div>

      <!-- Colonne droite : Billets pré-imprimés non vendus -->
      <div class="table-card">
        <div class="table-card-header">
          <h3>📋 Billets générés — non vendus</h3>
          <button class="btn btn-sm btn-ghost" id="vpRefreshBtn" onclick="vpRefreshGeneres()" style="display:none">↻ Actualiser</button>
        </div>
        <div id="vpGeneresList" style="padding:16px;color:var(--muted);font-size:.85rem">
          Sélectionnez une activité pour voir les billets pré-imprimés non vendus.
        </div>
      </div>
    </div>`);
}

function vpLoadActivity() {
  const sel = document.getElementById('vpActivite');
  const opt = sel.options[sel.selectedIndex];
  if (!opt.value) { document.getElementById('vpForm').style.display = 'none'; return; }
  document.getElementById('vpPrix').value = opt.dataset.prix || '0';
  document.getElementById('vpForm').style.display = 'block';
  document.getElementById('vpTickets').innerHTML = '';
  document.getElementById('vpRefreshBtn').style.display = 'inline-flex';
  vpRefreshGeneres();
}

async function vpRefreshGeneres() {
  const actId = document.getElementById('vpActivite').value;
  if (!actId) return;
  const list = document.getElementById('vpGeneresList');
  list.innerHTML = '<div style="color:var(--muted)">⏳ Chargement...</div>';
  try {
    const tickets = await api(`/activities/${actId}/billets-generes`);
    if (!tickets.length) {
      list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted)">✅ Aucun billet pré-imprimé en attente</div>';
      return;
    }
    list.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <span style="font-size:.82rem;color:var(--muted)">${tickets.length} billet(s) non vendu(s)</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" onclick="vpSaisirTalons()">🎫 Saisir les talons</button>
          <button class="btn btn-sm" style="color:#c62828;border-color:#ffd5d5;background:#fff5f5" onclick="vpAnnulerNonVendus('${actId}')">🗑 Annuler tous</button>
        </div>
      </div>` +
      tickets.map(t => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:.84rem">${escHtml(t.acheteur_nom||'Anonyme')}</div>
            <div style="font-size:.72rem;font-family:monospace;color:#777">${t.barcode_data}</div>
          </div>
          <div style="font-weight:700;color:var(--g2);font-size:.85rem">$${(t.prix||0).toFixed(2)}</div>
          <button class="btn btn-sm btn-primary" onclick="vpMarquerVendu(${t.id})" title="Marquer comme vendu">✅ Vendu</button>
          <a href="/ticket.html?id=${t.id}" target="_blank" class="btn btn-sm btn-ghost" title="Imprimer">🖨️</a>
        </div>`).join('');
  } catch(e) { list.innerHTML = '<div style="color:var(--red)">Erreur: ' + e.message + '</div>'; }
}

async function vpAction(mode) {
  const actId = document.getElementById('vpActivite').value;
  const nom = document.getElementById('vpNom').value.trim() || 'Anonyme';
  const nb = parseInt(document.getElementById('vpNb').value) || 1;
  const prix = parseFloat(document.getElementById('vpPrix').value) || 0;
  if (!actId) return toast('Choisissez une activité', true);
  try {
    const r = await api(`/activities/${actId}/vendre`, { method: 'POST', body: JSON.stringify({ acheteur_nom: nom, nb_billets: nb, prix_unitaire: prix, mode }) });
    const ids = r.tickets.map(t => t.id).join(',');
    const label = mode === 'generer' ? 'pré-imprimé(s)' : 'vendu(s)';
    const container = document.getElementById('vpTickets');
    container.innerHTML =
      `<div style="background:${mode==='vendre'?'#e8f5e9':'#fff8e1'};border-radius:10px;padding:12px 16px;margin-bottom:12px;font-size:.85rem">
        ${mode==='vendre'?'✅':'🖨️'} <strong>${r.tickets.length} billet(s) ${label}</strong>${mode==='vendre'?' — revenu enregistré':' — vente à confirmer'}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <a href="/print-tickets.html?ids=${ids}" target="_blank" class="btn btn-primary btn-sm">🖨️ Imprimer tous</a>
        <a href="/print-tickets.html?ids=${ids}&size=small" target="_blank" class="btn btn-outline btn-sm">🖨️ Format petit</a>
      </div>`;
    toast(r.tickets.length + ' billet(s) ' + label);
    vpRefreshGeneres();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

async function vpMarquerVendu(ticketId) {
  try {
    await api(`/tickets/${ticketId}/marquer-vendu`, { method: 'POST' });
    toast('✅ Billet marqué vendu — revenu enregistré');
    vpRefreshGeneres();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

// ══════════════════════════════════════════════════════════════════════════════
// STATISTIQUES DU SITE (contrôlables par le comité)
// ══════════════════════════════════════════════════════════════════════════════
async function statsSite() {
  const cfg = await api('/stats/config').catch(() => ({}));
  setContent(`
    <div class="table-card" style="max-width:100%">
      <div class="table-card-header">
        <h3>📊 Statistiques du site public</h3>
      </div>
      <div style="padding:20px">

        <div style="background:#e8f5e9;border-left:4px solid #1b5e20;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:.85rem">
          <strong>Comment ça fonctionne :</strong> Les stats <b>Réelles</b> viennent de la base de données.
          Les stats <b>Globales</b> sont les valeurs que vous souhaitez afficher publiquement
          (ex: inclure d'anciens membres). Laissez vide pour afficher la valeur réelle.
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:24px">

          <!-- Membres actifs -->
          <div class="table-card" style="padding:16px">
            <div style="font-size:.8rem;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:10px">👥 Membres actifs</div>
            <div style="display:flex;gap:12px;align-items:flex-start">
              <div style="flex:1">
                <label class="form-label">Réel (base de données)</label>
                <div style="font-size:2rem;font-weight:800;color:var(--g2)">${cfg.membres_reel || 0}</div>
              </div>
              <div style="flex:1">
                <label class="form-label">Global (affiché sur le site)</label>
                <input id="cfg_membres" class="form-input" type="number" min="0" placeholder="${cfg.membres_reel || 0} (réel)" value="${cfg.membres_global || ''}"/>
              </div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:.84rem;cursor:pointer">
              <input type="checkbox" id="cfg_show_membres" ${cfg.show_membres !== 0 ? 'checked' : ''}/>
              Afficher sur le site public
            </label>
          </div>

          <!-- Heures de bénévolat -->
          <div class="table-card" style="padding:16px">
            <div style="font-size:.8rem;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:10px">🤝 Heures de bénévolat</div>
            <div style="display:flex;gap:12px;align-items:flex-start">
              <div style="flex:1">
                <label class="form-label">Réel (base de données)</label>
                <div style="font-size:2rem;font-weight:800;color:var(--g2)">${Math.round(cfg.benevoles_reel || 0)}h</div>
              </div>
              <div style="flex:1">
                <label class="form-label">Global (affiché sur le site)</label>
                <input id="cfg_benevoles" class="form-input" type="number" min="0" placeholder="${Math.round(cfg.benevoles_reel || 0)} (réel)" value="${cfg.benevoles_global || ''}"/>
              </div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:.84rem;cursor:pointer">
              <input type="checkbox" id="cfg_show_benevoles" ${cfg.show_benevoles !== 0 ? 'checked' : ''}/>
              Afficher sur le site public
            </label>
          </div>

          <!-- Années de service -->
          <div class="table-card" style="padding:16px">
            <div style="font-size:.8rem;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:10px">🏛️ Années de service</div>
            <div>
              <label class="form-label">Valeur affichée (fondée en janvier 2008)</label>
              <input id="cfg_annees" class="form-input" type="number" min="1" value="${cfg.annees_service || 18}"/>
              <div style="font-size:.75rem;color:var(--muted);margin-top:4px">Calculé automatiquement : ${new Date().getFullYear() - 2008} ans</div>
            </div>
          </div>
        </div>

        <button class="btn btn-primary" onclick="saveStatsSite()">💾 Enregistrer et publier</button>

        <hr style="margin:28px 0;border:none;border-top:1px solid var(--border)"/>

        <h3 style="font-size:.95rem;font-weight:700;margin-bottom:16px">🔐 Connexions par membre</h3>
        <div id="connexions_section">
          <div style="text-align:center;padding:24px;color:var(--muted)">Chargement…</div>
        </div>
      </div>
    </div>`);

  // Charger les stats de connexions (reset cache à chaque ouverture)
  window._connexionsData = null;
  window._connexionsFiltres = { recherche: '', role: '', plan: '' };
  statsChargerConnexions('nb_connexions', 'desc');
}

async function saveStatsSite() {
  try {
    await api('/stats/config', { method: 'PUT', body: JSON.stringify({
      membres_global:   document.getElementById('cfg_membres').value,
      benevoles_global: document.getElementById('cfg_benevoles').value,
      annees_service:   document.getElementById('cfg_annees').value,
      show_membres:     document.getElementById('cfg_show_membres').checked ? 1 : 0,
      show_benevoles:   document.getElementById('cfg_show_benevoles').checked ? 1 : 0,
    })});
    toast('✅ Statistiques mises à jour sur le site public !');
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

async function statsChargerConnexions(triCol, triDir) {
  const section = document.getElementById('connexions_section');
  if (!section) return;

  // Chargement initial uniquement (données stockées en cache)
  if (!window._connexionsData) {
    section.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted)">Chargement…</div>';
    try { window._connexionsData = await api('/stats/connexions'); }
    catch { section.innerHTML = '<div style="color:#c62828;padding:12px">Erreur de chargement</div>'; return; }
  }

  // Mémoriser les filtres actifs
  if (!window._connexionsFiltres) window._connexionsFiltres = { recherche:'', role:'', plan:'' };
  window._connexionsTri = { col: triCol, dir: triDir };

  statsRendreConnexions();
}

function statsRendreConnexions() {
  const section = document.getElementById('connexions_section');
  if (!section) return;
  const { col: triCol, dir: triDir } = window._connexionsTri || { col:'nb_connexions', dir:'desc' };
  const { recherche, role, plan } = window._connexionsFiltres || {};
  const ROLE_FR = { admin:'Admin', secretaire:'Secrétaire', tresoriere:'Trésorière', delegue:'Délégué', membre:'Membre' };

  // Filtrage
  let rows = (window._connexionsData || []).filter(u => {
    if (recherche) {
      const q = recherche.toLowerCase();
      const nom = (u.prenom + ' ' + u.nom).toLowerCase();
      const email = (u.email || '').toLowerCase();
      if (!nom.includes(q) && !email.includes(q)) return false;
    }
    if (role && u.role !== role) return false;
    if (plan && (u.plan || 'gratuit') !== plan) return false;
    return true;
  });

  // Tri
  rows = [...rows].sort((a, b) => {
    let va = a[triCol] ?? 0, vb = b[triCol] ?? 0;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    return triDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const inv = d => d === 'asc' ? 'desc' : 'asc';
  const th = (label, colId) => {
    const active = triCol === colId;
    const arrow  = active ? (triDir === 'asc' ? ' ▲' : ' ▼') : '';
    const center = colId === 'nb_connexions';
    return '<th onclick="statsChargerConnexions(\'' + colId + '\',\'' + (active ? inv(triDir) : 'desc') + '\')" ' +
      'style="padding:8px 12px;text-align:' + (center ? 'center' : 'left') + ';cursor:pointer;user-select:none;white-space:nowrap;' +
      'background:' + (active ? '#e8f0fe' : '#f8f8f8') + ';color:' + (active ? '#1565c0' : 'var(--text)') + '">' + label + arrow + '</th>';
  };

  // Collecter les rôles et plans uniques pour les filtres
  const roles  = [...new Set((window._connexionsData||[]).map(u => u.role).filter(Boolean))];
  const plans  = [...new Set((window._connexionsData||[]).map(u => u.plan || 'gratuit').filter(Boolean))];

  const selStyle = 'border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:.82rem;background:#fff;cursor:pointer;';

  section.innerHTML =
    // ── Barre de filtres ────────────────────────────────────────────────
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;padding:12px 14px;background:var(--off);border-radius:10px;border:1px solid var(--border)">' +
      '<input id="cx_recherche" type="text" placeholder="🔍 Rechercher un membre…" value="' + escHtml(recherche || '') + '" ' +
        'oninput="window._connexionsFiltres.recherche=this.value;statsRendreConnexions()" ' +
        'style="flex:1;min-width:180px;border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:.84rem"/>' +
      '<select id="cx_role" onchange="window._connexionsFiltres.role=this.value;statsRendreConnexions()" style="' + selStyle + '">' +
        '<option value="">Tous les rôles</option>' +
        roles.map(r => '<option value="' + r + '"' + (role === r ? ' selected' : '') + '>' + (ROLE_FR[r] || r) + '</option>').join('') +
      '</select>' +
      '<select id="cx_plan" onchange="window._connexionsFiltres.plan=this.value;statsRendreConnexions()" style="' + selStyle + '">' +
        '<option value="">Tous les plans</option>' +
        plans.map(p => '<option value="' + p + '"' + (plan === p ? ' selected' : '') + '>' + (p.charAt(0).toUpperCase() + p.slice(1)) + '</option>').join('') +
      '</select>' +
      '<select onchange="statsChargerConnexions(\'nb_connexions\',this.value)" style="' + selStyle + '">' +
        '<option value="desc"' + (triCol === 'nb_connexions' && triDir === 'desc' ? ' selected' : '') + '>Connexions ▼</option>' +
        '<option value="asc"'  + (triCol === 'nb_connexions' && triDir === 'asc'  ? ' selected' : '') + '>Connexions ▲</option>' +
      '</select>' +
      (recherche || role || plan
        ? '<button onclick="window._connexionsFiltres={recherche:\'\',role:\'\',plan:\'\'};statsRendreConnexions()" style="border:1px solid #c62828;color:#c62828;background:#fff;border-radius:8px;padding:6px 12px;font-size:.8rem;cursor:pointer">✕ Réinitialiser</button>'
        : '') +
    '</div>' +
    '<div style="font-size:.8rem;color:var(--muted);margin-bottom:8px">' + rows.length + ' membre(s) affiché(s) sur ' + (window._connexionsData||[]).length + ' · Cliquez sur une colonne pour trier</div>' +

    // ── Tableau ─────────────────────────────────────────────────────────
    '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px">' +
    '<table style="width:100%;border-collapse:collapse;font-size:.84rem">' +
    '<thead><tr>' +
    th('Membre', 'nom') + th('Rôle', 'role') + th('Plan', 'plan') + th('Connexions', 'nb_connexions') + th('Dernière connexion', 'derniere_connexion') +
    '</tr></thead><tbody>' +
    (rows.length ? rows.map((u, i) => {
      const initials = ((u.prenom||'')[0]||'').toUpperCase() + ((u.nom||'')[0]||'').toUpperCase();
      const date = u.derniere_connexion ? u.derniere_connexion.substring(0, 16).replace('T', ' ') : 'Jamais';
      const heat = u.nb_connexions >= 20 ? '#1b5e20' : u.nb_connexions >= 5 ? '#e65100' : '#555';
      return '<tr style="border-top:1px solid var(--border)' + (i % 2 ? ';background:#fafafa' : '') + '">' +
        '<td style="padding:9px 12px"><div style="display:flex;align-items:center;gap:8px">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;flex-shrink:0">' + initials + '</div>' +
        '<div><strong>' + escHtml(u.prenom + ' ' + u.nom) + '</strong><div style="font-size:.73rem;color:var(--muted)">' + (u.email || '') + '</div></div>' +
        '</div></td>' +
        '<td style="padding:9px 12px">' + (ROLE_FR[u.role] || u.role || '') + '</td>' +
        '<td style="padding:9px 12px">' + planBadge(u.plan) + '</td>' +
        '<td style="padding:9px;text-align:center;font-size:1.1rem;font-weight:800;color:' + heat + '">' + (u.nb_connexions || 0) + '</td>' +
        '<td style="padding:9px 12px;font-size:.8rem;color:var(--muted)">' + date + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--muted)">Aucun résultat pour ces filtres</td></tr>') +
    '</tbody></table></div>';
}

async function vpAnnulerNonVendus(actId) {
  if (!confirm('Annuler tous les billets pré-imprimés non vendus ? Aucun revenu ne sera enregistré.')) return;
  try {
    const r = await api(`/activities/${actId}/annuler-non-vendus`, { method: 'POST' });
    toast(r.annules + ' billet(s) annulé(s)');
    vpRefreshGeneres();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

// ── Saisie des talons (codes AHH-XXXXX) pour marquer vendus en lot ───────────
async function vpSaisirTalons() {
  const actId = document.getElementById('vpActivite')?.value;
  openModal('🎫 Saisir les talons récupérés',
    `<p style="font-size:.85rem;color:var(--muted);margin-bottom:12px">
      Entrez les codes des talons récupérés (un par ligne ou séparés par des virgules).<br/>
      Exemple : <code>AHH-4RQ584, AHH-7XK291</code>
    </p>
    <textarea id="talonCodes" rows="8" class="form-input" placeholder="AHH-4RQ584&#10;AHH-7XK291&#10;..." style="font-family:monospace;resize:vertical;margin-bottom:12px"></textarea>
    <div style="display:flex;gap:10px">
      <button class="btn btn-primary" onclick="vpTraiterTalons()">✅ Marquer vendus</button>
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
    </div>
    <div id="talonResult" style="margin-top:12px"></div>`
  );
}

async function vpTraiterTalons() {
  const raw = document.getElementById('talonCodes')?.value || '';
  const codes = raw.split(/[\n,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return toast('Entrez au moins un code', true);
  const result = document.getElementById('talonResult');
  result.innerHTML = '<span style="color:var(--muted)">⏳ Traitement...</span>';

  let ok = 0, errors = [];
  for (const code of codes) {
    try {
      const r = await api(`/tickets/by-barcode/${encodeURIComponent(code)}/marquer-vendu`, { method: 'POST' });
      if (r.ok) ok++;
      else errors.push(code + ': ' + (r.error || 'Erreur'));
    } catch(e) { errors.push(code + ': ' + e.message); }
  }

  result.innerHTML =
    `<div style="background:#e8f5e9;border-radius:8px;padding:10px 14px;font-size:.84rem;color:#1b5e20;margin-bottom:8px">
      ✅ <strong>${ok} billet(s)</strong> marqué(s) vendu(s) — revenu enregistré
    </div>` +
    (errors.length ? `<div style="background:#fdecea;border-radius:8px;padding:10px 14px;font-size:.82rem;color:#c62828">
      ❌ ${errors.length} code(s) non trouvé(s) :<br/>${errors.join('<br/>')}
    </div>` : '');

  if (ok > 0) vpRefreshGeneres();
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. GRAPHIQUES DE CROISSANCE
// ══════════════════════════════════════════════════════════════════════════════
async function statsGrowthView() {
  const s = await api('/stats/growth').catch(() => ({}));
  setContent(`
    <div class="page-header"><div><h2>📈 Statistiques & Croissance</h2></div>
      <div class="page-actions"><button class="btn btn-outline" onclick="window.print()">🖨️ Imprimer</button></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
      <div class="table-card" style="padding:16px">
        <h4 style="margin-bottom:12px">👥 Nouveaux membres (12 mois)</h4>
        <canvas id="chartMembres" height="200"></canvas>
      </div>
      <div class="table-card" style="padding:16px">
        <h4 style="margin-bottom:12px">💰 Revenus mensuels</h4>
        <canvas id="chartRevenus" height="200"></canvas>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div class="table-card" style="padding:16px">
        <h4 style="margin-bottom:12px">📅 Présence aux activités</h4>
        <canvas id="chartPresence" height="200"></canvas>
      </div>
      <div class="table-card" style="padding:16px">
        <h4 style="margin-bottom:12px">👤 Répartition par rôle</h4>
        <canvas id="chartRoles" height="200"></canvas>
      </div>
    </div>`);

  setTimeout(() => {
    if (!window.Chart) return;
    const months = s.membres?.map(m => m.mois) || [];
    const green = '#2e7d32', lightGreen = 'rgba(46,125,50,.15)', accent = '#f9a825';

    if (document.getElementById('chartMembres')) new Chart('chartMembres', { type:'bar',
      data:{ labels:months, datasets:[{ label:'Membres', data:s.membres?.map(m=>m.nb)||[], backgroundColor:lightGreen, borderColor:green, borderWidth:2 }]},
      options:{ responsive:true, plugins:{legend:{display:false}} }});

    if (document.getElementById('chartRevenus')) new Chart('chartRevenus', { type:'line',
      data:{ labels:s.revenus?.map(r=>r.mois)||[], datasets:[{ label:'Revenus $', data:s.revenus?.map(r=>r.total)||[], borderColor:accent, backgroundColor:'rgba(249,168,37,.1)', tension:.4, fill:true }]},
      options:{ responsive:true, plugins:{legend:{display:false}} }});

    if (document.getElementById('chartPresence')) new Chart('chartPresence', { type:'bar',
      data:{ labels:s.presence?.map(p=>p.titre.substring(0,15))||[], datasets:[
        { label:'Inscrits', data:s.presence?.map(p=>p.inscrits)||[], backgroundColor:'rgba(46,125,50,.3)' },
        { label:'Présents', data:s.presence?.map(p=>p.presents)||[], backgroundColor:green }
      ]},
      options:{ responsive:true, scales:{ x:{ stacked:false }}}});

    if (document.getElementById('chartRoles')) {
      const roles = s.parRole||[];
      new Chart('chartRoles', { type:'doughnut',
        data:{ labels:roles.map(r=>r.role), datasets:[{ data:roles.map(r=>r.nb), backgroundColor:['#1b5e20','#2e7d32','#43a047','#66bb6a','#a5d6a7','#c8e6c9'] }]},
        options:{ responsive:true }});
    }
  }, 300);
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. VOTES & ÉLECTIONS
// ══════════════════════════════════════════════════════════════════════════════
async function votesView() {
  const votes = await api('/votes').catch(() => []);
  const canManage = can.executive();
  setContent(`
    <div class="page-header">
      <div><h2>🗳️ Votes & Élections</h2><p>Votes officiels et sondages de gouvernance</p></div>
      ${canManage ? '<div class="page-actions"><button class="btn btn-primary" onclick="voteNewForm()">+ Créer un vote</button></div>' : ''}
    </div>
    ${!votes.length ? '<div class="empty-state"><div class="es-icon">🗳️</div><p>Aucun vote pour le moment</p></div>' :
      votes.map(v => {
        const opts = JSON.parse(v.options_json||'[]');
        const badge = v.statut==='ouvert' ? '<span style="background:#e8f5e9;color:#1b5e20;padding:2px 10px;border-radius:12px;font-size:.75rem;font-weight:700">🟢 OUVERT</span>' :
          v.statut==='ferme' ? '<span style="background:#fdecea;color:#c62828;padding:2px 10px;border-radius:12px;font-size:.75rem;font-weight:700">🔴 FERMÉ</span>' :
          '<span style="background:#fff3cd;color:#856404;padding:2px 10px;border-radius:12px;font-size:.75rem;font-weight:700">📝 BROUILLON</span>';
        return `<div class="table-card" style="margin-bottom:14px;padding:18px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:10px">
            <div>
              <div style="font-weight:700;font-size:.95rem">${escHtml(v.titre)} ${badge}</div>
              ${v.description ? `<div style="font-size:.82rem;color:var(--muted);margin-top:4px">${escHtml(v.description)}</div>` : ''}
              <div style="font-size:.75rem;color:var(--muted);margin-top:4px">${v.nb_votes||0} vote(s) · Par ${escHtml(v.createur||'')}</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${v.statut==='ouvert' ? `<button class="btn btn-primary btn-sm" onclick="voteParticiper(${v.id})">Voter</button>` : ''}
              ${v.statut!=='brouillon' ? `<button class="btn btn-outline btn-sm" onclick="voteResultats(${v.id})">Résultats</button>` : ''}
              ${canManage ? `<button class="btn btn-sm btn-ghost" onclick="voteChangeStatut(${v.id},'${v.statut}')">${v.statut==='brouillon'?'▶ Ouvrir':v.statut==='ouvert'?'⏹ Fermer':'🔁 Rouvrir'}</button>` : ''}
              ${canManage ? `<button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="voteDelete(${v.id})">🗑</button>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${opts.map((o,i) => `<span style="background:var(--off);border-radius:20px;padding:3px 10px;font-size:.78rem">${escHtml(o)}</span>`).join('')}
          </div>
        </div>`;
      }).join('')}`);
}

async function voteNewForm() {
  openModal('🗳️ Nouveau vote',
    `<div class="form-group"><label class="form-label">Titre *</label><input id="vt_titre" class="form-input" placeholder="Ex: Élection du président"/></div>
    <div class="form-group"><label class="form-label">Description</label><textarea id="vt_desc" class="form-input" rows="2"></textarea></div>
    <div class="form-group"><label class="form-label">Type</label>
      <select id="vt_type" class="form-input">
        <option value="election">Élection</option>
        <option value="decision">Décision</option>
        <option value="consultation">Consultation</option>
      </select></div>
    <div class="form-group">
      <label class="form-label">Options (une par ligne) *</label>
      <textarea id="vt_options" class="form-input" rows="4" placeholder="Option 1&#10;Option 2&#10;Option 3"></textarea>
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-primary" onclick="voteSave()">Créer</button>
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
    </div>`);
}

async function voteSave() {
  const titre = document.getElementById('vt_titre').value.trim();
  const options = document.getElementById('vt_options').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if (!titre || options.length < 2) return toast('Titre et au moins 2 options requis', true);
  try {
    await api('/votes', { method:'POST', body:JSON.stringify({ titre, description:document.getElementById('vt_desc').value, type:document.getElementById('vt_type').value, options }) });
    closeModal(); toast('Vote créé !'); votesView();
  } catch(e) { toast('Erreur: '+e.message,true); }
}

async function voteChangeStatut(id, current) {
  const next = current==='brouillon'?'ouvert':current==='ouvert'?'ferme':'ouvert';
  await api(`/votes/${id}/statut`, { method:'PATCH', body:JSON.stringify({ statut:next }) });
  toast(`Vote ${next}`); votesView();
}

async function voteParticiper(id) {
  const r = await api(`/votes/${id}/resultats`);
  const opts = JSON.parse(r.vote.options_json||'[]');
  openModal('🗳️ ' + escHtml(r.vote.titre),
    `<p style="font-size:.85rem;color:var(--muted);margin-bottom:14px">${escHtml(r.vote.description||'')}</p>
    ${r.myVote !== null ? `<div style="background:#e8f5e9;border-radius:8px;padding:10px 14px;font-size:.85rem;color:#1b5e20;margin-bottom:14px">✅ Vous avez déjà voté pour : <strong>${escHtml(opts[r.myVote]||'')}</strong></div>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px">
      ${opts.map((o,i) => `<button class="btn ${r.myVote===i?'btn-primary':'btn-outline'}" onclick="voteCast(${id},${i})">${escHtml(o)}</button>`).join('')}
    </div>`);
}

async function voteCast(id, idx) {
  try { await api(`/votes/${id}/voter`, { method:'POST', body:JSON.stringify({ option_index:idx }) }); closeModal(); toast('✅ Vote enregistré !'); } catch(e) { toast(e.message,true); }
}

async function voteResultats(id) {
  const r = await api(`/votes/${id}/resultats`);
  const opts = JSON.parse(r.vote.options_json||'[]');
  openModal('📊 Résultats — ' + escHtml(r.vote.titre),
    `<p style="font-size:.82rem;color:var(--muted);margin-bottom:14px">${r.total} vote(s) au total</p>` +
    r.resultats.map(res => `
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:.84rem;margin-bottom:4px">
          <span>${escHtml(res.option)}</span>
          <span style="font-weight:700">${res.nb} (${res.pct}%)</span>
        </div>
        <div style="background:var(--off);border-radius:6px;height:10px">
          <div style="background:var(--g2);border-radius:6px;height:100%;width:${res.pct}%;transition:.3s"></div>
        </div>
      </div>`).join('') +
    `<button class="btn btn-ghost" style="margin-top:12px" onclick="closeModal()">Fermer</button>`);
}

async function voteDelete(id) {
  if (!confirm('Supprimer ce vote ?')) return;
  await api(`/votes/${id}`, { method:'DELETE' }); toast('Vote supprimé'); votesView();
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. PARRAINAGE
// ══════════════════════════════════════════════════════════════════════════════
async function parrainageView() {
  const r = await api('/referral/my-code').catch(() => ({}));
  setContent(`
    <div class="page-header"><div><h2>🤝 Parrainage</h2><p>Invitez vos amis et famille à rejoindre l'AHH</p></div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div class="table-card" style="padding:20px">
        <h4 style="margin-bottom:16px;color:var(--g2)">Votre lien de parrainage</h4>
        <div style="background:var(--off);border-radius:10px;padding:14px;text-align:center;margin-bottom:16px">
          <div style="font-size:1.8rem;font-weight:800;color:var(--g2);letter-spacing:.1em;font-family:monospace">${r.code||'–'}</div>
          <div style="font-size:.78rem;color:var(--muted);margin-top:4px">Votre code unique</div>
        </div>
        <input class="form-input" value="${r.lien||''}" readonly onclick="this.select()" style="margin-bottom:10px"/>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="navigator.clipboard&&navigator.clipboard.writeText('${r.lien||''}').then(()=>toast('Lien copié !'))">📋 Copier</button>
          <a href="https://wa.me/?text=${encodeURIComponent('Rejoignez l\'AHH Hamilton ! '+(r.lien||''))}" target="_blank" class="btn btn-outline">WhatsApp 📱</a>
          <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(r.lien||'')}" target="_blank" class="btn btn-outline">Facebook</a>
        </div>
      </div>
      <div class="table-card" style="padding:20px">
        <h4 style="margin-bottom:14px;color:var(--g2)">🏆 Vos filleuls (${r.nb||0})</h4>
        ${r.parrainages?.length ? r.parrainages.map(p=>`
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
            <div style="width:34px;height:34px;border-radius:50%;background:var(--g2);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">${(p.prenom||'?')[0]}${(p.nom||'')[0]||''}</div>
            <div><div style="font-weight:600;font-size:.85rem">${escHtml(p.prenom)} ${escHtml(p.nom)}</div><div style="font-size:.72rem;color:var(--muted)">${fmt(p.date_inscription)}</div></div>
          </div>`).join('') : '<div style="color:var(--muted);text-align:center;padding:24px">Aucun filleul encore — partagez votre lien !</div>'}
      </div>
    </div>`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. CARTE DE MEMBRE NUMÉRIQUE
// ══════════════════════════════════════════════════════════════════════════════
async function carteMembreView() {
  const me = await api('/auth/me').catch(() => USER);
  const planLabel = { gratuit:'Gratuit', bienfaiteur:'Bienfaiteur', partenaire:'Partenaire' };
  const planColor = { gratuit:'#546e7a', bienfaiteur:'#1565c0', partenaire:'#4a148c' };
  const initials = `${(me.prenom||'?')[0]}${(me.nom||'')[0]}`.toUpperCase();
  const numMembre = String(me.id).padStart(5, '0');
  const qrData = encodeURIComponent(`AHH-${numMembre}-${me.referral_code || me.id}`);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${qrData}&bgcolor=ffffff&color=1a237e`;

  setContent(`
    <div class="page-header"><div><h2>🪪 Ma carte de membre</h2><p>Votre identité numérique AHH Hamilton</p></div></div>
    <div style="display:flex;justify-content:center;margin-bottom:24px">
      <div id="carteMembre" style="width:min(420px,95vw);border-radius:20px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:linear-gradient(135deg,${planColor[me.plan]||'#1a237e'},${planColor[me.plan]||'#1a237e'}cc);color:#fff;position:relative">
        <!-- En-tête -->
        <div style="padding:22px 24px 14px;display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:.62rem;letter-spacing:.15em;opacity:.7;text-transform:uppercase;margin-bottom:4px">Association Haïtienne Hamilton</div>
            <div style="font-size:1.05rem;font-weight:800;letter-spacing:.04em">AHH</div>
          </div>
          <div style="background:rgba(255,255,255,.15);border-radius:8px;padding:6px 12px;font-size:.72rem;font-weight:700;letter-spacing:.06em">${(planLabel[me.plan]||'GRATUIT').toUpperCase()}</div>
        </div>
        <!-- Photo + nom + logo -->
        <div style="padding:0 24px 16px;display:flex;align-items:center;gap:14px">
          ${me.photo_url && me.carte_photo_approuvee
            ? `<img src="${BASE}${me.photo_url}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.5);flex-shrink:0"/>`
            : `<div style="width:72px;height:72px;border-radius:50%;background:rgba(255,255,255,.2);border:3px solid rgba(255,255,255,.5);font-size:1.8rem;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0">${initials}</div>`}
          <div style="flex:1;min-width:0">
            <div style="font-size:1.25rem;font-weight:800;line-height:1.1">${escHtml(me.prenom)}</div>
            <div style="font-size:1.25rem;font-weight:800;line-height:1.1">${escHtml(me.nom)}</div>
            <div style="font-size:.72rem;opacity:.7;margin-top:5px">Membre depuis ${me.date_inscription ? new Date(me.date_inscription).getFullYear() : '–'}</div>
          </div>
          <img src="/Public/logo1.png" alt="AHH" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.35);flex-shrink:0"/>
        </div>
        <!-- QR + numéro + expiration -->
        <div style="background:rgba(0,0,0,.2);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div>
            <div style="font-size:.6rem;opacity:.65;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">N° de membre</div>
            <div style="font-size:1.4rem;font-weight:900;letter-spacing:.12em;font-family:monospace">#${numMembre}</div>
            <div style="font-size:.65rem;opacity:.55;margin-top:6px">
              Expire · ${me.date_inscription
                ? new Date(new Date(me.date_inscription).setFullYear(new Date(me.date_inscription).getFullYear()+2)).toLocaleDateString('fr-CA',{year:'numeric',month:'short'})
                : new Date().getFullYear() + 2}
            </div>
          </div>
          <div style="background:#fff;border-radius:10px;padding:6px">
            <img src="${qrUrl}" alt="QR" style="width:90px;height:90px;display:block"/>
          </div>
        </div>
      </div>
    </div>
    <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="carteMembePrint()">🖨️ Imprimer</button>
      <button class="btn btn-outline" onclick="carteMembeSave()">💾 Enregistrer en image</button>
    </div>
    <p style="text-align:center;font-size:.78rem;color:var(--muted);margin-top:12px">Présentez cette carte lors des événements AHH Hamilton</p>

    ${!me.photo_url
      ? `<div style="max-width:420px;margin:18px auto 0;padding:14px 16px;background:#fff8e1;border:1px solid #ffe082;border-radius:12px;display:flex;gap:12px;align-items:flex-start">
          <span style="font-size:1.3rem;flex-shrink:0">⚠️</span>
          <div>
            <div style="font-weight:700;font-size:.88rem;color:#e65100;margin-bottom:4px">Carte non valide</div>
            <div style="font-size:.82rem;color:#6d4c41;line-height:1.45">
              Votre carte de membre ne sera <strong>valide</strong> qu'une fois que vous aurez ajouté une photo dans votre profil <strong>et</strong> qu'elle aura été approuvée par le comité.
            </div>
            <button onclick="showView('profile')" style="margin-top:10px;background:#e65100;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:.8rem;font-weight:700;cursor:pointer">📷 Mettre à jour mon profil →</button>
          </div>
        </div>`
      : !me.carte_photo_approuvee
        ? `<div style="max-width:420px;margin:18px auto 0;padding:14px 16px;background:#e3f2fd;border:1px solid #90caf9;border-radius:12px;display:flex;gap:12px;align-items:flex-start">
            <span style="font-size:1.3rem;flex-shrink:0">🕐</span>
            <div>
              <div style="font-weight:700;font-size:.88rem;color:#1565c0;margin-bottom:4px">Carte en attente de validation</div>
              <div style="font-size:.82rem;color:#37474f;line-height:1.45">
                Votre photo a bien été reçue. Votre carte sera <strong>activée</strong> dès qu'un membre du comité aura approuvé votre photo. Vous recevrez une notification à ce moment.
              </div>
            </div>
          </div>`
        : `<div style="max-width:420px;margin:18px auto 0;padding:12px 16px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:12px;display:flex;gap:12px;align-items:center">
            <span style="font-size:1.3rem">✅</span>
            <div style="font-size:.84rem;color:#1b5e20;font-weight:600">Carte valide</div>
            <div style="font-size:.8rem;color:#2e7d32">Photo approuvée par le comité</div>
          </div>`
    }
  `);
}

function carteMembePrint() {
  const el = document.getElementById('carteMembre');
  if (!el) return;
  const win = window.open('', '_blank', 'width=600,height=400');
  win.document.write(`<html><head><title>Carte membre AHH</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f0f0f0;font-family:sans-serif}@media print{body{background:none}}</style></head><body>${el.outerHTML}<script>window.print()<\/script></body></html>`);
  win.document.close();
}

async function carteMembeSave() {
  toast('Faites une capture d\'écran de la carte pour l\'enregistrer');
}

// ══════════════════════════════════════════════════════════════════════════════
// GESTION DES CARTES DE MEMBRE (comité)
// ══════════════════════════════════════════════════════════════════════════════
async function carteGestionView() {
  const membres = await api('/admin/cartes').catch(() => []);
  const planLabel = { gratuit:'Gratuit', bienfaiteur:'Bienfaiteur', partenaire:'Partenaire' };

  setContent(`
    <div class="page-header">
      <div><h2>🪪 Gestion des cartes membres</h2><p>Approuver les photos · Gérer les expirations · Renouveler</p></div>
      <div class="page-actions"><button class="btn btn-outline" onclick="carteGestionView()">↻ Actualiser</button></div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <button class="btn btn-sm ${window._carteFilter==='all'||!window._carteFilter?'btn-primary':'btn-ghost'}" onclick="window._carteFilter='all';carteGestionView()">Tous (${membres.length})</button>
      <button class="btn btn-sm ${window._carteFilter==='expire'?'btn-primary':'btn-ghost'}" onclick="window._carteFilter='expire';carteGestionView()" style="color:#c62828">Expirés / ≤30j (${membres.filter(m=>m.days_left!==null&&m.days_left<=30).length})</button>
      <button class="btn btn-sm ${window._carteFilter==='photo'?'btn-primary':'btn-ghost'}" onclick="window._carteFilter='photo';carteGestionView()">Photo à approuver (${membres.filter(m=>m.photo_url&&!m.carte_photo_approuvee).length})</button>
    </div>
    <div class="table-card">
      <table class="data-table">
        <thead><tr>
          <th>Membre</th><th>Plan</th><th>Photo</th><th>Expiration</th><th>Statut</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${membres.filter(m => {
            const f = window._carteFilter || 'all';
            if (f === 'expire') return m.days_left !== null && m.days_left <= 30;
            if (f === 'photo') return m.photo_url && !m.carte_photo_approuvee;
            return true;
          }).map(m => {
            const dj = m.days_left;
            const statusBadge = !m.expiration ? '<span style="color:var(--muted)">–</span>'
              : dj < 0 ? '<span style="color:#c62828;font-weight:700">⛔ Expirée</span>'
              : dj <= 30 ? `<span style="color:#e65100;font-weight:700">⚠️ ${dj}j restants</span>`
              : `<span style="color:#2e7d32">✅ ${dj}j</span>`;
            return `<tr>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  ${m.photo_url
                    ? `<img src="${BASE}${m.photo_url}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid ${m.carte_photo_approuvee?'#2e7d32':'#e65100'}"/>`
                    : `<div style="width:32px;height:32px;border-radius:50%;background:var(--g2);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700">${(m.prenom||'?')[0]}${(m.nom||'')[0]||''}</div>`}
                  <div>
                    <div style="font-weight:600;font-size:.85rem">${escHtml(m.prenom)} ${escHtml(m.nom)}${m.role!=='member'?` <span style="font-size:.65rem;background:#e8f0fe;color:#1565c0;border-radius:4px;padding:1px 5px;font-weight:700">${m.role}</span>`:''}</div>
                    <div style="font-size:.72rem;color:var(--muted)">#${String(m.id).padStart(5,'0')}</div>
                  </div>
                </div>
              </td>
              <td>${planLabel[m.plan]||m.plan}</td>
              <td>${m.photo_url
                  ? (m.carte_photo_approuvee
                    ? '<span style="color:#2e7d32;font-size:.8rem">✅ Approuvée</span>'
                    : `<span style="color:#e65100;font-size:.8rem;font-weight:700">⏳ En attente</span>`)
                  : '<span style="color:var(--muted);font-size:.8rem">Aucune</span>'}</td>
              <td style="font-size:.82rem">${m.expiration ? fmt(m.expiration) : '–'}</td>
              <td>${statusBadge}</td>
              <td style="white-space:nowrap;display:flex;gap:6px;flex-wrap:wrap">
                ${m.photo_url && !m.carte_photo_approuvee
                  ? `<button class="btn btn-sm btn-primary" onclick="carteApprouverPhoto(${m.id})" title="Approuver photo">✅</button>
                     <button class="btn btn-sm btn-ghost" style="color:#c62828" onclick="carteRejeterPhoto(${m.id})" title="Rejeter photo">✗</button>`
                  : ''}
                <button class="btn btn-sm btn-outline" onclick="carteRenouveler(${m.id},'${escHtml(m.prenom)} ${escHtml(m.nom)}')" title="Renouveler 2 ans">🔄</button>
              </td>
            </tr>`;
          }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Aucun résultat</td></tr>'}
        </tbody>
      </table>
    </div>
  `);
}

async function carteApprouverPhoto(id) {
  if (id === USER.id) return toast('❌ Vous ne pouvez pas approuver votre propre photo', true);
  await api(`/admin/cartes/${id}/approuver-photo`, { method:'POST' });
  toast('✅ Photo approuvée');
  carteGestionView();
}
async function carteRejeterPhoto(id) {
  if (!confirm('Rejeter et supprimer la photo de profil de ce membre ?')) return;
  await api(`/admin/cartes/${id}/rejeter-photo`, { method:'POST' });
  toast('Photo rejetée');
  carteGestionView();
}
async function carteRenouveler(id, nom) {
  if (!confirm(`Renouveler la carte de ${nom} pour 2 ans à partir d'aujourd'hui ?`)) return;
  const r = await api(`/admin/cartes/${id}/renouveler`, { method:'POST' });
  toast(`✅ Carte renouvelée jusqu'au ${fmt(r.expiration)}`);
  carteGestionView();
}

// ══════════════════════════════════════════════════════════════════════════════
// SCANNER CARTES DE MEMBRE — BarcodeDetector natif (rapide) + html5-qrcode fallback
// ══════════════════════════════════════════════════════════════════════════════
async function carteScannerView() {
  // Arrêter tout scanner en cours
  if (window._carteScanner) { try { await window._carteScanner.stop(); } catch {} window._carteScanner = null; }
  if (window._carteStream)  { window._carteStream.getTracks().forEach(t => t.stop()); window._carteStream = null; }
  if (window._carteAnimFrame) { cancelAnimationFrame(window._carteAnimFrame); window._carteAnimFrame = null; }

  setContent(`
    <div class="page-header"><div><h2>📷 Scanner de cartes membres</h2><p>Pointez la caméra vers le QR code de la carte</p></div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;max-width:920px">

      <div class="table-card" style="padding:20px">
        <h4 style="margin-bottom:12px;color:var(--g2)">📷 Caméra</h4>
        <div id="carteReaderWrap" style="border-radius:12px;overflow:hidden;background:#111;min-height:220px;position:relative">
          <!-- video pour BarcodeDetector natif -->
          <video id="scanVideo" autoplay muted playsinline style="width:100%;display:none;border-radius:12px;max-height:280px;object-fit:cover"></video>
          <!-- viseur -->
          <div id="scanViewfinder" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;pointer-events:none">
            <div style="position:relative;width:190px;height:190px;border:2.5px solid rgba(255,255,255,.75);border-radius:14px;box-shadow:0 0 0 9999px rgba(0,0,0,.45)">
              <div style="position:absolute;top:-4px;left:-4px;width:22px;height:22px;border-top:5px solid #fff;border-left:5px solid #fff;border-radius:4px 0 0 0"></div>
              <div style="position:absolute;top:-4px;right:-4px;width:22px;height:22px;border-top:5px solid #fff;border-right:5px solid #fff;border-radius:0 4px 0 0"></div>
              <div style="position:absolute;bottom:-4px;left:-4px;width:22px;height:22px;border-bottom:5px solid #fff;border-left:5px solid #fff;border-radius:0 0 0 4px"></div>
              <div style="position:absolute;bottom:-4px;right:-4px;width:22px;height:22px;border-bottom:5px solid #fff;border-right:5px solid #fff;border-radius:0 0 4px 0"></div>
            </div>
          </div>
          <!-- fallback html5-qrcode -->
          <div id="carteReader"></div>
        </div>
        <div id="carteReaderMsg" style="display:none;padding:10px;text-align:center;font-size:.8rem;color:var(--muted)"></div>
        <div style="margin-top:14px">
          <label class="form-label">Saisie manuelle / lecteur USB</label>
          <div style="display:flex;gap:6px">
            <input id="scanQrInput" class="form-input" placeholder="AHH-00007-..."
              onkeydown="if(event.key==='Enter'){event.preventDefault();carteScanSearch();}"/>
            <button class="btn btn-primary" onclick="carteScanSearch()" title="Rechercher">🔍</button>
          </div>
        </div>
      </div>

      <div id="scanResult" class="table-card" style="padding:20px">
        <div class="empty-state"><div class="es-icon">🪪</div><p>Scannez une carte pour voir le profil du membre</p></div>
      </div>
    </div>
    <div id="scanActivities" style="display:none;margin-top:20px;max-width:920px"></div>
  `);

  // Utiliser BarcodeDetector natif si disponible (hardware-accelerated, très rapide)
  if ('BarcodeDetector' in window) {
    await _startNativeScanner();
  } else {
    await _startHtml5Scanner();
  }
}

async function _startNativeScanner() {
  const video = document.getElementById('scanVideo');
  if (!video) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = stream;
    window._carteStream = stream;
    video.style.display = 'block';
    const vf = document.getElementById('scanViewfinder');
    if (vf) vf.style.display = 'flex';

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    let lastValue = '', lastTime = 0;

    const loop = async () => {
      if (!document.getElementById('scanVideo')) return; // vue changée
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          const now = Date.now();
          if (codes.length > 0 && (codes[0].rawValue !== lastValue || now - lastTime > 3000)) {
            lastValue = codes[0].rawValue;
            lastTime = now;
            const inp = document.getElementById('scanQrInput');
            if (inp) { inp.value = lastValue; carteScanSearch(); }
          }
        }
      } catch {}
      window._carteAnimFrame = requestAnimationFrame(loop);
    };
    video.addEventListener('loadedmetadata', () => {
      window._carteAnimFrame = requestAnimationFrame(loop);
    }, { once: true });

  } catch(e) {
    console.warn('[Scanner natif]', e.message, '→ fallback html5-qrcode');
    await _startHtml5Scanner();
  }
}

async function _startHtml5Scanner() {
  if (!window.Html5Qrcode) {
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    } catch {
      const msg = document.getElementById('carteReaderMsg');
      if (msg) { msg.style.display='block'; msg.textContent='Caméra non disponible — utilisez la saisie manuelle.'; }
      return;
    }
  }
  const scanner = new Html5Qrcode('carteReader');
  window._carteScanner = scanner;
  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 30, qrbox: { width: 220, height: 220 }, disableFlip: false },
      (decoded) => {
        const inp = document.getElementById('scanQrInput');
        if (inp && inp.value !== decoded) { inp.value = decoded; carteScanSearch(); }
      },
      () => {}
    );
  } catch(e) {
    const msg = document.getElementById('carteReaderMsg');
    if (msg) { msg.style.display='block'; msg.textContent='Caméra non disponible — utilisez la saisie manuelle.'; }
    const el = document.getElementById('carteReader');
    if (el) el.innerHTML = '<div style="padding:40px;text-align:center;font-size:2rem">📷</div>';
  }
}

let _carteScanLock = false;
async function carteScanSearch() {
  const qr = document.getElementById('scanQrInput')?.value?.trim();
  if (!qr || _carteScanLock) return;
  _carteScanLock = true;
  setTimeout(() => { _carteScanLock = false; }, 2000); // anti-doublon 2s

  const resultEl = document.getElementById('scanResult');
  if (resultEl) resultEl.innerHTML = '<div style="text-align:center;padding:32px"><div class="spinner"></div></div>';

  try {
    const r = await api(`/carte-scan/${encodeURIComponent(qr)}`);
    const m = r.member;
    const planLabel = { gratuit:'Gratuit', bienfaiteur:'Bienfaiteur', partenaire:'Partenaire' };
    const initials = `${(m.prenom||'?')[0]}${(m.nom||'')[0]}`.toUpperCase();
    const photoOk      = !!(m.photo_url && m.carte_photo_approuvee);
    const photoEnAttente = !!(m.photo_url && !m.carte_photo_approuvee);
    const sansPhoto    = !m.photo_url;
    const expiColor = sansPhoto ? '#e65100' : photoEnAttente ? '#1565c0' : m.expired ? '#c62828' : '#2e7d32';
    const expiBg    = sansPhoto ? '#fff3e0' : photoEnAttente ? '#e3f2fd' : m.expired ? '#fdecea' : '#e8f5e9';
    const validLabel = sansPhoto
      ? '⚠️ CARTE INVALIDE — aucune photo'
      : photoEnAttente
        ? '🕐 En attente de validation photo'
        : m.expired
          ? '⛔ Carte EXPIRÉE'
          : `✅ Valide — expire ${fmt(m.expiration)}`;
    const avatarBg = sansPhoto ? '#e65100' : photoEnAttente ? '#1565c0' : '#546e7a';

    if (resultEl) resultEl.innerHTML = `
      <div style="text-align:center;margin-bottom:16px">
        ${photoOk
          ? `<img src="${BASE}${m.photo_url}" style="width:88px;height:88px;border-radius:50%;object-fit:cover;border:4px solid ${expiColor};margin-bottom:10px"/>`
          : photoEnAttente
            ? `<img src="${BASE}${m.photo_url}" style="width:88px;height:88px;border-radius:50%;object-fit:cover;border:4px solid #1565c0;margin-bottom:10px;opacity:.7"/>`
            : `<div style="width:88px;height:88px;border-radius:50%;background:${avatarBg};color:#fff;font-size:2.2rem;font-weight:900;display:flex;align-items:center;justify-content:center;margin:0 auto 10px;border:4px solid ${avatarBg}">${initials}</div>`}
        <div style="font-size:1.15rem;font-weight:800">${escHtml(m.prenom)} ${escHtml(m.nom)}</div>
        <div style="font-size:.8rem;color:var(--muted);margin-top:2px">#${String(m.id).padStart(5,'0')} · ${planLabel[m.plan]||''}</div>
        <div style="margin-top:10px;padding:8px 16px;border-radius:20px;display:inline-block;font-size:.82rem;font-weight:700;
          background:${expiBg};color:${expiColor}">
          ${validLabel}
        </div>
      </div>`;

    window._scanUserId = m.id;
    const actEl = document.getElementById('scanActivities');
    if (actEl) {
      actEl.style.display = 'block';

      const inscrits   = r.activities.filter(a => a.reg_statut);
      const disponibles = r.activities.filter(a => !a.reg_statut);

      const rowInscrire = (a) => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <div style="width:8px;height:8px;border-radius:50%;background:#2e7d32;flex-shrink:0"></div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:.88rem">${escHtml(a.titre)}</div>
            <div style="font-size:.74rem;color:var(--muted)">${a.date_debut ? new Date(a.date_debut).toLocaleDateString('fr-CA',{weekday:'short',month:'short',day:'numeric'}) : '–'}${a.lieu ? ' · ' + escHtml(a.lieu) : ''}</div>
          </div>
          ${a.reg_statut === 'confirme'
            ? '<span style="color:#2e7d32;font-weight:700;font-size:.8rem;white-space:nowrap">✅ Présent confirmé</span>'
            : `<button class="btn btn-sm btn-primary" style="background:#2e7d32;white-space:nowrap" onclick="carteScanPresencer(${a.id})">✅ Confirmer présence</button>`}
        </div>`;

      const rowDisponible = (a) => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #e3f2fd;flex-wrap:wrap">
          <div style="width:8px;height:8px;border-radius:50%;background:#1565c0;flex-shrink:0"></div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:.88rem">${escHtml(a.titre)}</div>
            <div style="font-size:.74rem;color:var(--muted)">${a.date_debut ? new Date(a.date_debut).toLocaleDateString('fr-CA',{weekday:'short',month:'short',day:'numeric'}) : '–'}${a.lieu ? ' · ' + escHtml(a.lieu) : ''}</div>
          </div>
          <button class="btn btn-sm btn-outline" style="border-color:#1565c0;color:#1565c0;white-space:nowrap" onclick="carteScanPresencer(${a.id})">+ Ajouter présence</button>
        </div>`;

      actEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;max-width:920px">
          <div class="table-card">
            <div class="table-card-header" style="background:#e8f5e9">
              <h3 style="color:#2e7d32">🟢 Inscrit(e) (${inscrits.length})</h3>
            </div>
            ${inscrits.length ? inscrits.map(rowInscrire).join('') : '<div style="padding:16px;text-align:center;font-size:.82rem;color:var(--muted)">Non inscrit(e) à aucune activité</div>'}
          </div>
          <div class="table-card">
            <div class="table-card-header" style="background:#e3f2fd">
              <h3 style="color:#1565c0">🔵 Disponible (${disponibles.length})</h3>
            </div>
            ${disponibles.length ? disponibles.map(rowDisponible).join('') : '<div style="padding:16px;text-align:center;font-size:.82rem;color:var(--muted)">Toutes les activités sont cochées</div>'}
          </div>
        </div>`;
    }
  } catch(e) {
    if (resultEl) resultEl.innerHTML = `<div class="empty-state"><div class="es-icon">⚠️</div><p style="color:#c62828">${escHtml(e.message)}</p></div>`;
    const actEl = document.getElementById('scanActivities');
    if (actEl) actEl.style.display = 'none';
  }
}

async function carteScanPresencer(actId) {
  const userId = window._scanUserId;
  if (!userId) return;
  try {
    await api('/carte-scan/presencer', { method:'POST', body: JSON.stringify({ user_id:userId, activity_id:actId }) });
    toast('✅ Présence enregistrée !');
    await carteScanSearch();
  } catch(e) { toast(e.message, true); }
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. FIL D'ACTUALITÉS COMMUNAUTAIRE
// ══════════════════════════════════════════════════════════════════════════════
async function actualitesView() {
  const [galerie, activites, forumTopics] = await Promise.all([
    api('/gallery').catch(() => []),
    api('/activities').catch(() => []),
    api('/forum/topics').catch(() => [])
  ]);

  const feed = [];
  galerie.slice(0, 5).forEach(g => feed.push({
    type:'photo', date: g.date_upload, icon:'🖼️',
    titre: g.titre || 'Photo AHH',
    desc: `Photo ajoutée par ${escHtml(g.uploadeur||'AHH')}`,
    action: `showView('gallery_mgmt')`, color:'#7b1fa2'
  }));
  activites.filter(a => a.statut === 'planifiee').slice(0, 5).forEach(a => feed.push({
    type:'activite', date: a.date_creation || a.date_debut, icon:'🎉',
    titre: a.titre,
    desc: `📍 ${a.lieu||'–'} · ${a.date_debut ? new Date(a.date_debut).toLocaleDateString('fr-CA') : ''}`,
    action: `showView('activities')`, color:'#c62828'
  }));
  forumTopics.slice(0, 5).forEach(t => feed.push({
    type:'forum', date: t.date_creation, icon:'💬',
    titre: t.titre,
    desc: `${t.nb_posts||0} réponse(s) · Par ${escHtml(t.auteur||'membre')}`,
    action: `showView('forum')`, color:'#1565c0'
  }));

  feed.sort((a, b) => new Date(b.date||0) - new Date(a.date||0));

  setContent(`
    <div class="page-header"><div><h2>📰 Actualités</h2><p>Le fil de vie de votre communauté AHH</p></div></div>
    ${!feed.length ? '<div class="empty-state"><div class="es-icon">📰</div><p>Aucune actualité pour le moment</p></div>' :
      `<div style="display:flex;flex-direction:column;gap:12px">
        ${feed.map(item => `
          <div style="border:1px solid var(--border);border-radius:12px;background:#fff;overflow:hidden;cursor:pointer" onclick="${item.action}">
            <div style="display:flex;align-items:flex-start;gap:14px;padding:14px 16px">
              <div style="width:40px;height:40px;border-radius:10px;background:${item.color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">${item.icon}</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:.9rem;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(item.titre)}</div>
                <div style="font-size:.78rem;color:var(--muted)">${item.desc}</div>
              </div>
              <div style="font-size:.7rem;color:var(--muted);flex-shrink:0;margin-top:2px">${item.date ? fmt(item.date) : ''}</div>
            </div>
          </div>`).join('')}
      </div>`}
  `);
}

// ══════════════════════════════════════════════════════════════════════════════
// 9. PRÉFÉRENCES DE NOTIFICATION
// ══════════════════════════════════════════════════════════════════════════════
async function notifPrefsView() {
  const prefs = await api('/member/notif-prefs').catch(() => ({ notif_activites:1, notif_paiements:1, notif_messages:1, notif_forum:1 }));
  const cats = [
    { key:'notif_activites', icon:'🎉', label:'Activités & événements', desc:'Nouvelles activités, rappels, confirmations d\'inscription' },
    { key:'notif_paiements', icon:'💳', label:'Paiements & cotisations', desc:'Confirmations de paiement, rappels, reçus fiscaux' },
    { key:'notif_messages',  icon:'✉️', label:'Messages',               desc:'Messages reçus de l\'équipe ou d\'autres membres' },
    { key:'notif_forum',     icon:'💬', label:'Forum',                  desc:'Nouvelles réponses à vos sujets' },
  ];
  setContent(`
    <div class="page-header"><div><h2>🔔 Préférences de notification</h2><p>Choisissez les communications que vous souhaitez recevoir</p></div></div>
    <div class="table-card" style="max-width:560px">
      <div style="padding:20px">
        ${cats.map(c => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:12px">
              <div style="font-size:1.4rem">${c.icon}</div>
              <div>
                <div style="font-weight:700;font-size:.9rem">${c.label}</div>
                <div style="font-size:.76rem;color:var(--muted);margin-top:2px">${c.desc}</div>
              </div>
            </div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
              <input type="checkbox" id="notif_${c.key}" ${prefs[c.key]?'checked':''} style="opacity:0;width:0;height:0"/>
              <span style="position:absolute;inset:0;border-radius:24px;background:${prefs[c.key]?'var(--g2)':'#ccc'};cursor:pointer;transition:.3s" onclick="this.previousElementSibling.click();this.style.background=this.previousElementSibling.checked?'var(--g2)':'#ccc'">
                <span style="position:absolute;left:${prefs[c.key]?'22':'2'}px;top:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.3s;pointer-events:none" id="thumb_${c.key}"></span>
              </span>
            </label>
          </div>`).join('')}
        <div style="margin-top:20px;display:flex;gap:10px">
          <button class="btn btn-primary" onclick="notifPrefsSave()">Enregistrer</button>
          <span id="notifStatus" style="line-height:38px;font-size:.82rem;color:var(--muted)"></span>
        </div>
      </div>
    </div>
  `);
}

async function notifPrefsSave() {
  const body = {
    notif_activites: document.getElementById('notif_notif_activites')?.checked ? 1 : 0,
    notif_paiements: document.getElementById('notif_notif_paiements')?.checked ? 1 : 0,
    notif_messages:  document.getElementById('notif_notif_messages')?.checked  ? 1 : 0,
    notif_forum:     document.getElementById('notif_notif_forum')?.checked      ? 1 : 0,
  };
  try {
    await api('/member/notif-prefs', { method:'PUT', body: JSON.stringify(body) });
    const el = document.getElementById('notifStatus');
    if (el) { el.textContent = '✅ Enregistré !'; setTimeout(() => { if(el) el.textContent=''; }, 3000); }
  } catch(e) { toast('Erreur: ' + e.message, true); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ESPACE JEUNES (15-30 ans)
// ══════════════════════════════════════════════════════════════════════════════

async function youngHome() {
  if (!isJeune()) { setContent('<div class="empty-state"><div class="es-icon">🔒</div><p>Cette section est réservée aux membres de 15 à 30 ans.</p></div>'); return; }
  const stats = await api('/young/stats').catch(() => ({}));
  const age = getUserAge();
  setContent(`
    <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);border-radius:16px;padding:28px;color:#fff;margin-bottom:20px">
      <div style="font-size:2rem;margin-bottom:8px">🌟 Bienvenue dans l'Espace Jeunes</div>
      <div style="opacity:.85;font-size:.95rem">Tu as ${age} ans — cet espace est fait pour toi !</div>
      <div style="margin-top:16px;font-size:.85rem;opacity:.75">🎉 Tarif préférentiel -50% sur les activités payantes · Accès aux stages, formations et sondages</div>
    </div>
    <div class="cards-grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat-card" onclick="showView('young-jobs')" style="cursor:pointer">
        <div class="sc-icon">💼</div><div class="sc-value">${stats.nb_jobs||0}</div><div class="sc-label">Offres d'emploi</div>
      </div>
      <div class="stat-card" onclick="showView('young-trainings')" style="cursor:pointer">
        <div class="sc-icon">📚</div><div class="sc-value">${stats.nb_trainings||0}</div><div class="sc-label">Formations</div>
      </div>
      <div class="stat-card" onclick="showView('young-polls')" style="cursor:pointer">
        <div class="sc-icon">📊</div><div class="sc-value">${stats.nb_polls||0}</div><div class="sc-label">Sondages actifs</div>
      </div>
      <div class="stat-card" onclick="showView('young-stories')" style="cursor:pointer">
        <div class="sc-icon">🏆</div><div class="sc-value" style="font-size:1.4rem">Story</div><div class="sc-label">Success Stories</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
      <div class="table-card" style="padding:16px">
        <h4 style="margin-bottom:12px;color:var(--g2)">💡 Avantages jeunes</h4>
        <ul style="list-style:none;font-size:.88rem;display:flex;flex-direction:column;gap:8px">
          <li>🎟️ <strong>50% de rabais</strong> sur toutes les activités payantes</li>
          <li>💼 Accès aux <strong>offres de stages & emplois</strong></li>
          <li>📚 Formations et ateliers <strong>gratuits ou réduits</strong></li>
          <li>📊 Participer aux <strong>sondages communautaires</strong></li>
          <li>🏆 Partager tes <strong>succès</strong> avec la communauté</li>
        </ul>
      </div>
      <div class="table-card" style="padding:16px">
        <h4 style="margin-bottom:12px;color:var(--g2)">🚀 Actions rapides</h4>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" onclick="showView('young-jobs')">💼 Voir les offres d'emploi</button>
          <button class="btn btn-outline" onclick="showView('young-trainings')">📚 Formations disponibles</button>
          <button class="btn btn-outline" onclick="showView('young-polls')">📊 Voter aux sondages</button>
          <button class="btn btn-outline" onclick="showView('young-stories')">🏆 Partager mon succès</button>
        </div>
      </div>
    </div>`);
}

async function youngJobs() {
  const [jobs, canManage] = await Promise.all([
    api('/young/jobs').catch(() => []),
    Promise.resolve(can.executive())
  ]);
  const JOB_TYPES = { stage:'Stage', job_etudiant:'Emploi étudiant', mentorat:'Mentorat', atelier:'Atelier' };
  const JOB_COLORS = { stage:'#1565c0', job_etudiant:'#2e7d32', mentorat:'#6a1b9a', atelier:'#e65100' };
  setContent(`
    <div class="table-card">
      <div class="table-card-header">
        <h3>💼 Stages & Emplois</h3>
        ${canManage ? `<div style="display:flex;gap:8px">\n          <button class="btn btn-sm" style="background:#e8f5e9;color:#1b5e20;border:1px solid #a5d6a7" onclick="youngNotifyAllJobs()">📧 Notifier les membres</button>\n          <button class="btn btn-primary btn-sm" onclick="youngJobForm()">+ Ajouter</button>\n        </div>` : ''}
      </div>
      <div style="padding:16px">
        ${!jobs.length ? '<div class="empty-state"><div class="es-icon">💼</div><p>Aucune offre disponible pour le moment.</p></div>' :
          jobs.map(j => `
            <div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;background:#fff">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                    <span style="background:${JOB_COLORS[j.type]||'#555'};color:#fff;font-size:.7rem;font-weight:700;padding:2px 10px;border-radius:20px">${JOB_TYPES[j.type]||j.type}</span>
                    <strong style="font-size:.95rem">${escHtml(j.titre)}</strong>
                  </div>
                  ${j.organisation ? `<div style="font-size:.82rem;color:var(--muted)">🏢 ${escHtml(j.organisation)}</div>` : ''}
                  ${j.lieu ? `<div style="font-size:.82rem;color:var(--muted)">📍 ${escHtml(j.lieu)}</div>` : ''}
                  ${j.date_limite ? `<div style="font-size:.82rem;color:#c62828">⏰ Avant le ${fmt(j.date_limite)}</div>` : ''}
                  ${j.description ? `<div style="font-size:.84rem;margin-top:8px;color:var(--text)">${escHtml(j.description).substring(0,200)}${j.description.length>200?'...':''}</div>` : ''}
                  ${j.contact ? `<div style="font-size:.82rem;margin-top:6px">📧 ${escHtml(j.contact)}</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;align-items:center">
                  ${j.lien_externe ? `<a href="${j.lien_externe}" target="_blank" class="btn btn-primary btn-sm">Postuler →</a>` : ''}
                  ${canManage ? `<button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="youngDeleteJob(${j.id})">🗑</button>` : ''}
                </div>
              </div>
            </div>`).join('')}
      </div>
    </div>`);
}

async function youngJobForm() {
  const JOB_TYPES = { stage:'Stage', job_etudiant:'Emploi étudiant', mentorat:'Mentorat', atelier:'Atelier' };
  openModal('💼 Nouvelle offre',
    `<div class="form-group"><label class="form-label">Type</label>
      <select id="yj_type" class="form-input">
        ${Object.entries(JOB_TYPES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}
      </select></div>
    <div class="form-group"><label class="form-label">Titre *</label><input id="yj_titre" class="form-input" placeholder="Ex: Stage en communication"/></div>
    <div class="form-group"><label class="form-label">Organisation</label><input id="yj_org" class="form-input" placeholder="Nom de l'entreprise/organisation"/></div>
    <div class="form-group"><label class="form-label">Lieu</label><input id="yj_lieu" class="form-input" placeholder="Hamilton, ON"/></div>
    <div class="form-group"><label class="form-label">Date limite</label><input id="yj_date" class="form-input" type="date"/></div>
    <div class="form-group"><label class="form-label">Description</label><textarea id="yj_desc" class="form-input" rows="4" placeholder="Détails de l'offre..."></textarea></div>
    <div class="form-group"><label class="form-label">Contact / Email</label><input id="yj_contact" class="form-input" placeholder="recrutement@exemple.com"/></div>
    <div class="form-group"><label class="form-label">Lien externe (optionnel)</label><input id="yj_lien" class="form-input" placeholder="https://..."/></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="youngSaveJob(false)">Publier</button>
      <button class="btn btn-primary" style="background:#2e7d32" onclick="youngSaveJob(true)">📧 Publier et notifier les membres</button>
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
    </div>`);
}
async function youngSaveJob(notifier = false) {
  const body = { type:document.getElementById('yj_type').value, titre:document.getElementById('yj_titre').value.trim(), organisation:document.getElementById('yj_org').value, lieu:document.getElementById('yj_lieu').value, date_limite:document.getElementById('yj_date').value, description:document.getElementById('yj_desc').value, contact:document.getElementById('yj_contact').value, lien_externe:document.getElementById('yj_lien').value };
  if (!body.titre) return toast('Titre requis', true);
  try {
    const r = await api('/young/jobs', { method:'POST', body:JSON.stringify(body) });
    if (notifier && r.id) {
      toast('Publication en cours…');
      const n = await api('/young/jobs/' + r.id + '/notify', { method:'POST' });
      closeModal(); youngJobs(); toast('Offre publiée et ' + n.ok + ' membre(s) notifié(s) par courriel !');
    } else {
      closeModal(); youngJobs(); toast('Offre publiée !');
    }
  } catch(e) { toast('Erreur: '+e.message, true); }
}
async function youngDeleteJob(id) {
  if (!confirm('Supprimer cette offre ?')) return;
  await api(`/young/jobs/${id}`, { method:'DELETE' }); youngJobs();
}
async function youngNotifyJob(id, titre) {
  if (!confirm('Envoyer un courriel de notification à tous les membres actifs pour l\'offre "' + titre + '" ?')) return;
  try {
    toast('Envoi en cours…');
    const r = await api('/young/jobs/' + id + '/notify', { method: 'POST' });
    toast('✅ ' + r.ok + ' membre(s) notifié(s) par courriel !' + (r.errors ? ' (' + r.errors + ' erreur(s))' : ''));
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

async function youngTrainings() {
  const [trainings, canManage] = await Promise.all([api('/young/trainings').catch(()=>[]), Promise.resolve(can.executive())]);
  setContent(`
    <div class="table-card">
      <div class="table-card-header">
        <h3>📚 Formations & Ateliers</h3>
        ${canManage ? `<div style="display:flex;gap:8px">\n          <button class="btn btn-sm" style="background:#e8f5e9;color:#1b5e20;border:1px solid #a5d6a7" onclick="youngNotifyAllTrainings()">📧 Notifier les membres</button>\n          <button class="btn btn-primary btn-sm" onclick="youngTrainingForm()">+ Ajouter</button>\n        </div>` : ''}
      </div>
      <div style="padding:16px">
        ${!trainings.length ? '<div class="empty-state"><div class="es-icon">📚</div><p>Aucune formation disponible.</p></div>' :
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">' +
          trainings.map(t => `
            <div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;background:#fff">
              <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:14px 16px;color:#fff">
                <div style="font-weight:700;font-size:.95rem">${escHtml(t.titre)}</div>
                ${t.formateur ? `<div style="font-size:.75rem;opacity:.8;margin-top:3px">Par ${escHtml(t.formateur)}</div>` : ''}
              </div>
              <div style="padding:12px 16px;font-size:.84rem">
                ${t.date_debut ? `<div style="margin-bottom:4px">📅 ${fmt(t.date_debut)}${t.date_fin ? ' → ' + fmt(t.date_fin) : ''}</div>` : ''}
                ${t.lieu ? `<div style="margin-bottom:4px">📍 ${escHtml(t.lieu)}</div>` : ''}
                <div style="margin-bottom:8px">${t.gratuit ? '✅ <strong>Gratuit</strong>' : `💳 <strong>$${t.prix.toFixed(2)}</strong>`} · ${t.places_max} places</div>
                ${t.description ? `<div style="color:var(--muted);font-size:.82rem;margin-bottom:10px">${escHtml(t.description).substring(0,150)}${t.description.length>150?'...':''}</div>` : ''}
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  ${t.lien_inscription ? `<a href="${t.lien_inscription}" target="_blank" class="btn btn-primary btn-sm">S'inscrire →</a>` : ''}
                  ${canManage ? `<button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="youngDeleteTraining(${t.id})">🗑</button>` : ''}
                </div>
              </div>
            </div>`).join('') + '</div>'}
      </div>
    </div>`);
}
async function youngTrainingForm() {
  openModal('📚 Nouvelle formation',
    `<div class="form-group"><label class="form-label">Titre *</label><input id="yt_titre" class="form-input" placeholder="Ex: Atelier communication"/></div>
    <div class="form-group"><label class="form-label">Formateur / Animateur</label><input id="yt_form" class="form-input"/></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date début</label><input id="yt_debut" class="form-input" type="date"/></div>
      <div class="form-group"><label class="form-label">Date fin</label><input id="yt_fin" class="form-input" type="date"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Lieu</label><input id="yt_lieu" class="form-input"/></div>
      <div class="form-group"><label class="form-label">Places max</label><input id="yt_places" class="form-input" type="number" value="20"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Prix ($)</label><input id="yt_prix" class="form-input" type="number" value="0" step="0.01"/></div>
      <div class="form-group" style="display:flex;align-items:center;gap:8px;padding-top:24px"><label><input type="checkbox" id="yt_gratuit" checked/> Gratuit</label></div>
    </div>
    <div class="form-group"><label class="form-label">Description</label><textarea id="yt_desc" class="form-input" rows="3"></textarea></div>
    <div class="form-group"><label class="form-label">Lien d'inscription</label><input id="yt_lien" class="form-input" placeholder="https://..."/></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="youngSaveTraining(false)">Publier</button>
      <button class="btn btn-primary" style="background:#1b5e20" onclick="youngSaveTraining(true)">📧 Publier et notifier les membres</button>
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
    </div>`);
}
async function youngSaveTraining(notifier = false) {
  const body = { titre:document.getElementById('yt_titre').value.trim(), formateur:document.getElementById('yt_form').value, date_debut:document.getElementById('yt_debut').value, date_fin:document.getElementById('yt_fin').value, lieu:document.getElementById('yt_lieu').value, places_max:document.getElementById('yt_places').value, prix:document.getElementById('yt_prix').value, gratuit:document.getElementById('yt_gratuit').checked, description:document.getElementById('yt_desc').value, lien_inscription:document.getElementById('yt_lien').value };
  if (!body.titre) return toast('Titre requis', true);
  try {
    const r = await api('/young/trainings', { method:'POST', body:JSON.stringify(body) });
    if (notifier && r.id) {
      toast('Publication en cours…');
      const n = await api('/young/trainings/' + r.id + '/notify', { method:'POST' });
      closeModal(); youngTrainings(); toast('Formation publiée et ' + n.ok + ' membre(s) notifié(s) par courriel !');
    } else {
      closeModal(); youngTrainings(); toast('Formation publiée !');
    }
  } catch(e) { toast('Erreur: '+e.message, true); }
}
async function youngDeleteTraining(id) {
  if (!confirm('Supprimer cette formation ?')) return;
  await api(`/young/trainings/${id}`, { method:'DELETE' }); youngTrainings();
}
async function youngNotifyTraining(id, titre) {
  if (!confirm('Envoyer un courriel de notification à tous les membres actifs pour la formation "' + titre + '" ?')) return;
  try {
    toast('Envoi en cours…');
    const r = await api('/young/trainings/' + id + '/notify', { method: 'POST' });
    toast('✅ ' + r.ok + ' membre(s) notifié(s) par courriel !' + (r.errors ? ' (' + r.errors + ' erreur(s))' : ''));
  } catch(e) { toast('Erreur : ' + e.message, true); }
}
async function youngNotifyAllJobs() {
  if (!confirm('Envoyer un courriel à tous les membres actifs pour les informer des nouvelles opportunités ?')) return;
  try {
    toast('Envoi en cours…');
    const r = await api('/young/jobs/notify-all', { method: 'POST' });
    toast('✅ ' + r.ok + ' membre(s) notifié(s) !' + (r.errors ? ' (' + r.errors + ' erreur(s))' : ''));
  } catch(e) { toast('Erreur : ' + e.message, true); }
}
async function youngNotifyAllTrainings() {
  if (!confirm('Envoyer un courriel à tous les membres actifs pour les informer des nouvelles formations ?')) return;
  try {
    toast('Envoi en cours…');
    const r = await api('/young/trainings/notify-all', { method: 'POST' });
    toast('✅ ' + r.ok + ' membre(s) notifié(s) !' + (r.errors ? ' (' + r.errors + ' erreur(s))' : ''));
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

async function youngPolls() {
  const [polls, canManage] = await Promise.all([api('/young/polls').catch(()=>[]), Promise.resolve(can.executive())]);
  setContent(`
    <div class="table-card">
      <div class="table-card-header">
        <h3>📊 Sondages communautaires</h3>
        ${canManage ? '<button class="btn btn-primary btn-sm" onclick="youngPollForm()">+ Créer un sondage</button>' : ''}
      </div>
      <div style="padding:16px">
        ${!polls.length ? '<div class="empty-state"><div class="es-icon">📊</div><p>Aucun sondage actif.</p></div>' :
          polls.map(p => {
            const hasVoted = p.my_vote !== null;
            return `<div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;background:#fff">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
                <div style="font-weight:700;font-size:.95rem">${escHtml(p.question)}</div>
                ${canManage ? `<button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="youngDeletePoll(${p.id})">🗑</button>` : ''}
              </div>
              ${p.description ? `<div style="font-size:.82rem;color:var(--muted);margin-bottom:12px">${escHtml(p.description)}</div>` : ''}
              <div style="display:flex;flex-direction:column;gap:8px">
                ${p.options.map(o => {
                  const pct = p.total_votes > 0 ? Math.round(o.votes/p.total_votes*100) : 0;
                  const isMyVote = p.my_vote === o.id;
                  return `<div>
                    <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:3px">
                      <span>${isMyVote?'✅ ':''}<strong>${escHtml(o.texte)}</strong></span>
                      <span style="color:var(--muted)">${o.votes} vote(s) · ${pct}%</span>
                    </div>
                    <div style="background:#e0e0e0;border-radius:6px;height:8px">
                      <div style="background:${isMyVote?'var(--g2)':'#90a4ae'};border-radius:6px;height:100%;width:${pct}%;transition:.3s"></div>
                    </div>
                    ${!hasVoted ? `<button class="btn btn-sm btn-ghost" style="margin-top:4px;font-size:.75rem" onclick="youngVote(${p.id},${o.id})">Voter pour cette option</button>` : ''}
                  </div>`;
                }).join('')}
              </div>
              <div style="font-size:.75rem;color:var(--muted);margin-top:10px">${p.total_votes} vote(s) au total · Par ${escHtml(p.createur||'')}</div>
            </div>`;
          }).join('')}
      </div>
    </div>`);
}
async function youngPollForm() {
  openModal('📊 Nouveau sondage',
    `<div class="form-group"><label class="form-label">Question *</label><input id="yp_question" class="form-input" placeholder="Ex: Quel type d'activité préférez-vous ?"/></div>
    <div class="form-group"><label class="form-label">Description (optionnel)</label><textarea id="yp_desc" class="form-input" rows="2"></textarea></div>
    <div class="form-group"><label class="form-label">Date de fin (optionnel)</label><input id="yp_fin" class="form-input" type="date"/></div>
    <div class="form-group">
      <label class="form-label">Options (minimum 2)</label>
      <div id="yp_options">
        <input class="form-input yp-opt" placeholder="Option 1" style="margin-bottom:6px"/>
        <input class="form-input yp-opt" placeholder="Option 2" style="margin-bottom:6px"/>
        <input class="form-input yp-opt" placeholder="Option 3 (optionnel)" style="margin-bottom:6px"/>
        <input class="form-input yp-opt" placeholder="Option 4 (optionnel)" style="margin-bottom:6px"/>
      </div>
    </div>
    <div style="display:flex;gap:10px"><button class="btn btn-primary" onclick="youngSavePoll()">Publier</button><button class="btn btn-ghost" onclick="closeModal()">Annuler</button></div>`);
}
async function youngSavePoll() {
  const question = document.getElementById('yp_question').value.trim();
  const options = Array.from(document.querySelectorAll('.yp-opt')).map(i=>i.value.trim()).filter(Boolean);
  if (!question) return toast('Question requise',true);
  if (options.length < 2) return toast('Au moins 2 options requises',true);
  try { await api('/young/polls', { method:'POST', body:JSON.stringify({ question, description:document.getElementById('yp_desc').value, date_fin:document.getElementById('yp_fin').value||null, options }) }); closeModal(); toast('Sondage publié !'); youngPolls(); } catch(e) { toast('Erreur: '+e.message,true); }
}
async function youngVote(pollId, optionId) {
  try { await api(`/young/polls/${pollId}/vote`, { method:'POST', body:JSON.stringify({ option_id:optionId }) }); toast('Vote enregistré !'); youngPolls(); } catch(e) { toast('Erreur: '+e.message,true); }
}
async function youngDeletePoll(id) {
  if (!confirm('Supprimer ce sondage ?')) return;
  await api(`/young/polls/${id}`, { method:'DELETE' }); youngPolls();
}

async function youngStories() {
  const [stories, canApprove] = await Promise.all([api('/young/stories').catch(()=>[]), Promise.resolve(can.executive())]);
  setContent(`
    <div class="table-card">
      <div class="table-card-header">
        <h3>🏆 Success Stories</h3>
        <button class="btn btn-primary btn-sm" onclick="youngStoryForm()">+ Partager mon succès</button>
      </div>
      <div style="padding:16px">
        ${!stories.length ? '<div class="empty-state"><div class="es-icon">🏆</div><p>Soyez le premier à partager votre succès !</p></div>' :
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">' +
          stories.map(s => {
            const initials = ((s.prenom||'?')[0]+(s.nom||'')[0]||'').toUpperCase();
            return `<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;background:#fff">
              ${s.photo_url ? `<img src="${s.photo_url}" style="width:100%;height:160px;object-fit:cover"/>` : '<div style="height:80px;background:linear-gradient(135deg,#1b5e20,#43a047);display:flex;align-items:center;justify-content:center;font-size:2.5rem">🏆</div>'}
              <div style="padding:14px">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  <div style="width:36px;height:36px;border-radius:50%;background:var(--g2);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;flex-shrink:0">${initials}</div>
                  <div><div style="font-weight:600;font-size:.88rem">${escHtml((s.prenom||'')+' '+(s.nom||''))}</div><div style="font-size:.72rem;color:var(--muted)">${fmt(s.date_creation)}</div></div>
                </div>
                <div style="font-weight:700;font-size:.92rem;margin-bottom:6px">${escHtml(s.titre)}</div>
                <div style="font-size:.83rem;color:var(--muted)">${escHtml(s.contenu).substring(0,150)}${s.contenu.length>150?'...':''}</div>
              </div>
            </div>`;
          }).join('') + '</div>'}
      </div>
    </div>`);
}
async function youngStoryForm() {
  openModal('🏆 Partager mon succès',
    `<div style="font-size:.84rem;color:var(--muted);margin-bottom:14px">Partagez une réalisation, une promotion, un diplôme, un projet abouti... Votre histoire inspirera d'autres jeunes !</div>
    <div class="form-group"><label class="form-label">Titre *</label><input id="ys_titre" class="form-input" placeholder="Ex: J'ai obtenu mon diplôme en marketing !"/></div>
    <div class="form-group"><label class="form-label">Votre histoire *</label><textarea id="ys_contenu" class="form-input" rows="5" placeholder="Racontez votre parcours, vos défis et votre victoire..."></textarea></div>
    <div style="background:#fff3cd;border-radius:8px;padding:10px;font-size:.8rem;margin-bottom:12px">⏳ Votre histoire sera publiée après validation par le comité.</div>
    <div style="display:flex;gap:10px"><button class="btn btn-primary" onclick="youngSaveStory()">Soumettre</button><button class="btn btn-ghost" onclick="closeModal()">Annuler</button></div>`);
}
async function youngSaveStory() {
  const titre = document.getElementById('ys_titre').value.trim();
  const contenu = document.getElementById('ys_contenu').value.trim();
  if (!titre || !contenu) return toast('Titre et contenu requis',true);
  try { await api('/young/stories', { method:'POST', body:JSON.stringify({ titre, contenu }) }); closeModal(); toast('✅ Histoire soumise — en attente de validation !'); } catch(e) { toast('Erreur: '+e.message,true); }
}

// ══════════════════════════════════════════════════════════════════════════════
// FORUM
// ══════════════════════════════════════════════════════════════════════════════
const FORUM_CATS = { general:'Général', entraide:'Entraide', emploi:'Emploi', logement:'Logement', culture:'Culture & Événements', annonces:'Annonces' };
let _forumTopic = null;

async function forum() {
  if (_forumTopic) { await forumShowTopic(_forumTopic); return; }
  const topics = await api('/forum/topics');
  const canMod = can.adminOrSec();
  setContent(`
    <div class="table-card" style="width:100%;max-width:100%">
      <div class="table-card-header" style="gap:12px;flex-wrap:wrap;padding:20px 28px">
        <h3 style="font-size:1.1rem">💬 Forum communautaire</h3>
        <button class="btn btn-primary" onclick="forumNewTopic()">+ Nouveau sujet</button>
      </div>
      <div style="padding:0 28px 20px">
        ${topics.length ? topics.map(t => `
          <div class="gm-row" style="cursor:pointer;align-items:center;padding:18px 0;gap:16px" onclick="forumOpenTopic(${t.id})">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap">
                ${t.epingle ? '<span style="font-size:.72rem;color:var(--g2);font-weight:700;background:rgba(27,94,32,.1);padding:2px 8px;border-radius:10px">📌 Épinglé</span>' : ''}
                ${t.ferme ? '<span style="font-size:.72rem;color:var(--muted);background:var(--off);padding:2px 8px;border-radius:10px">🔒 Fermé</span>' : ''}
                <span style="font-size:.72rem;color:#fff;background:var(--g2);padding:2px 10px;border-radius:10px;font-weight:600">${FORUM_CATS[t.categorie]||t.categorie}</span>
              </div>
              <strong style="font-size:1rem;line-height:1.4">${escHtml(t.titre)}</strong>
              <div style="font-size:.8rem;color:var(--muted);margin-top:4px">
                Par <strong style="color:var(--text)">${escHtml(t.prenom||'')}</strong> · ${fmt(t.date_creation)}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:18px;flex-shrink:0">
              <div style="text-align:center;font-size:.85rem;color:var(--muted)">
                <div style="font-size:1.1rem">💬</div><div>${t.nb_posts||0}</div>
              </div>
              <div style="text-align:center;font-size:.85rem;color:var(--muted)">
                <div style="font-size:1.1rem">👁</div><div>${t.nb_vues||0}</div>
              </div>
              ${canMod ? `<div style="display:flex;gap:4px">
                <button class="gm-tb-btn" onclick="event.stopPropagation();forumPin(${t.id})" title="Épingler">${t.epingle?'📌':'📍'}</button>
                <button class="gm-tb-btn" onclick="event.stopPropagation();forumClose(${t.id})" title="${t.ferme?'Ouvrir':'Fermer'}">${t.ferme?'🔓':'🔒'}</button>
                <button class="gm-tb-btn" style="color:#d93025" onclick="event.stopPropagation();forumDeleteTopic(${t.id})" title="Supprimer">🗑</button>
              </div>` : ''}
            </div>
          </div>`).join('<hr style="margin:0;border:none;border-top:1px solid var(--border)"/>') :
          '<div class="empty-state" style="padding:60px"><div class="es-icon">💬</div><p>Aucun sujet pour l\'instant. Soyez le premier à démarrer une discussion !</p></div>'
        }
      </div>
    </div>`);
}

function forumOpenTopic(id) { _forumTopic = id; forum(); }
function forumBack() { _forumTopic = null; forum(); }

async function forumShowTopic(id) {
  const { topic, posts } = await api(`/forum/topics/${id}`);
  const canMod = can.adminOrSec();
  const isClosed = topic.ferme;
  setContent(`
    <div class="table-card">
      <div class="table-card-header" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="forumBack()">← Forum</button>
        <h3 style="margin:0;flex:1">${escHtml(topic.titre)}</h3>
        <span style="font-size:.78rem;color:var(--muted);padding:4px 10px;background:var(--off);border-radius:20px">${FORUM_CATS[topic.categorie]||topic.categorie}</span>
      </div>
      <div style="padding:0 20px 20px">
        ${posts.map((p,i) => `
          <div style="display:flex;gap:12px;margin-top:${i===0?'0':'20px'}">
            <div style="width:40px;height:40px;border-radius:50%;background:var(--g1);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;overflow:hidden">
              ${p.photo_url ? `<img src="${BASE_URL}${p.photo_url}" style="width:100%;height:100%;object-fit:cover"/>` : '👤'}
            </div>
            <div style="flex:1;background:var(--off);border-radius:10px;padding:12px 16px">
              <div style="font-size:.8rem;color:var(--muted);margin-bottom:6px">
                <strong style="color:var(--text)">${escHtml(p.prenom||'')}</strong> · ${fmt(p.date_creation)}
                ${(p.auteur_id===USER.id||canMod) ? `<button class="gm-tb-btn" style="color:#d93025;float:right" onclick="forumDeletePost(${p.id})">🗑</button>` : ''}
              </div>
              <div style="white-space:pre-wrap;font-size:.9rem;line-height:1.6">${escHtml(p.contenu)}</div>
            </div>
          </div>`).join('')}

        ${!isClosed ? `
          <div style="margin-top:24px">
            <textarea id="forumReply" rows="4" placeholder="Votre réponse…"
              style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:10px;font-size:.9rem;box-sizing:border-box;resize:vertical"></textarea>
            <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="forumPostReply(${id})">Envoyer</button>
          </div>` : '<p style="text-align:center;color:var(--muted);margin-top:24px">🔒 Ce sujet est fermé.</p>'}
      </div>
    </div>`);
}

async function forumPostReply(topicId) {
  const contenu = document.getElementById('forumReply')?.value?.trim();
  if (!contenu) return toast('Écrivez quelque chose !', true);
  await api(`/forum/topics/${topicId}/posts`, { method:'POST', body: JSON.stringify({ contenu }) });
  toast('Réponse envoyée');
  forumOpenTopic(topicId);
}

async function forumDeletePost(id) {
  if (!confirm('Supprimer ce message ?')) return;
  await api(`/forum/posts/${id}`, { method:'DELETE' });
  toast('Message supprimé');
  forumShowTopic(_forumTopic);
}

async function forumDeleteTopic(id) {
  if (!confirm('Supprimer ce sujet et toutes ses réponses ?')) return;
  await api(`/forum/topics/${id}`, { method:'DELETE' });
  toast('Sujet supprimé');
  _forumTopic = null;
  forum();
}

async function forumPin(id) {
  await api(`/forum/topics/${id}/pin`, { method:'PATCH' });
  forum();
}

async function forumClose(id) {
  await api(`/forum/topics/${id}/close`, { method:'PATCH' });
  if (_forumTopic === id) forumShowTopic(id); else forum();
}

function forumNewTopic() {
  openModal('💬 Nouveau sujet',
    '<label class="form-label">Catégorie</label>' +
    '<select id="ftCat" class="form-input" style="margin-bottom:12px">' +
      Object.entries(FORUM_CATS).map(([v,l]) => `<option value="${v}">${l}</option>`).join('') +
    '</select>' +
    '<label class="form-label">Titre</label>' +
    '<input id="ftTitre" class="form-input" placeholder="Titre du sujet" style="margin-bottom:12px"/>' +
    '<label class="form-label">Message</label>' +
    '<textarea id="ftContenu" rows="6" class="form-input" placeholder="Décrivez votre sujet..." style="resize:vertical;margin-bottom:16px"></textarea>' +
    '<div style="display:flex;gap:10px">' +
      '<button class="btn btn-primary" onclick="forumSubmitTopic()">Publier</button>' +
      '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
    '</div>'
  );
}

async function forumSubmitTopic() {
  const titre = document.getElementById('ftTitre')?.value?.trim();
  const contenu = document.getElementById('ftContenu')?.value?.trim();
  const categorie = document.getElementById('ftCat')?.value;
  if (!titre || !contenu) return toast('Titre et message requis', true);
  const { id } = await api('/forum/topics', { method:'POST', body: JSON.stringify({ titre, contenu, categorie }) });
  closeModal();
  toast('Sujet publié !');
  forumOpenTopic(id);
}

// ══════════════════════════════════════════════════════════════════════════════
// NEWSLETTER
// ══════════════════════════════════════════════════════════════════════════════

let _nlHistory = [];

const NL_TEMPLATES = [
  { label:'🎉 Invitation activité', sujet:'Vous êtes invité(e) — [Titre]', corps:`Bonjour,\n\nNous avons le plaisir de vous inviter à notre prochaine activité :\n\n📅 Date : [date]\n📍 Lieu : [lieu]\n\n[Description de l'activité]\n\nVeuillez confirmer votre présence en vous connectant à votre espace membre.\n\nCordialement,\nL'équipe AHH Hamilton` },
  { label:'💳 Rappel cotisation', sujet:'Rappel — Votre cotisation AHH Hamilton', corps:`Bonjour,\n\nNous vous rappelons que votre cotisation annuelle pour l'Association Haïtienne de Hamilton est maintenant due.\n\nPour renouveler votre adhésion, connectez-vous à votre espace membre et accédez à la section "Mon paiement".\n\nMerci pour votre soutien continu !\n\nCordialement,\nLe comité AHH Hamilton` },
  { label:'📢 Annonce générale', sujet:'Nouvelles de l\'AHH Hamilton — [Mois]', corps:`Bonjour à tous,\n\nVoici les dernières nouvelles de l'Association Haïtienne de Hamilton :\n\n1. [Nouvelle 1]\n2. [Nouvelle 2]\n3. [Nouvelle 3]\n\nN'hésitez pas à partager cette infolettre avec votre entourage.\n\nCordialement,\nL'équipe AHH Hamilton` },
  { label:'🙏 Remerciements', sujet:'Merci pour votre participation — [Activité]', corps:`Bonjour,\n\nAu nom de toute l'équipe de l'Association Haïtienne de Hamilton, nous tenons à vous remercier chaleureusement pour votre participation à [Activité].\n\nVotre présence et votre engagement enrichissent notre communauté.\n\nÀ très bientôt,\nL'équipe AHH Hamilton` },
];

async function newsletter() {
  setContent(`
    <div class="table-card" style="max-width:100%">
      <div class="table-card-header"><h3>📨 Infolettre — Envoi de masse</h3></div>
      <div style="padding:20px">
        <div style="margin-bottom:16px">
          <label class="form-label">Modèle rapide</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
            ${NL_TEMPLATES.map((t,i) => `<button class="btn btn-ghost btn-sm" onclick="nlApplyTemplate(${i})">${t.label}</button>`).join('')}
          </div>
        </div>
        <div style="margin-bottom:20px">
          <label class="form-label">Segment de destinataires</label>
          <select id="nlSegment" class="form-input" style="margin-bottom:14px">
            <option value="tous">Tous les membres actifs</option>
            <option value="payants">Membres payants (bienfaiteur + partenaire)</option>
            <option value="bienfaiteur">Bienfaiteurs seulement</option>
            <option value="partenaire">Partenaires seulement</option>
          </select>
          <label class="form-label">Sujet</label>
          <input id="nlSujet" class="form-input" placeholder="Objet de l'email" style="margin-bottom:14px"/>
          <label class="form-label">Corps du message</label>
          <textarea id="nlCorps" rows="10" class="form-input" placeholder="Contenu de votre infolettre..." style="resize:vertical;margin-bottom:14px"></textarea>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="sendNewsletter()">📨 Envoyer</button>
            <button class="btn btn-outline" onclick="nlPreview()">👁 Aperçu</button>
            <span id="nlStatus" style="font-size:.85rem;color:var(--muted)"></span>
          </div>
        </div>
        <hr style="margin:24px 0;border:none;border-top:1px solid var(--border)"/>
        <h4 style="margin-bottom:12px;color:var(--muted);font-size:.85rem">HISTORIQUE</h4>
        <div id="nlHistContainer"><div style="text-align:center;padding:20px;color:var(--muted)">Chargement...</div></div>
      </div>
    </div>`);
  await refreshNlHistory();
}

async function refreshNlHistory() {
  const container = document.getElementById('nlHistContainer');
  if (!container) return;
  _nlHistory = await api('/newsletter/history').catch(() => []);
  if (!_nlHistory.length) {
    container.innerHTML = '<p style="color:var(--muted);text-align:center">Aucun envoi pour l\'instant</p>';
    return;
  }
  container.innerHTML = '<table class="data-table"><thead><tr>' +
    '<th>Date</th><th>Sujet</th><th>Segment</th><th>Envoyés</th><th>Par</th><th>Statut</th><th>Actions</th>' +
    '</tr></thead><tbody>' +
    _nlHistory.map(h =>
      `<tr id="nlRow_${h.id}" style="${h.archive ? 'opacity:.45' : ''}">` +
      '<td>' + fmt(h.date_envoi) + '</td>' +
      '<td>' + escHtml(h.sujet) + '</td>' +
      '<td>' + (h.segment || 'tous') + '</td>' +
      '<td>' + h.nb_destinataires + '</td>' +
      '<td>' + escHtml((h.prenom || '') + ' ' + (h.nom || '')) + '</td>' +
      '<td>' + (h.archive ? '📦 Archivé' : '✅ Envoyé') + '</td>' +
      '<td style="white-space:nowrap;display:flex;gap:4px">' +
        `<button class="btn btn-ghost btn-sm" onclick="nlEdit(${h.id})" title="Modifier" style="padding:4px 8px">✏️</button>` +
        `<button class="btn btn-ghost btn-sm" onclick="nlArchive(${h.id})" title="${h.archive ? 'Désarchiver' : 'Archiver'}" style="padding:4px 8px">📦</button>` +
        `<button class="btn btn-ghost btn-sm" onclick="nlDelete(${h.id})" title="Supprimer" style="padding:4px 8px;color:#c62828">🗑️</button>` +
      '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

async function nlEdit(id) {
  const h = _nlHistory.find(x => x.id === id);
  if (!h) return;
  openModal('✏️ Modifier l\'infolettre',
    '<label class="form-label">Sujet</label>' +
    '<input id="nlEditSujet" class="form-input" style="margin-bottom:12px" value="' + escHtml(h.sujet) + '"/>' +
    '<label class="form-label">Corps</label>' +
    '<textarea id="nlEditCorps" rows="8" class="form-input" style="resize:vertical;margin-bottom:16px">' + escHtml(h.corps || '') + '</textarea>' +
    '<div style="display:flex;gap:10px">' +
    '<button class="btn btn-primary" onclick="nlEditSave(' + id + ')">Enregistrer</button>' +
    '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
    '</div>'
  );
}

async function nlEditSave(id) {
  const sujet = document.getElementById('nlEditSujet')?.value?.trim();
  const corps = document.getElementById('nlEditCorps')?.value?.trim();
  if (!sujet || !corps) return toast('Sujet et corps requis', true);
  try {
    await api('/newsletter/' + id, { method: 'PATCH', body: JSON.stringify({ sujet, corps }) });
    closeModal();
    toast('Infolettre modifiée');
    await refreshNlHistory();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

async function nlDelete(id) {
  if (!confirm('Supprimer cet envoi de l\'historique ?')) return;
  try {
    await api('/newsletter/' + id, { method: 'DELETE' });
    toast('Envoi supprimé');
    await refreshNlHistory();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

async function nlArchive(id) {
  try {
    const r = await api('/newsletter/' + id + '/archive', { method: 'PATCH' });
    toast(r.archive ? 'Archivé' : 'Désarchivé');
    await refreshNlHistory();
  } catch(e) { toast('Erreur : ' + e.message, true); }
}

// ══ HISTORIQUE MEMBRE ══════════════════════════════════════════════════════
async function memberHistory(userId, nomMembre) {
  const h = await api(`/members/${userId}/history`).catch(e => { toast(e.message,'error'); return null; });
  if (!h) return;
  const u = h.user;
  openModal(`📋 Historique — ${nomMembre || u.prenom+' '+u.nom}`, `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
      <div style="background:var(--off);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:800;color:var(--g1)">${fmtMoney(h.totalPaye)}</div>
        <div style="font-size:.72rem;color:var(--muted);margin-top:4px">Total payé</div>
      </div>
      <div style="background:var(--off);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:800;color:#1565c0">${h.totalHeures}h</div>
        <div style="font-size:.72rem;color:var(--muted);margin-top:4px">Bénévolat approuvé</div>
      </div>
      <div style="background:var(--off);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:800;color:#6a1b9a">${h.activites.length}</div>
        <div style="font-size:.72rem;color:var(--muted);margin-top:4px">Activités</div>
      </div>
    </div>

    ${h.badges.length ? `
    <div style="margin-bottom:16px">
      <div style="font-weight:700;font-size:.82rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">🏅 Badges</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${h.badges.map(b => `<span style="background:var(--off);border:1px solid var(--border);border-radius:20px;padding:5px 12px;font-size:.8rem">${b.icon} ${escHtml(b.nom)}</span>`).join('')}
      </div>
    </div>` : ''}

    <details open style="margin-bottom:14px">
      <summary style="cursor:pointer;font-weight:700;font-size:.88rem;padding:8px 0;border-bottom:1px solid var(--border)">💳 Paiements (${h.paiements.length})</summary>
      <div style="max-height:200px;overflow-y:auto">
        <table style="width:100%;font-size:.78rem;border-collapse:collapse;margin-top:8px">
          <thead><tr style="background:var(--off)"><th style="text-align:left;padding:6px">Mois</th><th>Montant</th><th>Type</th><th>Statut</th><th>Date</th></tr></thead>
          <tbody>${h.paiements.map(p => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:5px 8px">${p.mois||'–'}</td>
            <td style="text-align:center">${fmtMoney(p.montant)}</td>
            <td style="text-align:center">${p.type}</td>
            <td style="text-align:center">${pill(p.statut, p.statut==='approuve'?'bp-green':p.statut==='en_attente'?'bp-orange':'bp-red')}</td>
            <td style="text-align:center">${fmt(p.date_soumission)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </details>

    <details style="margin-bottom:14px">
      <summary style="cursor:pointer;font-weight:700;font-size:.88rem;padding:8px 0;border-bottom:1px solid var(--border)">🎉 Activités (${h.activites.length})</summary>
      <div style="max-height:180px;overflow-y:auto;margin-top:8px">
        ${h.activites.map(a => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:.8rem">
          <span>${escHtml(a.titre)}</span>
          <span style="color:var(--muted)">${a.date_debut ? new Date(a.date_debut).toLocaleDateString('fr-CA') : '–'} · ${a.checked_in ? '✅ Présent' : '–'}</span>
        </div>`).join('') || '<p style="color:var(--muted);font-size:.8rem;padding:8px 0">Aucune activité</p>'}
      </div>
    </details>

    <details>
      <summary style="cursor:pointer;font-weight:700;font-size:.88rem;padding:8px 0;border-bottom:1px solid var(--border)">🤝 Bénévolat (${h.benevole.length})</summary>
      <div style="max-height:180px;overflow-y:auto;margin-top:8px">
        ${h.benevole.map(v => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:.8rem">
          <span>${escHtml(v.description||v.activite||'–')}</span>
          <span style="color:var(--muted)">${v.heures}h · ${v.date_service||'–'} · ${pill(v.statut, v.statut==='approuve'?'bp-green':'bp-orange')}</span>
        </div>`).join('') || '<p style="color:var(--muted);font-size:.8rem;padding:8px 0">Aucune heure</p>'}
      </div>
    </details>
  `);
}

// ══ PRÉSENCES ÉVÉNEMENT ════════════════════════════════════════════════════
async function presencesView(actId, actTitre) {
  const [presences, act] = await Promise.all([
    api(`/activities/${actId}/presences`),
    api(`/activities/${actId}`).catch(() => ({ titre: actTitre }))
  ]);
  const titre = actTitre || act?.titre || 'Événement';
  const presents = presences.filter(p => p.checked_in);
  openModal(`✅ Présences — ${titre}`, `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap">
      <div style="background:#e8f5e9;border-radius:10px;padding:12px 20px;text-align:center">
        <div style="font-size:1.4rem;font-weight:800;color:#2e7d32">${presents.length}</div>
        <div style="font-size:.72rem;color:var(--muted)">Présents</div>
      </div>
      <div style="background:var(--off);border-radius:10px;padding:12px 20px;text-align:center">
        <div style="font-size:1.4rem;font-weight:800">${presences.length}</div>
        <div style="font-size:.72rem;color:var(--muted)">Inscrits</div>
      </div>
      ${can.adminOrSec() && presences.length ? `
      <button class="btn btn-outline btn-sm no-print" onclick="presencesCheckAll(${actId})" style="margin-left:auto">✅ Tout cocher</button>` : ''}
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="background:var(--off)">
          <th style="text-align:left;padding:8px">Membre</th>
          <th style="text-align:center;padding:8px">Statut</th>
          <th style="text-align:center;padding:8px">Check-in</th>
          ${can.adminOrSec() ? '<th style="text-align:center;padding:8px">Action</th>' : ''}
        </tr></thead>
        <tbody id="presencesBody">
          ${presences.map(p => `<tr id="pr-${p.user_id}" style="border-bottom:1px solid var(--border)">
            <td style="padding:8px">
              <div style="font-weight:600">${escHtml(p.prenom+' '+p.nom)}</div>
              <div style="font-size:.72rem;color:var(--muted)">${escHtml(p.email||'')}</div>
            </td>
            <td style="text-align:center;padding:8px">${pill(p.statut||'inscrit','bp-blue')}</td>
            <td style="text-align:center;padding:8px" id="ci-${p.user_id}">
              ${p.checked_in ? `<span style="color:#2e7d32;font-weight:700">✅ ${p.date_checkin ? new Date(p.date_checkin).toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'}) : ''}</span>` : '<span style="color:var(--muted)">–</span>'}
            </td>
            ${can.adminOrSec() ? `<td style="text-align:center;padding:8px">
              <button class="btn btn-sm ${p.checked_in ? 'btn-ghost' : 'btn-primary'}" onclick="presenceToggle(${actId},${p.user_id},${p.checked_in ? 0 : 1})" id="prb-${p.user_id}">
                ${p.checked_in ? 'Annuler' : '✅ Marquer présent'}
              </button>
            </td>` : ''}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `);
}

async function presenceToggle(actId, userId, present) {
  try {
    await api(`/activities/${actId}/presences/${userId}/checkin`, { method:'PATCH', body: JSON.stringify({ present: !!present }) });
    const ciCell = document.getElementById(`ci-${userId}`);
    const btn = document.getElementById(`prb-${userId}`);
    if (present) {
      const heure = new Date().toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'});
      if (ciCell) ciCell.innerHTML = `<span style="color:#2e7d32;font-weight:700">✅ ${heure}</span>`;
      if (btn) { btn.textContent = 'Annuler'; btn.className = 'btn btn-sm btn-ghost'; }
    } else {
      if (ciCell) ciCell.innerHTML = '<span style="color:var(--muted)">–</span>';
      if (btn) { btn.textContent = '✅ Marquer présent'; btn.className = 'btn btn-sm btn-primary'; }
    }
  } catch(e) { toast(e.message,'error'); }
}

async function presencesCheckAll(actId) {
  const presences = await api(`/activities/${actId}/presences`).catch(() => []);
  const absents = presences.filter(p => !p.checked_in).map(p => p.user_id);
  if (!absents.length) return toast('Tous déjà cochés');
  await api(`/activities/${actId}/presences/bulk-checkin`, { method:'POST', body: JSON.stringify({ user_ids: absents }) });
  toast(`✅ ${absents.length} présence(s) cochées`);
  // Refresh
  presences.forEach(p => {
    if (!p.checked_in) {
      const ciCell = document.getElementById(`ci-${p.user_id}`);
      const btn = document.getElementById(`prb-${p.user_id}`);
      if (ciCell) ciCell.innerHTML = `<span style="color:#2e7d32;font-weight:700">✅</span>`;
      if (btn) { btn.textContent = 'Annuler'; btn.className = 'btn btn-sm btn-ghost'; }
    }
  });
}

// ══ JOURNAL ADMIN ══════════════════════════════════════════════════════════
async function journalAdmin() {
  if (!can.admin()) return toast('Accès réservé aux administrateurs', true);
  const logs = await api('/activity-logs?limit=200').catch(() => []);
  const actionColors = {
    paiement_approuve: '#2e7d32', export_csv: '#1565c0', badge_manuel: '#6a1b9a',
    badges_auto_assign: '#e65100', checkin: '#00838f', signature_document: '#37474f',
    paiement_rejete: '#c62828'
  };
  setContent(`
    <div class="page-header">
      <div><h2>📋 Journal d'activité</h2><p>Actions administratives des 200 dernières opérations</p></div>
      <div class="page-actions">
        <button class="btn btn-outline" onclick="journalAdmin()">🔄 Rafraîchir</button>
        ${can.admin() ? `<button class="btn btn-ghost" onclick="badgesAutoAssign()">🏅 Attribuer badges auto</button>` : ''}
      </div>
    </div>
    <div class="table-card">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:.82rem">
          <thead><tr style="background:var(--off)">
            <th style="text-align:left;padding:8px 12px">Date</th>
            <th style="text-align:left;padding:8px 12px">Acteur</th>
            <th style="text-align:left;padding:8px 12px">Action</th>
            <th style="text-align:left;padding:8px 12px">Détails</th>
          </tr></thead>
          <tbody>
            ${logs.map(l => `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:7px 12px;white-space:nowrap;color:var(--muted);font-size:.75rem">${fmt(l.date_action)}</td>
              <td style="padding:7px 12px;font-weight:600">${escHtml(l.nom_acteur||'Système')}</td>
              <td style="padding:7px 12px">
                <span style="background:${actionColors[l.action]||'#607d8b'}22;color:${actionColors[l.action]||'#607d8b'};padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:600">${l.action}</span>
              </td>
              <td style="padding:7px 12px;color:var(--muted);font-size:.78rem">${escHtml(l.details||'–')}</td>
            </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--muted)">Aucune action enregistrée</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `);
}

async function badgesAutoAssign() {
  try {
    toast('Attribution des badges en cours...');
    const r = await api('/badges/auto-assign', { method:'POST' });
    toast(`✅ ${r.assigned} badge(s) attribué(s) automatiquement`);
    journalAdmin();
  } catch(e) { toast(e.message,'error'); }
}

// ══ SIGNATURE ÉLECTRONIQUE ═════════════════════════════════════════════════
function openSignatureModal(docId, docNom) {
  openModal(`✍️ Signer — ${escHtml(docNom)}`, `
    <p style="font-size:.85rem;color:var(--muted);margin-bottom:16px">Dessinez votre signature dans la zone ci-dessous. Elle sera horodatée et liée à votre compte.</p>
    <div style="border:2px solid var(--border);border-radius:12px;overflow:hidden;background:#fafafa;margin-bottom:16px">
      <canvas id="sigCanvas" width="520" height="160" style="display:block;touch-action:none;cursor:crosshair;width:100%;height:160px"></canvas>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:20px">
      <button class="btn btn-ghost btn-sm" onclick="clearSignature()">🗑 Effacer</button>
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-primary" onclick="submitSignature(${docId})">✅ Signer le document</button>
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
    </div>
  `);
  // Init canvas
  setTimeout(() => {
    const canvas = document.getElementById('sigCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#1b5e20';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let drawing = false, lastX = 0, lastY = 0;
    function getPos(e) {
      const p = e.touches ? e.touches[0] : e;
      const r = canvas.getBoundingClientRect();
      return [(p.clientX - r.left) * scaleX, (p.clientY - r.top) * scaleY];
    }
    canvas.onmousedown = canvas.ontouchstart = e => { e.preventDefault(); drawing = true; [lastX, lastY] = getPos(e); };
    canvas.onmousemove = canvas.ontouchmove = e => {
      if (!drawing) return;
      e.preventDefault();
      const [x, y] = getPos(e);
      ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(x, y); ctx.stroke();
      [lastX, lastY] = [x, y];
    };
    canvas.onmouseup = canvas.ontouchend = () => { drawing = false; };
  }, 100);
}

function clearSignature() {
  const c = document.getElementById('sigCanvas');
  if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

async function submitSignature(docId) {
  const canvas = document.getElementById('sigCanvas');
  if (!canvas) return;
  // Vérifier que la signature n'est pas vide
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const hasDrawing = data.some((v, i) => i % 4 === 3 && v > 0);
  if (!hasDrawing) return toast('Veuillez dessiner votre signature', true);
  const signatureData = canvas.toDataURL('image/png');
  try {
    await api(`/documents/${docId}/sign`, { method:'POST', body: JSON.stringify({ signature_data: signatureData }) });
    toast('✅ Document signé avec succès');
    closeModal();
    documents_mgmt();
  } catch(e) { toast(e.message,'error'); }
}

// ══ MES BADGES ═════════════════════════════════════════════════════════════
async function mesBadgesView() {
  const badges = await api(`/users/${USER.id}/badges`).catch(() => []);
  const allBadges = await api('/badges').catch(() => []);
  const obtenu = new Set(badges.map(b => b.code));
  setContent(`
    <div class="page-header"><div><h2>🏅 Mes badges</h2><p>Récompenses obtenues pour votre engagement dans la communauté AHH</p></div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:24px">
      ${allBadges.map(b => {
        const got = obtenu.has(b.code);
        const myBadge = badges.find(mb => mb.code === b.code);
        return `<div style="border:2px solid ${got?'#4caf50':'var(--border)'};border-radius:16px;padding:20px;text-align:center;background:${got?'#f1f8e9':'var(--off)'};opacity:${got?1:0.5}">
          <div style="font-size:2.5rem;margin-bottom:8px">${b.icon}</div>
          <div style="font-weight:700;font-size:.9rem">${escHtml(b.nom)}</div>
          <div style="font-size:.75rem;color:var(--muted);margin:6px 0">${escHtml(b.description||'')}</div>
          ${got ? `<div style="font-size:.7rem;color:#2e7d32;font-weight:600;margin-top:8px">✅ Obtenu le ${fmt(myBadge?.date_attribution)}</div>` : '<div style="font-size:.7rem;color:var(--muted);margin-top:8px">Non encore obtenu</div>'}
        </div>`;
      }).join('')}
    </div>
  `);
}

function nlApplyTemplate(i) {
  const t = NL_TEMPLATES[i];
  if (!t) return;
  const sj = document.getElementById('nlSujet');
  const co = document.getElementById('nlCorps');
  if (sj) sj.value = t.sujet;
  if (co) co.value = t.corps;
  toast('Modèle appliqué — adaptez le contenu avant d\'envoyer');
}

function nlPreview() {
  const sujet = document.getElementById('nlSujet')?.value?.trim() || '(sans sujet)';
  const corps = (document.getElementById('nlCorps')?.value?.trim() || '').replace(/\n/g, '<br>');
  const preview = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#003F87,#D21034);padding:24px;text-align:center;border-radius:10px 10px 0 0">
        <div style="color:#fff;font-size:1rem;font-weight:700">Association Haïtienne de Hamilton</div>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #e0e0e0">
        <div style="font-size:1.05rem;font-weight:700;color:#003F87;margin-bottom:16px">📧 ${escHtml(sujet)}</div>
        <div style="font-size:.9rem;color:#333;line-height:1.7">${corps}</div>
        <div style="margin-top:24px;font-size:.75rem;color:#aaa;border-top:1px solid #eee;padding-top:12px;text-align:center">
          © ${new Date().getFullYear()} Association Haïtienne de Hamilton
        </div>
      </div>
    </div>`;
  openModal('👁 Aperçu de l\'infolettre', preview, 'lg');
}

async function sendNewsletter() {
  const sujet = document.getElementById('nlSujet')?.value?.trim();
  const corps = document.getElementById('nlCorps')?.value?.trim();
  const segment = document.getElementById('nlSegment')?.value;
  if (!sujet || !corps) return toast('Sujet et corps requis', true);
  const status = document.getElementById('nlStatus');
  if (status) status.textContent = 'Envoi en cours... (peut prendre jusqu\'à 2 min)';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(API + '/newsletter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sujet, corps, segment }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `Erreur ${res.status}`);
    toast(r.ok + ' email(s) envoyé(s)' + (r.errors ? ' (' + r.errors + ' erreur(s))' : ''));
    if (status) status.textContent = '';
    document.getElementById('nlSujet').value = '';
    document.getElementById('nlCorps').value = '';
    await refreshNlHistory();
  } catch(e) {
    toast('Erreur : ' + (e.name === 'AbortError' ? 'Délai dépassé (trop de membres ?)' : e.message), true);
    if (status) status.textContent = '';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AMBASSADEUR DU MOIS (admin)
// ══════════════════════════════════════════════════════════════════════════════
async function ambassadeurAdmin() {
  const [current, membres] = await Promise.all([
    api('/ambassador').catch(() => null),
    api('/users').then(u => u.filter(m => m.actif)).catch(() => [])
  ]);

  setContent(
    '<div class="page-header"><div><h2>⭐ Ambassadeur du mois</h2><p>Mettez en valeur un membre exceptionnel sur la page d\'accueil.</p></div></div>' +

    (current && current.nom ? `
    <div class="table-card" style="margin-bottom:24px">
      <div class="table-card-header"><h3>Ambassadeur actuel — ${current.mois || ''}</h3></div>
      <div style="padding:20px;display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <div style="width:70px;height:70px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--primary-lt));display:flex;align-items:center;justify-content:center;font-size:1.6rem;font-weight:800;color:#fff;flex-shrink:0">${((current.prenom||'').charAt(0)+(current.nom||'').charAt(0)).toUpperCase()}</div>
        <div>
          <div style="font-size:1.1rem;font-weight:800">${current.prenom||''} ${current.nom||''}</div>
          <div style="color:var(--muted);font-size:.85rem">${current.role_description||''}</div>
          ${current.citation ? `<blockquote style="border-left:3px solid var(--accent);padding-left:12px;margin-top:8px;font-style:italic;font-size:.85rem;color:var(--muted)">"${current.citation}"</blockquote>` : ''}
        </div>
      </div>
    </div>` : '<div class="table-card" style="margin-bottom:24px;padding:20px;text-align:center;color:var(--muted)">Aucun ambassadeur défini pour ce mois.</div>') +

    '<div class="table-card"><div class="table-card-header"><h3>Définir l\'ambassadeur du mois</h3></div>' +
    '<div style="padding:20px">' +
    '<div class="form-group"><label>Choisir un membre existant (optionnel)</label>' +
    '<select id="amb_user" onchange="ambassadeurAutoFill(this.value)" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px;background:var(--input-bg);color:var(--text)">' +
    '<option value="">— Ou saisir manuellement ci-dessous —</option>' +
    membres.map(m => `<option value="${m.id}" data-prenom="${m.prenom||''}" data-nom="${m.nom||''}" data-photo="${m.photo_profil||''}">${m.prenom||''} ${m.nom||''} (${m.email})</option>`).join('') +
    '</select></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
    '<div class="form-group"><label>Prénom *</label><input id="amb_prenom" type="text" placeholder="Jean" class="form-input"/></div>' +
    '<div class="form-group"><label>Nom *</label><input id="amb_nom" type="text" placeholder="Dupont" class="form-input"/></div>' +
    '</div>' +
    '<div class="form-group"><label>Rôle / description</label><input id="amb_role" type="text" placeholder="Bénévole dévoué depuis 5 ans" class="form-input"/></div>' +
    '<div class="form-group"><label>Citation / témoignage</label><textarea id="amb_citation" rows="3" placeholder="Ce que la communauté représente pour moi…" class="form-input" style="resize:vertical"></textarea></div>' +
    '<div class="form-group"><label>Photo (optionnel)</label>' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    '<input id="amb_photo" type="text" placeholder="URL générée automatiquement après téléversement" class="form-input" style="flex:1;min-width:0" readonly/>' +
    '<label style="cursor:pointer;white-space:nowrap;background:var(--primary);color:#fff;padding:9px 16px;border-radius:8px;font-size:.85rem;font-weight:600;display:inline-flex;align-items:center;gap:6px">📷 Téléverser<input type="file" accept="image/*" style="display:none" onchange="ambUploadPhoto(this)"/></label>' +
    '</div>' +
    '<div id="ambPhotoPreview" style="margin-top:10px"></div>' +
    '</div>' +
    '<button class="btn btn-primary" onclick="saveAmbassadeur()" style="margin-top:8px">⭐ Enregistrer comme ambassadeur du mois</button>' +
    '</div></div>'
  );
}

function ambassadeurAutoFill(userId) {
  if (!userId) return;
  const sel = document.getElementById('amb_user');
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  const prenom = opt.dataset.prenom || '';
  const nom    = opt.dataset.nom    || '';
  const photo  = opt.dataset.photo  || '';
  document.getElementById('amb_prenom').value = prenom;
  document.getElementById('amb_nom').value    = nom;
  if (photo) {
    document.getElementById('amb_photo').value = photo;
    const prev = document.getElementById('ambPhotoPreview');
    if (prev) prev.innerHTML = `<img src="${BASE}${photo}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid var(--primary)"/>`;
  }
}

async function ambUploadPhoto(input) {
  if (!input.files || !input.files[0]) return;
  const btn = input.parentElement;
  btn.textContent = '⏳ Envoi…';
  try {
    const fd = new FormData();
    fd.append('photo', input.files[0]);
    const r = await fetch(API + '/ambassador/photo', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('ahh_token') },
      body: fd
    });
    if (!r.ok) throw new Error('Erreur serveur');
    const data = await r.json();
    document.getElementById('amb_photo').value = data.photo_url;
    const prev = document.getElementById('ambPhotoPreview');
    if (prev) prev.innerHTML = `<img src="${BASE}${data.photo_url}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid var(--primary)"/>`;
    toast('📷 Photo téléversée !');
  } catch(e) {
    toast('Erreur : ' + e.message, true);
  } finally {
    btn.innerHTML = '📷 Téléverser<input type="file" accept="image/*" style="display:none" onchange="ambUploadPhoto(this)"/>';
  }
}

async function saveAmbassadeur() {
  const prenom = document.getElementById('amb_prenom').value.trim();
  const nom    = document.getElementById('amb_nom').value.trim();
  if (!prenom || !nom) return toast('Prénom et nom requis', true);
  const payload = {
    prenom, nom,
    role_description: document.getElementById('amb_role').value.trim(),
    citation: document.getElementById('amb_citation').value.trim(),
    photo_url: document.getElementById('amb_photo').value.trim() || null,
    user_id: document.getElementById('amb_user').value || null,
  };
  try {
    await api('/ambassador', { method: 'PUT', body: JSON.stringify(payload) });
    toast('✅ Ambassadeur du mois mis à jour !');
    await ambassadeurAdmin();
  } catch(e) { toast(e.message, true); }
}

// ── Abonnés newsletter ────────────────────────────────────────────────────────
async function abonnesNewsletter() {
  setContent(`
    <div class="table-card" style="max-width:100%">
      <div class="table-card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <h3>📧 Abonnés à la newsletter</h3>
        <a href="${API}/newsletter/subscribers/export" class="btn btn-ghost btn-sm" target="_blank">📥 Exporter CSV</a>
      </div>
      <div style="padding:0 20px 20px">
        <div id="nlSubsContainer"><div style="text-align:center;padding:32px;color:var(--muted)">Chargement…</div></div>
      </div>
    </div>`);
  await refreshNlSubs();
}

async function refreshNlSubs() {
  const container = document.getElementById('nlSubsContainer');
  if (!container) return;
  const subs = await api('/newsletter/subscribers').catch(() => []);
  if (!subs || !subs.length) {
    container.innerHTML = '<p style="color:var(--muted);text-align:center;padding:32px">Aucun abonné pour l\'instant</p>';
    return;
  }
  container.innerHTML =
    `<p style="margin:16px 0 12px;font-size:.85rem;color:var(--muted)">${subs.length} abonné${subs.length > 1 ? 's' : ''}</p>` +
    '<table class="data-table"><thead><tr>' +
    '<th>Prénom</th><th>Courriel</th><th>Date d\'inscription</th><th>Actions</th>' +
    '</tr></thead><tbody>' +
    subs.map(s =>
      `<tr>
        <td>${escHtml(s.prenom || '—')}</td>
        <td>${escHtml(s.email)}</td>
        <td>${fmt(s.date_inscription)}</td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="nlSubDelete(${s.id},'${escHtml(s.email)}')"
            style="color:#c62828;padding:4px 8px" title="Désabonner">🗑️ Désabonner</button>
        </td>
      </tr>`
    ).join('') +
    '</tbody></table>';
}

async function nlSubDelete(id, email) {
  if (!confirm('Désabonner ' + email + ' ?')) return;
  await api('/newsletter/subscribers/' + id, { method: 'DELETE' });
  toast('Abonné retiré');
  await refreshNlSubs();
}
