#!/bin/sh
chown -R node:node /home/node/.n8n
exec su-exec node n8n "$@"
