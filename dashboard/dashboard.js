// ── CONFIG ─────────────────────────────────────────────────────────────────
const API  = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001/api' : '/api';
const BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001' : '';
let   USER = null;
let   TOKEN = null;

// ── CHAT STATE ──────────────────────────────────────────────────────────────
const CHAT = {
  open:      false,
  rooms:     [],
  activeId:  null,
  lastMsgAt: {},
  pollTimer: null,
};

const EMOJIS = [
  '😀','😂','😊','😍','🥰','😎','🤔','😅','😭','🙏',
  '👍','👋','🤝','💪','✅','❤️','🔥','💯','🎉','🌺',
  '🇭🇹','⭐','🙌','😮','🤩','👏','💚','🏆','📢','✨'
];

// ── INIT ───────────────────────────────────────────────────────────────────
(async function init() {
  TOKEN = localStorage.getItem('ahh_token');
  const raw = localStorage.getItem('ahh_user');
  if (!TOKEN || !raw) return location.replace('login.html');
  USER = JSON.parse(raw);

  buildSidebar();
  renderUserChip();
  setupTopbar();
  await showView('home');
  pollBadges();
  initChat();
  // Synchroniser le plan/rôle depuis le serveur (détecte les changements admin)
  syncUserFromServer();
  setInterval(syncUserFromServer, 120000); // re-vérifier toutes les 2 min
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

// ── API HELPER ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout
  try {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...opts.headers },
      signal: controller.signal,
      ...opts
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
    actif:'bp-green', inactif:'bp-gray', approuve:'bp-green', en_attente:'bp-orange', rejete:'bp-red',
    demande:'bp-orange', genere:'bp-blue', signe:'bp-green', paye:'bp-green', en_attente2:'bp-orange' };
  return pill(s || '–', m[s] || 'bp-gray');
}

function roleName(r) {
  return { admin:'Admin', tresoriere:'Trésorière', secretaire:'Secrétaire', delegue:'Délégué', member:'Membre' }[r] || r;
}

const can = {
  admin:      () => USER.role === 'admin',
  tresoriere: () => USER.role === 'tresoriere',
  secretaire: () => USER.role === 'secretaire',
  delegue:    () => USER.role === 'delegue',
  adminOrSec: () => ['admin','secretaire'].includes(USER.role),
  adminOrTre: () => ['admin','tresoriere'].includes(USER.role),
  executive:  () => ['admin','tresoriere','secretaire','delegue'].includes(USER.role),
};

function setContent(html) {
  document.getElementById('mainContent').innerHTML = html;
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
    {
      label: null, // pas de titre de section pour l'item principal
      items: [
        { id:'home', icon:'⊞', label:'Tableau de bord', roles: ALL },
      ]
    },

    // ── Membres & Inscriptions ────────────────────────────────────
    {
      label: 'Membres',
      items: [
        { id:'members',       icon:'◎', label:'Annuaire',          roles:['admin','secretaire'] },
        { id:'inscriptions',  icon:'◈', label:'Inscriptions',      roles:EXEC },
        { id:'volunteer',     icon:'◇', label:'Heures bénévolat',  roles:['admin','secretaire','member'] },
      ]
    },

    // ── Activités ─────────────────────────────────────────────────
    {
      label: 'Activités',
      items: [
        { id:'activities',    icon:'◉', label:'Calendrier',    roles: ALL },
        { id:'subcommittees', icon:'◐', label:'Sous-comités',  roles: ALL },
        { id:'projects',      icon:'◑', label:'Projets',       roles:['admin','delegue'] },
      ]
    },

    // ── Finance ───────────────────────────────────────────────────
    {
      label: 'Finance',
      items: [
        { id:'paiements',  icon:'◆', label:'Paiements',       roles:['admin','tresoriere'] },
        { id:'finance',    icon:'◇', label:'Lignes & budget',  roles:['admin','tresoriere'] },
        { id:'invoices',   icon:'◈', label:'Factures',         roles:['admin','tresoriere'] },
        { id:'recus',      icon:'◉', label:'Reçus fiscaux',   roles:['admin','tresoriere'] },
      ]
    },

    // ── Contenu ───────────────────────────────────────────────────
    {
      label: 'Contenu',
      items: [
        { id:'gallery_mgmt',       icon:'◎', label:'Galerie',          roles:['admin','secretaire'] },
        { id:'talents_mgmt',       icon:'◈', label:'Talents',           roles:['admin','secretaire'] },
        { id:'annonces_mgmt',      icon:'◉', label:'Petites annonces',  roles:['admin','secretaire'] },
        { id:'testimonials_mgmt',  icon:'❝', label:'Témoignages',       roles:['admin','secretaire'] },
        { id:'videos_mgmt',        icon:'▶', label:'Vidéos',            roles:['admin','secretaire'] },
        { id:'notes',              icon:'◇', label:'Notes de réunion',  roles:EXEC },
      ]
    },

    // ── Rapports ──────────────────────────────────────────────────
    {
      label: 'Rapports',
      items: [
        { id:'reports', icon:'◆', label:'Rapports', roles:STAFF },
        { id:'letters', icon:'◎', label:'Lettres',  roles:['admin','secretaire','member'] },
      ]
    },

    // ── Communication ─────────────────────────────────────────────
    {
      label: 'Communication',
      items: [
        { id:'annuaire', icon:'◉', label:'Courriel', roles: ALL },
      ]
    },

    // ── Mon espace membre ─────────────────────────────────────────
    {
      label: 'Mon espace',
      items: [
        { id:'mes_talents',  icon:'◈', label:'Mon talent',   roles:['member','delegue'], planMin:['bienfaiteur','partenaire'] },
        { id:'mes_annonces', icon:'◉', label:'Mes annonces', roles:['member','delegue'], planMin:['bienfaiteur','partenaire'] },
        { id:'mon_paiement', icon:'◆', label:'Mon paiement', roles:['member','delegue'], planMin:['bienfaiteur','partenaire'] },
        { id:'alerts',       icon:'◇', label:'Alertes',      roles:['admin','tresoriere'] },
        { id:'profile',      icon:'◎', label:'Mon profil',   roles: ALL },
      ]
    },
  ];

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
  const labels = {
    home:'Tableau de bord', activities:'Activités', members:'Membres', subcommittees:'Sous-comités',
    finance:'Finance', invoices:'Factures', messages:'Messages', volunteer:'Heures de bénévolat',
    notes:'Notes de réunion', reports:'Rapports', letters:'Lettres de recommandation',
    projects:'Projets', alerts:'Alertes', profile:'Mon profil', gallery_mgmt:'Gérer la galerie',
    talents_mgmt:'Nos talents', annonces_mgmt:'Petites annonces',
    mes_talents:'Mon talent', mes_annonces:'Mes annonces',
    inscriptions:'Inscriptions en attente', paiements:'Paiements membres',
    recus:'Reçus fiscaux', mon_paiement:'Mon paiement', annuaire:'Courriel'
  };
  const raw = labels[viewId] || 'Dashboard';
  document.getElementById('topbarTitle').textContent = window.AHH_LANG ? AHH_LANG.get(raw) : raw;
}

