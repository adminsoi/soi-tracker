FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 443

CMD ["node", "index.js"]
