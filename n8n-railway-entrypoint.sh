#!/bin/sh
chown -R node:node /home/node/.n8n
exec chroot --userspec=node:node / n8n "$@"
