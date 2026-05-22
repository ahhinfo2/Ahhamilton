const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ahh_secret_2026';

function authMiddleware(req, res, next) {
  // Accept token from Authorization header OR ?token= query param (for window.open)
  const header = req.headers.authorization;
  const token  = (header && header.startsWith('Bearer ')) ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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
