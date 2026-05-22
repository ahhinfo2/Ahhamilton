// Détecte si l'utilisateur est connecté et adapte le bouton de navigation
(function updateNavForAuth() {
  const token    = localStorage.getItem('ahh_token');
  const rawUser  = localStorage.getItem('ahh_user');
  const loginBtn = document.querySelector('.btn-login');
  if (!loginBtn) return;

  if (token && rawUser) {
    try {
      const user = JSON.parse(rawUser);
      // Utilisateur connecté → bouton "Mon espace"
      loginBtn.innerHTML  = `👤 ${user.prenom} <span style="opacity:.7;font-size:.8em">→ Mon espace</span>`;
      // Chemin relatif selon la profondeur de la page actuelle
      const depth = (window.location.pathname.match(/\//g) || []).length;
      const prefix = depth <= 1 ? '' : '../'.repeat(depth - 1);
      loginBtn.href = prefix + 'dashboard/app.html';
      loginBtn.title      = `Connecté en tant que ${user.prenom} ${user.nom} (${user.role})`;
      loginBtn.style.background = 'linear-gradient(135deg,#43a047,#69f0ae)';
      loginBtn.style.color = '#fff';

      // Ajouter un bouton de déconnexion rapide à côté
      const logoutQuick = document.createElement('a');
      logoutQuick.href  = '#';
      logoutQuick.style.cssText = 'font-size:.75rem;color:rgba(255,255,255,.6);margin-left:4px;padding:6px 10px;border-radius:50px;transition:.2s';
      logoutQuick.title = 'Se déconnecter';
      logoutQuick.textContent = '⬅';
      logoutQuick.onmouseover = () => logoutQuick.style.color = '#fff';
      logoutQuick.onmouseout  = () => logoutQuick.style.color = 'rgba(255,255,255,.6)';
      logoutQuick.onclick = e => {
        e.preventDefault();
        localStorage.removeItem('ahh_token');
        localStorage.removeItem('ahh_user');
        loginBtn.textContent = '🔐 Connexion';
        loginBtn.href        = 'dashboard/login.html';
        loginBtn.style.background = '';
        loginBtn.style.color = '';
        logoutQuick.remove();
      };
      loginBtn.insertAdjacentElement('afterend', logoutQuick);
    } catch(e) {
      localStorage.removeItem('ahh_token');
      localStorage.removeItem('ahh_user');
    }
  }
})();
