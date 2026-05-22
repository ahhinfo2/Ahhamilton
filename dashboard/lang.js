// ── Système de traduction AHH — FR / EN / HT (Kreyòl ayisyen) ─────────────
window.AHH_LANG = (function() {

  const T = {
    // ── Navigation sidebar ────────────────────────────────────────
    'Tableau de bord':   { en:'Dashboard',         ht:'Tablo debo' },
    'Annuaire':          { en:'Directory',          ht:'Anyè' },
    'Inscriptions':      { en:'Registrations',      ht:'Enskripsyon' },
    'Heures bénévolat':  { en:'Volunteer Hours',    ht:'Èdtan bènevolat' },
    'Calendrier':        { en:'Calendar',           ht:'Kalandriye' },
    'Sous-comités':      { en:'Sub-Committees',     ht:'Sou-komite' },
    'Projets':           { en:'Projects',           ht:'Pwojè' },
    'Paiements':         { en:'Payments',           ht:'Peman' },
    'Lignes & budget':   { en:'Lines & Budget',     ht:'Liy & Bidjè' },
    'Factures':          { en:'Invoices',            ht:'Fakti' },
    'Reçus fiscaux':     { en:'Tax Receipts',       ht:'Resi fiskal' },
    'Galerie':           { en:'Gallery',             ht:'Galri' },
    'Talents':           { en:'Talents',             ht:'Talan' },
    'Petites annonces':  { en:'Classifieds',         ht:'Piti anonn' },
    'Notes de réunion':  { en:'Meeting Notes',      ht:'Nòt reyinyon' },
    'Rapports':          { en:'Reports',             ht:'Rapò' },
    'Lettres':           { en:'Letters',             ht:'Lèt' },
    'Courriel':          { en:'Email',               ht:'Imèl' },
    'Mon talent':        { en:'My Talent',           ht:'Talan mwen' },
    'Mes annonces':      { en:'My Listings',         ht:'Anonn mwen' },
    'Mon paiement':      { en:'My Payment',          ht:'Peman mwen' },
    'Alertes':           { en:'Alerts',              ht:'Alèt' },
    'Mon profil':        { en:'My Profile',          ht:'Pwofil mwen' },
    'Membres':           { en:'Members',             ht:'Manm' },
    'Mon espace':        { en:'My Space',            ht:'Espas mwen' },
    'Finance':           { en:'Finance',             ht:'Finans' },
    'Contenu':           { en:'Content',             ht:'Kontni' },
    'Communication':     { en:'Communication',       ht:'Kominikasyon' },
    'Activités':         { en:'Activities',          ht:'Aktivite' },

    // ── Boutons communs ───────────────────────────────────────────
    'Connexion':         { en:'Login',              ht:'Koneksyon' },
    'Déconnexion':       { en:'Logout',             ht:'Dekonekte' },
    'Annuler':           { en:'Cancel',             ht:'Anile' },
    'Enregistrer':       { en:'Save',               ht:'Sovgade' },
    'Créer':             { en:'Create',             ht:'Kreye' },
    'Modifier':          { en:'Edit',               ht:'Modifye' },
    'Supprimer':         { en:'Delete',             ht:'Efase' },
    'Approuver':         { en:'Approve',            ht:'Aprouve' },
    'Refuser':           { en:'Reject',             ht:'Refize' },
    'Retirer':           { en:'Withdraw',           ht:'Retire' },
    'Envoyer':           { en:'Send',               ht:'Voye' },
    'Imprimer':          { en:'Print',              ht:'Enprime' },
    'Voir':              { en:'View',               ht:'Wè' },
    'Fermer':            { en:'Close',              ht:'Fèmen' },

    // ── Titres de vues ────────────────────────────────────────────
    'Tableau de bord':   { en:'Dashboard',          ht:'Tablo debo' },
    'Activités':         { en:'Activities',         ht:'Aktivite' },
    'Membres':           { en:'Members',            ht:'Manm' },
    'Finance':           { en:'Finance',            ht:'Finans' },
    'Factures':          { en:'Invoices',           ht:'Fakti' },
    'Mon profil':        { en:'My Profile',         ht:'Pwofil mwen' },

    // ── Statuts ───────────────────────────────────────────────────
    'Actif':             { en:'Active',             ht:'Aktif' },
    'Inactif':           { en:'Inactive',           ht:'Inaktif' },
    'En attente':        { en:'Pending',            ht:'Annatant' },
    'Approuvé':          { en:'Approved',           ht:'Aprouve' },
    'Refusé':            { en:'Rejected',           ht:'Refize' },
    'Publié':            { en:'Published',          ht:'Pibliye' },
    'Retiré':            { en:'Withdrawn',          ht:'Retire' },
    'Planifiée':         { en:'Planned',            ht:'Planifye' },
    'En cours':          { en:'In Progress',        ht:'An kous' },
    'Terminée':          { en:'Completed',          ht:'Fini' },
    'Annulée':           { en:'Cancelled',          ht:'Anile' },

    // ── Rôles ─────────────────────────────────────────────────────
    'Admin':             { en:'Admin',              ht:'Admin' },
    'Membre':            { en:'Member',             ht:'Manm' },
    'Trésorière':        { en:'Treasurer',          ht:'Trezorye' },
    'Secrétaire':        { en:'Secretary',          ht:'Sekretè' },
    'Délégué':           { en:'Delegate',           ht:'Delege' },

    // ── Plans ─────────────────────────────────────────────────────
    'Gratuit':           { en:'Free',               ht:'Gratis' },
    'Bienfaiteur':       { en:'Benefactor',         ht:'Bienfektè' },
    'Partenaire':        { en:'Partner',            ht:'Patnè' },

    // ── Titres topbar ─────────────────────────────────────────────
    'Messages':                   { en:'Messages',               ht:'Mesaj' },
    'Heures de bénévolat':        { en:'Volunteer Hours',        ht:'Èdtan bènevolat' },
    'Lettres de recommandation':  { en:'Recommendation Letters', ht:'Lèt rekomandasyon' },
    'Gérer la galerie':           { en:'Manage Gallery',         ht:'Jere galri' },
    'Nos talents':                { en:'Our Talents',            ht:'Talan nou yo' },
    'Petites annonces':           { en:'Classifieds',            ht:'Piti anonn' },
    'Inscriptions en attente':    { en:'Pending Registrations',  ht:'Enskripsyon annatant' },
    'Paiements membres':          { en:'Member Payments',        ht:'Peman manm' },

    // ── Messages génériques ───────────────────────────────────────
    'Chargement...':     { en:'Loading...',         ht:'Chajman...' },
    'Aucun résultat':    { en:'No results',         ht:'Pa gen rezilta' },
    'Bonjour':           { en:'Hello',              ht:'Bonjou' },
    'Mon espace':        { en:'My Space',           ht:'Espas mwen' },
    'Courriel':          { en:'Email',              ht:'Imèl' },
    'Mot de passe':      { en:'Password',           ht:'Modpas' },
  };

  let _lang = localStorage.getItem('ahh_lang') || 'fr';

  function get(key) {
    if (_lang === 'fr' || !T[key]) return key;
    return (T[key][_lang]) || key;
  }

  function setLang(lang) {
    _lang = lang;
    localStorage.setItem('ahh_lang', lang);
    apply();
  }

  function getLang() { return _lang; }

  // Appliquer les traductions à tous les éléments data-i18n
  function apply() {
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      const key = el.getAttribute('data-i18n');
      el.textContent = get(key);
    });
    // Mettre à jour le sélecteur de langue si présent
    const sel = document.getElementById('langSelector');
    if (sel) sel.value = _lang;
  }

  return { get: get, set: setLang, getLang: getLang, apply: apply, T: T };
})();
