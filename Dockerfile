# Multi-stage Dockerfile for medical intake voice agent

# Stage 1: Build backend
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Stage 2: Build frontend
FROM node:20-alpine AS frontend-builder
# Force rebuild
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 3: Production image with nginx and Node.js
FROM node:20-alpine
# Install nginx
RUN apk add --no-cache nginx

# Copy backend build
COPY --from=backend-builder /app/backend /app/backend

# Copy frontend build (force rebuild)
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

# Verify assets are copied
RUN ls -la /usr/share/nginx/html/assets/

# Copy nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Copy startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Environment variables will be set at runtime for database connection

# Install backend production dependencies
WORKDIR /app/backend
RUN npm ci --only=production

# Expose port 8080
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

CMD ["/start.sh"]