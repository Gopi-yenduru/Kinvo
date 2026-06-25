# Frontend build -> served as static files by nginx (TLS + reverse proxy configured
# via deploy/nginx.conf, mounted by docker-compose).
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
# Static SPA assets
COPY --from=build /app/dist /usr/share/nginx/html
# nginx.conf is mounted at runtime by docker-compose (so certs/host can be configured)
EXPOSE 80 443
