const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Ce dépôt est public sur GitHub — un secret JWT en dur dans le code serait visible de tous et
// permettrait de forger un token pour n'importe quel compte (y compris admin). Si JWT_SECRET
// n'est pas défini, on génère un secret aléatoire pour ce démarrage plutôt que d'utiliser une
// valeur fixe : les sessions existantes seront invalidées au redémarrage (dégradé mais sûr),
// au lieu d'un secret prévisible connu de quiconque lit le dépôt.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.error('⚠️  JWT_SECRET absent des variables d\'environnement — secret temporaire généré pour ce démarrage. Définissez JWT_SECRET dans .env (production) pour des sessions stables et sécurisées.');
}

let _db = null;
function getDb() {
  if (!_db) _db = require('../db/database');
  return _db;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  const token  = (header && header.startsWith('Bearer ')) ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(decoded.id);
    if (user && user.password_changed_at) {
      const changedAt = Math.floor(new Date(user.password_changed_at).getTime() / 1000);
      if (decoded.iat && decoded.iat < changedAt) {
        return res.status(401).json({ error: 'Session expirée — reconnectez-vous' });
      }
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole, JWT_SECRET };
