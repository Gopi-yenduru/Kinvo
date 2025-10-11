import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "A7f9K2dL8qX3pV0b"; 

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
    console.log('Auth: Token verified successfully for user:', decoded?.username);
    req.user = decoded; // ✅ attach user info to request
    next();
  } catch (err: any) {
    console.log('Auth: Token verification failed:', err.message);
    return res.status(403).json({ error: "Invalid or expired token" });
  }
};