function renderUserChip() {
  document.getElementById('userChip').textContent = `${USER.prenom} · ${roleName(USER.role)}`;
  const nameEl = document.getElementById('siteNavName');
  if (nameEl) nameEl.textContent = `${USER.prenom} ${USER.nom}`;
  const logoutStrip = document.getElementById('siteNavLogout');
  if (logoutStrip) logoutStrip.onclick = logout;
}

function setupTopbar() {
  document.getElementById('sidebarToggle').onclick = () =>
    document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('btnLogout').onclick = logout;
  document.getElementById('alertBtn').onclick = () => showView('alerts');
  document.getElementById('msgBtn').onclick   = () => showView('annuaire');
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').onclick = e => { if (e.target.id === 'modalOverlay') closeModal(); };
  setupDarkMode();
  setupSearch();
  setupLangSelector();
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

async function pollBadges() {
  try {
    const stats = await api('/stats');
    if (stats) {
      const ac = document.getElementById('alertCount');
      const mc = document.getElementById('msgCount');
      ac.textContent = stats.alertes_non_lues;
      mc.textContent = stats.messages_non_lus;
      ac.style.display = stats.alertes_non_lues > 0 ? 'block' : 'none';
      mc.style.display = stats.messages_non_lus > 0 ? 'block' : 'none';
    }
  } catch {}
  setTimeout(pollBadges, 30000);
}

// ── MODAL ──────────────────────────────────────────────────────────────────
function openModal(title, bodyHtml) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalOverlay').style.display = 'flex';
}
function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }

// ── VIEWS ──────────────────────────────────────────────────────────────────
async function showView(viewId) {
  setActiveNav(viewId);
  setContent('<div class="loading-screen"><div class="spinner"></div><p>Chargement...</p></div>');
  const views = {
    home, activities, members, subcommittees,
    finance, invoices, messages, volunteer,
    notes, reports, letters, projects, alerts, profile,
    gallery_mgmt, annuaire, talents_mgmt, annonces_mgmt, mes_talents, mes_annonces,
    inscriptions, paiements, recus, mon_paiement, testimonials_mgmt, videos_mgmt
  };
  try {
    await (views[viewId] || home)();
  } catch(e) {
    setContent(`<div class="empty-state"><div class="es-icon">⚠️</div><p>${e.message}</p></div>`);
  }
}

