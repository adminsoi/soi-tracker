FROM node:20-alpine

WORKDIR /app

COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev

COPY server ./server
COPY public ./public

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "index.js"]
