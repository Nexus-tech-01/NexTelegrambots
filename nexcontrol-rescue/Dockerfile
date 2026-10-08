FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY nexcontrol/package.json /app/nexcontrol/package.json
RUN cd /app/nexcontrol && npm install --omit=dev --no-audit --no-fund
COPY nexcontrol /app/nexcontrol
COPY nexcontrol-rescue/server.mjs /app/nexcontrol-rescue/server.mjs
USER node
EXPOSE 8080
CMD ["node", "nexcontrol-rescue/server.mjs"]
