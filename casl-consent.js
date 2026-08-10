// CASL/GDPR cookie consent banner — inject once on all public pages
(function() {
  if (localStorage.getItem('ahh_consent')) return;

  const style = document.createElement('style');
  style.textContent = `
    #caslBanner {
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
      background: #1a2e1a; color: #fff;
      padding: 16px 24px; display: flex; align-items: center;
      gap: 16px; flex-wrap: wrap; justify-content: center;
      box-shadow: 0 -4px 24px rgba(0,0,0,.25); font-family: 'Poppins', sans-serif;
      font-size: .8rem; line-height: 1.6;
      transform: translateY(100%); transition: transform .4s ease;
    }
    #caslBanner.show { transform: translateY(0); }
    #caslBanner p { margin: 0; color: rgba(255,255,255,.8); max-width: 700px; }
    #caslBanner a { color: #66bb6a; text-decoration: underline; }
    .casl-btns { display: flex; gap: 8px; flex-shrink: 0; }
    .casl-accept {
      background: #2e7d32; color: #fff; border: none; border-radius: 8px;
      padding: 8px 20px; font-family: 'Poppins', sans-serif; font-size: .8rem;
      font-weight: 600; cursor: pointer; transition: .2s;
    }
    .casl-accept:hover { background: #43a047; }
    .casl-decline {
      background: transparent; color: rgba(255,255,255,.6); border: 1px solid rgba(255,255,255,.25);
      border-radius: 8px; padding: 8px 16px; font-family: 'Poppins', sans-serif;
      font-size: .8rem; cursor: pointer; transition: .2s;
    }
    .casl-decline:hover { color: #fff; border-color: rgba(255,255,255,.5); }
  `;
  document.head.appendChild(style);

  const t = window.AHH_t || (() => null);
  const text = t('casl.text') || '🍪 Ce site utilise des témoins (cookies) essentiels à son fonctionnement, conformément à la <strong>Loi canadienne anti-pourriel (LCAP/CASL)</strong>. En continuant à naviguer, vous acceptez notre <a href="/privacy.html">politique de confidentialité</a>.';
  const acceptLabel = t('casl.accept') || 'Accepter';
  const declineLabel = t('casl.decline') || 'Refuser';

  const banner = document.createElement('div');
  banner.id = 'caslBanner';
  banner.innerHTML = `
    <p>${text}</p>
    <div class="casl-btns">
      <button class="casl-accept" id="caslAccept">${acceptLabel}</button>
      <button class="casl-decline" id="caslDecline">${declineLabel}</button>
    </div>
  `;
  document.body.appendChild(banner);

  setTimeout(() => banner.classList.add('show'), 600);

  document.getElementById('caslAccept').onclick = () => {
    localStorage.setItem('ahh_consent', 'accepted');
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 400);
  };
  document.getElementById('caslDecline').onclick = () => {
    localStorage.setItem('ahh_consent', 'declined');
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 400);
  };
})();