// ══ HOME ════════════════════════════════════════════════════════════════════
async function home() {
  const stats    = await api('/stats');
  const alerts   = await api('/alerts');
  const upcoming = stats.prochaines_activites || [];
  const unreadAlerts = alerts.filter(a => !a.lu).slice(0, 4);

  const quickActions = [
    canCreateActivity ? { icon:'🎉', label:'Nouvelle activité', action:"openActivityForm()" } : null,
    can.adminOrSec() ? { icon:'✉️', label:'Envoyer un message', action:"showView('messages')" } : null,
    can.adminOrSec() ? { icon:'🤝', label:'Heures bénévolat', action:"showView('volunteer')" } : null,
    can.adminOrSec() ? { icon:'🖼️', label:'Gérer la galerie', action:"showView('gallery_mgmt')" } : null,
    can.adminOrTre() ? { icon:'💰', label:'Voir la finance', action:"showView('finance')" } : null,
    { icon:'📝', label:'Prendre des notes', action:"showView('notes')" },
  ].filter(Boolean);

  setContent(`
    <!-- Salutation -->
    <div class="home-greeting">
      <div class="home-greeting-text">
        <h2>Bonjour, <span style="color:var(--g3)">${USER.prenom}</span> 👋</h2>
        <p>Bienvenue dans votre espace AHH · <strong>${roleName(USER.role)}</strong></p>
      </div>
      <div style="font-size:2.8rem">
        ${{ admin:'👑', tresoriere:'💰', secretaire:'📋', delegue:'🤝', member:'🌟' }[USER.role] || '👤'}
      </div>
    </div>

    <!-- Stats cards -->
    <div class="cards-grid" style="margin-bottom:28px">
      ${USER.role !== 'member' ? `
      <div class="stat-card">
        <div class="sc-icon">👥</div>
        <div class="sc-value">${stats.total_membres}</div>
        <div class="sc-label">Membres actifs</div>
      </div>` : ''}
      <div class="stat-card">
        <div class="sc-icon">🎉</div>
        <div class="sc-value">${stats.total_activites}</div>
        <div class="sc-label">Activités</div>
      </div>
      <div class="stat-card">
        <div class="sc-icon">🤝</div>
        <div class="sc-value">${stats.total_heures}h</div>
        <div class="sc-label">Bénévolat approuvé</div>
      </div>
      <div class="stat-card ${stats.messages_non_lus > 0 ? 'has-notif' : ''}">
        <div class="sc-icon">✉️</div>
        <div class="sc-value">${stats.messages_non_lus}</div>
        <div class="sc-label">Messages non lus</div>
      </div>
      ${can.adminOrTre() ? `
      <div class="stat-card accent">
        <div class="sc-icon">💳</div>
        <div class="sc-value">${fmtMoney(stats.solde || 0)}</div>
        <div class="sc-label">Solde du compte</div>
      </div>` : ''}
    </div>

    <div class="home-grid">
      <!-- Actions rapides -->
      <div class="table-card">
        <div class="table-card-header"><h3>⚡ Actions rapides</h3></div>
        <div class="quick-actions-grid">
          ${quickActions.map(a => `
            <button class="quick-action-btn" onclick="${a.action}">
              <span class="qa-icon">${a.icon}</span>
              <span class="qa-label">${a.label}</span>
            </button>`).join('')}
        </div>
      </div>

      <!-- Alertes récentes -->
      ${can.adminOrTre() || can.adminOrSec() ? `
      <div class="table-card">
        <div class="table-card-header">
          <h3>🔔 Alertes récentes</h3>
          ${unreadAlerts.length ? `<button class="btn btn-sm btn-ghost" onclick="showView('alerts')">Toutes →</button>` : ''}
        </div>
        <div style="padding:4px 8px">
          ${unreadAlerts.length ? unreadAlerts.map(a => `
            <div class="alert-item">
              <div class="alert-dot"></div>
              <div>
                <div class="alert-title">${a.titre || 'Alerte'}</div>
                <div class="alert-body">${a.contenu || ''}</div>
                <div class="alert-time">${fmt(a.date_creation)}</div>
              </div>
            </div>`).join('') : '<div class="empty-state" style="padding:24px"><div class="es-icon">✅</div><p>Aucune alerte non lue</p></div>'}
        </div>
      </div>` : ''}
    </div>

    <!-- Prochaines activités -->
    ${upcoming.length ? `
    <div class="table-card" style="margin-top:20px">
      <div class="table-card-header">
        <h3>📅 Prochaines activités</h3>
        <button class="btn btn-sm btn-primary" onclick="showView('activities')">Voir toutes →</button>
      </div>
      <div class="table-wrapper"><table>
        <thead><tr><th>Activité</th><th>Date</th><th>Lieu</th><th>Action</th></tr></thead>
        <tbody>${upcoming.map(a => `<tr>
          <td><strong>${a.titre}</strong></td>
          <td>${fmt(a.date_debut)}</td>
          <td>${a.lieu || '–'}</td>
          <td><button class="btn btn-sm btn-ghost" onclick="showView('activities')">Voir →</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}
  `);
}

// ══ ACTIVITIES ═══════════════════════════════════════════════════════════════
async function activities() {
  const data = await api('/activities');

  setContent(`
    <div class="page-header">
      <div><h2>Activités</h2><p>Toutes les activités communautaires</p></div>
      <div class="page-actions">
        <button class="btn btn-ghost" onclick="activityCalendar()">🗓️ Calendrier</button>
        <button class="btn btn-outline" onclick="printSection('Activités')">🖨️ Imprimer</button>
      </div>
    </div>
    <div class="table-card">
      <div class="table-wrapper"><table>
        <thead><tr><th>Titre</th><th>Type</th><th>Date</th><th>Lieu</th><th>Participants</th><th>Statut</th><th>Actions</th></tr></thead>
        <tbody>
          ${data.length ? data.map(a => {
            const isMember = USER.role === 'member' || USER.role === 'delegue';
            const isRegistered = a.user_registered > 0;
            const canRegister = isMember && a.statut === 'planifiee';
            let memberBtn = '';
            if (canRegister) {
              if (isRegistered) {
                memberBtn = '<span class="registered-badge">✅ Prêt(e)</span>';
              } else {
                memberBtn = `<button class="btn btn-sm btn-accent" onclick="registerActivity(${a.id})">S'inscrire</button>`;
              }
            }
            return `<tr>
            <td><strong>${a.titre}</strong></td>
            <td>${a.type}</td>
            <td>${fmt(a.date_debut)}</td>
            <td>${a.lieu||'–'}</td>
            <td>${a.nb_inscrits}${a.max_participants ? '/' + a.max_participants : ''}</td>
            <td>${statusPill(a.statut)}</td>
            <td>
              ${canCreateActivity() ? `
                <button class="btn btn-sm btn-outline" onclick='openActivityForm(${JSON.stringify(a)})'>✏️</button>
                ${a.statut === 'planifiee' && can.adminOrSec() ? `<button class="btn btn-sm btn-primary" onclick="launchActivity(${a.id},'${a.titre}')">🚀 Lancer</button>` : ''}
                ${a.paiement_requis ? `<button class="btn btn-sm btn-accent" onclick="viewActivityQR(${a.id},'${a.titre.replace(/'/g,"\\'")}','${a.qr_token||''}')">📱 QR</button>` : ''}
                <button class="btn btn-sm btn-ghost" onclick="viewRegistrations(${a.id},'${a.titre}')">👥</button>
                <button class="btn btn-sm btn-ghost" onclick="showActivityReport(${a.id})">📊</button>
              ` : ''}
              ${memberBtn}
            </td>
          </tr>`;
          }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Aucune activité</td></tr>'}
        </tbody>
      </table></div>
    </div>
  `);
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
        <option value="delegue">Délégué</option>
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
    <td><strong>${hl(u.prenom+' '+u.nom, q)}</strong></td>
    <td>${hl(u.email, q)}</td>
    <td>${hl(u.telephone||'–', q)}</td>
    <td>${pill(roleName(u.role), u.role==='admin'?'bp-orange':u.role==='member'?'bp-blue':'bp-green')}</td>
    <td>${can.admin()
      ? `<select class="plan-select" onchange="changePlan(${u.id},this.value)" style="font-size:.75rem;border:1px solid var(--border);border-radius:6px;padding:2px 6px;background:#fff">
           <option value="gratuit"     ${(u.plan||'gratuit')==='gratuit'    ?'selected':''}>Gratuit</option>
           <option value="bienfaiteur" ${(u.plan||'')==='bienfaiteur'?'selected':''}>💛 Bienfaiteur</option>
           <option value="partenaire"  ${(u.plan||'')==='partenaire' ?'selected':''}>⭐ Partenaire</option>
         </select>`
      : pill(u.plan||'gratuit', u.plan==='bienfaiteur'?'bp-orange':u.plan==='partenaire'?'bp-green':'bp-gray')}</td>
    <td>${u.actif ? pill('Actif','bp-green') : pill('Inactif','bp-red')}</td>
    <td>${fmt(u.date_inscription)}</td>
    <td>
      ${can.admin() ? `
        <button class="btn btn-sm btn-outline" onclick='openMemberForm(${JSON.stringify(u).replace(/'/g,"\\'")})'>✏️</button>
        ${u.actif
          ? `<button class="btn btn-sm btn-danger" onclick="toggleMember(${u.id},0)">🚫</button>`
          : `<button class="btn btn-sm btn-ghost"  onclick="toggleMember(${u.id},1)">✅</button>`}` : ''}
      ${can.adminOrSec() ? `<button class="btn btn-sm btn-ghost" onclick="showVolunteerFor(${u.id},'${u.prenom} ${u.nom}')">🤝</button>` : ''}
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
          <option value="delegue" ${u?.role==='delegue'?'selected':''}>Délégué</option>
          <option value="secretaire" ${u?.role==='secretaire'?'selected':''}>Secrétaire</option>
          <option value="tresoriere" ${u?.role==='tresoriere'?'selected':''}>Trésorière</option>
          <option value="admin" ${u?.role==='admin'?'selected':''}>Admin</option>
        </select></div>` : ''}
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
    if (can.admin()) body.role = document.getElementById('m_role').value;
    if (!isEdit) body.password = document.getElementById('m_pw').value;
    try {
      if (isEdit) await api(`/users/${u.id}`, { method:'PUT', body:JSON.stringify(body) });
      else        await api('/users', { method:'POST', body:JSON.stringify(body) });
      closeModal(); toast(isEdit ? 'Membre mis à jour' : 'Membre créé'); members();
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
  const [lines, rep] = await Promise.all([api('/finance/lines'), api('/finance/account')]);
  window._finLines = lines;
  window._finRep   = rep;
  const totalBudget  = lines.reduce((s,l) => s + (l.budget_alloue||0), 0);
  const totalDep     = lines.reduce((s,l) => s + (l.depenses||0), 0);
  const totalRev     = lines.reduce((s,l) => s + (l.revenus||0), 0);
  const totalPending = lines.reduce((s,l) => s + (l.depenses_en_attente||0), 0);

  setContent(`
    <div class="page-header">
      <div><h2>Finance</h2><p>Gestion des fonds et lignes budgétaires</p></div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick="openTransactionForm(null,window._finLines)">+ Transaction</button>
        <button class="btn btn-outline" onclick="openAccountForm(window._finRep)">⚙️ Compte</button>
      </div>
    </div>
    <div class="finance-summary">
      <div class="fin-card"><div class="fc-val">${fmtMoney(rep?.solde)}</div><div class="fc-label">Solde actuel</div></div>
      <div class="fin-card"><div class="fc-val">${fmtMoney(totalBudget)}</div><div class="fc-label">Budget total alloué</div></div>
      <div class="fin-card"><div class="fc-val negative">${fmtMoney(totalDep)}</div><div class="fc-label">Total dépenses</div></div>
      <div class="fin-card"><div class="fc-val">${fmtMoney(totalRev)}</div><div class="fc-label">Total revenus</div></div>
    </div>
    <div class="table-card">
      <div class="table-card-header"><h3>Lignes financières</h3></div>
      <div class="table-wrapper"><table>
        <thead><tr><th>Activité / Projet</th><th>Budget alloué</th><th>Dépenses</th><th>En attente</th><th>Revenus</th><th>Solde ligne</th><th>Statut</th><th>Actions</th></tr></thead>
        <tbody>${lines.map(l => {
          const solde = (l.budget_alloue||0) - (l.depenses||0) + (l.revenus||0);
          const pending = l.depenses_en_attente||0;
          return `<tr>
            <td><strong>${l.activite||l.projet||l.titre}</strong></td>
            <td>${fmtMoney(l.budget_alloue)}</td>
            <td style="color:var(--red);font-size:.86rem">${fmtMoney(l.depenses)}</td>
            <td style="color:#e65100;font-size:.86rem">${pending>0?'⏳ '+fmtMoney(pending):'–'}</td>
            <td style="color:var(--g2);font-size:.86rem">${fmtMoney(l.revenus)}</td>
            <td><strong style="color:${solde<0?'var(--red)':'var(--g2)'}">${fmtMoney(solde)}</strong></td>
            <td>${statusPill(l.statut)}</td>
            <td><button class="btn btn-sm btn-ghost" onclick="viewTransactions(${l.id},'${l.titre.replace(/'/g,"\\'")}')">Voir transactions</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>
    <p style="font-size:.78rem;color:var(--muted);margin-top:-8px">Institution: ${rep?.institution||'–'} · Compte: ${rep?.numero_compte||'–'} · Titulaire: ${rep?.nom_titulaire||'–'}</p>
  `);
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
      <div class="page-actions">
        <button class="btn btn-primary" onclick='openInvoiceForm(${JSON.stringify(lines)})'>+ Nouvelle facture</button>
      </div>
    </div>
    <div class="table-card"><div class="table-wrapper"><table>
      <thead><tr><th>Titre</th><th>Fournisseur</th><th>Montant</th><th>Date</th><th>Activité / Projet</th><th>Statut</th><th>Photo</th><th>Actions</th></tr></thead>
      <tbody>${data.map(i=>`<tr>
        <td><strong>${i.titre}</strong></td>
        <td>${i.fournisseur||'–'}</td>
        <td>${fmtMoney(i.montant)}</td>
        <td>${fmt(i.date_facture)}</td>
        <td>${i.ligne||'–'}</td>
        <td>${statusPill(i.statut)}</td>
        <td>${i.photo_path ? `<a href="${BASE}${i.photo_path}" target="_blank" class="btn btn-sm btn-ghost">📷 Voir</a>` : '–'}</td>
        <td>
          ${i.statut === 'en_attente' ? `<button class="btn btn-sm btn-primary" onclick="updateInvoiceStatus(${i.id},'approuve')">✅</button>
          <button class="btn btn-sm btn-accent" onclick="updateInvoiceStatus(${i.id},'paye')">💰 Payé</button>` : ''}
        </td>
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
        <td>${can.adminOrSec() && v.statut==='en_attente' ? `
          <button class="btn btn-sm btn-primary" onclick="approveVol(${v.id},'approuve')">✅</button>
          <button class="btn btn-sm btn-danger" onclick="approveVol(${v.id},'rejete')">❌</button>` : ''}
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

// ══ NOTES ══════════════════════════════════════════════════════════════════
async function notes() {
  const [data, allActs] = await Promise.all([api('/notes'), api('/activities')]);
  setContent(`
    <div class="page-header">
      <div><h2>Notes de réunion</h2><p>Avec correction automatique FR / EN / Créole haïtien</p></div>
      <div class="page-actions">
        <button class="btn btn-primary" onclick='openNoteForm(null,${JSON.stringify(allActs)})'>+ Nouvelle note</button>
      </div>
    </div>
    ${data.map(n=>`
      <div class="table-card" style="margin-bottom:16px">
        <div class="table-card-header">
          <div>
            <h3>${n.titre}</h3>
            <small style="color:var(--muted)">${n.auteur} · ${fmt(n.date_reunion)} · ${n.langue.toUpperCase()} ${n.activite?'· 📎 '+n.activite:''}</small>
          </div>
          <div class="tc-actions">
            <button class="btn btn-sm btn-outline" onclick='openNoteForm(${JSON.stringify(n)},${JSON.stringify(allActs)})'>✏️ Modifier</button>
            ${n.auteur_id===USER.id||can.admin() ? `<button class="btn btn-sm btn-danger" onclick="deleteNote(${n.id})">🗑️</button>` : ''}
          </div>
        </div>
        <div style="padding:16px 20px;white-space:pre-wrap;font-size:.88rem;color:var(--text);max-height:180px;overflow-y:auto;line-height:1.7">${n.contenu_corrige||n.contenu||'–'}</div>
      </div>
    `).join('') || '<div class="empty-state"><div class="es-icon">📝</div><p>Aucune note de réunion</p></div>'}
  `);
}

function openNoteForm(n, allActs) {
  const isEdit = !!n;
  openModal(isEdit ? 'Modifier la note' : 'Nouvelle note de réunion', `
    <div class="form-group"><label>Titre</label><input id="n_titre" value="${n?.titre||''}"/></div>
    <div class="form-row">
      <div class="form-group"><label>Date de réunion</label><input type="date" id="n_date" value="${n?.date_reunion||''}"/></div>
      <div class="form-group"><label>Langue</label>
        <select id="n_lang">
          <option value="fr" ${(!n||n.langue==='fr')?'selected':''}>🇫🇷 Français</option>
          <option value="en" ${n?.langue==='en'?'selected':''}>🇬🇧 Anglais</option>
          <option value="ht" ${n?.langue==='ht'?'selected':''}>🇭🇹 Créole haïtien</option>
        </select></div>
    </div>
    <div class="form-group"><label>Activité liée</label>
      <select id="n_act"><option value="">– Aucune –</option>
        ${allActs.map(a=>`<option value="${a.id}" ${n?.activity_id===a.id?'selected':''}>${a.titre}</option>`).join('')}
      </select></div>
    <div class="form-group">
      <div class="note-toolbar">
        <label>Notes</label>
        <button type="button" class="btn btn-sm btn-accent" onclick="correctNote()">🪄 Corriger automatiquement</button>
      </div>
      <textarea class="note-area" id="n_contenu">${n?.contenu||''}</textarea>
      <div class="corrected-box" id="n_corrected">${n?.contenu_corrige||''}</div>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>
      <button type="button" class="btn btn-primary" onclick="saveNote(${isEdit?n.id:'null'})">Enregistrer</button>
    </div>
  `);
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
  const body = { titre:document.getElementById('n_titre').value, contenu:document.getElementById('n_contenu').value,
    langue:document.getElementById('n_lang').value, date_reunion:document.getElementById('n_date').value,
    activity_id:parseInt(document.getElementById('n_act').value)||null,
    contenu_corrige:document.getElementById('n_corrected').textContent||null };
  try {
    if (id) await api(`/notes/${id}`, { method:'PUT', body:JSON.stringify(body) });
    else    await api('/notes', { method:'POST', body:JSON.stringify(body) });
    closeModal(); toast('Note enregistrée'); notes();
  } catch(ex) { toast(ex.message,'error'); }
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
      <img src="/Public/logo.jpg" alt="AHH" style="width:70px;height:70px;border-radius:8px;object-fit:cover;flex-shrink:0"/>
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
          catHtml += `
            <div class="gallery-mgmt-card" id="gmc-${p.id}" data-photoidx="${idx}">
              <div class="gmc-img" data-photoidx="${idx}" style="cursor:zoom-in">
                <img src="${src}" alt="${(p.titre||'').replace(/"/g,'&quot;')}"
                  onerror="this.style.display='none'" loading="lazy"/>
              </div>
              <div class="gmc-info">
                <div class="gmc-title">${p.titre || '(Sans titre)'}</div>
                <div class="gmc-meta">${fmt(p.date_upload)} · ${p.uploadeur || '–'}</div>
              </div>
              <button class="gmc-delete"
                data-delid="${p.id}"
                title="Supprimer">🗑️</button>
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
    // Clic sur le bouton supprimer
    const delBtn = e.target.closest('[data-delid]');
    if (delBtn) {
      e.stopPropagation();
      deleteGalleryPhoto(parseInt(delBtn.dataset.delid));
      return;
    }
    // Clic sur une image (pas sur le bouton supprimer)
    if (e.target.closest('.gmc-delete')) return;
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
          <div class="gm-nav-row gm-active" id="gn-inbox"  onclick="gmNav('inbox')"><span>📥</span><span>Boîte de réception</span><span class="gm-badge" id="gm-badge"></span></div>
          <div class="gm-nav-row" id="gn-starred" onclick="gmNav('starred')"><span>☆</span><span>Suivis</span></div>
          <div class="gm-nav-row" id="gn-sent"    onclick="gmNav('sent')"  ><span>📤</span><span>Envoyés</span></div>
          <div class="gm-nav-row" id="gn-all"     onclick="gmNav('all')"   ><span>📂</span><span>Tous</span></div>
          <div class="gm-nav-row" id="gn-trash"   onclick="gmNav('trash')" ><span>🗑️</span><span>Corbeille</span></div>
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
  if (view === 'inbox')   return gmLoadInbox();
  if (view === 'sent')    return gmLoadSent();
  if (view === 'starred') return gmRenderList(_M.all.inbox.filter(m => _M.starred.has(m.message_id||m.id)), 'inbox');
  if (view === 'all')     return gmRenderList([..._M.all.inbox,..._M.all.sent], 'inbox');
  if (view === 'trash')   return gmLoadTrash();
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
  _MC.to = []; _MC.cc = [];
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
          <input id="mc-to" class="gm-field-input" placeholder="Destinataire…" autocomplete="off"
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
  if (!hits.length) { sg.innerHTML=''; sg.classList.remove('open'); return; }
  sg.innerHTML = hits.map(u =>
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
    const ids = toArr.map(c => (_M.members.find(u=>u.email===c.email)||{}).id).filter(Boolean);
    if (!ids.length) {
      toast('Destinataire introuvable — utilisez la liste de suggestions', 'error');
      btn.disabled=false; btn.textContent='Envoyer'; return;
    }

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

    toast('✅ Message envoyé!');
    _MC.to=[]; _MC.cc=[];
    if (fileEl) fileEl.value = '';
    document.getElementById('mc-attach') && (document.getElementById('mc-attach').innerHTML = '');
    gmNav('sent');
  } catch(ex) {
    toast(ex.message, 'error');
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

async function loadMessages(roomId, since) {
  try {
    const url = since ? `/chat/rooms/${roomId}/messages?since=${encodeURIComponent(since)}` : `/chat/rooms/${roomId}/messages`;
    const msgs = await api(url);
    if (!msgs?.length) {
      if (!since) document.getElementById('chatMessages').innerHTML = '<div class="chat-empty"><div class="ce-icon">💬</div><p>Aucun message encore.<br/>Soyez le premier à écrire!</p></div>';
      return;
    }
    renderMessages(msgs, !!since);
    if (msgs.length) CHAT.lastMsgAt[roomId] = msgs[msgs.length - 1].created_at;
    loadChatRooms(); // refresh unread
  } catch {}
}

function renderMessages(msgs, append) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const html = msgs.map(m => {
    const isMe = m.sender_id === USER.id;
    const initials = `${m.prenom[0]}${m.nom[0]}`.toUpperCase();
    const time = new Date(m.created_at).toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit' });
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
    await loadMessages(CHAT.activeId, CHAT.lastMsgAt[CHAT.activeId]);
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
    const since = CHAT.lastMsgAt[CHAT.activeId];
    if (since) await loadMessages(CHAT.activeId, since);
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
            ${can.admin() ? `<button class="btn btn-sm btn-outline" onclick='openProjectForm(${JSON.stringify(p)},${JSON.stringify(allUsers)})'>✏️</button>` : ''}
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

  setContent(`
    <div class="page-header"><div><h2>Mon profil</h2></div>
      <div class="page-actions"><button class="btn btn-outline" onclick="openEditProfile(${JSON.stringify(u).replace(/"/g,'&quot;')})">✏️ Modifier</button></div></div>
    <div class="profile-card">
      <div class="profile-avatar-wrap">
        <div class="profile-avatar">${avatarInner}</div>
        <label class="profile-photo-btn" for="photoFileInput" title="Changer la photo">📷</label>
        <input type="file" id="photoFileInput" accept="image/jpeg,image/png,image/webp" style="display:none"/>
      </div>
      <div class="profile-info">
        <h3>${u.prenom} ${u.nom}</h3>
        <span class="role-tag">${roleName(u.role)}</span>
        <div class="info-grid">
          <div class="info-item"><label>Email</label><span>${u.email}</span></div>
          <div class="info-item"><label>Téléphone</label><span>${u.telephone||'–'}</span></div>
          <div class="info-item"><label>Adresse</label><span>${u.adresse||'–'}</span></div>
          <div class="info-item"><label>Date naissance</label><span>${u.date_naissance||'–'}</span></div>
          <div class="info-item"><label>Membre depuis</label><span>${fmt(u.date_inscription)}</span></div>
          <div class="info-item"><label>Heures bénévolat</label><span><strong>${totalH}h</strong></span></div>
        </div>
      </div>
    </div>
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

