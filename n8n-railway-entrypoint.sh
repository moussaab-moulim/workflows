#!/bin/sh
chown -R node:node /home/node/.n8n
exec node /docker-entrypoint-railway.js "$@"
