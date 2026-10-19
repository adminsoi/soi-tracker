FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

# Exact versions from package-lock.json, so a bad new release of a
# dependency can't break a redeploy. Update with `npm install` locally.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 443

CMD ["node", "index.js"]
