#!/bin/sh

# Start the backend server in background
cd /app/backend/dist
node server.js &

# Start nginx in foreground
nginx -g "daemon off;"