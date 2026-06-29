// ── Système de traduction AHH — FR / EN / HT (Kreyòl ayisyen) ─────────────
window.AHH_LANG = (function() {

  const T = {
    // ── Navigation sidebar ────────────────────────────────────────
    'Tableau de bord':   { en:'Dashboard',         ht:'Tablo debo' },
    'Annuaire':          { en:'Directory',          ht:'Anyè' },
    'Inscriptions':      { en:'Registrations',      ht:'Enskripsyon' },
    'Bénévolat':         { en:'Volunteer',          ht:'Bènevolat' },
    'Heures bénévolat':  { en:'Volunteer Hours',    ht:'Èdtan bènevolat' },
    'Cartes membres':    { en:'Member Cards',       ht:'Kat manm' },
    'Lecteur de cartes': { en:'Scan Cards',         ht:'Eskane kat' },
    'Calendrier':        { en:'Calendar',           ht:'Kalandriye' },
    'Sous-comités':      { en:'Sub-Committees',     ht:'Sou-komite' },
    'Projets':           { en:'Projects',           ht:'Pwojè' },
    'Paiements':         { en:'Payments',           ht:'Peman' },
    'Budget':            { en:'Budget',             ht:'Bidjè' },
    'Lignes & budget':   { en:'Lines & Budget',     ht:'Liy & Bidjè' },
    'Factures':          { en:'Invoices',            ht:'Fakti' },
    'Reçus fiscaux':     { en:'Tax Receipts',       ht:'Resi fiskal' },
    'Rapports':          { en:'Reports',             ht:'Rapò' },
    'Statistiques':      { en:'Statistics',          ht:'Estatistik' },
    'Stats du site':     { en:'Site Stats',          ht:'Stat sit la' },
    'Lettres':           { en:'Letters',             ht:'Lèt' },
    'Alertes':           { en:'Alerts',              ht:'Alèt' },
    'Courriel':          { en:'Email',               ht:'Imèl' },
    'Forum':             { en:'Forum',               ht:'Fowòm' },
    'Galerie':           { en:'Gallery',             ht:'Galri' },
    'Talents':           { en:'Talents',             ht:'Talan' },
    'Annonces':          { en:'Listings',            ht:'Anonn' },
    'Petites annonces':  { en:'Classifieds',         ht:'Piti anonn' },
    'Notes réunion':     { en:'Meeting Notes',       ht:'Nòt reyinyon' },
    'Notes de réunion':  { en:'Meeting Notes',       ht:'Nòt reyinyon' },
    'Témoignages':       { en:'Testimonials',        ht:'Temwayaj' },
    'Vidéos':            { en:'Videos',              ht:'Videyo' },
    'Documents':         { en:'Documents',           ht:'Dokiman' },
    'Mon talent':        { en:'My Talent',           ht:'Talan mwen' },
    'Mes annonces':      { en:'My Listings',         ht:'Anonn mwen' },
    'Mon paiement':      { en:'My Payment',          ht:'Peman mwen' },
    'Mes billets':       { en:'My Tickets',          ht:'Bilè mwen' },
    'Mon profil':        { en:'My Profile',          ht:'Pwofil mwen' },
    'Ma carte membre':   { en:'My Member Card',      ht:'Kat manm mwen' },
    'Actualités':        { en:'News',                ht:'Aktyalite' },
    'Notifications':     { en:'Notifications',       ht:'Notifikasyon' },
    'Membres':           { en:'Members',             ht:'Manm' },
    'Mon espace':        { en:'My Space',            ht:'Espas mwen' },
    'Finance':           { en:'Finance',             ht:'Finans' },
    'Contenu':           { en:'Content',             ht:'Kontni' },
    'Communication':     { en:'Communication',       ht:'Kominikasyon' },
    'Activités':         { en:'Activities',          ht:'Aktivite' },
    'Gouvernance':       { en:'Governance',          ht:'Govènans' },
    'Votes & Élections': { en:'Votes & Elections',   ht:'Vòt & Eleksyon' },
    'Parrainage':        { en:'Referral',            ht:'Parennaj' },
    'Billetterie':       { en:'Ticketing',           ht:'Bilteri' },
    'Vendre (cash)':     { en:'Sell (Cash)',         ht:'Vann (kach)' },
    'Numériser billets': { en:'Scan Tickets',        ht:'Eskane bilè' },
    'Commandes en attente': { en:'Pending Orders',   ht:'Kòmand annatant' },

    // ── Espace Jeunes ────────────────────────────────────────────
    'Espace Jeunes':     { en:'Youth Space',         ht:'Espas Jèn' },
    'Tableau jeunes':    { en:'Youth Board',         ht:'Tablo jèn' },
    'Stages & emplois':  { en:'Internships & Jobs',  ht:'Estaj & travay' },
    'Formations':        { en:'Training',            ht:'Fòmasyon' },
    'Sondages':          { en:'Surveys',             ht:'Sondaj' },
    'Success Stories':   { en:'Success Stories',     ht:'Istwa siksè' },

    // ── Boutons communs ───────────────────────────────────────────
    'Connexion':         { en:'Login',              ht:'Koneksyon' },
    'Déconnexion':       { en:'Logout',             ht:'Dekonekte' },
    '⬅ Déco':           { en:'⬅ Logout',           ht:'⬅ Sòti' },
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
    'Retour':            { en:'Back',               ht:'Retounen' },
    '← Retour':         { en:'← Back',             ht:'← Retounen' },
    'Ajouter':           { en:'Add',                ht:'Ajoute' },
    '+ Ajouter':         { en:'+ Add',              ht:'+ Ajoute' },
    'Télécharger':       { en:'Download',           ht:'Telechaje' },
    'Téléverser':        { en:'Upload',             ht:'Telechaje' },
    'Rechercher':        { en:'Search',             ht:'Chèche' },
    'Filtrer':           { en:'Filter',             ht:'Filtre' },
    'Exporter':          { en:'Export',             ht:'Ekspòte' },
    'Importer':          { en:'Import',             ht:'Enpòte' },
    'Publier':           { en:'Publish',            ht:'Pibliye' },
    'Archiver':          { en:'Archive',            ht:'Achive' },
    'Confirmer':         { en:'Confirm',            ht:'Konfime' },
    'Postuler':          { en:'Apply',              ht:'Aplike' },

    // ── Titres de vues ────────────────────────────────────────────
    'Tableau de bord':    { en:'Dashboard',          ht:'Tablo debo' },
    'Finance':            { en:'Finance',            ht:'Finans' },
    'Factures':           { en:'Invoices',           ht:'Fakti' },
    'Mon profil':         { en:'My Profile',         ht:'Pwofil mwen' },
    'Membres actifs':     { en:'Active Members',     ht:'Manm aktif' },
    'Documents officiels':{ en:'Official Documents', ht:'Dokiman ofisyèl' },
    'Mes cotisations':    { en:'My Contributions',   ht:'Kontribisyon mwen' },
    'Historique des paiements': { en:'Payment History', ht:'Istwa peman' },

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
    'Payé':              { en:'Paid',               ht:'Peye' },
    'Impayé':            { en:'Unpaid',             ht:'Pa peye' },
    'À jour':            { en:'Up to date',         ht:'Ajou' },
    'En retard':         { en:'Late',               ht:'Anreta' },
    'Gratuit':           { en:'Free',               ht:'Gratis' },

    // ── Rôles ─────────────────────────────────────────────────────
    'Admin':             { en:'Admin',              ht:'Admin' },
    'Membre':            { en:'Member',             ht:'Manm' },
    'Trésorière':        { en:'Treasurer',          ht:'Trezorye' },
    'Secrétaire':        { en:'Secretary',          ht:'Sekretè' },
    'Délégué':           { en:'Delegate',           ht:'Delege' },
    'Accompagnateur':    { en:'Accompanier',        ht:'Akonpanatè' },

    // ── Plans ─────────────────────────────────────────────────────
    'Gratuit':           { en:'Free',               ht:'Gratis' },
    'Bienfaiteur':       { en:'Benefactor',         ht:'Bienfektè' },
    'Partenaire':        { en:'Partner',            ht:'Patnè' },

    // ── Sections topbar / accueil ─────────────────────────────────
    'Messages':                    { en:'Messages',                ht:'Mesaj' },
    'Heures de bénévolat':         { en:'Volunteer Hours',         ht:'Èdtan bènevolat' },
    'Lettres de recommandation':   { en:'Recommendation Letters',  ht:'Lèt rekomandasyon' },
    'Gérer la galerie':            { en:'Manage Gallery',          ht:'Jere galri' },
    'Nos talents':                 { en:'Our Talents',             ht:'Talan nou yo' },
    'Petites annonces':            { en:'Classifieds',             ht:'Piti anonn' },
    'Inscriptions en attente':     { en:'Pending Registrations',   ht:'Enskripsyon annatant' },
    'Paiements membres':           { en:'Member Payments',         ht:'Peman manm' },
    'Prochaines activités':        { en:'Upcoming Activities',     ht:'Aktivite pwochèn' },
    'Actions rapides':             { en:'Quick Actions',           ht:'Aksyon rapid' },
    'Derniers membres':            { en:'Latest Members',          ht:'Dènye manm' },

    // ── Formulaires ────────────────────────────────────────────────
    'Nom':               { en:'Last name',          ht:'Non' },
    'Prénom':            { en:'First name',         ht:'Prenon' },
    'Courriel':          { en:'Email',              ht:'Imèl' },
    'Téléphone':         { en:'Phone',              ht:'Telefòn' },
    'Adresse':           { en:'Address',            ht:'Adrès' },
    'Mot de passe':      { en:'Password',           ht:'Modpas' },
    'Date de naissance': { en:'Date of birth',      ht:'Dat nesans' },
    'Description':       { en:'Description',        ht:'Deskripsyon' },
    'Titre':             { en:'Title',              ht:'Tit' },
    'Date':              { en:'Date',               ht:'Dat' },
    'Lieu':              { en:'Location',           ht:'Kote' },
    'Prix':              { en:'Price',              ht:'Pri' },
    'Montant':           { en:'Amount',             ht:'Montan' },
    'Référence':         { en:'Reference',          ht:'Referans' },
    'Commentaire':       { en:'Comment',            ht:'Kòmantè' },
    'Catégorie':         { en:'Category',           ht:'Kategori' },

    // ── Messages génériques ───────────────────────────────────────
    'Chargement...':       { en:'Loading...',           ht:'Chajman...' },
    'Aucun résultat':      { en:'No results',           ht:'Pa gen rezilta' },
    'Bonjour':             { en:'Hello',                ht:'Bonjou' },
    'Aucune alerte non lue': { en:'No unread alerts',  ht:'Pa gen alèt' },
    'Imprimer / PDF':      { en:'Print / PDF',          ht:'Enprime / PDF' },
    '🖨️ Imprimer / PDF':  { en:'🖨️ Print / PDF',       ht:'🖨️ Enprime / PDF' },
    'Payer en ligne':      { en:'Pay online',           ht:'Peye anliy' },
    'Nouvelle activité':   { en:'New Activity',         ht:'Nouvo aktivite' },
    'Envoyer un message':  { en:'Send a message',       ht:'Voye yon mesaj' },
    'Voir la finance':     { en:'View finance',         ht:'Wè finans' },
    'Gérer la galerie':    { en:'Manage gallery',       ht:'Jere galri' },
    'Heures bénévolat':    { en:'Volunteer hours',      ht:'Èdtan bènevolat' },
    'Mon espace':          { en:'My Space',             ht:'Espas mwen' },
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
    // 1. Éléments avec attribut data-i18n
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      const key = el.getAttribute('data-i18n');
      el.textContent = get(key);
    });
    // 2. Mettre à jour le sélecteur de langue
    const sel = document.getElementById('langSelector');
    if (sel) sel.value = _lang;
    // 3. Traduit les nœuds texte du contenu dynamique si pas en FR
    if (_lang !== 'fr') applyTextNodes();
  }

  // Scan des nœuds texte dans le contenu principal pour remplacer les chaînes connues
  function applyTextNodes() {
    const main = document.getElementById('mainContent');
    if (!main) return;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent.trim();
      if (txt && T[txt]) {
        const translated = T[txt][_lang];
        if (translated && node.textContent !== translated) {
          node.textContent = node.textContent.replace(txt, translated);
        }
      }
    }
    // Aussi traduire les titres de page courants
    document.querySelectorAll('.page-header h2, .table-card-header h3, .page-header p').forEach(el => {
      const txt = el.textContent.trim();
      if (T[txt]) el.textContent = T[txt][_lang] || txt;
    });
  }

  return { get, set: setLang, getLang, apply, applyTextNodes, T };
})();