function openEditProfile(u) {
  openModal('Modifier mon profil', `
    <form id="editProf">
      <div class="form-row">
        <div class="form-group"><label>Prénom</label><input id="ep_prenom" value="${u.prenom||''}"/></div>
        <div class="form-group"><label>Nom</label><input id="ep_nom" value="${u.nom||''}"/></div>
      </div>
      <div class="form-group"><label>Téléphone</label><input id="ep_tel" value="${u.telephone||''}"/></div>
      <div class="form-group"><label>Adresse</label><input id="ep_addr" value="${u.adresse||''}"/></div>
      <div class="form-group"><label>Date de naissance</label><input type="date" id="ep_dob" value="${u.date_naissance||''}"/></div>
      <div class="form-group"><label>Bio</label><textarea id="ep_bio">${u.bio||''}</textarea></div>
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
        date_naissance:document.getElementById('ep_dob').value, bio:document.getElementById('ep_bio').value })});
      // Update local user
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
  if (!input) return;
  let timer = null;
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
  document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) results.style.display = 'none'; });
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
    '<thead><tr><th>Nom</th><th>Email</th><th>Plan</th><th>Statut</th><th>Soumis</th><th>Traité</th></tr></thead><tbody>' +
    (processed.map(p =>
      '<tr><td>' + p.prenom + ' ' + p.nom + '</td><td>' + p.email + '</td><td>' + (p.plan||'gratuit') + '</td>' +
      '<td>' + statutPill(p.statut) + '</td><td>' + fmt(p.date_soumission) + '</td><td>' + fmt(p.date_traitement) + '</td></tr>'
    ).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Aucun historique</td></tr>') +
    '</tbody></table></div></div>'
  );
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
  const data = await api('/payments');
  const pending  = data.filter(d => d.statut === 'en_attente');
  const approved = data.filter(d => d.statut === 'approuve');
  const total    = approved.reduce((s, p) => s + p.montant, 0);
  const TYPE_LABEL = { mensualite:'💳 Mensualité', don:'🎁 Don' };

  setContent(
    '<div class="page-header"><div><h2>💳 Paiements membres</h2>' +
    '<p>Validez les paiements et dons avant comptabilisation.</p></div>' +
    '<div class="page-actions"><button class="btn btn-outline" onclick="showView(\'recus\')">🧾 Reçus fiscaux</button></div></div>' +

    '<div class="cards-grid" style="margin-bottom:24px">' +
      '<div class="stat-card accent"><div class="sc-icon">✅</div><div class="sc-value">$' + total.toFixed(2) + '</div><div class="sc-label">Total approuvé</div></div>' +
      '<div class="stat-card"><div class="sc-icon">⏳</div><div class="sc-value">' + pending.length + '</div><div class="sc-label">En attente</div></div>' +
      '<div class="stat-card"><div class="sc-icon">📋</div><div class="sc-value">' + data.length + '</div><div class="sc-label">Total</div></div>' +
    '</div>' +

    (pending.length ? '<h3 style="margin-bottom:12px;font-size:.95rem;font-weight:700">⏳ À approuver</h3>' : '') +
    pending.map(p =>
      '<div class="table-card" style="margin-bottom:14px;border-left:4px solid var(--accent)">' +
      '<div class="table-card-header">' +
        '<div><h3>' + (TYPE_LABEL[p.type]||p.type) + ' — ' + p.prenom + ' ' + p.nom + '</h3>' +
        '<small style="color:var(--muted)">' + p.email + ' · Plan: ' + (p.plan||'–') + ' · $' + p.montant + ' · ' + (p.methode||'–') + ' · Mois: ' + (p.mois||'–') + '</small>' +
        (p.note ? '<br/><small style="color:var(--muted)">Note: ' + p.note + '</small>' : '') + '</div>' +
        '<div class="tc-actions">' +
          (p.proof_path ? '<a class="btn btn-ghost btn-sm" href="' + BASE + p.proof_path + '" target="_blank">🧾 Preuve</a>' : '') +
          '<button class="btn btn-primary btn-sm" onclick="approuverPaiement(' + p.id + ')">✅ Approuver</button>' +
          '<button class="btn btn-danger btn-sm" onclick="rejeterPaiement(' + p.id + ')">❌ Rejeter</button>' +
        '</div></div></div>'
    ).join('') +

    '<div class="table-card"><div class="table-card-header"><h3>Historique</h3></div>' +
    '<div class="table-wrapper"><table>' +
    '<thead><tr><th>Membre</th><th>Type</th><th>Montant</th><th>Mois</th><th>Méthode</th><th>Statut</th><th>Date</th></tr></thead><tbody>' +
    (data.map(p => {
      const nom = (p.prenom && p.nom) ? p.prenom + ' ' + p.nom : (p.note || p.email || '–');
      return '<tr><td>' + nom + '</td><td>' + (TYPE_LABEL[p.type]||p.type) + '</td><td>$' + p.montant + '</td>' +
      '<td>' + (p.mois||'–') + '</td><td>' + (p.methode||'–') + '</td><td>' + statusPill(p.statut) + '</td><td>' + fmt(p.date_soumission) + '</td></tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Aucun paiement</td></tr>') +
    '</tbody></table></div></div>'
  );
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
  setContent(
    '<div class="page-header"><div><h2>🧾 Reçus fiscaux</h2><p>Générez et envoyez les reçus de fin d\'année.</p></div></div>' +

    '<div class="table-card" style="margin-bottom:24px"><div class="table-card-header"><h3>Générer un reçu</h3></div>' +
    '<div style="padding:20px;max-width:450px">' +
      '<form id="receiptsForm">' +
        '<div class="form-group"><label>Membre</label>' +
          '<select id="rec_user"><option value="">Choisir…</option>' +
          membres.filter(m => m.role === 'member').map(m =>
            '<option value="' + m.id + '">' + m.prenom + ' ' + m.nom + ' (' + m.email + ')</option>'
          ).join('') + '</select></div>' +
        '<div class="form-group"><label>Année fiscale</label>' +
          '<input type="number" id="rec_annee" value="' + new Date().getFullYear() + '" min="2020" max="2030"/></div>' +
        '<button type="submit" class="btn btn-primary">🧾 Générer et envoyer</button>' +
      '</form>' +
    '</div></div>' +

    '<div class="table-card"><div class="table-card-header"><h3>Reçus émis</h3></div>' +
    '<div class="table-wrapper"><table>' +
    '<thead><tr><th>Membre</th><th>Année</th><th>Total</th><th>Date</th><th>Action</th></tr></thead><tbody>' +
    (data.length ? data.map(r =>
      '<tr><td>' + r.prenom + ' ' + r.nom + '</td><td>' + r.annee + '</td><td>$' + r.montant_total.toFixed(2) + '</td>' +
      '<td>' + fmt(r.date_generation) + '</td>' +
      '<td><button class="btn btn-sm btn-primary" onclick="imprimerRecu(' + r.id + ')">🖨️ Imprimer</button></td></tr>'
    ).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Aucun reçu émis</td></tr>') +
    '</tbody></table></div></div>'
  );

  document.getElementById('receiptsForm').onsubmit = async function(e) {
    e.preventDefault();
    const user_id = document.getElementById('rec_user').value;
    const annee   = document.getElementById('rec_annee').value;
    if (!user_id) return toast('Sélectionnez un membre', 'error');
    try {
      const r = await api('/receipts', { method:'POST', body: JSON.stringify({ user_id: parseInt(user_id), annee: parseInt(annee) }) });
      toast('🧾 Reçu généré — $' + r.montant_total.toFixed(2) + ' — envoyé au membre');
      recus();
    } catch(ex) { toast(ex.message, 'error'); }
  };
}

function imprimerRecu(id) {
  window.open(`${BASE}/api/receipts/${id}/print?token=${TOKEN}`, '_blank');
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

async function mon_paiement() {
  const [myPays, myRecus, me] = await Promise.all([api('/payments/my'), api('/receipts/my'), api('/auth/me')]);
  const PLAN_PRIX = { bienfaiteur:10, partenaire:20 };
  const montantDu = PLAN_PRIX[me.plan] || 0;
  const now = new Date();
  const currentMonth = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const paidThisMonth = myPays.some(p => p.mois === currentMonth && p.statut === 'approuve');
  const unpaid = me.plan_unpaid_count || 0;
  const TYPE_LABEL = { mensualite:'💳 Mensualité', don:'🎁 Don' };
  const bannerBg = paidThisMonth ? 'linear-gradient(135deg,#1b5e20,#2e7d32)' : (unpaid > 0 ? 'linear-gradient(135deg,#bf360c,#d84315)' : 'linear-gradient(135deg,#e65100,#f57c00)');

  setContent(
    '<div class="page-header"><div><h2>💳 Mon paiement</h2>' +
    '<p>Déclarez votre mensualité ou faites un don à l\'association.</p></div></div>' +

    '<div class="quota-banner" style="' + bannerBg + '">' +
      '<div class="quota-title">Plan <strong>' + me.plan + '</strong></div>' +
      '<div class="quota-grid">' +
        '<div class="quota-item"><div class="quota-label">Mensualité</div><div class="quota-val">$' + montantDu + '/mois</div></div>' +
        '<div class="quota-item"><div class="quota-label">Ce mois (' + currentMonth + ')</div><div class="quota-val">' + (paidThisMonth ? '✅ Payé' : '⏳ En attente') + '</div></div>' +
        '<div class="quota-item"><div class="quota-label">Rappels reçus</div><div class="quota-val">' + unpaid + '/2</div></div>' +
      '</div>' +
    '</div>' +

    (!paidThisMonth ?
      '<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:12px;padding:14px 18px;margin-bottom:20px;font-size:.84rem;color:#5d4037">' +
        '💳 Votre mensualité de <strong>$' + montantDu + '</strong> est due le 15 de chaque mois.' +
        (unpaid > 0 ? '<br/>⚠️ <strong>' + unpaid + ' rappel(s)</strong> envoyé(s). Après 2, votre plan sera rétrogradé.' : '') +
      '</div>' : '') +

    '<div class="table-card" style="margin-bottom:24px"><div class="table-card-header"><h3>Déclarer un paiement ou un don</h3></div>' +
    '<div style="padding:20px;max-width:480px"><form id="payForm">' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Type *</label><select id="pay_type">' +
          '<option value="mensualite">💳 Mensualité</option>' +
          '<option value="don">🎁 Don</option></select></div>' +
        '<div class="form-group"><label>Montant ($) *</label>' +
          '<input type="number" id="pay_montant" step="0.01" min="1" value="' + montantDu + '" required/></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Mois</label><input type="month" id="pay_mois" value="' + currentMonth + '"/></div>' +
        '<div class="form-group"><label>Méthode</label><select id="pay_methode">' +
          '<option value="virement">Virement bancaire</option>' +
          '<option value="interac">Interac</option>' +
          '<option value="cash">Espèces</option>' +
          '<option value="cheque">Chèque</option></select></div>' +
      '</div>' +
      '<div class="form-group"><label>Référence / Confirmation</label>' +
        '<input id="pay_ref" placeholder="ex: confirmation Interac, no chèque…"/></div>' +
      '<div class="form-group"><label>Preuve de paiement (optionnel)</label>' +
        '<input type="file" id="pay_proof" accept="image/*,application/pdf"/></div>' +
      '<div class="form-group"><label>Note</label>' +
        '<textarea id="pay_note" rows="2" placeholder="Commentaire optionnel…"></textarea></div>' +
      '<div class="form-actions">' +
        '<button type="submit" class="btn btn-primary">📤 Soumettre à la finance</button>' +
      '</div>' +
    '</form></div></div>' +

    '<div class="table-card" style="margin-bottom:24px"><div class="table-card-header"><h3>Mes paiements</h3></div>' +
    '<div class="table-wrapper"><table>' +
    '<thead><tr><th>Type</th><th>Montant</th><th>Mois</th><th>Méthode</th><th>Statut</th><th>Date</th></tr></thead><tbody>' +
    (myPays.length ? myPays.map(p =>
      '<tr><td>' + (TYPE_LABEL[p.type]||p.type) + '</td><td>$' + p.montant + '</td><td>' + (p.mois||'–') + '</td>' +
      '<td>' + (p.methode||'–') + '</td><td>' + statusPill(p.statut) + '</td><td>' + fmt(p.date_soumission) + '</td></tr>'
    ).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Aucun paiement soumis</td></tr>') +
    '</tbody></table></div></div>' +

    '<div class="table-card"><div class="table-card-header"><h3>🧾 Mes reçus fiscaux</h3></div>' +
    '<div class="table-wrapper"><table>' +
    '<thead><tr><th>Année</th><th>Total</th><th>Date</th><th>Action</th></tr></thead><tbody>' +
    (myRecus.length ? myRecus.map(r =>
      '<tr><td>' + r.annee + '</td><td>$' + r.montant_total.toFixed(2) + '</td><td>' + fmt(r.date_generation) + '</td>' +
      '<td><button class="btn btn-sm btn-ghost" onclick="voirRecu(\'' + (r.contenu||'').replace(/'/g,"\\'").replace(/\n/g,'\\n') + '\')">👁️ Voir</button></td></tr>'
    ).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Aucun reçu disponible</td></tr>') +
    '</tbody></table></div></div>'
  );

  document.getElementById('payForm').onsubmit = async function(e) {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Envoi…';
    const fd = new FormData();
    fd.append('montant',   document.getElementById('pay_montant').value);
    fd.append('type',      document.getElementById('pay_type').value);
    fd.append('mois',      document.getElementById('pay_mois').value);
    fd.append('methode',   document.getElementById('pay_methode').value);
    fd.append('reference', document.getElementById('pay_ref').value);
    fd.append('note',      document.getElementById('pay_note').value);
    const proof = document.getElementById('pay_proof').files[0];
    if (proof) fd.append('proof', proof);
    try {
      const res = await fetch(API + '/payments', { method:'POST', headers:{ Authorization:'Bearer ' + TOKEN }, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Erreur');
      toast('✅ Paiement soumis à la finance pour validation !', 'info');
      mon_paiement();
    } catch(ex) {
      toast(ex.message, 'error');
      btn.disabled = false; btn.textContent = '📤 Soumettre à la finance';
    }
  };
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

  openModal('📱 Code QR — ' + titre,
    '<div style="text-align:center;padding:8px">' +
      '<p style="font-size:.82rem;color:var(--muted);margin-bottom:16px">Partagez ce QR code avec les membres pour qu\'ils paient ou valident leur présence.</p>' +
      '<div style="width:240px;height:240px;margin:0 auto;border-radius:16px;border:1px solid var(--border);overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center">' +
        '<img id="qrImgModal" src="' + qrUrl + '?t=' + Date.now() + '" style="width:220px;height:220px;display:block" onerror="this.parentElement.innerHTML=\'<span style=\\\'font-size:.8rem;color:var(--muted)\\\'>Erreur QR — rechargez</span>\'"/>' +
      '</div>' +
      '<div style="margin-top:12px;background:var(--off);border-radius:8px;padding:8px 10px;font-size:.72rem;color:var(--muted);word-break:break-all;text-align:left">' +
        '🔗 <a href="' + checkoutUrl + '" target="_blank" style="color:var(--g2)">' + checkoutUrl + '</a>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap">' +
        '<button class="btn btn-outline btn-sm" onclick="window.open(\'' + qrUrl + '\',\'_blank\')">⬇️ Télécharger QR</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + checkoutUrl + '\').then(()=>toast(\'Lien copié !\'))">📋 Copier lien</button>' +
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
  const { activite: act, inscrits, totalRevenu, nbPayes, nbNonPayes } = r;

  openModal('📊 Rapport — ' + act.titre,
    '<div style="max-height:70vh;overflow-y:auto">' +
      '<div class="cards-grid" style="grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">' +
        '<div class="stat-card"><div class="sc-icon">👥</div><div class="sc-value">' + inscrits.length + '</div><div class="sc-label">Inscrits</div></div>' +
        '<div class="stat-card"><div class="sc-icon">✅</div><div class="sc-value">' + nbPayes + '</div><div class="sc-label">Payés</div></div>' +
        '<div class="stat-card accent"><div class="sc-icon">💰</div><div class="sc-value">$' + totalRevenu.toFixed(2) + '</div><div class="sc-label">Revenu</div></div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:.82rem">' +
        '<thead><tr style="background:var(--off)">' +
          '<th style="padding:8px;text-align:left">Membre</th><th>Plan</th><th>Statut</th><th>Payé</th><th>Montant</th>' +
        '</tr></thead><tbody>' +
        inscrits.map(i =>
          '<tr style="border-bottom:1px solid var(--border)">' +
            '<td style="padding:7px 8px">' + i.prenom + ' ' + i.nom + '<br/><small style="color:var(--muted)">' + i.email + '</small></td>' +
            '<td style="padding:7px 8px">' + pill(i.plan||'gratuit','bp-blue') + '</td>' +
            '<td style="padding:7px 8px">' + (i.statut||'inscrit') + '</td>' +
            '<td style="padding:7px 8px">' + (i.paye ? '✅' : '❌') + '</td>' +
            '<td style="padding:7px 8px">$' + (i.montant_paye||0).toFixed(2) + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table>' +
      '<div style="margin-top:14px;text-align:right">' +
        '<button class="btn btn-outline btn-sm" onclick="printSection(\'Rapport — ' + act.titre + '\')">🖨️ Imprimer</button>' +
      '</div>' +
    '</div>'
  );
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
