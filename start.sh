#!/bin/sh

# Start the backend server in background
cd /app/backend
node dist/server.js &

# Start nginx in foreground
nginx -g "daemon off;"