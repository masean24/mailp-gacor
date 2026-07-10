import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'default-secret-change-me' || secret === 'your_super_secret_jwt_key_change_this') {
        throw new Error('JWT_SECRET must be configured with a strong value');
    }
    return secret;
};

export const generateToken = (payload) => {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: '24h' });
};

export const verifyToken = (token) => {
    return jwt.verify(token, getJwtSecret());
};

export const authMiddleware = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'No token provided',
            });
        }

        const token = authHeader.split(' ')[1];
        const decoded = verifyToken(token);

        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired token',
        });
    }
};

export default authMiddleware;
