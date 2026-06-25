import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// The JWT signing secret MUST be provided via environment (see backend/.env).
// Fail fast rather than fall back to a weak, source-committed default.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET is missing or too short. Set a strong (>=32 char) JWT_SECRET in backend/.env before starting the server.'
  );
}

// Shared so token signing (login) and verification use the exact same secret.
export const getJwtSecret = (): string => JWT_SECRET;
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

export interface AuthRequest extends Request {
  user?: any; // store decoded user info here
}

export const authenticateJWT = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  console.log('Auth: Checking authentication for path:', req.path);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log('Auth: Missing or invalid authorization header');
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const token = authHeader.split(" ")[1];
  console.log('Auth: Token received, length:', token.length);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded; // attach decoded user info (id, username, role)
    next();
  } catch (err: any) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
};

/**
 * Role-based access control. Use after authenticateJWT, e.g.
 *   app.post('/api/admin/users', authenticateJWT, requireRole('admin'), handler)
 */
export const requireRole = (...allowed: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient privileges' });
    }
    next();
  };
};
